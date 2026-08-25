"use client";

import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  addClearedPrintJobIds,
  loadAuthSession,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  savePrintJobs,
} from "@/lib/storage";
import { PosBootstrap, PosOrder, PrintJob } from "@/lib/types";
import { formatMoney } from "@/lib/format";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function appendPrintJobs(jobs: PrintJob[]) {
  if (jobs.length === 0 || typeof window === "undefined") return;
  savePrintJobs([...jobs, ...loadPrintJobs()]);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { count: jobs.length } }));
}

export function buildReceiptPrintJobs(
  order: PosOrder,
  bootstrap: PosBootstrap,
): PrintJob[] {
  const receiptSettings = loadPosLocalSettings().printTemplates.receipt;
  type ReceiptItem = NonNullable<PrintJob["items"]>[number];

  const receiptPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "receipt",
  );
  if (receiptPrinters.length === 0) return [];

  const timestamp = new Date().toISOString();
  const receiptSections: Record<(typeof receiptSettings.sectionOrder)[number], ReceiptItem[]> = {
    store_name: receiptSettings.showStoreName ? [{ name: "門店", quantity: 1, specs: [], note: bootstrap.storeName }] : [],
    order_no: receiptSettings.showOrderNo ? [{ name: "單號", quantity: 1, specs: [], note: order.localOrderNo }] : [],
    table_name: receiptSettings.showTableName ? [{ name: "桌號", quantity: 1, specs: [], note: order.tableName }] : [],
    items: [
      ...order.items.map<ReceiptItem>((item) => ({
        name: item.name,
        quantity: item.quantity,
        specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
        note: item.note,
      })),
      ...(order.voidedItems ?? []).map<ReceiptItem>((item) => ({
        name: `（已退菜）${item.name}`,
        quantity: item.quantity,
        specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
        note: item.voidedReason ?? item.note,
      })),
    ],
    total: [{ name: "總計", quantity: 1, specs: [], note: formatMoney(order.total, bootstrap.currency) }],
    payment_method:
      receiptSettings.showPaymentMethod && order.paymentMethod
        ? [{ name: "付款方式", quantity: 1, specs: [], note: String(order.paymentMethod) }]
        : [],
    order_note:
      receiptSettings.showOrderNote && order.orderNote
        ? [{ name: "全單備註", quantity: 1, specs: [], note: order.orderNote }]
        : [],
    footer: receiptSettings.footerText ? [{ name: "頁尾", quantity: 1, specs: [], note: receiptSettings.footerText }] : [],
  };
  const receiptItems: NonNullable<PrintJob["items"]> = receiptSettings.sectionOrder.flatMap(
    (section) => receiptSections[section],
  );

  return receiptPrinters.map<PrintJob>((printer) => ({
    id: uid("print"),
    orderId: order.id,
    orderNo: order.localOrderNo,
    tableName: order.tableName,
    ticketType: "normal",
    printerGroup: "receipt",
    printerId: printer.id,
    printerName: printer.name,
    items: receiptItems,
    status: "pending",
    createdAt: timestamp,
  }));
}

export function buildVoidPrintJobsForOrder(order: PosOrder, reason: string): PrintJob[] {
  const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
  const timestamp = new Date().toISOString();
  const voidPrintJobs: PrintJob[] = [];

  for (const item of order.items) {
    const jobs = configuredPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") && (printer.zoneId ?? "") === item.printerGroup,
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: order.localOrderNo,
        tableName: order.tableName,
        ticketType: "void",
        printerGroup: printer.zoneId ?? item.printerGroup,
        printerId: printer.id,
        printerName: printer.name,
        items: [
          {
            name: item.name,
            quantity: item.quantity,
            specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
            note: reason || "線上訂單已取消",
          },
        ],
        status: "pending",
        createdAt: timestamp,
      }));
    voidPrintJobs.push(...jobs);
  }

  return voidPrintJobs;
}

/**
 * 返結（反結賬）列印：把已結單退回可編輯狀態時，印一張「返結單」到所有啟用中的
 * 區域 / 標籤印表機，記錄原單號、原因、操作人，便於廚房 / 吧檯與收銀對帳。
 * ticketType 沿用 "void"（修正單），並於項目名稱前加【返結】標記。
 */
export function buildReopenPrintJobs(order: PosOrder, reason: string, operator: string): PrintJob[] {
  const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
  const timestamp = new Date().toISOString();
  const reopenPrintJobs: PrintJob[] = [];

  for (const item of order.items) {
    const jobs = configuredPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") && (printer.zoneId ?? "") === item.printerGroup,
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: order.localOrderNo,
        tableName: order.tableName,
        ticketType: "void",
        printerGroup: printer.zoneId ?? item.printerGroup,
        printerId: printer.id,
        printerName: printer.name,
        items: [
          {
            name: `【返結】${item.name}`,
            quantity: item.quantity,
            specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
            note: `原因：${reason || "結帳錯誤"}｜操作人：${operator}`,
          },
        ],
        status: "pending",
        createdAt: timestamp,
      }));
    reopenPrintJobs.push(...jobs);
  }

  return reopenPrintJobs;
}

export function findPosOrderForLedger(ledgerOrderId: string): PosOrder | null {
  const posOrderId = `ledger-${ledgerOrderId}`;
  return loadOrders().find((row) => row.id === posOrderId || row.onlineOrderId === ledgerOrderId) ?? null;
}

export function printReceiptForPosOrder(order: PosOrder): number {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return 0;
  const jobs = buildReceiptPrintJobs(order, bootstrap);
  appendPrintJobs(jobs);
  return jobs.length;
}

export function printVoidForLedgerOrder(ledgerOrderId: string, reason = "線上訂單已取消"): number {
  const order = findPosOrderForLedger(ledgerOrderId);
  if (!order || order.items.length === 0) return 0;
  const jobs = buildVoidPrintJobsForOrder(order, reason);
  appendPrintJobs(jobs);
  return jobs.length;
}

export async function printReceiptForLedgerOrder(
  ledgerOrderId: string,
  options?: { paymentMethod?: string; networkOnline?: boolean },
): Promise<number> {
  let order = findPosOrderForLedger(ledgerOrderId);
  if (!order) return 0;

  if (options?.paymentMethod) {
    order = { ...order, paymentMethod: options.paymentMethod };
  }

  return printReceiptForPosOrder(order);
}

const recentVoidLedgerIds = new Set<string>();
const recentReceiptLedgerIds = new Set<string>();

function rememberOnce(set: Set<string>, key: string) {
  if (set.has(key)) return false;
  set.add(key);
  if (typeof window !== "undefined") {
    window.setTimeout(() => set.delete(key), 60_000);
  }
  return true;
}

export function printVoidForLedgerOrderOnce(ledgerOrderId: string, reason = "線上訂單已取消"): number {
  if (!rememberOnce(recentVoidLedgerIds, ledgerOrderId)) return 0;
  return printVoidForLedgerOrder(ledgerOrderId, reason);
}

export async function printReceiptForLedgerOrderOnce(
  ledgerOrderId: string,
  options?: { paymentMethod?: string; networkOnline?: boolean },
): Promise<number> {
  if (!rememberOnce(recentReceiptLedgerIds, ledgerOrderId)) return 0;
  return printReceiptForLedgerOrder(ledgerOrderId, options);
}

/**
 * 經 /api/pos/sync 推送 `PRINT_JOB_DELETED` 事件，真刪伺服器 `pos_print_jobs` 行。
 * 離線 / 失敗唔阻礙：本機 tombstone（addClearedPrintJobIds）已經防止 backfill 復活，
 * 伺服器行喺恢復網絡後由下次 sync 清走（見 docs/52）。
 */
export async function deletePrintJobsOnServer(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const storeId =
    loadAuthSession()?.merchantId ?? loadBootstrapCache()?.storeId ?? undefined;
  if (!storeId) return;
  const events = ids.map((id) => ({
    id: `pjd-${id}`,
    type: "PRINT_JOB_DELETED" as const,
    entityId: id,
    payload: { id },
    status: "synced" as const,
    createdAt: new Date().toISOString(),
  }));
  try {
    await fetch("/api/pos/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events, storeId }),
    });
  } catch {
    // 離線：tombstone 已擋復活；成功連線後由 flush / sync 再清伺服器行
  }
}

/**
 * 自動清理：移除已發送（sent）超過 olderThanDays 日嘅打印單，避免 localStorage 無限累積。
 * 保留 recent sent（俾用家短時間內喺打印中心見到「已發送」）+ 所有 pending / failed（等跟進）。
 * flush worker 每次 tick 完會 call（見 dispatch.ts）。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。
 */
export function pruneSentPrintJobs(olderThanDays = 7): number {
  const jobs = loadPrintJobs();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const kept = jobs.filter((j) => {
    if (j.status !== "sent") return true;
    const t = j.createdAt ? new Date(j.createdAt).getTime() : 0;
    return Number.isNaN(t) ? true : t > cutoff;
  });
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const prunedIds = jobs.filter((j) => !kept.includes(j)).map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(prunedIds);
    void deletePrintJobsOnServer(prunedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}

/** 手動「清除已發送」：移除所有 sent 單（保留 pending / failed 等用家跟進）。打印中心按鈕 call。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。 */
export function clearSentPrintJobs(): number {
  const jobs = loadPrintJobs();
  const kept = jobs.filter((j) => j.status !== "sent");
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const removedIds = jobs.filter((j) => j.status === "sent").map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(removedIds);
    void deletePrintJobsOnServer(removedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}

/** 手動「清除已失敗」：移除所有 failed 單（保留 pending / sent）。打印中心按鈕 call。
 * 真刪：記錄 clearedPrintJobIds tombstone + 推送伺服器 DELETE（見 docs/52）。 */
export function clearFailedPrintJobs(): number {
  const jobs = loadPrintJobs();
  const kept = jobs.filter((j) => j.status !== "failed");
  const removed = jobs.length - kept.length;
  if (removed > 0) {
    const removedIds = jobs.filter((j) => j.status === "failed").map((j) => j.id);
    savePrintJobs(kept);
    addClearedPrintJobIds(removedIds);
    void deletePrintJobsOnServer(removedIds);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: kept } }));
    }
  }
  return removed;
}
