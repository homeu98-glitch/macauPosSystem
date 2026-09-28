"use client";

/**
 * 線上單自動補建 hook（2026-09-27）—— 商家口徑：「商家不應該需要按這個」。
 *
 * ## 背景（P1 · 治第一層）
 *
 * 2026-09-24 實案：外賣自取線上單（取餐碼 001 · MOP 43 · 餘額扣點）喺 Ledger
 * 已完成＋已付款，但 POS 從未建本地單 ⇒ 營業報表／交班明細**兩邊都見唔到**，
 * 而商家完全冇任何提示。舊版本只提供一個手動「補建入 POS」按鈕。
 *
 * 商家明確表示**唔應該要佢撳** ⇒ 補建改為**自動**。本 hook 負責
 * **(b) 被動兜底** —— 捕捉「已經 `completed` ＋ `paid`、而本機完全冇
 * `ledger-<id>`」嘅漏帳單（**(a) 主動採納**由既有接單路徑處理）。
 *
 * 搭**既有** Ledger 拉取節拍（`ledgerOrders` 變化），**零新增請求節拍**。
 *
 * ## 點解要 hook（而唔係喺兩個元件各寫一次）
 *
 * 兩個消費者（`online-orders.tsx` 訂單頁、`quick-online-orders-panel.tsx` POS 主界面
 * 快捷面板）都要同一份邏輯。共用一份可保證「去重、唔出紙、唔漂日期」三條鐵律
 * **單點維護**。
 *
 * ## 🔴 三條鐵律（缺一都會出錯，改動前必讀）
 *
 * 1. **唔可以重新出紙**：一律傳 `skipPrint: true`（由 `adoptCompletedLedgerOrderToLocal`
 *    內部處理）。補建嘅單係「已經做過、只係冇入帳」，廚房唔應該再收紙。
 * 2. **唔可以覆蓋已有本地單**：`adoptCompletedLedgerOrderToLocal()` 內有硬 guard
 *    （本機 `loadOrders()` 冇 `ledger-<id>` 才補）。本 hook 再加**雲端交叉核對**
 *    （見 `fetchAdoptedOnlineIds`），杜絕「換機／本機冇歷史」時嘅誤補。
 * 3. **唔可以漂移訂單歸屬日**：`adoptCompletedLedgerOrderToLocal()` 用
 *    `updatedAtOverride`（Ledger 事件時間）＋ `settledAt`（0057 不可變業務時間）。
 *
 * ## 🔴 「不影響現有的功能」
 *
 * - 本 hook 只**新增**一個 effect，**唔改**任何既有 effect / handler。
 * - 無單可補 ⇒ 除咗一個零成本嘅 Set 運算，乜都唔做（**日常流程零變化**）。
 * - 雲端核對失敗 ⇒ fallback 本機判準，行為同今日一致（見 `adopted-online-ids.ts`）。
 * - 每張單**每個掛載最多試一次**（`attemptedRef`），唔會迴圈重試。
 */
import { useEffect, useRef } from "react";

import { fetchAdoptedOnlineIds } from "@/lib/pos/adopted-online-ids";
import {
  pickAdoptableOrders,
  type AdoptableLedgerOrderLike,
} from "@/lib/pos/adopt-completed-ledger-orders";

/**
 * 只要求 hook 需要嘅欄位。
 *
 * ⚠️ 純判定（`isAdoptableCompletedOrder` / `pickAdoptableOrders`）收喺
 *    `@/lib/pos/adopt-completed-ledger-orders`（**零 import**，可被 `node --test` 直接載入）；
 *    呢個檔案負責 React 生命週期，唔可以被單元測試 import。
 */
export type AdoptableLedgerOrder = AdoptableLedgerOrderLike;

export type UseAdoptCompletedLedgerOrdersOptions<T extends AdoptableLedgerOrder> = {
  /** Ledger 線上單（已付款／未付款全部；本 hook 自己篩）。 */
  ledgerOrders: readonly T[];
  /** 載入中 ⇒ 唔要動手（避免用未穩定嘅快照補建）。 */
  loading: boolean;
  /**
   * 真正執行補建。回 `null` ＝ 唔符安全閘（未付款／未完成／已有本地單）。
   * 呼叫端傳 `adoptCompletedLedgerOrderToLocal`（可 lazy import）。
   */
  adopt: (order: T) => Promise<unknown>;
  /**
   * 店舖／商戶 id。**用嚟做雲端交叉核對**；冇 → 跳過核對（純本機判準，＝今日行為）。
   * 亦係「換帳號要重置狀態」嘅 key。
   */
  merchantId?: string | null;
  /** `true` ⇒ 完全唔動手（例如 admin 模式 / 唯讀視圖）。 */
  disabled?: boolean;
};

/**
 * 自動補建「Ledger 已完成＋已付款、但 POS 冇記錄」嘅線上單。
 *
 * 呼叫方式（喺已經持有 `ledgerOrders` 嘅元件內）：
 * ```ts
 * useAdoptCompletedLedgerOrders({ ledgerOrders, loading, merchantId, adopt });
 * ```
 */
export function useAdoptCompletedLedgerOrders<T extends AdoptableLedgerOrder>(
  options: UseAdoptCompletedLedgerOrdersOptions<T>,
): void {
  const { ledgerOrders, loading, adopt, merchantId, disabled } = options;

  /** 本掛載內已嘗試過嘅 Ledger 單 id（成功／失敗／略過都算，避免迴圈）。 */
  const attemptedRef = useRef<Set<string>>(new Set());
  /** 雲端已入帳 id 快取（每個 merchantId 拉一次）。`null` ＝ 未拉／拉唔到。 */
  const remoteIdsRef = useRef<Set<string> | null>(null);
  /** 防止同時多個 effect 執行互相踩（補建本身會觸發 `pos-orders-changed`）。 */
  const runningRef = useRef(false);
  /** `adopt` 嘅 ref（呼叫端多數傳 inline 箭頭，identity 每次都變）。 */
  const adoptRef = useRef(adopt);
  useEffect(() => {
    adoptRef.current = adopt;
  }, [adopt]);

  // 換帳號／換店 ⇒ 清空所有狀態，避免用上一間店嘅資料判斷呢間店。
  useEffect(() => {
    attemptedRef.current = new Set();
    remoteIdsRef.current = null;
  }, [merchantId]);

  // 雲端交叉核對：每個 merchantId 只拉一次（零節拍成本）。
  useEffect(() => {
    if (disabled || loading || !merchantId) return;
    if (remoteIdsRef.current) return;
    let cancelled = false;
    void (async () => {
      const ids = await fetchAdoptedOnlineIds({ storeId: merchantId, hours: 48 });
      if (cancelled) return;
      remoteIdsRef.current = new Set(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, [disabled, loading, merchantId]);

  useEffect(() => {
    if (disabled || loading) return;
    if (ledgerOrders.length === 0) return;
    /**
     * 🔴 冇 `merchantId` ⇒ **唔補**。
     *
     * 正常情況冇 merchantId 就冇 Ledger 單（`ledgerOrders` 空），呢度入唔到；
     * 但呢道閘係最後防線：補建會**寫入本機訂單庫並推上雲**，唔應該喺
     * 「唔知係邊間店」嘅情況下發生。亦令 admin／未登入視圖天然唯讀。
     */
    if (!merchantId) return;
    if (runningRef.current) return;

    const targets = pickAdoptableOrders(ledgerOrders, attemptedRef.current);
    if (targets.length === 0) return;

    runningRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        // 雲端集合可能仲未返（async）。未返就先用本機判準（＝今日行為）——
        // 唔可以為咗等雲端而唔補：補一張有 id 去重、唔會雙計，但漏帳係報表少錢。
        const remoteIds = remoteIdsRef.current ?? new Set<string>();

        for (const order of targets) {
          if (cancelled) return;
          // 標記「試過」：無論成功／失敗／略過，本掛載內唔會再試。
          attemptedRef.current.add(order.id);
          // 雲端已經有呢張單 ⇒ 略過（唔可以覆蓋，見檔頭鐵律 2）。
          if (remoteIds.has(order.id)) continue;
          try {
            await adoptRef.current(order);
          } catch {
            // 單張失敗唔可以拖死其餘；亦唔彈 toast（商家口徑：唔應該要佢理）。
          }
        }
      } finally {
        runningRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [disabled, loading, ledgerOrders, merchantId]);
}
