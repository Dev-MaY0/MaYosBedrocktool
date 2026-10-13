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
    // リレー（Google Cloud の VM・Railway など）のアドレス。Cloudflare の変数 RELAY_HOST があればそれを、なければ /setup/ で保存したものを使う
    RELAY_HOST: normalizeRelayHost(isSet(env.RELAY_HOST) ? env.RELAY_HOST : s.relayHost || "").host,
    RELAY_FROM: isSet(env.RELAY_HOST) ? "var" : s.relayHost ? "page" : "",
    // サイト内VC の音声中継（VPS の TURN）。Cloudflare のシークレット TURN_SECRET か、/setup/ で作ったもの
    TURN_SECRET: isSet(env.TURN_SECRET) ? env.TURN_SECRET.trim() : s.turnSecret || "",
    TURN_HOST: isSet(env.TURN_HOST) ? env.TURN_HOST.trim() : "",
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
    relay: e.RELAY_HOST,
    relayFrom: e.RELAY_FROM,
    relayError: isSet(env.RELAY_HOST) ? normalizeRelayHost(env.RELAY_HOST).error : "",
    turn: !!e.TURN_SECRET,
  };
}

// ---------------------------------------------------------------------
//  リレー（Minecraft の /wsserver を中継するサーバー）のアドレス
//  Minecraft の /wsserver は、返事の「Connection: Upgrade」が大文字でないとつながらない。
//  Cloudflare は必ず小文字（upgrade）で返すので、Google Cloud の VM や Railway に置いたリレーを通してつなぐ。
//  形: ホスト名 または ホスト名:ポート（ポート 80 は省略）
//    例: 34.82.1.2（VM の外部 IP）/ vc.example.com（独自ドメイン）/ shuttle.proxy.rlwy.net:15140（Railway の TCP Proxy）
// ---------------------------------------------------------------------
export function normalizeRelayHost(input) {
  let v = String(input || "").trim();
  if (!v || /ここに/.test(v)) return { host: "", error: "" };
  v = v.replace(/^\/?wsserver\s+/i, "");               // コマンドごと貼られたとき
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (scheme && !/^(ws|http)$/i.test(scheme[1]))
    return { host: "", error: "wss:// や https:// は使えません。リレーのアドレス（ホスト名:ポート）だけを入れてください。" };
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").toLowerCase();
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::(\d{1,5}))?$/.exec(v);
  if (!m || v.length > 200) return { host: "", error: "アドレスの形がちがいます。例: 34.82.1.2 ／ vc.example.com ／ shuttle.proxy.rlwy.net:15140" };
  const port = m[2] ? Number(m[2]) : 0;
  if (m[2] && (port < 1 || port > 65535)) return { host: "", error: "ポート番号がちがいます（1〜65535）。" };
  if (/\.workers\.dev$/.test(m[1]))
    return { host: "", error: "それは Cloudflare（Worker）のアドレスです。リレーのアドレス（VPS の IP、Google Cloud の VM の外部 IP、独自ドメイン、Railway の TCP Proxy のアドレス）を入れてください。" };
  return { host: port && port !== 80 ? `${m[1]}:${port}` : m[1], hostname: m[1], port: port || 80, error: "" };
}

/** 2つの文字列が同じか（長さ以外の情報がもれないように、ハッシュにしてから全部くらべる） */
async function sameText(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest("SHA-256", enc.encode(String(v)))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}

/**
 * /setup/ からリレーのアドレスを保存する。
 * ほかの人が勝手に書きかえられないように、Bot のトークン（/setup/ で入れたもの）が必要。
 * relay を空にすると、リレーを使わない（近接VC コネクターの案内に戻る）。
 */
export async function saveRelay(env, { token, relay }) {
  token = String(token || "").trim().replace(/^Bot\s+/i, "");
  if (!token) return { ok: false, error: "Bot のトークンを入れてください（勝手に変えられないように、確認に使います）。" };
  const s = await loadStored(env);
  const real = isSet(env.DISCORD_TOKEN) ? env.DISCORD_TOKEN.trim() : s.token || "";
  if (!real) return { ok: false, error: "先に上の「Bot の設定」を終わらせてください。" };
  if (!(await sameText(token, real))) return { ok: false, error: "トークンがちがいます（いま Bot に設定されているトークンを入れてください）。" };
  const r = normalizeRelayHost(relay);
  if (r.error) return { ok: false, error: r.error };
  await saveStored(env, { relayHost: r.host });
  const e = await resolveEnv(env, { fresh: true });
  return { ok: true, relay: e.RELAY_HOST, relayFrom: e.RELAY_FROM, saved: r.host };
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

/**
 * VPS（ConoHa など）に貼るコマンドを作る（リレー＋音声中継 TURN をまとめて入れる）。
 * TURN の合言葉はここで作って保存し、コマンドに入れる。Bot のトークンで本人か確かめる。
 */
export async function vpsCommand(env, { token, origin, host }) {
  token = String(token || "").trim().replace(/^Bot\s+/i, "");
  if (!token) return { ok: false, error: "Bot のトークンを入れてください（勝手に見られないように、確認に使います）。" };
  const s = await loadStored(env);
  const real = isSet(env.DISCORD_TOKEN) ? env.DISCORD_TOKEN.trim() : s.token || "";
  if (!real) return { ok: false, error: "先に上の「Bot の設定」を終わらせてください。" };
  if (!(await sameText(token, real))) return { ok: false, error: "トークンがちがいます（いま Bot に設定されているトークンを入れてください）。" };
  let secret = isSet(env.TURN_SECRET) ? env.TURN_SECRET.trim() : s.turnSecret || "";
  if (!secret) {
    const b = crypto.getRandomValues(new Uint8Array(24));
    secret = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await saveStored(env, { turnSecret: secret });
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return { ok: false, error: "Cloudflare のシークレット TURN_SECRET には、英数字と - _ だけを使ってください（16 文字以上）。" };
  const command = `curl -fsSL ${origin}/download/vps-setup.sh | sudo bash -s -- ${host} ${secret}`;
  return { ok: true, command, secretFrom: isSet(env.TURN_SECRET) ? "var" : "page" };
}
