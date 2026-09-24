/**
 * 線上單對數（2026-09-24）—— 找出「**Ledger 已付款，但 POS 訂單庫完全冇記錄**」嘅線上單。
 *
 * ## 為咩要有呢個
 *
 * 「外賣自取」嘅線上單，POS 收到後只行出紙兜底、**唔會建本地單**（見
 * `ledger-pos-bridge.ts` 嘅 `adoptCompletedLedgerOrderToLocal` 檔頭）。商家若冇喺 POS
 * 撳「採納／完成」，就會出現「Ledger 有、POS 冇」嘅靜默缺口：
 *
 * - 訂單頁「線上訂單」見到（讀 Ledger）；
 * - 營業報表／交班明細見唔到（讀 POS 訂單庫）。
 *
 * 2026-09-24 實案：表嫂美食取餐碼 001（MOP 43、餘額扣點、預約單）就係咁樣唔入帳，
 * **零紅標、零提示**，商家只會覺得「報表同實收夾唔埋」。
 *
 * ## 呢個模組嘅職責（單一）
 *
 * 只做**純判定**：邊幾張 Ledger 已付款單冇對應嘅 POS 單。唔抓資料、唔寫資料、唔出紙。
 * 呼叫端負責把結果顯示出嚟（P0）同決定要唔要補建（P1）。
 *
 * ## 點解要零依賴
 *
 * `npm test` ＝ `node --test`：**唔認 `@/` 別名、唔行 bundler、唔支援 `.tsx`**，
 * 而且 import 要有副檔名。所以呢個檔用相對路徑 import，唔可以引入任何 `@/` 依賴。
 */

/** 對數只需要嘅 Ledger 欄位（structural typing —— 唔綁死 `LedgerOnlineOrder`）。 */
export type ReconcilableLedgerOrder = {
  id: string;
  /** `paid` / `unpaid`（見 `mapLedgerOrderRow`）。 */
  paymentStatus?: string;
  /** Ledger 原始狀態；含 "cancel" 一律當取消。 */
  status?: string;
  /** 金額（MOP）。 */
  total?: number;
  pickupCode?: string;
};

/** 對數只需要嘅 POS 欄位。 */
export type ReconcilablePosOrder = {
  /** POS 單對應嘅 Ledger id；冇 ＝ 呢張係純線下單。 */
  onlineOrderId?: string | null;
};

export type OnlineReconcile = {
  /** 未入 POS 記錄嘅線上單（已付款、非取消）——**可以補建**。 */
  unadopted: ReconcilableLedgerOrder[];
  unadoptedCount: number;
  unadoptedAmountMop: number;
  /** 已付款、非取消嘅線上單總數（含已入帳）——分母，用嚟講「有幾多靠 Ledger 撐住」。 */
  paidCount: number;
  /** 上述未入帳單嘅金額合計（同上，方便直接顯示）。 */
  paidAmountMop: number;
};

/** 金額四捨五入到分。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `cancel*` 一律當取消（同報表 / 交班 / `paid-orders.ts` 同一口徑）。 */
export function isCancelledLedgerOrder(order: ReconcilableLedgerOrder): boolean {
  return String(order.status ?? "").toLowerCase().includes("cancel");
}

/**
 * 對數：`ledgerOrders` **必須**已經係「當前報表區間內」嘅單。
 *
 * @returns 未入 POS 記錄嘅線上單（連張數／金額）。
 */
export function reconcileOnlineOrders(params: {
  ledgerOrders: readonly ReconcilableLedgerOrder[];
  posOrders: readonly ReconcilablePosOrder[];
}): OnlineReconcile {
  const adopted = new Set<string>();
  for (const order of params.posOrders) {
    const id = order.onlineOrderId;
    if (typeof id === "string" && id) adopted.add(id);
  }

  const unadopted: ReconcilableLedgerOrder[] = [];
  let paidCount = 0;
  let paidAmountMop = 0;
  let unadoptedAmountMop = 0;

  for (const order of params.ledgerOrders) {
    if (!order?.id) continue;
    if (isCancelledLedgerOrder(order)) continue;
    if (String(order.paymentStatus ?? "").toLowerCase() !== "paid") continue;

    const amount = Number(order.total ?? 0);
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    paidCount += 1;
    paidAmountMop += safeAmount;

    if (adopted.has(order.id)) continue;
    unadopted.push(order);
    unadoptedAmountMop += safeAmount;
  }

  return {
    unadopted,
    unadoptedCount: unadopted.length,
    unadoptedAmountMop: round2(unadoptedAmountMop),
    paidCount,
    paidAmountMop: round2(paidAmountMop),
  };
}

/** Ledger 線上單抓取狀態（同 `restaurant-daily-report.tsx` 嘅 `onlineFetchInfo.status`）。 */
export type OnlineFetchStatus = "idle" | "loading" | "success" | "error" | "skipped";

/**
 * 「線上資料唔完整」嘅警示文案；冇問題 → `null`。
 *
 * 🔴 舊寫法 `error` 只喺「尖峰時段」卡顯示、`skipped` 完全靜默 ⇒
 * 商家睇唔到「今日線上金額係殘缺嘅」。呢個函式令兩個狀態都一定有文案。
 */
export function onlineFetchWarning(
  status: OnlineFetchStatus,
  lastError?: string | null,
): string | null {
  if (status === "error") {
    return `Ledger 線上單抓取失敗${lastError ? `（${lastError}）` : ""}，今日線上金額可能不完整。`;
  }
  if (status === "skipped") {
    return `未載入 Ledger 線上單${lastError ? `（${lastError}）` : ""}，今日線上金額未計入報表。`;
  }
  return null;
}

/**
 * 「有未入帳線上單」嘅提示文案；冇 → `null`。
 *
 * @param reconcile 對數結果
 */
export function unadoptedNotice(reconcile: OnlineReconcile): string | null {
  if (reconcile.unadoptedCount <= 0) return null;
  const amount = round2(reconcile.unadoptedAmountMop);
  return `有 ${reconcile.unadoptedCount} 張線上已付款單（MOP ${amount}）POS 冇記錄，只靠 Ledger 計入。`;
}
