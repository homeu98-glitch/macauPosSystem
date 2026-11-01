/**
 * 《老浏览器补救層》—— 白屏變成一句人話（2026-10-31）
 *
 * ## 為何需要呢個檔
 *
 * 2026-10-31 實機：一部 **Android 6.0.1 + Chrome 81** 的 D1 收銀機打開我們網站
 * = **純白頁**。原因唔係網絡、唔係憑證，係本專案（Next 16）預設 target 係
 * **Chrome 111+**：
 *
 *   · App Router client runtime 用咗 `class X { static { … } }`（Chrome 94+）
 *     ⇒ Chrome 81 **解析即 SyntaxError，嗰個 chunk 整份唔執行**；
 *   · 同一批檔案仲有 `Array.prototype.at`（92+）、`??=`（85+）、
 *     `crypto.randomUUID`（92+）、`Object.hasOwn`（93+）。
 *
 * React 因此永遠唔會 hydrate ⇒ `<ClientOnly>` 永遠停在 fallback ⇒ 商家見到一片白，
 * **而且完全冇任何線索**（連「載入中」都冇，因為 fallback 刻意無文字，見 layout.tsx 註解）。
 *
 * ## 為何一定要「內聯 + ES5 + 唔靠 React」
 *
 * 白屏嘅本質係「主 bundle 解析失敗」。所以補救層**唔可以**：
 *   · 写成 React component（一樣喺死咗嗰個 bundle 裡面）；
 *   · 用 Tailwind class（`@layer` 喺 Chrome 99 以下**整塊被丟棄**，等於冇樣式）；
 *   · 用 `?.` / `??` / 箭頭函數以外嘅新語法（最少都要 ES5，越舊越安全）。
 *
 * 所以：一個 `dangerouslySetInnerHTML` 內聯 `<script>`，純 ES5，樣式全內聯。
 * 佢**獨立於** React 生命週期 ⇒ 主 bundle 死幾多次都阻唔到佢執行。
 *
 * ## 三個刻意嘅設計決定
 *
 * 1. **fail-open**：`UA 拎唔到 Chrome 版本`（Safari、Firefox、新版 UA 精簡）→
 *    **直接 return，唔攔**。誤攔一個正常客人，比漏攔一個老機嚴重得多。
 * 2. **只喺 < 94 出手**。94–110 之間（例如 Android 7 的 WebView 106）JS 其實跑得郁，
 *    淨係 `color-mix()` / `oklch()` 缺失 ⇒ 顏色有瑕疵但**開得到單**。
 *    喺呢個區間彈全屏提示＝為咗美觀而阻住做生意，唔值。
 * 3. **掛喺 `body` 末尾、而且只喺老機掛**。版本夠嘅機 **一隻字節 DOM 都唔會多**，
 *    所以冇 hydration mismatch 風險（React 19 對額外節點極敏感，見 layout.tsx 內
 *    2026-10-12 翻譯擴充事件）。而 < 94 嘅機本來就唔會 hydrate，更加唔會撞。
 *
 * ## 原生殼（APK）內嘅文案唔同
 *
 * 喺 APK 裡面唔應該叫用戶「下載 APK」（已經裝緊）。改為叫佢更新
 * **Android System WebView** —— 因為 APK 都係 WebView 殼，WebView 舊一樣白屏。
 * 判斷方式同 `src/lib/app-update.ts` 一致：只認 `window.PosNative.checkAppUpdate`。
 */

/** 低於呢個版本，React 一定掛唔上（`static {}` 需要 Chrome 94）。 */
const MIN_SUPPORTED_CHROME = 94;

/**
 * 注入 `<body>` 開頭嘅補救腳本。
 *
 * ⚠️ 入面**唔可以有** `</script>` 字樣（會提早結束標籤），亦**唔可以**用
 * `${}` 插值（會被 build 當成模板）。反斜杠亦要小心：本檔用 `new RegExp("…")`
 * 而唔用 `/…\/…/` 字面量，避免 `\` 喺模板字符串被吞。
 */
export const BROWSER_COMPAT_GUARD_SCRIPT = `(function () {
  try {
    var MIN = ${MIN_SUPPORTED_CHROME};
    var ua = navigator.userAgent || "";
    var m = new RegExp("Chrome/([0-9]+)").exec(ua);
    if (!m) return; /* fail-open：認唔到就唔攔 */
    var v = parseInt(m[1], 10);
    if (!v || v >= MIN) return;

    var full = new RegExp("Chrome/[0-9.]+").exec(ua);
    var label = full ? full[0] : "Chrome " + v;
    var native = !!(window.PosNative && window.PosNative.checkAppUpdate);

    function el(tag, css, text) {
      var n = document.createElement(tag);
      if (css) n.setAttribute("style", css);
      if (text) n.appendChild(document.createTextNode(text));
      return n;
    }

    function build() {
      var root = el("div", "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;" +
        "background:#f2f4f7;padding:22px 16px 36px;overflow:auto;box-sizing:border-box;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','Microsoft YaHei',sans-serif;" +
        "color:#111827;line-height:1.6;-webkit-text-size-adjust:100%");
      root.setAttribute("id", "compat-guard");

      var card = el("div", "max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;" +
        "border-radius:16px;padding:24px 20px;box-shadow:0 8px 24px rgba(16,24,40,0.08)");

      card.appendChild(el("div", "font-size:12px;font-weight:700;letter-spacing:0.14em;color:#ea580c;margin-bottom:8px", "MACAU POS"));
      card.appendChild(el("div", "font-size:23px;font-weight:700;line-height:1.3;margin-bottom:12px", "這部裝置的瀏覽器太舊"));

      card.appendChild(el("div", "font-size:16px;color:#475467;margin-bottom:10px",
        "偵測到 " + label + "，本系統需要 Chrome " + MIN + " 或以上。"));
      card.appendChild(el("div", "font-size:16px;color:#475467;margin-bottom:18px",
        native
          ? "所以畫面停在空白 —— 請到「設定 → 應用程式 → Android System WebView」更新至最新版本，再重新開啟本程式。"
          : "所以畫面停在空白。這不是壞機，只是網頁引擎太舊，跑不動這個系統。"));

      if (!native) {
        var a = el("a", "display:block;padding:16px 14px;background:#f97316;border:1px solid #ea580c;" +
          "border-radius:12px;color:#ffffff;font-size:18px;font-weight:700;text-align:center;" +
          "text-decoration:none;box-sizing:border-box", "看安裝指引");
        a.setAttribute("href", "/install.html");
        card.appendChild(a);
      }

      card.appendChild(el("div", "margin-top:18px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;" +
        "border-radius:10px;font-size:14px;color:#92400e",
        "提醒：Android 6 的收銀機裝不到 APK（APK 要求 Android 7 以上）。最徹底的做法，是請供應商把固件升級到 Android 7 以上。"));

      card.appendChild(el("div", "margin-top:16px;font-size:12px;color:#98a2b3;text-align:center",
        "查詢裝置版本：設定 → 關於裝置 → Android 版本"));

      root.appendChild(card);
      return root;
    }

    function mount() {
      try {
        if (document.getElementById("compat-guard")) return;
        if (!document.body) return;
        document.body.appendChild(build());
      } catch (e) { /* 靜默：補救層自己都唔可以拋錯 */ }
    }

    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  } catch (e) { /* 靜默 */ }
})();`;
