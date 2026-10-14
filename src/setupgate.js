// =====================================================================
//  /setup/（管理者用の設定ページ）のパスワードロック
//
//  ・パスワードは SETUP_KEY（サーバーの中にだけある秘密。VPS では /etc/mayo-vc/env、Cloudflare ではシークレット）
//  ・まちがい・未入力のあいだは、設定ページの本体（フォーム・説明文）をブラウザに 1 文字も送らない。
//    送るのは、パスワードを入れる窓だけの小さなページ（gatePage）
//  ・パスワードが合ったら、12 時間だけ使える「入室の印」（Cookie）を渡す。
//    印は SETUP_KEY から作った署名つきで、サーバーに何も保存しない（SETUP_KEY を変えると全部むこうになる）
//  ・設定のための API（/api/setup/… ・/api/admin/chat）も、この印がないと何も返さない（index.js で確認）
//  ・SETUP_KEY が決まっていないサーバーでは、だれも入れない（先に来た人に設定されないように）
//
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { isSet } from "./appconfig.js";

export const SESSION_MS = 12 * 3600 * 1000;
const enc = new TextEncoder();

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

/** 2 つの文字列が同じか（長さなどの情報がもれないように、ハッシュにしてから全部くらべる） */
export async function sameHash(a, b) {
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest("SHA-256", enc.encode(String(v)))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}

async function sign(env, exp) {
  const key = await crypto.subtle.importKey("raw", enc.encode("setup-session|" + String(env.SETUP_KEY).trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("setup-session:" + exp)));
}

/** https でひらかれているか（VPS では Caddy が X-Forwarded-Proto を付ける） */
export function isHttps(request) {
  const u = new URL(request.url);
  return u.protocol === "https:" || (request.headers.get("X-Forwarded-Proto") || "").toLowerCase() === "https";
}
const cookieName = secure => (secure ? "__Host-mayo_setup" : "mayo_setup");

function readCookie(request, name) {
  for (const part of String(request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** 入室の印がいま有効か（SETUP_KEY がないサーバーでは、いつも false） */
export async function isSetupAuthed(request, env) {
  if (!isSet(env.SETUP_KEY)) return false;
  const v = readCookie(request, cookieName(isHttps(request)));
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(v);
  if (!m) return false;
  const exp = Number(m[1]), now = Date.now();
  if (exp < now || exp > now + SESSION_MS + 60000) return false;
  return sameHash(m[2], await sign(env, exp));
}

/** パスワードが合ったときに渡す Set-Cookie の値 */
export async function sessionCookie(request, env) {
  const secure = isHttps(request);
  const exp = Date.now() + SESSION_MS;
  return `${cookieName(secure)}=${exp}.${await sign(env, exp)}; Max-Age=${Math.floor(SESSION_MS / 1000)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

const PAGE_HEAD = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>ログイン</title>
<style>
:root { color-scheme: light dark; --bg: #f4f5f8; --card: #fff; --fg: #1d2030; --sub: #5d6378; --line: #cfd3df; --accent: #4f46e5; --ng: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg: #14161f; --card: #1d2030; --fg: #e8eaf2; --sub: #9aa1b8; --line: #343a52; --accent: #8b87ff; --ng: #ff7b6b; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; padding: 16px; }
main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px 22px; }
h1 { margin: 0 0 14px; font-size: 18px; }
input { width: 100%; padding: 11px 12px; font-size: 16px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: inherit; }
button { margin-top: 12px; width: 100%; padding: 11px; font-size: 16px; font-weight: 700; border: 0; border-radius: 9px; background: var(--accent); color: #fff; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
p { margin: 10px 0 0; font-size: 14px; color: var(--sub); }
#msg { min-height: 1.4em; color: var(--ng); }
code { font-size: 13px; word-break: break-all; }
</style></head><body><main>`;

/** パスワードを入れる窓だけのページ（これ以外の説明やフォームは出さない） */
export function gatePage({ keyMissing = false } = {}) {
  if (keyMissing) {
    return `${PAGE_HEAD}
<h1>ログインできません</h1>
<p>このサーバーには、パスワード（<code>SETUP_KEY</code>）がまだ登録されていません。登録するまで、この画面は使えません。</p>
<p>Cloudflare: Worker の「設定」→「変数とシークレット」に、シークレット <code>SETUP_KEY</code> を追加。<br>VPS: <code>sudo mayo-vc key</code> で出るキーがパスワードです。</p>
</main></body></html>`;
  }
  return `${PAGE_HEAD}
<h1>パスワードを入力してください</h1>
<form id="f" autocomplete="off">
  <input id="k" type="password" autocomplete="current-password" spellcheck="false" aria-label="パスワード" placeholder="パスワード" autofocus>
  <button id="b" type="submit">入る</button>
</form>
<p id="msg" role="alert"></p>
<script>
"use strict";
const f = document.getElementById("f"), k = document.getElementById("k"), b = document.getElementById("b"), msg = document.getElementById("msg");
f.addEventListener("submit", async e => {
  e.preventDefault();
  if (!k.value.trim()) { k.focus(); return; }
  b.disabled = true; msg.textContent = "";
  try {
    const r = await fetch("/api/setup/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k.value.trim() }), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { location.reload(); return; }
    msg.textContent = j.error || "入れませんでした。";
  } catch (err) { msg.textContent = "つながりませんでした。もう一度ためしてください。"; }
  b.disabled = false; k.select();
});
</script>
</main></body></html>`;
}
