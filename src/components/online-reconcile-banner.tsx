"use client";

import { formatMoney } from "@/lib/format";
import {
  onlineFetchWarning,
  unadoptedNotice,
  type OnlineFetchStatus,
  type OnlineReconcile,
} from "@/lib/pos/online-reconcile";

/**
 * 線上單對數警示條（2026-09-24）。
 *
 * ## 為何要有呢個（P0）
 *
 * 2026-09-24 實案：表嫂美食取餐碼 001（MOP 43、餘額扣點）在 Ledger 已完成＋已付款，
 * 但 POS 訂單庫完全冇記錄 ⇒ 營業報表／交班明細**兩邊都見唔到**，而且：
 *
 * - 「Ledger 抓取失敗」只有喺「尖峰時段」卡細字顯示；
 * - 「未登入 Ledger（skipped）」**完全靜默**；
 * - 「N 張已付款單只喺 Ledger、POS 冇單」**從來冇提示過**。
 *
 * 商家只會見到「報表同實收夾唔埋」，無從判斷係計錯定漏單。
 *
 * ## 顯示規則（冇事就完全唔 render —— 佈局零改動）
 *
 * | 情況 | 顯示 |
 * |---|---|
 * | Ledger 抓取 `error` / `skipped` | 紅色警示：今日線上金額可能不完整 |
 * | 有「已付款但 POS 冇單」 | 橙色警示 ＋ 「補建入 POS」按鈕 |
 * | 兩者皆無 | `null`（唔佔位） |
 *
 * ⚠️ 呢個元件**唔會自己抓資料**（零新請求）：全部輸入由呼叫端已經抓到嘅資料推導。
 *    補建亦只喺用戶主動撳先發生（一次 `get_order_detail` ＋ 一次上雲 sync）。
 */
export type OnlineReconcileBannerProps = {
  reconcile: OnlineReconcile;
  fetchStatus: OnlineFetchStatus;
  fetchError?: string | null;
  /** 補建進行中（防連點）。 */
  busy?: boolean;
  /** 撳「補建入 POS」；冇傳 = 只顯示、唔提供動作（例如交班唯讀視圖）。 */
  onBackfill?: () => void;
  /** 補建結果說明（成功／失敗），由呼叫端提供。 */
  backfillMessage?: string | null;
};

export function OnlineReconcileBanner({
  reconcile,
  fetchStatus,
  fetchError,
  busy = false,
  onBackfill,
  backfillMessage,
}: OnlineReconcileBannerProps) {
  const warning = onlineFetchWarning(fetchStatus, fetchError ?? null);
  const notice = unadoptedNotice(reconcile);

  if (!warning && !notice && !backfillMessage) return null;

  return (
    <div className="space-y-2">
      {warning ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <div className="font-semibold">線上資料不完整</div>
          <div className="mt-0.5">{warning}</div>
        </div>
      ) : null}

      {notice ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <div className="font-semibold">有線上單未入 POS 記錄</div>
          <div className="mt-0.5">
            {notice}
            {reconcile.unadoptedCount > 0 ? (
              <>
                {" "}
                未補建前，交班／「線下訂單」／對帳都唔會見到呢
                {reconcile.unadoptedCount} 張單。
              </>
            ) : null}
          </div>
          {reconcile.unadopted.length > 0 ? (
            <div className="mt-1 text-xs text-amber-800">
              取餐碼：
              {reconcile.unadopted
                .slice(0, 12)
                .map((o) => o.pickupCode ?? o.id.slice(0, 8))
                .join("、")}
              {reconcile.unadopted.length > 12 ? ` 等 ${reconcile.unadopted.length} 張` : ""}
              {" · 合計 "}
              {formatMoney(reconcile.unadoptedAmountMop)}
            </div>
          ) : null}
          {onBackfill ? (
            <button
              type="button"
              onClick={onBackfill}
              disabled={busy}
              className="mt-2 inline-flex min-h-[44px] items-center rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "補建中…" : `補建入 POS（${reconcile.unadoptedCount} 張）`}
            </button>
          ) : null}
        </div>
      ) : null}

      {backfillMessage ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          {backfillMessage}
        </div>
      ) : null}
    </div>
  );
}
