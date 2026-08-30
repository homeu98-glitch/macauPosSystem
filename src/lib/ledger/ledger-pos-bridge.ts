"use client";

import { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { toLedgerMenuItemId } from "@/lib/ledger/menu-import";
import { getOrderDetail, LedgerOrderDetail, LedgerOrderDetailItem } from "@/lib/ledger/orders";
import { resolvePrintJobStatus } from "@/lib/print-bridge/companion";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadClearedPrintJobIds,
  loadDeviceConfig,
  loadPrintJobs,
  savePrintJobs,
} from "@/lib/storage";
import { mergePrintJobs } from "@/lib/pos/print-job-merge";

/**
 * 契約 M3 / M8：線上單**唔** mirror 入 POS DB（loadOrders / saveOrders）。
 * 呢度只留一份 in-memory 表示，俾「收銀見單」同 void/receipt 打印查詢用
 * （見 print-jobs.ts 嘅 findPosOrderForLedger）。真正線上單權威係 Ledger DB，
 * 顯示靠 use-ledger-orders-realtime（Realtime + list_merchant_orders）嘅 in-memory feed。
 * 注意：換頁 / 重載後呢份 map 會清空；如需喺 reload 後補印， caller 應帶齊 Ledger order 資料。
 */
const bridgedOrders = new Map<string, PosOrder>();

export function getBridgedPosOrder(ledgerOrderId: string): PosOrder | null {
  return bridgedOrders.get(ledgerOrderId) ?? null;
}
import {
  DevicePrinterConfig,
  MenuItem,
  OrderItem,
  PosBootstrap,
  PosOrder,
  PrintJob,
} from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveTableMeta(order: LedgerOnlineOrder, tableId?: string, tableName?: string) {
  if (order.tabType === "dine_in" && tableId && tableName) {
    return { tableId, tableName };
  }
  if (order.tabType === "pickup") {
    return { tableId: "counter", tableName: "自取" };
  }
  if (order.tabType === "self_delivery") {
    return { tableId: "counter", tableName: "外賣" };
  }
  return { tableId: "counter", tableName: "堂食" };
}

/**
 * 菜名正規化：去掉所有空白 + 轉小寫。只用作 fallback 配對，唔影響單據顯示名。
 * 令「凍檸茶 」/「凍 檸 茶」/「凍檸茶」都對返同一項本地餐牌。
 */
function normalizeMenuName(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

type MenuLookup = {
  byId: Map<string, MenuItem>;
  byName: Map<string, MenuItem>;
  byNormalizedName: Map<string, MenuItem>;
};

function buildMenuLookup(items: MenuItem[]): MenuLookup {
  const byId = new Map<string, MenuItem>();
  const byName = new Map<string, MenuItem>();
  const byNormalizedName = new Map<string, MenuItem>();
  for (const row of items) {
    if (!byId.has(row.id)) byId.set(row.id, row);
    if (!byName.has(row.name)) byName.set(row.name, row);
    const key = normalizeMenuName(row.name);
    if (key && !byNormalizedName.has(key)) byNormalizedName.set(key, row);
  }
  return { byId, byName, byNormalizedName };
}

/**
 * Ledger 明細 item → 本地餐牌項。命中與否直接決定 `printerGroup`，即張廚房單打去邊部機。
 *
 * 配對順序（愈前愈可信）：
 *   1) `ledger-<menuItemId>`：匯入線上餐牌後本地 id 帶前綴（見 menu-import.ts），
 *      而 Ledger 明細帶嘅係**冇前綴**嘅原始 product id。舊寫法 `row.id === item.menuItemId`
 *      永遠對唔上，等於只剩「靠菜名撞」，呢度補返呢條最可靠嘅路。
 *   2) 本地 id 直接相等（本地自建菜品 / 舊格式）
 *   3) 菜名完全相同
 *   4) 菜名正規化後相同（去空白 / 不分大小寫）
 *
 * 搵唔到就返回 undefined，caller 退回預設分區並 warn 提示重新匯入餐牌。
 */
function resolveMenuItem(
  item: LedgerOrderDetailItem,
  bootstrap: PosBootstrap | null,
  lookup: MenuLookup,
): MenuItem | undefined {
  if (!bootstrap) return undefined;
  if (item.menuItemId) {
    const rawId = String(item.menuItemId);
    const byLedgerId = lookup.byId.get(toLedgerMenuItemId(rawId));
    if (byLedgerId) return byLedgerId;
    const byRawId = lookup.byId.get(rawId);
    if (byRawId) return byRawId;
  }
  const byName = lookup.byName.get(item.name);
  if (byName) return byName;
  const key = normalizeMenuName(item.name);
  return key ? lookup.byNormalizedName.get(key) : undefined;
}

function mapDetailToOrderItems(
  detail: LedgerOrderDetail,
  bootstrap: PosBootstrap | null,
): OrderItem[] {
  const lookup = buildMenuLookup(bootstrap?.menuItems ?? []);
  const unmatched: string[] = [];

  const items = detail.items.map((item) => {
    const menu = resolveMenuItem(item, bootstrap, lookup);
    if (!menu) unmatched.push(item.name);
    return {
      menuItemId: menu?.id ?? item.menuItemId ?? `ext-${item.name}`,
      name: item.name,
      quantity: item.qty,
      price: item.unitPrice ?? menu?.price ?? 0,
      printerGroup: menu?.printerGroup ?? "kitchen",
      note: item.note,
    };
  });

  if (unmatched.length > 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[ledger→pos] ${unmatched.length} 項對唔到本地餐牌，分區退回 "kitchen"：` +
        `${unmatched.join("、")}。請喺餐牌設定重新匯入線上餐牌（對返菜名／分區）。`,
    );
  }

  return items;
}

/**
 * 打印機 ↔ 菜品分區匹配——**與堂食 print-jobs.ts:buildKitchenPrintJobs 保持一致**：
 * 冇填 zoneId 嘅機係「catch-all」，接晒所有菜品；填咗 zoneId 就只接自己分區。
 *
 * 舊寫法係嚴格 `item.printerGroup === (printer.zoneId ?? "")`，令「只設一台冇填分區嘅廚房機」
 * 嘅店接單後**靜默唔出單**（堂食單有 catch-all 照印，線上單卻唔印）。
 */
function printerTakesItem(printer: DevicePrinterConfig, item: OrderItem): boolean {
  return !printer.zoneId || item.printerGroup === printer.zoneId;
}

function toPrintItemLine(item: OrderItem) {
  return {
    name: item.name,
    quantity: item.quantity,
    specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
    note: item.note,
  };
}

function buildPrintJobsForItems(options: {
  orderId: string;
  orderNo: string;
  tableName: string;
  items: OrderItem[];
}): PrintJob[] {
  const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
  const timestamp = new Date().toISOString();

  const kitchenTargets = configuredPrinters.filter(
    (printer) => printer.role === "zone" || printer.role === "label",
  );
  if (kitchenTargets.length === 0) {
    if (options.items.length > 0 && process.env.NODE_ENV !== "production") {
      console.warn(
        `[ledger→pos] 訂單 ${options.orderNo} 接單成功，但未配任何已啟用嘅廚房/標籤打印機（zone/label role）→ 零 PrintJob 產生，廚房單靜默丟失。請去「設置 → 打印機綁定」添加廚房打印機。`,
      );
    }
    return [];
  }
  if (options.items.length === 0) return [];

  const makeJob = (printer: DevicePrinterConfig, items: OrderItem[]): PrintJob => ({
    id: uid("print"),
    orderId: options.orderId,
    orderNo: options.orderNo,
    tableName: options.tableName,
    ticketType: "normal",
    printerGroup: printer.zoneId ?? "",
    printerId: printer.id,
    printerName: printer.name,
    items: items.map(toPrintItemLine),
    status: resolvePrintJobStatus(true),
    createdAt: timestamp,
  });

  const jobs: PrintJob[] = [];
  const covered = new Set<number>();

  for (const printer of kitchenTargets) {
    const matched: OrderItem[] = [];
    options.items.forEach((item, index) => {
      if (!printerTakesItem(printer, item)) return;
      covered.add(index);
      matched.push(item);
    });
    if (matched.length === 0) continue;
    jobs.push(makeJob(printer, matched));
  }

  // 兜底（無死角）：所有機都填咗 zoneId、而某啲菜嘅分區對唔中任何機（例如未匯入餐牌
  // 退回 "kitchen" 但店內無 kitchen 分區）→ 舊寫法會靜默丟單。呢度兜底打落第一台廚房機，
  // 寧願打錯部門都好過漏單，並 warn 提示檢查打印機分區。
  const orphans = options.items.filter((_, index) => !covered.has(index));
  if (orphans.length > 0) {
    const fallbackPrinter = kitchenTargets[0];
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[ledger→pos] ${orphans.length} 項分區對唔中任何打印機，兜底打落「${fallbackPrinter.name}」：` +
          `${orphans.map((item) => item.name).join("、")}。請檢查設備設定嘅打印機分區。`,
      );
    }
    const lines = orphans.map(toPrintItemLine);
    if (jobs.length > 0) {
      jobs[0] = { ...jobs[0], items: [...(jobs[0].items ?? []), ...lines] };
    } else {
      jobs.push(makeJob(fallbackPrinter, orphans));
    }
  }

  return jobs;
}

function buildPrintJobs(order: PosOrder): PrintJob[] {
  return buildPrintJobsForItems({
    orderId: order.id,
    orderNo: order.localOrderNo,
    tableName: order.tableName,
    items: order.items,
  });
}

function resolveQuickPickupTableName(order: LedgerOnlineOrder): string {
  if (order.tabType === "pickup") return "自取";
  if (order.tabType === "self_delivery") return "外賣";
  return "堂食取餐";
}

function resolveLocalOrderNo(order: LedgerOnlineOrder): string {
  return (
    order.pickupCode ??
    (order.tabType === "pickup"
      ? `自取-${order.id.slice(0, 6)}`
      : order.tabType === "self_delivery"
        ? `外送-${order.id.slice(0, 6)}`
        : `線上-${order.id.slice(0, 6)}`)
  );
}

/** 接單後只送廚房打印，不建立本地 PosOrder。 */
export async function printKitchenForLedgerOrder(
  ledgerOrder: LedgerOnlineOrder,
  detail?: LedgerOrderDetail,
): Promise<PrintJob[]> {
  const bootstrap = loadBootstrapCache();
  const resolvedDetail = detail ?? (await getOrderDetail(ledgerOrder.id));
  const items = mapDetailToOrderItems(resolvedDetail, bootstrap);
  const printJobs = buildPrintJobsForItems({
    orderId: `ledger-${ledgerOrder.id}`,
    orderNo: resolveLocalOrderNo(ledgerOrder),
    tableName: resolveQuickPickupTableName(ledgerOrder),
    items,
  });

  if (printJobs.length > 0) {
    const existing = loadPrintJobs();
    const cleared = loadClearedPrintJobIds();
    const merged = mergePrintJobs(existing, [...printJobs, ...existing], cleared);
    savePrintJobs(merged);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
    }
  }

  return printJobs;
}

export type BridgeLedgerOrderOptions = {
  ledgerOrder: LedgerOnlineOrder;
  tableId?: string;
  tableName?: string;
  detail?: LedgerOrderDetail;
};

export async function bridgeLedgerOrderToPos(options: BridgeLedgerOrderOptions): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
}> {
  const bootstrap = loadBootstrapCache();
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  const { tableId, tableName } = resolveTableMeta(options.ledgerOrder, options.tableId, options.tableName);
  const items = mapDetailToOrderItems(detail, bootstrap);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxRate = bootstrap?.rules.taxRate ?? 0;
  const serviceRate = bootstrap?.rules.serviceChargeRate ?? 0;
  const taxAmount = subtotal * taxRate;
  const serviceChargeAmount = subtotal * serviceRate;
  const timestamp = new Date().toISOString();
  const localOrderNo =
    options.ledgerOrder.pickupCode ??
    (options.ledgerOrder.tabType === "pickup"
      ? `自取-${options.ledgerOrder.id.slice(0, 6)}`
      : options.ledgerOrder.tabType === "self_delivery"
        ? `外送-${options.ledgerOrder.id.slice(0, 6)}`
        : `線上-${options.ledgerOrder.id.slice(0, 6)}`);

  const posOrder: PosOrder = {
    id: `ledger-${options.ledgerOrder.id}`,
    localOrderNo,
    tableId,
    tableName,
    status: "sent_to_kitchen",
    fulfillmentStatus: "preparing",
    items,
    orderNote: options.ledgerOrder.note,
    subtotal,
    taxAmount,
    serviceChargeAmount,
    discountAmount: 0,
    total: detail.total ?? options.ledgerOrder.total,
    prepaidAmount: options.ledgerOrder.paymentStatus === "paid" ? options.ledgerOrder.total : 0,
    onlineOrderId: options.ledgerOrder.id,
    paymentMethod: options.ledgerOrder.paymentMode,
    createdAt: options.ledgerOrder.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  const printJobs = buildPrintJobs(posOrder);

  // 契約 M3 / M8：線上單唔 mirror 入 POS DB。只留 in-memory 表示（見檔頭 bridgedOrders），
  // 唔 call saveOrders，唔 dispatch pos-orders-changed（POS 本機單唔含線上單）。
  bridgedOrders.set(options.ledgerOrder.id, posOrder);

  if (printJobs.length > 0) {
    // 用 mergePrintJobs 統一合併邏輯（同 pos-app.persistPrintJobs 一致），
    // 避免 spread 合併唔做去重 / tombstone 過濾。
    const existing = loadPrintJobs();
    const cleared = loadClearedPrintJobIds();
    const merged = mergePrintJobs(existing, [...printJobs, ...existing], cleared);
    savePrintJobs(merged);
    // 同 printKitchenForLedgerOrder 一致：dispatch event 令 PrintFlushWorker 即時 flush，
    // 以及 Print Center UI 即時刷新（唔靠 2.5s poll 兜底）。
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
    }
  }

  return { posOrder, printJobs };
}
