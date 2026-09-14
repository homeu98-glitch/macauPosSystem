"use client";

// 線上（Ledger)「已付款單」加總 —— 交班／報表嘅「線上實收」唯一來源（2026-09-14）。
//
// 🔴 為何唔用 RPC `get_merchant_report_summary.order_paid_avos`：
//    Ledger 對該欄位嘅定義係「**已完成**且 `payment_status=paid` 之 `total_avos` 合計」
//    ⇒ **口徑滯後**：客人已經付款，但訂單仲未推去 Ledger `completed`（例：掃碼／採納單本地
//    已經 settled，Ledger 爬梯未推完），嗰筆錢就唔會出現喺 RPC 度。
//    實案（2026-09-14 表嫂美食）：本地「訂單 002」= 線上已支付 38、本地顯示已完成，
//    但 Ledger 未同步完成 ⇒ RPC `order_paid_avos` 少咗 38 ⇒ 交班「線上線下合計」少算 38。
//
// 商家口徑（明確）：「**實收 = 今日實際收到嘅錢**」⇒ 用「已付款單逐張加總」，
// 唔理訂單有冇推去 completed。同時回報「已付款但未完成」嘅張數／金額，
// 方便 UI 解釋同 Ledger RPC 嘅差額。
//
// 篩選條件同報表頁（`restaurant-daily-report.tsx` 嘅 Ledger 線上單）完全一致：
//   ① 區間內（依 `createdAt ?? updatedAt`；澳門時區界線由 `resolveReportRange()` 提供）
//   ② 非取消（`status` 含 "cancel" 一律剔）
//   ③ `paymentStatus === "paid"`（未付款唔算錢）
//
// ⚠️ 唔好喺度改「只計 completed」——咁做就係返去 RPC 嗰個滯後口徑。

import { listMerchantOrders } from "@/lib/ledger/orders";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { resolveReportRange, type ReportRangeArg } from "@/lib/ledger/report-period";

export interface PaidLedgerOrdersTotal {
  /** 已付款線上單 `total` 加總（MOP）＝ 商家實際收到嘅線上錢。 */
  amountMop: number;
  /** 已付款線上單張數。 */
  count: number;
  /** 已付款但 **Ledger 未推 `completed`** 嘅張數（唔會入 RPC `order_paid_avos`）。 */
  incompleteCount: number;
  /** 上面嗰批未完成單嘅金額（MOP）。 */
  incompleteAmountMop: number;
  /**
   * 上面嗰批未完成單嘅 **Ledger order id**（最多 {@link MAX_INCOMPLETE_IDS} 個）。
   * 用途：UI「補推狀態」按鈕（`syncOnlineDineInCompletionById()`）。
   */
  incompleteIds: string[];
  /**
   * 逐張已付款線上單（**完整 row**）—— 供呼叫端
   * ① 同本地/POS 側嘅線上投影單做聯集去重（同一張單唔可以兩邊各計一次）；
   * ② 列出「Ledger 純線上單」明細（交班明細要見到 001 / 005 呢類從未入 POS DB 嘅單）。
   */
  orders: LedgerOnlineOrder[];
}

/** `incompleteIds` 上限（防一次補推打爆 RPC；一日嘅量遠低於此）。 */
const MAX_INCOMPLETE_IDS = 200;

/** 一頁 200 單；上限 8 頁 = 1600 單，足夠一日有餘。 */
const PAGE = 200;
const MAX_PAGES = 8;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 加總區間內「已付款」線上單（含未完成）。
 *
 * @param params.merchantId Ledger 商家／店舖 id（同 POS `authSession.merchantId` 一致）。
 * @param params.range 期間（`today` / `7d` / …，見 `resolveReportRange()`）。
 */
export async function sumPaidLedgerOrders(params: {
  merchantId: string;
  range: ReportRangeArg;
}): Promise<PaidLedgerOrdersTotal> {
  const period = resolveReportRange(params.range);
  if (!period) throw new Error("無法計算報表區間。");

  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.end);

  let amountMop = 0;
  let count = 0;
  let incompleteCount = 0;
  let incompleteAmountMop = 0;
  const incompleteIds: string[] = [];
  const paidOrders: LedgerOnlineOrder[] = [];

  // RPC `list_merchant_orders` 按 `updatedAt` DESC 排序，用 (since, sinceId) 由新到舊翻頁。
  let cursorSince: string | null = period.start;
  let cursorSinceId: string | null = null;

  outer: for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await listMerchantOrders({
      merchantId: params.merchantId,
      limit: PAGE,
      since: cursorSince,
      sinceId: cursorSinceId,
    });
    if (rows.length === 0) break;

    for (const order of rows) {
      const ts = order.createdAt ?? order.updatedAt;
      if (!ts) continue;
      const t = Date.parse(ts);
      if (!Number.isFinite(t)) continue;

      if (Number.isFinite(startMs) && t < startMs) {
        // 排序係由新到舊：一過區間起點，後面全部更舊 → 收工。
        break outer;
      }
      if (Number.isFinite(endMs) && t > endMs) continue;
      if (String(order.status ?? "").toLowerCase().includes("cancel")) continue;
      if (order.paymentStatus !== "paid") continue;

      const paid = Number(order.total ?? order.paidAmount ?? 0);
      const safePaid = Number.isFinite(paid) ? paid : 0;
      amountMop += safePaid;
      count += 1;
      paidOrders.push(order);

      if (String(order.status ?? "").toLowerCase() !== "completed") {
        incompleteCount += 1;
        incompleteAmountMop += safePaid;
        if (incompleteIds.length < MAX_INCOMPLETE_IDS) incompleteIds.push(order.id);
      }
    }

    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    cursorSince = last.updatedAt ?? last.createdAt ?? cursorSince;
    cursorSinceId = last.id;
  }

  return {
    amountMop: round2(amountMop),
    count,
    incompleteCount,
    incompleteAmountMop: round2(incompleteAmountMop),
    incompleteIds,
    orders: paidOrders,
  };
}
