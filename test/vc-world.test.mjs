// =====================================================================
//  サイト内VC の聞こえ方のテスト
//   ・死んだ人の見分け方（testfor @a と testfor @e[type=player] をくらべる。アドオンなし）
//   ・ワールドにいるのに位置が分からない人をロビーにしない（どれだけ離れても聞こえていた）
//   ・覚えている ID が古くなった人（ワールドが変わった・入り直した）を、名前で読み直す
//   ・距離・ディメンションの表示は、ふだん「非表示」
//  ニセの Minecraft（/wsserver）とブラウザ（WebSocket）を、workerd につないでためします。
//
//  使い方（cloudflare フォルダで）:  npm install && node test/vc-world.test.mjs
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const WORKERD = require("workerd").default;
const PORT = 8734;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (c, m) => { console.log((c ? "  ok  " : "  NG  ") + m); if (!c) fail++; };

// ---- 1) 計算だけのテスト（ブラウザと同じ式）----
const { gainRule, cleanRules, DEFAULT_RULES } = await import(pathToFileURL(path.join(ROOT, "src", "webvc.js")).href);
{
  const R = DEFAULT_RULES;
  const at = (x, extra = {}) => ({ pos: { x, y: 64, z: 0, d: 0 }, dead: false, spec: false, inGame: true, ...extra });
  const out = { pos: null, dead: false, spec: false, inGame: false };
  check(DEFAULT_RULES.showInfo === false && cleanRules({}).showInfo === false && cleanRules({ showInfo: true }).showInfo === true, "距離・ディメンションの表示は、ふだん非表示");
  check(gainRule(at(0), at(1), 20, R) === 1, "近い人（1 ブロック）→ よく聞こえる");
  check(gainRule(at(0), at(19.9), 20, R) < 0.01, "届く距離のはし → ほぼ聞こえない");
  check(gainRule(at(0), at(500), 20, R) === 0, "遠い人（500 ブロック）→ 聞こえない");
  check(gainRule(at(0), at(1, { pos: { x: 1, y: 64, z: 0, d: 1 } }), 20, R) === 0, "ちがうディメンション → 聞こえない");
  check(gainRule(at(0), at(1, { dead: true }), 20, R) === 0, "生きている人には、死んだ人の声は聞こえない（すぐ近くでも）");
  check(gainRule(at(1, { dead: true }), at(0), 20, R) === 0, "死んだ人には、生きている人の声は聞こえない（ふだん）");
  check(gainRule(at(1, { dead: true }), at(900, { dead: true }), 20, R) === 1, "死んだ人どうしは話せる");
  check(gainRule({ ...out, inGame: true, dead: true }, { ...out, spec: true }, 20, R) === 1, "位置が分からない死んだ人も、観戦者どうしで話せる");
  check(gainRule(at(0), { ...out, inGame: true, dead: true }, 20, R) === 0, "位置が分からない死んだ人の声は、生きている人に聞こえない");
  check(gainRule({ ...out, inGame: true }, { ...out, inGame: true }, 20, R) === 0, "ワールドにいるのに位置が分からない人どうし → ロビーにしない（聞こえない）");
  check(gainRule(out, { ...out, inGame: true }, 20, R) === 0, "ゲームにいない人と、位置が分からないワールドの人 → 聞こえない");
  check(gainRule(out, out, 20, R) === 1, "どちらもゲームにいない → ロビー（聞こえる）");
  check(gainRule(at(0), at(500), 20, R, false) === 1, "ワールドがつながっていない → ロビー");
  check(gainRule(at(1, { dead: true }), at(500), 20, { ...R, listen: true }) === 1, "「観戦者は生きている人の声を聞ける」→ 聞こえる");
  check(gainRule(at(1, { dead: true }), at(2, { dead: true }), 20, { ...R, talk: "none" }) === 0, "「話せない」→ 死んだ人どうしも聞こえない");
  check(gainRule(at(1, { dead: true }), at(500, { dead: true }), 20, { ...R, talk: "near" }) === 0, "「近くだけ」→ 遠くの死んだ人は聞こえない");
}

// ---- 2) workerd で動かす ----
const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
const compatDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml) || [])[1];
const flags = [...((/^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-world-"));
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
  durableObjectNamespaces = [ (className = "GuildRoom", uniqueKey = "guildroom-vcworld-test", enableSql = true) ],
  durableObjectStorage = (inMemory = void),
  globalOutbound = "net",
  bindings = [ (name = "GUILD", durableObjectNamespace = (className = "GuildRoom")), (name = "ASSETS", service = "assets"),
               (name = "DISCORD_API", text = "http://127.0.0.1:9/api/v10"), (name = "SETUP_KEY", text = "Test-Setup-Key-vcworld-0123456789"),
               (name = "SITE_URL", text = "https://example.workers.dev") ],
);
const a :Workerd.Worker = ( modules = [ (name = "assets.js", esModule = embed "assets.js") ], compatibilityDate = "${compatDate}" );
`);
const wd = spawn(WORKERD, ["serve", "--experimental", path.join(tmp, "config.capnp")], { stdio: ["ignore", "pipe", "pipe"] });
let wdLog = "";
wd.stdout.on("data", d => { wdLog += d; });
wd.stderr.on("data", d => { wdLog += d; });
const BASE = `http://127.0.0.1:${PORT}`;
const stop = code => { wd.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch (e) { /* 待つ */ } await sleep(250); }

let ipN = 0;
const post = (p, body) => fetch(BASE + p, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.4.0.${++ipN}` } });

/** ニセの Minecraft（/wsserver）。commandRequest に、ワールドの様子で返事をする */
function fakeMinecraft(url, world) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    const reply = (id, body) => ws.send(JSON.stringify({ header: { requestId: id, messagePurpose: "commandResponse", version: 1 }, body }));
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      const h = m.header || {}, line = (m.body && m.body.commandLine) || "";
      if (h.messagePurpose !== "commandRequest") return;
      seen.push(line);
      const all = Object.keys(world.players);
      const info = n => ({ dimension: world.players[n].d || 0, position: { x: world.players[n].x, y: 64, z: 0 }, uniqueId: world.players[n].uid, yRot: 0 });
      if (line === "testfor @a") return reply(h.requestId, all.length ? { statusCode: 0, victim: all } : { statusCode: -2147352576 });
      if (line === "testfor @e[type=player]") {
        const alive = all.filter(n => !world.players[n].dead);
        return reply(h.requestId, alive.length ? { statusCode: 0, victim: alive } : { statusCode: -2147352576, statusMessage: "No targets matched selector" });
      }
      if (line === "querytarget @a") return reply(h.requestId, { statusCode: 0, details: JSON.stringify(all.map(info)) });
      const q = /^querytarget @a\[name="([^"]+)"\]$/.exec(line);
      if (q) return reply(h.requestId, world.players[q[1]] ? { statusCode: 0, details: JSON.stringify([info(q[1])]) } : { statusCode: -2147352576 });
      if (/^testfor @a\[tag=/.test(line)) return reply(h.requestId, { statusCode: -2147352576 });   // アドオンなし
      reply(h.requestId, { statusCode: 0 });
    };
    ws.onopen = () => resolve({ ws, seen });
    ws.onerror = () => reject(new Error("mc ws error"));
  });
}
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const box = { ws, msgs: [] };
    ws.onmessage = e => { if (e.data !== "pong") { try { box.msgs.push(JSON.parse(e.data)); } catch (err) { /* 無視 */ } } };
    ws.onopen = () => resolve(box);
    ws.onerror = () => reject(new Error("ws error"));
  });
}
async function waitFor(box, pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = [...box.msgs].reverse().find(pred); if (m) return m; await sleep(40); }
  return null;
}

try {
  const room = await (await post("/api/web/rooms", { name: "聞こえ方テスト" })).json();
  const host = await (await post("/api/web/host", { r: room.roomId, hostKey: room.hostKey })).json();
  check(room.ok && host.ok && /^[A-Z0-9]{8}$/.test(host.worldCode || ""), "部屋を作る・ワールドの接続コード");
  check(host.rules && host.rules.showInfo === false, "新しい部屋: 距離・ディメンションの表示はオフ");

  // ワールド: Alice(0) ・ Bob(100 ブロック先) ・ Carol(3 ブロック先)
  const world = { players: { Alice: { uid: "-4294967295", x: 0 }, Bob: { uid: "-8589934591", x: 100 }, Carol: { uid: "-12884901887", x: 3 } } };
  const mc = await fakeMinecraft(`ws://127.0.0.1:${PORT}/v/${host.worldCode}`, world);

  // ブラウザ 3 人（ゲスト）→ 自分をえらぶ
  const socks = {};
  for (const name of ["Alice", "Bob", "Carol"]) {
    const g = await (await post("/api/guest", { name: name + "さん" })).json();
    const b = await openWs(`ws://127.0.0.1:${PORT}/api/web/socket?r=${room.roomId}&g=${encodeURIComponent(g.token)}`);
    b.ws.send(JSON.stringify({ t: "hello" }));
    const wel = await waitFor(b, x => x.t === "welcome");
    if (name === "Alice") check(wel && wel.room.rules.showInfo === false, "ブラウザに送る部屋の設定も、表示オフ");
    await waitFor(b, x => x.t === "players" && (x.list || []).includes(name), 6000);
    b.ws.send(JSON.stringify({ t: "pick", name }));
    check(!!(await waitFor(b, x => x.t === "verified")), `${name} が自分をえらんで入る`);
    socks[name] = b;
  }
  const A = socks.Alice;
  const p1 = await waitFor(A, x => x.t === "pos" && x.p.alice && x.p.bob && x.p.carol, 8000);
  check(!!p1, "3 人の位置が届く");
  check(p1 && ["alice", "bob", "carol"].every(n => (p1.inGame || []).includes(n)) && !(p1.dead || []).length, "ワールドにいる人の一覧（inGame）・死んだ人なし");
  check(mc.seen.includes("testfor @e[type=player]"), "生きている人を testfor @e[type=player] で読む");

  // Bob が死ぬ → 死んだ人に
  world.players.Bob.dead = true;
  const p2 = await waitFor(A, x => x.t === "pos" && (x.dead || []).includes("bob"), 4000);
  check(p2 && p2.p.bob && p2.p.bob[5] === 1 && !(p2.dead || []).includes("alice"), "Bob が死ぬ → dead に入る（アドオンなし）");
  // Bob が生き返る
  world.players.Bob.dead = false;
  const p3 = await waitFor(A, x => x.t === "pos" && x.p.bob && !(x.dead || []).includes("bob") && x.p.bob[5] === 0, 4000);
  check(!!p3, "リスポーン → dead から消える");

  // Carol の ID が変わった（入り直し）→ 名前で読み直して、位置が続く
  world.players.Carol.uid = "-99999999999";
  world.players.Carol.x = 5;
  await sleep(300);
  const p4 = await waitFor(A, x => x.t === "pos" && x.p.carol && x.p.carol[0] === 5, 6000);
  check(!!p4, "ID が変わった人も、名前で読み直して位置が分かる（ロビーにならない）");

  // 全員死ぬ → testfor @e が失敗 → 全員 dead
  for (const n of Object.keys(world.players)) world.players[n].dead = true;
  const p5 = await waitFor(A, x => x.t === "pos" && ["alice", "bob", "carol"].every(n => (x.dead || []).includes(n)), 4000);
  check(!!p5, "全員死ぬ → 全員 dead");
  for (const n of Object.keys(world.players)) world.players[n].dead = false;

  // 管理者が表示をオンにできる
  const on = await (await post("/api/web/host", { r: room.roomId, hostKey: room.hostKey, action: "rules", rules: { showInfo: true } })).json();
  check(on.ok && on.rules.showInfo === true, "管理者設定で表示をオンにできる");

  // ワールドに入り直す（ID が入れかわる）→ つながり直したら名前で読み直す（Alice と Bob をまちがえない）
  mc.ws.close();
  await sleep(800);
  const old = { a: world.players.Alice.uid, b: world.players.Bob.uid };
  world.players.Alice.uid = old.b; world.players.Bob.uid = old.a;
  world.players.Alice.x = 0; world.players.Bob.x = 100;
  const mc2 = await fakeMinecraft(`ws://127.0.0.1:${PORT}/v/${host.worldCode}`, world);
  await sleep(1500);
  const p6 = await waitFor(A, x => x.t === "pos" && x.p.alice && x.p.bob && x.p.alice[0] === 0 && x.p.bob[0] === 100, 8000);
  check(!!p6, "入り直して ID が入れかわっても、Alice と Bob の位置をまちがえない");
  const last = [...A.msgs].reverse().find(x => x.t === "pos" && x.p.alice && x.p.bob);
  check(last && last.p.alice[0] === 0 && last.p.bob[0] === 100, "（そのあとも正しいまま）");

  for (const b of Object.values(socks)) b.ws.close();
  mc2.ws.close();
} catch (e) {
  console.error(e);
  fail++;
}
if (fail) { console.log(wdLog.slice(-3000)); console.log(`NG が ${fail} 件`); stop(1); }
console.log("すべて成功");
stop(0);
