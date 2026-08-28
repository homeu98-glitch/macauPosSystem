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
import { getBridgedPosOrder } from "@/lib/ledger/ledger-pos-bridge";
import { formatMoney } from "@/lib/format";
import {
  buildKitchenContent,
  buildLabelContent,
  buildReceiptContent,
  buildSnapshot,
  ticketTypeLabel,
} from "@/lib/escpos-template";
import { PrintItemLine } from "@/lib/escpos-render";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function nowText() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function appendPrintJobs(jobs: PrintJob[]) {
  if (jobs.length === 0 || typeof window === "undefined") return;
  savePrintJobs([...jobs, ...loadPrintJobs()]);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { count: jobs.length } }));
}

// ── 收據：每台 receipt 打印機一張，附商家收據模板快照 + 靜態內容 ──
export function buildReceiptPrintJobs(order: PosOrder, bootstrap: PosBootstrap): PrintJob[] {
  const receiptTemplate = loadPosLocalSettings().printTemplates.receipt;
  const storeName = bootstrap.storeName;
  const currency = bootstrap.currency;
  const receiptPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "receipt",
  );
  if (receiptPrinters.length === 0) return [];

  const timestamp = new Date().toISOString();
  const items: PrintItemLine[] = order.items.map((it) => ({
    name: it.name,
    quantity: it.quantity,
    specs: (it.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
    note: it.note,
  }));
  const content = buildReceiptContent(order, { storeName, currency, footerText: receiptTemplate.footerText });
  const template = buildSnapshot("receipt", receiptTemplate);

  return receiptPrinters.map<PrintJob>((printer) => ({
    id: uid("print"),
    orderId: order.id,
    orderNo: order.localOrderNo,
    tableName: order.tableName,
    ticketType: "normal",
    printerGroup: "receipt",
    printerId: printer.id,
    printerName: printer.name,
    items,
    content,
    template,
    status: "pending",
    createdAt: timestamp,
  }));
}

export interface KitchenPrintOpts {
  ticketType: "normal" | "addon" | "void";
  storeName: string;
  time?: string;
  itemNamePrefix?: string;
  itemNoteOverride?: string;
  itemsOverride?: PosOrder["items"];
  orderNoSuffix?: string;
}

// ── 廚房 / 分區單：每台 zone 打印機一張（只印該分區嘅菜品），附廚房模板快照 ──
export function buildKitchenPrintJobs(order: PosOrder, opts: KitchenPrintOpts): PrintJob[] {
  const kitchenTemplate = loadPosLocalSettings().printTemplates.kitchen;
  const zonePrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "zone",
  );
  if (zonePrinters.length === 0) return [];
  const timestamp = new Date().toISOString();
  const typeLabel = ticketTypeLabel(opts.ticketType);
  const time = opts.time ?? nowText();
  const template = buildSnapshot("kitchen", kitchenTemplate);
  const sourceItems = opts.itemsOverride ?? order.items;

  const jobs: PrintJob[] = [];
  for (const printer of zonePrinters) {
    const matched = sourceItems.filter((it) => !printer.zoneId || it.printerGroup === printer.zoneId);
    if (matched.length === 0) continue;
    const items: PrintItemLine[] = matched.map((it) => ({
      name: opts.itemNamePrefix ? `${opts.itemNamePrefix}${it.name}` : it.name,
      quantity: it.quantity,
      specs: (it.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
      note: opts.itemNoteOverride ?? it.note,
    }));
    const content = buildKitchenContent(order, {
      storeName: opts.storeName,
      footerText: kitchenTemplate.footerText,
      typeLabel,
      time,
    });
    const orderNo = `${order.localOrderNo}${opts.orderNoSuffix ?? ""}`;
    content.order_no = orderNo;
    jobs.push({
      id: uid("print"),
      orderId: order.id,
      orderNo,
      tableName: order.tableName,
      ticketType: opts.ticketType,
      printerGroup: printer.zoneId ?? "",
      printerId: printer.id,
      printerName: printer.name,
      items,
      content,
      template,
      status: "pending",
      createdAt: timestamp,
    });
  }
  return jobs;
}

export interface LabelPrintOpts {
  ticketType: "normal" | "addon" | "void";
  storeName: string;
  itemNamePrefix?: string;
  itemsOverride?: PosOrder["items"];
  orderNoSuffix?: string;
}

// ── 標籤：每台 label 打印機，每項菜品一張（飲品標籤），附標籤模板快照 ──
// （舊版冇 label builder，label 機一直收到同 zone 一樣嘅廚房式 job；呢度補返正確 label 單）
export function buildLabelPrintJobs(order: PosOrder, opts: LabelPrintOpts): PrintJob[] {
  const labelTemplate = loadPosLocalSettings().printTemplates.label;
  const labelPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "label",
  );
  if (labelPrinters.length === 0) return [];
  const timestamp = new Date().toISOString();
  const template = buildSnapshot("label", labelTemplate);
  const sourceItems = opts.itemsOverride ?? order.items;
  const orderNo = `${order.localOrderNo}${opts.orderNoSuffix ?? ""}`;

  const jobs: PrintJob[] = [];
  for (const printer of labelPrinters) {
    const matched = sourceItems.filter((it) => !printer.zoneId || it.printerGroup === printer.zoneId);
    for (const item of matched) {
      const content = buildLabelContent(order, item, {
        storeName: opts.storeName,
        headerText: labelTemplate.headerText,
        footerText: labelTemplate.footerText,
      });
      content.order_no = orderNo;
      jobs.push({
        id: uid("print"),
        orderId: order.id,
        orderNo,
        tableName: order.tableName,
        ticketType: opts.ticketType,
        printerGroup: printer.zoneId ?? item.printerGroup,
        printerId: printer.id,
        printerName: printer.name,
        items: [],
        content,
        template,
        status: "pending",
        createdAt: timestamp,
      });
    }
  }
  return jobs;
}

// ── 退菜：廚房單（退）+ 標籤單（退），分區/標籤各自套對應模板 ──
export function buildVoidPrintJobsForOrder(
  order: PosOrder,
  reason: string,
  opts?: { itemsOverride?: PosOrder["items"]; orderNoSuffix?: string },
): PrintJob[] {
  const storeName = loadBootstrapCache()?.storeName ?? "門店";
  const kitchenJobs = buildKitchenPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "（退）",
    itemNoteOverride: reason || "線上訂單已取消",
    itemsOverride: opts?.itemsOverride,
    orderNoSuffix: opts?.orderNoSuffix,
  });
  const labelJobs = buildLabelPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "（退）",
    itemsOverride: opts?.itemsOverride,
    orderNoSuffix: opts?.orderNoSuffix,
  });
  return [...kitchenJobs, ...labelJobs];
}

/**
 * 返結（反結賬）列印：把已結單退回可編輯狀態時，印一張「返結單」到所有啟用中
 * 分區 / 標籤打印機，記錄原單號、原因、操作人。ticketType 沿用 "void"（修正單）。
 */
export function buildReopenPrintJobs(order: PosOrder, reason: string, operator: string): PrintJob[] {
  const storeName = loadBootstrapCache()?.storeName ?? "門店";
  const voidReason = `原因：${reason || "結帳錯誤"}｜操作人：${operator}`;
  const kitchenJobs = buildKitchenPrintJobs(order, {
    ticketType: "void",
    storeName,
    itemNamePrefix: "【返結】",
    itemNoteOverride: voidReason,
  });
  const labelJobs = buildLabelPrintJobs(order, { ticketType: "void", storeName, itemNamePrefix: "【返結】" });
  return [...kitchenJobs, ...labelJobs];
}

export function findPosOrderForLedger(ledgerOrderId: string): PosOrder | null {
  // 線上單唔 mirror 入 POS DB（契約 M3/M8），先查 in-memory bridge registry；
  // 舊 persisted 線上單（legacy）仍會喺 loadOrders() 搵到。
  const bridged = getBridgedPosOrder(ledgerOrderId);
  if (bridged) return bridged;
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
