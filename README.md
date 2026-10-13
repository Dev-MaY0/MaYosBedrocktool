# マイクラ統合版ツール（死体スキン・近接VC）

> 制作: **MaYo (mayo01297)**　／　**二次配布禁止**（再アップロード・改変しての配布・自作発言の禁止）

このフォルダを GitHub に置いて、Cloudflare で「リポジトリをインポート」するだけで動きます（ブラウザだけでOK）。

1. このフォルダを GitHub のリポジトリ（Private でOK）にアップロード
2. Cloudflare →「Workers & Pages」→「作成」→「リポジトリをインポート」
   - Worker 名は `wrangler.toml` の `name`（いまは `mayosbedrocktool`）と同じにする
   - このフォルダをリポジトリの `cloudflare/` に置いたときは、「設定」→「ビルド」の **ルートディレクトリ** を `cloudflare` にする
3. できたサイトの `/setup/` をひらいて、Discord の Bot のトークンを貼って「設定する」

| フォルダ・ファイル | 中身 |
|---|---|
| `public/` | サイト（トップ・死体スキン・近接VC（サイト版・Discord 版）・チャット・設定ページ）。`download/vps-server.sh` は VPS で公開サイトとして動かすスクリプト |
| `src/` | 近接VC の Discord Bot と、Minecraft の `/wsserver` の受け口（`/v/<接続コード>`） |
| `wrangler.toml` | Worker の設定（Durable Object `GUILD` → `GuildRoom`、WebSocket の圧縮オフ） |
| `relay/` | 近接VC リレー（**Google Cloud の VM** や **Railway** で動かす中継サーバー）。Minecraft の `/wsserver` を PC のアプリなしで Bot につなぐ。Cloudflare では使いません。手順は [relay/vps/README.md](relay/vps/README.md)（VPS・ConoHa）・[relay/gcp/README.md](relay/gcp/README.md)（Google Cloud）・[relay/README.md](relay/README.md)（Railway） |
| `relay/vps/PUBLIC_SERVER.md` | （上級者向け）このサイトと Bot をまとめて VPS に引っ越す手順（自分のドメインがあるとき） |
| `test/` | Worker のテスト（`npm test`。Cloudflare では使いません） |
