/**
 * 退款「淨額口徑」共用邏輯（2026-09-17 商家實案）。
 *
 * 【背景】原本報表（`isSaleCountable()`）同交班（`summarizeClosedOrders()`）
 * 都係「退款單整張剔走」口徑：
 *   - `isSaleCountable()` 對 `refunded` / `partially_refunded` 直接回 false；
 *   - 交班只計 `settled` 單，退款單「連實收部分都唔計」。
 * 兩頁夾得埋，但**實收偏低**：「賣 100、退 30」正確實收 70，兩頁都當 0。
 *
 * 【正確口徑】**淨營業額 = 已計銷售單實收 − 退款總額**。
 * 因為退款只會喺已計銷售（`settled` / `paid`）嘅單上發生，兩種寫法等價：
 *   `Σ(countable.total) − Σ(refundedAmount)` ≡ `Σ(countable 未退部分)`
 * 用前者改動最小，原有 `revenue` / `paidTotal` 語義**不變**（仍只計已結帳），
 * 新增 `netRevenue` / `netPaidTotal` 並存 ⇒ 商家對數時「毛 / 淨」兩個數都睇得到。
 *
 * ⚠️ 為何呢個檔案係 `.ts` 而唔係放喺 `restaurant-daily-report.tsx`：
 * `node --test` 用 Node 內建 type-stripping，**唔支援 `.tsx` 副檔名**
 * （`ERR_UNKNOWN_FILE_EXTENSION`）。純函式抽到 `.ts` 才可以被單元測試直接載入。
 * 呢個係 2026-09-17 實測結論 —— 勿把純計算邏輯寫入元件檔。
 *
 * ⚠️ import 路徑用**相對 + 顯式 `.ts`**：`@/` 別名喺 Node ESM 解析唔到。
 */
import type { PosOrder } from "./types.ts";

/** 判斷訂單是否處於「已退款 / 部分退款」狀態（退款金額統計嘅唯一入口）。 */
export function isRefundedOrderStatus(status: string | undefined | null): boolean {
  return status === "refunded" || status === "partially_refunded";
}

/**
 * 單張訂單嘅退款金額。
 *
 * 取值優先序：
 *   1. `order.refundedAmount`（累計退款額，> 0 才用）；
 *   2. fallback：累加 `order.refundRecords[].amount`。
 *
 * ⚠️ 為何要 fallback：`refundedAmount` 係 2026-09-17 之後嘅欄位，
 * 舊資料 / 未跑 migration 嘅環境會係 `undefined`；而 `refundRecords` 一直都有。
 * 另外「全額折扣單退貨」實退 0 元 ⇒ `refundedAmount === 0`，唔可以因為 0 就當冇退。
 *
 * @returns 非負數嘅退款金額；髒資料（負數 / NaN）一律當 0，唔會拖低總額。
 */
export function refundAmountOf(order: PosOrder | undefined | null): number {
  if (!order) return 0;
  const fromField = Number(order.refundedAmount);
  if (Number.isFinite(fromField) && fromField > 0) return fromField;
  const records = order.refundRecords ?? [];
  let sum = 0;
  for (const rec of records) {
    const amount = Number(rec?.amount);
    if (Number.isFinite(amount) && amount > 0) sum += amount;
  }
  return sum;
}

/**
 * 一批訂單嘅**退款總額**。
 *
 * ⚠️ 只認 `refunded` / `partially_refunded` 狀態 —— 其他狀態理論上唔應該有
 * `refundedAmount`，但若資料髒咗（例如已結帳單被寫入退款欄），計入去會令
 * 淨額無端變細，所以收窄範圍。
 *
 * @returns 四捨五入到分嘅退款總額（避免浮點尾巴，如 0.1 + 0.2 = 0.30000000000000004）。
 */
export function refundTotalOf(orders: readonly PosOrder[] | undefined | null): number {
  let total = 0;
  for (const order of orders ?? []) {
    if (!isRefundedOrderStatus(order?.status)) continue;
    total += refundAmountOf(order);
  }
  return Math.round(total * 100) / 100;
}

/**
 * 一批訂單中有退款紀錄嘅**單數**（供 UI 顯示「N 張退款單」）。
 */
export function refundOrderCountOf(orders: readonly PosOrder[] | undefined | null): number {
  let count = 0;
  for (const order of orders ?? []) {
    if (isRefundedOrderStatus(order?.status)) count += 1;
  }
  return count;
}

/**
 * 淨額 = 毛額 − 退款總額，四捨五入到分。
 * 用於 `netRevenue`（報表）同 `netPaidTotal`（交班），確保兩頁同一套算法。
 */
export function netOf(gross: number, refundTotal: number): number {
  const g = Number.isFinite(gross) ? gross : 0;
  const r = Number.isFinite(refundTotal) ? refundTotal : 0;
  return Math.round((g - r) * 100) / 100;
}
