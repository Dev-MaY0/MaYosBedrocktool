// =====================================================================
//  接続チェックのページ（ブラウザで /v/<接続コード> をひらいたとき）
//  Minecraft の /wsserver が Bot まで届いているかを、その場で見られる。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STYLE = `
:root { --bg:#f3f4f6; --card:#fff; --text:#1f2328; --sub:#5d6670; --line:#d9dde3; --green:#2e9e48; --orange:#d97a00; --red:#c93c3c; --blue:#2868ce; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif; line-height: 1.6; }
header { background: #2f3640; color: #fff; padding: 14px 16px; }
header h1 { margin: 0; font-size: 19px; }
header p { margin: 2px 0 0; font-size: 13px; opacity: .85; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 14px; }
.card h2 { margin: 0 0 10px; font-size: 16.5px; }
.state { display: flex; gap: 12px; align-items: center; }
.state .big { width: 42px; height: 42px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 22px; font-weight: 700; color: #fff; background: #b2b6be; }
.state.ok .big { background: var(--green); } .state.ng .big { background: var(--orange); } .state.bad .big { background: var(--red); }
.state b { font-size: 16px; } .state p { margin: 2px 0 0; color: var(--sub); font-size: 13.5px; }
.cmd { display: flex; gap: 8px; align-items: stretch; margin: 6px 0 10px; }
.cmd code { flex: 1; min-width: 0; overflow-wrap: anywhere; background: #1f2328; color: #e6edf3; border-radius: 6px; padding: 9px 11px; font-family: ui-monospace, Consolas, monospace; font-size: 14px; }
.cmd button { flex: none; border: 0; border-radius: 6px; background: var(--blue); color: #fff; font-weight: 700; padding: 0 14px; cursor: pointer; font-size: 14px; }
.label { font-size: 13.5px; color: var(--sub); margin: 8px 0 0; }
.dl { display: inline-block; background: var(--blue); color: #fff; font-weight: 700; text-decoration: none; padding: 8px 16px; border-radius: 6px; }
ul.tries { list-style: none; margin: 0; padding: 0; font-size: 14px; }
ul.tries li { padding: 6px 8px; border-bottom: 1px dashed var(--line); border-radius: 6px; }
ul.tries li:last-child { border-bottom: 0; }
ul.tries li.new { background: #fff7d6; }
ul.tries .t { color: var(--sub); font-size: 12.5px; margin-right: 6px; }
ul.tries .d { color: var(--sub); font-size: 12px; overflow-wrap: anywhere; }
.empty { color: var(--sub); font-size: 14px; margin: 0; }
.hint { margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; background: #eef4fd; font-size: 14px; }
.hint.warn { background: #fff2e0; }
ol.check { margin: 0; padding-left: 22px; font-size: 14.5px; }
ol.check li { margin: 6px 0; }
footer { text-align: center; color: var(--sub); font-size: 12px; padding: 8px 0 24px; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181c; --card:#1f2228; --text:#e6e8eb; --sub:#a3aab3; --line:#353a42; }
  .cmd code { background: #0d1014; }
  ul.tries li.new { background: #3a3420; }
  .hint { background: #1d2a3d; } .hint.warn { background: #3a2c17; }
}
`;

/** 接続コードがちがうとき */
export function badCodePage() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>接続チェック</title><style>${STYLE}</style></head><body>
<header><h1>近接VC 接続チェック</h1><p>制作: MaYo（mayo01297）</p></header>
<main><section class="card"><div class="state bad"><div class="big">✗</div><div><b>この接続コードは見つかりません</b>
<p>Discord で <b>/vc key</b> を送って、新しいコマンドを確認してください（<b>/vc rekey</b> をするとコードが変わります）。</p></div></div></section></main>
<footer>© MaYo (mayo01297)　二次配布禁止</footer></body></html>`;
}

/** 接続チェックのページ（relay … リレーのアドレス。あれば Minecraft からリレーにつなぐ案内を先に出す） */
export function checkPage({ host, code, relay = "" }) {
  const ws = `/wsserver ws://${host}/v/${code}`;
  const wss = `/wsserver wss://${host}/v/${code}`;
  const viaRelay = relay ? `/wsserver ws://${relay}/v/${code}` : "";
  const connectorSteps = `
    <p style="margin:8px 0"><a class="dl" href="/download/MaYoVCConnector.zip">近接VC コネクターをダウンロード（.zip）</a></p>
    <p class="label">コネクターに貼り付けて「スタート」</p>
    <div class="cmd"><code id="c1">${esc(ws)}</code><button type="button" data-copy="c1">コピー</button></div>
    <p class="label">このページをひらいたまま、Minecraft のチャットで送る</p>
    <div class="cmd"><code id="c3">/wsserver ws://127.0.0.1:19131</code><button type="button" data-copy="c3">コピー</button></div>`;
  const first = relay ? `
  <section class="card">
    <h2>① Minecraft のチャットで送る</h2>
    <p class="label" style="margin-top:0">このページをひらいたまま、ワールドに入って、チャットでこれを送ってください（リレー経由でつながります）。</p>
    <div class="cmd"><code id="c0">${esc(viaRelay)}</code><button type="button" data-copy="c0">コピー</button></div>
    <p class="label">リレーが動いているかは、ブラウザで <a href="http://${esc(relay)}/" target="_blank" rel="noopener">http://${esc(relay)}/</a> をひらくと分かります（「MaYoVCRelay … OK」と出れば動いています）。</p>
    <details style="margin-top:10px"><summary class="label" style="cursor:pointer">予備: リレーが動かないとき（近接VC コネクター・Windows）</summary>${connectorSteps}
    </details>
  </section>
` : `
  <section class="card">
    <h2>① 近接VC コネクター（Windows）でつなぐ</h2>
    <p class="label" style="margin-top:0">Minecraft の /wsserver は、Cloudflare 上の Bot に直接つなぐと、すぐ切れてしまいます。PC の中で中継する「近接VC コネクター」を使ってください。</p>${connectorSteps}
    <details style="margin-top:10px"><summary class="label" style="cursor:pointer">コネクターを使わずに直接つなぐ（ほとんどの場合、すぐ切れます）</summary>
      <div class="cmd"><code id="c2">${esc(wss)}</code><button type="button" data-copy="c2">コピー</button></div>
    </details>
  </section>
`;
  return `<!doctype html>
<!-- 近接VC 接続チェック  制作: MaYo (mayo01297)  二次配布禁止 -->
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>接続チェック</title><style>${STYLE}</style></head><body>
<header><h1>近接VC 接続チェック</h1><p>Minecraft の /wsserver が Bot まで届いているかを見るページ　｜　制作: MaYo（mayo01297）</p></header>
<main>
  <section class="card" aria-live="polite">
    <div class="state" id="state"><div class="big" id="icon">…</div><div><b id="title">確認しています…</b><p id="sub"></p></div></div>
  </section>
${first}
  <section class="card" aria-live="polite">
    <h2>② Minecraft からの接続の記録（3秒ごとに更新）</h2>
    <ul class="tries" id="tries"></ul>
    <p class="empty" id="empty">まだ何も届いていません。</p>
    <p class="hint" id="hint" hidden></p>
  </section>

  <section class="card">
    <h2>③ 記録が出ないとき（Minecraft 側で止まっています）</h2>
    <ol class="check">
      <li>ワールドの設定で <b>チート</b> がオン、コマンドを打つ人が <b>オペレーター</b>（ホスト）になっている</li>
      <li>Minecraft の「設定」→「一般」にある <b>WebSocket</b> の項目を見る：「WebSocket を有効にする」のようなスイッチがあれば <b>オン</b>、「<b>暗号化された WebSocket を要求</b>」は <b>オフ</b></li>
      <li>設定を変えたら、<b>Minecraft を一度完全に終了</b>して、ひらき直す</li>
      <li>コマンドを <b>2〜3回</b> 送ってみる（1回目は失敗することがあります）</li>
      ${relay ? `<li>Minecraft のコマンドが ① のもの（<b>${esc(viaRelay)}</b>）と同じか確認する。ポート番号（<b>:</b> のあとの数字）も必要です</li>
      <li>ブラウザで <b>http://${esc(relay)}/</b> がひらけないときは、リレー（中継サーバー）が止まっています。Google Cloud の VM・Railway のサービスが動いているか、アドレスが変わっていないか確認する</li>` : ""}
      <li>コネクターを使っているときは、コネクターの画面が「Minecraft からの接続を待っています」になっているか、Minecraft のコマンドがコネクターに出ているもの（<b>/wsserver ws://127.0.0.1:19131</b>）と同じか確認する</li>
      <li>学校・お店などの Wi-Fi や、セキュリティソフトの「Web保護」が止めていることがあります。<b>スマホのテザリング</b>など、ちがう回線でも試す</li>
      <li>Realms のワールドでは使えません（自分のワールドで、ホストが送ってください）</li>
    </ol>
  </section>
</main>
<footer>© MaYo (mayo01297)　二次配布禁止</footer>
<script>
"use strict";
const CODE = ${JSON.stringify(code)};
const RELAY = ${JSON.stringify(relay)};
const opened = Date.now();
const $ = id => document.getElementById(id);
let skew = 0;
function ago(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "秒前" : s < 3600 ? Math.round(s / 60) + "分前" : Math.round(s / 3600) + "時間前"; }
function show(kind, icon, title, sub) { $("state").className = "state " + kind; $("icon").textContent = icon; $("title").textContent = title; $("sub").textContent = sub || ""; }
async function load() {
  let d;
  try { d = await (await fetch("/v/" + CODE + "?json=1", { cache: "no-store" })).json(); } catch (e) { show("ng", "!", "Bot につながりません", "インターネットの接続を確認してください。"); return; }
  if (!d.ok) { show("bad", "✗", "この接続コードは見つかりません", "Discord で /vc key を送って、新しいコマンドを確認してください。"); return; }
  skew = (d.now || Date.now()) - Date.now();
  const where = d.kind === "web" ? "サイトの部屋「" + d.guildName + "」" : "Discord「" + d.guildName + "」";
  const now = Date.now() + skew;
  if (d.mode === "ws") show("ok", "✓", "つながっています！（" + where + "）", d.ready ? (d.encrypted ? "暗号化して通信しています。" : "通信しています。") : "準備しています…");
  else if (d.mode === "bds") show("ok", "✓", "BDS からつながっています（" + where + "）", "");
  else show("ng", "…", "接続コードは正しいです（" + where + "）", "まだ Minecraft とはつながっていません。① のコマンドを送ってください。");
  const ul = $("tries"); ul.textContent = "";
  for (const x of d.tries || []) {
    const li = document.createElement("li");
    if (x.t >= opened + skew - 2000) li.className = "new";
    const t = document.createElement("span"); t.className = "t"; t.textContent = ago(now - x.t);
    li.append(t, x.text + (x.scheme === "https" ? "（wss://）" : x.scheme === "http" ? "（ws://）" : ""));
    if (x.detail) { const dd = document.createElement("div"); dd.className = "d"; dd.textContent = x.detail; li.appendChild(dd); }
    ul.appendChild(li);
  }
  $("empty").hidden = !!(d.tries && d.tries.length);
  const fresh = (d.tries || []).filter(x => x.t >= opened + skew - 2000);
  const hint = $("hint");
  hint.hidden = false; hint.className = "hint";
  if (d.mode === "ws") hint.textContent = "うまくいっています。Minecraft のチャットに「[近接VC] … とつながりました」が出ていれば完成です。";
  else if (!fresh.length) hint.textContent = "このページをひらいてから、まだ何も届いていません。Minecraft でコマンドを送ると、数秒でここに出ます。出なければ ③ を見てください。" + (RELAY ? "（「サーバーに接続できませんでした」と出るときは、リレーが止まっているか、アドレス・ポートがちがいます）" : "");
  else if (fresh.some(x => x.kind === "close" && /1002/.test(x.text)) && !fresh.some(x => x.kind === "open" && /コネクター|リレー/.test(x.text))) { hint.className = "hint warn"; hint.textContent = RELAY ? "Minecraft から Bot（Cloudflare）に直接つないだため、すぐ切れました。上の ① のコマンド（リレー経由）を送ってください。" : "Minecraft から直接つないだため、すぐ切れました（Minecraft と Cloudflare の相性の問題です）。上の「近接VC コネクター」を使ってつないでください。"; }
  else if (fresh.some(x => x.kind === "close" || x.kind === "error")) { hint.className = "hint warn"; hint.textContent = "Bot までは届いていますが、すぐ切れています。記録の「切れました」の行と、その下の灰色の行を見ると、原因が分かります。スクリーンショットを残しておいてください。"; }
  else if (fresh.some(x => x.kind === "noupgrade")) { hint.className = "hint warn"; hint.textContent = "Bot までは届いていますが、とちゅうで WebSocket の形がこわされています。wss:// のほうを試すか、ちがう回線で試してください。"; }
  else hint.textContent = "Bot まで届いています。";
}
for (const b of document.querySelectorAll("button[data-copy]")) {
  b.addEventListener("click", () => {
    const text = $(b.dataset.copy).textContent;
    const done = ok => { b.textContent = ok ? "コピー済み" : "失敗"; setTimeout(() => { b.textContent = "コピー"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); else done(false);
  });
}
load();
setInterval(() => { if (document.visibilityState === "visible") load(); }, 3000);
</script>
</body></html>`;
}
