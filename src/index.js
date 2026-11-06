// =====================================================================
//  近接VC Bot（入口）… サイト（public/）と同じ Worker で動く
//  - /setup/       … 設定ページ。パスワード（SETUP_KEY）を入れるまでは、パスワードの窓だけを返す（src/setupgate.js）
//  - /api/setup/auth … 設定ページのパスワードを確かめて、12 時間の入室の印（Cookie）を渡す
//  - /api/setup    … 設定ページ（/setup/）から、Bot のトークンを登録する
//  - /api/setup/relay … 設定ページから、リレー（中継サーバー）のアドレスを保存する・ためす
//  - /interactions … Discord のスラッシュコマンド
//  - /v/<接続コード> … ワールド用（ホストが /wsserver でつなぐ。ブラウザでひらくと接続チェック）
//  - /ws/<接続キー> … ワールド用（接続キーそのままでつなぐとき）
//  - /api/update   … BDS 用（アドオンが位置のグループを送ってくる）
//  - /api/check    … サイトから接続キーを確認する
//  - /api/web/…    … サイト内の近接VC（部屋を作る・ブラウザの WebSocket・ホストの操作）
//  - /api/guest・/api/chat/… … ゲスト（名前#1234）と、みんなのチャット・DM
//  - /api/news     … ホームに出すお知らせ（だれでも読める・公開したものだけ）
//  - /api/admin/news … お知らせを書く・直す・消す（/setup/ にログインした管理者だけ）
//  - /api/works    … 作品の紹介（だれでも読める・公開したものだけ）。/api/works/img/<ID> は作品の画像
//  - /api/admin/works … 作品を書く・直す・消す（/setup/ にログインした管理者だけ）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { GuildRoom, CODE_RE } from "./guild.js";
import { verifyDiscordRequest } from "./discord.js";
import { resolveEnv, runSetup, setupStatus, isSet, loadStored, saveStored, inviteUrl, saveRelay, vpsCommand, checkAdminToken } from "./appconfig.js";
import { sha256hex } from "./webvc.js";
import { newKey, notifyWebhook } from "./shop.js";
import { checkPage, badCodePage } from "./checkpage.js";
import { testRelay } from "./relaycheck.js";
import { gatePage, isSetupAuthed, sessionCookie, sameHash, withSetupKey } from "./setupgate.js";

export { GuildRoom };

const KEY_RE = /^(\d{15,22})\.([A-Za-z0-9]{16,64})$/;
// /v/<接続コード>（/vc/ /connect/ も受け付ける。/vc/ だけのときはサイトのページ）
const CODE_PATH_RE = /^\/(?:v|vc|connect)\/([^/]+)$/i;

/** 接続キー（<サーバーID>.<ひみつの文字>）からサーバーIDを取り出す */
export function parseKey(key) {
  const m = KEY_RE.exec(String(key || "").trim());
  return m ? { guildId: m[1], secret: m[2], key: m[0] } : null;
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const room = (env, guildId) => env.GUILD.get(env.GUILD.idFromName(guildId));
const directory = env => env.GUILD.get(env.GUILD.idFromName("__directory__"));

// サイト内VC の部屋番号（6 けたの数字。前に作った部屋は、まぎらわしい 0 O 1 I を使わない 6 文字）
const ROOM_RE = /^(?:\d{6}|[A-HJ-NP-Z2-9]{6})$/;
function randomText(n, abc) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}
const webRoomId = v => { const r = String(v || "").replace(/[\s-]/g, "").toUpperCase(); return ROOM_RE.test(r) ? r : ""; };
const HOST_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/**
 * 部屋を作る。
 *  ・内部の ID: 32 文字のランダムな文字（UUID）… 世界中で同時に作っても被らない。Durable Object の名前になる
 *  ・部屋番号: 人が打つ 6 けた（100000〜999999）… 名簿で 1 つの部屋にだけ割り当てる（使われていたら作り直す）
 */
async function createWebRoom(env, { name, hostKey, fromGame = false, showKey = "" }) {
  const dir = directory(env);
  for (let i = 0; i < 12; i++) {
    const roomId = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const uid = crypto.randomUUID().replace(/-/g, "");
    const got = await (await dir.fetch("https://room/dir/room/put", { method: "POST", body: JSON.stringify({ code: roomId, uid }) })).json();
    if (!got.ok) continue;   // その番号は使われている → 別の番号で
    const r = await webRoom(env, uid).fetch("https://room/web/create", { method: "POST",
      body: JSON.stringify({ roomId, uid, name, hostKeyHash: await sha256hex(hostKey), fromGame, showKey }) });
    const j = r.status === 409 ? { ok: false } : await r.json().catch(() => ({ ok: false }));
    if (j.ok) return { roomId, uid, worldCode: j.worldCode };
    await dir.fetch("https://room/dir/room/del", { method: "POST", body: JSON.stringify({ code: roomId, uid }) });   // 作れなかった → 番号を返す
    if (r.status !== 409) return null;
  }
  return null;
}
/** いたずら防止の数え方（1 時間に max 回まで）。false なら上限 */
async function underRate(env, k, max) {
  const r = await directory(env).fetch("https://room/dir/rate", { method: "POST", body: JSON.stringify({ k, max }) });
  return !!(await r.json()).ok;
}
// 部屋（Durable Object）の名前は、内部の長いランダム ID（32 文字）。人が打つ 6 けたの部屋番号は、名簿でこの ID につなぐ
const webRoom = (env, uid) => room(env, "web:" + uid);
/** 部屋番号（6 けた）→ 部屋。番号が名簿になければ null（前の版で作った部屋は、番号がそのまま名前なので、そちらも探す） */
async function webRoomByCode(env, code) {
  const r = await (await directory(env).fetch("https://room/dir/room/get?code=" + encodeURIComponent(code))).json();
  if (r.uid) return webRoom(env, r.uid);
  return webRoom(env, code);
}
const chatRoom = env => room(env, "__chat__");
// お知らせは設定の部屋（"__config__"）に保存する
const newsRoom = env => room(env, "__config__");
// お知らせの読み出しを少しだけ覚えておく（みんながホームをひらくたびに部屋を起こさないように）
const NEWS_CACHE_MS = 15000;
const newsCaches = new Map();   // site → { items, at }
let worksCache = null, worksCacheAt = 0;

/**
 * 使っている人の IP（いたずら防止の数え方にだけ使う。そのままは保存しない）
 * Cloudflare では CF-Connecting-IP、VPS（Caddy の後ろ）では Caddy が付ける X-Real-IP
 */
async function ipKeyOf(request) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP") || "local";
  return (await sha256hex("vc:" + ip)).slice(0, 16);
}
/** ゲストのトークン → { id, name, tag }（だめなら null） */
async function guestOf(env, token) {
  if (!token) return null;
  const r = await chatRoom(env).fetch("https://room/chat/guest/check?token=" + encodeURIComponent(token));
  if (!r.ok) return null;
  const j = await r.json();
  return j.ok ? { id: j.id, name: j.name, tag: j.tag } : null;
}

/**
 * Minecraft の WebSocket を、部屋（Durable Object）に渡す。
 * WebSocket の圧縮（permessage-deflate）は wrangler.toml の compatibility_flags で切ってある。
 * Minecraft が圧縮を求めてきたかは DO からは見えないので、記録用に ext に入れて渡す。
 */
function wsToRoom(stub, request, inner) {
  const ext = request.headers.get("Sec-WebSocket-Extensions") || "";
  if (ext) inner.searchParams.set("ext", ext.slice(0, 120));
  // 近接VC コネクター（PC で動く中継アプリ）や、近接VC リレー（Google Cloud の VM・Railway など）からの接続か
  const connector = request.headers.get("X-VC-Connector") || "";
  const relay = request.headers.get("X-VC-Relay") || "";
  const via = connector ? connector : relay ? "relay:" + relay : "";
  if (via) inner.searchParams.set("via", via.replace(/[^\w.:-]/g, "").slice(0, 24));
  return stub.fetch(new Request(inner, request));
}

function sameKey(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// パスワード（入室の印）が必要な API
const ADMIN_API = new Set(["/api/setup/status", "/api/setup", "/api/setup/relay", "/api/setup/relay/test", "/api/setup/vps", "/api/admin/chat", "/api/admin/news", "/api/admin/works", "/api/admin/home", "/api/admin/shop"]);

// 設定ボタンの連打よけ（3秒）
async function recentlyTried(env) {
  const s = await loadStored(env);
  return !!(s.triedAt && Date.now() - s.triedAt < 3000);
}
async function markTried(env) {
  await saveStored(env, { triedAt: Date.now() });
}

/** www.<ドメイン> → www なし（SITE_URL・HOME_HOST・KAMEN_HOST のドメイン。GET・HEAD のページだけ。なければ null） */
function wwwRedirect(request, url, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return null;
  const mains = [];
  try { const m = new URL(String(env.SITE_URL || "").trim()); if (m.protocol === "https:") mains.push(m.hostname.toLowerCase()); } catch (e) { /* なし */ }
  for (const h of [env.HOME_HOST, env.KAMEN_HOST]) if (h && String(h).trim()) mains.push(String(h).trim().toLowerCase());
  const host = url.hostname.toLowerCase();
  const to = mains.find(m => host === "www." + m);
  if (!to) return null;
  return new Response(null, { status: 301, headers: { Location: "https://" + to + url.pathname + url.search, "Cache-Control": "public, max-age=3600" } });
}

/**
 * どのサイトか（ホスト名で決める）
 *   "home"  … HOME_HOST（m-ayosaba.com）… まよ鯖のホーム（public/_home/）
 *   "kamen" … KAMEN_HOST（kamen.m-ayosaba.com）… かめん部（public/_kamen/）
 *   "tool"  … それ以外ぜんぶ（tool.m-ayosaba.com・workers.dev・VPS）… このツール
 */
export function siteOfHost(host, env) {
  const h = String(host || "").toLowerCase();
  const home = String(env.HOME_HOST || "").trim().toLowerCase();
  const kamen = String(env.KAMEN_HOST || "").trim().toLowerCase();
  if (home && h === home) return "home";
  if (kamen && h === kamen) return "kamen";
  return "tool";
}

// ---- まよ鯖の Discord の人数（招待リンクから読む）----
//   ・3 分ごとに Discord に聞きに行く（それまではおぼえている数を返す）
//   ・読めた数は設定の部屋（Durable Object）にも残す → Discord に聞けないときも「最後に読めた本当の数」を出す
//   ・招待コードは /setup/ で変えられる（なければ wrangler.toml の HOME_DISCORD_INVITE）
const HOME_CHECK_MS = 3 * 60000;
let homeMem = null;
/** 招待リンク・コード → コード（だめなら ""） */
export function cleanInvite(v) {
  const t = String(v || "").trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?(discord\.gg|discord(app)?\.com\/invite)\//i, "").replace(/[/?#].*$/, "");
  return /^[A-Za-z0-9-]{2,32}$/.test(t) ? t : "";
}
async function homeSaved(env) {
  try { return (await (await newsRoom(env).fetch("https://room/home/get")).json()) || {}; } catch (e) { return {}; }
}
async function homeSave(env, patch) {
  await newsRoom(env).fetch("https://room/home/put", { method: "POST", body: JSON.stringify(patch) }).catch(() => null);
}
/** いまの人数（force: おぼえている数を使わず、すぐ聞きに行く） */
async function homeStats(env, force = false) {
  const now = Date.now();
  if (!force && homeMem && now - homeMem.checkedAt < HOME_CHECK_MS) return homeMem;
  const saved = await homeSaved(env);
  const invite = cleanInvite(saved.invite) || cleanInvite(env.HOME_DISCORD_INVITE);
  const last = saved.last && saved.last.invite === invite ? saved.last : null;
  const st = { invite, members: last ? last.members : null, online: last ? last.online : null, at: last ? last.at : null, live: false, error: null, checkedAt: now, expiresAt: saved.expiresAt || null };
  if (!invite) st.error = "noinvite";
  else {
    try {
      const api = String(env.DISCORD_API || "https://discord.com/api/v10").replace(/\/$/, "");
      const r = await fetch(`${api}/invites/${invite}?with_counts=true&with_expiration=true`, { headers: { "User-Agent": "DiscordBot (https://m-ayosaba.com, 1.0)", Accept: "application/json" } });
      if (r.status === 404) st.error = "invite";            // 招待リンクが切れている・まちがっている
      else if (r.status === 429) st.error = "ratelimit";    // Discord に聞きすぎ（しばらく前の数を出す）
      else if (!r.ok) st.error = "http" + r.status;
      else {
        const j = await r.json();
        const members = Number(j.approximate_member_count), online = Number(j.approximate_presence_count);
        if (!Number.isFinite(members) || members <= 0) st.error = "nocount";
        else {
          Object.assign(st, { members, online: Number.isFinite(online) ? online : null, at: now, live: true, expiresAt: j.expires_at || null });
          await homeSave(env, { last: { invite, members: st.members, online: st.online, at: now }, expiresAt: st.expiresAt, lastError: null, lastErrorAt: null });
        }
      }
    } catch (e) {
      st.error = "network";
    }
    if (st.error) await homeSave(env, { lastError: st.error, lastErrorAt: now });
  }
  homeMem = st;
  return st;
}
const HOME_ERROR_TEXT = {
  noinvite: "招待コードが入っていません。",
  invite: "招待リンクが切れているか、まちがっています。「期限なし」の招待リンクを作って入れ直してください。",
  ratelimit: "Discord に聞きすぎたので、少し待っています（最後に読めた数を出しています）。",
  network: "Discord につながりませんでした（最後に読めた数を出しています）。",
  nocount: "Discord が人数を返しませんでした。",
};

export default {
  async fetch(request, env, ctx) {
    env = withSetupKey(env);   // SETUP_KEY が未登録なら、あらかじめ決めたパスワードを使う
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // www.<サイトのドメイン> でひらいたら、www なしへ（ページを見るときだけ。WebSocket・API はそのまま）
    const toMain = wwwRedirect(request, url, env);
    if (toMain) return toMain;

    // ---- トップ（/）: m-ayosaba.com はまよ鯖のホーム、kamen.m-ayosaba.com はかめん部、ほかはこのツール ----
    //      ページの画像などは /_home/〜・/_kamen/〜 にあるので、ここを通らずにそのまま返る
    if (path === "/" && (request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
      const site = siteOfHost(url.hostname, env);
      if (site === "tool") return env.ASSETS.fetch(request);
      return env.ASSETS.fetch(new Request(url.origin + (site === "home" ? "/_home/" : "/_kamen/"), { method: request.method, headers: request.headers }));
    }
    // ---- 制作依頼のページ（m-ayosaba.com/shop/〜 → public/_home/shop/〜）----
    if (/^\/shop(?:\.html|\/.*)?$/.test(url.pathname) && (request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
      const home = String(env.HOME_HOST || "").trim().toLowerCase();
      const to = loc => new Response(null, { status: 301, headers: { Location: loc, "Cache-Control": "public, max-age=3600" } });
      const clean = url.pathname === "/shop" || url.pathname === "/shop.html" ? "/shop/" : url.pathname;
      if (home && siteOfHost(url.hostname, env) !== "home") return to(`https://${home}${clean}${url.search}`);   // ツールのアドレスでひらいたら、まよ鯖.COM へ
      if (clean !== url.pathname) return to(clean + url.search);
      if (!clean.endsWith("/") && !/\.[A-Za-z0-9]{1,5}$/.test(clean)) return to(clean + "/" + url.search);
      const res = await env.ASSETS.fetch(new Request(url.origin + "/_home" + clean + url.search, { method: request.method, headers: request.headers }));
      if (res.status >= 300 && res.status < 400) return new Response("Not Found", { status: 404 });
      return res;
    }

    // まよ鯖の Discord の人数と招待コード（ホームに出す）
    if (path === "/api/home/discord") {
      const st = await homeStats(env);
      const body = { ok: st.members > 0, members: st.members, online: st.online, at: st.at, live: st.live, invite: st.invite || null, now: Date.now() };
      return cors(new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": st.live ? "public, max-age=60" : "no-store" } }));
    }

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (path === "/health") {
      return new Response("近接VC Bot は動いています（制作: MaYo / mayo01297）", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // ---- 管理者用の設定ページ（/setup/）のパスワードロック ----
    // 設定ページの本体は public/_admin/setup/ にあり、ここを通らないと外からは見られない（パスワードが合った人にだけ返す）
    if (path === "/_admin" || path.startsWith("/_admin/") || (path.startsWith("/setup/") && path !== "/setup")) {
      return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (path === "/setup") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      const pageHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
      if (!isSet(env.SETUP_KEY)) return new Response(gatePage({ keyMissing: true }), { status: 200, headers: pageHeaders });
      if (!(await isSetupAuthed(request, env))) return new Response(gatePage(), { status: 200, headers: pageHeaders });
      const inner = env.ASSETS ? await env.ASSETS.fetch(new Request(url.origin + "/_admin/setup/", { method: "GET" })) : null;
      if (!inner || !inner.ok) return new Response("Not Found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : inner.body, { status: 200, headers: pageHeaders });
    }
    // パスワードを確かめる（合えば 12 時間の入室の印を渡す）。総当たりよけ: 同じ IP から 1 時間に 10 回まで
    if (path === "/api/setup/auth" && request.method === "POST") {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (!isSet(env.SETUP_KEY)) return new Response(JSON.stringify({ ok: false, error: "このサーバーには SETUP_KEY が登録されていません。" }), { status: 503, headers: noStore });
      if (!await underRate(env, "setupauth" + await ipKeyOf(request), 10))
        return new Response(JSON.stringify({ ok: false, error: "何回もまちがえました。1 時間ほど待ってから、もう一度入れてください。" }), { status: 429, headers: noStore });
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (!(await sameHash(String(body.key || "").trim(), String(env.SETUP_KEY).trim())))
        return new Response(JSON.stringify({ ok: false, error: "パスワードがちがいます。" }), { status: 403, headers: noStore });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...noStore, "Set-Cookie": await sessionCookie(request, env) } });
    }
    // 設定のための API は、入室の印がないと何も返さない（設定の中身・Bot の様子・トークンの確認など）
    const adminAuthed = ADMIN_API.has(path) ? await isSetupAuthed(request, env) : false;
    if (ADMIN_API.has(path) && !adminAuthed)
      return new Response(JSON.stringify({ ok: false, needAuth: true, error: "ログインが必要です。/setup/ でパスワードを入れてください。" }), { status: 401, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    // ---- 設定ページ（/setup/）から ----
    if (path === "/api/setup/status") {
      const origin = url.origin;
      let st = await setupStatus(env, origin);
      // Cloudflare のシークレット DISCORD_TOKEN があって、まだ Discord に登録していなければ、自動で設定する
      if (isSet(env.DISCORD_TOKEN) && !st.setupOk && !(await recentlyTried(env))) {
        await markTried(env);
        await runSetup(env, { token: "", origin });
        st = await setupStatus(env, origin);
      }
      // パスワードはもう入れてある（入室の印がある）ので、フォームで「設定用のキー」をもう一度聞かない
      return json({ ...st, needSetupKey: false });
    }
    if (path === "/api/setup" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      await markTried(env);
      // VPS で公開しているとき: インストールのときに出た「設定用のキー」がないと設定できない（知らない人に先に設定されないように）
      if (isSet(env.SETUP_KEY) && !adminAuthed && !sameKey(String(body.setupKey || "").trim(), env.SETUP_KEY.trim()))
        return json({ ok: false, needSetupKey: true, error: "設定用のキーがちがいます（VPS にインストールしたときに表示されたキーを入れてください）。" }, 403);
      const r = await runSetup(env, { token: String(body.token || ""), origin: url.origin });
      return json(r, r.ok ? 200 : 400);
    }
    // リレー（中継サーバー）のアドレスを保存（Bot のトークンで本人か確かめる）→ そのまま、つながるかためす
    if (path === "/api/setup/relay" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      await markTried(env);
      const r = await saveRelay(env, { token: String(body.token || ""), relay: String(body.relay || "") });
      if (r.ok && r.relay) r.test = await testRelay(r.relay, url.host);
      return json(r, r.ok ? 200 : 400);
    }
    // 保存してあるリレーがつながるか、ためすだけ（アドレスは入力させない）
    if (path === "/api/setup/relay/test" && request.method === "POST") {
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      await markTried(env);
      const e = await resolveEnv(env, { fresh: true });
      if (!e.RELAY_HOST) return json({ ok: false, error: "リレーのアドレスが保存されていません。" }, 400);
      return json(await testRelay(e.RELAY_HOST, url.host));
    }

    // VPS（ConoHa など）に貼るコマンド（リレー＋音声中継）。Bot のトークンで確かめる
    if (path === "/api/setup/vps" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      await markTried(env);
      const r = await vpsCommand(env, { token: String(body.token || ""), origin: url.origin, host: url.host });
      return json(r, r.ok ? 200 : 400);
    }

    // ---- お知らせ（ホームに出す） ----
    if (path === "/api/news") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      const now = Date.now();
      // site=home … まよ鯖のホーム（m-ayosaba.com）のお知らせ。ないとき・ほかの値はツールのお知らせ
      const site = url.searchParams.get("site") === "home" ? "home" : "tool";
      let c = newsCaches.get(site);
      if (!c || now - c.at > NEWS_CACHE_MS) {
        try {
          const j = await (await newsRoom(env).fetch("https://room/news/list?site=" + site)).json();
          c = { items: Array.isArray(j.items) ? j.items : [], at: now };
          newsCaches.set(site, c);
        } catch (e) {
          if (!c) return cors(json({ ok: false, error: "お知らせを読みこめませんでした。" }, 503));
        }
      }
      return cors(new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, now, site, items: c.items }), {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=15" } }));
    }
    // お知らせを書く・直す・消す（ログインした管理者だけ。上の ADMIN_API で確認ずみ）
    if (path === "/api/admin/news" && request.method === "POST") {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      // フォームからの送信（ほかのサイトからのなりすまし）を受け付けない
      if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || ""))
        return new Response(JSON.stringify({ ok: false, error: "JSON で送ってください。" }), { status: 415, headers: noStore });
      const text = await request.text();
      if (text.length > 20000) return new Response(JSON.stringify({ ok: false, error: "長すぎます。" }), { status: 413, headers: noStore });
      const r = await newsRoom(env).fetch("https://room/news/op", { method: "POST", body: text });
      newsCaches.clear();   // このサーバーでは、すぐ新しい内容を出す（ほかの場所のサーバーも 15 秒以内に変わる）
      return new Response(r.body, { status: r.status, headers: noStore });
    }

    // ---- 制作依頼（だれでも。合言葉は URL の # のあと → ページから JSON で送ってもらう）----
    const shopApi = /^\/api\/shop\/(new|view|post|cancel)$/.exec(path);
    if (shopApi) {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: noStore });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return out({ ok: false, error: "JSON で送ってください。" }, 415);
      const text = await request.text();
      if (text.length > 12000) return out({ ok: false, error: "長すぎます。" }, 413);
      let b = {};
      try { b = JSON.parse(text) || {}; } catch (e) { return out({ ok: false, error: "JSON が読めません。" }, 400); }
      const act = shopApi[1];
      const shopFetch = async body => {
        const r = await newsRoom(env).fetch("https://room/shop/op", { method: "POST", body: JSON.stringify(body) });
        return { status: r.status, j: await r.json() };
      };
      const strip = j => { const { _webhook, _item, status, ...rest } = j; return rest; };
      if (act === "new") {
        if (String(b.website || "").trim()) return out({ ok: false, error: "送れませんでした。" }, 400);   // ロボットよけ（見えない入力欄）
        if (!await underRate(env, "shopnew" + await ipKeyOf(request), 3))
          return out({ ok: false, error: "続けて依頼しすぎです。1 時間ほど待ってからにしてください。" }, 429);
        const key = newKey();
        const { status, j } = await shopFetch({ action: "create", keyHash: await sha256hex("shop:" + key), item: b });
        if (j.ok && j._webhook) ctx.waitUntil(notifyWebhook(j._webhook, { kind: "new", item: j._item }));
        return out(j.ok ? { ...strip(j), key } : strip(j), status);
      }
      const key = String(b.key || "");
      if (!/^[A-Za-z0-9]{20,40}$/.test(key) || !/^[a-z0-9]{8}$/.test(String(b.id || ""))) return out({ ok: false, error: "依頼が見つかりません（URL をもう一度確かめてください）。" }, 404);
      if (act === "post" && !await underRate(env, "shopmsg" + b.id, 30)) return out({ ok: false, error: "メッセージを送りすぎです。少し待ってください。" }, 429);
      const { status, j } = await shopFetch({ action: act, id: b.id, keyHash: await sha256hex("shop:" + key), text: b.text });
      if (j.ok && act === "post" && j._webhook) ctx.waitUntil(notifyWebhook(j._webhook, { kind: "message", item: j._item, text: String(b.text || "") }));
      return out(strip(j), status);
    }
    // 制作依頼の管理（ログインした管理者だけ。上の ADMIN_API で確認ずみ）
    if (path === "/api/admin/shop" && request.method === "POST") {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || ""))
        return new Response(JSON.stringify({ ok: false, error: "JSON で送ってください。" }), { status: 415, headers: noStore });
      const text = await request.text();
      if (text.length > 12000) return new Response(JSON.stringify({ ok: false, error: "長すぎます。" }), { status: 413, headers: noStore });
      let b = {};
      try { b = JSON.parse(text) || {}; } catch (e) { b = {}; }
      const r = await newsRoom(env).fetch("https://room/shop/op", { method: "POST", body: JSON.stringify({ ...b, admin: true }) });
      const { _webhook, _item, status, ...j } = await r.json();
      return new Response(JSON.stringify(j), { status: r.status, headers: noStore });
    }

    // まよ鯖ホームの人数（招待コードを変える・いまの様子を見る。ログインした管理者だけ）
    if (path === "/api/admin/home") {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (request.method === "POST") {
        if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || ""))
          return new Response(JSON.stringify({ ok: false, error: "JSON で送ってください。" }), { status: 415, headers: noStore });
        let b = {};
        try { b = await request.json(); } catch (e) { b = {}; }
        const raw = String(b.invite || "").trim();
        const code = cleanInvite(raw);
        if (raw && !code) return new Response(JSON.stringify({ ok: false, error: "招待リンクの形がちがいます（例: https://discord.gg/abcd1234）。" }), { status: 400, headers: noStore });
        await homeSave(env, { invite: code || null });
      } else if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
      const st = await homeStats(env, true);
      const saved = await homeSaved(env);
      return new Response(JSON.stringify({
        ok: true, invite: st.invite || "", fromSetup: !!cleanInvite(saved.invite), envInvite: cleanInvite(env.HOME_DISCORD_INVITE),
        members: st.members, online: st.online, at: st.at, live: st.live, expiresAt: st.expiresAt,
        error: st.error, errorText: st.error ? (HOME_ERROR_TEXT[st.error] || `Discord がエラーを返しました（${st.error}）。`) : "",
      }), { status: 200, headers: noStore });
    }

    // ---- 作品の紹介 ----
    if (path === "/api/works") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      const now = Date.now();
      if (!worksCache || now - worksCacheAt > NEWS_CACHE_MS) {
        try {
          const j = await (await newsRoom(env).fetch("https://room/works/list")).json();
          worksCache = Array.isArray(j.items) ? j.items : []; worksCacheAt = now;
        } catch (e) {
          if (!worksCache) return cors(json({ ok: false, error: "作品を読みこめませんでした。" }, 503));
        }
      }
      return cors(new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, now, items: worksCache }), {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=15" } }));
    }
    const workImg = /^\/api\/works\/img\/([a-z0-9]{10})$/.exec(path);
    if (workImg && (request.method === "GET" || request.method === "HEAD")) {
      const r = await newsRoom(env).fetch("https://room/works/img?id=" + workImg[1]);
      if (!r.ok) return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
      // URL に ?v=（画像を変えた時刻）が付いているので、長く覚えておいてよい
      return new Response(request.method === "HEAD" ? null : r.body, { status: 200, headers: {
        "Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
        "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
    }
    // 作品を書く・直す・消す（ログインした管理者だけ。上の ADMIN_API で確認ずみ）
    if (path === "/api/admin/works" && request.method === "POST") {
      const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || ""))
        return new Response(JSON.stringify({ ok: false, error: "JSON で送ってください。" }), { status: 415, headers: noStore });
      const text = await request.text();
      if (text.length > 1000000) return new Response(JSON.stringify({ ok: false, error: "大きすぎます（画像を小さくしてください）。" }), { status: 413, headers: noStore });
      const r = await newsRoom(env).fetch("https://room/works/op", { method: "POST", body: text });
      worksCache = null;
      return new Response(r.body, { status: r.status, headers: noStore });
    }

    // ---- サイト内の近接VC ----
    if (path === "/api/web/rooms" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      // いたずら防止: 同じ IP から 1 時間に 5 部屋まで（IP そのものは保存しない）
      const ipKey = await ipKeyOf(request);
      const rate = await (await directory(env).fetch("https://room/dir/rate", { method: "POST", body: JSON.stringify({ k: ipKey, max: 5 }) })).json();
      if (!rate.ok) return json({ ok: false, error: "部屋を作りすぎです。1 時間ほど待ってから作ってください。" }, 429);
      const name = String(body.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
      const hostKey = randomText(24, HOST_ABC);
      const made = await createWebRoom(env, { name, hostKey });
      if (!made) return json({ ok: false, error: "部屋を作れませんでした。もう一度ためしてください。" }, 500);
      return json({ ok: true, roomId: made.roomId, hostKey });
    }
    if (path === "/api/web/room") {
      const id = webRoomId(url.searchParams.get("r"));
      if (!id) return json({ ok: false, error: "部屋番号は 6 けたの数字です" }, 400);
      // 番号をかたっぱしからためされないように: 同じ IP から 1 時間に 60 回まで
      if (!await underRate(env, "look" + await ipKeyOf(request), 60))
        return json({ ok: false, error: "部屋番号を何回もためしすぎです。1 時間ほど待ってください。" }, 429);
      const stub = await webRoomByCode(env, id);
      if (!stub) return json({ ok: false, error: "部屋が見つかりません" }, 404);
      return stub.fetch("https://room/web/info");
    }
    if (path === "/api/web/host" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const id = webRoomId(body.r);
      if (!id) return json({ ok: false, error: "部屋の番号の形がちがいます" }, 400);
      const stub = await webRoomByCode(env, id);
      if (!stub) return json({ ok: false, error: "部屋が見つかりません" }, 404);
      const r = await stub.fetch("https://room/web/host", { method: "POST", body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok && j.worldCode) {
        const e = await resolveEnv(env);
        j.relay = e.RELAY_HOST || "";
        j.relayCommand = e.RELAY_HOST ? `/wsserver ws://${e.RELAY_HOST}/v/${j.worldCode}` : "";
        j.newCommand = e.RELAY_HOST ? `/wsserver ws://${e.RELAY_HOST}/new` : "";
        j.connectorCommand = `/wsserver ws://${url.host}/v/${j.worldCode}`;
        j.checkUrl = `${url.origin}/v/${j.worldCode}`;
      }
      return json(j, r.status);
    }
    if (path === "/api/web/socket") {
      const id = webRoomId(url.searchParams.get("r"));
      if (!id) return new Response("部屋の番号の形がちがいます", { status: 400 });
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("WebSocket でつないでください", { status: 426 });
      if (!await underRate(env, "sock" + await ipKeyOf(request), 300)) return new Response("つなぎ直しが多すぎます", { status: 429 });
      // ゲスト（名前#1234）を確かめてから、部屋に渡す
      const guest = await guestOf(env, url.searchParams.get("g"));
      const inner = new Request("https://room/web/socket", request);
      const headers = new Headers(inner.headers);
      headers.delete("X-Guest");
      if (guest) headers.set("X-Guest", JSON.stringify(guest));
      const stub = await webRoomByCode(env, id);
      if (!stub) return new Response("部屋が見つかりません", { status: 404 });
      return stub.fetch(new Request(inner, { headers }));
    }

    // ---- ゲストとチャット ----
    if (path === "/api/guest" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const ipKey = await ipKeyOf(request);
      // いたずら防止: 同じ IP から 1 時間に 10 人まで
      const rate = await (await directory(env).fetch("https://room/dir/rate", { method: "POST", body: JSON.stringify({ k: "g" + ipKey, max: 10 }) })).json();
      if (!rate.ok) return json({ ok: false, error: "名前を作りすぎです。1 時間ほど待ってください。" }, 429);
      return chatRoom(env).fetch("https://room/chat/guest/new", { method: "POST", body: JSON.stringify({ name: body.name, ipKey }) });
    }
    if (path === "/api/guest/me") {
      return chatRoom(env).fetch("https://room/chat/guest/check?token=" + encodeURIComponent(url.searchParams.get("token") || ""));
    }
    if (path === "/api/chat/socket") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("WebSocket でつないでください", { status: 426 });
      const inner = new URL("https://room/chat/socket");
      inner.searchParams.set("token", url.searchParams.get("token") || "");
      inner.searchParams.set("ip", await ipKeyOf(request));
      return chatRoom(env).fetch(new Request(inner, request));
    }
    // チャットの管理（サイトの管理者だけ。Bot のトークンで確かめる）
    if (path === "/api/admin/chat" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      const err = await checkAdminToken(env, body.token);
      if (err) { await markTried(env); return json({ ok: false, error: err }, 403); }
      return chatRoom(env).fetch("https://room/chat/admin", { method: "POST", body: JSON.stringify({ action: body.action, id: body.id, ids: body.ids, hours: body.hours }) });
    }

    // ---- Discord ----
    if (path === "/interactions" && request.method === "POST") {
      const body = await request.text();
      const sig = request.headers.get("X-Signature-Ed25519"), ts = request.headers.get("X-Signature-Timestamp");
      let e = await resolveEnv(env);
      let ok = !!e.DISCORD_PUBLIC_KEY && await verifyDiscordRequest(e.DISCORD_PUBLIC_KEY, sig, ts, body);
      if (!ok) {
        // 設定した直後は、古い設定を覚えていることがあるので読み直す
        const f = await resolveEnv(env, { fresh: true });
        if (f.DISCORD_PUBLIC_KEY && f.DISCORD_PUBLIC_KEY !== e.DISCORD_PUBLIC_KEY) ok = await verifyDiscordRequest(f.DISCORD_PUBLIC_KEY, sig, ts, body);
      }
      if (!ok) return new Response("invalid request signature", { status: 401 });
      const it = JSON.parse(body);
      if (it.type === 1) return json({ type: 1 }); // PING
      if (it.type === 4) {
        // /vc link の名前の候補（3秒以内に返す）
        if (!it.guild_id) return json({ type: 8, data: { choices: [] } });
        try {
          return await room(env, it.guild_id).fetch("https://room/autocomplete", { method: "POST", body });
        } catch (e) {
          return json({ type: 8, data: { choices: [] } });
        }
      }
      if (it.type === 2) {
        if (!it.guild_id) return json({ type: 4, data: { content: "Discord サーバーの中で使ってください。", flags: 64 } });
        // 「考え中…」で先に返事をして、実際の処理は Durable Object で（3秒の制限があるため）
        ctx.waitUntil(room(env, it.guild_id).fetch("https://room/interaction?origin=" + encodeURIComponent(url.origin), { method: "POST", body }));
        return json({ type: 5, data: { flags: 64 } });
      }
      return json({ type: 4, data: { content: "このボタンには対応していません。", flags: 64 } });
    }

    // ---- マイクラで部屋を作る: /wsserver ws://<リレー>/new ----
    //      新しい部屋を作って、そのまま部屋につなぐ。部屋番号はゲームのチャットに出る
    if (path === "/new" || /^\/(?:v|vc)\/new$/i.test(path)) {
      const isWs = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
      if (!isWs) return Response.redirect(`${url.origin}/talk/`, 302);
      // リレーから来たときは、リレーが教えてくれる Minecraft の IP で数える
      const relayed = !!request.headers.get("X-VC-Relay");
      const client = relayed ? String(request.headers.get("X-VC-Client") || "").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45) : "";
      const ipKey = client ? (await sha256hex("vc:" + client)).slice(0, 16) : await ipKeyOf(request);
      if (!await underRate(env, "mcnew" + ipKey, 10) || !await underRate(env, "mcnew-all", 600)) {
        console.log(JSON.stringify({ ev: "mc_new_limited" }));
        return new Response("部屋を作りすぎです。1 時間ほど待ってください", { status: 429 });
      }
      const adminKey = randomText(8, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
      const made = await createWebRoom(env, { name: "マイクラの部屋", hostKey: adminKey, fromGame: true, showKey: adminKey });
      if (!made) return new Response("部屋を作れませんでした", { status: 500 });
      const inner = new URL("https://room/ws");
      inner.searchParams.set("code", made.worldCode);
      inner.searchParams.set("scheme", url.protocol.replace(":", ""));
      return wsToRoom(webRoom(env, made.uid), request, inner);
    }

    // ---- ワールド用: 短い接続コード（/wsserver ws://…/v/ABCD2345） ----
    //      正式は /v/<コード>。打ちまちがいの /vc/<コード>・/connect/<コード> も同じあつかい
    //      ブラウザでひらくと「接続チェック」のページになる
    // /vc/discord/ のようなページは、接続コード（8 文字）ではないのでサイトのファイルへ
    const codePath = CODE_PATH_RE.exec(path);
    const looksLikeCode = codePath && ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket" || /^[A-Za-z0-9]{8}$/.test(codePath[1]));
    if (looksLikeCode) {
      let code = "";
      try { code = decodeURIComponent(codePath[1]).replace(/["'\s]/g, "").toUpperCase(); } catch (e) { code = ""; }
      const isWs = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
      const wantJson = url.searchParams.has("json");
      const ua = request.headers.get("User-Agent") || "";
      const isBrowser = /Mozilla\//.test(ua) && !isWs;
      const scheme = url.protocol.replace(":", "");
      const dir = CODE_RE.test(code)
        ? await (await env.GUILD.get(env.GUILD.idFromName("__directory__")).fetch("https://room/dir/get?code=" + code)).json()
        : { guildId: null };
      if (!dir.guildId) {
        // コードそのものはログに出さない（長さと形だけ）
        if (isWs) console.log(JSON.stringify({ ev: "mc_badcode", scheme, len: code.length, format: CODE_RE.test(code) }));
        if (wantJson) return json({ ok: false }, 404);
        if (isBrowser) return html(badCodePage(), 404);
        return new Response("接続コードがちがいます（/vc key で確認してください）", { status: 404 });
      }
      const g = room(env, dir.guildId);
      if (isWs) {
        const inner = new URL("https://room/ws");
        inner.searchParams.set("code", code);
        inner.searchParams.set("scheme", scheme);
        return wsToRoom(g, request, inner);
      }
      if (wantJson) {
        const r = await g.fetch("https://room/diag?code=" + code);
        return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (isBrowser) return html(checkPage({ host: url.host, code, relay: (await resolveEnv(env)).RELAY_HOST }));
      // ブラウザでも WebSocket でもない（とちゅうで Upgrade が消された Minecraft の接続など）→ 記録しておく
      ctx.waitUntil(g.fetch("https://room/diag?code=" + code, { method: "POST", body: JSON.stringify({ scheme }) }).catch(() => {}));
      return new Response("Minecraft のチャットで /wsserver を使ってつないでください", { status: 426 });
    }

    // ---- ワールド用: Minecraft の /wsserver（接続キーそのまま） ----
    if (path.startsWith("/ws/")) {
      const k = parseKey(decodeURIComponent(path.slice(4)));
      if (!k) return new Response("接続キーがちがいます", { status: 404 });
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("Minecraft のチャットで /wsserver を使ってつないでください", { status: 426 });
      const inner = new URL("https://room/ws");
      inner.searchParams.set("secret", k.secret);
      inner.searchParams.set("scheme", url.protocol.replace(":", ""));
      return wsToRoom(room(env, k.guildId), request, inner);
    }

    // ---- BDS 用 ----
    if (path === "/api/update" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return cors(json({ ok: false, error: "bad json" }, 400)); }
      const k = parseKey(body && body.key);
      if (!k) return cors(json({ ok: false, error: "接続キーがちがいます" }, 403));
      const res = await room(env, k.guildId).fetch("https://room/update", { method: "POST", body: JSON.stringify(body) });
      return cors(res);
    }

    // ---- サイトから確認 ----
    if (path === "/api/check") {
      const k = parseKey(url.searchParams.get("key"));
      if (!k) return cors(json({ ok: false, error: "接続キーの形がちがいます" }, 400));
      const res = await room(env, k.guildId).fetch("https://room/check?secret=" + encodeURIComponent(k.secret));
      return cors(res);
    }

    if (path === "/api/info") {
      const e = await resolveEnv(env);
      return cors(json({ ok: true, configured: e.CONFIGURED && e.SETUP_OK, appId: e.DISCORD_APP_ID || null, appName: e.APP_NAME || "", invite: inviteUrl(e.DISCORD_APP_ID), relay: e.RELAY_HOST || "" }));
    }

    // WebSocket なのに、どのURLにも当てはまらない（コマンドのURLのまちがい）
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      console.log(JSON.stringify({ ev: "mc_badpath", path: path.slice(0, 40) }));
      return new Response("URL がちがいます。Discord の /vc key で出た /wsserver コマンドを、そのまま送ってください", { status: 404 });
    }
    // それ以外はサイトのファイル（なければ 404 ページ）
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },
};
