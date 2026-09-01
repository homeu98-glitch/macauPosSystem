"use client";

import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  addClearedPrintJobIds,
  loadAuthSession,
  loadBootstrapCache,
  loadClearedPrintJobIds,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  savePrintJobs,
} from "@/lib/storage";
import { mergePrintJobs } from "@/lib/pos/print-job-merge";
import { resolveStoreTel } from "@/lib/pos/store-tel";
import { PosBootstrap, PosOrder, PrintJob, ReceiptTemplate } from "@/lib/types";
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
import { formatSpecLine, unitBasePrice } from "@/lib/escpos-render";
import { discountedUnitPrice } from "@/lib/pos/discount";

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
  const existing = loadPrintJobs();
  const cleared = loadClearedPrintJobIds();
  const merged = mergePrintJobs(existing, [...jobs, ...existing], cleared);
  savePrintJobs(merged);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { count: jobs.length } }));
}

// ── 收據：每台 receipt 打印機一張，附商家收據模板快照 + 靜態內容 ──
/**
 * 收據 / 自助點餐機小票共用嘅底層 builder，只差用邊一個模板槽位。
 *
 * ⚠️ `buildSnapshot()` 嘅 kind 一律係 `"receipt"`，即使傳入嘅係 kiosk 模板（docs/87 §2.3）。
 * 三個下游 repo（POS / desktop-companion / print-agent-android）嘅標題表只認
 * `receipt | label | kitchen`，傳 `"kiosk"` 會 fallthrough 到空標題。
 * 用 `"receipt"` 就做到「獨立可改嘅模板內容 + 完全一致嘅出紙格式」（規格 8）。
 */
function buildTemplateReceiptJobs(
  order: PosOrder,
  bootstrap: PosBootstrap,
  template: ReceiptTemplate,
): PrintJob[] {
  const receiptPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
    (printer) => printer.enabled && printer.role === "receipt",
  );
  if (receiptPrinters.length === 0) return [];

  const timestamp = new Date().toISOString();
  const serverName = loadAuthSession()?.name;
  const items: PrintItemLine[] = order.items.map((it) => {
    const base = unitBasePrice(it);
    const rate = it.discountRate;
    const hasDiscount = typeof rate === "number" && rate > 0 && rate < 100;
    const discounted = hasDiscount ? discountedUnitPrice(base, rate) : base;
    const saving = hasDiscount ? Math.round((base - discounted) * it.quantity * 100) / 100 : 0;
    return {
      name: it.name,
      quantity: it.quantity,
      // 主行價：冇折扣 → 基價 × quantity；有折扣 → 折後價 × quantity（renderer 加印原價）。
      price: it.price > 0 ? Math.round(discounted * it.quantity) : undefined,
      discountRate: hasDiscount ? rate : undefined,
      originalUnitPrice: hasDiscount ? Math.round(base) : undefined,
      discountedUnitPrice: hasDiscount ? Math.round(discounted) : undefined,
      savingAmount: saving > 0 ? saving : undefined,
      specs: (it.selectedSpecs ?? []).map((spec) => formatSpecLine(spec)),
      note: it.note,
    };
  });
  const content = buildReceiptContent(order, {
    storeName: bootstrap.storeName,
    // 收據電話：門店設定 → 商家登入號碼 fallback。見 src/lib/pos/store-tel.ts。
    storeTel: resolveStoreTel(bootstrap.storeTel),
    currency: bootstrap.currency,
    footerText: template.footerText,
    serverName,
  });
  const snapshot = buildSnapshot("receipt", template);

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
    template: snapshot,
    status: "pending",
    createdAt: timestamp,
  }));
}

/** 收銀台結帳收據：用 `printTemplates.receipt` 槽位。 */
export function buildReceiptPrintJobs(order: PosOrder, bootstrap: PosBootstrap): PrintJob[] {
  return buildTemplateReceiptJobs(order, bootstrap, loadPosLocalSettings().printTemplates.receipt);
}

/**
 * 自助點餐機 / 客人掃碼落單印畀客人嘅小票（docs/87 §2、規格 3+8）。
 *
 * 同收銀收據唯一差別：① 用 `printTemplates.kiosk` 呢個**獨立槽位**（商家可另行設計，
 * 唔會影響收銀台收據）；② **固定印 1 張**（規格 8：打印數量唔開放設定）。
 *
 * 打印機沿用 `role === "receipt"`：kiosk mode 係同一部機嘅裝置模式，
 * 「kiosk 隔籬嗰部打印機」就係呢部機自己 deviceConfig 入面嘅收據機，
 * 唔使新增 PrinterRole，亦唔使改 APK / Companion（規格 1、2）。
 */
export function buildKioskReceiptPrintJobs(order: PosOrder, bootstrap: PosBootstrap): PrintJob[] {
  const jobs = buildTemplateReceiptJobs(order, bootstrap, loadPosLocalSettings().printTemplates.kiosk);
  // 規格 8：job 層級寫死 1 份，優先於打印機層級嘅 `DevicePrinterConfig.copies`
  return jobs.map((job) => ({ ...job, copies: 1 }));
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

/**
 * 自助點餐機小票：本機排隊就得（**唔好推上雲**，docs/87 §3.1）。
 * 任何同步咗上 server 嘅 pending job，收銀端會 merge 落自己 localStorage 再印多一次。
 * 回傳實際加入隊列嘅張數（0 = 冇收據機 / 冇 bootstrap cache）。
 */
export function printKioskReceiptForOrder(order: PosOrder): number {
  const bootstrap = loadBootstrapCache();
  if (!bootstrap) return 0;
  const jobs = buildKioskReceiptPrintJobs(order, bootstrap);
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
