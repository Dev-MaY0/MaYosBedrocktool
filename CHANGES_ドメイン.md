# ドメインを m-ayosaba.com に（update_11 → update_12）

| ファイル | 変えたところ |
|---|---|
| `wrangler.toml` | `SITE_URL = "https://m-ayosaba.com"`。Discord のボタン（サイトでくわしく見る・接続チェック・コネクター）とマイクラのチャットの案内（〜/talk/）が、このアドレスになる |
| `public/config.js` | `mainSite: "https://m-ayosaba.com"`。workers.dev でひらいた人は m-ayosaba.com へ自動で移動（/setup/ と /download/ はそのまま・自分の PC でためすときも移動しない） |
| `src/index.js` | `www.m-ayosaba.com` でひらいたら `m-ayosaba.com` へ移動（301。ページを見るときだけ） |
| 各ページ | `canonical` と OGP（Discord・X に URL を貼ったときのカード: タイトル・説明・ロゴ） |
| `test/news-reconnect.test.mjs` | www の移動のテストを追加 |

※ 前のアドレス（workers.dev）でブラウザに保存されていたもの（ゲストの名前・死体スキンの登録など）は、新しいアドレスには引きつがれません。
※ リレー（VPS）は workers.dev のままで大丈夫です（変えなくてOK）。
