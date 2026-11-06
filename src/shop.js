// =====================================================================
//  制作依頼（m-ayosaba.com/shop/）
//   - 依頼する人: 種類・金額の上限（50〜500 円）・内容・Discord の名前 → 依頼 ID と合言葉（URL）をもらう
//   - 管理者（/setup/）: 一覧・承認（金額）・お断り・完了・メッセージ
//   - 承認されたら、依頼した人と管理者でメッセージのやりとりができる（お支払いは PayPay のみ）
//   - 保存場所: 設定の部屋（Durable Object "__config__"）。1 件ずつ "shop:req:<ID>"、設定は "shop:settings"
//   - 合言葉はハッシュだけを保存する（Worker で sha256 にしてから渡す）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

export const SHOP_CATS = { addon: "アドオン", web: "ウェブサイト", thumb: "動画サムネ＆壁紙", bot: "Discord Bot" };
export const BUDGET_MIN = 50, BUDGET_MAX = 500;
export const STATUS = ["pending", "accepted", "rejected", "done", "canceled"];
export const LIMITS = { title: 60, detail: 2000, contact: 40, message: 1000, reason: 300, messages: 300, total: 300, pending: 40 };
const PREFIX = "shop:req:";
const ID_RE = /^[a-z0-9]{8}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function newId() {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}
/** 合言葉（URL に入れる。保存はしない） */
export function newKey() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}

/** 文字をきれいにする（制御文字を消す・前後の空白を取る）。長すぎたら null */
function clean(v, max, multiline) {
  let s = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  s = multiline ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/[‪-‮⁦-⁩]/g, "");
  if (multiline) s = s.replace(/\n{4,}/g, "\n\n\n");
  s = s.trim();
  return [...s].length > max ? null : s;
}

/** 新しい依頼の中身を確かめる → { item } か { error } */
export function cleanRequest(x) {
  const b = x && typeof x === "object" ? x : {};
  if (!SHOP_CATS[b.cat]) return { error: "作ってほしいものを選んでください。" };
  const budget = Math.round(Number(b.budget));
  if (!Number.isFinite(budget) || budget < BUDGET_MIN || budget > BUDGET_MAX) return { error: `金額の上限は ${BUDGET_MIN}〜${BUDGET_MAX} 円で入れてください。` };
  const title = clean(b.title, LIMITS.title, false);
  if (title === null) return { error: `タイトルは ${LIMITS.title} 文字までです。` };
  if (!title) return { error: "タイトルを入れてください。" };
  const detail = clean(b.detail, LIMITS.detail, true);
  if (detail === null) return { error: `内容は ${LIMITS.detail} 文字までです。` };
  if ([...detail].length < 10) return { error: "どんなものを作ってほしいか、もう少しくわしく書いてください（10 文字以上）。" };
  const contact = clean(b.contact, LIMITS.contact, false);
  if (contact === null) return { error: `Discord の名前は ${LIMITS.contact} 文字までです。` };
  if (!contact) return { error: "連絡用に Discord のユーザー名を入れてください。" };
  if (b.agree !== true) return { error: "利用規約に同意してください。" };
  return { item: { cat: b.cat, budget, title, detail, contact } };
}

/** 依頼した人に見せる形（合言葉のハッシュなどは入れない） */
export function clientView(r, settings) {
  const out = {
    id: r.id, cat: r.cat, catName: SHOP_CATS[r.cat], budget: r.budget, title: r.title, detail: r.detail, contact: r.contact,
    status: r.status, price: r.price ?? null, reason: r.reason || "", at: r.at, updated: r.updated,
    messages: r.status === "pending" || r.status === "canceled" ? [] : r.messages.map(m => ({ from: m.from, text: m.text, at: m.at })),
    canPost: r.status === "accepted", canCancel: r.status === "pending",
  };
  if ((r.status === "accepted" || r.status === "done") && settings && settings.paypay) out.paypay = settings.paypay;
  return out;
}
/** 管理者の一覧に出す形 */
function summary(r) {
  const last = r.messages[r.messages.length - 1];
  return {
    id: r.id, cat: r.cat, catName: SHOP_CATS[r.cat], budget: r.budget, title: r.title, contact: r.contact, status: r.status, price: r.price ?? null,
    at: r.at, updated: r.updated, unread: r.unreadAdmin || 0, messages: r.messages.length, last: last ? { from: last.from, text: last.text.slice(0, 80), at: last.at } : null,
  };
}
const ORDER = { pending: 0, accepted: 1, done: 2, rejected: 3, canceled: 4 };

async function loadAll(storage) {
  const m = await storage.list({ prefix: PREFIX });
  return [...m.values()];
}

/**
 * 依頼の操作（Durable Object の中で、1 つずつ順番に動く）
 *  だれでも: create・view・post・cancel（合言葉のハッシュが必要）
 *  管理者（admin: true は Worker がログインを確かめてから付ける）: list・get・accept・reject・done・reopen・message・delete・settings
 */
export async function shopOp(storage, body, now = Date.now()) {
  const b = body && typeof body === "object" ? body : {};
  const settings = (await storage.get("shop:settings")) || {};
  const err = (error, status = 400) => ({ ok: false, error, status });
  const getReq = async id => (ID_RE.test(String(id || "")) ? (await storage.get(PREFIX + id)) || null : null);
  const save = r => storage.put(PREFIX + r.id, r);

  // ---- 依頼した人 ----
  if (!b.admin) {
    if (b.action === "create") {
      const c = cleanRequest(b.item);
      if (c.error) return err(c.error);
      if (!HASH_RE.test(String(b.keyHash || ""))) return err("合言葉がありません。");
      const all = await loadAll(storage);
      if (all.filter(r => r.status === "pending").length >= LIMITS.pending) return err("いまは依頼がいっぱいです。少し時間をおいてください。", 503);
      // 多くなったら、終わった古いものから消す
      if (all.length >= LIMITS.total) {
        const old = all.filter(r => ["rejected", "canceled", "done"].includes(r.status)).sort((x, y) => x.updated - y.updated);
        for (const r of old.slice(0, all.length - LIMITS.total + 1)) await storage.delete(PREFIX + r.id);
      }
      let id = newId();
      while (await storage.get(PREFIX + id)) id = newId();
      const r = { id, ...c.item, keyHash: b.keyHash, status: "pending", price: null, reason: "", at: now, updated: now, messages: [], unreadAdmin: 1, unreadClient: 0 };
      await save(r);
      return { ok: true, id, request: clientView(r, settings), _webhook: settings.webhook || "", _item: { id, ...c.item } };
    }
    const r = await getReq(b.id);
    if (!r || r.keyHash !== b.keyHash) return err("依頼が見つかりません（URL をもう一度確かめてください）。", 404);
    if (b.action === "view") {
      if (r.unreadClient) { r.unreadClient = 0; await save(r); }
      return { ok: true, request: clientView(r, settings) };
    }
    if (b.action === "post") {
      if (r.status !== "accepted") return err("いまはメッセージを送れません。", 409);
      const text = clean(b.text, LIMITS.message, true);
      if (text === null) return err(`メッセージは ${LIMITS.message} 文字までです。`);
      if (!text) return err("メッセージを入れてください。");
      if (r.messages.length >= LIMITS.messages) return err("メッセージが多すぎます。Discord で連絡してください。", 409);
      r.messages.push({ from: "client", text, at: now });
      r.updated = now; r.unreadAdmin = (r.unreadAdmin || 0) + 1;
      await save(r);
      return { ok: true, request: clientView(r, settings), _webhook: settings.webhook || "", _item: { id: r.id, cat: r.cat, budget: r.budget, title: r.title, contact: r.contact } };
    }
    if (b.action === "cancel") {
      if (r.status !== "pending") return err("承認されたあとは、メッセージで相談してください。", 409);
      r.status = "canceled"; r.updated = now; r.unreadAdmin = (r.unreadAdmin || 0) + 1;
      await save(r);
      return { ok: true, request: clientView(r, settings) };
    }
    return err("わからない操作です。");
  }

  // ---- 管理者 ----
  if (b.action === "settings") {
    if (b.set && typeof b.set === "object") {
      const next = { ...settings };
      if (b.set.webhook !== undefined) {
        const w = String(b.set.webhook || "").trim();
        if (w && !/^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9_-]{30,120}$/.test(w)) return err("Discord の Webhook の URL を入れてください（https://discord.com/api/webhooks/…）。");
        next.webhook = w;
      }
      if (b.set.paypay !== undefined) {
        const p = clean(b.set.paypay, 300, true);
        if (p === null) return err("PayPay の受け取り方法は 300 文字までです。");
        next.paypay = p;
      }
      await storage.put("shop:settings", next);
      return { ok: true, settings: { webhook: next.webhook ? true : false, webhookTail: next.webhook ? next.webhook.slice(-6) : "", paypay: next.paypay || "" } };
    }
    return { ok: true, settings: { webhook: !!settings.webhook, webhookTail: settings.webhook ? settings.webhook.slice(-6) : "", paypay: settings.paypay || "" } };
  }
  if (b.action === "list") {
    const all = (await loadAll(storage)).map(summary).sort((x, y) => (ORDER[x.status] - ORDER[y.status]) || (y.unread - x.unread) || (y.updated - x.updated));
    return { ok: true, items: all };
  }
  const r = await getReq(b.id);
  if (!r) return err("依頼が見つかりません。", 404);
  const done = async () => { r.updated = now; await save(r); return { ok: true, request: { ...clientView(r, settings), unread: r.unreadAdmin || 0 } }; };
  switch (b.action) {
    case "get":
      if (r.unreadAdmin) { r.unreadAdmin = 0; await save(r); }
      return { ok: true, request: { ...clientView(r, settings), unread: 0 } };
    case "accept": {
      if (!["pending", "rejected"].includes(r.status)) return err("この依頼は承認できません。", 409);
      let price = null;
      if (b.price !== undefined && b.price !== null && b.price !== "") {
        price = Math.round(Number(b.price));
        if (!Number.isFinite(price) || price < 0 || price > BUDGET_MAX) return err(`金額は 0〜${BUDGET_MAX} 円で入れてください。`);
      }
      r.status = "accepted"; r.price = price; r.reason = ""; r.unreadClient = (r.unreadClient || 0) + 1;
      const note = clean(b.note, LIMITS.message, true);
      r.messages.push({ from: "admin", text: note || `依頼を承認しました！${price !== null ? `金額は ${price} 円です。` : ""}くわしいことは、このメッセージで相談しましょう。`, at: now });
      return done();
    }
    case "reject": {
      if (!["pending", "accepted"].includes(r.status)) return err("この依頼はお断りできません。", 409);
      const reason = clean(b.reason, LIMITS.reason, true);
      if (reason === null) return err(`理由は ${LIMITS.reason} 文字までです。`);
      r.status = "rejected"; r.reason = reason || ""; r.unreadClient = (r.unreadClient || 0) + 1;
      return done();
    }
    case "done":
      if (r.status !== "accepted") return err("承認した依頼だけ、完了にできます。", 409);
      r.status = "done"; r.unreadClient = (r.unreadClient || 0) + 1;
      return done();
    case "reopen":
      if (r.status !== "done") return err("完了した依頼だけ、やりとり中にもどせます。", 409);
      r.status = "accepted";
      return done();
    case "message": {
      if (!["accepted", "done"].includes(r.status)) return err("承認してから、メッセージを送れます。", 409);
      const text = clean(b.text, LIMITS.message, true);
      if (text === null) return err(`メッセージは ${LIMITS.message} 文字までです。`);
      if (!text) return err("メッセージを入れてください。");
      if (r.messages.length >= LIMITS.messages) return err("メッセージが多すぎます。", 409);
      r.messages.push({ from: "admin", text, at: now });
      r.unreadClient = (r.unreadClient || 0) + 1;
      return done();
    }
    case "delete":
      await storage.delete(PREFIX + r.id);
      return { ok: true, deleted: r.id };
  }
  return err("わからない操作です。");
}

/** Discord の Webhook に知らせる（設定があるときだけ） */
export async function notifyWebhook(url, { kind, item, text }) {
  if (!url) return;
  const title = kind === "new" ? "🛒 新しい制作依頼" : "💬 制作依頼にメッセージ";
  const body = {
    username: "まよ鯖.COM 制作依頼",
    embeds: [{
      title, color: kind === "new" ? 0xff6a2b : 0x5865f2,
      fields: [
        { name: "種類", value: `${SHOP_CATS[item.cat] || item.cat}`, inline: true },
        { name: "金額の上限", value: `${item.budget} 円`, inline: true },
        { name: "Discord", value: String(item.contact || "").slice(0, 100) || "-", inline: true },
        { name: "タイトル", value: String(item.title || "").slice(0, 200) || "-" },
        ...(text ? [{ name: "メッセージ", value: String(text).slice(0, 1000) }] : []),
      ],
      footer: { text: `依頼 ID: ${item.id} ・ /setup/ の「🛒 制作依頼」で確認` },
    }],
    allowed_mentions: { parse: [] },
  };
  try {
    await fetch(url + "?wait=false", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { /* 知らせられなくても止めない */ }
}
