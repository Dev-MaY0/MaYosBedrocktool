// =====================================================================
//  Bot の設定（トークン・アプリID・パブリックキー）
//  /setup/ のページでトークンを貼ると、ここに保存されて自動で設定されます。
//  （Cloudflare のシークレット DISCORD_TOKEN があれば、そちらを使います）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { COMMANDS } from "./commands.js";
import { INVITE_PERMISSIONS } from "./discord.js";

const CONFIG_ROOM = "__config__";
export const isSet = v => typeof v === "string" && v.trim() !== "" && !/ここに/.test(v);
const configStub = env => env.GUILD.get(env.GUILD.idFromName(CONFIG_ROOM));

let cache = null, cacheAt = 0;
export function clearEnvCache() { cache = null; }

export async function loadStored(env) {
  try { return await (await configStub(env).fetch("https://room/config/get")).json(); } catch (e) { return {}; }
}
export async function saveStored(env, patch) {
  await configStub(env).fetch("https://room/config/put", { method: "POST", body: JSON.stringify(patch) });
  clearEnvCache();
}

/**
 * 使う設定をまとめる。Cloudflare の変数（DISCORD_TOKEN など）があればそれを、なければ /setup/ で保存したものを使う。
 * 戻り値は env と同じように使える（DISCORD_TOKEN / DISCORD_APP_ID / DISCORD_PUBLIC_KEY / SITE_URL / CONFIGURED）
 */
export async function resolveEnv(env, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 30000) return cache;
  const s = await loadStored(env);
  const token = isSet(env.DISCORD_TOKEN) ? env.DISCORD_TOKEN : s.token || "";
  const appId = isSet(env.DISCORD_APP_ID) ? env.DISCORD_APP_ID : s.appId || "";
  const publicKey = isSet(env.DISCORD_PUBLIC_KEY) ? env.DISCORD_PUBLIC_KEY : s.publicKey || "";
  cache = {
    GUILD: env.GUILD,
    DISCORD_API: env.DISCORD_API,
    BDS_STALE_MS: env.BDS_STALE_MS,
    DISCORD_TOKEN: token,
    DISCORD_APP_ID: appId,
    DISCORD_PUBLIC_KEY: publicKey,
    SITE_URL: isSet(env.SITE_URL) ? env.SITE_URL : s.origin || "",
    APP_NAME: s.appName || "",
    TOKEN_FROM: isSet(env.DISCORD_TOKEN) ? "secret" : s.token ? "page" : "",
    SETUP_OK: !!s.setupOk,
    SETUP_ERROR: s.setupError || "",
    CONFIGURED: !!(token && appId && publicKey),
  };
  cacheAt = Date.now();
  return cache;
}

async function dfetch(env, method, path, token, body) {
  const api = (env.DISCORD_API || "https://discord.com/api/v10").replace(/\/$/, "");
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://github.com/Dev-MaY0, 1.0) PlayerCorpseVC" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

export const inviteUrl = appId =>
  appId ? `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands` : "";

/** 設定ページに出す様子 */
export async function setupStatus(env, origin) {
  const e = await resolveEnv(env, { fresh: true });
  return {
    ok: true,
    configured: e.CONFIGURED,
    setupOk: e.SETUP_OK,
    appName: e.APP_NAME,
    appId: e.DISCORD_APP_ID,
    invite: inviteUrl(e.DISCORD_APP_ID),
    tokenFrom: e.TOKEN_FROM,
    endpoint: `${origin}/interactions`,
    site: origin,
    error: e.SETUP_ERROR,
  };
}

/**
 * トークンを確かめて保存し、Discord に「Bot の URL」とスラッシュコマンドを登録する。
 * token が空なら、Cloudflare のシークレット DISCORD_TOKEN を使う。
 */
export async function runSetup(env, { token, origin }) {
  const steps = [];
  const fromSecret = !token && isSet(env.DISCORD_TOKEN);
  token = String(token || (fromSecret ? env.DISCORD_TOKEN : "")).trim().replace(/^Bot\s+/i, "");
  if (!token) return { ok: false, steps, error: "トークンを入れてください。" };

  // 1. トークンを確かめる
  const me = await dfetch(env, "GET", "/applications/@me", token);
  if (me.status === 401) return { ok: false, steps, error: "トークンがちがいます。Discord Developer Portal の「Bot」→「Reset Token」で出たものを貼ってください。" };
  if (!me.ok || !me.data || !me.data.id) return { ok: false, steps, error: `Discord から Bot の情報を取れませんでした（${me.status}）。少し待ってからもう一度ためしてください。` };
  const appId = String(me.data.id), publicKey = String(me.data.verify_key || ""), appName = String(me.data.name || "");

  // ほかの人が勝手に別の Bot に変えられないように（同じ Bot のトークンの入れ直しはOK）
  const stored = await loadStored(env);
  if (!fromSecret && stored.appId && stored.appId !== appId && stored.token) {
    const still = await dfetch(env, "GET", "/applications/@me", stored.token);
    if (still.ok) return { ok: false, steps, error: `もう別の Bot（${stored.appName || stored.appId}）で設定されています。変えたいときは、Cloudflare でこの Worker を作り直してください。` };
  }
  await saveStored(env, { token: fromSecret ? "" : token, appId, publicKey, appName, origin, setupOk: false, setupError: "" });
  steps.push({ id: "token", text: `Bot「${appName}」のトークンを確認しました` });

  // 2. Discord に Bot の URL を登録（Discord がここに確認のリクエストを送ってきます）
  let p = null;
  for (let i = 0; i < 3; i++) {
    p = await dfetch(env, "PATCH", "/applications/@me", token, { interactions_endpoint_url: `${origin}/interactions` });
    if (p.ok) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!p.ok) {
    const error = `Discord に Bot の URL を登録できませんでした（${p.status}）。数十秒待ってから、もう一度「設定する」を押してください。`;
    await saveStored(env, { setupError: error });
    return { ok: false, steps, error, detail: JSON.stringify(p.data).slice(0, 300) };
  }
  steps.push({ id: "endpoint", text: "Discord に Bot の URL を登録しました" });

  // 3. スラッシュコマンド
  const c = await dfetch(env, "PUT", `/applications/${appId}/commands`, token, COMMANDS);
  if (!c.ok) {
    const error = `スラッシュコマンド（/vc）を登録できませんでした（${c.status}）。`;
    await saveStored(env, { setupError: error });
    return { ok: false, steps, error };
  }
  steps.push({ id: "commands", text: "スラッシュコマンド（/vc …）を登録しました" });
  await saveStored(env, { setupOk: true, setupError: "", setupAt: Date.now() });
  return { ok: true, steps, appName, appId, invite: inviteUrl(appId) };
}
