// =====================================================================
//  お知らせ（/api/news・/api/admin/news）・作品（/api/works）と、サイト内VC のつなぎ直し（同じブラウザの入れかえ）のテスト
//
//  使い方（cloudflare フォルダで）:  npm install && node test/news-reconnect.test.mjs
//  workerd（Cloudflare Workers と同じ実行環境）を直接動かします。Discord には何も送りません。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const WORKERD = require("workerd").default;
const PORT = 8733, KEY = "Test-Setup-Key-news-0123456789";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (c, m) => { console.log((c ? "  ok  " : "  NG  ") + m); if (!c) fail++; };

const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const compatDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml) || [])[1];
const flags = [...((/^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]);
// ニセの Discord（招待リンクの人数だけ）。mode で返事を変える
const FAKE_DISCORD = 8798;
const fakeDiscord = { mode: "down", calls: 0 };
const fakeServer = http.createServer((req, res) => {
  fakeDiscord.calls++;
  const m = /^\/api\/v10\/invites\/([A-Za-z0-9-]+)/.exec(req.url);
  if (!m || fakeDiscord.mode === "down") { res.writeHead(500); return res.end("{}"); }
  if (m[1] !== "abcDEF12") { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"message":"Unknown Invite","code":10006}'); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: m[1], approximate_member_count: 81, approximate_presence_count: 23, expires_at: null }));
});
await new Promise(r => fakeServer.listen(FAKE_DISCORD, "127.0.0.1", r));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-news-"));
fs.mkdirSync(path.join(tmp, "src"));
const mods = fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js"));
for (const f of mods) fs.copyFileSync(path.join(ROOT, "src", f), path.join(tmp, "src", f));
// サイトのファイルの代わり（どのパスを読みにきたかを返す）
fs.writeFileSync(path.join(tmp, "assets.js"), `export default { fetch(req) { return new Response("asset:" + new URL(req.url).pathname, { status: 404 }); } };\n`);
fs.writeFileSync(path.join(tmp, "config.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w), (name = "assets", worker = .a), (name = "net", network = (allow = ["public", "private", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main") ],
);
const w :Workerd.Worker = (
  modules = [ (name = "index.js", esModule = embed "src/index.js"),
${mods.filter(f => f !== "index.js").map(f => `    (name = "${f}", esModule = embed "src/${f}")`).join(",\n")} ],
  compatibilityDate = "${compatDate}",
  compatibilityFlags = [${flags.map(f => `"${f}"`).join(", ")}],
  durableObjectNamespaces = [ (className = "GuildRoom", uniqueKey = "guildroom-news-test", enableSql = true) ],
  durableObjectStorage = (inMemory = void),
  globalOutbound = "net",
  bindings = [ (name = "GUILD", durableObjectNamespace = (className = "GuildRoom")), (name = "ASSETS", service = "assets"),
               (name = "DISCORD_API", text = "http://127.0.0.1:${FAKE_DISCORD}/api/v10"), (name = "SETUP_KEY", text = "${KEY}"),
               (name = "SITE_URL", text = "https://example.workers.dev"),
               (name = "HOME_HOST", text = "home.example"), (name = "KAMEN_HOST", text = "kamen.example"),
               (name = "HOME_DISCORD_INVITE", text = "abcDEF12") ],
);
const a :Workerd.Worker = ( modules = [ (name = "assets.js", esModule = embed "assets.js") ], compatibilityDate = "${compatDate}" );
`);
const wd = spawn(WORKERD, ["serve", "--experimental", path.join(tmp, "config.capnp")], { stdio: ["ignore", "pipe", "pipe"] });
let wdLog = "";
wd.stdout.on("data", d => (wdLog += d)); wd.stderr.on("data", d => (wdLog += d));
const BASE = `http://127.0.0.1:${PORT}`;
const stop = code => { wd.kill(); fakeServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch (e) { /* 待つ */ } await sleep(250); }

let ipN = 0;
const freshIp = () => `10.2.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const req = (p, o = {}) => fetch(BASE + p, { redirect: "manual", ...o, headers: { "CF-Connecting-IP": o.ip || freshIp(), ...(o.headers || {}) } });
const post = (p, body, o = {}) => req(p, { method: "POST", body: JSON.stringify(body), ...o, headers: { "Content-Type": "application/json", ...(o.headers || {}) } });

/** WebSocket（受け取ったメッセージをためておく） */
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const box = { ws, msgs: [], closed: null };
    ws.onmessage = e => { if (e.data !== "pong") { try { box.msgs.push(JSON.parse(e.data)); } catch (err) { /* 無視 */ } } };
    ws.onclose = e => { box.closed = { code: e.code }; };
    ws.onopen = () => resolve(box);
    ws.onerror = () => reject(new Error("ws error"));
  });
}
async function waitFor(box, pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = box.msgs.find(pred); if (m) return m; await sleep(30); }
  return null;
}

try {
  // ---- お知らせ ----
  const empty = await (await req("/api/news")).json();
  check(empty.ok && Array.isArray(empty.items) && empty.items.length === 0 && typeof empty.now === "number", "はじめは、お知らせ 0 件（だれでも読める）");
  const noAuth = await post("/api/admin/news", { action: "list" });
  check(noAuth.status === 401, "ログインなしで /api/admin/news → 401");

  const login = await post("/api/setup/auth", { key: KEY });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check(login.status === 200 && cookie, "管理者でログイン");
  const admin = async body => { const r = await post("/api/admin/news", body, { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json() }; };

  const form = await req("/api/admin/news", { method: "POST", body: "action=list", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } });
  check(form.status === 415, "フォームの形で送ってきたら受け付けない（ほかのサイトからのなりすまし対策）→ 415");

  const bad1 = await admin({ action: "save", item: { type: "update", title: "  ", body: "x" } });
  check(bad1.status === 400 && /タイトル/.test(bad1.j.error), "タイトルなし → 400");
  const bad2 = await admin({ action: "save", item: { type: "nope", title: "x" } });
  check(bad2.status === 400, "知らない種類 → 400");
  const t0 = Date.now();
  const bad3 = await admin({ action: "save", item: { type: "maintenance", title: "メンテ", start: t0 + 3600e3, end: t0 } });
  check(bad3.status === 400 && /終わり/.test(bad3.j.error), "メンテナンスの終わりが、はじまりより前 → 400");
  const bad4 = await admin({ action: "save", item: { type: "info", title: "x".repeat(81) } });
  check(bad4.status === 400, "タイトル 81 文字 → 400");

  const up = await admin({ action: "save", item: { type: "update", title: "v1.3 アップデート", body: "・バックグラウンドモード\r\n・お知らせ\u0007", pinned: false, published: true } });
  check(up.status === 200 && up.j.ok && up.j.created && up.j.items.length === 1, "アップデートのお知らせを投稿");
  const upId = up.j.saved;
  check(up.j.items[0].body === "・バックグラウンドモード\n・お知らせ", "本文の改行は \\n にそろえ、制御文字は消す");
  const draft = await admin({ action: "save", item: { type: "info", title: "下書きです", body: "まだ", published: false } });
  check(draft.j.ok && draft.j.items.length === 2, "下書きを保存");
  const mt = await admin({ action: "save", item: { type: "maintenance", title: "サーバーのメンテナンス", body: "少し止まります", start: t0 - 60e3, end: t0 + 3600e3, pinned: true } });
  check(mt.j.ok, "メンテナンス（いま〜1 時間後・ピン留め）を投稿");
  const notMaintTime = await admin({ action: "save", item: { type: "update", title: "時刻つき", start: t0, end: t0 + 1000 } });
  check(notMaintTime.j.ok && notMaintTime.j.items.find(n => n.id === notMaintTime.j.saved).start === null, "メンテナンス以外の日時は保存しない");

  let pub = await (await req("/api/news")).json();
  check(pub.ok && pub.items.length === 3 && !pub.items.some(n => n.title === "下書きです"), "ホーム用（/api/news）には下書きが出ない → " + pub.items.map(n => n.title).join("・"));
  check(pub.items.every(n => !("published" in n)), "ホーム用には、出さなくてよい項目（published など）が入らない");
  const m = pub.items.find(n => n.type === "maintenance");
  check(m && m.pinned && m.start && m.end, "メンテナンスの日時とピン留めが届く");

  const ed = await admin({ action: "save", item: { id: upId, type: "update", title: "v1.3 アップデート（修正）", body: "直しました", published: true } });
  const edItem = ed.j.items.find(n => n.id === upId);
  check(ed.j.ok && !ed.j.created && edItem.title.endsWith("（修正）") && edItem.edited && edItem.at === up.j.items[0].at, "編集: ID と投稿日時はそのまま・編集日時がつく");
  const bump = await admin({ action: "save", item: { ...edItem, bump: true } });
  check(bump.j.items.find(n => n.id === upId).at > edItem.at, "「新着として出しなおす」で投稿日時が新しくなる");
  const pubOn = await admin({ action: "publish", id: draft.j.saved, on: true });
  check(pubOn.j.ok && pubOn.j.items.find(n => n.id === draft.j.saved).published, "下書きを公開");
  const pin = await admin({ action: "pin", id: upId, on: true });
  check(pin.j.ok && pin.j.items.find(n => n.id === upId).pinned, "ピン留め");
  const del = await admin({ action: "delete", id: notMaintTime.j.saved });
  check(del.j.ok && !del.j.items.some(n => n.id === notMaintTime.j.saved), "消す");
  const ghost = await admin({ action: "save", item: { id: "zzzzzzzzzz", type: "info", title: "x" } });
  check(ghost.status === 400, "ない ID を編集 → 400");
  pub = await (await req("/api/news")).json();
  check(pub.items.length === 3 && pub.items.some(n => n.title === "下書きです"), "変更はすぐホーム用に出る（同じサーバー）");

  // 50 件をこえたら、ピン留めしていない古いものから消える
  for (let i = 0; i < 52; i++) await admin({ action: "save", item: { type: "info", title: "たくさん " + i } });
  const many = await admin({ action: "list" });
  check(many.j.items.length === 50 && many.j.items.some(n => n.id === upId) && many.j.items.some(n => n.type === "maintenance"), "50 件まで（ピン留めしたものは残る）→ " + many.j.items.length + " 件");

  // ---- 作品の紹介 ----
  const wadmin = async body => { const r = await post("/api/admin/works", body, { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json() }; };
  check((await post("/api/admin/works", { action: "list" })).status === 401, "ログインなしで /api/admin/works → 401");
  check((await wadmin({ action: "save", item: { cat: "nope", title: "x" } })).status === 400, "作品: 知らない種類 → 400");
  const badLink = await wadmin({ action: "save", item: { cat: "addon", title: "x", links: [{ label: "a", url: "javascript:alert(1)" }] } });
  check(badLink.status === 400 && /https/.test(badLink.j.error), "作品: javascript: のリンク → 400");
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  check((await wadmin({ action: "save", item: { cat: "addon", title: "x" }, image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status === 400, "作品: SVG の画像 → 400（スクリプトを入れられないように）");
  check((await wadmin({ action: "save", item: { cat: "addon", title: "x" }, image: "data:image/png;base64,SGVsbG8gd29ybGQh" })).status === 400, "作品: PNG と言いながら中身がちがう → 400");
  const wk1 = await wadmin({ action: "save", item: { cat: "addon", title: "死体アドオン", summary: "死体が残る", sub: "v1.3", body: "説明\r\nです", pinned: true,
    links: [{ label: "つくる", url: "/corpse/" }, { label: "YouTube", url: "https://youtu.be/dQw4w9WgXcQ" }, { label: "", url: "" }] }, image: PNG });
  check(wk1.status === 200 && wk1.j.created && wk1.j.items[0].img && wk1.j.items[0].links.length === 2, "作品を載せる（画像・リンク 2 つ）");
  const wk2 = await wadmin({ action: "save", item: { cat: "client", title: "下書きクライアント", published: false } });
  check(wk2.j.ok, "作品の下書き");
  let wl = await (await req("/api/works")).json();
  check(wl.ok && wl.items.length === 1 && wl.items[0].title === "死体アドオン" && /^\/api\/works\/img\/[a-z0-9]{10}\?v=\d+$/.test(wl.items[0].img), "作品ページ用（/api/works）には公開したものだけ・画像の URL つき");
  check(wl.items[0].body === "説明\nです" && !("published" in wl.items[0]), "作品: 改行をそろえる・出さなくてよい項目は入れない");
  const imgRes = await req(wl.items[0].img);
  const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
  check(imgRes.status === 200 && imgRes.headers.get("content-type") === "image/png" && /immutable/.test(imgRes.headers.get("cache-control") || "") && imgBytes[0] === 0x89, "作品の画像を配る（image/png・長く覚えてよい）");
  check((await req("/api/works/img/zzzzzzzzzz")).status === 404, "ない作品の画像 → 404");
  const wEdit = await wadmin({ action: "save", item: { id: wk1.j.saved, cat: "addon", title: "死体アドオン 2", links: [] }, removeImage: true });
  check(wEdit.j.ok && !wEdit.j.items.find(w => w.id === wk1.j.saved).img, "作品を編集して画像を消す");
  check((await req(wl.items[0].img)).status === 404, "消した画像は配らない");
  const wDel = await wadmin({ action: "delete", id: wk2.j.saved });
  check(wDel.j.ok && wDel.j.items.length === 1, "作品を消す");

  // ---- サイト内VC: 同じブラウザ（同じ sid）でつなぎ直す ----
  const room = await (await post("/api/web/rooms", { name: "つなぎ直し" })).json();
  const g1 = await (await post("/api/guest", { name: "スマホ" })).json();
  const g2 = await (await post("/api/guest", { name: "みてる人" })).json();
  check(room.ok && g1.ok && g2.ok, "部屋とゲストを作る");
  const wsUrl = token => `ws://127.0.0.1:${PORT}/api/web/socket?r=${room.roomId}&g=${encodeURIComponent(token)}`;
  // 見ている人（観戦者）
  const obs = await openWs(wsUrl(g2.token));
  obs.ws.send(JSON.stringify({ t: "hello", sid: "" }));
  await waitFor(obs, x => x.t === "welcome");
  obs.ws.send(JSON.stringify({ t: "pick", spec: true }));
  check(!!(await waitFor(obs, x => x.t === "verified")), "見ている人が観戦者で入る");
  // スマホの人（1 本目の接続）
  const a1 = await openWs(wsUrl(g1.token));
  a1.ws.send(JSON.stringify({ t: "hello", sid: "" }));
  const w1 = await waitFor(a1, x => x.t === "welcome");
  a1.ws.send(JSON.stringify({ t: "pick", spec: true }));
  const v1 = await waitFor(a1, x => x.t === "verified");
  check(w1 && v1 && /^[A-Za-z0-9]{24}$/.test(w1.sid), "スマホの人が入る（sid をもらう）");
  const sid = w1.sid;
  await sleep(200);
  // 裏に回って切れたことに気づかないまま、2 本目でつなぎ直す（1 本目はサーバーに残っている）
  obs.msgs.length = 0;
  const a2 = await openWs(wsUrl(g1.token));
  a2.ws.send(JSON.stringify({ t: "hello", sid }));
  const w2 = await waitFor(a2, x => x.t === "welcome");
  check(w2 && w2.verified && w2.sid === sid, "同じ sid でつなぎ直す → そのまま入れる（選びなおさなくてよい）");
  for (let i = 0; i < 40 && !a1.closed; i++) await sleep(50);
  check(a1.closed && a1.closed.code === 4004, "古い接続はサーバーが閉じる（4004）→ " + JSON.stringify(a1.closed));
  await sleep(400);
  const lastPeers = [...obs.msgs].reverse().find(x => x.t === "peers");
  check(lastPeers && lastPeers.peers.filter(p => p.sid === sid).length === 1, "古い接続が閉じても、ほかの人の一覧からスマホの人が消えない（1 人だけ）");
  a2.ws.close(); obs.ws.close();
} catch (e) {
  console.error(e);
  fail++;
}

// ---- www.<サイトのドメイン> → www なしへ ----
try {
  const hostGet = (host, p, method = "GET", extra = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { Host: host, ...extra } }, res => { res.resume(); res.on("end", () => resolve(res)); });
    r.on("error", reject); r.end();
  });
  const w = await hostGet("www.example.workers.dev", "/talk/?r=123456");
  check(w.statusCode === 301 && w.headers.location === "https://example.workers.dev/talk/?r=123456", "www でひらく → www なしへ 301 → " + w.statusCode + " " + w.headers.location);
  const n = await hostGet("example.workers.dev", "/health");
  check(n.statusCode === 200, "www なしはそのまま → " + n.statusCode);
  const p = await hostGet("www.example.workers.dev", "/api/news", "POST");
  check(p.statusCode !== 301, "POST は移動しない → " + p.statusCode);
  const wh = await hostGet("www.home.example", "/?a=1");
  check(wh.statusCode === 301 && wh.headers.location === "https://home.example/?a=1", "www.<まよ鯖のホーム> → www なしへ 301 → " + wh.headers.location);
  const wk = await hostGet("www.kamen.example", "/");
  check(wk.statusCode === 301 && wk.headers.location === "https://kamen.example/", "www.<かめん部> → www なしへ 301 → " + wk.headers.location);
} catch (e) {
  console.error(e);
  fail++;
}

// ---- 3 つのサイト（トップ「/」はホスト名で中身が変わる） ----
try {
  const hostBody = (host, p, method = "GET") => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { Host: host } }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", reject); r.end();
  });
  check((await hostBody("home.example", "/")).body === "asset:/_home/", "まよ鯖のホームの「/」→ public/_home/");
  check((await hostBody("HOME.example", "/")).body === "asset:/_home/", "ホスト名の大文字・小文字はちがってもよい");
  check((await hostBody("kamen.example", "/")).body === "asset:/_kamen/", "かめん部の「/」→ public/_kamen/");
  check((await hostBody("example.workers.dev", "/")).body === "asset:/", "ツールのアドレスの「/」→ ツールのトップ（public/index.html）");
  check((await hostBody("tool.example", "/")).body === "asset:/", "知らないアドレスの「/」→ ツールのトップ");
  check((await hostBody("home.example", "/corpse/")).body === "asset:/corpse/", "まよ鯖のホームでも /corpse/ などはそのまま（config.js がツールのアドレスへ移す）");
  const hd = await hostBody("home.example", "/", "HEAD");
  check(hd.status === 404 && hd.body === "", "HEAD も同じように返す（中身なし）");
  check((await hostBody("home.example", "/health")).status === 200, "まよ鯖のホームでも /health は Worker");
  // 人数: Discord に届かないとき → ok:false（招待コードは返す）
  // 人数: Discord が一度も読めていないとき → ok:false（数は出さない）・招待コードは返す
  const dc = await hostBody("home.example", "/api/home/discord");
  const dj = JSON.parse(dc.body);
  check(dc.status === 200 && dj.ok === false && dj.members === null && dj.live === false && dj.invite === "abcDEF12" && dc.headers["cache-control"] === "no-store", "Discord の人数が一度も読めていないとき → ok:false・数は出さない・招待コードは返す");
  // お知らせ: まよ鯖のホーム（site=home）とツールは別々
  const login = await post("/api/setup/auth", { key: KEY });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const admin = async body => { const r = await post("/api/admin/news", body, { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json() }; };
  const before = (await (await req("/api/news")).json()).items.length;
  const h0 = await admin({ action: "list", site: "home" });
  check(h0.j.ok && h0.j.site === "home" && h0.j.items.length === 0, "まよ鯖のホームのお知らせは、はじめは 0 件（ツールのものはまざらない）");
  const hs = await admin({ action: "save", site: "home", item: { type: "info", title: "夏祭りイベント", body: "8/1 21:00〜", published: true } });
  check(hs.j.ok && hs.j.site === "home" && hs.j.items.length === 1, "まよ鯖のホームにお知らせを投稿");
  const hp = await (await req("/api/news?site=home")).json();
  check(hp.ok && hp.site === "home" && hp.items.length === 1 && hp.items[0].title === "夏祭りイベント", "/api/news?site=home にだけ出る");
  const tp = await (await req("/api/news")).json();
  check(tp.site === "tool" && tp.items.length === before && !tp.items.some(n => n.title === "夏祭りイベント"), "ツールのお知らせ（/api/news）には出ない");
  const odd = await (await req("/api/news?site=zzz")).json();
  check(odd.site === "tool", "知らない site はツールのお知らせ");
  const hdel = await admin({ action: "delete", site: "home", id: hs.j.saved });
  check(hdel.j.ok && hdel.j.items.length === 0, "まよ鯖のホームのお知らせを消す");
  const tl = await admin({ action: "list" });
  check(tl.j.site === "tool" && tl.j.items.length === 50, "site なしはツールのお知らせ（そのまま 50 件）");

  // ---- まよ鯖ホームの人数（招待リンクから・最後に読めた数を残す・/setup/ で招待リンクを変える） ----
  const home = async body => { const r = body ? await post("/api/admin/home", body, { headers: { Cookie: cookie } }) : await req("/api/admin/home", { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json() }; };
  check((await req("/api/admin/home")).status === 401, "ログインなしで /api/admin/home → 401");
  fakeDiscord.mode = "ok";
  let h = await home();
  check(h.j.ok && h.j.members === 81 && h.j.online === 23 && h.j.live === true && h.j.invite === "abcDEF12" && h.j.fromSetup === false && h.j.envInvite === "abcDEF12" && !h.j.error, "管理者: いまの人数（81 人・オンライン 23 人）→ " + JSON.stringify(h.j));
  let pub2 = JSON.parse((await hostBody("home.example", "/api/home/discord")).body);
  check(pub2.ok && pub2.members === 81 && pub2.online === 23 && pub2.live === true, "ホーム: いまの人数が出る");
  const callsBefore = fakeDiscord.calls;
  await hostBody("home.example", "/api/home/discord"); await hostBody("home.example", "/api/home/discord");
  check(fakeDiscord.calls === callsBefore, "3 分のあいだは Discord に聞きに行かない（おぼえている数）");
  h = await home({ invite: "https://discord.gg/NewCode99?event=1" });
  check(h.j.invite === "NewCode99" && h.j.fromSetup === true && h.j.error === "invite" && h.j.members === null && /期限なし/.test(h.j.errorText), "切れた招待リンクを入れる → エラーと理由（ちがう招待リンクの古い数は出さない）→ " + JSON.stringify(h.j));
  check((await home({ invite: "hello world" })).status === 400, "招待リンクの形がちがう → 400");
  fakeDiscord.mode = "down";
  h = await home({ invite: "discord.com/invite/abcDEF12" });
  check(h.j.invite === "abcDEF12" && h.j.error === "http500" && h.j.members === 81 && h.j.live === false && typeof h.j.at === "number", "Discord が読めないとき → 最後に読めた数（81 人）と、その時間を出す");
  pub2 = JSON.parse((await hostBody("home.example", "/api/home/discord")).body);
  check(pub2.ok && pub2.members === 81 && pub2.live === false && pub2.invite === "abcDEF12", "ホーム: 読めないときは最後に読めた数（live:false）");
  h = await home({ invite: "" });
  check(h.j.invite === "abcDEF12" && h.j.fromSetup === false, "招待リンクを空にする → wrangler.toml の招待コードにもどる");
} catch (e) {
  console.error(e);
  fail++;
}
if (fail) { console.log(wdLog.slice(-3000)); console.log(`NG が ${fail} 件`); stop(1); }
console.log("すべて成功");
stop(0);
