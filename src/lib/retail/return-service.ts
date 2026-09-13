"use client";

/**
 * 零售退換貨 —— **落帳服務**（唯一會碰 localStorage 嘅一層）。
 *
 * 【分層】`returns.ts` = 純計算（可單測）；本檔 = 副作用（儲存 / 出票 / 上雲）。
 * 呢個分法同 `retail-cart.ts` / `retail-orders.ts` 完全一致，唔可以喺純函式入面碰 storage。
 *
 * 🔴 **三條必守**：
 *   1. 落帳（改原單）→ 一定要入 outbox（`ORDER_UPDATED`）→ 否則雲端永遠見到舊狀態。
 *   2. 庫存回補 → 一定要經 `restoreStockForLines()`（唔可以自己加加減減 —— 稱重行單位係 kg）。
 *   3. 出票 → 一定要用 `appendPrintJobsWithSync()`（淨 `savePrintJobs()` ＝ 零出紙＋零紅標）。
 */

import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import { buildReceiptPrintJobs } from "@/lib/print-jobs";
import { isPrintContentEnabled } from "@/lib/print-toggles";
import {
  loadBootstrapCache,
  loadOrders,
  loadQueue,
  loadRetailProducts,
  saveOrders,
  saveQueue,
  saveRetailProducts,
} from "@/lib/storage";
import type { OrderItem, PosOrder, QueueEvent } from "@/lib/types";

import { restoreStockForLines, type StockChange } from "./stock.ts";
import { shouldRestock, type ReturnComputation } from "./returns.ts";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

export interface CommitReturnParams {
  /** 落帳後嘅新原單（由 `applyReturnToOrder()` 產出，未寫入） */
  order: PosOrder;
  computation: ReturnComputation;
  reason: string;
  operatorAccount?: string;
  operatorName?: string;
}

export interface CommitReturnResult {
  ok: boolean;
  /** 已回補嘅庫存變動（空 = 冇回補，睇 `restockSkipped`） */
  stockChanges: StockChange[];
  /** 冇回補嘅原因（唔可以靜默 —— 帳實要對得上） */
  restockSkipped?: string;
  /** 出票張數（0 = 未出票，睇 `printWarning`） */
  printJobCount: number;
  printWarning?: string;
  error?: string;
}

/**
 * 落帳一次退貨：改原單 → 回補庫存 → 上雲 → 出退款單。
 *
 * 次序同 `settleRetailOrder()` 一致（**先動庫存、再寫單、最後出票**）：
 * 庫存寫入失敗唔阻止落帳（客人已經收到錢），但一定要出聲。
 */
export function commitReturn(params: CommitReturnParams): CommitReturnResult {
  const { order, computation } = params;
  if (!computation.ok || computation.lines.length === 0) {
    return {
      ok: false,
      stockChanges: [],
      printJobCount: 0,
      error: "退貨計算未通過，唔可以落帳",
    };
  }

  const now = new Date().toISOString();
  let stockChanges: StockChange[] = [];
  let restockSkipped: string | undefined;

  // ── ① 庫存回補 ──────────────────────────────────────────────
  const restock = shouldRestock(params.reason);
  if (!restock) {
    restockSkipped = `原因「${params.reason}」→ 貨品唔入返貨架（照退款，庫存不變）`;
  } else {
    const products = loadRetailProducts();
    if (products.length === 0) {
      restockSkipped = "本機冇商品主檔 → 庫存未回補";
    } else {
      const lines = computation.lines.map((l) => ({
        lineId: l.key,
        productId: l.key.split("::")[0] ?? "",
        variantId: l.key.split("::")[1] || undefined,
        name: l.name,
        unitPrice: 0,
        unit: "件",
        quantity: l.kg > 0 ? 1 : l.qty,
        ...(l.kg > 0 ? { isWeighed: true, weightKg: l.kg } : {}),
      }));

      const applied = restoreStockForLines(products, lines);
      stockChanges = applied.changes;
      if (applied.skipped.length > 0) {
        // 對唔中商品（已刪 / 已停售 / 有變體但行上冇 variantId）→ 庫存冇回補，要報
        restockSkipped = `${applied.skipped.length} 行冇回補（商品已刪 / 停售 / 缺變體）`;
        console.warn("[retail] 退貨庫存未全數回補：", applied.skipped);
      }
      if (!saveRetailProducts(applied.products)) {
        console.error("[retail] 退貨庫存寫入失敗（quota / 私隱模式？）→ 庫存可能未回補");
        restockSkipped = "庫存寫入失敗（儲存空間不足 / 私隱模式）";
      }
    }
  }

  // ── ② 改原單（本機）────────────────────────────────────────
  const orders = loadOrders();
  const idx = orders.findIndex((o) => o.id === order.id);
  if (idx < 0) {
    return {
      ok: false,
      stockChanges,
      printJobCount: 0,
      error: "搵唔到原單（可能已被清除）→ 冇改動過任何嘢",
    };
  }
  const next = [...orders];
  next[idx] = order;
  // ⚠️ `saveOrders()` 回 void（既有契約，唔似 `saveRetailProducts()` 有 boolean）→
  // 唔可以測 truthiness；寫入失敗只可以靠 storage 層自己出聲。
  try {
    saveOrders(next);
  } catch (e) {
    console.error("[retail] 退貨寫入訂單失敗", e);
    return {
      ok: false,
      stockChanges,
      printJobCount: 0,
      error: "訂單寫入失敗 → 退款未記錄",
    };
  }

  // ── ③ 上雲 ─────────────────────────────────────────────────
  const event: QueueEvent = {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "ORDER_UPDATED",
    entityId: order.id,
    // 🔴 一定要 `{ order }` 包住（同 ORDER_UPDATED 契約一致，見 docs/113）
    payload: { order },
    status: "pending",
    createdAt: now,
  };
  saveQueue(enqueueEvents(loadQueue(), withStoreScope([event])));
  notifyQueueChanged();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  // ── ④ 出退款單 ──────────────────────────────────────────────
  let printJobCount = 0;
  let printWarning: string | undefined;
  try {
    if (!isPrintContentEnabled("receipt")) {
      printWarning = "「收據」打印開關已關 → 未出票";
    } else {
      const bootstrap = loadBootstrapCache();
      if (!bootstrap) {
        printWarning = "冇門店資料快取（bootstrap）→ 未出票";
      } else {
        const receiptView = buildReturnReceiptView(order, computation, params);
        const jobs = buildReceiptPrintJobs(receiptView, bootstrap);
        printJobCount = appendPrintJobsWithSync(jobs);
        if (printJobCount === 0) {
          printWarning = "冇啟用嘅收據機（role=receipt）→ 未出票";
        }
      }
    }
  } catch (e) {
    printWarning = "退款單出票失敗（詳見 console）";
    console.error("[retail] 退款單出票失敗", e);
  }

  return {
    ok: true,
    stockChanges,
    ...(restockSkipped ? { restockSkipped } : {}),
    printJobCount,
    ...(printWarning ? { printWarning } : {}),
  };
}

/**
 * 砌出「退款單」用嘅 order 視圖（唔會寫入 orders）。
 *
 * 【為何用收據通道而唔另開一個 ticketType】
 * 零售冇 zone 打印機（廚房單去 zone，會零出紙）；收據係 `role === "receipt"`，
 * 而退款單正正應該出畀客人 → 收據機係唯一正確嘅出口。
 *
 * 【點印退款金額 / 方式】
 * 收據模板**冇**「退款」區塊（`refund` 係交班單專用）→ 用「全單備註」承載：
 * 多行文字（退款方式逐筆 + 合計 + 原單號），唔需要改任何模板 / 四端 renderer。
 */
export function buildReturnReceiptView(
  order: PosOrder,
  computation: ReturnComputation,
  opts: { reason: string; operatorName?: string },
): PosOrder {
  const returnItems: OrderItem[] = computation.lines.map((l) => ({
    menuItemId: l.key.split("::")[0] ?? "",
    name: l.name,
    quantity: l.kg > 0 ? 1 : l.qty,
    // 退款單印「退幾錢」而唔係原售價 → price 放退款金額，數量 1
    price: l.amount,
    printerGroup: "receipt",
    ...(l.kg > 0 ? { weightKg: l.kg } : {}),
  }));

  const lines: string[] = [];
  lines.push(`※ 退款單（原單 ${order.localOrderNo}）`);
  lines.push(`原因：${opts.reason || "客人退貨"}`);
  if (opts.operatorName) lines.push(`經手：${opts.operatorName}`);
  for (const r of computation.refundByMethod) {
    lines.push(`退回${r.label}：$${r.amount.toFixed(2)}`);
  }
  lines.push(`退款合計：$${computation.totalRefund.toFixed(2)}`);
  if (computation.orderDiscountRefund > 0) {
    lines.push(`（已扣回整單折扣 $${computation.orderDiscountRefund.toFixed(2)}）`);
  }

  return {
    ...order,
    // 子單號：原單號 + 退序（同一張單退兩次唔會印出兩個一樣嘅單號）
    localOrderNo: `${order.localOrderNo}-退${(order.refundRecords?.length ?? 0) + 1}`,
    status: computation.isFullRefund ? "refunded" : "partially_refunded",
    items: returnItems,
    subtotal: round2(computation.lines.reduce((s, l) => s + l.amount, 0)),
    discountAmount: 0,
    total: computation.totalRefund,
    orderNote: lines.join("\n"),
  };
}
