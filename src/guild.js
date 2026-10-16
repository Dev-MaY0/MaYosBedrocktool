// =====================================================================
//  GuildRoom … Discord サーバー 1 つぶんの近接VC
//  - Minecraft から「だれがどのグループ（部屋）にいるか」を受け取る
//      ワールド用: ホストの /wsserver につないで、testfor でタグを読む
//      BDS 用   : アドオンが HTTP で送ってくる
//  - 紐付けた Discord ユーザーを、グループごとの VC に移動する
//  - 死んだ人は「死亡者VC」、ゲームにいない人は「ロビー」へ
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { DiscordRest, BudgetError, RateLimitError, editOriginal, hasPerm, PERM } from "./discord.js";
import { buildVcAddon, hasAddonTemplate } from "./addon.js";
import { resolveEnv } from "./appconfig.js";
import { WS_ENCRYPT_PROTOCOL, beginKeyExchange, finishKeyExchange, newCipherState, encryptText, decryptBytes } from "./mcenc.js";
import { webMethods } from "./webvc.js";
import { chatMethods, CHAT_TAG } from "./chat.js";
import { loadNews, publicNews, newsOp } from "./news.js";

export const DEAD_ROOM = 31;
const MAX_ROOM = 30;
const POLL_MS = 1500;             // ワールド用: 位置のグループを読む間隔
const WEB_IDLE_MS = 30000;        // サイトの部屋: サイトにだれもいないあいだは、ゆっくり（無料プランの節約）
const VERIFY_MS = 15000;          // 正しいVCにいる人も、この間隔で確認し直す
const RECHECK_MS = 5000;          // VCに入っていない人・ほかのVCにいる人を確認し直す間隔
const MOVE_COOLDOWN_MS = 2000;    // 同じ人を続けて移動しない時間
const BDS_STALE_DEFAULT_MS = 60000; // BDS からの送信がこれだけ止まったら全員ロビーへ
const LINK_TTL_MS = 10 * 60000;   // 紐付けコードの有効時間
const ENC_TIMEOUT_MS = 6000;      // 暗号化の準備をこれだけ待つ
const ENC_BROKEN_MS = 60 * 60000; // 暗号化がうまくいかなかったら、この間は暗号化なしでつなぐ
const MAX_TRIES = 10;             // 「接続の記録」を残す数
const DEFAULT_RADIUS = 20;
const TAGS = ["pcvc_on", "pcvc_b0", "pcvc_b1", "pcvc_b2", "pcvc_b3", "pcvc_b4"];

const CATEGORY_NAME = "Minecraft 近接VC";
const LOBBY_NAME = "🎮 近接VC ロビー";
const DEAD_NAME = "💀 死亡者VC";
const roomName = n => `🔊 近接VC ${n}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function newSecret() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}

function sameSecret(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// 短い接続コード（/wsserver で打ちやすいように。まぎらわしい 0 O 1 I は使わない）
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
function newShortCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const x of b) s += CODE_ABC[x % CODE_ABC.length];
  return s;
}
const DIRECTORY = "__directory__";

const quoteName = name => `"${String(name).replace(/["\\]/g, "")}"`;

/**
 * WebSocket の close コードを、人が読める形に。
 * 4999 より大きい値は規格にないコード。Minecraft は 1002 を逆のバイト順で送ってくることがあり、
 * そのとき 59907（0xEA03）になる → バイトを入れかえて元のコードも出す。
 */
const CLOSE_NAMES = {
  1000: "正常に終了", 1001: "相手が終了した", 1002: "プロトコルエラー（WebSocket のやりとりの形が合わない）",
  1003: "受け取れない種類のデータ", 1005: "コードなし", 1006: "回線が切れた", 1007: "文字コードのエラー",
  1008: "ポリシー違反", 1009: "メッセージが大きすぎる", 1010: "必要な拡張機能がない", 1011: "相手側のエラー",
  4000: "別のワールドがつながった", 4001: "接続キーが変わった", 4002: "暗号化のエラー",
};
export function describeClose(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return { base: null, text: `接続エラー${code && code !== "error" ? `（${code}）` : ""}` };
  if (n > 4999 && n <= 0xffff) {
    const swapped = ((n & 0xff) << 8) | (n >> 8);
    if (swapped >= 1000 && swapped <= 4999)
      return { base: swapped, text: `コード ${n}＝バイト順を戻すと ${swapped}: ${CLOSE_NAMES[swapped] || "その他"}` };
  }
  return { base: n, text: `コード ${n}${CLOSE_NAMES[n] ? `: ${CLOSE_NAMES[n]}` : ""}` };
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒前` : s < 3600 ? `${Math.round(s / 60)}分前` : `${Math.round(s / 3600)}時間前`;
}

export class GuildRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.rawEnv = env;
    this.env = env; // 処理のはじめに resolveEnv() で、/setup/ で保存した設定を足したものに入れかえる
    this.storage = ctx.storage;
    this.desired = new Map();   // ゲーム内の名前(小文字) → { name, room }
    this.current = new Map();   // Discord ユーザーID → { channelId, at, state }
    this.lastMove = new Map();  // Discord ユーザーID → 最後に移動した時刻
    this.poll = null;
    this.lastUpdate = 0;
    this.bdsMode = false;
    this.staleMs = Number(env.BDS_STALE_MS) || BDS_STALE_DEFAULT_MS;
    this.retryAt = 0;   // Discord の回数制限が明けるまで待つ時刻
    this.softRetry = 0; // 連続移動の待ちなどで、あとでもう一度確認する時刻
    // ブラウザ（サイト内VC）の「ping」には、部屋を起こさずに「pong」と返す
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch (e) { /* 古い環境 */ }
    ctx.blockConcurrencyWhile(async () => {
      this.cfg = (await this.storage.get("cfg")) || null;
      this.links = (await this.storage.get("links")) || {};
      this.pending = (await this.storage.get("pending")) || {};
      // BDS とつながっていたか（Durable Object がメモリから消えても、全員をロビーに戻せるように）
      this.bdsPersisted = (await this.storage.get("bdsActive")) === true;
      this.tries = (await this.storage.get("tries")) || [];          // Minecraft からの接続の記録（新しい順）
      this.encBrokenUntil = (await this.storage.get("encBrokenUntil")) || 0;
    });
  }

  // ------------------------------------------------------------------
  //  接続の記録（つながらないときに、どこで止まっているか分かるように）
  // ------------------------------------------------------------------
  async noteTry(entry) {
    this.tries = [{ t: Date.now(), ...entry }, ...(this.tries || [])].slice(0, MAX_TRIES);
    await this.storage.put("tries", this.tries);
    // Cloudflare のログ（ダッシュボードの「ログ」→ リアルタイム）にも出す。接続コード・キーは出さない
    console.log(JSON.stringify({ ev: "mc_" + (entry.kind || "note"), guild: this.cfg?.guildId || "", scheme: entry.scheme || "", text: entry.text, detail: entry.detail || "" }));
  }

  /** 記録を、人が読める 1 行に */
  static tryLine(x, now = Date.now()) {
    const how = x.scheme === "https" ? "wss://" : x.scheme === "http" ? "ws://" : "";
    return `${ago(now - x.t)}：${x.text}${how ? `（${how}）` : ""}`;
  }

  /** WebSocket ごとのメモ（休止しても消えない） */
  att(ws) {
    try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; }
  }
  setAtt(ws, a) {
    try { ws.serializeAttachment(a); } catch (e) { /* 無視 */ }
  }

  // ------------------------------------------------------------------
  //  入口
  // ------------------------------------------------------------------
  async useEnv() {
    this.env = await resolveEnv(this.rawEnv);
  }

  async fetch(request) {
    const url = new URL(request.url);
    // 設定の保存場所（"__config__" という名前の部屋だけが使う）
    if (url.pathname === "/config/get") return json((await this.storage.get("appConfig")) || {});
    if (url.pathname === "/config/put") {
      const cur = (await this.storage.get("appConfig")) || {};
      await this.storage.put("appConfig", { ...cur, ...(await request.json()) });
      return json({ ok: true });
    }
    // お知らせ（"__config__" の部屋だけが使う。中身は src/news.js）
    if (url.pathname === "/news/list") return json({ ok: true, items: publicNews(await loadNews(this.storage)) });
    if (url.pathname === "/news/op" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const r = await newsOp(this.storage, body);
      return json(r, r.ok ? 200 : 400);
    }
    if (!url.pathname.startsWith("/dir/")) await this.useEnv();
    switch (url.pathname) {
      case "/interaction":
        await this.onInteraction(await request.json(), url.searchParams.get("origin") || "");
        return new Response("ok");
      case "/ws":
        return this.onWsConnect(request, url.searchParams.get("secret"), url.searchParams.get("code"), url.searchParams.get("scheme") || "");
      case "/diag": {
        // 接続チェックのページ用（接続コードで確認）
        const code = url.searchParams.get("code");
        if (!this.cfg || !code || !sameSecret(code, this.cfg.shortCode)) return json({ ok: false }, 404);
        if (request.method === "POST") {
          // WebSocket ではない形で Minecraft（らしきもの）から来たとき
          const b = await request.json();
          await this.noteTry({ kind: "noupgrade", text: "⚠ 届いたけど WebSocket の形になっていませんでした（とちゅうの機器やセキュリティソフトが止めている可能性）", scheme: b.scheme || "" });
          return json({ ok: true });
        }
        return json({ ok: true, ...this.diagInfo() });
      }
      case "/autocomplete":
        return this.onAutocomplete(await request.json());
      case "/dir/get": {
        // 短い接続コード → サーバーID（"__directory__" という名前の部屋だけが使う）
        const guildId = await this.storage.get("dir:" + url.searchParams.get("code"));
        return json({ guildId: guildId || null });
      }
      case "/dir/rate": {
        // いたずら防止: 同じ人（IP のハッシュ）が 1 時間に作れる部屋の数（"__directory__" だけが使う）
        const b = await request.json();
        const hour = Math.floor(Date.now() / 3600000);
        let r = await this.storage.get("rate");
        if (!r || r.hour !== hour) r = { hour, c: {} };
        const n = (r.c[b.k] || 0) + 1;
        if (n > (Number(b.max) || 5)) return json({ ok: false });
        r.c[b.k] = n;
        await this.storage.put("rate", r);
        return json({ ok: true });
      }
      case "/dir/room/get": {
        // サイトの部屋: 6 けたの部屋番号 → 内部の長いランダム ID（"__directory__" だけが使う）
        const code = String(url.searchParams.get("code") || "");
        const uid = /^\d{6}$|^[A-HJ-NP-Z2-9]{6}$/.test(code) ? await this.storage.get("room:" + code) : null;
        return json({ uid: uid || null });
      }
      case "/dir/room/put": {
        // 部屋番号を 1 つの部屋にだけ割り当てる（すでに使われていたら conflict。ここが 1 か所なので、同時に作っても番号は被らない）
        const b = await request.json();
        if (!/^(?:\d{6}|[A-HJ-NP-Z2-9]{6})$/.test(String(b.code)) || !/^[0-9a-f]{32}$/.test(String(b.uid))) return json({ ok: false }, 400);
        if (await this.storage.get("room:" + b.code)) return json({ ok: false, conflict: true });
        await this.storage.put("room:" + b.code, b.uid);
        return json({ ok: true });
      }
      case "/dir/room/del": {
        // 部屋を作りそこねたときに、割り当てを取り消す（割り当てたときの ID と同じときだけ）
        const b = await request.json();
        if ((await this.storage.get("room:" + b.code)) === b.uid) await this.storage.delete("room:" + b.code);
        return json({ ok: true });
      }
      case "/dir/put": {
        const b = await request.json();
        const cur = await this.storage.get("dir:" + b.code);
        if (cur && cur !== b.guildId) return json({ ok: false, conflict: true });
        await this.storage.put("dir:" + b.code, b.guildId);
        if (b.oldCode && b.oldCode !== b.code && (await this.storage.get("dir:" + b.oldCode)) === b.guildId)
          await this.storage.delete("dir:" + b.oldCode);
        return json({ ok: true });
      }
      case "/update":
        return this.onBdsUpdate(await request.json());
      // ---- サイト内の近接VC（webvc.js）----
      case "/web/create":
        return this.webCreate(await request.json());
      case "/web/info":
        return this.webInfo();
      case "/web/host":
        return this.webHost(await request.json());
      case "/web/socket":
        return this.webAccept(request);
      // ---- ゲストのチャット（chat.js。"__chat__" という名前の部屋だけが使う）----
      case "/chat/guest/new":
        return this.chatGuestNew(await request.json());
      case "/chat/guest/check":
        return this.chatGuestCheck(url.searchParams.get("token"));
      case "/chat/socket":
        return this.chatAccept(request);
      case "/chat/admin":
        return this.chatAdmin(await request.json());
      case "/check":
        return this.onCheck(url.searchParams.get("secret"));
      default:
        return new Response("not found", { status: 404 });
    }
  }

  checkSecret(secret) {
    return !!(this.cfg && this.cfg.secret && sameSecret(secret, this.cfg.secret));
  }

  get key() {
    return this.cfg ? `${this.cfg.guildId}.${this.cfg.secret}` : "";
  }

  get radius() {
    return (this.cfg && this.cfg.radius) || DEFAULT_RADIUS;
  }

  /** つながっている Minecraft（/wsserver）。閉じかけのものは数えない */
  socket(except) {
    return this.ctx.getWebSockets("mc").find(s => s !== except && s.readyState === 1) || null;
  }

  liveMode() {
    if (this.socket()) return "ws";
    if (this.bdsMode && Date.now() - this.lastUpdate < this.staleMs) return "bds";
    return null;
  }

  async saveCfg() { await this.storage.put("cfg", this.cfg); }
  async saveLinks() { await this.storage.put("links", this.links); }
  async savePending() { await this.storage.put("pending", this.pending); }

  prunePending() {
    const now = Date.now();
    let changed = false;
    for (const [code, p] of Object.entries(this.pending)) {
      if (!p || p.expires < now) { delete this.pending[code]; changed = true; }
    }
    return changed;
  }

  // ------------------------------------------------------------------
  //  ワールド用: Minecraft の /wsserver
  // ------------------------------------------------------------------
  async onWsConnect(request, secret, code, scheme) {
    if (!this.cfg) return new Response("このサーバーでは、まだ /vc setup がされていません", { status: 404 });
    const codeOk = !!(code && this.cfg.shortCode && sameSecret(code, this.cfg.shortCode));
    if (!this.checkSecret(secret) && !codeOk) {
      await this.noteTry({ kind: "badkey", text: "✗ 接続キーがちがいました（/vc key で新しいコマンドを確認）", scheme });
      return new Response("接続キーがちがいます", { status: 403 });
    }
    for (const old of this.ctx.getWebSockets("mc")) {
      try { old.close(4000, "別のワールドがつながりました"); } catch (e) { /* 無視 */ }
    }
    // Minecraft は「暗号化できます」というサブプロトコルを送ってくる。
    // 同じ名前を返さないと、「暗号化された WebSocket を要求」がオンのとき「サーバーに接続できませんでした」になる。
    const offered = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(s => s.trim());
    const canEnc = offered.includes(WS_ENCRYPT_PROTOCOL);
    const wantEnc = canEnc && !(this.encBrokenUntil > Date.now());
    // つながらないときの調査用に、Minecraft が送ってきた WebSocket の条件を記録する（秘密の情報は入らない）
    // 圧縮の希望（Sec-WebSocket-Extensions）は DO には届かないので、入口（index.js）が ext に入れて渡している
    const ext =(request.headers.get("Sec-WebSocket-Extensions") || new URL(request.url).searchParams.get("ext") || "").slice(0, 120);
    const ua = (request.headers.get("User-Agent") || "").slice(0, 80);
    const ver = (request.headers.get("Sec-WebSocket-Version") || "").slice(0, 8);
    // どこを通ってきたか（入口の index.js が via に入れて渡す。コネクター: "1.0.0"、リレー: "relay:1.0.0"）
    const via = (new URL(request.url).searchParams.get("via") || request.headers.get("X-VC-Connector") || "").slice(0, 24);
    const viaRelay = via.startsWith("relay:");
    const viaName = !via ? "" : viaRelay ? "リレー" : "コネクター";
    const viaVer = viaRelay ? via.slice(6) : via;
    const detail = `${via ? `${viaName}経由（v${viaVer}）・` : ""}拡張: ${ext || "なし"}・サブプロトコル: ${offered.filter(Boolean).join(", ") || "なし"}・版: ${ver || "?"}${ua ? `・UA: ${ua}` : ""}`;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["mc"]);
    server.serializeAttachment({ init: false, since: Date.now(), wantEnc, scheme, sent: 0, recv: 0 });
    this.bdsMode = false;
    this.poll = null;
    await this.noteTry({ kind: "open", text: `✓ ${via ? `${viaName}経由で ` : ""}Minecraft から接続がきました${canEnc ? "（暗号化あり）" : ""}`, scheme, detail });
    await this.storage.setAlarm(Date.now() + 300); // 最初の設定は少し待ってから送る
    const headers = canEnc ? { "Sec-WebSocket-Protocol": WS_ENCRYPT_PROTOCOL } : {};
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /** Minecraft に送る（暗号化しているときは暗号化して、バイナリで送る） */
  rawSend(ws, obj) {
    const text = JSON.stringify(obj);
    const a = this.att(ws);
    a.sent = (a.sent || 0) + 1; // 切れたときに「いくつ送ったあとか」が分かるように
    if (a.enc) {
      const data = encryptText(a.enc, text);
      this.setAtt(ws, a);
      ws.send(data);
    } else {
      this.setAtt(ws, a);
      ws.send(text);
    }
  }

  /** Minecraft から届いたものを文字にする（暗号化されていたら復号）。順番が大事なので await の前に呼ぶ */
  decodeIncoming(ws, message) {
    const a = this.att(ws);
    a.recv = (a.recv || 0) + 1;
    this.setAtt(ws, a);
    if (typeof message === "string") return message;
    const bytes = new Uint8Array(message);
    if (a.enc) {
      const text = decryptBytes(a.enc, bytes);
      this.setAtt(ws, a);
      return text;
    }
    return new TextDecoder().decode(bytes);
  }

  mcSend(ws, purpose, body, requestId = crypto.randomUUID()) {
    this.rawSend(ws, {
      header: { version: 1, requestId, messagePurpose: purpose, messageType: "commandRequest" },
      body,
    });
    return requestId;
  }

  // ---- 暗号化の準備（Minecraft の enableencryption） ----
  async beginEncryption(ws) {
    const kx = await beginKeyExchange();
    const a = this.att(ws);
    if (a.init || a.enc || a.kx) return;
    const id = crypto.randomUUID();
    a.kx = { id, priv: kx.priv, salt: kx.salt, at: Date.now() };
    this.setAtt(ws, a);
    this.mcCommand(ws, kx.command, id); // ここまでは暗号化しないで送る
  }

  async finishEncryption(ws, body) {
    const a = this.att(ws);
    const kx = a.kx;
    if (!kx) return;
    let key = null;
    if (body && body.publicKey && !body.statusCode) {
      try { key = await finishKeyExchange(kx.priv, kx.salt, String(body.publicKey)); } catch (e) { key = null; }
    }
    const b = this.att(ws);
    delete b.kx;
    if (key) b.enc = newCipherState(key);
    else b.encFailed = true;
    this.setAtt(ws, b);
    if (!key) await this.noteTry({ kind: "info", text: "⚠ 暗号化の準備ができませんでした（暗号化なしで続けます）", scheme: b.scheme });
    await this.startSession(ws);
  }

  /** 暗号化がうまくいかなかった。しばらくは暗号化しないでつなぐ */
  async encryptionBroken(ws, why) {
    this.encBrokenUntil = Date.now() + ENC_BROKEN_MS;
    await this.storage.put("encBrokenUntil", this.encBrokenUntil);
    await this.noteTry({ kind: "error", text: `✗ 暗号化の通信でエラーになりました（${why}）。もう一度 /wsserver を打つと、暗号化なしでつなぎます。Minecraft の「暗号化された WebSocket を要求」はオフにしてください`, scheme: this.att(ws).scheme });
    try { ws.close(4002, "encryption error"); } catch (e) { /* 無視 */ }
  }

  /** 最初のあいさつ（イベントの登録・距離の設定・つながったメッセージ） */
  async startSession(ws) {
    if (this.att(ws).init) return;
    this.initSocket(ws);
    // 送ると暗号化の状態（attachment）が進むので、送ったあとに読み直してから書く
    const a = this.att(ws);
    a.init = true;
    a.initAt = Date.now();
    this.setAtt(ws, a);
    if (!this.poll) this.startPoll(ws);
    if (this.isWebRoom()) { this.webWorld(true); this.webStartPos(); }
  }

  diagInfo() {
    const ws = this.socket();
    const a = ws ? this.att(ws) : null;
    return {
      guildName: this.cfg?.guildName || "",
      kind: this.cfg?.kind || "discord",
      mode: this.liveMode(),
      encrypted: !!(a && a.enc),
      ready: !!(a && a.init),
      tries: (this.tries || []).map(x => ({ t: x.t, kind: x.kind, text: x.text, scheme: x.scheme || "", detail: x.detail || "" })),
      now: Date.now(),
    };
  }

  mcCommand(ws, commandLine, requestId) {
    return this.mcSend(ws, "commandRequest", { version: 1, commandLine, origin: { type: "player" } }, requestId);
  }

  tell(ws, name, text) {
    if (!ws) return;
    const target = name ? `@a[name=${quoteName(name)}]` : "@a";
    try { this.mcCommand(ws, `tellraw ${target} ${JSON.stringify({ rawtext: [{ text }] })}`); } catch (e) { /* 無視 */ }
  }

  sendConfig(ws) {
    try { this.mcCommand(ws, `scriptevent pcvc:config ${JSON.stringify({ radius: this.radius })}`); } catch (e) { /* 無視 */ }
  }

  initSocket(ws) {
    this.mcSend(ws, "subscribe", { eventName: "PlayerMessage" });
    this.sendConfig(ws);
    if (this.isWebRoom()) this.webAnnounce(ws);
    else
      this.tell(ws, null, `§a[近接VC] Discord「${this.cfg?.guildName || "サーバー"}」とつながりました（声が届く距離: ${this.radius}ブロック）`);
  }

  startPoll(ws) {
    const pending = new Map();
    for (const tag of TAGS) pending.set(this.mcCommand(ws, `testfor @a[tag=${tag}]`), tag);
    this.poll = { at: Date.now(), pending, results: {} };
  }

  async webSocketMessage(ws, message) {
    if (this.isChatSocket(ws)) return this.onChatMessage(ws, message);
    if (this.isWebSocket(ws)) return this.onWebMessage(ws, message);
    // 暗号化は順番どおりに復号しないといけないので、await より前にやる
    let text;
    try { text = this.decodeIncoming(ws, message); } catch (e) { text = ""; }
    let m = null;
    try { m = JSON.parse(text); } catch (e) { m = null; }
    if (!m || typeof m !== "object") {
      const a = this.att(ws);
      if (a.enc) {
        a.bad = (a.bad || 0) + 1;
        this.setAtt(ws, a);
        if (a.bad >= 3) await this.encryptionBroken(ws, "読めないデータ");
      }
      return;
    }
    const h = m.header || {}, b = m.body || {};
    const a0 = this.att(ws);
    if (a0.kx && h.requestId === a0.kx.id) {
      await this.finishEncryption(ws, b);
      return;
    }
    await this.useEnv();
    if (h.messagePurpose === "commandResponse") {
      if (this.webPos && await this.webOnResponse(h.requestId, b)) return;
      const p = this.poll;
      const tag = p && p.pending.get(h.requestId);
      if (!tag) return;
      p.pending.delete(h.requestId);
      p.results[tag] = b.statusCode === 0 && Array.isArray(b.victim) ? b.victim.map(String) : [];
      if (p.pending.size === 0) {
        this.poll = null;
        this.applyPoll(p.results);
        await this.reconcile();
      }
    } else if (h.messagePurpose === "event" && h.eventName === "PlayerMessage") {
      await this.onChat(ws, b);
    } else if (h.messagePurpose === "error") {
      console.log("minecraft error", JSON.stringify(b));
      const a = this.att(ws);
      if (!a.errNoted) {
        a.errNoted = true;
        this.setAtt(ws, a);
        await this.noteTry({ kind: "error", text: `⚠ Minecraft からエラー: ${String(b.statusMessage || b.statusCode || "").slice(0, 120)}`, scheme: a.scheme });
      }
    }
  }

  /** testfor の結果（タグ）から、だれがどの部屋かを組み立てる */
  applyPoll(results) {
    const desired = new Map();
    const bits = [0, 1, 2, 3, 4].map(k => new Set((results["pcvc_b" + k] || []).map(n => n.toLowerCase())));
    for (const name of results.pcvc_on || []) {
      const lower = name.toLowerCase();
      let room = 0;
      for (let k = 0; k < 5; k++) if (bits[k].has(lower)) room |= 1 << k;
      desired.set(lower, { name, room });
    }
    this.desired = desired;
    this.lastUpdate = Date.now();
  }

  async onChat(ws, body) {
    const sender = String(body.sender || "").trim();
    if (this.isWebRoom()) return this.webOnChat(ws, sender, body.message, String(body.type || "chat"));
    const m = /^!vc\s+(\d{4})$/i.exec(String(body.message || "").trim());
    if (!m || !sender) return;
    const r = await this.confirmLink(sender, m[1]);
    this.tell(ws, sender, r.ok ? `§a[近接VC] Discord の「${r.userTag}」と紐付けました！` : `§c[近接VC] ${r.error}`);
    if (r.ok) await this.reconcile();
  }

  async webSocketClose(ws, code, reason) {
    // 返事の close は、正しい範囲のコードでしか送れない（範囲外だと例外になる）
    try { ws.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000, "bye"); } catch (e) { /* 無視 */ }
    if (this.isChatSocket(ws)) return this.onChatClose(ws);
    if (this.isWebSocket(ws)) return this.onWebClose(ws);
    await this.noteClose(ws, code, reason);
    await this.onSocketGone(ws);
  }

  async webSocketError(ws, error) {
    if (this.isChatSocket(ws)) return this.onChatClose(ws);
    if (this.isWebSocket(ws)) return this.onWebClose(ws);
    await this.noteClose(ws, "error", String((error && error.message) || error || ""));
    await this.onSocketGone(ws);
  }

  /** 切れたことを記録（どれだけつながっていたか・何件やりとりしたか・コードの意味） */
  async noteClose(ws, code, reason = "") {
    const a = this.att(ws);
    if (a.closeNoted) return;
    a.closeNoted = true;
    this.setAtt(ws, a);
    const ms = a.since ? Date.now() - a.since : 0;
    const dur = ms < 10000 ? `${(ms / 1000).toFixed(2)}秒` : ms < 3600000 ? `${Math.round(ms / 60000)}分` : `${Math.round(ms / 3600000)}時間`;
    const c = describeClose(code);
    const traffic = `Bot→MC ${a.sent || 0}件・MC→Bot ${a.recv || 0}件`;
    let hint = "";
    if (!a.init && ms < 15000) {
      hint = c.base === 1002
        ? "。Minecraft が WebSocket のやりとりの形を受け付けずに切りました"
        : "。つながってすぐ切れました";
    }
    await this.noteTry({
      kind: "close",
      text: `切れました（${dur}・${c.text}）${hint}`,
      detail: `${traffic}${reason ? `・理由: ${String(reason).slice(0, 60)}` : ""}${a.enc ? "・暗号化中" : ""}`,
      scheme: a.scheme,
    });
  }

  async onSocketGone(ws) {
    await this.useEnv();
    if (this.socket(ws)) return; // ほかのワールドがつながっている
    this.poll = null;
    this.desired = new Map();
    if (this.isWebRoom()) this.webWorld(false);
    await this.reconcile(); // 全員ロビーへ
  }

  async alarm() {
    await this.useEnv();
    const now = Date.now();
    const ws = this.socket();
    if (ws) {
      const att = this.att(ws);
      if (!att.init) {
        if (att.wantEnc && !att.enc && !att.encFailed) {
          // 暗号化の準備（Minecraft の返事を待つ）
          if (!att.kx) await this.beginEncryption(ws);
          else if (now - att.kx.at > ENC_TIMEOUT_MS) {
            const a = this.att(ws);
            delete a.kx;
            a.encFailed = true;
            this.setAtt(ws, a);
            await this.noteTry({ kind: "info", text: "⚠ 暗号化の返事がありませんでした（暗号化なしで続けます）", scheme: a.scheme });
            await this.startSession(ws);
          }
          await this.storage.setAlarm(Date.now() + 500);
          return;
        }
        await this.startSession(ws);
      }
      // サイト内VC: サイトにだれもいないときは、位置もグループも読まない（30 秒ごとに、つながっているかだけ確かめる）
      if (this.isWebRoom() && !this.webSockets().length) {
        try { this.mcCommand(ws, "testfor @a"); } catch (e) { /* 無視 */ }   // 何も流れないと、リレーが 10 分で切るので
        await this.storage.setAlarm(now + WEB_IDLE_MS);
        return;
      }
      if (!this.poll || now - this.poll.at > 6000) this.startPoll(ws);
      // サイト内VC: 位置を読むのが止まっていたら、やり直す（部屋がメモリから消えたあとなど）
      if (this.isWebRoom()) { if (!this.webPos) this.webStartPos(); else await this.webPosTick(); }
      await this.storage.setAlarm(now + POLL_MS);
      return;
    }
    if ((this.bdsMode && now - this.lastUpdate >= this.staleMs) || (!this.bdsMode && this.bdsPersisted)) {
      // BDS からの送信が止まった（サーバーが止まった）ので全員ロビーへ
      this.bdsMode = false;
      this.bdsPersisted = false;
      await this.storage.delete("bdsActive");
      this.desired = new Map();
      this.softRetry = 0;
      await this.reconcile();
    } else if ((this.softRetry && now >= this.softRetry) || (this.retryAt && now >= this.retryAt)) {
      this.softRetry = 0;
      if (this.retryAt && now >= this.retryAt) this.retryAt = 0;
      await this.reconcile();
    }
    await this.armAlarm();
  }

  /** ポーリングしていないときの、次の目覚まし（BDS の見張り・やり直し） */
  async armAlarm() {
    if (this.socket()) return; // ワールド用は 1.5秒ごとに動いている
    const times = [];
    if (this.bdsMode) times.push(this.lastUpdate + this.staleMs + 1000);
    else if (this.bdsPersisted) times.push(Date.now() + 1000);
    if (this.softRetry) times.push(this.softRetry);
    if (this.retryAt) times.push(this.retryAt + 100);
    if (!times.length) return;
    const t = Math.max(Date.now() + 50, Math.min(...times));
    const cur = await this.storage.getAlarm();
    if (!cur || cur > t || cur < Date.now()) await this.storage.setAlarm(t);
  }

  // ------------------------------------------------------------------
  //  BDS 用
  // ------------------------------------------------------------------
  async onBdsUpdate(body) {
    const secret = String((body && body.key) || "").split(".")[1];
    if (!this.cfg) return json({ ok: false, error: "このサーバーでは、まだ /vc setup がされていません。" }, 404);
    if (!this.checkSecret(secret)) return json({ ok: false, error: "接続キーがちがいます。Discord で /vc key を確認してください。" }, 403);
    const now = Date.now();

    const results = [];
    for (const c of Array.isArray(body.confirms) ? body.confirms.slice(0, 10) : []) {
      const r = await this.confirmLink(String((c && c.gamertag) || ""), String((c && c.code) || ""));
      results.push({
        gamertag: c && c.gamertag,
        ok: r.ok,
        message: r.ok ? `§a[近接VC] Discord の「${r.userTag}」と紐付けました！` : `§c[近接VC] ${r.error}`,
      });
    }

    if (body.players && typeof body.players === "object") {
      const desired = new Map();
      for (const [name, room] of Object.entries(body.players).slice(0, 200)) {
        const r = Number(room) | 0;
        desired.set(String(name).toLowerCase(), { name: String(name), room: r >= 0 && r <= DEAD_ROOM ? r : 0 });
      }
      this.desired = desired;
    }
    if (!this.bdsMode && !this.bdsPersisted) await this.storage.put("bdsActive", true);
    this.bdsMode = true;
    this.bdsPersisted = true;
    this.lastUpdate = now;

    await this.reconcile();
    await this.armAlarm();

    if (this.prunePending()) await this.savePending();
    const linkRequests = Object.entries(this.pending).map(([code, p]) => ({ code, gamertag: p.gamertag, discord: p.userTag }));
    return json({ ok: true, radius: this.radius, linkRequests, results });
  }

  async onCheck(secret) {
    if (!this.cfg) return json({ ok: false, error: "このサーバーでは、まだ Discord で /vc setup がされていません。" }, 404);
    if (!this.checkSecret(secret)) return json({ ok: false, error: "接続キーがちがいます（/vc rekey で変わった可能性があります）。" }, 403);
    return json({
      ok: true,
      guildName: this.cfg.guildName || "",
      radius: this.radius,
      mode: this.liveMode(),
      linked: Object.keys(this.links).length,
      shortCode: this.cfg.shortCode || null,
      inGame: this.desired.size,
      lastUpdate: this.lastUpdate || null,
      tries: this.diagInfo().tries,
      now: Date.now(),
    });
  }

  // ------------------------------------------------------------------
  //  紐付け
  // ------------------------------------------------------------------
  async confirmLink(gamertag, code) {
    gamertag = String(gamertag || "").trim();
    if (this.prunePending()) await this.savePending();
    const p = this.pending[code];
    if (!p) return { ok: false, error: "そのコードは見つかりませんでした（10分で切れます）。Discord で /vc link をやり直してください。" };
    if (p.gamertag.toLowerCase() !== gamertag.toLowerCase())
      return { ok: false, error: `このコードは「${p.gamertag}」用です。Discord の /vc link で入れた名前を確認してください。` };
    const lower = gamertag.toLowerCase();
    for (const [k, v] of Object.entries(this.links)) {
      if (k === lower || v.userId === p.userId) delete this.links[k];
    }
    this.links[lower] = { userId: p.userId, userTag: p.userTag, gamertag, linkedAt: Date.now() };
    delete this.pending[code];
    this.current.delete(p.userId);
    await this.saveLinks();
    await this.savePending();
    await editOriginal(this.env, p.token,
      `✅ Minecraft の「${gamertag}」と紐付けました！\n` +
      `遊ぶときは「${LOBBY_NAME}」に入っておくと、ゲームの中の位置に合わせて自動でVCが切り替わります。`);
    return { ok: true, userTag: p.userTag };
  }

  // ------------------------------------------------------------------
  //  VC の移動
  // ------------------------------------------------------------------
  async targetChannel(room, rest) {
    const cfg = this.cfg;
    if (room === DEAD_ROOM) return cfg.deadId;
    if (room >= 1 && room <= MAX_ROOM) {
      if (cfg.rooms[room]) return cfg.rooms[room];
      const r = await rest.call("POST", `/guilds/${cfg.guildId}/channels`, { name: roomName(room), type: 2, parent_id: cfg.categoryId });
      if (r.ok && r.data && r.data.id) {
        cfg.rooms[room] = r.data.id;
        this.cfgDirty = true;
        return r.data.id;
      }
      console.log("create room failed", r.status, JSON.stringify(r.data));
      return null;
    }
    return cfg.lobbyId;
  }

  async reconcile() {
    const cfg = this.cfg;
    if (!cfg || !cfg.lobbyId) return;
    const now = Date.now();
    if (this.retryAt && now < this.retryAt) return;
    const rest = new DiscordRest(this.env, 24);
    const managed = new Set([cfg.lobbyId, cfg.deadId, ...Object.values(cfg.rooms || {})]);
    this.cfgDirty = false;
    let deferred = false;

    // 移動が必要そうな人から先に
    const jobs = Object.values(this.links).map(link => {
      const d = this.desired.get(link.gamertag.toLowerCase());
      return { link, room: d ? d.room : 0 };
    });
    const known = job => cfg.rooms[job.room] || (job.room === DEAD_ROOM ? cfg.deadId : job.room === 0 ? cfg.lobbyId : null);
    jobs.sort((a, b) => {
      const ca = this.current.get(a.link.userId), cb = this.current.get(b.link.userId);
      const na = ca && ca.channelId === known(a) ? 1 : 0, nb = cb && cb.channelId === known(b) ? 1 : 0;
      return na - nb;
    });

    try {
      for (const { link, room } of jobs) {
        const uid = link.userId;
        const cur = this.current.get(uid);
        const k = known({ room });
        if (k && cur && cur.channelId === k && now - cur.at < VERIFY_MS) continue;
        if (cur && (cur.state === "notInVoice" || cur.state === "other") && now - cur.at < RECHECK_MS) continue;
        if (now - (this.lastMove.get(uid) || 0) < MOVE_COOLDOWN_MS) { deferred = true; continue; }

        const vs = await rest.call("GET", `/guilds/${cfg.guildId}/voice-states/${uid}`);
        const ch = vs.ok && vs.data && vs.data.channel_id ? String(vs.data.channel_id) : null;
        if (!ch) { this.current.set(uid, { channelId: null, at: now, state: "notInVoice" }); continue; }
        if (!managed.has(ch)) { this.current.set(uid, { channelId: ch, at: now, state: "other" }); continue; }

        const target = await this.targetChannel(room, rest);
        if (!target) continue;
        if (ch === target) { this.current.set(uid, { channelId: ch, at: now, state: "ok" }); continue; }

        const mv = await rest.call("PATCH", `/guilds/${cfg.guildId}/members/${uid}`, { channel_id: target });
        if (mv.ok) {
          this.current.set(uid, { channelId: target, at: now, state: "ok" });
          this.lastMove.set(uid, now);
        } else if (mv.code === 40032) {
          this.current.set(uid, { channelId: null, at: now, state: "notInVoice" });
        } else if (mv.code === 10003) {
          // VC が消されていた
          for (const [n, id] of Object.entries(cfg.rooms)) if (id === target) delete cfg.rooms[n];
          this.cfgDirty = true;
        } else {
          this.current.set(uid, { channelId: ch, at: now, state: mv.status === 403 ? "noPerm" : "error" });
          console.log("move failed", mv.status, JSON.stringify(mv.data));
        }
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.retryAt = now + Math.ceil(e.retryAfter * 1000);
      } else if (e instanceof BudgetError) {
        deferred = true; // 1回で動かしきれなかった分は、すぐあとで
      } else {
        console.log("reconcile error", e && e.stack ? e.stack : e);
      }
    }
    if (this.cfgDirty) await this.saveCfg();
    if (deferred) this.softRetry = Math.max(this.softRetry, now + MOVE_COOLDOWN_MS + 200);
    if (deferred || this.retryAt) await this.armAlarm();
  }

  // ------------------------------------------------------------------
  //  スラッシュコマンド
  // ------------------------------------------------------------------
  async onInteraction(it, origin) {
    const sub = it.data && it.data.options && it.data.options[0];
    const opts = {};
    for (const o of (sub && sub.options) || []) opts[o.name] = o.value;
    let reply;
    try {
      switch (sub && sub.name) {
        case "setup": reply = await this.cmdSetup(it, opts, origin); break;
        case "link": reply = await this.cmdLink(it, opts); break;
        case "unlink": reply = await this.cmdUnlink(it, opts); break;
        case "status": reply = await this.cmdStatus(it); break;
        case "distance": reply = await this.cmdDistance(it, opts); break;
        case "reset": reply = await this.cmdReset(it); break;
        case "key": reply = await this.cmdKey(it, origin); break;
        case "rekey": reply = await this.cmdRekey(it, origin); break;
        case "addon": reply = await this.cmdAddon(it, opts, origin); break;
        default: reply = "このコマンドには対応していません。";
      }
    } catch (e) {
      console.log("command error", e && e.stack ? e.stack : e);
      reply = e instanceof RateLimitError
        ? `Discord の回数制限にかかりました。${Math.ceil(e.retryAfter)}秒ほど待ってから、もう一度ためしてください。`
        : "エラーが起きました: " + (e && e.message ? e.message : e);
    }
    await editOriginal(this.env, it.token, reply);
  }

  adminOnly(it) {
    return hasPerm(it.member, PERM.MANAGE_GUILD) ? null : "このコマンドは「サーバー管理」の権限がある人だけが使えます。";
  }

  /** 短い接続コードを用意する（なければ作って、名簿に登録） */
  async ensureShortCode(renew = false) {
    if (this.cfg.shortCode && !renew) return this.cfg.shortCode;
    const dir = this.env.GUILD.get(this.env.GUILD.idFromName(DIRECTORY));
    const old = this.cfg.shortCode || null;
    for (let i = 0; i < 5; i++) {
      const code = newShortCode();
      const r = await (await dir.fetch("https://room/dir/put", { method: "POST", body: JSON.stringify({ code, guildId: this.cfg.guildId, oldCode: old }) })).json();
      if (r.ok) { this.cfg.shortCode = code; await this.saveCfg(); return code; }
    }
    throw new Error("接続コードを作れませんでした。もう一度ためしてください。");
  }

  /** リレー（Google Cloud の VM・Railway など）のアドレス。/setup/ か Cloudflare の変数 RELAY_HOST で設定したもの。なければ "" */
  get relayHost() {
    return (this.env && this.env.RELAY_HOST) || "";
  }

  /**
   * Minecraft で送るコマンド。
   * リレーがあるとき: /wsserver ws://<リレー>/v/<コード>（Minecraft から直接）
   * ないとき: /wsserver ws://<この Worker>/v/<コード>（近接VC コネクターに貼る）
   */
  wsCommand(origin) {
    if (this.relayHost) return this.relayCommand();
    return this.connectorCommand(origin);
  }

  relayCommand() {
    return `/wsserver ws://${this.relayHost}/v/${this.cfg.shortCode}`;
  }

  /** 近接VC コネクターに貼るコマンド（Worker に直接） */
  connectorCommand(origin) {
    const host = origin ? new URL(origin).host : "（Bot のURL）";
    return `/wsserver ws://${host}/v/${this.cfg.shortCode}`;
  }

  siteButton(label = "サイトでくわしく見る（接続キー入力ずみ）") {
    const site = (this.env.SITE_URL || "").replace(/\/$/, "");
    return { label, url: `${site}/vc/discord/#key=${this.key}` };
  }

  /** つながらないときに、どこで止まっているかを見るページ */
  checkButton(label = "つながらないとき（接続チェック）") {
    const site = (this.env.SITE_URL || "").replace(/\/$/, "");
    return { label, url: `${site}/v/${this.cfg.shortCode}` };
  }

  /** ワールド用アドオンのファイル（Bot の中で作る） */
  async addonFile(mode, origin) {
    if (!hasAddonTemplate()) return null;
    const a = buildVcAddon({ mode, api: origin || "", key: this.key, last: this.cfg.lastAddonVersion || null });
    this.cfg.lastAddonVersion = a.version;
    await this.saveCfg();
    return { name: a.name, data: a.data };
  }

  /** 近接VC コネクター（Windows 用の中継アプリ）のダウンロード */
  connectorButton(label = this.relayHost ? "予備: 近接VC コネクター（Windows）" : "近接VC コネクターをダウンロード") {
    const site = (this.env.SITE_URL || "").replace(/\/$/, "");
    return { label, url: `${site}/download/MaYoVCConnector.zip` };
  }

  /** ワールド用の案内につけるボタン（リレーがあるときは、コネクターは予備なので最後） */
  worldButtons() {
    return this.relayHost
      ? [this.checkButton(), this.siteButton(), this.connectorButton()]
      : [this.connectorButton(), this.siteButton(), this.checkButton()];
  }

  /** ワールドでの始め方（setup・key で使う） */
  worldSteps(origin, hasFile) {
    return [
      this.relayHost ? "**ワールドで遊ぶとき（ホストがやること）**" : "**ワールドで遊ぶとき（ホストがやること・Windows の PC）**",
      hasFile ? "1. 下のファイルをひらく（近接VCアドオンが Minecraft に入ります）" : "1. サイトの近接VCページで、近接VCアドオンを作って入れる",
      "2. ワールドの設定で「チート」をオン、ビヘイビアパックで「近接VC BP」をオン",
      ...this.commandLines(origin, 3),
    ];
  }

  /**
   * つなぎ方。Minecraft の /wsserver は Cloudflare に直接つなぐと 0.3 秒で切れてしまう（1002）。
   * （Minecraft は返事の「Connection: Upgrade」が大文字でないと切る。Cloudflare は小文字で返す）
   * リレー（Google Cloud の VM・Railway など）があれば、Minecraft からリレーにつなぐ。なければ PC の中で中継する「近接VC コネクター」を使う。
   */
  commandLines(origin, n = 1) {
    if (this.relayHost) {
      return [
        `${n}. ワールドに入って、チャットでこれを送る（ワールドを開くたびに）`,
        "```" + this.relayCommand() + "```",
        "→「[近接VC] … とつながりました」と出たら完成！（つながらないときは「接続チェック」ボタンへ）",
        "（リレーが止まっているときは、予備の「近接VC コネクター」でもつなげます。くわしくは接続チェックのページへ）",
      ];
    }
    return [
      `${n}. 下のボタンから「近接VC コネクター」をダウンロードしてひらき、このコマンドを貼り付けて「スタート」`,
      "```" + this.connectorCommand(origin) + "```",
      `${n + 1}. ワールドに入って、チャットでこれを送る（ワールドを開くたびに）`,
      "```/wsserver ws://127.0.0.1:19131```",
      "→「[近接VC] … とつながりました」と出たら完成！（つながらないときは「接続チェック」ボタンへ）",
    ];
  }

  playerSteps() {
    return [
      "**遊ぶ人みんな**",
      "`/vc link` で自分の名前を選ぶ → マイクラのチャットで `!vc 1234`（Bot が教える番号）→「" + LOBBY_NAME + "」に入る",
    ];
  }

  keyLine() {
    return `🔑 接続キー（BDS・サイトで使います。ほかの人に見せないでください）: ||${this.key}||`;
  }

  async cmdSetup(it, opts, origin) {
    const denied = this.adminOnly(it);
    if (denied) return denied;
    const g = it.guild_id;
    const rest = new DiscordRest(this.env, 40);
    const cfg = this.cfg || { guildId: g, secret: newSecret(), radius: DEFAULT_RADIUS, rooms: {} };
    cfg.guildId = g;
    cfg.rooms = cfg.rooms || {};
    this.cfg = cfg;

    const permError = r => (r.status === 403 || r.code === 50013)
      ? "Bot の権限が足りません。サイトの「Bot を招待」からもう一度招待するか、Bot に「チャンネルの管理」「メンバーを移動」「接続」の権限をつけてください。"
      : `Discord でエラーが起きました（${r.status}）。少し待ってからもう一度ためしてください。`;

    try {
      const gi = await rest.call("GET", `/guilds/${g}`);
      if (!gi.ok) return permError(gi);
      cfg.guildName = gi.data.name;
      const chs = await rest.call("GET", `/guilds/${g}/channels`);
      if (!chs.ok) return permError(chs);
      const exists = new Set(chs.data.map(c => String(c.id)));

      const create = async (name, type, parent) => {
        const r = await rest.call("POST", `/guilds/${g}/channels`, parent ? { name, type, parent_id: parent } : { name, type });
        if (!r.ok) throw Object.assign(new Error(permError(r)), { friendly: true });
        return String(r.data.id);
      };
      if (!cfg.categoryId || !exists.has(cfg.categoryId)) cfg.categoryId = await create(CATEGORY_NAME, 4);
      if (!cfg.lobbyId || !exists.has(cfg.lobbyId)) cfg.lobbyId = await create(LOBBY_NAME, 2, cfg.categoryId);
      if (!cfg.deadId || !exists.has(cfg.deadId)) cfg.deadId = await create(DEAD_NAME, 2, cfg.categoryId);
      for (const [n, id] of Object.entries(cfg.rooms)) if (!exists.has(id)) delete cfg.rooms[n];
      const want = Math.max(1, Math.min(20, Number(opts.rooms) || 4));
      for (let n = 1; n <= want; n++) if (!cfg.rooms[n]) cfg.rooms[n] = await create(roomName(n), 2, cfg.categoryId);
    } catch (e) {
      await this.saveCfg();
      if (e.friendly) return e.message;
      throw e;
    }
    await this.saveCfg();
    await this.ensureShortCode();
    const file = await this.addonFile("world", origin);
    return {
      content: [
        `✅ 近接VC の準備ができました！（${cfg.guildName}）`,
        `VC: ${LOBBY_NAME} ／ ${DEAD_NAME} ／ ${roomName(1)}〜${Object.keys(cfg.rooms).length}（足りなくなったら自動で増えます）`,
        "",
        ...this.worldSteps(origin, !!file),
        "",
        ...this.playerSteps(),
        "",
        "BDS（サーバー）で使うときは `/vc addon type:BDS用` か、下のボタンからサイトへ。",
        this.keyLine(),
      ].join("\n"),
      files: file ? [file] : [],
      buttons: this.worldButtons(),
    };
  }

  async cmdKey(it, origin) {
    const denied = this.adminOnly(it);
    if (denied) return denied;
    if (!this.cfg) return "まだ準備ができていません。先に `/vc setup` をしてください。";
    await this.ensureShortCode();
    return {
      content: [this.relayHost ? "**ワールドでつなぐとき**（ホスト）" : "**ワールドでつなぐとき**（ホスト・Windows の PC）", ...this.commandLines(origin), "", this.keyLine()].join("\n"),
      buttons: this.worldButtons(),
    };
  }

  async cmdAddon(it, opts, origin) {
    if (!this.cfg) return "まだ準備ができていません。管理者が `/vc setup` をしてください。";
    const mode = opts.type === "bds" ? "bds" : "world";
    if (mode === "bds") {
      const denied = this.adminOnly(it);
      if (denied) return "BDS用には接続キーが入るので、" + denied;
    }
    await this.ensureShortCode();
    const file = await this.addonFile(mode, origin);
    if (!file) return { content: "Bot にアドオンが入っていません。下のボタンからサイトで作ってください。", buttons: [this.siteButton()] };
    const lines = mode === "bds"
      ? ["📦 **近接VCアドオン（BDS用）**です。接続キーが入っているので、ほかの人に配らないでください。",
        "1. サーバーのワールドにビヘイビアパックとして入れる",
        "2. ワールドの実験的機能「ベータ API」をオン",
        "3. `config/default/permissions.json` の `allowed_modules` に `\"@minecraft/server-net\"` を足す",
        "4. サーバーを再起動（くわしくは下のボタンからサイトへ）"]
      : ["📦 **近接VCアドオン（ワールド用）**です。", ...this.worldSteps(origin, true).slice(1)];
    return { content: lines.join("\n"), files: [file], buttons: mode === "bds" ? [this.siteButton()] : this.worldButtons() };
  }

  async cmdRekey(it, origin) {
    const denied = this.adminOnly(it);
    if (denied) return denied;
    if (!this.cfg) return "まだ準備ができていません。先に `/vc setup` をしてください。";
    this.cfg.secret = newSecret();
    await this.saveCfg();
    await this.ensureShortCode(true);
    for (const ws of this.ctx.getWebSockets("mc")) {
      try { ws.close(4001, "接続キーが変わりました"); } catch (e) { /* 無視 */ }
    }
    return {
      content: ["🔁 接続キーと接続コードを作り直しました。前のものはもう使えません。",
        "BDS の人は `/vc addon type:BDS用` で新しいアドオンを入れ直してください。", "",
        this.relayHost ? "**ワールドでつなぐとき**（新しいコマンドで送り直してください）" : "**ワールドでつなぐとき**（コネクターに新しいコマンドを貼り直してください）",
        ...this.commandLines(origin), "", this.keyLine()].join("\n"),
      buttons: this.worldButtons(),
    };
  }

  async cmdLink(it, opts) {
    if (!this.cfg) return "まだ準備ができていません。管理者が `/vc setup` をしてください。";
    const gamertag = String(opts.gamertag || "").trim();
    if (!gamertag || gamertag.length > 32 || /["\\@\n]/.test(gamertag)) return "マイクラの名前（ゲーマータグ）が正しくありません。";
    const user = (it.member && it.member.user) || it.user;
    const userTag = user.global_name || user.username;
    this.prunePending();
    for (const [c, p] of Object.entries(this.pending)) if (p.userId === user.id) delete this.pending[c];
    let code;
    do { code = String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000)); } while (this.pending[code]);
    this.pending[code] = { userId: user.id, userTag, gamertag, token: it.token, expires: Date.now() + LINK_TTL_MS };
    await this.savePending();

    this.tell(this.socket(), gamertag, `§e[近接VC] Discord の「${userTag}」から紐付けのリクエストが来ました。チャットで §f!vc ${code}§e と送ってください。`);

    const other = this.links[gamertag.toLowerCase()];
    return [
      `🔗 マイクラの「${gamertag}」と紐付けます（10分以内にやってください）`,
      "",
      `**ワールドで遊んでいるとき**: マイクラのチャットで \`!vc ${code}\` と送る`,
      `**BDS（サーバー）で遊んでいるとき**: ゲームの中に確認の画面が出るので「紐付ける」を押す`,
      "",
      "終わると、このメッセージが ✅ に変わります。",
      other && other.userId !== user.id ? `\n⚠ 「${gamertag}」は今「${other.userTag}」と紐付いています。確認すると入れ替わります。` : "",
    ].join("\n");
  }

  /** /vc link の名前の候補（ゲームにいる人。紐付けていない人が先） */
  async onAutocomplete(it) {
    const sub = it.data && it.data.options && it.data.options[0];
    const focused = ((sub && sub.options) || []).find(o => o.focused);
    const typed = String((focused && focused.value) || "").toLowerCase();
    const names = [...this.desired.values()].map(d => d.name)
      .filter(n => !typed || n.toLowerCase().includes(typed))
      .sort((a, b) => (this.links[a.toLowerCase()] ? 1 : 0) - (this.links[b.toLowerCase()] ? 1 : 0) || a.localeCompare(b));
    const choices = names.slice(0, 25).map(n => ({ name: this.links[n.toLowerCase()] ? `${n}（紐付けずみ）` : n, value: n }));
    if (typed && !names.some(n => n.toLowerCase() === typed) && choices.length < 25) {
      const raw = String(focused.value).trim().slice(0, 32);
      if (raw) choices.push({ name: `${raw}（入力した名前）`, value: raw });
    }
    return json({ type: 8, data: { choices } });
  }

  async cmdUnlink(it, opts) {
    const me = ((it.member && it.member.user) || it.user).id;
    const target = opts.user ? String(opts.user) : me;
    if (target !== me) {
      const denied = this.adminOnly(it);
      if (denied) return denied;
    }
    const removed = [];
    for (const [k, v] of Object.entries(this.links)) {
      if (v.userId === target) { removed.push(v.gamertag); delete this.links[k]; }
    }
    await this.saveLinks();
    this.current.delete(target);
    return removed.length ? `紐付けを外しました（${removed.join(", ")}）。` : "紐付けはありませんでした。";
  }

  async cmdDistance(it, opts) {
    const denied = this.adminOnly(it);
    if (denied) return denied;
    if (!this.cfg) return "まだ準備ができていません。先に `/vc setup` をしてください。";
    const n = Math.max(4, Math.min(128, Number(opts.blocks) || DEFAULT_RADIUS));
    this.cfg.radius = n;
    await this.saveCfg();
    const ws = this.socket();
    if (ws) { this.sendConfig(ws); this.tell(ws, null, `§a[近接VC] 声が届く距離を ${n} ブロックにしました`); }
    return `📏 声が届く距離を **${n}ブロック** にしました。${ws ? "（ゲームにもすぐ反映しました）" : "（ゲームがつながると反映されます）"}`;
  }

  async cmdReset(it) {
    const denied = this.adminOnly(it);
    if (denied) return denied;
    if (!this.cfg) return "まだ準備ができていません。先に `/vc setup` をしてください。";
    this.desired = new Map();
    this.current.clear();
    this.lastMove.clear();
    this.retryAt = 0;
    await this.reconcile();
    return `全員を「${LOBBY_NAME}」に戻しました。${this.liveMode() ? "（ゲームがつながっているので、また自動で分かれます）" : ""}`;
  }

  async cmdStatus(it) {
    if (!this.cfg) return "まだ準備ができていません。管理者が `/vc setup` をしてください。";
    const cfg = this.cfg;
    const mode = this.liveMode();
    const conn = mode === "ws" ? "🟢 ワールド（/wsserver）とつながっています"
      : mode === "bds" ? `🟢 BDS から受信中（${ago(Date.now() - this.lastUpdate)}）`
      : "⚪ ゲームとつながっていません";
    const chName = id => id === cfg.lobbyId ? LOBBY_NAME : id === cfg.deadId ? DEAD_NAME
      : (Object.entries(cfg.rooms).find(([, v]) => v === id) || [])[0] ? roomName(Object.entries(cfg.rooms).find(([, v]) => v === id)[0]) : "ほかのVC";
    const lines = [conn, `📏 声が届く距離: ${this.radius}ブロック`, ""];
    const links = Object.values(this.links);
    lines.push(`👥 紐付けた人（${links.length}人）`);
    for (const l of links) {
      const d = this.desired.get(l.gamertag.toLowerCase());
      const game = !d ? "ゲームにいない" : d.room === DEAD_ROOM ? "死亡中" : d.room ? `グループ ${d.room}` : "ゲーム中";
      const cur = this.current.get(l.userId);
      const vc = !cur ? "確認中" : cur.state === "notInVoice" ? "⚠ VCに入っていません"
        : cur.state === "other" ? "⚠ 近接VC以外のVCにいます" : cur.state === "noPerm" ? "⚠ 移動の権限がありません"
        : chName(cur.channelId);
      lines.push(`・<@${l.userId}> … ${l.gamertag}（${game}）→ ${vc}`);
    }
    const unlinked = [...this.desired.values()].filter(d => !this.links[d.name.toLowerCase()]).map(d => d.name);
    if (unlinked.length) lines.push("", `❔ ゲームにいるけど紐付けていない人: ${unlinked.join(", ")}`);
    if (mode !== "bds") {
      const recent = (this.tries || []).slice(0, 3);
      lines.push("", "🔌 Minecraft（/wsserver）からの接続の記録");
      if (recent.length) for (const x of recent) lines.push("・" + GuildRoom.tryLine(x));
      else lines.push("・まだ一度も届いていません（Minecraft 側で止まっています。`/vc key` の「接続チェック」を見てください）");
    }
    return lines.join("\n");
  }
}

// サイト内の近接VC（webvc.js）のメソッドを足す
Object.assign(GuildRoom.prototype, webMethods);
// ゲストのチャット（chat.js）
Object.assign(GuildRoom.prototype, chatMethods, {
  isChatSocket(ws) { try { return this.ctx.getTags(ws).includes(CHAT_TAG); } catch (e) { return false; } },
});
