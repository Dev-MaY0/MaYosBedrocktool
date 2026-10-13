// =====================================================================
//  サイト内の近接VC（ブラウザどうしで話す）… Discord を使わない部屋
//
//  しくみ
//   - 部屋（Durable Object "web:<部屋ID>"）は GuildRoom と同じクラスで、cfg.kind = "web"
//   - Minecraft はこれまでと同じ /wsserver（ワールドの接続コード）で部屋につながる
//   - 部屋は querytarget で、みんなの位置（座標・向き・ディメンション）を 1 秒に約 3 回読む
//   - ブラウザは /api/web/socket で部屋につながり、
//       ・マイクラのチャットで「!vc 123456」を送って本人確認（だれの声かをまちがえないように）
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
    const roomId = String(body.roomId || "");
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomId)) return json({ ok: false, error: "bad room id" }, 400);
    this.cfg = {
      kind: "web",
      roomId,
      guildId: "web:" + roomId,               // 接続コードの登録に使う（Discord の ID ではない）
      guildName: String(body.name || "").slice(0, 40) || "近接VC",
      hostKeyHash: String(body.hostKeyHash || ""),
      radius: 20,
      createdAt: Date.now(),
      rooms: {},
    };
    await this.saveCfg();
    await this.ensureShortCode();
    return json({ ok: true, roomId, worldCode: this.cfg.shortCode });
  },

  async webInfo() {
    if (!this.isWebRoom()) return json({ ok: false, error: "部屋が見つかりません" }, 404);
    const members = this.webSockets().filter(s => this.att(s).verified).length;
    return json({ ok: true, name: this.cfg.guildName, radius: this.radius, world: !!this.socket(), members });
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
    } else if (action === "newcode") {
      await this.ensureShortCode(true);
      for (const ws of this.ctx.getWebSockets("mc")) {
        try { ws.close(4001, "接続コードが変わりました"); } catch (e) { /* 無視 */ }
      }
    }
    const members = this.webSockets().filter(s => this.att(s).verified).map(s => this.att(s).name);
    return json({
      ok: true, name: this.cfg.guildName, radius: this.radius, worldCode: this.cfg.shortCode,
      world: !!this.socket(), members, tries: this.diagInfo().tries, now: Date.now(),
    });
  },

  // ---- ブラウザの WebSocket ----
  async webAccept(request) {
    if (!this.isWebRoom()) return new Response("部屋が見つかりません", { status: 404 });
    if (this.webSockets().length >= MAX_MEMBERS * 2) return new Response("部屋がいっぱいです", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [WEB_TAG]);
    server.serializeAttachment({ web: true, sid: "", name: "", verified: false, muted: false, since: Date.now() });
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
    const s = /^[A-Za-z0-9]{24}$/.test(sid) ? w.sessions[sid] : null;
    if (s && Date.now() - s.at < SESSION_TTL_MS) {
      a.sid = sid; a.name = s.name; a.verified = true;
      s.at = Date.now();
      await this.webSave("sessions");
      this.webKickOthers(ws, s.name);
    } else {
      a.sid = randomId(24); a.name = ""; a.verified = false;
    }
    this.setAtt(ws, a);
    this.webSend(ws, {
      t: "welcome", sid: a.sid, name: a.name, verified: a.verified,
      room: { id: this.cfg.roomId, name: this.cfg.guildName, radius: this.radius },
      world: !!this.socket(),
      ice: a.verified ? await this.webIce(a.sid) : null,
      peers: a.verified ? this.webPeers() : [],
    });
    if (a.verified) {
      this.webBroadcast({ t: "peers", peers: this.webPeers() });
      this.webSendPositions(true);
    }
  },

  /** 本人確認のコード（6けた）を出す */
  async webNewCode(ws) {
    const a = this.att(ws);
    if (!a.sid || a.verified) return;
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
  async webOnChat(mcws, sender, text) {
    const m = /^!vc\s+(\d{6})$/i.exec(String(text || "").trim());
    if (!m || !sender || NAME_BAD.test(sender) || sender.length > 32) return;
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
    a.name = sender; a.verified = true;
    this.setAtt(ws, a);
    w.sessions[a.sid] = { name: sender, at: now };
    // 古いものを消す
    const list = Object.entries(w.sessions).filter(([, s]) => now - s.at < SESSION_TTL_MS).sort((x, y) => y[1].at - x[1].at).slice(0, MAX_SESSIONS);
    w.sessions = Object.fromEntries(list);
    this.webKickOthers(ws, sender);
    await this.webSave("sessions");
    this.webSend(ws, { t: "verified", name: sender, ice: await this.webIce(a.sid), peers: this.webPeers() });
    this.webBroadcast({ t: "peers", peers: this.webPeers() });
    this.tell(mcws, null, `§a[近接VC] ${sender} さんがサイトの近接VCに入りました`);
    this.webPos && this.webPos.retry && this.webPos.retry.delete(lower);
    this.webSendPositions(true);
  },

  /** 同じ名前で、ほかのタブ・端末から入っていたら、そちらを閉じる */
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

  webPeers() {
    return this.webSockets().filter(s => this.att(s).verified)
      .map(s => { const b = this.att(s); return { sid: b.sid, name: b.name, muted: !!b.muted }; });
  },

  async onWebClose(ws) {
    const a = this.att(ws);
    if (a.closed) return;
    a.closed = true;
    this.setAtt(ws, a);
    if (a.verified) this.webBroadcast({ t: "peers", peers: this.webPeers().filter(p => p.sid !== a.sid) });
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
    }
  },

  // ---- 位置を読む（querytarget）----
  webStartPos() {
    if (!this.webPos) this.webPos = { pending: new Map(), sentAt: 0, timer: null, pos: {}, retry: new Map(), perName: false, lastSend: 0 };
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
    const members = [...new Set(this.webSockets().filter(s => this.att(s).verified).map(s => this.att(s).name))];
    if (!members.length) { p.pos = {}; this.webSchedule(1000); return; }  // だれもいないときは、ゆっくり
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
    const p = this.webPos;
    const job = p && p.pending.get(requestId);
    if (!job) return false;
    p.pending.delete(requestId);
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
