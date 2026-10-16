# マイクラ統合版ツール（死体スキン・近接VC）

> 制作: **MaYo (mayo01297)**　／　**二次配布禁止**（再アップロード・改変しての配布・自作発言の禁止）

このフォルダを GitHub に置いて、Cloudflare で「リポジトリをインポート」するだけで動きます（ブラウザだけでOK）。

1. このフォルダを GitHub のリポジトリ（Private でOK）にアップロード
2. Cloudflare →「Workers & Pages」→「作成」→「リポジトリをインポート」
   - Worker 名は `wrangler.toml` の `name`（いまは `mayosbedrocktool`）と同じにする
   - このフォルダをリポジトリの `cloudflare/` に置いたときは、「設定」→「ビルド」の **ルートディレクトリ** を `cloudflare` にする
3. **管理者用のパスワードを決める**: Worker の「設定」→「変数とシークレット」で、種類を「**シークレット**」にして `SETUP_KEY` を追加（長くてランダムな 20 文字以上。`npx wrangler secret put SETUP_KEY` でも可）。**入れないと `/setup/` はだれも開けません**
4. できたサイトの `/setup/` をひらいて、**パスワード（`SETUP_KEY`）を入れ**、Discord の Bot のトークンを貼って「設定する」
   - `/setup/` は、パスワードを入れるまで、パスワードの窓だけが出ます（設定の画面・説明文は見えません）。サイトの画面には、`/setup/` へのリンクはありません。URL を直接入力して開きます
   - 部屋番号（6 けた）は人が打つ番号で、内部では長いランダムな ID（32 文字）の部屋に割り当てられます

| フォルダ・ファイル | 中身 |
|---|---|
| `public/` | サイト（トップ・死体スキン・近接VC（サイト版・Discord 版）・チャット・設定ページ）。`download/vps-server.sh` は VPS で公開サイトとして動かすスクリプト |
| `src/` | 近接VC の Discord Bot と、Minecraft の `/wsserver` の受け口（`/v/<接続コード>`） |
| `wrangler.toml` | Worker の設定（Durable Object `GUILD` → `GuildRoom`、WebSocket の圧縮オフ） |
| `relay/` | 近接VC リレー（**Google Cloud の VM** や **Railway** で動かす中継サーバー）。Minecraft の `/wsserver` を PC のアプリなしで Bot につなぐ。Cloudflare では使いません。手順は [relay/vps/README.md](relay/vps/README.md)（VPS・ConoHa）・[relay/gcp/README.md](relay/gcp/README.md)（Google Cloud）・[relay/README.md](relay/README.md)（Railway） |
| `relay/vps/PUBLIC_SERVER.md` | （上級者向け）このサイトと Bot をまとめて VPS に引っ越す手順（自分のドメインがあるとき） |
| `test/` | Worker のテスト（`npm test`。Cloudflare では使いません） |
| `src/news.js` | ホームの「最新情報」（お知らせ）。`/setup/` の「📢 お知らせ」で書くと、ホームに出ます |
| `relay/vps/build-vps-server.mjs` | `public/download/vps-server.sh` を作り直す（`node relay/vps/build-vps-server.mjs`）。src/ や public/ を変えたら実行 |
