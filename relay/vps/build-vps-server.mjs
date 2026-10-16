// =====================================================================
//  public/download/vps-server.sh を作る（vps-server.template.sh に、サイトと Bot のファイルを入れる）
//    node relay/vps/build-vps-server.mjs      （cloudflare フォルダで）
//  src/ や public/ を変えたら、これで作り直す（VPS の人は sudo mayo-vc update で新しい版になる）。
//
//  ※ vps-server.sh はサイトの /download/ からだれでもダウンロードできるので、
//    src/setupgate.js の PRESET_SETUP_KEY（あらかじめ決めた /setup/ のパスワード）は、中に入れるときに空にする
//    （VPS ではインストールのときに SETUP_KEY が必ず作られるので、空でも困らない）。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "public", "download", "vps-server.sh");
const SKIP = new Set(["public/download/vps-server.sh", "public/download/vps-setup.sh"]);   // 自分自身と、別に配っているもの

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
const files = [
  ...walk("public").filter(f => !SKIP.has(f)),
  "relay/relay.mjs",
  ...fs.readdirSync(path.join(ROOT, "src")).filter(f => f.endsWith(".js")).map(f => "src/" + f),
  "wrangler.toml",
].sort();

const OK = /^(src\/[A-Za-z0-9_.-]+\.js|public\/[A-Za-z0-9_.\/-]+|relay\/relay\.mjs|wrangler\.toml)$/;
const entries = [];
for (const rel of files) {
  if (!OK.test(rel)) throw new Error("この名前のファイルは入れられません: " + rel);
  let buf = fs.readFileSync(path.join(ROOT, rel));
  if (rel === "src/setupgate.js") {
    const text = buf.toString("utf8");
    const cut = text.replace(/^export const PRESET_SETUP_KEY = "[^"]*";/m, 'export const PRESET_SETUP_KEY = "";   // 配る版には入れない（VPS は SETUP_KEY を必ず作る）');
    if (/^export const PRESET_SETUP_KEY = "[^"]+";/m.test(cut)) throw new Error("PRESET_SETUP_KEY を空にできませんでした");
    buf = Buffer.from(cut, "utf8");
  }
  entries.push(`${JSON.stringify(rel)}:${JSON.stringify(buf.toString("base64"))}`);
}
const bundle = "{\n" + entries.join(",\n") + "\n}";
if (bundle.split("\n").some(l => l === "MAYO_BUNDLE_EOF")) throw new Error("中身に MAYO_BUNDLE_EOF の行があります");
const sha = crypto.createHash("sha256").update(bundle + "\n").digest("hex");   // ヒアドキュメントの最後に改行が 1 つ付く

const tpl = fs.readFileSync(path.join(ROOT, "relay", "vps", "vps-server.template.sh"), "utf8").replace(/\r\n/g, "\n");
if (tpl.split("__BUNDLE_JSON__").length !== 2 || tpl.split("__BUNDLE_SHA256__").length !== 2) throw new Error("テンプレートに __BUNDLE_JSON__ と __BUNDLE_SHA256__ が 1 つずつ必要です");
const out = tpl.replace("__BUNDLE_SHA256__", sha).replace("__BUNDLE_JSON__", () => bundle);
fs.writeFileSync(OUT, out, { mode: 0o755 });
console.log(`作成しました: public/download/vps-server.sh（${files.length} ファイル・${Buffer.byteLength(out)} バイト）`);
