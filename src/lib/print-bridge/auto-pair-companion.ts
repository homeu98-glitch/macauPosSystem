// 自動配對桌面 Companion：令普通用戶「全程唔使手動改設定」。
//
// 觸發時機：POS app mount 嗰陣 call 一次 tryAutoPairCompanion()。
// 邏輯（二擇一）：
//   1) URL 帶 ?companion=<url>（Companion 狀態頁「一鍵開 POS 並自動配對」會帶埋）→ 直接寫入 localStorage。
//   2) 否則 probe http://127.0.0.1:9311/api/config，連到就自動寫入 companionUrl。
//
// 安全：全部 try/catch；mixed content 擋到就靜默 skip（用家可改用手動卡或 localhost dev 版 POS）。
// 寫入嘅 key 同 companion-config.ts 嘅 COMPANION_URL_KEY 一致，dispatch 自然會用 companion。

const COMPANION_URL_KEY = "macau-pos-companion-url";

export function tryAutoPairCompanion(): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromParam = params.get("companion");
    if (fromParam && fromParam.trim()) {
      window.localStorage.setItem(COMPANION_URL_KEY, fromParam.trim());
      return;
    }
    fetch("http://127.0.0.1:9311/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { companionUrl?: string } | null) => {
        if (cfg && cfg.companionUrl) {
          window.localStorage.setItem(COMPANION_URL_KEY, cfg.companionUrl);
        }
      })
      .catch(() => {
        /* 靜默：loopback 被擋或 Companion 未起動 */
      });
  } catch {
    /* 靜默 */
  }
}
