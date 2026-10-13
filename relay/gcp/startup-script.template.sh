#!/bin/bash
# =====================================================================
#  近接VC リレー … Google Cloud の VM（Compute Engine・Debian 12）用の起動スクリプト
#
#  VM の「起動スクリプト」（メタデータの startup-script）に、このファイルの中身を全部貼り付けます。
#  VM が起動するたびに動きます（何回動いても同じ状態になるように作ってあります）。
#
#  やること
#    1. VM のメタデータから設定を読む
#    2. 外への通信に上限をかける（Standard ネットワークの無料枠 200 GiB/月 をこえないように）
#    3. Node.js（公式のもの）を入れる（チェックサムを確かめる）
#    4. リレー（relay.mjs。このファイルの中に入っています）を置く
#    5. systemd のサービスにして、止まっても自動で起動しなおすようにする
#    6. セキュリティの自動更新（unattended-upgrades）を入れる
#
#  設定（VM の「メタデータ」に、キーと値で入れる）
#    worker-host … Worker のホスト名【必須】（例: mayosbedrocktool.dev-mayo-tools.workers.dev）
#    relay-port  … 待ち受けるポート（入れなければ 80）
#    public-host … 独自ドメインを使うとき、そのドメイン（入れなければ VM の外部 IP を表示に使う）
#    egress-kbit … 外への通信の上限（kbit/秒。入れなければ 500。0 で上限なし）
#
#  このファイルは build-startup-script.mjs で作っています（relay.mjs を変えたら作り直す）。
#  制作: MaYo (mayo01297)  https://github.com/Dev-MaY0  二次配布禁止
# =====================================================================
set -u
MD="${MD_URL:-http://metadata.google.internal/computeMetadata/v1}"
ROOT="${RELAY_ROOT:-}"                                         # テスト用（ふつうは空）
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"  # Node.js 22（LTS）の最新版
APP="$ROOT/opt/mayo-vc-relay"
md() { curl -fsS -m 5 -H "Metadata-Flavor: Google" "$MD/$1" 2>/dev/null || true; }
say() { echo "[mayo-vc-relay] $*"; }

# ---- 1. 設定 --------------------------------------------------------
WORKER_HOST="$(md instance/attributes/worker-host | tr -cd 'A-Za-z0-9.:-')"
RELAY_PORT="$(md instance/attributes/relay-port | tr -cd '0-9')"
RELAY_PORT="${RELAY_PORT:-80}"
PUBLIC_HOST="$(md instance/attributes/public-host | tr -cd 'A-Za-z0-9.-')"
[ -z "$PUBLIC_HOST" ] && PUBLIC_HOST="$(md instance/network-interfaces/0/access-configs/0/external-ip | tr -cd '0-9.')"
[ -n "$PUBLIC_HOST" ] && [ "$RELAY_PORT" != "80" ] && PUBLIC_HOST="$PUBLIC_HOST:$RELAY_PORT"
EGRESS_KBIT="$(md instance/attributes/egress-kbit | tr -cd '0-9')"
EGRESS_KBIT="${EGRESS_KBIT:-500}"
if [ -z "$WORKER_HOST" ]; then
  say "メタデータに worker-host がありません。VM の「編集」→「メタデータ」で worker-host を入れて、VM をリセットしてください。"
  exit 1
fi
say "中継先: $WORKER_HOST ／ ポート: $RELAY_PORT ／ 公開アドレス: ${PUBLIC_HOST:-不明} ／ 外への通信の上限: ${EGRESS_KBIT} kbit/秒"

# ---- 2. 外への通信の上限（お金がかからないように）--------------------
#  Google Cloud は「外へ出ていく通信」にお金がかかる（入ってくる通信は無料）。
#  ここで上限をかけておくと、攻撃されても、外への通信は 1 か月で最大
#  500 kbit/秒 × 730 時間 ≒ 153 GiB（Standard ネットワークの無料枠 200 GiB より少ない）までになる。
#  ふだんの近接VC は、1 ワールドで 0.012 Mbit/秒（12 kbit/秒）くらい。
if [ -z "$ROOT" ]; then
  IFACE="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [ -n "$IFACE" ]; then
    if [ "$EGRESS_KBIT" -gt 0 ]; then
      if tc qdisc replace dev "$IFACE" root tbf rate "${EGRESS_KBIT}kbit" burst 32kb latency 400ms; then
        say "外への通信の上限: ${EGRESS_KBIT} kbit/秒（$IFACE）"
      else
        say "注意: 外への通信の上限をかけられませんでした（tc）。リレーは動かしますが、上限なしです。"
      fi
    else
      tc qdisc del dev "$IFACE" root 2>/dev/null || true
      say "外への通信の上限: なし（egress-kbit=0）"
    fi
  fi
fi

# ---- 3. Node.js ------------------------------------------------------
case "$(uname -m)" in
  x86_64) NODE_ARCH=linux-x64 ;;
  aarch64) NODE_ARCH=linux-arm64 ;;
  *) say "この CPU（$(uname -m)）には対応していません"; exit 1 ;;
esac
NODE="$APP/node/bin/node"
if [ ! -x "$NODE" ] || ! "$NODE" -v 2>/dev/null | grep -q '^v22\.'; then
  say "Node.js を入れています…"
  TMP="$(mktemp -d)"
  if ! curl -fsSL -m 60 "$NODE_DIST/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"; then say "Node.js の一覧を取れませんでした"; exit 1; fi
  FILE="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-${NODE_ARCH}\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  if [ -z "$FILE" ]; then say "Node.js のファイルが見つかりませんでした"; exit 1; fi
  if ! curl -fsSL -m 600 "$NODE_DIST/$FILE" -o "$TMP/$FILE"; then say "Node.js をダウンロードできませんでした"; exit 1; fi
  if ! (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null); then say "Node.js のチェックサムが合いません（入れるのをやめました）"; exit 1; fi
  mkdir -p "$APP"
  rm -rf "$APP/node.new" && mkdir "$APP/node.new"
  tar -xzf "$TMP/$FILE" -C "$APP/node.new" --strip-components=1 --no-same-owner
  rm -rf "$APP/node" && mv "$APP/node.new" "$APP/node"
  rm -rf "$TMP"
fi
say "Node.js: $("$NODE" -v)"

# ---- 4. リレー（relay.mjs）--------------------------------------------
mkdir -p "$APP"
cat > "$APP/relay.mjs.new" <<'MAYO_RELAY_EOF'
__RELAY_MJS__
MAYO_RELAY_EOF
chmod 644 "$APP/relay.mjs.new" && mv "$APP/relay.mjs.new" "$APP/relay.mjs"

# ---- 5. systemd のサービス ---------------------------------------------
mkdir -p "$ROOT/etc/systemd/system"
cat > "$ROOT/etc/mayo-vc-relay.env" <<EOF
WORKER_HOST=$WORKER_HOST
PORT=$RELAY_PORT
PUBLIC_HOST=$PUBLIC_HOST
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
if [ -z "$ROOT" ]; then
  systemctl daemon-reload
  systemctl enable mayo-vc-relay >/dev/null 2>&1
  systemctl restart mayo-vc-relay
  sleep 2
  if systemctl is-active --quiet mayo-vc-relay; then say "リレーが動きました"; else say "リレーが起動しませんでした（journalctl -u mayo-vc-relay で確認）"; fi
fi

# ---- 6. セキュリティの自動更新 -----------------------------------------
if [ -z "$ROOT" ] && ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  say "セキュリティの自動更新を入れています…"
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades) >/dev/null 2>&1 \
    && say "セキュリティの自動更新: オン" || say "注意: unattended-upgrades を入れられませんでした"
fi
say "おわり"
