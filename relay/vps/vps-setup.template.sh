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
__RELAY_MJS__
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
