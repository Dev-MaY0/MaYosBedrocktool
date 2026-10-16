// =====================================================================
//  お知らせ（/api/news・/api/admin/news）と、サイト内VC のつなぎ直し（同じブラウザの入れかえ）のテスト
//
//  使い方（cloudflare フォルダで）:  npm install && node test/news-reconnect.test.mjs
//  workerd（Cloudflare Workers と同じ実行環境）を直接動かします。Discord には何も送りません。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-news-"));
fs.mkdirSync(path.join(tmp, "src"));
const mods = fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js"));
for (const f of mods) fs.copyFileSync(path.join(ROOT, "src", f), path.join(tmp, "src", f));
fs.writeFileSync(path.join(tmp, "assets.js"), `export default { fetch() { return new Response("not found", { status: 404 }); } };\n`);
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
               (name = "DISCORD_API", text = "http://127.0.0.1:9/api/v10"), (name = "SETUP_KEY", text = "${KEY}"),
               (name = "SITE_URL", text = "https://example.workers.dev") ],
);
const a :Workerd.Worker = ( modules = [ (name = "assets.js", esModule = embed "assets.js") ], compatibilityDate = "${compatDate}" );
`);
const wd = spawn(WORKERD, ["serve", "--experimental", path.join(tmp, "config.capnp")], { stdio: ["ignore", "pipe", "pipe"] });
let wdLog = "";
wd.stdout.on("data", d => (wdLog += d)); wd.stderr.on("data", d => (wdLog += d));
const BASE = `http://127.0.0.1:${PORT}`;
const stop = code => { wd.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
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
if (fail) { console.log(wdLog.slice(-3000)); console.log(`NG が ${fail} 件`); stop(1); }
console.log("すべて成功");
stop(0);
