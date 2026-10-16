// =====================================================================
//  お知らせ（アップデート・メンテナンス・お知らせ）
//   - 管理者が /setup/ で書く → ホーム（/）に出る
//   - 保存場所: 設定の部屋（Durable Object "__config__"）。1 件ずつ "news:item:<ID>" に入れる
//   - 公開してよい項目だけを返す（下書きは管理者にだけ見える）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

export const NEWS_TYPES = ["update", "maintenance", "info", "important"];
export const NEWS_MAX = 50;          // 保存しておく数（多くなったら、ピン留めしていない古いものから消す）
export const TITLE_MAX = 80;
export const BODY_MAX = 2000;
const PREFIX = "news:item:";
const ID_RE = /^[a-z0-9]{10}$/;
const T_MIN = Date.UTC(2020, 0, 1), T_MAX = Date.UTC(2100, 0, 1);

function newId() {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}

/** 文字をきれいにする（制御文字を消す・改行は \n にそろえる・前後の空白を取る） */
function cleanText(v, max, multiline) {
  let s = String(v == null ? "" : v).replace(/\r\n?/g, "\n");
  s = multiline ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : s.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/[‪-‮⁦-⁩]/g, "");   // 文字の向きを変える見えない文字
  if (multiline) s = s.replace(/\n{4,}/g, "\n\n\n");
  s = s.trim();
  return [...s].length > max ? null : s;
}
function cleanTime(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= T_MIN && n <= T_MAX ? Math.round(n) : undefined;
}

/**
 * 管理者が送ってきた内容 → 保存する形。だめなら { error }
 * prev があれば、それを書きかえる（作った日時・ID はそのまま）
 */
export function cleanItem(input, prev, now = Date.now()) {
  const x = input && typeof input === "object" ? input : {};
  const type = NEWS_TYPES.includes(x.type) ? x.type : null;
  if (!type) return { error: "種類をえらんでください。" };
  const title = cleanText(x.title, TITLE_MAX, false);
  if (title === null) return { error: `タイトルは ${TITLE_MAX} 文字までです。` };
  if (!title) return { error: "タイトルを入れてください。" };
  const body = cleanText(x.body, BODY_MAX, true);
  if (body === null) return { error: `本文は ${BODY_MAX} 文字までです。` };
  let start = cleanTime(x.start), end = cleanTime(x.end);
  if (start === undefined || end === undefined) return { error: "日時の形がちがいます。" };
  if (type !== "maintenance") { start = null; end = null; }
  if (start && end && end <= start) return { error: "メンテナンスの「終わり」は「はじまり」より後にしてください。" };
  const item = {
    id: prev ? prev.id : newId(),
    type, title, body,
    pinned: !!x.pinned,
    published: x.published === undefined ? (prev ? prev.published : true) : !!x.published,
    start, end,
    at: prev ? prev.at : now,
    edited: prev ? now : null,
  };
  // 編集したときに「新着として上に出す」
  if (prev && x.bump) { item.at = now; item.edited = null; }
  return { item };
}

/** いま保存されているお知らせ（新しい順） */
export async function loadNews(storage) {
  const m = await storage.list({ prefix: PREFIX });
  return [...m.values()].filter(v => v && ID_RE.test(v.id)).sort((a, b) => b.at - a.at);
}

/** 公開用（下書きを除く）。中身はそのまま見せてよい項目だけ */
export function publicNews(list) {
  return list.filter(n => n.published).map(n => ({
    id: n.id, type: n.type, title: n.title, body: n.body, pinned: !!n.pinned,
    start: n.start || null, end: n.end || null, at: n.at, edited: n.edited || null,
  }));
}

/**
 * 管理者の操作（Durable Object の中で動かす。1 つずつ順番に処理されるので、同時に押しても壊れない）
 *   { action: "list" }
 *   { action: "save", item: { id?, type, title, body, pinned, published, start, end, bump } }
 *   { action: "delete", id }
 *   { action: "publish", id, on } ・ { action: "pin", id, on }
 */
export async function newsOp(storage, body, now = Date.now()) {
  const b = body && typeof body === "object" ? body : {};
  const done = async extra => ({ ok: true, items: await loadNews(storage), ...extra });
  switch (b.action) {
    case "list":
      return done();
    case "save": {
      const raw = b.item && typeof b.item === "object" ? b.item : {};
      let prev = null;
      if (raw.id !== undefined && raw.id !== null && raw.id !== "") {
        if (!ID_RE.test(String(raw.id))) return { ok: false, error: "お知らせが見つかりません。" };
        prev = await storage.get(PREFIX + raw.id);
        if (!prev) return { ok: false, error: "お知らせが見つかりません（ほかの画面で消されたかもしれません）。" };
      }
      const r = cleanItem(raw, prev, now);
      if (r.error) return { ok: false, error: r.error };
      await storage.put(PREFIX + r.item.id, r.item);
      // 多くなったら、ピン留めしていない古いものから消す
      const all = await loadNews(storage);
      if (all.length > NEWS_MAX) {
        const drop = all.filter(n => !n.pinned && n.id !== r.item.id).slice(-(all.length - NEWS_MAX));
        if (drop.length) await storage.delete(drop.map(n => PREFIX + n.id));
      }
      return done({ saved: r.item.id, created: !prev });
    }
    case "delete": {
      if (!ID_RE.test(String(b.id || ""))) return { ok: false, error: "お知らせが見つかりません。" };
      await storage.delete(PREFIX + b.id);
      return done();
    }
    case "publish":
    case "pin": {
      if (!ID_RE.test(String(b.id || ""))) return { ok: false, error: "お知らせが見つかりません。" };
      const cur = await storage.get(PREFIX + b.id);
      if (!cur) return { ok: false, error: "お知らせが見つかりません。" };
      if (b.action === "publish") cur.published = !!b.on; else cur.pinned = !!b.on;
      await storage.put(PREFIX + b.id, cur);
      return done();
    }
    default:
      return { ok: false, error: "その操作はできません。" };
  }
}
