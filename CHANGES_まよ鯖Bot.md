# まよ鯖 Bot のインストーラーを置きました（update_15 → update_16）

- `public/download/mayo-bot-setup.sh` … まよ鯖 Bot を VPS に入れるインストーラー
  - プッシュすると https://tool.m-ayosaba.com/download/mayo-bot-setup.sh でダウンロードできます
  - VPS で: `curl -fsSL https://tool.m-ayosaba.com/download/mayo-bot-setup.sh | sudo bash`
  - トークンは中に入っていません（入れるときに聞かれます）
- Bot のプログラムは別のフォルダ（`mayo-bot/`・別の zip）です。使い方はその README.md
- VPS 版（vps-server.sh）には、このインストーラーは入れていません
