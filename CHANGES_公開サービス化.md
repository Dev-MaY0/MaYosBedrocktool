# 公開サービス化の修正メモ（update_3 → update_4）

## 変えたもの
| 仕様書 | 内容 | 場所 |
|---|---|---|
| 3.1 | 全ページのフッターから「管理者用の設定」リンクを削除（`/setup/` は URL を直接入力して開く） | `public/**/index.html` |
| 3.2 | `/setup/` を `SETUP_KEY` でロック。未ログインではパスワードの窓だけを返し、設定の画面・説明文は一切送らない | `src/setupgate.js`（新規）・`src/index.js`・`wrangler.toml` |
| 3.2 | 設定 API（`/api/setup/*`・`/api/admin/chat`）も、ログインなしだと 401 | `src/index.js` |
| 3.3 | Discord Bot の手順を 6 ステップに（New Application → Reset Token → Public Bot → 3 つのインテント → 設定する → OAuth2 の URL Generator）。元の文章は残したまま追加 | `public/_admin/setup/index.html` |
| 3.4 | 部屋の内部 ID を 32 文字のランダムな ID（UUID）に。6 けたの部屋番号は、名簿で内部 ID につなぐ | `src/index.js`・`src/guild.js`・`src/webvc.js` |
| 3.5 | `relay/relay.mjs` は変更なし（下を参照） | — |
| — | `vps-server.sh`（中に Worker とサイトを入れて配るスクリプト）を、今回の内容で作り直し | `public/download/vps-server.sh` |

## /setup/ のしくみ
- 設定ページの本体は `public/_admin/setup/index.html` に移動。`/_admin/*` と `/setup/index.html` は、いつも 404。
- パスワードが合うと、12 時間の入室の印（HttpOnly・SameSite=Strict の Cookie。`SETUP_KEY` から作った署名つきで、サーバーには何も保存しない）を渡す。
- 総当たりよけ: 同じ IP から 1 時間に 10 回まで。
- **`SETUP_KEY` が登録されていないサーバーでは、だれも `/setup/` に入れません。**
  - Cloudflare: 「設定」→「変数とシークレット」にシークレット `SETUP_KEY` を追加（20 文字以上のランダムな文字）
  - VPS（vps-server.sh）: インストールのときに自動で作られます（`sudo mayo-vc key`）
- 以前は `/setup/` を開くだけで、シークレット `DISCORD_TOKEN` から自動設定が走っていました。いまはログイン後に開いたときに走ります。

## 部屋番号について
- 人が打つ番号は、これまでどおり 6 けた（仕様書 2.2）。内部の Durable Object の名前は、32 文字のランダムな ID になりました。
- 番号の割り当ては名簿（`__directory__`）の 1 か所で行うので、同時に作っても番号は被りません。
- 前の版で作った部屋は、番号がそのまま名前なので、番号でも引き続き開けます。

## relay.mjs について
Bot のトークンを持たない作りです。Minecraft からの接続を Worker にそのまま流すだけで、部屋の割り当ては Worker がやります。そのため、もともと複数の人が同時に使える形でした。確認のため、リレー経由で 8 人が同時に `/new` へつなぐテストを足してあります。

## テスト
`npm install && npm test`（workerd で動かします。本物の Discord には何も送りません）。
