// =====================================================================
//  /setup/ のパスワードロック・設定 API のガード・サイトの部屋（内部 ID）のテスト
//
//  使い方（cloudflare フォルダで）:  npm install && node test/setup-gate.test.mjs
//  workerd（Cloudflare Workers と同じ実行環境）を直接動かします。Discord には何も送りません。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const WORKERD = require("workerd").default;
const PORT = 8732, KEY = "Test-Setup-Key-0123456789abcdef";
const MARK = "SETUP-PAGE-BODY-MARKER";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (c, m) => { console.log((c ? "  ok  " : "  NG  ") + m); if (!c) fail++; };

const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const compatDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml) || [])[1];
const flags = [...((/^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-gate-"));
fs.mkdirSync(path.join(tmp, "src"));
const mods = fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js"));
for (const f of mods) fs.copyFileSync(path.join(ROOT, "src", f), path.join(tmp, "src", f));
// にせの「サイトのファイル」: 設定ページの本体（/_admin/setup/）だけ、目印つきで返す
fs.writeFileSync(path.join(tmp, "assets.js"), `export default { fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/_admin/setup/") return new Response("<!doctype html><html><body>${MARK}</body></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return new Response("not found", { status: 404 });
} };\n`);
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
  durableObjectNamespaces = [ (className = "GuildRoom", uniqueKey = "guildroom-gate-test", enableSql = true) ],
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
let relay = null;
const stop = code => { wd.kill(); if (relay) relay.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch (e) { /* 待つ */ } await sleep(250); }

let ipN = 0;
const freshIp = () => `10.1.${(ipN >> 8) & 255}.${ipN++ & 255}`;
const req = (p, o = {}) => fetch(BASE + p, { redirect: "manual", ...o, headers: { "CF-Connecting-IP": o.ip || freshIp(), ...(o.headers || {}) } });
const post = (p, body, o = {}) => req(p, { method: "POST", body: JSON.stringify(body), ...o, headers: { "Content-Type": "application/json", ...(o.headers || {}) } });

try {
  // ---- /setup/ : パスワードを入れるまでは、窓だけ ----
  for (const p of ["/setup/", "/setup"]) {
    const r = await req(p);
    const t = await r.text();
    check(r.status === 200 && /type="password"/.test(t) && !t.includes(MARK), `未ログインで ${p} → パスワードの窓だけ（設定ページの本体は出ない）`);
    check(!/Reset Token|Public Bot|PRESENCE INTENT|設定する|Bot のトークン/.test(t), `未ログインで ${p} → 説明文・入力欄は 1 つも出ない`);
    check(/no-store/.test(r.headers.get("cache-control") || "") && /noindex/.test(r.headers.get("x-robots-tag") || ""), `${p} は保存されない・検索に出ない`);
  }
  for (const p of ["/_admin/setup/", "/_admin/setup/index.html", "/_admin/", "/setup/index.html", "/setup/anything"]) {
    const r = await req(p);
    check(r.status === 404 && !(await r.text()).includes(MARK), `${p} を直接ひらく → 404（本体は見えない）`);
  }

  // ---- 設定の API は、ログインなしだと何も返さない ----
  for (const [m, p] of [["GET", "/api/setup/status"], ["POST", "/api/setup"], ["POST", "/api/setup/relay"], ["POST", "/api/setup/relay/test"], ["POST", "/api/setup/vps"], ["POST", "/api/admin/chat"]]) {
    const r = await req(p, { method: m, body: m === "POST" ? "{}" : undefined, headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    check(r.status === 401 && j.needAuth === true && j.ok === false && !("appId" in j) && !("configured" in j), `未ログインで ${m} ${p} → 401（設定やBotの様子を返さない）`);
  }
  const info = await (await req("/api/info")).json();
  check(info.ok === true, "一般向けの /api/info はそのまま使える");

  // ---- パスワード ----
  const ipA = freshIp();
  const bad = await post("/api/setup/auth", { key: "wrong" }, { ip: ipA });
  check(bad.status === 403 && !bad.headers.get("set-cookie"), "まちがったパスワード → 403・Cookie は渡さない");
  const good = await post("/api/setup/auth", { key: KEY }, { ip: ipA });
  const setCookie = good.headers.get("set-cookie") || "";
  check(good.status === 200 && (await good.json()).ok === true, "正しいパスワード → 200");
  check(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Max-Age=43200/.test(setCookie), "入室の印: HttpOnly・SameSite=Strict・12 時間 → " + setCookie.replace(/=[0-9.a-f]{20,}/, "=…"));
  const cookie = setCookie.split(";")[0];

  // ---- ログイン後 ----
  const page = await req("/setup/", { headers: { Cookie: cookie } });
  const pt = await page.text();
  check(page.status === 200 && pt.includes(MARK) && !/type="password"/.test(pt), "ログイン後の /setup/ → 設定ページの本体");
  const st = await req("/api/setup/status", { headers: { Cookie: cookie } });
  const sj = await st.json();
  check(st.status === 200 && sj.ok === true && sj.needSetupKey === false, "ログイン後の /api/setup/status → 返す（設定用のキーをもう一度は聞かない）");
  const vps = await post("/api/setup/vps", {}, { headers: { Cookie: cookie } });
  check(vps.status === 400, "ログイン後は、API の中の確認（Bot のトークン）まで進む → " + vps.status);

  // ---- にせの Cookie ----
  const [name, val] = cookie.split("=");
  const [exp, sig] = val.split(".");
  const forged = [
    `${name}=${exp}.${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`,                                   // 署名を 1 文字変える
    `${name}=${Date.now() + 3600000}.${sig}`,                                                               // 期限だけ書き換える
    `${name}=${Date.now() - 1000}.${crypto.createHmac("sha256", "setup-session|" + KEY).update("setup-session:" + (Date.now() - 1000)).digest("hex")}`,   // 期限切れ
    `${name}=${Date.now() + 3600000}.${crypto.createHmac("sha256", "setup-session|other-key").update("setup-session:" + (Date.now() + 3600000)).digest("hex")}`, // ほかのキーで署名
    `${name}=`,
  ];
  let allBlocked = true;
  for (const c of forged) {
    const r1 = await req("/setup/", { headers: { Cookie: c } });
    const r2 = await req("/api/setup/status", { headers: { Cookie: c } });
    if ((await r1.text()).includes(MARK) || r2.status !== 401) allBlocked = false;
  }
  check(allBlocked, "にせの入室の印（署名ちがい・期限の書きかえ・期限切れ・ほかのキー）は、すべて入れない");

  // ---- 総当たりよけ ----
  const ipB = freshIp();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post("/api/setup/auth", { key: "x" + i }, { ip: ipB })).status;
  check(last === 429, "同じ IP から何回もまちがえる → 429（1 時間に 10 回まで）");

  // ---- サイトの部屋: 内部 ID と部屋番号 ----
  const ids = new Set();
  let okFormat = true, okInfo = true;
  for (let i = 0; i < 25; i++) {
    const r = await post("/api/web/rooms", { name: "テスト" + i });
    const j = await r.json();
    if (!j.ok || !/^\d{6}$/.test(j.roomId) || !/^[A-Za-z0-9]{24}$/.test(j.hostKey)) { okFormat = false; continue; }
    ids.add(j.roomId);
    const info = await (await req("/api/web/room?r=" + j.roomId)).json();
    if (!info.ok || info.name !== "テスト" + i) okInfo = false;
  }
  check(okFormat && ids.size === 25, "部屋を 25 個作る → 部屋番号は 6 けたで、ぜんぶちがう（" + ids.size + " 個）");
  check(okInfo, "部屋番号から、それぞれの部屋にたどりつく（内部 ID に変換）");
  const none = await req("/api/web/room?r=000001");
  check(none.status === 404, "ない部屋番号 → 404");

  // 部屋番号 → ホスト操作 → ワールドの接続コード（8 文字）→ /v/<コード> が同じ部屋に届く
  const made = await (await post("/api/web/rooms", { name: "つながるか" })).json();
  const host = await (await post("/api/web/host", { r: made.roomId, hostKey: made.hostKey, action: "get" })).json();
  check(host.ok && /^[A-HJ-NP-Z2-9]{8}$/.test(host.worldCode), "ホスト操作でワールドの接続コード（8 文字）が出る → " + host.worldCode);
  const diag = await (await req(`/v/${host.worldCode}?json=1`)).json();
  check(diag.ok === true, "/v/<接続コード> が、その部屋（長い内部 ID の部屋）にとどく");
  const badHost = await post("/api/web/host", { r: made.roomId, hostKey: "wrongwrongwrong", action: "get" });
  check(badHost.status === 403, "管理用のキーがちがうと、ホスト操作はできない");

  // マイクラの /wsserver ws://…/new → 部屋ができて、ゲームのチャットに 6 けたの部屋番号が出る
  const mc = await rawWs("/new", { "CF-Connecting-IP": freshIp() });
  check(/ 101 /.test(mc.status), "/new に WebSocket でつなぐ → 101");
  let roomNo = "";
  for (let i = 0; i < 14 && !roomNo; i++) {
    const f = await mc.next(3000);
    if (!f) break;
    const m = /部屋番号: §e§l(\d{6})/.exec(f.payload.toString());
    if (m) roomNo = m[1];
  }
  check(/^\d{6}$/.test(roomNo), "/new で作った部屋の番号がゲームのチャットに出る → " + roomNo);
  if (roomNo) {
    const info = await (await req("/api/web/room?r=" + roomNo)).json();
    check(info.ok === true && info.world === true, "その部屋番号で、サイトからひらける（ワールドとつながっている）");
  }
  mc.sock.destroy();

  // ---- リレー（relay/relay.mjs）: 知らない人どうしが同時につないでも、それぞれ別の部屋になる ----
  //      リレーは Bot のトークンを持たず、バイトをそのまま流すだけ（部屋の割り当ては Worker がする）
  const RELAY_PORT = 8733;
  relay = spawn(process.execPath, [path.join(ROOT, "relay", "relay.mjs")], {
    env: { ...process.env, WORKER_HOST: `127.0.0.1:${PORT}`, UPSTREAM_TLS: "0", PORT: String(RELAY_PORT), HOST: "127.0.0.1", PER_IP_MAX: "0", PER_IP_RATE: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).ok) break; } catch (e) { /* 待つ */ } await sleep(150); }
  const N = 8;
  const conns = await Promise.all(Array.from({ length: N }, () => rawWs("/new", {}, RELAY_PORT)));
  check(conns.every(c => / 101 /.test(c.status)), `リレー経由で ${N} 人が同時に /new につなぐ → 全員 101`);
  const nos = await Promise.all(conns.map(async c => {
    for (let i = 0; i < 14; i++) {
      const f = await c.next(3000);
      if (!f) return "";
      const m = /部屋番号: §e§l(\d{6})/.exec(f.payload.toString());
      if (m) return m[1];
    }
    return "";
  }));
  check(nos.every(n => /^\d{6}$/.test(n)) && new Set(nos).size === N, `リレー経由の ${N} 人に、それぞれ別の部屋番号 → ${nos.join(" ")}`);
  for (const c of conns) c.sock.destroy();
} catch (e) {
  check(false, "例外: " + (e && e.stack || e));
  console.log(wdLog.slice(-2000));
}
console.log(fail ? `失敗: ${fail}` : "すべて成功");
stop(fail ? 1 : 0);

/** 生の WebSocket クライアント */
function rawWs(p, extra, port = PORT) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), done = false;
    const frames = [], waiters = [];
    const api = {
      sock, frames,
      next(ms) {
        if (frames.length) return Promise.resolve(frames.shift());
        return new Promise(r => { const t = setTimeout(() => r(null), ms); waiters.push(f => { clearTimeout(t); r(f); }); });
      },
    };
    sock.on("connect", () => sock.write([`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n")));
    sock.on("error", reject);
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (!done) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.subarray(0, i).toString("latin1");
        buf = buf.subarray(i + 4);
        api.status = head.split("\r\n")[0];
        done = true;
        resolve(api);
      }
      while (buf.length >= 2) {
        const b1 = buf[1];
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (b1 & 0x80) off += 4;
        if (buf.length < off + len) return;
        const f = { opcode: buf[0] & 15, payload: buf.subarray(off, off + len) };
        buf = buf.subarray(off + len);
        if (waiters.length) waiters.shift()(f); else frames.push(f);
      }
    });
  });
}
