// =====================================================================
//  近接VC Bot（入口）… サイト（public/）と同じ Worker で動く
//  - /api/setup    … 設定ページ（/setup/）から、Bot のトークンを登録する
//  - /interactions … Discord のスラッシュコマンド
//  - /v/<接続コード> … ワールド用（ホストが /wsserver でつなぐ。ブラウザでひらくと接続チェック）
//  - /ws/<接続キー> … ワールド用（接続キーそのままでつなぐとき）
//  - /api/update   … BDS 用（アドオンが位置のグループを送ってくる）
//  - /api/check    … サイトから接続キーを確認する
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { GuildRoom, CODE_RE } from "./guild.js";
import { verifyDiscordRequest } from "./discord.js";
import { resolveEnv, runSetup, setupStatus, isSet, loadStored, saveStored, inviteUrl } from "./appconfig.js";
import { checkPage, badCodePage } from "./checkpage.js";

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

/**
 * Minecraft の WebSocket を、部屋（Durable Object）に渡す。
 * WebSocket の圧縮（permessage-deflate）は wrangler.toml の compatibility_flags で切ってある。
 * Minecraft が圧縮を求めてきたかは DO からは見えないので、記録用に ext に入れて渡す。
 */
function wsToRoom(stub, request, inner) {
  const ext = request.headers.get("Sec-WebSocket-Extensions") || "";
  if (ext) inner.searchParams.set("ext", ext.slice(0, 120));
  return stub.fetch(new Request(inner, request));
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

    if (path === "/" || path === "/health") {
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
      const r = await runSetup(env, { token: String(body.token || ""), origin: url.origin });
      return json(r, r.ok ? 200 : 400);
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

    // ---- ワールド用: 短い接続コード（/wsserver ws://…/v/ABCD2345） ----
    //      正式は /v/<コード>。打ちまちがいの /vc/<コード>・/connect/<コード> も同じあつかい
    //      ブラウザでひらくと「接続チェック」のページになる
    const codePath = CODE_PATH_RE.exec(path);
    if (codePath) {
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
      if (isBrowser) return html(checkPage({ host: url.host, code }));
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
      return cors(json({ ok: true, configured: e.CONFIGURED && e.SETUP_OK, appId: e.DISCORD_APP_ID || null, appName: e.APP_NAME || "", invite: inviteUrl(e.DISCORD_APP_ID) }));
    }

    // WebSocket なのに、どのURLにも当てはまらない（コマンドのURLのまちがい）
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      console.log(JSON.stringify({ ev: "mc_badpath", path: path.slice(0, 40) }));
      return new Response("URL がちがいます。/wsserver ws://<この Worker のURL>/v/<接続コード> の形で送ってください（Discord の /vc key で確認できます）", { status: 404 });
    }
    // それ以外はサイトのファイル（なければ 404 ページ）
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },
};
