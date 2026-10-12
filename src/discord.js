// =====================================================================
//  Discord まわりの小物（署名の確認・REST API の呼び出し）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

const enc = new TextEncoder();

function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Discord から来たリクエストか（Ed25519 の署名）を確かめる */
export async function verifyDiscordRequest(publicKeyHex, signatureHex, timestamp, body) {
  const key = hexToBytes(publicKeyHex), sig = hexToBytes(signatureHex);
  if (!key || key.length !== 32 || !sig || sig.length !== 64 || !timestamp) return false;
  const data = enc.encode(timestamp + body);
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, data);
  } catch (e) {
    // 古いランタイム向け
    try {
      const k = await crypto.subtle.importKey("raw", key, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"]);
      return await crypto.subtle.verify("NODE-ED25519", k, sig, data);
    } catch (e2) {
      return false;
    }
  }
}

export class BudgetError extends Error {}
export class RateLimitError extends Error {
  constructor(retryAfter) { super(`rate limited ${retryAfter}s`); this.retryAfter = retryAfter; }
}

/**
 * Bot として REST API を呼ぶ。
 * Cloudflare の無料プランは 1 回の処理で外部へのリクエストが 50 回までなので、budget で回数を数える。
 */
export class DiscordRest {
  constructor(env, budget = 24) {
    this.env = env;
    this.budget = budget;
    this.api = (env.DISCORD_API || "https://discord.com/api/v10").replace(/\/$/, "");
  }

  async call(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.budget <= 0) throw new BudgetError("budget");
      this.budget--;
      const res = await fetch(this.api + path, {
        method,
        headers: {
          Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://github.com/Dev-MaY0, 1.0) PlayerCorpseVC",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) {
        let wait = 1;
        try { wait = Number((await res.json()).retry_after) || 1; } catch (e) { /* 無視 */ }
        if (attempt === 0 && wait <= 1.5) { await sleep(wait * 1000 + 50); continue; }
        throw new RateLimitError(wait);
      }
      let data = null;
      const text = await res.text();
      if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
      return { ok: res.ok, status: res.status, data, code: data && typeof data === "object" ? data.code : undefined };
    }
    throw new RateLimitError(1);
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * スラッシュコマンドの「考え中…」を書きかえる（Bot トークンはいらない）
 * reply: 文字列、または { content, files: [{ name, data }], buttons: [{ label, url }] }
 * ボタンやファイルを Discord が受け付けなかったときは、文字だけでもう一度送る。
 */
export async function editOriginal(env, token, reply) {
  const api = (env.DISCORD_API || "https://discord.com/api/v10").replace(/\/$/, "");
  const r = typeof reply === "string" ? { content: reply } : reply || {};
  const url = `${api}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`;
  const payload = { content: String(r.content || "").slice(0, 1990), allowed_mentions: { parse: [] } };
  const buttons = (r.buttons || []).filter(b => isLinkUrl(b.url)).slice(0, 5);
  if (buttons.length) payload.components = [{ type: 1, components: buttons.map(b => ({ type: 2, style: 5, label: b.label, url: b.url })) }];
  const files = r.files || [];
  try {
    let res;
    if (files.length) {
      payload.attachments = files.map((f, i) => ({ id: i, filename: f.name }));
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify(payload));
      files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data], { type: "application/octet-stream" }), f.name));
      res = await fetch(url, { method: "PATCH", body: fd });
    } else {
      res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
    if (res.ok) return true;
    console.log("editOriginal failed", res.status, await res.text());
    if (!files.length && !payload.components) return false;
    // ボタンやファイルが原因かもしれないので、文字だけで
    const plain = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: payload.content, allowed_mentions: { parse: [] } }) });
    return plain.ok;
  } catch (e) {
    console.log("editOriginal error", e);
    return false;
  }
}

/** Discord のリンクボタンに使える URL か（設定前の「ここに…」などは使えない） */
export function isLinkUrl(u) {
  return typeof u === "string" && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[\x21-\x7e]*)?$/.test(u) && u.length <= 512;
}

// 権限ビット
export const PERM = {
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
};

export function hasPerm(member, bit) {
  try {
    const p = BigInt(member?.permissions ?? "0");
    return (p & PERM.ADMINISTRATOR) !== 0n || (p & bit) !== 0n;
  } catch (e) {
    return false;
  }
}

// Bot を招待するときの権限: チャンネルを見る・接続・メンバーを移動・チャンネルの管理・メッセージ送信
export const INVITE_PERMISSIONS = (1n << 10n) | (1n << 20n) | (1n << 24n) | (1n << 4n) | (1n << 11n);
