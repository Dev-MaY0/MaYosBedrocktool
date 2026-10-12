// =====================================================================
//  近接VC の接続テスト（Minecraft の /wsserver と同じ形で、Worker に WebSocket でつなぐ）
//
//  使い方（このフォルダの 1 つ上 = cloudflare フォルダで）:
//    npm install
//    npm test
//
//  wrangler dev ではなく workerd（Cloudflare Workers と同じ実行環境）を直接動かします。
//  wrangler dev は手前に別の層があり、WebSocket の圧縮をその層が決めてしまうため、
//  本番と同じ「Worker が直接 WebSocket を受ける」形で確かめます。
//  Discord は、このテストの中の「にせの Discord」を使います（本物には何も送りません）。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// wrangler といっしょに入る workerd（各 OS 用の実行ファイルの場所を教えてくれる）
const WORKERD = require("workerd").default;
const MOCK_PORT = 9931, PORT = 8731, GUILD = "123456789012345678", APP = "999999999999999999";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (c, m) => { console.log((c ? "  ok  " : "  NG  ") + m); if (!c) fail++; };

// ---------------- にせの Discord ----------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const edits = {};
let nextId = 500000000000000000n;
const channels = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks), body = raw.toString("utf8");
    const p = new URL(req.url, "http://x").pathname.replace(/^\/api\/v10/, "");
    const send = (s, j) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(j === undefined ? "" : JSON.stringify(j)); };
    let m;
    if ((m = /^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/.exec(p))) {
      const ct = req.headers["content-type"] || "";
      const payload = ct.startsWith("multipart/form-data")
        ? JSON.parse((await new Response(raw, { headers: { "content-type": ct } }).formData()).get("payload_json"))
        : JSON.parse(body);
      (edits[m[1]] = edits[m[1]] || []).push(payload.content || "");
      return send(200, {});
    }
    if (req.headers.authorization !== "Bot test-token") return send(401, { message: "401: Unauthorized" });
    if (p === "/applications/@me" && req.method === "GET") return send(200, { id: APP, name: "テストBot", verify_key: pubHex });
    if (p === "/applications/@me" && req.method === "PATCH") {
      // 本物と同じく、Bot の URL に PING を送って確かめる
      const url = JSON.parse(body).interactions_endpoint_url;
      const ping = JSON.stringify({ type: 1 }), ts = String(Math.floor(Date.now() / 1000));
      const r = await fetch(url, { method: "POST", body: ping, headers: { "X-Signature-Ed25519": crypto.sign(null, Buffer.from(ts + ping), privateKey).toString("hex"), "X-Signature-Timestamp": ts } });
      return r.ok ? send(200, { id: APP }) : send(400, { message: "invalid endpoint" });
    }
    if (p === `/applications/${APP}/commands`) return send(200, JSON.parse(body));
    if (p === `/guilds/${GUILD}`) return send(200, { id: GUILD, name: "テストサーバー" });
    if (p === `/guilds/${GUILD}/channels` && req.method === "GET") return send(200, channels);
    if (p === `/guilds/${GUILD}/channels` && req.method === "POST") {
      const b = JSON.parse(body); const ch = { id: String(nextId++), name: b.name, type: b.type, parent_id: b.parent_id || null };
      channels.push(ch); return send(201, ch);
    }
    if (/^\/guilds\/\d+\/voice-states\/\d+$/.test(p)) return send(404, { code: 10065 });
    send(404, { message: "mock: " + req.method + " " + p });
  });
});
await new Promise(r => mock.listen(MOCK_PORT, "127.0.0.1", r));

// ---------------- workerd（wrangler.toml の設定をそのまま使う）----------------
const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const compatDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml) || [])[1];
const flags = [...((/^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-test-"));
fs.mkdirSync(path.join(tmp, "src"));
const mods = fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js"));
for (const f of mods) fs.copyFileSync(path.join(ROOT, "src", f), path.join(tmp, "src", f));
fs.writeFileSync(path.join(tmp, "assets.js"), 'export default { fetch() { return new Response("not found", { status: 404 }); } };\n');
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
  durableObjectNamespaces = [ (className = "GuildRoom", uniqueKey = "guildroom-test", enableSql = true) ],
  durableObjectStorage = (inMemory = void),
  globalOutbound = "net",
  bindings = [ (name = "GUILD", durableObjectNamespace = (className = "GuildRoom")), (name = "ASSETS", service = "assets"),
               (name = "DISCORD_API", text = "http://127.0.0.1:${MOCK_PORT}/api/v10"), (name = "SITE_URL", text = "https://example.workers.dev") ],
);
const a :Workerd.Worker = ( modules = [ (name = "assets.js", esModule = embed "assets.js") ], compatibilityDate = "${compatDate}" );
`);
const wd = spawn(WORKERD, ["serve", "--experimental", path.join(tmp, "config.capnp")], { stdio: ["ignore", "pipe", "pipe"] });
let wdLog = "";
wd.stdout.on("data", d => (wdLog += d)); wd.stderr.on("data", d => (wdLog += d));
const BASE = `http://127.0.0.1:${PORT}`;
const stop = code => { wd.kill(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch (e) { /* 待つ */ } await sleep(250); }

console.log(`compatibility_date = ${compatDate} / compatibility_flags = [${flags.join(", ")}]`);
try {
  // ---- HTTP のルート ----
  const h = await fetch(BASE + "/health");
  check(h.ok && (await h.text()).includes("近接VC Bot"), "HTTP: /health");
  const su = await (await fetch(BASE + "/api/setup", { method: "POST", body: JSON.stringify({ token: "test-token" }), headers: { "Content-Type": "application/json" } })).json();
  check(su.ok, "HTTP: /api/setup でトークンを登録 " + (su.error || ""));

  // ---- Discord の /vc setup（部屋と接続コードを作る）----
  const token = "tok1";
  const it = JSON.stringify({ type: 2, id: "1", application_id: APP, token, guild_id: GUILD,
    member: { permissions: "32", user: { id: "111111111111111111", username: "admin" } }, data: { name: "vc", options: [{ type: 1, name: "setup", options: [] }] } });
  const ts = String(Math.floor(Date.now() / 1000));
  const ir = await fetch(BASE + "/interactions", { method: "POST", body: it, headers: { "X-Signature-Ed25519": crypto.sign(null, Buffer.from(ts + it), privateKey).toString("hex"), "X-Signature-Timestamp": ts } });
  check((await ir.json()).type === 5, "Discord: /vc setup を受け付ける");
  let text = "";
  for (let i = 0; i < 80 && !/準備ができました/.test(text); i++) { await sleep(100); text = (edits[token] || []).join("\n"); }
  const CODE = (/\/wsserver ws:\/\/[^/]+\/v\/([A-Z2-9]{8})/.exec(text) || [])[1];
  check(!!CODE, `Discord: /wsserver のコマンドと接続コード（${CODE}）`);

  // ---- /v/<コード> の HTTP ----
  const page = await fetch(`${BASE}/v/${CODE}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  check(page.status === 200 && /接続チェック/.test(await page.text()), "HTTP: ブラウザでひらくと接続チェック");
  const j0 = await (await fetch(`${BASE}/v/${CODE.toLowerCase()}?json=1`)).json();
  check(j0.ok && j0.guildName === "テストサーバー", "HTTP: 接続コードは大文字・小文字どちらでもOK");

  // ---- WebSocket Upgrade ----
  const bad = await rawWs(`/v/ABCDEFGH`, {});
  check(/ 404 /.test(bad.status), "Upgrade: ちがう接続コードは 404（101 にしない）");
  bad.sock.destroy();
  const mc = await rawWs(`/v/${CODE}`, {
    "Sec-WebSocket-Protocol": "com.microsoft.minecraft.wsencrypt",
    "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
    "User-Agent": "TestClient/1.0",
  });
  console.log("---- 101 のレスポンス ----\n" + mc.rawHead + "\n----");
  check(/^HTTP\/1\.1 101 /.test(mc.status) && mc.acceptOk, "Upgrade: 101 Switching Protocols・Sec-WebSocket-Accept が正しい");
  check(mc.headers["sec-websocket-protocol"] === "com.microsoft.minecraft.wsencrypt", "Upgrade: 暗号化のサブプロトコルを返す");
  check(!mc.headers["sec-websocket-extensions"], "Upgrade: 圧縮（permessage-deflate）を使わない" + (mc.headers["sec-websocket-extensions"] ? `（${mc.headers["sec-websocket-extensions"]} が返った）` : ""));

  // ---- Durable Object からのフレーム（暗号化の準備）----
  const f1 = await mc.next(4000);
  check(f1 && !f1.rsv1 && !f1.rsv2 && !f1.rsv3 && !f1.masked && f1.opcode === 1, "DO: 最初のフレームはテキスト・RSV ビット 0（圧縮なし）・マスクなし");
  let cmd = null;
  try { cmd = JSON.parse(f1.payload.toString()); } catch (e) { cmd = null; }
  const line = cmd && cmd.body && cmd.body.commandLine || "";
  check(/^enableencryption "[^"]+" "[^"]+" cfb8$/.test(line), "DO: 最初は enableencryption（平文）");
  // Minecraft と同じやり方で鍵を交換する（ECDH P-384 → SHA-256 → AES-256-CFB8）
  const ASN1 = Buffer.from("3076301006072a8648ce3d020106052b81040022036200", "hex");
  const args = line.split(" ");
  const ecdh = crypto.createECDH("secp384r1"); const myPub = ecdh.generateKeys();
  const key = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(JSON.parse(args[2]), "base64"), ecdh.computeSecret(Buffer.from(JSON.parse(args[1]), "base64").subarray(ASN1.length))])).digest();
  mc.send(1, JSON.stringify({ header: { requestId: cmd.header.requestId, messagePurpose: "commandResponse", version: 1 }, body: { publicKey: Buffer.concat([ASN1, myPub]).toString("base64"), statusCode: 0 } }));
  const dec = crypto.createDecipheriv("aes-256-cfb8", key, key.subarray(0, 16));
  const got = [];
  for (let i = 0; i < 6; i++) {
    const f = await mc.next(4000);
    if (!f) break;
    try { got.push({ binary: f.opcode === 2, rsv1: f.rsv1, m: JSON.parse(dec.update(f.payload).toString("utf8")) }); } catch (e) { got.push({ bad: true }); }
  }
  check(got.length >= 3 && got.every(g => g.binary && !g.rsv1 && !g.bad), `DO: 暗号化のあとはバイナリで、すべて復号できる（${got.length}件）`);
  check(got.some(g => g.m && g.m.header.messagePurpose === "subscribe" && g.m.body.eventName === "PlayerMessage"), "DO: PlayerMessage を購読");
  check(got.some(g => g.m && /つながりました/.test(g.m.body.commandLine || "")), "DO: 「つながりました」を送る");

  // ---- 切断の記録（本番で出た「コード 59907」と同じ close フレームを送る）----
  mc.send(8, Buffer.from([0xEA, 0x03]));
  await sleep(1200);
  mc.sock.destroy();
  const j = await (await fetch(`${BASE}/v/${CODE}?json=1`)).json();
  const close = j.tries.find(x => x.kind === "close"), open = j.tries.find(x => x.kind === "open");
  check(close && /バイト順を戻すと 1002/.test(close.text), "記録: 59907 を「1002: プロトコルエラー」と読む → " + (close && close.text));
  check(close && /Bot→MC \d+件・MC→Bot \d+件/.test(close.detail), "記録: 切れるまでのやりとりの件数 → " + (close && close.detail));
  check(open && /拡張: permessage-deflate/.test(open.detail) && /UA: TestClient/.test(open.detail), "記録: Minecraft が送ってきた条件 → " + (open && open.detail));

  // ---- 暗号化なし（Minecraft の「暗号化された WebSocket を要求」オフ）----
  const plain = await rawWs(`/v/${CODE}`, {});
  check(/ 101 /.test(plain.status) && !plain.headers["sec-websocket-protocol"], "Upgrade: 暗号化なしでも 101（サブプロトコルなし）");
  const p1 = await plain.next(4000);
  let pm = null; try { pm = JSON.parse(p1.payload.toString()); } catch (e) { pm = null; }
  check(pm && pm.header.messagePurpose === "subscribe" && !p1.rsv1, "DO: 暗号化なしなら平文の subscribe から始まる");
  plain.send(8, Buffer.from([0x03, 0xE8]));
  await sleep(500);
  plain.sock.destroy();
} catch (e) {
  check(false, "例外: " + (e && e.stack || e));
  console.log(wdLog.slice(-2000));
}
console.log(fail ? `失敗: ${fail}` : "すべて成功");
stop(fail ? 1 : 0);

/** 生の WebSocket クライアント（Minecraft と同じく、HTTP/1.1 で Upgrade する） */
function rawWs(p, extra) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0), done = false;
    const frames = [], waiters = [];
    const api = {
      sock, frames,
      next(ms) {
        if (frames.length) return Promise.resolve(frames.shift());
        return new Promise(r => { const t = setTimeout(() => r(null), ms); waiters.push(f => { clearTimeout(t); r(f); }); });
      },
      send(opcode, payload) {
        const data = Buffer.from(payload), mask = crypto.randomBytes(4);
        const hd = data.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | data.length])
          : Buffer.from([0x80 | opcode, 0x80 | 126, data.length >> 8, data.length & 255]);
        sock.write(Buffer.concat([hd, mask, Buffer.from(data.map((b, i) => b ^ mask[i % 4]))]));
      },
    };
    sock.on("connect", () => sock.write([`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n")));
    sock.on("error", reject);
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (!done) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.subarray(0, i).toString("latin1");
        buf = buf.subarray(i + 4);
        const [status, ...hl] = head.split("\r\n");
        const headers = {};
        for (const l of hl) { const k = l.indexOf(":"); headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
        api.status = status; api.headers = headers; api.rawHead = head;
        api.acceptOk = headers["sec-websocket-accept"] === crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        done = true;
        resolve(api);
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(b1 & 0x80);
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const f = { opcode: b0 & 15, rsv1: !!(b0 & 64), rsv2: !!(b0 & 32), rsv3: !!(b0 & 16), masked, payload: buf.subarray(off, off + len) };
        buf = buf.subarray(off + len);
        if (waiters.length) waiters.shift()(f); else frames.push(f);
      }
    });
  });
}
