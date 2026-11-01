// =====================================================================
//  サイトの設定（近接VC）
//  ふつうは何も書かなくてOKです（サイトと Bot が同じ場所で動くため）。
//  Bot を別の場所に置いたときだけ、botUrl と discordAppId を書いてください。
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
window.SITE_CONFIG = {
  // botUrl: "https://…workers.dev",
  // discordAppId: "…",

  // 公開サイトのアドレス。ほかのアドレス（Cloudflare の workers.dev など）でひらいた人は、ここへ自動で移動します
  // （/setup/ と /download/ はそのまま。移動先が動いていないときは移動しません）。"" にすると移動しません。
  mainSite: "https://m-ayosaba.com",
};

// ---- 公開サイト（mainSite）へ移動する ----
(function () {
  var main = String((window.SITE_CONFIG || {}).mainSite || "").replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(main)) return;
  try {
    if (location.origin === main || !/^https?:$/.test(location.protocol)) return;
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;   // 自分の PC でためしているとき
    if (/^\/(setup|download)\//.test(location.pathname)) return;   // 管理者用のページ・ダウンロードはそのまま
    // 移動先が動いているときだけ移動する（準備中・止まっているときは、このサイトのまま）
    fetch(main + "/health", { mode: "no-cors", cache: "no-store" }).then(function () {
      location.replace(main + location.pathname + location.search + location.hash);
    }).catch(function () { /* このサイトのまま */ });
  } catch (e) { /* 無視 */ }
})();
