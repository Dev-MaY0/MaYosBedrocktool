// =====================================================================
//  サイト内の近接VC（ブラウザどうしで話す）… Discord を使わない部屋
//
//  しくみ
//   - 部屋（Durable Object "web:<内部ID>"。内部 ID は 32 文字のランダムな文字。人が打つ 6 けたの部屋番号は、名簿（__directory__）で内部 ID につなぐ）は GuildRoom と同じクラスで、cfg.kind = "web"
//   - Minecraft はこれまでと同じ /wsserver（ワールドの接続コード）で部屋につながる
//   - 部屋は querytarget で、みんなの位置（座標・向き・ディメンション）を 1 秒に約 3 回読む
//   - 部屋は 2 通りで作れる: サイトで作る（/api/web/rooms）／マイクラで /wsserver ws://<リレー>/new を送る
//     マイクラで作ったときは、部屋番号（6 けた）をゲームに出し、管理キーは送った人（@s）にだけ出す
//   - ブラウザは /api/web/socket で部屋につながり、
//       ・ワールドにいる人の一覧から「自分を選択」して入る（かんたん。部屋の設定で !vc を必須にもできる）
//       ・マイクラのチャットで「!vc 123456」を送ると本人確認（✓）。ゲーム中チャットがマイクラにも出る
//       ・「観戦者」でも入れる（死んだ人と同じあつかい。部屋のルールで、話せる相手が決まる）
//       ・位置を受け取って、相手との距離で音量、向きで左右を決める（音声はブラウザどうしの WebRTC）
//       ・WebRTC のつなぎ方（シグナリング）は、この部屋が中継する
//   - 死亡: 近接VC アドオンが入っていれば、死んだ人（グループ 31）は死んだ人どうしだけ聞こえる
//   - ゲームにいない人どうし（ワールドが閉じているときも）は、ロビーとして全員の声が聞こえる
//
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

export const WEB_TAG = "web";
const POS_MS = 330;                 // 位置を読む間隔
const POS_STALL_MS = 2500;          // 返事がこない時は、これだけ待ってから読み直す
const NAME_RETRY_MS = 5000;         // ゲームにいなかった人を、もう一度さがす間隔
const CODE_TTL_MS = 10 * 60000;     // 本人確認のコードの有効時間
const SESSION_TTL_MS = 30 * 86400000; // 本人確認ずみのブラウザを覚えておく時間
const MAX_SESSIONS = 300;
const MAX_MEMBERS = 40;             // 1 部屋で同時に話せる人数
const MAX_MSG = 32768;
const TURN_TTL_S = 12 * 3600;
const DEAD_ROOM = 31;
const NAME_BAD = /["\\@\n\r\t]/;
const LIST_MS = 2500;               // ワールドにいる人の一覧（testfor @a）を読む間隔
const ADMIN_SHOW_MS = 10 * 60000;   // マイクラで作った部屋の管理キーを、!vc admin で出せる時間
// 部屋のルール（管理者設定）
//   talk   … 観戦者（死んだ人・サイトで観戦者をえらんだ人）の声: none 話せない / near 近くだけ / spectators 観戦者どうし
//   listen … 観戦者は、生きている人の声を（距離に関係なく）聞ける
//   verify … 入り方: pick 自分をえらぶ / code マイクラのチャットで !vc（なりすまし防止）
//   template … none / werewolf（人狼: 観戦者どうしで話せて、生きている人の声も聞ける）
//   showInfo … サイトの一覧に、ほかの人との距離・ディメンションを表示するか（true 表示 / false 非表示）
export const DEFAULT_RULES = { talk: "spectators", listen: false, verify: "pick", template: "none", showInfo: true };
export function cleanRules(r) {
  r = r || {};
  return {
    talk: ["none", "near", "spectators"].includes(r.talk) ? r.talk : DEFAULT_RULES.talk,
    listen: !!r.listen,
    verify: r.verify === "code" ? "code" : "pick",
    template: r.template === "werewolf" ? "werewolf" : "none",
    showInfo: r.showInfo !== false,
  };
}
// ゲーム中チャット（部屋のチャット）の上限
const ROOM_CHAT_MAX = 200, ROOM_CHAT_KEEP = 50, ROOM_PER10S = 5, ROOM_PERMIN = 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const quoteName = name => `"${String(name).replace(/["\\]/g, "")}"`;
function randomId(n, abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}
function sameText(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const round1 = v => Math.round(Number(v) * 10) / 10;

/**
 * querytarget の返事から、[{ dimension, position:{x,y,z}, uniqueId, yRot }] を取り出す。
 * details は「エスケープされた JSON の文字列」で来る（statusMessage にも同じものが入る）。
 */
export function parseQueryTarget(body) {
  if (!body || body.statusCode) return null;
  for (const c of [body.details, body.statusMessage]) {
    if (Array.isArray(c)) return c;
    if (typeof c !== "string") continue;
    const tries = [c, c.replace(/\\n/g, "").replace(/\\"/g, '"')];
    for (const t of tries) {
      const i = t.indexOf("["), j = t.lastIndexOf("]");
      if (i < 0 || j <= i) continue;
      try {
        const arr = JSON.parse(t.slice(i, j + 1));
        if (Array.isArray(arr)) return arr;
      } catch (e) { /* 次をためす */ }
    }
  }
  return null;
}

/** 距離で音量を決める（ブラウザと同じ計算。テスト用にここにも置く） */
export function gainFor(me, other, radius) {
  if (!me || !other) return (!me && !other) ? 1 : 0;      // どちらもゲームにいない → ロビー
  if (me.dead || other.dead) return (me.dead && other.dead) ? 1 : 0;
  if (me.d !== other.d) return 0;
  const dist = Math.hypot(me.x - other.x, me.y - other.y, me.z - other.z);
  const full = Math.min(2, radius / 4);
  if (dist <= full) return 1;
  if (dist >= radius) return 0;
  const t = (dist - full) / (radius - full);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * ルールつきの聞こえ方（ブラウザと同じ計算）。me が other の声をどれだけの大きさで聞くか（0〜1）
 *   p = { pos: { x, y, z, d } | null, dead: 死んでいる, spec: サイトの観戦者 }
 */
export function gainRule(me, other, radius, rules, world = true) {
  rules = rules || DEFAULT_RULES;
  if (!world) return 1;                                   // ワールドがつながっていない → ロビー
  const ghost = p => !!(p.spec || (p.pos && p.dead));
  const dist = () => (me.pos && other.pos ? gainFor(me.pos, other.pos, radius) : 0);
  const mg = ghost(me), og = ghost(other);
  if (!mg && !og) {
    if (!me.pos && !other.pos) return 1;                  // どちらもゲームにいない → ロビー
    return dist();
  }
  if (og) {                                               // 相手が観戦者
    if (rules.talk === "none") return 0;
    if (rules.talk === "spectators") return mg ? 1 : 0;
    if (me.spec && other.spec) return 1;                  // 近くだけ: サイトの観戦者どうし
    return me.spec || other.spec ? 0 : dist();            // 近くだけ: 場所があれば距離で
  }
  // 自分が観戦者・相手は生きている人
  if (rules.listen && other.pos && !other.dead) return 1;
  if (rules.talk === "near" && !me.spec) return dist();
  return 0;
}

// ---------------------------------------------------------------------
//  GuildRoom に足すメソッド（Object.assign(GuildRoom.prototype, webMethods)）
// ---------------------------------------------------------------------
export const webMethods = {
  isWebRoom() {
    return !!(this.cfg && this.cfg.kind === "web");
  },
  isWebSocket(ws) {
    try { return this.ctx.getTags(ws).includes(WEB_TAG); } catch (e) { return false; }
  },
  webSockets() {
    return this.ctx.getWebSockets(WEB_TAG).filter(s => s.readyState === 1);
  },
  webSend(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 閉じかけ */ }
  },
  webBroadcast(obj, onlyVerified = true) {
    const text = JSON.stringify(obj);
    for (const s of this.webSockets()) {
      if (onlyVerified && !this.att(s).verified) continue;
      try { s.send(text); } catch (e) { /* 無視 */ }
    }
  },

  // ---- 保存しているもの（本人確認ずみのブラウザ・確認待ちのコード・プレイヤーの ID）----
  async webLoad() {
    if (this.web) return this.web;
    const [sessions, pending, uids] = await Promise.all([
      this.storage.get("webSessions"), this.storage.get("webPending"), this.storage.get("webUids")]);
    this.web = {
      sessions: sessions || {},   // sid → { name, at }
      pending: pending || {},     // code → { sid, expires }
      uids: uids || {},           // 名前(小文字) → uniqueId
      fails: {},                  // 送った人(小文字) → { n, at }（コードのまちがい）
    };
    return this.web;
  },
  async webSave(which) {
    const w = await this.webLoad();
    if (which === "sessions" || !which) await this.storage.put("webSessions", w.sessions);
    if (which === "pending" || !which) await this.storage.put("webPending", w.pending);
    if (which === "uids" || !which) await this.storage.put("webUids", w.uids);
  },

  // ---- 部屋を作る（入口の index.js から）----
  async webCreate(body) {
    if (this.cfg) return json({ ok: false, conflict: true }, 409);
    const roomId = String(body.roomId || "");     // 人が打つ部屋番号（6 けた）
    if (!/^(?:\d{6}|[A-HJ-NP-Z2-9]{6})$/.test(roomId)) return json({ ok: false, error: "bad room id" }, 400);
    // 内部の ID（長いランダムな文字。Durable Object の名前になる）。ないとき（前の版）は部屋番号をそのまま使う
    const uid = /^[0-9a-f]{32}$/.test(String(body.uid || "")) ? String(body.uid) : roomId;
    const showKey = String(body.showKey || "");
    this.cfg = {
      kind: "web",
      roomId,
      guildId: "web:" + uid,                  // 接続コードの登録に使う（Discord の ID ではない）。部屋の名前（Durable Object）と同じ
      guildName: String(body.name || "").slice(0, 40) || "近接VC",
      hostKeyHash: String(body.hostKeyHash || ""),
      radius: 20,
      createdAt: Date.now(),
      rooms: {},
      rules: { ...DEFAULT_RULES },
      // マイクラで作った部屋: 管理キーを、ワールドで作った人に出す（出したら消す）
      fromGame: !!body.fromGame,
      adminShow: /^[A-Za-z0-9]{6,24}$/.test(showKey) ? { key: showKey, until: Date.now() + ADMIN_SHOW_MS, fallback: false } : null,
    };
    await this.saveCfg();
    await this.ensureShortCode();
    return json({ ok: true, roomId, worldCode: this.cfg.shortCode });
  },

  async webInfo() {
    if (!this.isWebRoom()) return json({ ok: false, error: "部屋が見つかりません" }, 404);
    const members = this.webSockets().filter(s => this.att(s).verified).length;
    return json({ ok: true, name: this.cfg.guildName, radius: this.radius, world: !!this.socket(), members, rules: this.webRules() });
  },

  /** ホスト（部屋を作った人）の操作。hostKey で確かめる */
  async webHost(body) {
    if (!this.isWebRoom()) return json({ ok: false, error: "部屋が見つかりません" }, 404);
    if (!sameText(await sha256hex(String(body.hostKey || "")), this.cfg.hostKeyHash))
      return json({ ok: false, error: "管理用のキーがちがいます" }, 403);
    const action = String(body.action || "get");
    if (action === "radius") {
      const n = Math.max(4, Math.min(128, Number(body.radius) || 20));
      this.cfg.radius = n;
      await this.saveCfg();
      const ws = this.socket();
      if (ws) { this.sendConfig(ws); this.tell(ws, null, `§a[近接VC] 声が届く距離を ${n} ブロックにしました`); }
      this.webBroadcast({ t: "radius", radius: n }, false);
    } else if (action === "rename") {
      this.cfg.guildName = String(body.name || "").trim().slice(0, 40) || this.cfg.guildName;
      await this.saveCfg();
      this.webBroadcast({ t: "room", name: this.cfg.guildName }, false);
    } else if (action === "rules") {
      const before = this.webRules();
      const rules = cleanRules({ ...before, ...(body.rules || {}) });
      this.cfg.rules = rules;
      if (body.radius != null) this.cfg.radius = Math.max(4, Math.min(128, Number(body.radius) || this.radius));
      await this.saveCfg();
      const ws = this.socket();
      if (ws) { this.sendConfig(ws); this.tell(ws, null, `§a[近接VC] 部屋の設定を変えました（声が届く距離: ${this.radius}ブロック・${rules.verify === "code" ? "!vc で本人確認" : "サイトで自分をえらぶ"}${rules.template === "werewolf" ? "・人狼" : ""}）`); }
      // !vc が必須になったら、えらんで入った人は入り直し
      if (rules.verify === "code" && before.verify !== "code") {
        for (const s of this.webSockets()) {
          const b = this.att(s);
          if (b.verified && b.via === "pick") {
            b.verified = false; b.via = ""; b.name = "";
            this.setAtt(s, b);
            this.webSend(s, { t: "unverified", text: "この部屋は、マイクラのチャットで !vc を送って本人確認することになりました" });
          }
        }
        this.webBroadcast({ t: "peers", peers: this.webPeers() });
      }
      this.webBroadcast({ t: "radius", radius: this.radius }, false);
      this.webBroadcast({ t: "rules", rules }, false);
      this.webSendPlayers();
    } else if (action === "newcode") {
      await this.ensureShortCode(true);
      for (const ws of this.ctx.getWebSockets("mc")) {
        try { ws.close(4001, "接続コードが変わりました"); } catch (e) { /* 無視 */ }
      }
    }
    const members = this.webSockets().filter(s => this.att(s).verified).map(s => this.att(s).name);
    return json({
      ok: true, name: this.cfg.guildName, radius: this.radius, worldCode: this.cfg.shortCode,
      world: !!this.socket(), members, tries: this.diagInfo().tries, now: Date.now(), rules: this.webRules(),
    });
  },

  // ---- ブラウザの WebSocket ----
  async webAccept(request) {
    if (!this.isWebRoom()) return new Response("部屋が見つかりません", { status: 404 });
    if (this.webSockets().length >= MAX_MEMBERS * 2) return new Response("部屋がいっぱいです", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [WEB_TAG]);
    // ゲスト（名前#1234）は、入口の index.js がトークンを確かめてから X-Guest で渡してくる
    let guest = null;
    try { guest = JSON.parse(request.headers.get("X-Guest") || "null"); } catch (e) { guest = null; }
    server.serializeAttachment({ web: true, sid: "", name: "", verified: false, muted: false, since: Date.now(),
      gid: guest && guest.id || "", gname: guest && guest.name || "", gtag: guest && guest.tag || "" });
    return new Response(null, { status: 101, webSocket: client });
  },

  async onWebMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const a = this.att(ws);
    switch (m.t) {
      case "hello": return this.webHello(ws, m);
      case "code": return this.webNewCode(ws);
      case "pick": return this.webPick(ws, m);
      case "unpick": return this.webUnpick(ws);
      case "signal": {
        if (!a.verified) return;
        const to = String(m.to || "");
        const target = this.webSockets().find(s => s !== ws && this.att(s).verified && this.att(s).sid === to);
        if (target) this.webSend(target, { t: "signal", from: a.sid, data: m.data });
        return;
      }
      case "mute": {
        if (!a.verified) return;
        a.muted = !!m.on;
        this.setAtt(ws, a);
        this.webBroadcast({ t: "peers", peers: this.webPeers() });
        return;
      }
      case "chat": return this.webRoomChat(ws, m.text);
      case "leave": {
        const w = await this.webLoad();
        if (a.sid && w.sessions[a.sid]) { delete w.sessions[a.sid]; await this.webSave("sessions"); }
        try { ws.close(1000, "bye"); } catch (e) { /* 無視 */ }
        await this.onWebClose(ws);
        return;
      }
    }
  },

  /** はじめのあいさつ。前に本人確認したブラウザなら、そのまま入れる */
  async webHello(ws, m) {
    await this.useEnv();
    const w = await this.webLoad();
    const a = this.att(ws);
    let sid = String(m.sid || "");
    // 同じブラウザ（同じ sid）の古い接続が残っていたら、入れかえる。
    // スマホで裏に回したとき・回線が変わったときに、切れたはずの古い接続が名前を使ったままになり、
    // 「その名前は、ほかの人が使っています」で入り直せなくなるのを防ぐ
    if (/^[A-Za-z0-9]{24}$/.test(sid)) this.webDropSameSid(ws, sid);
    let s = /^[A-Za-z0-9]{24}$/.test(sid) ? w.sessions[sid] : null;
    const rules = this.webRules();
    const via = s ? (s.via || "code") : "";
    // えらんで入った人: !vc が必須になった・その名前をほかの人が使っている → 入り直し
    if (s && via === "pick" && (rules.verify === "code" || this.webTaken(s.name, ws))) s = null;
    if (s && Date.now() - s.at < SESSION_TTL_MS) {
      a.sid = sid; a.name = s.name; a.verified = true; a.via = via; a.spec = via === "spec";
      s.at = Date.now();
      await this.webSave("sessions");
      if (via === "code") this.webKickOthers(ws, s.name);
    } else {
      a.sid = /^[A-Za-z0-9]{24}$/.test(sid) ? sid : randomId(24); a.name = ""; a.verified = false; a.via = ""; a.spec = false;
    }
    this.setAtt(ws, a);
    this.webSend(ws, {
      t: "welcome", sid: a.sid, name: a.name, verified: a.verified, via: a.via || "",
      room: { id: this.cfg.roomId, name: this.cfg.guildName, radius: this.radius, rules: this.webRules(), fromGame: !!this.cfg.fromGame },
      players: this.webPlayers(), taken: this.webTakenList(),
      world: !!this.socket(),
      ice: a.verified ? await this.webIce(a.sid) : null,
      peers: a.verified ? this.webPeers() : [],
      chat: ((await this.storage.get("webChat")) || []).slice(-ROOM_CHAT_KEEP),
      guest: a.gid ? { id: a.gid, name: a.gname, tag: a.gtag } : null,
    });
    if (a.verified) {
      this.webBroadcast({ t: "peers", peers: this.webPeers() });
      this.webSendPositions(true);
      this.webSendPlayers();
    }
    this.webWake();
  },
  /** サイトにだれもいなくて休んでいたら、位置・一覧・グループを読みはじめる */
  webWake() {
    const mc = this.socket();
    if (!mc || !this.att(mc).init) return;
    if (!this.webPos) this.webStartPos();
    else if (this.webPos.idle || (!this.webPos.timer && !this.webPos.pending.size)) { this.webPos.listAt = 0; this.webPosTick().catch(() => {}); }
    this.storage.setAlarm(Date.now() + 200).catch(() => {});
  },

  webRules() { return cleanRules(this.cfg && this.cfg.rules); },
  /** ワールドにいる人（testfor @a で読んだ名前） */
  webPlayers() { return (this.webPos && this.webPos.players) || []; },
  /** サイトで使われている名前 */
  webTakenList(except = null) {
    return [...new Set(this.webSockets().filter(s => s !== except && this.att(s).verified && !this.att(s).spec).map(s => this.att(s).name))];
  },
  webTaken(name, except) {
    const lower = String(name || "").toLowerCase();
    return this.webSockets().some(s => s !== except && this.att(s).verified && !this.att(s).spec && this.att(s).name.toLowerCase() === lower);
  },
  webSendPlayers() {
    this.webBroadcast({ t: "players", list: this.webPlayers(), taken: this.webTakenList() }, false);
  },

  /** 「自分を選択」: ワールドにいる人の名前をえらんで入る。spec なら観戦者 */
  async webPick(ws, m) {
    const a = this.att(ws);
    if (!a.sid) return;
    const deny = text => this.webSend(ws, { t: "pickfail", text });
    const rules = this.webRules();
    let name, via;
    if (m.spec) {
      name = `${a.gname || "ゲスト"}#${a.gtag || a.sid.slice(0, 4)}`;   // マイクラの名前には # が入らないので、かぶらない
      via = "spec";
    } else {
      if (rules.verify === "code") return deny("この部屋は、マイクラのチャットで !vc を送って本人確認してください");
      const want = String(m.name || "").toLowerCase();
      name = this.webPlayers().find(n => n.toLowerCase() === want);
      if (!name) return deny("その名前の人は、いまワールドにいません");
      if (this.webTaken(name, ws)) return deny("その名前は、ほかの人が使っています");
      via = "pick";
    }
    if (a.verified && a.via === "code" && via === "pick") return;   // 本人確認ずみなら、そのまま
    const w = await this.webLoad();
    a.name = name; a.verified = true; a.via = via; a.spec = via === "spec";
    this.setAtt(ws, a);
    w.sessions[a.sid] = { name, at: Date.now(), via };
    await this.webSave("sessions");
    this.webSend(ws, { t: "verified", name, via, ice: await this.webIce(a.sid), peers: this.webPeers() });
    this.webBroadcast({ t: "peers", peers: this.webPeers() });
    this.webSendPlayers();
    this.webSendPositions(true);
    if (via === "pick") { const mc = this.socket(); if (mc) this.tell(mc, null, `§a[近接VC] ${name} さんがサイトの近接VCに入りました`); }
  },
  /** えらびなおす（名前・観戦者をやめる） */
  async webUnpick(ws) {
    const a = this.att(ws);
    if (!a.verified || a.via === "code") return;
    const w = await this.webLoad();
    if (w.sessions[a.sid]) { delete w.sessions[a.sid]; await this.webSave("sessions"); }
    a.verified = false; a.via = ""; a.spec = false; a.name = "";
    this.setAtt(ws, a);
    this.webSend(ws, { t: "unverified", text: "" });
    this.webBroadcast({ t: "peers", peers: this.webPeers() });
    this.webSendPlayers();
  },

  /** マイクラとつながったときの案内（部屋番号。マイクラで作った部屋は、管理キーを送った人だけに） */
  webAnnounce(ws) {
    const site = String(this.env.SITE_URL || "").replace(/\/$/, "");
    const rules = this.webRules();
    const how = rules.verify === "code" ? "サイトに出た「!vc 6けたの数字」をチャットで送ってね" : "自分の名前をえらんでね";
    this.tell(ws, null, `§a[近接VC] サイトの部屋とつながりました！ 部屋番号: §e§l${this.cfg.roomId}§r§a　${site ? `${site}/talk/ をひらいて` : "サイトで"}部屋番号を入れて、${how}（声が届く距離: ${this.radius}ブロック）`);
    const show = this.cfg.adminShow;
    if (show && Date.now() < show.until) {
      const text = `§7[近接VC] 管理キー（人に見せないでね）: §f§l${show.key}§r§7　サイトの「🔒 管理者設定」で、距離や人狼などの設定に使います`;
      this.webAdminReq = this.mcCommand(ws, `tellraw @s ${JSON.stringify({ rawtext: [{ text }] })}`);
    }
  },
  /** tellraw @s の返事。@s に出せなかったら、チャットの !vc admin で出せるようにする */
  async webOnAdminShown(body) {
    const show = this.cfg && this.cfg.adminShow;
    if (!show) return;
    if (body && body.statusCode === 0) { this.cfg.adminShow = null; }
    else {
      show.fallback = true;
      const ws = this.socket();
      if (ws) this.tell(ws, null, "§e[近接VC] 管理キーを出せませんでした。ワールドで部屋を作った人は、チャットで「!vc admin」と送ってください（最初の 1 人にだけ出ます）");
    }
    await this.saveCfg();
  },

  /** 本人確認のコード（6けた）を出す */
  async webNewCode(ws) {
    const a = this.att(ws);
    if (!a.sid || (a.verified && a.via === "code")) return;
    const w = await this.webLoad();
    const now = Date.now();
    for (const [c, p] of Object.entries(w.pending)) if (!p || p.expires < now || p.sid === a.sid) delete w.pending[c];
    let code = "";
    for (let i = 0; i < 20 && (!code || w.pending[code]); i++) code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    w.pending[code] = { sid: a.sid, expires: now + CODE_TTL_MS };
    await this.webSave("pending");
    this.webSend(ws, { t: "code", code, world: !!this.socket(), expires: now + CODE_TTL_MS });
  },

  /** マイクラのチャット「!vc 123456」→ そのコードを出したブラウザを、送った人として確認ずみにする */
  async webOnChat(mcws, sender, text, type = "chat") {
    const m = /^!vc\s+(\d{6})$/i.exec(String(text || "").trim());
    if (!sender || NAME_BAD.test(sender) || sender.length > 32) return;
    const cmd = String(text || "").trim().toLowerCase();
    if (cmd === "!vc") {
      const site = String(this.env.SITE_URL || "").replace(/\/$/, "");
      this.tell(mcws, sender, `§a[近接VC] 部屋番号: §e§l${this.cfg.roomId}§r§a　${site ? site + "/talk/ " : "サイト"}で番号を入れてね`);
      return;
    }
    if (cmd === "!vc admin") {
      const show = this.cfg.adminShow;
      if (show && show.fallback && Date.now() < show.until) {
        this.cfg.adminShow = null;
        await this.saveCfg();
        this.tell(mcws, sender, `§7[近接VC] 管理キー（人に見せないでね）: §f§l${show.key}§r§7　サイトの「🔒 管理者設定」で使います`);
      } else {
        this.tell(mcws, sender, "§c[近接VC] 管理キーは、もう出せません（部屋を作ったときに出たものを使ってください）");
      }
      return;
    }
    if (!m) {
      // ふつうのチャット → サイトの「ゲーム中チャット」にも出す（ささやき /tell は出さない）
      if (type === "chat" || type === "say") await this.webRoomPost({ name: sender, game: 1 }, String(text || ""), false);
      return;
    }
    const w = await this.webLoad();
    const lower = sender.toLowerCase(), now = Date.now();
    const f = w.fails[lower];
    if (f && now - f.at < 60000 && f.n >= 5) { this.tell(mcws, sender, "§c[近接VC] まちがいが多いので、1 分待ってからもう一度送ってください"); return; }
    const p = w.pending[m[1]];
    if (!p || p.expires < now) {
      w.fails[lower] = { n: (f && now - f.at < 60000 ? f.n : 0) + 1, at: f && now - f.at < 60000 ? f.at : now };
      this.tell(mcws, sender, "§c[近接VC] そのコードは見つかりませんでした。サイトに出ている 6 けたの数字を確認してください（10 分で切れます）");
      return;
    }
    delete w.pending[m[1]];
    await this.webSave("pending");
    const ws = this.webSockets().find(s => this.att(s).sid === p.sid);
    if (!ws) { this.tell(mcws, sender, "§c[近接VC] サイトのページが閉じられています。ページをひらいて、もう一度コードを出してください"); return; }
    const a = this.att(ws);
    a.name = sender; a.verified = true; a.via = "code"; a.spec = false;
    this.setAtt(ws, a);
    w.sessions[a.sid] = { name: sender, at: now, via: "code" };
    // 古いものを消す
    const list = Object.entries(w.sessions).filter(([, s]) => now - s.at < SESSION_TTL_MS).sort((x, y) => y[1].at - x[1].at).slice(0, MAX_SESSIONS);
    w.sessions = Object.fromEntries(list);
    this.webKickOthers(ws, sender);
    await this.webSave("sessions");
    this.webSend(ws, { t: "verified", name: sender, via: "code", ice: await this.webIce(a.sid), peers: this.webPeers() });
    this.webBroadcast({ t: "peers", peers: this.webPeers() });
    this.webSendPlayers();
    this.tell(mcws, null, `§a[近接VC] ${sender} さんがサイトの近接VCに入りました（✓ 本人確認）`);
    this.webPos && this.webPos.retry && this.webPos.retry.delete(lower);
    this.webSendPositions(true);
  },

  /** 同じ名前で、ほかのタブ・端末から入っていたら、そちらを閉じる */
  /** 同じ sid の古い接続を閉じる（つなぎ直したブラウザが、新しい接続で続ける） */
  webDropSameSid(ws, sid) {
    for (const s of this.webSockets()) {
      if (s === ws) continue;
      const b = this.att(s);
      if (b.sid !== sid) continue;
      this.webSend(s, { t: "kick", text: "ほかのタブで、この部屋に入り直しました" });
      b.verified = false; b.kicked = true; b.closed = true;   // closed: 閉じたときに「いなくなった」と知らせない（新しい接続で続くため）
      this.setAtt(s, b);
      try { s.close(4004, "replaced"); } catch (e) { /* 無視 */ }
    }
  },
  webKickOthers(ws, name) {
    const lower = String(name).toLowerCase();
    for (const s of this.webSockets()) {
      if (s === ws) continue;
      const b = this.att(s);
      if (b.verified && b.name.toLowerCase() === lower) {
        this.webSend(s, { t: "kick", text: "ほかのタブや端末で、同じ名前で入り直しました" });
        b.verified = false; b.kicked = true;
        this.setAtt(s, b);
        try { s.close(4003, "duplicate"); } catch (e) { /* 無視 */ }
      }
    }
  },

  // ---- ゲーム中チャット（この部屋だけのチャット。マイクラのチャットともつながる）----
  async webRoomChat(ws, raw) {
    const a = this.att(ws);
    const deny = (text, wait = 0) => this.webSend(ws, { t: "limit", text, wait });
    if (!a.gid && !a.verified) return deny("名前を決めてから書けます");
    if (a.spec && this.webRules().template === "werewolf") return deny("人狼の部屋では、観戦者はゲーム中チャットに書けません");
    let text = String(raw || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    if ([...text].length > ROOM_CHAT_MAX) return deny(`${ROOM_CHAT_MAX} 文字までです`);
    const now = Date.now();
    const key = a.gid || "mc:" + a.name.toLowerCase();
    if (!this.webRates) this.webRates = new Map();
    const r = this.webRates.get(key) || { times: [], last: "", lastAt: 0 };
    const from = a.verified && a.via === "code" ? { name: a.name, v: 1 }
      : a.verified && a.via === "pick" ? { name: a.name, p: 1 }
      : { name: a.gname, tag: a.gtag, v: 0, ...(a.spec ? { s: 1 } : {}) };
    // 同じ文のくり返し（部屋が休んでメモリが消えても分かるように、保存したチャットでも確かめる）
    const saved = (await this.storage.get("webChat")) || [];
    let mine = null;
    for (let i = saved.length - 1; i >= 0; i--) {
      const f = saved[i].f || {};
      if (!f.game && f.name === from.name && (f.v || f.p ? (!!f.v === !!from.v && !!f.p === !!from.p) : (!from.v && !from.p && f.tag === from.tag))) { mine = saved[i]; break; }
    }
    if ((r.last === text && now - r.lastAt < 30000) || (mine && mine.x === text && now - mine.at < 30000)) return deny("同じメッセージは、続けて送れません");
    const t10 = r.times.filter(t => now - t < 10000), t60 = r.times.filter(t => now - t < 60000);
    if (t10.length >= ROOM_PER10S) return deny("送りすぎです。少し待ってください", Math.ceil((10000 - (now - t10[0])) / 1000));
    if (t60.length >= ROOM_PERMIN) return deny("送りすぎです。少し待ってください", Math.ceil((60000 - (now - t60[0])) / 1000));
    r.times = [...t60, now]; r.last = text; r.lastAt = now;
    this.webRates.set(key, r);
    if (this.webRates.size > 2000) this.webRates.clear();
    // マイクラに送るのは、!vc で本人確認した人だけ（知らない人・えらんだだけの人がワールドに書きこめないように）
    await this.webRoomPost(from, text, !!(a.verified && a.via === "code"));
  },
  async webRoomPost(from, text, toGame) {
    text = String(text).slice(0, 400);
    const msg = { id: randomId(8), f: from, x: text, at: Date.now() };
    const list = ((await this.storage.get("webChat")) || []);
    list.push(msg);
    await this.storage.put("webChat", list.slice(-ROOM_CHAT_KEEP));
    this.webBroadcast({ t: "chat", m: msg }, false);
    const ws = toGame ? this.socket() : null;
    if (ws) {
      // § の色コードは消してから送る
      const line = `§b[サイト] §f${from.name}: ${text.replace(/§./gu, "").replace(/§/g, "").replace(/\n/g, " ")}`;
      try { this.mcCommand(ws, `tellraw @a ${JSON.stringify({ rawtext: [{ text: line }] })}`); } catch (e) { /* 無視 */ }
    }
  },

  webPeers(except = null) {
    return this.webSockets().filter(s => s !== except && this.att(s).verified)
      .map(s => { const b = this.att(s); return { sid: b.sid, name: b.name, muted: !!b.muted, via: b.via || "code", spec: !!b.spec }; });
  },

  async onWebClose(ws) {
    const a = this.att(ws);
    if (a.closed) return;
    a.closed = true;
    this.setAtt(ws, a);
    if (a.verified) {
      // 閉じた接続だけを除く（同じ人がもう新しい接続で入り直していたら、その人は残す）
      this.webBroadcast({ t: "peers", peers: this.webPeers(ws) });
      this.webBroadcast({ t: "players", list: this.webPlayers(), taken: this.webTakenList(ws) }, false);
    }
  },

  /** 音声をつなぐためのサーバー（STUN と、VPS の TURN）。TURN のパスワードは 12 時間で切れる */
  async webIce(sid) {
    const ice = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    const secret = this.env.TURN_SECRET;
    const host = String(this.env.TURN_HOST || this.env.RELAY_HOST || "").replace(/:\d+$/, "");
    if (secret && host) {
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${sid}`;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
      let bin = "";
      for (const x of sig) bin += String.fromCharCode(x);
      ice.push({ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential: btoa(bin) });
    }
    return ice;
  },

  // ---- Minecraft とつながったとき・切れたとき ----
  webWorld(connected) {
    this.webBroadcast({ t: "world", connected, name: this.cfg && this.cfg.guildName }, false);
    if (!connected) {
      this.webStopPos();
      this.webBroadcast({ t: "pos", at: Date.now(), p: {} });
      this.webSendPlayers();
    }
  },

  // ---- 位置を読む（querytarget）----
  webStartPos() {
    if (!this.webPos) this.webPos = { pending: new Map(), sentAt: 0, timer: null, pos: {}, retry: new Map(), perName: false, lastSend: 0, players: [], listAt: 0 };
    this.webPosTick();
  },
  webStopPos() {
    if (this.webPos && this.webPos.timer) clearTimeout(this.webPos.timer);
    this.webPos = null;
  },
  webSchedule(ms = POS_MS) {
    const p = this.webPos;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => { p.timer = null; this.webPosTick().catch(() => {}); }, ms);
  },
  async webPosTick() {
    const p = this.webPos;
    const ws = this.socket();
    if (!p || !ws || !this.att(ws).init) return;
    const now = Date.now();
    if (p.pending.size && now - p.sentAt < POS_STALL_MS) return;
    p.pending.clear();
    const w = await this.webLoad();
    const socks = this.webSockets();
    // サイトにだれもいない → 休む（だれかが来たら webHello が起こす）
    if (!socks.length) { p.pos = {}; p.idle = true; return; }
    p.idle = false;
    // ワールドにいる人の一覧（「自分を選択」用）
    if (socks.length && now - p.listAt >= LIST_MS) {
      p.listAt = now;
      p.pending.set(this.mcCommand(ws, "testfor @a"), { kind: "list" });
    }
    const members = [...new Set(socks.filter(s => this.att(s).verified && !this.att(s).spec).map(s => this.att(s).name))];
    if (!members.length) {
      p.pos = {};
      if (p.pending.size) { p.sentAt = now; return; }                      // 一覧の返事を待つ
      this.webSchedule(1000); return;                                     // だれもいないときは、ゆっくり
    }
    // ID（uniqueId）が分からない人は、名前で 1 人ずつ読む（ゲームにいなかった人は 5 秒おき）
    let n = 0;
    for (const name of members) {
      const lower = name.toLowerCase();
      if (!p.perName && w.uids[lower]) continue;
      const last = p.retry.get(lower) || 0;
      if (!p.perName && now - last < NAME_RETRY_MS) continue;
      if (++n > 12) break;
      p.retry.set(lower, now);
      p.pending.set(this.mcCommand(ws, `querytarget @a[name=${quoteName(name)}]`), { kind: "name", lower, name });
    }
    if (!p.perName) p.pending.set(this.mcCommand(ws, "querytarget @a"), { kind: "all" });
    p.sentAt = now;
    if (!p.pending.size) this.webSchedule();
  },
  /** querytarget の返事。位置のときは true を返す */
  async webOnResponse(requestId, body) {
    if (this.webAdminReq && requestId === this.webAdminReq) {
      this.webAdminReq = null;
      await this.webOnAdminShown(body);
      return true;
    }
    const p = this.webPos;
    const job = p && p.pending.get(requestId);
    if (!job) return false;
    p.pending.delete(requestId);
    if (job.kind === "list") {
      const names = body && body.statusCode === 0 && Array.isArray(body.victim)
        ? [...new Set(body.victim.map(String).filter(n => n && n.length <= 32 && !NAME_BAD.test(n)))].sort((x, y) => x.localeCompare(y)).slice(0, 100)
        : [];
      if (names.join("\n") !== p.players.join("\n")) { p.players = names; this.webSendPlayers(); }
      if (!p.pending.size) { this.webSendPositions(); this.webSchedule(); }
      return true;
    }
    const w = await this.webLoad();
    const list = parseQueryTarget(body);
    const at = Date.now();
    const entry = e => {
      const pos = e && e.position;
      if (!pos || !Number.isFinite(Number(pos.x))) return null;
      return { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z), d: Number(e.dimension) || 0, r: round1(e.yRot || 0), at };
    };
    if (job.kind === "name") {
      if (list && list.length === 1) {
        const uid = list[0].uniqueId != null ? String(list[0].uniqueId) : "";
        if (uid && !p.perName && w.uids[job.lower] !== uid) { w.uids[job.lower] = uid; await this.webSave("uids"); }
        const e = entry(list[0]);
        if (e) p.pos[job.lower] = e;
        p.retry.delete(job.lower);
      } else {
        delete p.pos[job.lower];   // ゲームにいない
      }
    } else if (list) {
      const byUid = new Map(list.filter(e => e && e.uniqueId != null).map(e => [String(e.uniqueId), e]));
      if (list.length && !byUid.size) p.perName = true;   // ID が来ない → 名前で 1 人ずつ読む
      const fresh = {};
      for (const [lower, uid] of Object.entries(w.uids)) {
        const e = byUid.get(uid);
        if (e) { const v = entry(e); if (v) fresh[lower] = v; }
      }
      // 名前で読んだばかりの人は残す
      for (const [lower, v] of Object.entries(p.pos)) if (!fresh[lower] && at - v.at < 1000 && !w.uids[lower]) fresh[lower] = v;
      p.pos = fresh;
    }
    if (!p.pending.size) {
      this.webSendPositions();
      this.webSchedule();
    }
    return true;
  },
  /** 位置をブラウザに送る: { 名前(小文字): [x, y, z, ディメンション, 向き, 死んでいる] } */
  webSendPositions(force = false) {
    const p = this.webPos;
    const now = Date.now();
    if (!p) { if (force) this.webBroadcast({ t: "pos", at: now, p: {} }); return; }
    if (!force && now - p.lastSend < 150) return;
    p.lastSend = now;
    const out = {};
    for (const [lower, v] of Object.entries(p.pos)) {
      const g = this.desired && this.desired.get(lower);
      out[lower] = [v.x, v.y, v.z, v.d, v.r, g && g.room === DEAD_ROOM ? 1 : 0];
    }
    this.webBroadcast({ t: "pos", at: now, p: out });
  },
};
