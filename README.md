# マイクラ統合版ツール（死体スキン・近接VC）

> 制作: **MaYo (mayo01297)**　／　**二次配布禁止**（再アップロード・改変しての配布・自作発言の禁止）

このフォルダを GitHub に置いて、Cloudflare で「リポジトリをインポート」するだけで動きます（ブラウザだけでOK）。

1. このフォルダを GitHub のリポジトリ（Private でOK）にアップロード
2. Cloudflare →「Workers & Pages」→「作成」→「リポジトリをインポート」
   - Worker 名は `wrangler.toml` の `name`（いまは `corpseskintoolpage`）と同じにする
   - このフォルダをリポジトリの `cloudflare/` に置いたときは、「設定」→「ビルド」の **ルートディレクトリ** を `cloudflare` にする
3. できたサイトの `/setup/` をひらいて、Discord の Bot のトークンを貼って「設定する」

| フォルダ・ファイル | 中身 |
|---|---|
| `public/` | サイト（トップ・死体スキン・近接VC・設定ページ） |
| `src/` | 近接VC の Discord Bot と、Minecraft の `/wsserver` の受け口（`/v/<接続コード>`） |
| `wrangler.toml` | Worker の設定（Durable Object `GUILD` → `GuildRoom`、WebSocket の圧縮オフ） |
