"use client";

import { resolvePrintJobStatus } from "@/lib/print-bridge/client";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  savePrintJobs,
} from "@/lib/storage";
import { PosBootstrap, PosOrder, PrintJob } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

export function appendPrintJobs(jobs: PrintJob[]) {
  if (jobs.length === 0 || typeof window === "undefined") return;
  savePrintJobs([...jobs, ...loadPrintJobs()]);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { count: jobs.length } }));
}

export function buildReceiptPrintJobs(
  order: PosOrder,
  bootstrap: PosBootstrap,
  networkOnline = true,
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
    table_name: receiptSettings.showTableName ? [{ name: "類型", quantity: 1, specs: [], note: order.tableName }] : [],
    items: order.items.map<ReceiptItem>((item) => ({
      name: item.name,
      quantity: item.quantity,
      specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
      note: item.note,
    })),
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
    status: resolvePrintJobStatus(networkOnline),
    createdAt: timestamp,
  }));
}

export function buildVoidPrintJobsForOrder(order: PosOrder, reason: string, networkOnline = true): PrintJob[] {
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
        status: resolvePrintJobStatus(networkOnline),
        createdAt: timestamp,
      }));
    voidPrintJobs.push(...jobs);
  }

  return voidPrintJobs;
}

export function findPosOrderForLedger(ledgerOrderId: string): PosOrder | null {
  const posOrderId = `ledger-${ledgerOrderId}`;
  return loadOrders().find((row) => row.id === posOrderId || row.onlineOrderId === ledgerOrderId) ?? null;
}

export function printReceiptForPosOrder(order: PosOrder, networkOnline = true): number {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return 0;
  const jobs = buildReceiptPrintJobs(order, bootstrap, networkOnline);
  appendPrintJobs(jobs);
  return jobs.length;
}

export function printVoidForLedgerOrder(ledgerOrderId: string, reason = "線上訂單已取消", networkOnline = true): number {
  const order = findPosOrderForLedger(ledgerOrderId);
  if (!order || order.items.length === 0) return 0;
  const jobs = buildVoidPrintJobsForOrder(order, reason, networkOnline);
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

  return printReceiptForPosOrder(order, options?.networkOnline ?? true);
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
