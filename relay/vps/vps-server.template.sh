#!/bin/bash
# =====================================================================
#  マイクラ統合版ツール … VPS（ConoHa など・Ubuntu / Debian）で「公開サイト」としてまとめて動かす
#
#    1. サイトと Discord Bot（Cloudflare の Worker と同じプログラムを、workerd で動かす）… 127.0.0.1:8787
#    2. Caddy … https://<IP>.sslip.io/ でサイトを出す（証明書は Let's Encrypt から自動・ポート 443）
#    3. 近接VC リレー … Minecraft の /wsserver ws://<IP>/v/… を受けて 1. に中継（ポート 80）
#    4. 音声の中継（TURN・coturn）… サイトで近接VC の声がつながりにくい人用（ポート 3478 と 49160-49200）
#    5. ファイアウォール（ufw）… 使うポートだけをあける
#
#  使い方（VPS に SSH でログインして）:
#    curl -fsSL https://<配布元のサイト>/download/vps-server.sh | sudo bash -s -- https://<配布元のサイト>
#  最後に出る「サイトの URL」をひらいて /setup/ で Discord の Bot のトークンを入れれば完了です。
#  何回実行しても大丈夫です（データ・設定用のキー・音声の中継の合言葉は、そのまま残ります）。
#  新しい版にするときは: sudo mayo-vc update
#
#  このファイルは web/build_site.mjs（または build_site.ps1）で作っています（サイトと Bot のファイルを中に入れるため）。
#  制作: MaYo (mayo01297)  https://github.com/Dev-MaY0  二次配布禁止
# =====================================================================
set -u

main() {
exec </dev/null   # curl | bash のとき、途中のコマンドがスクリプトの続きを読んでしまわないように
SOURCE="$(printf '%s' "${1:-${MAYO_SOURCE:-}}" | tr -cd 'A-Za-z0-9.:/_-' | sed 's#/*$##')"
ROOT="${MAYO_ROOT:-}"                                           # テスト用（ふつうは空）
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"  # Node.js 22（LTS）の最新版
WORKERD_VERSION="1.20261006.1"
BUNDLE_SHA256="__BUNDLE_SHA256__"
APP="$ROOT/opt/mayo-vc"
ETC="$ROOT/etc/mayo-vc"
STATE="$ROOT/var/lib/mayo-vc"
SITE_PORT="${MAYO_PORT:-8787}"
RELAY_PORT=80
TURN_PORT=3478
TURN_MIN=49160
TURN_MAX=49200
say() { echo "[mayo-vc] $*"; }
die() { echo "[mayo-vc] ✗ $*" >&2; exit 1; }

echo "=================================================="
echo " マイクラ統合版ツール … VPS で公開サイトを動かす"
echo " （サイト・Discord Bot・近接VC リレー・音声の中継） 制作: MaYo / mayo01297"
echo "=================================================="
[ -n "$ROOT" ] || [ "$(id -u)" = "0" ] || die "管理者（root）で実行してください（コマンドの先頭に sudo を付ける）"
if [ -z "$ROOT" ] && ! command -v apt-get >/dev/null 2>&1; then die "このスクリプトは Ubuntu / Debian 用です"; fi
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
[ -n "$MEM_MB" ] && [ "$MEM_MB" -lt 700 ] && say "注意: メモリが ${MEM_MB}MB です。1GB 以上をおすすめします"

# ---- 0. この VPS の IP アドレスと、サイトの名前 -----------------------------
LOCAL_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
PUBLIC_IP="$(printf '%s' "${PUBLIC_IP:-}" | tr -cd '0-9.')"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(curl -fsS4 -m 8 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | tr -cd '0-9.')"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$LOCAL_IP"
echo "$PUBLIC_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "この VPS の IP アドレスが分かりませんでした"
# サイトの名前: ふつうは「IP の . を - にしたもの.sslip.io」（sslip.io は、名前の中の IP をそのまま返す無料の DNS）
# 自分のドメインを使うときは、2 つ目に書く: … | sudo bash -s -- <配布元のサイト> vc.example.com（DNS でこの VPS の IP に向けておく）
HOST="$(printf '%s' "${2:-${MAYO_HOST:-}}" | tr -cd 'A-Za-z0-9.-' | tr 'A-Z' 'a-z')"
[ -z "$HOST" ] && HOST="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
say "この VPS の IP: $PUBLIC_IP ／ サイト: https://$HOST/"

# ---- 1. 必要なもの ------------------------------------------------------
if [ -z "$ROOT" ]; then
  say "必要なものを入れています…（2〜5 分）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || die "apt-get update ができませんでした（インターネットにつながっているか確認）"
  apt-get install -y -qq curl ca-certificates tar gzip ufw coturn gnupg unattended-upgrades >/dev/null 2>&1 \
    || die "パッケージを入れられませんでした（curl ca-certificates tar gzip ufw coturn gnupg）"
  # Caddy（公式の apt リポジトリ。https://caddyserver.com/docs/install の手順どおり）
  if ! command -v caddy >/dev/null 2>&1; then
    say "Caddy を入れています…"
    if curl -1sLf -m 60 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
      && curl -1sLf -m 60 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list; then
      chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq >/dev/null 2>&1
    fi
    apt-get install -y -qq caddy >/dev/null 2>&1 || die "Caddy を入れられませんでした"
  fi
fi

# メモリが少ない VPS（1GB）では、スワップ（ディスクを予備のメモリにする）を 1GB 作る（ないときだけ）
if [ -z "$ROOT" ] && [ -n "$MEM_MB" ] && [ "$MEM_MB" -lt 1800 ] && [ -z "$(swapon --show 2>/dev/null)" ] && [ ! -e /swapfile ]; then
  if fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab && say "スワップを 1GB 作りました（メモリが足りなくなったときの予備）"
  fi
fi

# ---- 2. Node.js（公式のもの。チェックサムを確かめる）--------------------------
case "$(uname -m)" in
  x86_64) NODE_ARCH=linux-x64; WD_PKG=workerd-linux-64 ;;
  aarch64) NODE_ARCH=linux-arm64; WD_PKG=workerd-linux-arm64 ;;
  *) die "この CPU（$(uname -m)）には対応していません" ;;
esac
NODE="${MAYO_NODE:-$APP/node/bin/node}"
if [ -z "${MAYO_NODE:-}" ] && { [ ! -x "$NODE" ] || ! "$NODE" -v 2>/dev/null | grep -q '^v22\.'; }; then
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

# ---- 3. workerd（Cloudflare Workers と同じ動きをする、オープンソースの実行環境）------
WORKERD="${MAYO_WORKERD:-$APP/runtime/node_modules/@cloudflare/$WD_PKG/bin/workerd}"
if [ -z "${MAYO_WORKERD:-}" ] && ! "$WORKERD" --version 2>/dev/null | grep -q "${WORKERD_VERSION:2:4}-${WORKERD_VERSION:6:2}-${WORKERD_VERSION:8:2}"; then
  say "workerd $WORKERD_VERSION を入れています…（1〜2 分）"
  mkdir -p "$APP/runtime"
  NPM="$(dirname "$NODE")/npm"
  printf '{ "private": true }\n' > "$APP/runtime/package.json"
  PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$APP/runtime" --no-audit --no-fund --omit=dev --loglevel=error "workerd@$WORKERD_VERSION" >/dev/null 2>&1 \
    || die "workerd を入れられませんでした（npm install workerd@$WORKERD_VERSION）"
fi
"$WORKERD" --version >/dev/null 2>&1 || die "workerd が動きません（$WORKERD）"
say "workerd: $("$WORKERD" --version 2>/dev/null | head -1)"

# ---- 4. サイトと Bot のファイル -------------------------------------------
TMP="$(mktemp -d)"
cat > "$TMP/bundle.json" <<'MAYO_BUNDLE_EOF'
__BUNDLE_JSON__
MAYO_BUNDLE_EOF
GOT="$(sha256sum "$TMP/bundle.json" | cut -d' ' -f1)"
[ "$GOT" = "$BUNDLE_SHA256" ] || die "スクリプトが途中で切れています（ダウンロードし直してください）"
cat > "$TMP/gen.mjs" <<'MAYO_GEN_EOF'
// サイトと Bot のファイルを取り出して、workerd の設定（config.capnp）を作る
import fs from "node:fs";
import path from "node:path";
const [bundlePath, outDir, finalDir, stateDir, port, build] = process.argv.slice(2);
const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
const OK = /^(src\/[A-Za-z0-9_.-]+\.js|public\/[A-Za-z0-9_.\/-]+|relay\/relay\.mjs|wrangler\.toml)$/;
const pub = [];
for (const [rel, b64] of Object.entries(bundle)) {
  if (!OK.test(rel) || rel.split("/").some(p => p === "" || p === "." || p === "..")) throw new Error("bad path: " + rel);
  const to = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, Buffer.from(b64, "base64"));
  if (rel.startsWith("public/")) pub.push(rel.slice(6));
}
const toml = fs.readFileSync(path.join(outDir, "wrangler.toml"), "utf8");
const compat = (/^compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/m.exec(toml) || [])[1] || "2025-09-01";
const flags = [...((/^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml) || [])[1] || "").matchAll(/"([a-z0-9_]+)"/g)].map(m => m[1]);
// 最初のモジュールがメイン（index.js）になる
const mods = fs.readdirSync(path.join(outDir, "src")).filter(f => f.endsWith(".js") && f !== "index.js").sort();
if (!fs.existsSync(path.join(outDir, "src/index.js"))) throw new Error("src/index.js がありません");
mods.unshift("index.js");
// サイトのファイルを返す小さな Worker（Cloudflare の「Workers の静的ファイル」のかわり）
fs.writeFileSync(path.join(outDir, "assets.js"), `// 自動で作られるファイルです（vps-server.sh）
const FILES = new Set(${JSON.stringify(pub.sort())});
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", sh: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  zip: "application/zip", mcaddon: "application/octet-stream", mcpack: "application/octet-stream", woff2: "font/woff2" };
const typeOf = p => TYPES[((/\\.([a-z0-9]+)$/i.exec(p) || [])[1] || "").toLowerCase()] || "application/octet-stream";
const notFound = () => new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const moved = (to, url) => new Response(null, { status: 307, headers: { Location: to + url.search } });
export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return notFound(); }
    let file = "";
    if (p.endsWith("/")) { if (FILES.has(p + "index.html")) file = p + "index.html"; }
    else if (p.endsWith("/index.html") && FILES.has(p)) return moved(p.slice(0, -10), url);
    else if (FILES.has(p)) file = p;
    else if (FILES.has(p + "/index.html")) return moved(p + "/", url);
    if (!file) return notFound();
    const r = await env.FILES.fetch("http://files" + file.split("/").map(encodeURIComponent).join("/"));
    if (!r.ok) return notFound();
    const h = new Headers({ "Content-Type": typeOf(file), "X-Content-Type-Options": "nosniff",
      "Cache-Control": file.endsWith(".html") || file.endsWith(".sh") || file === "/config.js" ? "no-cache" : "public, max-age=3600" });
    for (const k of ["content-length", "last-modified"]) if (r.headers.get(k)) h.set(k, r.headers.get(k));
    return new Response(request.method === "HEAD" ? null : r.body, { status: 200, headers: h });
  },
};
`);
const q = s => JSON.stringify(String(s));
fs.writeFileSync(path.join(outDir, "config.capnp"), `# 自動で作られるファイルです（vps-server.sh）。手で書きかえないでください。
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "assets", worker = .assetsWorker),
    (name = "site-files", disk = (path = ${q(path.join(finalDir, "public"))})),
    (name = "do-disk", disk = (path = ${q(path.join(stateDir, "do"))}, writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = ${q("127.0.0.1:" + port)}, http = (forwardedProtoHeader = "X-Forwarded-Proto"), service = "main") ],
);
const mainWorker :Workerd.Worker = (
  modules = [
${mods.map(f => `    (name = ${q(f)}, esModule = embed ${q("src/" + f)})`).join(",\n")}
  ],
  compatibilityDate = ${q(compat)},
  compatibilityFlags = [${flags.map(q).join(", ")}],
  durableObjectNamespaces = [ (className = "GuildRoom", uniqueKey = "mayo-vc-guildroom", enableSql = true) ],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
  bindings = [
    (name = "GUILD", durableObjectNamespace = (className = "GuildRoom")),
    (name = "ASSETS", service = "assets"),
    (name = "MAYO_SERVER", text = "vps"),
    (name = "DISCORD_API", text = "https://discord.com/api/v10"),
    (name = "RELAY_HOST", fromEnvironment = "RELAY_HOST"),
    (name = "TURN_SECRET", fromEnvironment = "TURN_SECRET"),
    (name = "SETUP_KEY", fromEnvironment = "SETUP_KEY"),
    (name = "DISCORD_TOKEN", fromEnvironment = "DISCORD_TOKEN"),
    (name = "SITE_URL", fromEnvironment = "SITE_URL"),
  ],
);
const assetsWorker :Workerd.Worker = (
  modules = [ (name = "assets.js", esModule = embed "assets.js") ],
  compatibilityDate = ${q(compat)},
  bindings = [ (name = "FILES", service = "site-files") ],
);
`);
fs.writeFileSync(path.join(outDir, "BUILD"), build + "\n");
console.log(`files=${Object.keys(bundle).length} site=${pub.length} modules=${mods.length} compat=${compat}`);
MAYO_GEN_EOF
rm -rf "$APP/app.new" && mkdir -p "$APP/app.new" "$STATE"
OUT="$("$NODE" "$TMP/gen.mjs" "$TMP/bundle.json" "$APP/app.new" "$APP/app" "$STATE" "$SITE_PORT" "${BUNDLE_SHA256:0:12}" 2>&1)" \
  || die "サイトと Bot のファイルを取り出せませんでした: $OUT"
rm -rf "$TMP"
# 前の版は app.old に残す（新しい版が動かなかったら、自動で前の版にもどす）
rm -rf "$APP/app.old"
[ -d "$APP/app" ] && mv "$APP/app" "$APP/app.old"
mv "$APP/app.new" "$APP/app"
chmod -R a+rX "$APP"
say "サイトと Bot: $OUT（ビルド ${BUNDLE_SHA256:0:12}）"

# ---- 5. 設定（キーと合言葉は、前のものがあればそのまま使う）--------------------
mkdir -p "$ETC"
old() { [ -f "$ETC/env" ] && sed -n "s/^$1=//p" "$ETC/env" | head -1; }
rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
SETUP_KEY="$(old SETUP_KEY)"; [ -n "$SETUP_KEY" ] || SETUP_KEY="$(rand 24)"
TURN_SECRET="$(old TURN_SECRET)"
[ -z "$TURN_SECRET" ] && [ -f "$ROOT/etc/turnserver.conf" ] && TURN_SECRET="$(sed -n 's/^static-auth-secret=//p' "$ROOT/etc/turnserver.conf" | tr -cd 'A-Za-z0-9_-' | head -c 64)"
[ -n "$TURN_SECRET" ] || TURN_SECRET="$(rand 32)"
[ -n "$SOURCE" ] || SOURCE="$(old SOURCE)"
DISCORD_TOKEN="$(old DISCORD_TOKEN)"
umask 077
cat > "$ETC/env" <<EOF
# マイクラ統合版ツール（VPS）の設定  … vps-server.sh が作ります。SETUP_KEY と TURN_SECRET は人に見せないでください
HOST=$HOST
SITE_URL=https://$HOST
PUBLIC_IP=$PUBLIC_IP
RELAY_HOST=$PUBLIC_IP
SETUP_KEY=$SETUP_KEY
TURN_SECRET=$TURN_SECRET
SOURCE=$SOURCE
DISCORD_TOKEN=$DISCORD_TOKEN
EOF
cat > "$ETC/relay.env" <<EOF
WORKER_HOST=127.0.0.1:$SITE_PORT
UPSTREAM_TLS=0
PORT=$RELAY_PORT
PUBLIC_HOST=$PUBLIC_IP
HTTPS_REDIRECT_HOST=$HOST
TARGET_LABEL=$HOST
UPSTREAM_NAME=このサイト
EOF
umask 022
chmod 600 "$ETC/env"; chmod 644 "$ETC/relay.env"

# ---- 6. 自動で動かす（systemd）------------------------------------------
mkdir -p "$ROOT/etc/systemd/system"
cat > "$ROOT/etc/systemd/system/mayo-vc.service" <<EOF
[Unit]
Description=MaYo VC site + Discord Bot (workerd)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/mayo-vc/env
ExecStartPre=/bin/mkdir -p /var/lib/mayo-vc/do
ExecStart=$APP/runtime/node_modules/@cloudflare/$WD_PKG/bin/workerd serve --experimental $APP/app/config.capnp
Restart=always
RestartSec=3
# root では動かさない（その場で作るユーザー）。データは /var/lib/mayo-vc（StateDirectory）
DynamicUser=yes
StateDirectory=mayo-vc
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
MemoryMax=600M
TasksMax=256
LimitNOFILE=16384

[Install]
WantedBy=multi-user.target
EOF
cat > "$ROOT/etc/systemd/system/mayo-vc-relay.service" <<EOF
[Unit]
Description=MaYo VC Relay (Minecraft /wsserver -> this site)
After=network-online.target mayo-vc.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/mayo-vc/relay.env
ExecStart=$APP/node/bin/node --max-old-space-size=48 $APP/app/relay/relay.mjs
Restart=always
RestartSec=3
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

# ---- 7. 音声の中継（TURN・coturn）----------------------------------------
EXT="$PUBLIC_IP"
[ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$PUBLIC_IP" ] && EXT="$PUBLIC_IP/$LOCAL_IP"   # NAT の内側のとき
cat > "$ROOT/etc/turnserver.conf" <<EOF
# =====================================================================
#  サイトで近接VC の音声の中継（TURN）  … vps-server.sh が作ります  制作: MaYo (mayo01297)
#  パスワードはサイト（workerd）が、合言葉（static-auth-secret）から 12 時間だけ使えるものを作る
# =====================================================================
listening-port=$TURN_PORT
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=mayo-vc
external-ip=$EXT
min-port=$TURN_MIN
max-port=$TURN_MAX
no-tls
no-dtls
no-tcp-relay
user-quota=12
total-quota=400
max-bps=96000
no-multicast-peers
no-cli
stale-nonce=600
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
no-stdout-log
syslog
EOF
if [ -z "$ROOT" ]; then
  chown root:turnserver /etc/turnserver.conf 2>/dev/null && chmod 640 /etc/turnserver.conf || chmod 600 /etc/turnserver.conf
  [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
else
  chmod 640 "$ROOT/etc/turnserver.conf"
fi

# ---- 8. Caddy（https のサイト。証明書は Let's Encrypt から自動）---------------
# ポート 80 は Minecraft 用のリレーが使うので、Caddy は 443 だけ。証明書は TLS-ALPN（443）でとる
mkdir -p "$ROOT/etc/caddy"
if [ -f "$ROOT/etc/caddy/Caddyfile" ] && ! grep -q 'mayo-vc' "$ROOT/etc/caddy/Caddyfile"; then
  cp "$ROOT/etc/caddy/Caddyfile" "$ROOT/etc/caddy/Caddyfile.before-mayo-vc"
fi
cat > "$ROOT/etc/caddy/Caddyfile" <<EOF
# マイクラ統合版ツール（mayo-vc）… vps-server.sh が作ります
{
	http_port 8081
	auto_https disable_redirects
	servers {
		protocols h1 h2
	}
}

$HOST {
	tls {
		issuer acme {
			disable_http_challenge
		}
	}
	encode gzip
	request_body {
		max_size 1MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
	reverse_proxy 127.0.0.1:$SITE_PORT {
		header_up X-Real-IP {remote_host}
		header_up -CF-Connecting-IP
	}
}
EOF

# ---- 9. 管理コマンド（sudo mayo-vc …）--------------------------------------
mkdir -p "$ROOT/usr/local/bin"
cat > "$ROOT/usr/local/bin/mayo-vc" <<'EOF'
#!/bin/bash
# マイクラ統合版ツール（VPS）の管理コマンド … vps-server.sh が作ります
set -u
[ "$(id -u)" = "0" ] || { echo "sudo を付けて実行してください（例: sudo mayo-vc status）"; exit 1; }
. /etc/mayo-vc/env
case "${1:-help}" in
  status)
    for s in mayo-vc mayo-vc-relay caddy coturn; do printf '  %-15s %s\n' "$s" "$(systemctl is-active "$s")"; done
    echo "  サイト: https://$HOST/   （ビルド $(cat /opt/mayo-vc/app/BUILD 2>/dev/null)）"
    echo "  Minecraft（サイト版の近接VC）: /wsserver ws://$RELAY_HOST/new"
    curl -fsS -m 5 "http://127.0.0.1:8787/health" >/dev/null 2>&1 && echo "  ✓ サイトと Bot が返事をしています" || echo "  ✗ サイトと Bot が返事をしません（sudo mayo-vc logs）"
    curl -fsS -m 8 "https://$HOST/health" >/dev/null 2>&1 && echo "  ✓ https://$HOST/ にとどきます" || echo "  ✗ https://$HOST/ にとどきません（証明書・ポート 443 を確認）"
    ;;
  update)
    URL="$(printf '%s' "${2:-$SOURCE}" | tr -cd 'A-Za-z0-9.:/_-' | sed 's#/*$##')"
    [ -n "$URL" ] || { echo "使い方: sudo mayo-vc update https://<配布元のサイト>"; exit 1; }
    T="$(mktemp)"
    curl -fsSL -m 300 "$URL/download/vps-server.sh" -o "$T" || { echo "ダウンロードできませんでした: $URL/download/vps-server.sh"; exit 1; }
    bash "$T" "$URL" "$HOST"; R=$?; rm -f "$T"; exit $R
    ;;
  restart) systemctl restart mayo-vc mayo-vc-relay caddy coturn && echo "動かし直しました" ;;
  logs) journalctl -u mayo-vc -u mayo-vc-relay -u caddy -n "${2:-80}" --no-pager ;;
  key) echo "設定用のキー（/setup/ で使う）: $SETUP_KEY" ;;
  backup)
    F="/root/mayo-vc-backup-$(date +%Y%m%d-%H%M%S).tgz"
    systemctl stop mayo-vc
    tar -czf "$F" -C / var/lib/private/mayo-vc etc/mayo-vc 2>/dev/null || tar -czf "$F" -C / var/lib/mayo-vc etc/mayo-vc
    systemctl start mayo-vc
    chmod 600 "$F"; echo "保存しました: $F"
    ;;
  *)
    echo "使い方: sudo mayo-vc <コマンド>"
    echo "  status   ようすを見る"
    echo "  update   新しい版にする（配布元のサイトから vps-server.sh を取ってきて実行）"
    echo "  restart  動かし直す"
    echo "  logs     ログを見る（例: sudo mayo-vc logs 200）"
    echo "  key      /setup/ で使う「設定用のキー」を見る"
    echo "  backup   データ（Bot の設定・部屋・チャット）を /root に保存する"
    ;;
esac
EOF
chmod 755 "$ROOT/usr/local/bin/mayo-vc"

[ -n "$ROOT" ] && { say "（テスト）ファイルを作りました: $ROOT"; return 0; }

# ---- 10. ファイアウォール（ufw）: 使うポートだけあける -----------------------
SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' | sort -u)"
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null; done   # SSH を先にあける（閉め出されないように）
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow "$TURN_PORT/tcp" >/dev/null
ufw allow "$TURN_PORT/udp" >/dev/null
ufw allow "$TURN_MIN:$TURN_MAX/udp" >/dev/null
ufw --force enable >/dev/null && say "ファイアウォール: SSH($(echo $SSH_PORTS | tr ' ' ','))・80/tcp・443/tcp・$TURN_PORT/tcp+udp・$TURN_MIN-$TURN_MAX/udp をあけました"

# ---- 11. 動かす ------------------------------------------------------------
OTHER="$(ss -ltnpH "sport = :80" 2>/dev/null | grep -v 'node' | head -1)"
[ -n "$OTHER" ] && say "注意: ポート 80 をほかのソフトが使っています（$OTHER）。止めてから、もう一度実行してください"
systemctl daemon-reload
systemctl enable mayo-vc mayo-vc-relay coturn caddy >/dev/null 2>&1
systemctl restart caddy          # 先に Caddy（入れたばかりの Caddy がポート 80 を使っているので、新しい設定で 443 だけにする）
systemctl restart mayo-vc
systemctl restart mayo-vc-relay coturn
OK=1
up() { for i in $(seq 1 30); do curl -fsS -m 3 "http://127.0.0.1:$SITE_PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
if up; then say "✓ サイトと Bot が動いています"
elif [ -d "$APP/app.old" ]; then
  say "✗ 新しい版が動かないので、前の版にもどします（くわしくは: journalctl -u mayo-vc -n 50）"
  rm -rf "$APP/app.bad" && mv "$APP/app" "$APP/app.bad" && mv "$APP/app.old" "$APP/app"
  systemctl restart mayo-vc mayo-vc-relay
  OK=0; up && say "✓ 前の版で動いています"
else OK=0; say "✗ サイトと Bot が動いていません（くわしくは: journalctl -u mayo-vc -n 50）"; fi
# 前の「リレーだけ」のセットアップ（vps-setup.sh）で入れたものは、もう使わないので片づける
[ -d /opt/mayo-vc-relay ] && rm -rf /opt/mayo-vc-relay /etc/mayo-vc-relay.env
if curl -fsS -m 5 "http://127.0.0.1:$RELAY_PORT/health" 2>/dev/null | grep -q MaYoVCRelay; then say "✓ 近接VC リレーが動いています"; else OK=0; say "✗ リレーが動いていません（くわしくは: journalctl -u mayo-vc-relay -n 30）"; fi
if systemctl is-active --quiet coturn; then say "✓ 音声の中継（TURN）が動いています"; else OK=0; say "✗ 音声の中継（TURN）が動いていません（くわしくは: journalctl -u coturn -n 30）"; fi
say "https の証明書をとっています…（最初は 1 分くらい）"
HTTPS=0
for i in $(seq 1 45); do
  if curl -fsS -m 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/health" >/dev/null 2>&1; then HTTPS=1; break; fi
  sleep 2
done
if [ "$HTTPS" = "1" ]; then say "✓ https://$HOST/ が使えます（証明書: Let's Encrypt）"
else OK=0; say "✗ https の証明書がまだとれていません。ConoHa の「セキュリティグループ」で 443/TCP をあけたか確認して、1〜2 分後に sudo mayo-vc status（くわしくは: journalctl -u caddy -n 50）"; fi

echo
echo "=================================================="
if [ "$OK" = "1" ]; then echo " ✅ 完了しました"; else echo " ⚠ 一部うまくいきませんでした（上の ✗ を見てください）"; fi
echo
echo "  サイトの URL:   https://$HOST/"
echo "  設定用のキー:   $SETUP_KEY"
echo "     → https://$HOST/setup/ をひらいて、このキーと Discord の Bot のトークンを入れる"
echo "       （キーはあとで sudo mayo-vc key でも見られます。人に見せないでください）"
echo
echo "  サイト版の近接VC: ワールドで（チートをオン）  /wsserver ws://$PUBLIC_IP/new"
echo "     → ゲームに出た 6 けたの部屋番号を、みんながサイトで入れる"
echo "  ようすを見る: sudo mayo-vc status　　新しい版にする: sudo mayo-vc update"
echo "  ※ VPS の会社の「セキュリティグループ」（ConoHa など）でも 22・80・443/TCP、3478/TCP・UDP、49160-49200/UDP をあけてください"
echo "=================================================="
}

main "$@"
