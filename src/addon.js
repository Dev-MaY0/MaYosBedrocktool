// =====================================================================
//  近接VC アドオン（.mcaddon）を Bot の中で作る
//  /vc setup などの返事にファイルとして付けるため。
//  addon_template.js は web/build_site（.ps1 / .mjs）が自動で作ります。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { ADDON_FILES } from "./addon_template.js";

const PACK_DIR = "PlayerCorpseVC_BP";
const enc = new TextEncoder();
const dec = new TextDecoder();

export const hasAddonTemplate = () => !!(ADDON_FILES && ADDON_FILES[`${PACK_DIR}/manifest.json`]);

function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/** 無圧縮の zip を作る */
export function makeZip(files, date = new Date()) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const parts = [], central = [];
  let offset = 0;
  for (const [path, data] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const name = enc.encode(path), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.size, true); end.setUint16(10, files.size, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

/** 日本時間の「月/日 時:分」 */
function jstParts(date) {
  const f = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const hh = p.hour === "24" ? "00" : p.hour;
  return { label: `${p.month}/${p.day} ${hh}:${p.minute}`, file: `${p.month}-${p.day}_${hh}-${p.minute}` };
}

/**
 * mode: "world" | "bds"
 * last: 前回のバージョン [1, minor, patch]（同じバージョンにならないように）
 * 戻り値: { name, data(Uint8Array), version, label }
 */
export function buildVcAddon({ mode, api = "", key = "", last = null, date = new Date() }) {
  const files = new Map();
  for (const [path, b64] of Object.entries(ADDON_FILES)) {
    if (mode === "world" && path.endsWith("/scripts/main_bds.js")) continue;
    if (mode === "bds" && path.endsWith("/scripts/main_world.js")) continue;
    files.set(path, b64ToBytes(b64));
  }
  const cfg = { mode, api: mode === "bds" ? api : "", key: mode === "bds" ? key : "", radius: 20 };
  files.set(`${PACK_DIR}/scripts/vc_config.js`, enc.encode(
    "// このファイルは近接VC Bot / サイトが自動で書き換えます。手で編集しないでください。\n" +
    "// 制作: MaYo (mayo01297)  二次配布禁止\n" +
    `export const VC_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`));

  // バージョン: [1, 2026/1/1からの日数, その日の分]（各数字 65535 まで）
  let minor = Math.max(1, Math.min(65535, Math.floor((date - Date.UTC(2026, 0, 1)) / 86400000) + 1));
  let patch = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (Array.isArray(last) && last.length === 3) {
    const [, lm, lp] = last;
    if (minor < lm || (minor === lm && patch <= lp)) { minor = lm; patch = lp + 1; if (patch > 65535) { minor++; patch = 0; } }
  }
  const version = [1, minor, patch];
  const when = jstParts(date);
  const modeName = mode === "bds" ? "BDS用" : "ワールド用";
  const label = `${modeName}・${when.label}版`;

  let text = dec.decode(files.get(`${PACK_DIR}/manifest.json`));
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const m = JSON.parse(text);
  m.header.version = version;
  m.header.name = `${m.header.name}【${label}】`;
  m.header.description = `【${label}】\n${m.header.description}`;
  for (const mod of m.modules) {
    mod.version = version;
    if (mod.type === "script") mod.entry = mode === "bds" ? "scripts/main_bds.js" : "scripts/main_world.js";
  }
  if (mode === "bds") {
    m.dependencies.push({ module_name: "@minecraft/server-net", version: "1.0.0-beta" });
    m.dependencies.push({ module_name: "@minecraft/server-ui", version: "2.0.0" });
  }
  files.set(`${PACK_DIR}/manifest.json`, enc.encode(JSON.stringify(m, null, 2) + "\n"));
  return { name: `PlayerCorpseVC_${mode}_${when.file}.mcaddon`, data: makeZip(files, date), version, label };
}
