// =====================================================================
//  接続チェックのページ（ブラウザで /v/<接続コード> をひらいたとき）
//  Minecraft の /wsserver が Bot まで届いているかを、その場で見られる。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STYLE = `
:root { --bg:#fafafa; --card:#fff; --text:#262626; --sub:#737373; --line:#dbdbdb; --soft:#efefef; --green:#22a55b; --orange:#f39c12; --red:#ed4956; --blue:#0095f6;
  --grad: linear-gradient(45deg,#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5); --grad-btn: linear-gradient(90deg,#f56040,#e1306c,#833ab4); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, system-ui, sans-serif; line-height: 1.6; -webkit-font-smoothing: antialiased; }
header { background: rgba(255,255,255,.92); border-bottom: 1px solid var(--line); padding: 12px 16px; }
header h1 { margin: 0 auto; max-width: 760px; font-size: 19px; font-weight: 800; background: var(--grad-btn); -webkit-background-clip: text; background-clip: text; color: transparent; }
header p { margin: 2px auto 0; max-width: 760px; font-size: 12.5px; color: var(--sub); }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; margin: 0 0 14px; box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.05); }
.card h2 { margin: 0 0 10px; font-size: 16.5px; }
.state { display: flex; gap: 12px; align-items: center; }
.state .big { width: 46px; height: 46px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 22px; font-weight: 700; color: #fff; background: #c7c7c7; }
.state.ok .big { background: var(--green); } .state.ng .big { background: var(--orange); } .state.bad .big { background: var(--red); }
.state b { font-size: 16px; } .state p { margin: 2px 0 0; color: var(--sub); font-size: 13.5px; }
.cmd { display: flex; gap: 6px; align-items: center; margin: 6px 0 10px; background: #f5f5f5; border: 1px solid var(--soft); border-radius: 12px; padding: 4px 4px 4px 12px; }
.cmd code { flex: 1; min-width: 0; overflow-wrap: anywhere; padding: 6px 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13.5px; }
.cmd button { flex: none; align-self: stretch; border: 0; border-radius: 9px; background: var(--blue); color: #fff; font-weight: 600; padding: 0 14px; cursor: pointer; font-size: 13px; }
.label { font-size: 13.5px; color: var(--sub); margin: 8px 0 0; }
.dl { display: inline-block; background: var(--blue); color: #fff; font-weight: 600; text-decoration: none; padding: 9px 18px; border-radius: 10px; }
ul.tries { list-style: none; margin: 0; padding: 0; font-size: 14px; }
ul.tries li { padding: 7px 10px; border-bottom: 1px solid var(--soft); border-radius: 10px; }
ul.tries li:last-child { border-bottom: 0; }
ul.tries li.new { background: #fff7e0; }
ul.tries .t { color: var(--sub); font-size: 12.5px; margin-right: 6px; }
ul.tries .d { color: var(--sub); font-size: 12px; overflow-wrap: anywhere; }
.empty { color: var(--sub); font-size: 14px; margin: 0; }
.hint { margin: 10px 0 0; padding: 10px 14px; border-radius: 12px; background: #e8f3ff; font-size: 14px; }
.hint.warn { background: #fff1db; }
ol.check { margin: 0; padding-left: 22px; font-size: 14.5px; }
ol.check li { margin: 6px 0; }
footer { text-align: center; color: var(--sub); font-size: 12px; padding: 8px 0 24px; }
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
    <p class="label">ページをひらいたまま、マイクラのチャットで送る</p>
    <div class="cmd"><code id="c3">/wsserver ws://127.0.0.1:19131</code><button type="button" data-copy="c3">コピー</button></div>`;
  const first = relay ? `
  <section class="card">
    <h2>① マイクラのチャットで送る</h2>
    <p class="label" style="margin-top:0">ページをひらいたまま、ワールドでこれを送ってください。</p>
    <div class="cmd"><code id="c0">${esc(viaRelay)}</code><button type="button" data-copy="c0">コピー</button></div>
    <p class="label">リレーの確認: <a href="http://${esc(relay)}/" target="_blank" rel="noopener">http://${esc(relay)}/</a>（「MaYoVCRelay … OK」なら動いています）</p>
    <details style="margin-top:10px"><summary class="label" style="cursor:pointer">予備: コネクター（Windows）</summary>${connectorSteps}
    </details>
  </section>
` : `
  <section class="card">
    <h2>① 近接VC コネクター（Windows）でつなぐ</h2>
    <p class="label" style="margin-top:0">Bot に直接つなぐと切れるので、コネクターで中継します。</p>${connectorSteps}
    <details style="margin-top:10px"><summary class="label" style="cursor:pointer">直接つなぐ（ほぼ切れます）</summary>
      <div class="cmd"><code id="c2">${esc(wss)}</code><button type="button" data-copy="c2">コピー</button></div>
    </details>
  </section>
`;
  return `<!doctype html>
<!-- 近接VC 接続チェック  制作: MaYo (mayo01297)  二次配布禁止 -->
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>接続チェック</title><style>${STYLE}</style></head><body>
<header><h1>近接VC 接続チェック</h1><p>/wsserver が届いているか見るページ　｜　制作: MaYo（mayo01297）</p></header>
<main>
  <section class="card" aria-live="polite">
    <div class="state" id="state"><div class="big" id="icon">…</div><div><b id="title">確認しています…</b><p id="sub"></p></div></div>
  </section>
${first}
  <section class="card" aria-live="polite">
    <h2>② 接続の記録（3秒ごとに更新）</h2>
    <ul class="tries" id="tries"></ul>
    <p class="empty" id="empty">まだ何も届いていません。</p>
    <p class="hint" id="hint" hidden></p>
  </section>

  <section class="card">
    <h2>③ 記録が出ないとき</h2>
    <ol class="check">
      <li><b>チート</b>がオン・送る人が<b>オペレーター</b></li>
      <li>「設定」→「一般」で <b>WebSocket</b> をオン・「<b>暗号化を要求</b>」はオフ</li>
      <li>変えたら<b>マイクラを完全に終了</b>してひらき直す</li>
      <li>コマンドを <b>2〜3回</b> 送る</li>
      ${relay ? `<li>コマンドが ① と同じか（ポート番号も）</li>
      <li><b>http://${esc(relay)}/</b> がひらけないなら、リレーが止まっています</li>` : ""}
      <li>コネクターのときは、マイクラで <b>/wsserver ws://127.0.0.1:19131</b> を送っているか</li>
      <li>学校の Wi-Fi やセキュリティソフトが止めていることも。<b>テザリング</b>などでためす</li>
      <li>Realms では使えません</li>
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
  if (d.mode === "ws") hint.textContent = "うまくいっています。マイクラに「[近接VC] … とつながりました」と出れば完成です。";
  else if (!fresh.length) hint.textContent = "まだ何も届いていません。コマンドを送ると数秒で出ます（出なければ ③）。" + (RELAY ? "「サーバーに接続できませんでした」なら、リレーかアドレスの問題です。" : "");
  else if (fresh.some(x => x.kind === "close" && /1002/.test(x.text)) && !fresh.some(x => x.kind === "open" && /コネクター|リレー/.test(x.text))) { hint.className = "hint warn"; hint.textContent = RELAY ? "直接つないだので切れました。① のコマンドを送ってください。" : "直接つないだので切れました。コネクターを使ってください。"; }
  else if (fresh.some(x => x.kind === "close" || x.kind === "error")) { hint.className = "hint warn"; hint.textContent = "届いていますが、すぐ切れています。記録の「切れました」の行で原因が分かります。"; }
  else if (fresh.some(x => x.kind === "noupgrade")) { hint.className = "hint warn"; hint.textContent = "とちゅうで WebSocket がこわされています。wss:// か、ちがう回線でためしてください。"; }
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
