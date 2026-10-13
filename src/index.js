// =====================================================================
//  近接VC Bot（入口）… サイト（public/）と同じ Worker で動く
//  - /api/setup    … 設定ページ（/setup/）から、Bot のトークンを登録する
//  - /api/setup/relay … 設定ページから、リレー（中継サーバー）のアドレスを保存する・ためす
//  - /interactions … Discord のスラッシュコマンド
//  - /v/<接続コード> … ワールド用（ホストが /wsserver でつなぐ。ブラウザでひらくと接続チェック）
//  - /ws/<接続キー> … ワールド用（接続キーそのままでつなぐとき）
//  - /api/update   … BDS 用（アドオンが位置のグループを送ってくる）
//  - /api/check    … サイトから接続キーを確認する
//  - /api/web/…    … サイト内の近接VC（部屋を作る・ブラウザの WebSocket・ホストの操作）
//  - /api/guest・/api/chat/… … ゲスト（名前#1234）と、みんなのチャット・DM
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { GuildRoom, CODE_RE } from "./guild.js";
import { verifyDiscordRequest } from "./discord.js";
import { resolveEnv, runSetup, setupStatus, isSet, loadStored, saveStored, inviteUrl, saveRelay, vpsCommand, checkAdminToken } from "./appconfig.js";
import { sha256hex } from "./webvc.js";
import { checkPage, badCodePage } from "./checkpage.js";
import { testRelay } from "./relaycheck.js";

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
/** 部屋を作る（番号は 100000〜999999 のどれか。使われていたら作り直す） */
async function createWebRoom(env, { name, hostKey, fromGame = false, showKey = "" }) {
  for (let i = 0; i < 8; i++) {
    const roomId = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const r = await webRoom(env, roomId).fetch("https://room/web/create", { method: "POST",
      body: JSON.stringify({ roomId, name, hostKeyHash: await sha256hex(hostKey), fromGame, showKey }) });
    if (r.status === 409) continue;
    const j = await r.json();
    return j.ok ? { roomId, worldCode: j.worldCode } : null;
  }
  return null;
}
/** いたずら防止の数え方（1 時間に max 回まで）。false なら上限 */
async function underRate(env, k, max) {
  const r = await directory(env).fetch("https://room/dir/rate", { method: "POST", body: JSON.stringify({ k, max }) });
  return !!(await r.json()).ok;
}
const webRoom = (env, id) => room(env, "web:" + id);
const chatRoom = env => room(env, "__chat__");

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

// 設定ボタンの連打よけ（3秒）
async function recentlyTried(env) {
  const s = await loadStored(env);
  return !!(s.triedAt && Date.now() - s.triedAt < 3000);
}
async function markTried(env) {
  await saveStored(env, { triedAt: Date.now() });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (path === "/health") {
      return new Response("近接VC Bot は動いています（制作: MaYo / mayo01297）", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

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
      return json(st);
    }
    if (path === "/api/setup" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      if (await recentlyTried(env)) return json({ ok: false, error: "少し待ってから、もう一度押してください。" }, 429);
      await markTried(env);
      // VPS で公開しているとき: インストールのときに出た「設定用のキー」がないと設定できない（知らない人に先に設定されないように）
      if (isSet(env.SETUP_KEY) && !sameKey(String(body.setupKey || "").trim(), env.SETUP_KEY.trim()))
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
      return webRoom(env, id).fetch("https://room/web/info");
    }
    if (path === "/api/web/host" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const id = webRoomId(body.r);
      if (!id) return json({ ok: false, error: "部屋の番号の形がちがいます" }, 400);
      const r = await webRoom(env, id).fetch("https://room/web/host", { method: "POST", body: JSON.stringify(body) });
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
      return webRoom(env, id).fetch(new Request(inner, { headers }));
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
      return wsToRoom(webRoom(env, made.roomId), request, inner);
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
