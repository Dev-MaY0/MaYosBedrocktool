# 近接VC リレー（中継サーバー）

> 制作: MaYo (mayo01297)　／　二次配布禁止

Minecraft の `/wsserver` を、PC のアプリ（近接VC コネクター）なしで Bot につなぐための中継サーバーです。
**全部ブラウザで設定できます。**

```
Minecraft ──ws://<リレー>/v/<接続コード>──▶ リレー（Google Cloud の VM・Railway） ──wss://──▶ Bot（Cloudflare Workers）
```

## どこで動かすか

| | **VPS（ConoHa など）【おすすめ】** | Google Cloud（Compute Engine） | Railway |
|---|---|---|---|
| 手順 | **[vps/README.md](vps/README.md)** | [gcp/README.md](gcp/README.md) | このページの ①〜③ |
| 月の料金 | **定額**（ConoHa 512MB なら上限 751 円・転送量の課金なし） | 約 $3.65（使った分だけ課金） | 約 $0.2〜$0.6（使った分だけ課金） |
| 攻撃されたとき | 料金は変わらない | 外への通信に上限・課金ストッパーつき（ただし Google 側の上限はない） | Railway の「Usage Limits」で上限を決める |
| サイトで近接VC の音声の中継（TURN） | **いっしょに入る** | なし | なし |
| コマンド | `/wsserver ws://160.251.1.2/v/…` | `/wsserver ws://34.82.1.2/v/…` | `/wsserver ws://xxx.proxy.rlwy.net:12345/v/…` |

リレーのプログラム（`relay.mjs`）はどちらも同じです。

## なぜ必要か

- Minecraft の `/wsserver` は、サーバーの返事に `Connection: Upgrade`（**U が大文字**）がないと、つないだ直後に切ってしまいます（相性テストで確認ずみ: 小文字の `upgrade` だけ ×）。
- Cloudflare は、Worker が何を返しても `Connection: upgrade`（小文字）にして送ります（`workers.dev` で確認ずみ。Cloudflare で買った独自ドメインも、同じ Cloudflare のプロキシを通るので同じになると考えられます）。
- このリレーは Cloudflare の外（Google Cloud の VM や Railway）で動き、Minecraft には `Connection: Upgrade` で返事をして、あとは中身をそのまま Bot に流します。

## このリレーがすること・しないこと

- 中継先は `WORKER_HOST` だけ。URL は `/v/<接続コード>`（と `/ws/<接続キー>`）だけを中継します（ほかの場所への中継には使えません）
- 中身は読みません（Minecraft の「暗号化された WebSocket」がオンでも、そのまま通ります）
- 外部ライブラリなし（Node.js だけ）・タイマーなし。接続がないときは何もしないで待っているだけです
- ログに接続コード（最初の2文字以外）や IP アドレスは出しません
- 秘密の情報（トークンなど）はリレーに置きません（`WORKER_HOST` は秘密ではありません）
- 同じ IP からの接続数に上限（同時 8 本・1 分に 30 回）。こえたら何も返さずに切ります（Railway の TCP Proxy の後ろでは、全員が同じ IP に見えるので自動で無効）

---

# Railway で動かすとき

---

## ① GitHub に置く

**いまの Cloudflare 用のリポジトリに、`relay` フォルダごと置くのがおすすめ**です（リポジトリは 1 つのまま）。
`cloudflare` フォルダの中身を全部アップロードした人は、もう入っています。

1. GitHub の、いま Cloudflare につないでいるリポジトリをひらく（`wrangler.toml` がいちばん上にあるもの）
2. 「**Add file**」→「**Upload files**」→ `relay` フォルダを**フォルダごと**ドラッグ →「**Commit changes**」
3. リポジトリのいちばん上に `relay/`（中に `relay.mjs` `package.json` `Dockerfile` `README.md`）ができていればOK

```
（リポジトリ）
├─ public/        … サイト（Cloudflare）
├─ src/           … Bot（Cloudflare）
├─ wrangler.toml
├─ package.json
└─ relay/         … ここだけを Railway が使う
   ├─ relay.mjs
   ├─ package.json
   ├─ Dockerfile
   └─ README.md
```

- Cloudflare は `src/` と `public/` しか使わないので、`relay/` を置いても Worker には影響しません（コミットすると Worker も作り直されますが、中身は同じです）。
- **別のリポジトリにしたいとき**: 新しいリポジトリを作って、`relay` フォルダの**中身**（4 ファイル）をいちばん上に置きます。この場合、② の「Root Directory」は空のままにします。リポジトリが 2 つになる分、更新の手間が増えます。
- Private（非公開）のリポジトリのままで大丈夫です。

## ② Railway にデプロイ（ブラウザで）

1. [railway.com](https://railway.com/) →「**Login**」→ **GitHub でログイン**
   - GitHub で確認が通らないと「制限つきのお試し」になり、外への通信が制限されることがあります（リレーは Cloudflare につなぐので、通信できる必要があります）
2. 「**New Project**」（または「New」）→「**Deploy from GitHub repo**」→ ① のリポジトリを選ぶ
   - 一覧に出ないときは「Configure GitHub App」で、Railway にそのリポジトリの読み取りを許可する
   - このあと最初のデプロイが動きますが、まだ設定していないので失敗しても大丈夫です
3. できたサービス（四角いカード）をクリック →「**Settings**」
   - 「**Root Directory**」に **`/relay`** を入れる（同じリポジトリに置いたとき。`cloudflare` フォルダごと置いているときは `/cloudflare/relay`）
   - 「**Watch Paths**」があれば **`/relay/**`** を入れる（同じく `/cloudflare/relay/**`。Bot やサイトだけ変えたときに、リレーが作り直されないように）
4. 「**Variables**」タブ →「New Variable」で 2 つ入れる

   | 名前 | 値 |
   |---|---|
   | `WORKER_HOST` | Worker のホスト名（例: `mayosbedrocktool.dev-mayo-tools.workers.dev`。`https://` や `/` は付けない） |
   | `PORT` | `8080` |

5. 「**Settings**」→「**Networking**」→「**TCP Proxy**」→ ポートに **`8080`** を入れて追加
   - `shuttle.proxy.rlwy.net:15140` のような **アドレス:ポート** が出ます。これが**リレーのアドレス**です（数字は人によってちがいます）
   - 「Generate Domain」（HTTP のドメイン）は使いません
6. 画面の上に「Apply changes」「Deploy」などが出ていたら押して、デプロイし直す
7. 「**Deployments**」で、いちばん上が「Active」（緑）になればOK。「View logs」で、こう出ていれば動いています
   ```
   MaYoVCRelay 1.1.0 起動: [::]:8080 → wss://mayosbedrocktool.dev-mayo-tools.workers.dev
   公開アドレス: shuttle.proxy.rlwy.net:15140（これをサイトの /setup/ の「リレーのアドレス」に入れる）
   ```
8. ブラウザで **`http://<リレーのアドレス>/`**（例: `http://shuttle.proxy.rlwy.net:15140/`）をひらくと、
   `MaYoVCRelay 1.1.0 OK（中継先: …）` と出ます（`https://` ではなく `http://` です）

> Railway の画面の言葉や場所は、変わることがあります。見つからないときは、Railway のドキュメントの「TCP Proxy」「Monorepo」を見てください。

## ③ Bot にリレーのアドレスを教える

1. サイトの **`/setup/`**（例: `https://mayosbedrocktool.dev-mayo-tools.workers.dev/setup/`）をひらく
2. 「📡 リレー（Railway）のアドレスを入れる」に、**② の 5 のアドレス:ポート**を入れる（例: `shuttle.proxy.rlwy.net:15140`）
3. 確認のため **Bot のトークン**（最初に `/setup/` で入れたもの）を入れて「**保存してためす**」
4. 「✓ リレーが動いています（MaYoVCRelay v1.1.0・中継先: …）」と出れば完成
   - トークンは確認に使うだけで、保存はしません。手もとにないときは、Developer Portal の「Reset Token」で出し直して、上の「トークンを入れ直す」で設定し直してから使ってください
   - 「中継先が … になっています」と出たら、② の `WORKER_HOST` がこの Worker になっているか確認
5. Discord で **`/vc key`** を送ると、コマンドが **`/wsserver ws://shuttle.proxy.rlwy.net:15140/v/ABCD2345`** の形になります
   （反映まで 30 秒くらいかかることがあります）
6. ワールドに入って、そのコマンドをチャットで送る →「[近接VC] … とつながりました」

- リレーをやめるときは、`/setup/` のアドレスを空にして保存（Discord の案内が「近接VC コネクター」に戻ります）
- 上級者向け: `wrangler.toml` の `[vars]` に `RELAY_HOST = "shuttle.proxy.rlwy.net:15140"` と書いても同じです（こちらが優先）。
  Cloudflare のダッシュボードで変数として入れた場合は、GitHub からデプロイし直すと `wrangler.toml` の内容で上書きされて消えます（Cloudflare のドキュメント「Source of truth」）

---

## 独自ドメインを使うとき（例: `vc.example.com`）

TCP Proxy は「ポート番号で振り分ける」しくみなので、Railway 側に独自ドメインを登録する必要はありません。DNS を足すだけです。

1. ドメインの DNS に **CNAME** を 1 つ足す
   - 名前: `vc`（`vc.example.com` にするとき）
   - 向け先: TCP Proxy のホスト名だけ（例: `shuttle.proxy.rlwy.net`）。**`:15140` は付けない**
2. **Cloudflare の DNS を使っているときは、雲のマークを灰色（DNS のみ）にする**
   - Railway のドキュメントにも「Cloudflare を使うときはプロキシをオフ（DNS のみ）に」と書かれています。オレンジ（プロキシ）にすると、Cloudflare を通ってしまい（`Connection: upgrade` に戻る）、TCP Proxy のような番号のポートは、ふつう Cloudflare のプロキシが通しません
3. `/setup/` のリレーのアドレスを **`vc.example.com:15140`**（ドメイン + **Railway のポート番号**）にして保存 → `/vc key` で新しいコマンドを確認

ポート番号についての注意:

- **ポートは Railway が決めた番号のまま**です。`:80` や `:443`、好きな番号にはできません。Minecraft のコマンドにも必ず `:15140` のようなポートを付けます
- ドメインのいちばん上（`example.com` そのもの）より、`vc.example.com` のようなサブドメインにするほうが確実です
- Railway の「Custom Domain」ボタン（HTTP 用）は使いません
- TCP Proxy を消して作り直すと、ホスト名やポート番号が変わることがあります。そのときは CNAME と `/setup/` を直して、`/vc key` で出し直します
- `ws://`（暗号化なし）でつなぎます。リレーは TLS（`wss://`）を受け付けません。Minecraft の「暗号化された WebSocket」は、オンでもオフでもつながります

---

## お金の目安（Railway）

Railway の料金（公式ドキュメント「Pricing Plans」より）: メモリ **$10 / GB / 月**、CPU **$20 / vCPU / 月**、外への通信 **$0.05 / GB**。
Free プランは **月 $1 分**のクレジットです（最初の 30 日はお試しで $5）。

このリレーを手もとで動かして測った値:

| | 測った値 | 1 か月（24 時間動かしっぱなし）の目安 |
|---|---|---|
| メモリ | RSS 約 50 MB（そのうち実際に確保しているのは約 11 MB） | 約 $0.11〜$0.50 |
| CPU | 待っているあいだはほぼ 0（タイマーなし） | ほぼ $0 |
| 通信 | 1 人つないで、1 時間に約 5.3 MB（Bot→Minecraft 3.0 MB・Minecraft→Bot 2.3 MB） | 100 時間遊んで約 0.5 GB ＝ 約 $0.03 |

- 合計で **月 $0.2〜$0.6 くらい**の見込みです。人数が多いと通信が少し増えます
- Railway がメモリをどう数えるか（RSS 全体か、確保した分だけか）は、ドキュメントに書かれていないため幅があります。**数日動かしたら、Railway の「Usage」で実際の金額を確認**してください
- メモリの上限は、`Dockerfile` で `node` を直接起動して（`npm start` を通さない）少なくしています

## 確かめられていないこと（正直に）

- **Railway の Free プラン（月 $1）で TCP Proxy が使えるか**は、公式ドキュメントに書かれていません。使えない場合は Hobby プラン（月 $5）が必要です
- **月 $1 を使い切ったとき**、Free プランのサービスが止まるかどうかも、ドキュメントに書かれていません（お試しの $5 を使い切ると止まる、とは書かれています）
- 「Serverless」（使っていないときに眠らせる設定）は、TCP Proxy への接続で起きるかがドキュメントに書かれていないため、**オフのまま**をおすすめします（オンにすると、最初の 1 回がつながらないことがあります）
- 本物の Railway と本物の Minecraft でのテストはしていません。手もとで、Minecraft と同じ形のリクエストを送るにせ Minecraft・本物の Cloudflare Workers の実行環境（workerd）・TLS（wss）つなぎで、接続・暗号化・VC の移動まで確認しています

---

## 困ったとき

- **Minecraft で「サーバーに接続できませんでした」**
  1. ブラウザで `http://<リレーのアドレス>/` がひらけるか → ひらけなければ、Railway のサービスが止まっているか、アドレス・ポートがちがいます（「Deployments」と「View logs」を見る）
  2. コマンドに **ポート番号**（`:15140` など）が入っているか
  3. ログの「起動: [::]:8080」の番号と、TCP Proxy に入れた番号が同じか
  4. `/setup/` の「いまのリレーがつながるか、ためす」
- **チャットに「[近接VC] 接続コードがちがいます」** → Discord の `/vc key` で新しいコマンドを確認（`/vc rekey` をするとコードが変わります）
- **チャットに「[近接VC] Bot（Cloudflare）につながりませんでした」** → Railway の `WORKER_HOST` がまちがっているか、Railway から外へ通信できていません（「制限つきのお試し」のアカウントなど）
- **チャットに「[近接VC] URL がちがいます」** → Discord に出たコマンドを、そのままコピーして送ってください
- **ブラウザで「ERR_UNSAFE_PORT」** → ブラウザが一部のポート番号をひらかないためです。`/setup/` の「ためす」で確認してください
- どこで止まっているか分からないとき → Discord の「接続チェック」ボタンのページをひらいたまま、Minecraft でコマンドを送る（「✓ リレー経由で Minecraft から接続がきました」と出れば、リレーまでは届いています）
- リレーが止まっているときでも、Windows の PC なら予備の「近接VC コネクター」でつなげます

## 設定（環境変数。Railway は Variables、Google Cloud は起動スクリプトが自動で入れる）

| 名前 | 意味 | ふつうの値 |
|---|---|---|
| `WORKER_HOST` | 中継先の Worker のホスト名【必須】 | `mayosbedrocktool.dev-mayo-tools.workers.dev` |
| `PORT` | 待ち受けるポート（TCP Proxy に入れる番号と同じ） | `8080` |
| `MAX_CONN` | 全体の同時接続の上限 | `200`（入れなくてOK） |
| `PER_IP_MAX` / `PER_IP_RATE` | 同じ IP からの同時接続・1 分あたりの接続の上限（0 で無効） | `8` / `30`（入れなくてOK） |
| `PUBLIC_HOST` | 外から見たアドレス（ログと確認ページに出すだけ） | 入れなくてOK |

TCP Proxy があるときは、Railway が自動で入れる `RAILWAY_TCP_APPLICATION_PORT`（TCP Proxy に入れた番号）を `PORT` より先に使います。
