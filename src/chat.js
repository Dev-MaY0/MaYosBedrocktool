// =====================================================================
//  ゲストのチャット（みんなのチャット・DM）… "__chat__" という名前の部屋（GuildRoom と同じクラス）が受け持つ
//
//  - ゲスト: 最初に名前を入れると、ID とひみつのトークンがもらえる（ブラウザに保存）。表示は「名前#1234」
//  - みんなのチャット: サイトに来ている人みんなで話せる（最新 100 件を保存）
//  - DM: 1 対 1。相手がいなくても届く（会話ごとに最新 60 件・7 日）
//  - スパム対策: 文字数・連投・同じ文の連投・はじめたばかりの人の待ち時間・作れるゲストの数・同時接続の数
//  - 管理: サイトの管理者が、ゲストを止める（BAN）・メッセージを消す
//
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

export const CHAT_TAG = "chat";
export const LIMITS = {
  nameMax: 16,
  lobbyMax: 200,          // みんなのチャットの文字数
  dmMax: 500,             // DM の文字数
  lobbyPer10s: 3, lobbyPerMin: 15,
  dmPer10s: 6, dmPerMin: 30,
  newDmPeersPerDay: 20,   // 1 日に話しかけられる新しい相手の数
  newbieWaitMs: 10000,    // 名前を決めてから、みんなのチャットに書けるまで
  dupWindowMs: 60000,     // 同じ文をくり返せない時間
  slowModeAt: 40,         // 全体で 10 秒に 40 件をこえたら、ゆっくりモード（1 人 10 秒に 1 件）
  socketsPerIp: 6,
  renamePerHour: 3,
};
const LOBBY_KEEP = 100, DM_KEEP = 60, DM_TTL_MS = 7 * 86400000, MAX_CONVS = 50;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
function rid(n, abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += abc[x % abc.length];
  return s;
}
async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function same(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 名前をきれいにする（制御文字・前後の空白・< > を消す）。だめなら "" */
export function cleanName(v) {
  const s = String(v || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>"'`\\]/g, "").replace(/\s+/g, " ").trim();
  return [...s].slice(0, LIMITS.nameMax).join("");
}
/** メッセージをきれいにする（制御文字を消す・改行は 3 つまで続けてよい） */
export function cleanText(v, max) {
  let s = String(v || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
  s = s.replace(/\n{4,}/g, "\n\n\n").trim();
  const chars = [...s];
  return chars.length > max ? null : s;
}

/** 連投の見張り（times は送った時刻の配列）。だめなら待つ秒数を返す */
export function rateWait(times, now, per10s, perMin) {
  const t10 = times.filter(t => now - t < 10000), t60 = times.filter(t => now - t < 60000);
  if (t10.length >= per10s) return Math.ceil((10000 - (now - t10[0])) / 1000);
  if (t60.length >= perMin) return Math.ceil((60000 - (now - t60[0])) / 1000);
  return 0;
}

export const chatMethods = {
  // ---- ゲスト ----
  async chatGuestNew(body) {
    const name = cleanName(body.name);
    if (!name) return json({ ok: false, error: "名前を入れてください（16 文字まで）" }, 400);
    const ipKey = String(body.ipKey || "");
    const bans = (await this.storage.get("bans")) || {};
    if (ipKey && bans["ip:" + ipKey] > Date.now()) return json({ ok: false, error: "このネットワークからは、しばらく使えません" }, 403);
    const id = rid(10);
    const secret = rid(32);
    const tag = String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
    const g = { id, name, tag, tokenHash: await sha(secret), at: Date.now(), ipKey, renames: [] };
    await this.storage.put("g:" + id, g);
    return json({ ok: true, id, name, tag, token: `${id}.${secret}` });
  },
  /** トークン → ゲスト（だめなら null）。BAN されていたら { banned } */
  async chatGuestByToken(token) {
    const m = /^([A-Za-z0-9]{10})\.([A-Za-z0-9]{32})$/.exec(String(token || ""));
    if (!m) return null;
    const g = await this.storage.get("g:" + m[1]);
    if (!g || !same(await sha(m[2]), g.tokenHash)) return null;
    return g;
  },
  async chatGuestCheck(token) {
    const g = await this.chatGuestByToken(token);
    if (!g) return json({ ok: false }, 401);
    if (g.bannedUntil > Date.now()) return json({ ok: false, banned: true }, 403);
    return json({ ok: true, id: g.id, name: g.name, tag: g.tag });
  },

  // ---- WebSocket ----
  chatSockets() {
    return this.ctx.getWebSockets(CHAT_TAG).filter(s => s.readyState === 1);
  },
  async chatAccept(request) {
    const url = new URL(request.url);
    const g = await this.chatGuestByToken(url.searchParams.get("token"));
    if (!g) return new Response("ゲストの情報がありません。名前を入れ直してください", { status: 401 });
    if (g.bannedUntil > Date.now()) return new Response("このゲストは、しばらく使えません", { status: 403 });
    const ipKey = url.searchParams.get("ip") || "";
    if (ipKey && this.chatSockets().filter(s => this.att(s).ip === ipKey).length >= LIMITS.socketsPerIp)
      return new Response("同じネットワークから、たくさんひらきすぎです", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [CHAT_TAG]);
    server.serializeAttachment({ chat: true, gid: g.id, name: g.name, tag: g.tag, ip: ipKey, since: Date.now() });
    this.chatPresenceSoon();
    return new Response(null, { status: 101, webSocket: client });
  },
  chatSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* 閉じかけ */ } },
  chatUser(g) { return { id: g.id, name: g.name, tag: g.tag }; },
  chatOnline() {
    const seen = new Map();
    for (const s of this.chatSockets()) {
      const a = this.att(s);
      if (!seen.has(a.gid)) seen.set(a.gid, { id: a.gid, name: a.name, tag: a.tag });
    }
    return [...seen.values()];
  },
  async chatWelcome(ws, g) {
    const lobby = (await this.storage.get("lobby")) || [];
    const convs = await this.chatConvs(g.id);
    const online = this.chatOnline();
    this.chatSend(ws, { t: "welcome", me: this.chatUser(g), lobby: lobby.slice(-50), convs, online: online.slice(0, 200), onlineCount: online.length, limits: LIMITS });
  },
  chatPresenceSoon() {
    if (this.chatPresenceTimer) return;
    this.chatPresenceTimer = setTimeout(() => {
      this.chatPresenceTimer = null;
      const online = this.chatOnline();
      const text = JSON.stringify({ t: "online", list: online.slice(0, 200), count: online.length });
      for (const s of this.chatSockets()) { try { s.send(text); } catch (e) { /* 無視 */ } }
    }, 800);
  },
  async onChatClose(ws) {
    const a = this.att(ws);
    if (a.closed) return;
    a.closed = true;
    this.setAtt(ws, a);
    this.chatPresenceSoon();
  },

  // ---- 会話の一覧（DM）----
  async chatConvs(gid) {
    const list = (await this.storage.get("dml:" + gid)) || {};
    const out = [];
    const now = Date.now();
    for (const [peer, at] of Object.entries(list).sort((x, y) => y[1] - x[1]).slice(0, MAX_CONVS)) {
      if (now - at > DM_TTL_MS) continue;
      const pg = await this.storage.get("g:" + peer);
      if (!pg) continue;
      const msgs = (await this.storage.get(this.dmKey(gid, peer))) || [];
      out.push({ peer: this.chatUser(pg), last: msgs[msgs.length - 1] || null });
    }
    return out;
  },
  dmKey(a, b) { return "dm:" + [a, b].sort().join("|"); },

  /** 連投の見張り（メモリに置く。部屋がメモリから消えたら、また 0 から） */
  chatRate(gid) {
    if (!this.chatRates) this.chatRates = new Map();
    let r = this.chatRates.get(gid);
    if (!r) { r = { lobby: [], dm: [], last: { x: "", at: 0 }, rename: [] }; this.chatRates.set(gid, r); }
    if (this.chatRates.size > 5000) this.chatRates.clear();
    return r;
  },

  async onChatMessage(ws, message) {
    if (typeof message !== "string" || message.length > 4000) return;
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    const a = this.att(ws);
    if (!a.gid) return;
    const now = Date.now();
    const g = await this.storage.get("g:" + a.gid);
    if (!g || g.bannedUntil > now) { try { ws.close(4004, "banned"); } catch (e) { /* 無視 */ } return; }
    const r = this.chatRate(a.gid);
    const deny = (text, wait = 0) => this.chatSend(ws, { t: "limit", text, wait });

    if (m.t === "hello") return this.chatWelcome(ws, g);

    if (m.t === "say") {
      const text = cleanText(m.text, LIMITS.lobbyMax);
      if (text === null) return deny(`${LIMITS.lobbyMax} 文字までです`);
      if (!text) return;
      if (now - g.at < LIMITS.newbieWaitMs) return deny("はじめたばかりの人は、少し待ってから書けます", Math.ceil((LIMITS.newbieWaitMs - (now - g.at)) / 1000));
      // 同じ文のくり返し（部屋が休んでメモリが消えても分かるように、保存したチャットでも確かめる）
      const lobby = (await this.storage.get("lobby")) || [];
      let mine = null;
      for (let i = lobby.length - 1; i >= 0; i--) if (lobby[i].f.id === a.gid) { mine = lobby[i]; break; }
      if ((r.last.x === text && now - r.last.at < LIMITS.dupWindowMs) || (mine && mine.x === text && now - mine.at < LIMITS.dupWindowMs))
        return deny("同じメッセージは、続けて送れません");
      // 全体がにぎやかすぎるときは、ゆっくりモード
      if (!this.chatGlobal) this.chatGlobal = [];
      this.chatGlobal = this.chatGlobal.filter(t => now - t < 10000);
      const slow = this.chatGlobal.length >= LIMITS.slowModeAt;
      const wait = slow ? rateWait(r.lobby, now, 1, 6) : rateWait(r.lobby, now, LIMITS.lobbyPer10s, LIMITS.lobbyPerMin);
      if (wait) return deny(slow ? "いま混んでいるので、ゆっくりモードです" : "送りすぎです。少し待ってください", wait);
      r.lobby = [...r.lobby.filter(t => now - t < 60000), now];
      r.last = { x: text, at: now };
      this.chatGlobal.push(now);
      const msg = { id: rid(8), f: this.chatUser(g), x: text, at: now };
      lobby.push(msg);
      await this.storage.put("lobby", lobby.slice(-LOBBY_KEEP));
      const out = JSON.stringify({ t: "lobby", m: msg });
      for (const s of this.chatSockets()) { try { s.send(out); } catch (e) { /* 無視 */ } }
      return;
    }

    if (m.t === "dm") {
      const to = String(m.to || "");
      if (!/^[A-Za-z0-9]{10}$/.test(to) || to === a.gid) return;
      const pg = await this.storage.get("g:" + to);
      if (!pg) return deny("その人は見つかりませんでした");
      const text = cleanText(m.text, LIMITS.dmMax);
      if (text === null) return deny(`${LIMITS.dmMax} 文字までです`);
      if (!text) return;
      if (r.last.x === text && now - r.last.at < 3000) return deny("同じメッセージは、続けて送れません");
      const wait = rateWait(r.dm, now, LIMITS.dmPer10s, LIMITS.dmPerMin);
      if (wait) return deny("送りすぎです。少し待ってください", wait);
      const key = this.dmKey(a.gid, to);
      const msgs = (await this.storage.get(key)) || [];
      if (!msgs.length) {
        // 1 日に話しかけられる新しい相手の数
        const day = Math.floor(now / 86400000);
        const nd = g.newDm && g.newDm.day === day ? g.newDm : { day, n: 0 };
        if (nd.n >= LIMITS.newDmPeersPerDay) return deny("今日は、これ以上新しい人に DM を送れません");
        nd.n++;
        g.newDm = nd;
        await this.storage.put("g:" + g.id, g);
      }
      r.dm = [...r.dm.filter(t => now - t < 60000), now];
      r.last = { x: text, at: now };
      const msg = { id: rid(8), f: this.chatUser(g), to: to, x: text, at: now };
      msgs.push(msg);
      await this.storage.put(key, msgs.filter(x => now - x.at < DM_TTL_MS).slice(-DM_KEEP));
      for (const [me, peer] of [[a.gid, to], [to, a.gid]]) {
        const list = (await this.storage.get("dml:" + me)) || {};
        list[peer] = now;
        const trimmed = Object.fromEntries(Object.entries(list).sort((x, y) => y[1] - x[1]).slice(0, MAX_CONVS));
        await this.storage.put("dml:" + me, trimmed);
      }
      const peerOf = { [a.gid]: this.chatUser(pg), [to]: this.chatUser(g) };
      for (const s of this.chatSockets()) {
        const b = this.att(s);
        if (b.gid === a.gid || b.gid === to) this.chatSend(s, { t: "dm", m: msg, peer: peerOf[b.gid] });
      }
      return;
    }

    if (m.t === "open") {
      const peer = String(m.with || "");
      if (!/^[A-Za-z0-9]{10}$/.test(peer)) return;
      const pg = await this.storage.get("g:" + peer);
      if (!pg) return;
      const msgs = ((await this.storage.get(this.dmKey(a.gid, peer))) || []).filter(x => now - x.at < DM_TTL_MS);
      this.chatSend(ws, { t: "history", peer: this.chatUser(pg), msgs });
      return;
    }

    if (m.t === "rename") {
      const name = cleanName(m.name);
      if (!name) return deny("名前を入れてください（16 文字まで）");
      g.renames = (g.renames || []).filter(t => now - t < 3600000);
      if (g.renames.length >= LIMITS.renamePerHour) return deny("名前は 1 時間に 3 回まで変えられます");
      g.renames.push(now);
      g.name = name;
      await this.storage.put("g:" + g.id, g);
      for (const s of this.chatSockets()) {
        const b = this.att(s);
        if (b.gid === g.id) { b.name = name; this.setAtt(s, b); this.chatSend(s, { t: "me", me: this.chatUser(g) }); }
      }
      this.chatPresenceSoon();
      return;
    }
  },

  // ---- 管理（サイトの管理者だけ。入口の index.js で Bot のトークンを確かめてから呼ぶ）----
  async chatAdmin(body) {
    const action = String(body.action || "list");
    const now = Date.now();
    let lobby = (await this.storage.get("lobby")) || [];
    if (action === "ban") {
      const id = String(body.id || "");
      const g = await this.storage.get("g:" + id);
      if (!g) return json({ ok: false, error: "そのゲストは見つかりません" }, 404);
      const hours = Math.max(1, Math.min(24 * 365, Number(body.hours) || 24 * 7));
      g.bannedUntil = now + hours * 3600000;
      await this.storage.put("g:" + id, g);
      if (g.ipKey) {
        const bans = (await this.storage.get("bans")) || {};
        bans["ip:" + g.ipKey] = g.bannedUntil;
        for (const [k, v] of Object.entries(bans)) if (v < now) delete bans[k];
        await this.storage.put("bans", bans);
      }
      const removed = lobby.filter(x => x.f.id === id).map(x => x.id);
      lobby = lobby.filter(x => x.f.id !== id);
      await this.storage.put("lobby", lobby);
      const out = JSON.stringify({ t: "removed", ids: removed });
      for (const s of this.chatSockets()) {
        try { s.send(out); } catch (e) { /* 無視 */ }
        if (this.att(s).gid === id) { try { s.close(4004, "banned"); } catch (e) { /* 無視 */ } }
      }
      this.chatPresenceSoon();
    } else if (action === "unban") {
      const g = await this.storage.get("g:" + String(body.id || ""));
      if (g) {
        g.bannedUntil = 0;
        await this.storage.put("g:" + g.id, g);
        const bans = (await this.storage.get("bans")) || {};
        delete bans["ip:" + g.ipKey];
        await this.storage.put("bans", bans);
      }
    } else if (action === "delete") {
      const ids = new Set([].concat(body.ids || []).map(String));
      lobby = lobby.filter(x => !ids.has(x.id));
      await this.storage.put("lobby", lobby);
      const out = JSON.stringify({ t: "removed", ids: [...ids] });
      for (const s of this.chatSockets()) { try { s.send(out); } catch (e) { /* 無視 */ } }
    }
    return json({ ok: true, lobby: lobby.slice(-50), online: this.chatOnline().length });
  },
};
