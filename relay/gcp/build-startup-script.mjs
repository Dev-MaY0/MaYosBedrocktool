// =====================================================================
//  startup-script.sh を作る（startup-script.template.sh に ../relay.mjs を入れる）
//    node build-startup-script.mjs
//  relay.mjs を変えたら、これで作り直して、VM のメタデータの startup-script を貼りかえる。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = fs.readFileSync(path.join(dir, "..", "relay.mjs"), "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
if (relay.split("\n").some(l => l.trim() === "MAYO_RELAY_EOF")) throw new Error("relay.mjs に MAYO_RELAY_EOF の行があります");
const tpl = fs.readFileSync(path.join(dir, "startup-script.template.sh"), "utf8").replace(/\r\n/g, "\n");
if (tpl.split("__RELAY_MJS__").length !== 2) throw new Error("テンプレートに __RELAY_MJS__ が 1 つだけ必要です");
const out = tpl.replace("__RELAY_MJS__", () => relay);
const bytes = Buffer.byteLength(out);
// メタデータの値は 1 つ 256 KB まで
if (bytes > 256 * 1024) throw new Error(`大きすぎます（${bytes} バイト）`);
fs.writeFileSync(path.join(dir, "startup-script.sh"), out, { mode: 0o755 });
console.log(`作成しました: startup-script.sh（${bytes} バイト）`);
