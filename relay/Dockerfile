# 近接VC リレー（Railway 用）  制作: MaYo (mayo01297)  二次配布禁止
# Railway は、このフォルダに Dockerfile があると、これを使ってビルドします。
# npm を通さずに node を直接起動するので、メモリが少なくてすみます（npm start だと npm の分も使う）。
FROM node:22-alpine
WORKDIR /app
COPY package.json relay.mjs ./
ENV NODE_ENV=production
USER node
EXPOSE 8080
# --max-old-space-size … JavaScript のメモリの上限（MB）。このリレーはほとんど使わないので小さく
CMD ["node", "--max-old-space-size=32", "relay.mjs"]
