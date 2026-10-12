// =====================================================================
//  Minecraft の「暗号化された WebSocket」（/wsserver）
//  Minecraft の設定「暗号化された WebSocket を要求」がオンでもつながるように、
//  Minecraft と同じやり方（ECDH P-384 → SHA-256 → AES-256-CFB8）で暗号化します。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================

/** Minecraft が「暗号化できます」と伝えてくるサブプロトコル名 */
export const WS_ENCRYPT_PROTOCOL = "com.microsoft.minecraft.wsencrypt";

// ---------------------------------------------------------------------
//  AES-256（暗号化だけ。CFB8 は暗号化の向きしか使わない）
// ---------------------------------------------------------------------
const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
(() => {
  const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);   // p * 3
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;     // q / 3
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff, s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = t;
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
})();

export class Aes256 {
  constructor(key) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("AES-256 の鍵は 32 バイトです");
    const w = new Uint32Array(60);
    for (let i = 0; i < 8; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    let rcon = 1;
    for (let i = 8; i < 60; i++) {
      let t = w[i - 1];
      if (i % 8 === 0) {
        t = ((t << 8) | (t >>> 24)) >>> 0;
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
        t = (t ^ (rcon << 24)) >>> 0;
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
      } else if (i % 8 === 4) {
        t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
      }
      w[i] = (w[i - 8] ^ t) >>> 0;
    }
    this.rk = w;
  }

  /** 16 バイトを暗号化して out に書く */
  encryptBlock(inp, out) {
    const rk = this.rk;
    let s0 = (((inp[0] << 24) | (inp[1] << 16) | (inp[2] << 8) | inp[3]) ^ rk[0]) >>> 0;
    let s1 = (((inp[4] << 24) | (inp[5] << 16) | (inp[6] << 8) | inp[7]) ^ rk[1]) >>> 0;
    let s2 = (((inp[8] << 24) | (inp[9] << 16) | (inp[10] << 8) | inp[11]) ^ rk[2]) >>> 0;
    let s3 = (((inp[12] << 24) | (inp[13] << 16) | (inp[14] << 8) | inp[15]) ^ rk[3]) >>> 0;
    let k = 4;
    for (let r = 1; r < 14; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ rk[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ rk[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ rk[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ rk[k + 3];
      s0 = t0 >>> 0; s1 = t1 >>> 0; s2 = t2 >>> 0; s3 = t3 >>> 0;
      k += 4;
    }
    const last = (a, b, c, d, key) => ((
      (SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 255] << 16) | (SBOX[(c >>> 8) & 255] << 8) | SBOX[d & 255]) ^ key) >>> 0;
    const o0 = last(s0, s1, s2, s3, rk[k]), o1 = last(s1, s2, s3, s0, rk[k + 1]);
    const o2 = last(s2, s3, s0, s1, rk[k + 2]), o3 = last(s3, s0, s1, s2, rk[k + 3]);
    for (const [i, v] of [[0, o0], [4, o1], [8, o2], [12, o3]]) {
      out[i] = v >>> 24; out[i + 1] = (v >>> 16) & 255; out[i + 2] = (v >>> 8) & 255; out[i + 3] = v & 255;
    }
  }
}

/**
 * AES-256-CFB8。iv（16バイト）は呼ぶたびに進むので、続きは戻り値の iv を使う。
 * decrypt=false で暗号化、true で復号。
 */
export function cfb8(aes, iv, data, decrypt) {
  const reg = Uint8Array.from(iv), ks = new Uint8Array(16), out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    aes.encryptBlock(reg, ks);
    const x = data[i] ^ ks[0];
    const c = decrypt ? data[i] : x;
    reg.copyWithin(0, 1);
    reg[15] = c;
    out[i] = x;
  }
  return { out, iv: reg };
}

// ---------------------------------------------------------------------
//  base64・バイト列
// ---------------------------------------------------------------------
export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const bin = atob(String(b64).replace(/[\s"]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
// P-384 の公開鍵（SubjectPublicKeyInfo）の頭の部分。生の点（04 …, 97バイト）が来たときに付け足す
const SPKI_P384_HEADER = Uint8Array.from([0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00]);

const ECDH = { name: "ECDH", namedCurve: "P-384" };

/** 鍵の交換をはじめる（Minecraft に送るコマンドと、あとで使う秘密の値） */
export async function beginKeyExchange() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pub = toB64(spki), saltB64 = toB64(salt);
  return {
    command: `enableencryption ${JSON.stringify(pub)} ${JSON.stringify(saltB64)} cfb8`,
    priv: { d: jwk.d, x: jwk.x, y: jwk.y },
    salt: saltB64,
  };
}

/** Minecraft から返ってきた公開鍵で、共通の鍵（AES-256 の鍵, base64）を作る */
export async function finishKeyExchange(priv, saltB64, clientPublicKey) {
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-384", d: priv.d, x: priv.x, y: priv.y, ext: true },
    ECDH, false, ["deriveBits"]);
  let der = fromB64(clientPublicKey);
  if (der.length === 97 && der[0] === 4) der = concat(SPKI_P384_HEADER, der);
  const pub = await crypto.subtle.importKey("spki", der, ECDH, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, key, 384));
  const aesKey = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(fromB64(saltB64), secret)));
  return toB64(aesKey);
}

// ---------------------------------------------------------------------
//  1 本の WebSocket ぶんの暗号化の状態（WebSocket の attachment に入れて、休止しても続けられるようにする）
//  state = { k: 鍵, e: 送る向きの iv, d: 受ける向きの iv }（すべて base64）
// ---------------------------------------------------------------------
const aesCache = new Map();
function aesFor(k) {
  let a = aesCache.get(k);
  if (!a) {
    if (aesCache.size > 50) aesCache.clear();
    a = new Aes256(fromB64(k));
    aesCache.set(k, a);
  }
  return a;
}

export function newCipherState(keyB64) {
  const iv = toB64(fromB64(keyB64).subarray(0, 16));
  return { k: keyB64, e: iv, d: iv };
}

/** 文字列を暗号化（state.e が進む） */
export function encryptText(state, text) {
  const r = cfb8(aesFor(state.k), fromB64(state.e), new TextEncoder().encode(text), false);
  state.e = toB64(r.iv);
  return r.out;
}

/** バイト列を復号して文字列に（state.d が進む） */
export function decryptBytes(state, bytes) {
  const r = cfb8(aesFor(state.k), fromB64(state.d), bytes, true);
  state.d = toB64(r.iv);
  return new TextDecoder().decode(r.out);
}
