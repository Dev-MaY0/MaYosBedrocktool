// =====================================================================
//  作品（アドオン・クライアント・マップ・ツールなど）の紹介
//   - サイトの制作者（管理者）が /setup/ で書く → /works/ とホームに出る
//   - 保存場所: 設定の部屋（Durable Object "__config__"）
//       "works:item:<ID>" … 作品の文字の情報
//       "works:img:<ID>"  … 作品の画像（WebP / JPEG / PNG。600KB まで）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

export const WORK_CATS = ["addon", "client", "map", "tool", "game", "video", "other"];
export const WORKS_MAX = 60;
export const IMG_MAX = 600 * 1024;           // 画像（デコード後）の大きさの上限
const LIMITS = { title: 60, summary: 120, body: 3000, sub: 50, label: 20, url: 400 };
const ITEM = "works:item:";
const IMG = "works:img:";
const ID_RE = /^[a-z0-9]{10}$/;
const IMG_TYPES = { "image/webp": 1, "image/jpeg": 1, "image/png": 1 };

function newId() {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}

function cleanText(v, max, multiline) {
  let s = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  s = multiline ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/[‪-‮⁦-⁩]/g, "");
  if (multiline) s = s.replace(/\n{4,}/g, "\n\n\n");
  s = s.trim();
  return [...s].length > max ? null : s;
}

/** リンク: https:// か、このサイトの中（/ から始まる）だけ */
function cleanUrl(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.length > LIMITS.url) return null;
  if (/^\/(?!\/)[^\s]*$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch (e) { return null; }
}

/**
 * 管理者が送ってきた内容 → 保存する形。だめなら { error }
 */
export function cleanWork(input, prev, now = Date.now()) {
  const x = input && typeof input === "object" ? input : {};
  const cat = WORK_CATS.includes(x.cat) ? x.cat : null;
  if (!cat) return { error: "種類をえらんでください。" };
  const title = cleanText(x.title, LIMITS.title, false);
  if (title === null) return { error: `名前は ${LIMITS.title} 文字までです。` };
  if (!title) return { error: "作品の名前を入れてください。" };
  const summary = cleanText(x.summary, LIMITS.summary, false);
  if (summary === null) return { error: `ひとこと紹介は ${LIMITS.summary} 文字までです。` };
  const body = cleanText(x.body, LIMITS.body, true);
  if (body === null) return { error: `くわしい説明は ${LIMITS.body} 文字までです。` };
  const sub = cleanText(x.sub, LIMITS.sub, false);
  if (sub === null) return { error: `バージョン・対応は ${LIMITS.sub} 文字までです。` };
  const links = [];
  for (const l of Array.isArray(x.links) ? x.links.slice(0, 6) : []) {
    const url = cleanUrl(l && l.url);
    const label = cleanText(l && l.label, LIMITS.label, false);
    if (url === null) return { error: "リンクは https:// から始まる URL（またはこのサイトの /〜）にしてください。" };
    if (label === null) return { error: `リンクのボタンの文字は ${LIMITS.label} 文字までです。` };
    if (!url) continue;
    links.push({ label: label || "ひらく", url });
    if (links.length >= 4) break;
  }
  const item = {
    id: prev ? prev.id : newId(),
    cat, title, summary, body, sub, links,
    pinned: !!x.pinned,
    published: x.published === undefined ? (prev ? prev.published : true) : !!x.published,
    img: prev ? prev.img || null : null,     // 画像は別に保存（{ v: 版, type }）
    at: prev ? prev.at : now,
    edited: prev ? now : null,
  };
  if (prev && x.bump) { item.at = now; item.edited = null; }
  return { item };
}

/** data:image/...;base64,... → { type, bytes }。だめなら { error } */
export function parseImage(dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m || !IMG_TYPES[m[1]]) return { error: "画像は WebP・JPEG・PNG にしてください。" };
  let bin;
  try { bin = atob(m[2]); } catch (e) { return { error: "画像が読めませんでした。" }; }
  if (bin.length > IMG_MAX) return { error: `画像が大きすぎます（${Math.round(IMG_MAX / 1024)}KB まで）。` };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 中身が本当にその形式か（先頭のしるし）を確かめる
  const sig = {
    "image/png": b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    "image/webp": b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  }[m[1]];
  if (!sig(bytes)) return { error: "画像の中身が形式と合いません。" };
  return { type: m[1], bytes };
}

/** 作品（新しい順。おすすめを先に） */
export async function loadWorks(storage) {
  const m = await storage.list({ prefix: ITEM });
  return [...m.values()].filter(v => v && ID_RE.test(v.id)).sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at));
}

/** 公開用（下書きを除く） */
export function publicWorks(list) {
  return list.filter(w => w.published).map(w => ({
    id: w.id, cat: w.cat, title: w.title, summary: w.summary, body: w.body, sub: w.sub, links: w.links,
    pinned: !!w.pinned, img: w.img ? `/api/works/img/${w.id}?v=${w.img.v}` : "", at: w.at, edited: w.edited || null,
  }));
}

/** 画像（なければ null） */
export async function loadWorkImage(storage, id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const v = await storage.get(IMG + id);
  return v && v.type && v.data ? v : null;
}

/**
 * 管理者の操作（Durable Object の中で動かす）
 *   { action: "list" }
 *   { action: "save", item: {...}, image?: "data:image/webp;base64,...", removeImage?: true }
 *   { action: "delete", id } ・ { action: "publish", id, on } ・ { action: "pin", id, on }
 */
export async function worksOp(storage, body, now = Date.now()) {
  const b = body && typeof body === "object" ? body : {};
  const done = async extra => ({ ok: true, items: (await loadWorks(storage)).map(w => ({ ...w, imgUrl: w.img ? `/api/works/img/${w.id}?v=${w.img.v}` : "" })), ...extra });
  switch (b.action) {
    case "list":
      return done();
    case "save": {
      const raw = b.item && typeof b.item === "object" ? b.item : {};
      let prev = null;
      if (raw.id !== undefined && raw.id !== null && raw.id !== "") {
        if (!ID_RE.test(String(raw.id))) return { ok: false, error: "作品が見つかりません。" };
        prev = await storage.get(ITEM + raw.id);
        if (!prev) return { ok: false, error: "作品が見つかりません（ほかの画面で消されたかもしれません）。" };
      }
      if (!prev && (await storage.list({ prefix: ITEM })).size >= WORKS_MAX) return { ok: false, error: `作品は ${WORKS_MAX} 個までです。古いものを消してください。` };
      const r = cleanWork(raw, prev, now);
      if (r.error) return { ok: false, error: r.error };
      const item = r.item;
      if (b.image) {
        const img = parseImage(b.image);
        if (img.error) return { ok: false, error: img.error };
        await storage.put(IMG + item.id, { type: img.type, data: img.bytes.buffer });
        item.img = { v: now, type: img.type };
      } else if (b.removeImage) {
        await storage.delete(IMG + item.id);
        item.img = null;
      }
      await storage.put(ITEM + item.id, item);
      return done({ saved: item.id, created: !prev });
    }
    case "delete": {
      if (!ID_RE.test(String(b.id || ""))) return { ok: false, error: "作品が見つかりません。" };
      await storage.delete([ITEM + b.id, IMG + b.id]);
      return done();
    }
    case "publish":
    case "pin": {
      if (!ID_RE.test(String(b.id || ""))) return { ok: false, error: "作品が見つかりません。" };
      const cur = await storage.get(ITEM + b.id);
      if (!cur) return { ok: false, error: "作品が見つかりません。" };
      if (b.action === "publish") cur.published = !!b.on; else cur.pinned = !!b.on;
      await storage.put(ITEM + b.id, cur);
      return done();
    }
    default:
      return { ok: false, error: "その操作はできません。" };
  }
}
