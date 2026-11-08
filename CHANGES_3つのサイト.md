# 3 つのサイト（update_13 → update_14）

1 つの Worker のまま、ひらいたアドレスでトップ（/）の中身が変わります。

| アドレス | 中身 | ファイル |
|---|---|---|
| https://m-ayosaba.com/ | **まよ鯖.COM**（まよ鯖の紹介・2 つのサイトの入口・最新情報） | `public/_home/` |
| https://tool.m-ayosaba.com/ | **MaYoSaBa BE TOOL**（いままでのサイト） | `public/` |
| https://kamen.m-ayosaba.com/ | **かめん部** | `public/_kamen/` |

## やること（Cloudflare）
1. いつもどおり GitHub に上げてデプロイ
2. Workers & Pages →「mayosbedrocktool」→「設定」→「ドメインとルート」→「追加」→「カスタムドメイン」で
   **`tool.m-ayosaba.com`** と **`kamen.m-ayosaba.com`** を追加（`m-ayosaba.com` はそのまま）
3. 数分で 3 つともひらけます

## まよ鯖.COM
- 参考ページのデザインを、暗い背景＋明るい赤オレンジにしたもの（update_15）。ナビ・できること・ルール・参加方法・運営チームは参考ページと同じ内容
- **人数は Discord から自動で読みます**（招待リンクから・10 分ごと）。読めないときは 77 人のまま
- **招待リンクを変えるとき**は `wrangler.toml` の `HOME_DISCORD_INVITE`（discord.gg/〜 の 〜）だけ変える → ボタンと人数の両方が変わります
- **最新情報**: `/setup/` →「📢 お知らせ」→ 上の **「🏠 まよ鯖ホーム」** をえらんで書く（ツールのお知らせとはまざりません）

## かめん部
- 参考デザインの形をオレンジにしたもの（文章は「かめん部とは？.txt」から）
- バナー（キャラとロゴが見えるように）・かめん部とは・企画（ピエロ MaYo 版・Hive・SMP）・メンバー・募集（条件・なり方）・YouTube / Discord
- YouTube・Discord のリンクは `public/_kamen/index.html` に書いてあります

## ツール（tool.m-ayosaba.com）
- 下に「まよ鯖.COM」へのボタンを追加
- m-ayosaba.com/corpse/ などの古いリンクは、自動で tool.m-ayosaba.com へ移ります
- マイクラの `/wsserver m-ayosaba.com/v/〜`・Discord Bot はそのまま使えます（新しく出すリンクは tool.m-ayosaba.com）

## 注意
- ブラウザに保存された設定（チャットの名前・VC の設定など）はアドレスごとなので、tool.m-ayosaba.com では一度だけ入れ直しになります
- VPS 版（vps-server.sh）はツールだけ（まよ鯖.COM・かめん部は入れていません）

## テスト
- `npm test`（4 つすべて成功）に追加: アドレスごとのトップ・www なしへの移動・まよ鯖ホームのお知らせが別になること・人数が読めないとき
