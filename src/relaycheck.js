// =====================================================================
//  リレーが動いているかを、Worker から確かめる（/setup/ の「リレーをためす」）
//  リレーの /health に HTTP でたずねて、
//    ・近接VC リレーが動いているか（X-VC-Relay）
//    ・リレーの中継先（WORKER_HOST）が、この Worker になっているか（X-VC-Relay-Target）
//  を見る。Cloudflare の TCP ソケット（cloudflare:sockets の connect）を使う。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
import { connect } from "cloudflare:sockets";
import { normalizeRelayHost } from "./appconfig.js";

const TIMEOUT_MS = 6000;

export async function testRelay(relay, workerHost) {
  const r = normalizeRelayHost(relay);
  if (!r.host) return { ok: false, error: r.error || "リレーのアドレスが入っていません。" };
  let sock = null, timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS); });
  try {
    try {
      sock = connect({ hostname: r.hostname, port: r.port });
      await Promise.race([sock.opened, timeout]);
    } catch (e) {
      return {
        ok: false,
        error: `リレー（${r.host}）につながりませんでした。アドレスとポート番号、リレーのサーバー（VPS・Google Cloud の VM・Railway のサービス）が動いているか、ファイアウォールでポートがあいているかを確認してください。` +
          "独自ドメインを Cloudflare の DNS で使っているときは、雲のマークを灰色（DNS のみ）にしてください。",
        detail: String(e && e.message || e).slice(0, 120),
      };
    }
    const w = sock.writable.getWriter();
    await w.write(new TextEncoder().encode(`GET /health HTTP/1.1\r\nHost: ${r.host}\r\nUser-Agent: MaYoVCBot\r\nConnection: close\r\n\r\n`));
    w.releaseLock();
    const reader = sock.readable.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (text.length < 4096) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    const head = text.split("\r\n\r\n")[0];
    const header = name => ((new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head) || [])[1] || "").trim();
    const version = header("X-VC-Relay");
    const target = header("X-VC-Relay-Target").toLowerCase();
    if (!version) return { ok: false, error: `${r.host} には返事がありましたが、近接VC リレーではないようです（アドレスとポート番号を確認してください）。` };
    // 中継先がこの Worker とちがう（別の Worker や、独自ドメインで同じ Worker を指しているとき）
    const warn = target && workerHost && target !== String(workerHost).toLowerCase()
      ? `リレーの中継先（WORKER_HOST。VPS は /setup/ でコマンドを作り直す、Google Cloud は VM のメタデータ worker-host、Railway は Variables）が「${target}」になっています。この Worker は「${workerHost}」です。同じ Worker の別のアドレスでなければ、WORKER_HOST を「${workerHost}」に直してください。`
      : "";
    return { ok: true, version, target, relay: r.host, warn };
  } catch (e) {
    return { ok: false, error: `リレー（${r.host}）から返事がありませんでした。`, detail: String(e && e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
    try { if (sock) sock.close(); } catch (e) { /* 無視 */ }
  }
}
