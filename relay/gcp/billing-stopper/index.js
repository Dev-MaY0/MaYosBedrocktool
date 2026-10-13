// =====================================================================
//  課金ストッパー（Google Cloud の Cloud Run functions で動かす）
//
//  予算（Budget）の通知が Pub/Sub に届くたびに動き、
//  「使った金額（costAmount）」が「予算（budgetAmount）× THRESHOLD」以上になっていたら:
//    MODE=stop    … このプロジェクトの、動いている VM をすべて止める（あとで手で起動しなおせる）
//    MODE=billing … このプロジェクトの課金を無効にする（すべてのサービスが止まる。データが消えることがある）
//    MODE=both    … VM を止めてから、課金を無効にする【おすすめ】
//
//  ・外部ライブラリは Functions Framework だけ。Google の API は REST で直接呼ぶ（トークンはメタデータサーバーから）
//  ・ためすときは DRY_RUN=1（何もせず、何をするかをログに出すだけ）
//
//  環境変数
//    MODE           … stop / billing / both（ふつうは both）
//    THRESHOLD      … 予算の何倍で止めるか（1 = 100%。通知がおくれる分を見込むなら 0.9 など）
//    DRY_RUN        … 1 で「ためし」（止めない）
//    TARGET_PROJECT … 止めるプロジェクトの ID（ふつうは空 = この関数があるプロジェクト）
//    INSTANCE_LABEL … 止める VM をラベルでしぼる（例: app=vc-relay。ふつうは空 = 全部）
//
//  もとにしたもの: Google Cloud のドキュメント「Disable billing usage with notifications」
//                 「Control resource usage with notifications」
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
"use strict";
const functions = require("@google-cloud/functions-framework");

const MODE = String(process.env.MODE || "both").toLowerCase();
const THRESHOLD = Number(process.env.THRESHOLD || "1") || 1;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const LABEL = String(process.env.INSTANCE_LABEL || "").trim();
// テスト用に差しかえられるようにしてある（ふつうは変えない）
const MD = process.env.METADATA_URL || "http://metadata.google.internal/computeMetadata/v1";
const COMPUTE = process.env.COMPUTE_API || "https://compute.googleapis.com/compute/v1";
const BILLING = process.env.BILLING_API || "https://cloudbilling.googleapis.com/v1";

const log = (msg, extra = {}) => console.log(JSON.stringify({ severity: "NOTICE", message: msg, ...extra }));
const warn = (msg, extra = {}) => console.log(JSON.stringify({ severity: "ERROR", message: msg, ...extra }));

async function metadata(path) {
  const r = await fetch(`${MD}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata ${path}: ${r.status}`);
  return r.text();
}
async function accessToken() {
  return JSON.parse(await metadata("instance/service-accounts/default/token")).access_token;
}
async function projectId() {
  return process.env.TARGET_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || (await metadata("project/project-id")).trim();
}
async function api(token, method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.replace(/\?.*$/, "")} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function labelMatches(labels) {
  if (!LABEL) return true;
  const [k, v] = LABEL.split("=");
  return !!labels && labels[k] !== undefined && (v === undefined || labels[k] === v);
}

/** 動いている VM をすべて止める（全部のゾーン） */
async function stopInstances(token, project) {
  const targets = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ maxResults: "500" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await api(token, "GET", `${COMPUTE}/projects/${project}/aggregated/instances?${q}`);
    for (const [scope, v] of Object.entries(r.items || {})) {
      for (const inst of v.instances || []) {
        if (inst.status !== "RUNNING" || !labelMatches(inst.labels)) continue;
        targets.push({ zone: scope.replace(/^zones\//, ""), name: inst.name });
      }
    }
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  if (!targets.length) { log("動いている VM はありません"); return; }
  for (const t of targets) {
    if (DRY_RUN) { log(`[ためし] VM を止めます: ${t.zone}/${t.name}`); continue; }
    try {
      await api(token, "POST", `${COMPUTE}/projects/${project}/zones/${t.zone}/instances/${t.name}/stop`);
      log(`VM を止めました: ${t.zone}/${t.name}`);
    } catch (e) {
      warn(`VM を止められませんでした: ${t.zone}/${t.name}`, { error: String(e.message || e) });
    }
  }
}

/** このプロジェクトの課金を無効にする（請求先アカウントとのリンクを外す） */
async function disableBilling(token, project) {
  if (DRY_RUN) { log(`[ためし] プロジェクト ${project} の課金を無効にします`); return; }
  const r = await api(token, "PUT", `${BILLING}/projects/${project}/billingInfo`, { billingAccountName: "" });
  log(`プロジェクト ${project} の課金を無効にしました`, { billingEnabled: r.billingEnabled === true });
}

functions.cloudEvent("billingStopper", async (cloudEvent) => {
  const message = (cloudEvent && cloudEvent.data && cloudEvent.data.message) || {};
  let data = null;
  try { data = JSON.parse(Buffer.from(message.data || "", "base64").toString("utf8")); } catch (e) { data = null; }
  if (!data || data.costAmount === undefined || data.budgetAmount === undefined) {
    log("予算の通知ではないので、何もしません");
    return;
  }
  const cost = Number(data.costAmount), budget = Number(data.budgetAmount);
  const limit = budget * THRESHOLD;
  const info = { cost, budget, limit, currency: data.currencyCode || "", mode: MODE, dryRun: DRY_RUN, budgetId: (message.attributes || {}).budgetId || "" };
  if (!(budget > 0) || !(cost >= limit)) {
    log(`まだ大丈夫です（${cost} / ${limit} ${info.currency}）`, info);
    return;
  }
  warn(`予算の上限に達しました（${cost} / ${limit} ${info.currency}）。止めます`, info);

  const token = await accessToken();
  const project = await projectId();
  let failed = null;
  if (MODE === "stop" || MODE === "both") {
    try { await stopInstances(token, project); } catch (e) { failed = e; warn("VM を止める処理でエラー", { error: String(e.message || e) }); }
  }
  if (MODE === "billing" || MODE === "both") {
    // VM を止めるのに失敗しても、課金の無効化はやる（こちらが本当の止め）
    try { await disableBilling(token, project); } catch (e) { failed = e; warn("課金を無効にする処理でエラー", { error: String(e.message || e) }); }
  }
  if (!["stop", "billing", "both"].includes(MODE)) warn(`MODE が「${MODE}」になっています。stop / billing / both のどれかにしてください`);
  if (failed) throw failed;   // エラーはログで分かるように（次の通知でまたためします）
});
