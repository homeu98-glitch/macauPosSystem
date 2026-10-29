"use client";

import { useEffect, useState } from "react";

import { clearAuthSession, loadAuthSession } from "@/lib/storage";
import { useNetworkOnline } from "@/lib/use-network-online";

/**
 * 「已略過」記喺 sessionStorage（唔係 localStorage）：見下面 §「為何用 sessionStorage」。
 */
const DISMISS_KEY = "macau-pos/offline-relogin-dismissed";

/**
 * 收銀台「呢次係離線登入，建議重新登入」橫幅（2026-10-30，P4 收尾）。
 *
 * ## 為何要有呢個橫幅
 *
 * P4 嘅**離線登入**係用**本機憑證**（`offline-credential.ts` 嘅 PBKDF2 驗證器）
 * 開出嚟嘅 session：server 完全冇份參與，**server 亦從未認過呢個 token**。
 * 網路由「斷」變「通」之後：
 *
 *   · 單據／沽清／交班照常做得（呢啲本來就 fail-soft，OK）；
 *   · 但**身份從未被 server 驗證過** —— 權限係由本機憑證嗰份快照 copy 返嚟，
 *     假如店主呢幾日改過某個店員嘅權限／停咗佢個帳號，呢部機係唔會知嘅；
 *   · `AuthSession` 上嘅 token 亦係**上次聯網嗰陣拎嘅舊 token**，可能已經過期。
 *
 * 冇提示嘅話，店員可以成日用住一個「server 唔認」嘅身分 —— 呢個係安全缺口。
 *
 * ## 為何淨係提示、**唔**自動踢人落線
 *
 * 1. 離線期間產生嘅單可能仲未補傳完；踢人落線＝操作員要重新揀身份打 PIN，
 *    而未同步完嘅隊列雖然唔會冇，但畫面上睇唔到進度會令人以為單唔見咗。
 * 2. 半開網絡（`navigator.onLine === true` 但實際打唔到 server）好常見，
 *    一偵測到 online 就踢人 → 會不停踢、唔停係 ack。
 * ⇒ in-flow 橫幅 + 人手撳。同 `SessionRevokedBanner` 同一套取捨。
 *
 * ## 為何用 sessionStorage 記「已略過」
 *
 *  reload 之後唔好再彈（relay 已經睇到），但**關機再開／換班**一定要再提醒。
 *  localStorage 會令呢部機從此再唔提（安全缺口復活）⇒ 一定要 sessionStorage。
 */
export function PosOfflineReloginBanner({
  pendingSyncCount,
}: {
  /** 仲未補傳上雲嘅事件數 —— 用嚟講清楚「重新登入唔會冇咗單」。 */
  pendingSyncCount: number;
}) {
  const online = useNetworkOnline();
  const [offlineLoginAt, setOfflineLoginAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true); // SSR／未確定前一律唔出

  useEffect(() => {
    // session 喺呢個分頁生命週期內唔會變（要改就一定行 login-screen），
    // 所以 mount 讀一次就夠，唔使訂閱 `notifyAuthSessionChanged`。
    setOfflineLoginAt(loadAuthSession()?.offlineLoginAt ?? null);
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!offlineLoginAt || !online || dismissed) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  /**
   * 真正嘅復原路徑：清 session → 回登入頁。
   *
   * ⚠️ 同 `SessionRevokedBanner` 一樣：**一定要先** `clearAuthSession()`，
   *    否則 `AuthGuard` 見到仲有 session 會即刻踢返嚟，撳落去好似冇反應。
   *
   * 只清 session（本機憑證、訂單、隊列、班別全部留底），
   *  💡 **刻意唔 call `signOutLedgerSession()`**：嗰個會 `markDeviceSignedOut()`
   *  → 呢部機下次開機唔會再自動認機器，等同懲罰用家（佢只係想驗證身份）。
   */
  function handleRelogin() {
    clearAuthSession();
    window.location.replace("/login");
  }

  const at = new Date(offlineLoginAt);
  const timeText = Number.isNaN(at.getTime())
    ? ""
    : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

  return (
    <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-amber-900">
          ⚠ 而家係「離線登入」身分
          {timeText ? `（${timeText} 用本機憑證開工）` : ""}
        </span>
        <span className="text-xs text-amber-900">
          入網時 server 仲未驗證過呢個身份，權限係幾日前嘅本機快照
          ——店員權限改過／帳號停用過，呢部機唔會知。建議重新登入一次。
        </span>
        {/* 獨立一行：收銀員最驚嘅係「單唔見」，要一眼講清楚唔會冇 */}
        <span className="w-full text-xs font-semibold text-amber-900">
          {pendingSyncCount > 0
            ? `重新登入唔會清走資料：本機訂單同 ${pendingSyncCount} 筆待補傳紀錄全部保留。`
            : "重新登入唔會清走資料：本機訂單全部保留。"}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button
            className="min-h-[40px] rounded-full bg-amber-600 px-4 text-sm font-semibold text-white"
            onClick={handleRelogin}
            type="button"
          >
            重新登入
          </button>
          <button
            className="min-h-[40px] rounded-full bg-white px-4 text-sm font-semibold text-amber-900 ring-1 ring-amber-300"
            onClick={dismiss}
            type="button"
          >
            暫時唔使
          </button>
        </span>
      </div>
    </div>
  );
}
