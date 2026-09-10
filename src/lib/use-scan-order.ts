"use client";

import { useOrderingCore } from "@/lib/use-kiosk-order";

/**
 * **客人掃枱 QR 自助點餐**（手機 `/menu`）嘅專用 hook。
 *
 * ## 為何要同 kiosk 分開（2026-09-10 需求 2）
 *
 * 客人掃碼同店內自助機（平板 `/order`）係兩套**唔同**嘅流程：
 *
 * | | 自助點餐機 `/order` | 客人掃碼 `/menu` |
 * |---|---|---|
 * | 入口 hook | `useKioskOrder()` | `useScanOrder()` |
 * | 查詢／呈現依據 | 單號（`localOrderNo`） | **台號**（`tableId`） |
 * | 落單號碼 | 店內同日序號 `/api/pos/sequence` | **完全冇單號**（寫台名落 DB） |
 * | 已有訂單 | 由本機流程持有 | **每次由 DB 依台號載入**（DB 為準） |
 * | 顧客小票 | 落單後本機即印 | 唔印（由收銀台出單） |
 * | 成功頁 | 5 秒倒數自動返主頁 | 顯示本枱訂單，可加單，**冇「完成」** |
 *
 * 呢個 hook 只暴露掃碼需要嘅介面（堂食掃碼**冇**「完成 / 返主頁」呢個概念 ——
 * `returnToHome` 只係畀**快餐掃碼**（`/quick`）落單成功頁開新單用，見檔尾註解），
 * 避免 `/menu` 意外用到 kiosk 專屬行為。
 *
 * 底層共用 `useOrderingCore("scan")` 嘅**中性基礎設施**（menu bootstrap、售罄、
 * realtime、購物車、金額計算、落單重試 / 本地待同步隊列）—— 呢啲係兩套流程真正
 * 相同嘅部分，重複一份只會令修 bug 要改兩個地方（2026-09-10 事故就係咁漏）。
 * 「以單號為導向」嘅行為已經全部由 `variant` 分流，唔會行到掃碼路徑。
 */
export function useScanOrder() {
  const core = useOrderingCore("scan");

  return {
    // ── 載入 / 店舖 / 餐牌 ──
    hydrated: core.hydrated,
    menuLoading: core.menuLoading,
    menuUnavailable: core.menuUnavailable,
    bootstrap: core.bootstrap,
    displayStoreName: core.displayStoreName,
    language: core.language,
    needsBinding: core.needsBinding,
    storeId: core.storeId,

    // ── 枱號（掃碼流程嘅唯一查詢／呈現依據）──
    mode: core.mode,
    tableId: core.tableId,
    tableName: core.tableName,

    // ── 餐牌 / 購物車 ──
    activeCategory: core.activeCategory,
    setActiveCategory: core.setActiveCategory,
    categoryItems: core.categoryItems,
    soldoutIds: core.soldoutIds,
    cart: core.cart,
    setCart: core.setCart,
    totals: core.totals,
    orderNote: core.orderNote,
    setOrderNote: core.setOrderNote,
    specDraft: core.specDraft,
    setSpecDraft: core.setSpecDraft,
    pushLine: core.pushLine,
    changeQty: core.changeQty,

    // ── 本枱訂單（DB 為準）／落單 ──
    submittedOrder: core.submittedOrder,
    activeTableOrder: core.activeTableOrder,
    addToOrder: core.addToOrder,
    placeOrder: core.placeOrder,
    submitting: core.submitting,
    error: core.error,
    orderSyncPending: core.orderSyncPending,
    pendingSyncCount: core.pendingSyncCount,

    // ── 畫面流轉 ──
    started: core.started,
    startOrdering: core.startOrdering,
    ordering: core.ordering,
    /**
     * 清走落單成功頁、返去 landing（下一位 / 下一單重新「開始點餐」）。
     *
     * ⚠️ 只有**快餐掃碼**（`/quick`）會用到：快餐一單一單獨立，客人落完單要可以再開
     * 新單，所以成功頁必須有出口。堂食掃碼唔用（成功頁 = 「本枱訂單」，
     * 客人嘅出口係「加單」，冇「完成」概念 —— 見 docs/115）。
     */
    returnToHome: core.returnToHome,
  };
}

/** `useScanOrder()` 嘅回傳型別（供元件 props / 測試標註用）。 */
export type ScanOrderApi = ReturnType<typeof useScanOrder>;
