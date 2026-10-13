#!/bin/bash
# =====================================================================
#  近接VC … VPS（ConoHa など・Ubuntu / Debian）に、まとめて入れるスクリプト
#
#    1. 近接VC リレー … Minecraft の /wsserver を受けて、Cloudflare の Bot（Worker）に中継する（ポート 80）
#    2. 音声の中継（TURN・coturn）… 「サイトで近接VC」の声が、ブラウザどうしで直接つながらない人のため（ポート 3478）
#    3. ファイアウォール（ufw）… 使うポートだけをあける
#
#  使い方: サイトの /setup/ の「VPS に貼るコマンドを作る」で出たコマンドを、VPS でそのまま実行する
#    curl -fsSL https://<サイト>/download/vps-setup.sh | sudo bash -s -- <Worker のホスト名> <音声の中継の合言葉>
#  何回実行しても大丈夫です（同じ状態になります）。新しいリレーにするときも、同じコマンドをもう一度。
#
#  このファイルは web/build_site.mjs で作っています（relay.mjs を中に入れるため）。
#  制作: MaYo (mayo01297)  https://github.com/Dev-MaY0  二次配布禁止
# =====================================================================
set -u
WORKER_HOST="$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9.:-')"
TURN_SECRET="$(printf '%s' "${2:-}" | tr -cd 'A-Za-z0-9_-')"
ROOT="${RELAY_ROOT:-}"                                         # テスト用（ふつうは空）
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"  # Node.js 22（LTS）の最新版
RELAY_PORT="${RELAY_PORT:-80}"
TURN_PORT=3478
TURN_MIN=49160
TURN_MAX=49200
APP="$ROOT/opt/mayo-vc-relay"
say() { echo "[近接VC] $*"; }
die() { echo "[近接VC] ✗ $*" >&2; exit 1; }

echo "=================================================="
echo " 近接VC … VPS のセットアップ（制作: MaYo / mayo01297）"
echo "=================================================="
[ -n "$ROOT" ] || [ "$(id -u)" = "0" ] || die "管理者（root）で実行してください（コマンドの先頭に sudo を付ける）"
[ -n "$WORKER_HOST" ] || die "Worker のホスト名がありません。サイトの /setup/ で作ったコマンドを、そのまま貼り付けてください"
[ -n "$TURN_SECRET" ] || say "注意: 音声の中継の合言葉がないので、音声の中継（TURN）は入れません（リレーだけ入れます）"
if [ -z "$ROOT" ] && ! command -v apt-get >/dev/null 2>&1; then die "このスクリプトは Ubuntu / Debian 用です"; fi

# ---- 0. この VPS の IP アドレス ---------------------------------------
LOCAL_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
PUBLIC_IP="${PUBLIC_IP:-}"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(curl -fsS4 -m 8 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | tr -cd '0-9.')"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$LOCAL_IP"
[ -n "$PUBLIC_IP" ] || die "この VPS の IP アドレスが分かりませんでした"
say "中継先（Worker）: $WORKER_HOST ／ この VPS の IP: $PUBLIC_IP"

# ---- 1. 必要なもの ------------------------------------------------------
if [ -z "$ROOT" ]; then
  say "必要なものを入れています…（1〜3 分）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || die "apt-get update ができませんでした（インターネットにつながっているか確認）"
  PKGS="curl ca-certificates tar ufw unattended-upgrades"
  [ -n "$TURN_SECRET" ] && PKGS="$PKGS coturn"
  apt-get install -y -qq $PKGS >/dev/null 2>&1 || die "パッケージを入れられませんでした（$PKGS）"
fi

# ---- 2. Node.js（公式のもの。チェックサムを確かめる）--------------------------
case "$(uname -m)" in
  x86_64) NODE_ARCH=linux-x64 ;;
  aarch64) NODE_ARCH=linux-arm64 ;;
  *) die "この CPU（$(uname -m)）には対応していません" ;;
esac
NODE="$APP/node/bin/node"
if [ ! -x "$NODE" ] || ! "$NODE" -v 2>/dev/null | grep -q '^v22\.'; then
  say "Node.js を入れています…"
  TMP="$(mktemp -d)"
  curl -fsSL -m 60 "$NODE_DIST/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || die "Node.js の一覧を取れませんでした"
  FILE="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-${NODE_ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "Node.js のファイルが見つかりませんでした"
  curl -fsSL -m 600 "$NODE_DIST/$FILE" -o "$TMP/$FILE" || die "Node.js をダウンロードできませんでした"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js のチェックサムが合いません（入れるのをやめました）"
  mkdir -p "$APP"
  rm -rf "$APP/node.new" && mkdir "$APP/node.new"
  tar -xzf "$TMP/$FILE" -C "$APP/node.new" --strip-components=1 --no-same-owner
  rm -rf "$APP/node" && mv "$APP/node.new" "$APP/node"
  rm -rf "$TMP"
fi
say "Node.js: $("$NODE" -v)"

# ---- 3. 近接VC リレー（relay.mjs）---------------------------------------
mkdir -p "$APP"
cat > "$APP/relay.mjs.new" <<'MAYO_RELAY_EOF'
// =====================================================================
//  近接VC リレー（中継サーバー）… Google Cloud の VM（Compute Engine）や Railway で動かす
//
//  Minecraft の /wsserver は、返事の「Connection: Upgrade」が大文字でないと切ってしまう。
//  Cloudflare は必ず小文字の「Connection: upgrade」を返すので、直接はつながらない。
//  そこで、このリレーが間に入って:
//    1. Minecraft から ws://<リレー>/v/<接続コード> を受ける（生の TCP）
//    2. 同じ WebSocket のリクエストを、Cloudflare の Worker に TLS（wss）で送る
//    3. Worker の返事（101）を「Connection: Upgrade」に書き直して Minecraft に返す
//    4. あとは両方向のバイトを、そのまま流すだけ（中身は読まない・暗号化もそのまま通る）
//
//  ・外部ライブラリなし（Node.js の net / tls / crypto だけ）
//  ・タイマーも定期処理もなし。接続がないときは、何もしないで待っているだけ（CPU ほぼ 0）
//  ・中継先は WORKER_HOST だけ・URL は /v/<接続コード> だけ（ほかの場所への中継には使えない）
//  ・ログに接続コードや IP アドレスは出さない
//  ・攻撃よけ: 同じ IP からの同時接続数と、1 分あたりの新しい接続数に上限（こえたら何も返さずに切る＝外への通信を使わない）
//
//  設定（環境変数）
//    WORKER_HOST … Worker のホスト名（例: mayosbedrocktool.dev-mayo-tools.workers.dev）【必須】
//    PORT        … 待ち受けるポート（Google Cloud の VM は 80、Railway は 8080 など）
//                  ※ Railway の TCP Proxy があるときは、Railway が教えてくれる番号（RAILWAY_TCP_APPLICATION_PORT）を先に使う
//    PUBLIC_HOST … 外から見たアドレス（ログと確認ページに出すだけ。例: 34.82.1.2 / vc.example.com）
//    MAX_CONN    … 全体の同時接続の上限（ふつうは 200）
//    PER_IP_MAX  … 同じ IP からの同時接続の上限（ふつうは 8。0 で無効）
//    PER_IP_RATE … 同じ IP からの、1 分あたりの新しい接続の上限（ふつうは 30。0 で無効）
//                  ※ Railway の TCP Proxy の後ろでは、全員が同じ IP に見えるので、自動で無効になる
//
//  動いているかの確認: ブラウザで http://<リレーのアドレス>/ をひらくと「MaYoVCRelay … OK」
//
//  制作: MaYo (mayo01297)  https://github.com/Dev-MaY0  二次配布禁止
// =====================================================================
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const VERSION = "1.1.0";
const env = process.env;
const PORT = Number(env.RAILWAY_TCP_APPLICATION_PORT) || Number(env.PORT) || 8080;
// 外から見たアドレス（ログと確認ページに出すだけ）。Railway の TCP Proxy なら Railway が自動で入れる変数から
const PUBLIC = /^[A-Za-z0-9.:-]{1,200}$/.test(env.PUBLIC_HOST || "") ? env.PUBLIC_HOST
  : env.RAILWAY_TCP_PROXY_DOMAIN && env.RAILWAY_TCP_PROXY_PORT ? `${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}` : "";
const MAX_CONN = Number(env.MAX_CONN) || 200;
// 同じ IP からの上限。手前にプロキシ（Railway の TCP Proxy）があると、全員が同じ IP に見えるので使わない
const BEHIND_PROXY = !!(env.RAILWAY_TCP_PROXY_PORT || env.RAILWAY_PROJECT_ID);
const limitVar = (name, def) => (env[name] !== undefined && env[name] !== "" ? Math.max(0, Number(env[name]) || 0) : BEHIND_PROXY ? 0 : def);
const PER_IP_MAX = limitVar("PER_IP_MAX", 8);
const PER_IP_RATE = limitVar("PER_IP_RATE", 30);
// テスト用: UPSTREAM_TLS=0 で、Worker へ暗号化なし（ws://）でつなぐ
const USE_TLS = process.env.UPSTREAM_TLS !== "0";
const MAX_HEAD = 8192;            // HTTP ヘッダーの最大サイズ
const HEAD_TIMEOUT_MS = 10000;    // Minecraft がヘッダーを送ってくるまで待つ時間
const UPSTREAM_TIMEOUT_MS = 15000;
// どちらからも何も流れないまま、この時間がたったら切る（つながっているあいだは Bot が 1.5 秒ごとに読むので、ふつうは起きない）
const IDLE_MS = 10 * 60 * 1000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// WORKER_HOST は「ホスト名」または「ホスト名:ポート」。https:// や / が付いていても取り除く
const workerRaw = String(process.env.WORKER_HOST || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(workerRaw);
if (!m) {
  console.error("WORKER_HOST を設定してください（例: mayosbedrocktool.dev-mayo-tools.workers.dev）");
  process.exit(1);
}
const WORKER_HOSTNAME = m[1];
const WORKER_PORT = Number(m[2]) || (USE_TLS ? 443 : 80);
const WORKER_HOST_HEADER = m[2] ? `${m[1]}:${m[2]}` : m[1];

// 受け付ける URL（/v/<接続コード8文字>、/vc/ /connect/ も同じ。接続キーそのままの /ws/<キー> も）
const PATH_RE = /^\/(?:(?:v|vc|connect)\/[A-Za-z0-9]{8}|ws\/\d{15,22}\.[A-Za-z0-9]{16,64})\/?$/;

let active = 0, total = 0;
const started = Date.now();

// ---------------------------------------------------------------------
//  ログ（攻撃されたときにログでディスクがいっぱいにならないように、1 分に 60 行まで）
// ---------------------------------------------------------------------
let logMin = 0, logCount = 0, logDropped = 0;
function log(line) {
  const m = Math.floor(Date.now() / 60000);
  if (m !== logMin) {
    if (logDropped) console.log(`（ログが多すぎたので ${logDropped} 行を省略しました）`);
    logMin = m; logCount = 0; logDropped = 0;
  }
  if (++logCount > 60) { logDropped++; return; }
  console.log(line);
}

// ---------------------------------------------------------------------
//  同じ IP からの接続の上限（タイマーは使わず、数えるときに古いものを消す）
// ---------------------------------------------------------------------
const perIp = new Map();   // ip → { n: 同時接続数, win: 何分目か, c: その分の新しい接続数 }
function ipKey(sock) { return String(sock.remoteAddress || "").replace(/^::ffff:/, ""); }
function admit(ip) {
  if (!PER_IP_MAX && !PER_IP_RATE) return true;
  const w = Math.floor(Date.now() / 60000);
  let e = perIp.get(ip);
  if (!e) {
    if (perIp.size >= 20000) for (const [k, v] of perIp) if (v.n === 0 && v.win !== w) perIp.delete(k);
    e = { n: 0, win: w, c: 0 };
    perIp.set(ip, e);
  }
  if (e.win !== w) { e.win = w; e.c = 0; }
  if ((PER_IP_RATE && e.c >= PER_IP_RATE) || (PER_IP_MAX && e.n >= PER_IP_MAX)) return false;
  e.c++; e.n++;
  return true;
}
function release(ip) {
  const e = perIp.get(ip);
  if (e && e.n > 0) e.n--;
}
let refused = 0;

// ---------------------------------------------------------------------
//  HTTP ヘッダーを読む（\r\n\r\n まで）
// ---------------------------------------------------------------------
function readHead(sock, timeoutMs, maxBytes, stripPP = false) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0), first = true;
    // 読み終わったら止めておく（pipe するまでに届いたデータを落とさないように）
    const done = (v) => { clearTimeout(t); sock.off("data", onData); sock.off("end", onEnd); sock.off("error", onEnd); sock.off("close", onEnd); sock.pause(); resolve(v); };
    const onData = (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (first && stripPP) {
        const b = stripProxyProtocol(buf);
        if (!b) return buf.length > maxBytes ? done(null) : undefined;
        buf = b; first = false;
      }
      const i = buf.indexOf("\r\n\r\n");
      if (i >= 0) return done({ head: buf.subarray(0, i).toString("latin1"), rest: buf.subarray(i + 4) });
      if (buf.length > maxBytes) done(null);
    };
    const onEnd = () => done(null);
    const t = setTimeout(() => done(null), timeoutMs);
    sock.on("data", onData);
    sock.once("end", onEnd);
    sock.once("error", onEnd);
    sock.once("close", onEnd);
  });
}

function parseHead(head) {
  const lines = head.split("\r\n");
  const first = lines.shift() || "";
  const headers = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return { first, headers };
}

const acceptFor = (key) => crypto.createHash("sha1").update(key + GUID).digest("base64");

// 念のため: 手前のプロキシが PROXY protocol（v1 の文字 / v2 のバイナリ）を付けてきたら取り除く
// （Railway の TCP Proxy が付けるという説明は見当たらないが、付いていても動くように）
const PPV2 = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
function stripProxyProtocol(buf) {
  if (buf.length >= 16 && buf.subarray(0, 12).equals(PPV2)) {
    const n = 16 + buf.readUInt16BE(14);
    return buf.length >= n ? buf.subarray(n) : null;  // null … まだ足りない
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString("latin1") === "PROXY ") {
    const i = buf.indexOf("\r\n");
    return i >= 0 ? buf.subarray(i + 2) : null;
  }
  return buf;
}

// サーバーから送るフレーム（マスクなし）
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

/**
 * Minecraft のチャットに理由を出してから切る（Minecraft には「接続できませんでした」だけでは分からないので）
 * Minecraft が「暗号化できます」のサブプロトコルを送ってきたときは、同じものを返す（返さないと 101 を受け取ってもらえない）
 */
function rejectInGame(sock, key, text, code = 1008, protocol = "") {
  const cmd = `tellraw @a ${JSON.stringify({ rawtext: [{ text: `§c[近接VC] ${text}` }] })}`;
  const msg = JSON.stringify({
    header: { version: 1, requestId: crypto.randomUUID(), messagePurpose: "commandRequest", messageType: "commandRequest" },
    body: { version: 1, commandLine: cmd, origin: { type: "player" } },
  });
  try {
    const proto = protocol ? `Sec-WebSocket-Protocol: ${protocol.split(",")[0].trim()}\r\n` : "";
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptFor(key) + "\r\n" + proto + "\r\n");
    sock.write(frame(1, Buffer.from(msg, "utf8")));
    sock.write(frame(8, Buffer.from([code >> 8, code & 255])));
  } catch (e) { /* 無視 */ }
  setTimeout(() => sock.destroy(), 500);
}

// ブラウザ・Worker の「リレーをためす」用のふつうの HTTP の返事
// X-VC-Relay（版）と X-VC-Relay-Target（中継先）は、Worker の /setup/ が「正しいリレーか」を見るのに使う
function plainResponse(sock, status, text) {
  const body = Buffer.from(text + "\n", "utf8");
  const head = [`HTTP/1.1 ${status}`, "Content-Type: text/plain; charset=utf-8", `Content-Length: ${body.length}`,
    "Cache-Control: no-store", `X-VC-Relay: ${VERSION}`, `X-VC-Relay-Target: ${WORKER_HOST_HEADER}`, "Connection: close"];
  sock.end(Buffer.concat([Buffer.from(head.join("\r\n") + "\r\n\r\n", "latin1"), body]));
}

const mask = (path) => path.replace(/([A-Za-z0-9]{2})[A-Za-z0-9.]+$/, "$1******");

// ---------------------------------------------------------------------
//  1 本の接続
// ---------------------------------------------------------------------
async function onClient(mc) {
  if (active >= MAX_CONN) { mc.destroy(); return; }
  // 同じ IP から多すぎるときは、何も返さずに切る（外への通信を使わないように）
  const ip = ipKey(mc);
  if (!admit(ip)) {
    if (++refused % 100 === 1) log(`同じ IP からの接続が多すぎるので切りました（これまでに ${refused} 回）`);
    mc.destroy();
    return;
  }
  active++; total++;
  const t0 = Date.now();
  mc.setNoDelay(true);
  mc.setKeepAlive(true, 30000);
  let up = null, piped = false;
  const cleanup = () => {
    if (mc.destroyed && (!up || up.destroyed)) return;
    mc.destroy(); if (up) up.destroy();
  };
  mc.once("close", () => {
    active--;
    release(ip);
    if (up) up.destroy();
    if (piped) log(`close ${((Date.now() - t0) / 1000).toFixed(1)}s active=${active}`);
  });
  mc.on("error", () => cleanup());

  const req = await readHead(mc, HEAD_TIMEOUT_MS, MAX_HEAD, true);
  if (!req) { mc.destroy(); return; }
  const { first, headers } = parseHead(req.head);
  const [method, rawPath = "/"] = first.split(" ");
  const path = rawPath.split("?")[0];
  const isWs = /websocket/i.test(headers["upgrade"] || "") && headers["sec-websocket-key"];

  // ブラウザなどからの、ふつうの HTTP（動いているかの確認用）
  if (!isWs) {
    if (method === "GET" && (path === "/" || path === "/health"))
      return plainResponse(mc, "200 OK", `MaYoVCRelay ${VERSION} OK（中継先: ${WORKER_HOST_HEADER}・接続中: ${active - 1}・起動から ${Math.round((Date.now() - started) / 60000)} 分）` +
        (PUBLIC ? `\nMinecraft で送るコマンド: /wsserver ws://${PUBLIC}/v/<接続コード>（Discord の /vc key で確認）` : ""));
    return plainResponse(mc, "404 Not Found", "Minecraft のチャットで /wsserver ws://<このリレー>/v/<接続コード> を送ってください");
  }
  const key = headers["sec-websocket-key"];
  const protocol = headers["sec-websocket-protocol"] || "";
  const version = headers["sec-websocket-version"] || "13";
  // Worker に送る前に、形を確かめる（へんな文字を Worker へのリクエストに混ぜないように）
  if (!/^[A-Za-z0-9+/]{20,40}={0,2}$/.test(key) || !/^[\w.\-, ]{0,200}$/.test(protocol) || !/^\d{1,3}$/.test(version))
    return plainResponse(mc, "400 Bad Request", "WebSocket のリクエストの形がちがいます");
  if (!PATH_RE.test(path)) {
    log(`bad path ${mask(path).slice(0, 40)}`);
    return rejectInGame(mc, key, "URL がちがいます。Discord の /vc key で出たコマンドを、そのまま送ってください。", 1008, protocol);
  }

  // ---- Worker（Cloudflare）につなぐ ----
  up = USE_TLS
    ? tls.connect({ host: WORKER_HOSTNAME, port: WORKER_PORT, servername: WORKER_HOSTNAME, ALPNProtocols: ["http/1.1"] })
    : net.connect({ host: WORKER_HOSTNAME, port: WORKER_PORT });
  up.setNoDelay(true);
  up.setKeepAlive(true, 30000);
  up.on("error", (e) => { if (!piped) log(`upstream error ${e.code || e.message}`); });
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), UPSTREAM_TIMEOUT_MS);
    up.once(USE_TLS ? "secureConnect" : "connect", () => { clearTimeout(t); resolve(true); });
    up.once("error", () => { clearTimeout(t); resolve(false); });
  });
  if (!ready) return rejectInGame(mc, key, "Bot（Cloudflare）につながりませんでした。少し待ってから、もう一度ためしてください。", 1011, protocol);

  // 圧縮（Sec-WebSocket-Extensions）の希望は送らない（そのまま流すので、圧縮しない約束にしておく）
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${WORKER_HOST_HEADER}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: ${version}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    `User-Agent: MaYoVCRelay/${VERSION}`,
    `X-VC-Relay: ${VERSION}`,
  ];
  up.write(lines.join("\r\n") + "\r\n\r\n");

  const res = await readHead(up, UPSTREAM_TIMEOUT_MS, 32768);
  if (!res) { up.destroy(); return rejectInGame(mc, key, "Bot（Cloudflare）から返事がありませんでした。", 1011, protocol); }
  const r = parseHead(res.head);
  const status = Number((r.first.split(" ")[1]) || 0);
  if (status !== 101) {
    up.destroy();
    log(`upstream ${status} ${mask(path).slice(0, 40)}`);
    const why = status === 404 ? "接続コードがちがいます。Discord の /vc key で、新しいコマンドを確認してください。"
      : status === 403 ? "接続キーがちがいます。Discord の /vc key で確認してください。"
      : `Bot（Cloudflare）でエラーになりました（${status}）。`;
    return rejectInGame(mc, key, why, 1008, protocol);
  }
  const accept = r.headers["sec-websocket-accept"] || "";
  if (accept !== acceptFor(key)) log("warning: Sec-WebSocket-Accept が合いません");

  // ---- Minecraft への返事（ここがこのリレーのいちばん大事なところ: Connection は大文字の Upgrade）----
  const out = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(r.headers["sec-websocket-protocol"] ? [`Sec-WebSocket-Protocol: ${r.headers["sec-websocket-protocol"]}`] : []),
    ...(r.headers["sec-websocket-extensions"] ? [`Sec-WebSocket-Extensions: ${r.headers["sec-websocket-extensions"]}`] : []),
  ];
  mc.write(out.join("\r\n") + "\r\n\r\n");
  if (res.rest.length) mc.write(res.rest);   // 返事のすぐ後ろに来たデータ
  if (req.rest.length) up.write(req.rest);   // Minecraft がすぐ送ってきたデータ

  // ---- あとは両方向にそのまま流す ----
  piped = true;
  mc.setTimeout(IDLE_MS, cleanup);
  up.setTimeout(IDLE_MS, cleanup);
  log(`open ${mask(path).slice(0, 40)}${protocol ? " (暗号化あり)" : ""} active=${active}`);
  mc.pipe(up);
  up.pipe(mc);
  up.once("close", () => mc.destroy());
}

const server = net.createServer({ pauseOnConnect: false }, (s) => { onClient(s).catch(() => s.destroy()); });
// "::" は IPv6 と IPv4 の両方で待つ。IPv6 が使えない場所では 0.0.0.0（IPv4）で待ちなおす
let host = process.env.HOST || "::";
server.on("error", (e) => {
  if (e.code === "EAFNOSUPPORT" && host === "::") { host = "0.0.0.0"; return listen(); }
  console.error("server error", e.code || e.message);
  process.exit(1);
});
const listen = () => server.listen({ port: PORT, host, ipv6Only: false });
server.once("listening", () => {
  console.log(`MaYoVCRelay ${VERSION} 起動: ${host === "::" ? "[::]" : host}:${PORT} → ${USE_TLS ? "wss" : "ws"}://${WORKER_HOST_HEADER}`);
  console.log(PUBLIC ? `公開アドレス: ${PUBLIC}（これをサイトの /setup/ の「リレーのアドレス」に入れる）`
    : `公開アドレス: 不明（Google Cloud なら VM の外部 IP、Railway なら TCP Proxy のアドレス。ポート ${PORT} で待っています）`);
  console.log(PER_IP_MAX || PER_IP_RATE ? `同じ IP からの上限: 同時 ${PER_IP_MAX || "なし"}・1分に ${PER_IP_RATE || "なし"} 回` : `同じ IP からの上限: なし（${BEHIND_PROXY ? "手前にプロキシがあるため" : "PER_IP_MAX・PER_IP_RATE が 0"}）`);
});
listen();
// Railway が止めるとき
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 500); });
MAYO_RELAY_EOF
chmod 644 "$APP/relay.mjs.new" && mv "$APP/relay.mjs.new" "$APP/relay.mjs"

mkdir -p "$ROOT/etc/systemd/system"
cat > "$ROOT/etc/mayo-vc-relay.env" <<EOF
WORKER_HOST=$WORKER_HOST
PORT=$RELAY_PORT
PUBLIC_HOST=$PUBLIC_IP$( [ "$RELAY_PORT" != "80" ] && printf ':%s' "$RELAY_PORT" )
EOF
chmod 644 "$ROOT/etc/mayo-vc-relay.env"
cat > "$ROOT/etc/systemd/system/mayo-vc-relay.service" <<'EOF'
[Unit]
Description=MaYo VC Relay (Minecraft /wsserver -> Cloudflare Workers)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/mayo-vc-relay.env
ExecStart=/opt/mayo-vc-relay/node/bin/node --max-old-space-size=32 /opt/mayo-vc-relay/relay.mjs
Restart=always
RestartSec=3
# root では動かさない（その場で作るユーザー）。ポート 80 を使う権限だけ渡す
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryMax=256M
TasksMax=64
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF

# ---- 4. 音声の中継（TURN・coturn）----------------------------------------
if [ -n "$TURN_SECRET" ]; then
  EXT="$PUBLIC_IP"
  [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$PUBLIC_IP" ] && EXT="$PUBLIC_IP/$LOCAL_IP"   # NAT の内側（Google Cloud など）
  cat > "$ROOT/etc/turnserver.conf" <<EOF
# =====================================================================
#  近接VC（サイトで近接VC）の音声の中継（TURN）  制作: MaYo (mayo01297)
#  パスワードは Cloudflare の Worker が、合言葉（static-auth-secret）から 12 時間だけ使えるものを作る
# =====================================================================
listening-port=$TURN_PORT
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=mayo-vc
external-ip=$EXT
min-port=$TURN_MIN
max-port=$TURN_MAX
# 暗号化（TLS/DTLS）の入口は使わない（WebRTC の音声そのものは、いつも暗号化されている）
no-tls
no-dtls
# 中継は UDP だけ・1 人あたり・全体の数と速さに上限
no-tcp-relay
user-quota=12
total-quota=400
max-bps=96000
no-multicast-peers
no-cli
stale-nonce=600
# VPS の中や、家の中のネットワーク（プライベートアドレス）には中継しない
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
# ログは journald へ（ふつうは少しだけ）
no-stdout-log
syslog
EOF
  if [ -z "$ROOT" ]; then
    chown root:turnserver /etc/turnserver.conf 2>/dev/null && chmod 640 /etc/turnserver.conf || chmod 644 /etc/turnserver.conf
    [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  else
    chmod 640 "$ROOT/etc/turnserver.conf"
  fi
fi

# ---- 5. ファイアウォール（ufw）: 使うポートだけあける -----------------------
if [ -z "$ROOT" ]; then
  SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u)"
  [ -n "$SSH_PORTS" ] || SSH_PORTS=22
  for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null; done   # SSH を先にあける（閉め出されないように）
  ufw allow "$RELAY_PORT/tcp" >/dev/null
  if [ -n "$TURN_SECRET" ]; then
    ufw allow "$TURN_PORT/tcp" >/dev/null
    ufw allow "$TURN_PORT/udp" >/dev/null
    ufw allow "$TURN_MIN:$TURN_MAX/udp" >/dev/null
  fi
  ufw --force enable >/dev/null && say "ファイアウォール: SSH($(echo $SSH_PORTS | tr ' ' ','))・$RELAY_PORT/tcp$( [ -n "$TURN_SECRET" ] && printf '・%s/tcp+udp・%s-%s/udp' $TURN_PORT $TURN_MIN $TURN_MAX ) をあけました"
fi

# ---- 6. 動かす ------------------------------------------------------------
if [ -z "$ROOT" ]; then
  # ほかのソフトがポート 80 を使っていないか
  OTHER="$(ss -ltnpH "sport = :$RELAY_PORT" 2>/dev/null | grep -v 'node' | head -1)"
  [ -n "$OTHER" ] && say "注意: ポート $RELAY_PORT をほかのソフトが使っています（$OTHER）。そのソフトを止めてから、もう一度実行してください"
  systemctl daemon-reload
  systemctl enable mayo-vc-relay >/dev/null 2>&1
  systemctl restart mayo-vc-relay
  if [ -n "$TURN_SECRET" ]; then
    systemctl enable coturn >/dev/null 2>&1
    systemctl restart coturn
  fi
  sleep 3
  OK=1
  if curl -fsS -m 5 "http://127.0.0.1:$RELAY_PORT/health" 2>/dev/null | grep -q MaYoVCRelay; then say "✓ リレーが動いています"; else OK=0; say "✗ リレーが動いていません（くわしくは: journalctl -u mayo-vc-relay -n 30）"; fi
  if [ -n "$TURN_SECRET" ]; then
    if systemctl is-active --quiet coturn; then say "✓ 音声の中継（TURN）が動いています"; else OK=0; say "✗ 音声の中継（TURN）が動いていません（くわしくは: journalctl -u coturn -n 30）"; fi
  fi
  echo
  echo "=================================================="
  if [ "$OK" = "1" ]; then echo " ✅ 完了しました"; else echo " ⚠ 一部うまくいきませんでした（上の ✗ を見てください）"; fi
  echo
  echo "  リレーのアドレス:  $PUBLIC_IP$( [ "$RELAY_PORT" != "80" ] && printf ':%s' "$RELAY_PORT" )"
  echo "    → サイトの /setup/ の「📡 リレーのアドレス」に入れて「保存してためす」"
  echo
  echo "  ブラウザで http://$PUBLIC_IP$( [ "$RELAY_PORT" != "80" ] && printf ':%s' "$RELAY_PORT" )/ をひらくと、動いているか分かります"
  echo "  ※ VPS の会社の「セキュリティグループ」（ConoHa など）でも、ポートをあけてください"
  echo "=================================================="
fi
