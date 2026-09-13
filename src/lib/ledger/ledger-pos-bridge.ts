"use client";

import { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { toLedgerMenuItemId } from "@/lib/ledger/menu-import";
import { getOrderDetail, LedgerOrderDetail, LedgerOrderDetailItem } from "@/lib/ledger/orders";
import { enrichSpecsFromMenu, toResolvedSpecs } from "@/lib/ledger/order-item-specs";
import { resolvePrintJobStatus } from "@/lib/print-bridge/companion";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  cacheLedgerPosOrder,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadQueue,
  saveOrders,
  saveQueue,
} from "@/lib/storage";
// ⚠️ 唔可以 import `@/lib/print-jobs`（佢反過來 import 咗呢個檔 → 循環依賴）。
// 出紙入隊邏輯走獨立嘅 `@/lib/pos/print-job-enqueue`。
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import {
  syncOnlineDineInCompletion,
  type OnlineDineInProgress,
} from "@/lib/pos/online-dinein-fulfillment";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import { isPrintContentEnabled } from "@/lib/print-toggles";
import {
  buildKitchenContent,
  buildSnapshot,
  paperColumnsFromSize,
  ticketTypeLabel,
} from "@/lib/escpos-template";

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
  QueueEvent,
} from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 廚房單上嘅時間文字（同 `print-jobs.ts:nowText()` 一致格式）。 */
function kitchenTimeText() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    // 單品折扣：優先用 discountRate（百分比）；冇就用 discountAvos（金額）除返原價算 rate。
    let discountRate: number | undefined = item.discountRate;
    if (discountRate == null && item.discountAvos != null && item.discountAvos > 0) {
      const unitOriginal = item.unitPrice ?? menu?.price ?? 0;
      if (unitOriginal > 0) {
        const savingPerUnit = item.discountAvos / 100 / item.qty;
        discountRate = Math.round(((1 - savingPerUnit / unitOriginal) * 100) * 100) / 100;
      }
    }
    /**
     * 🔴 已選規格（2026-09-13 修）。
     *
     * 舊寫法呢度**冇 `selectedSpecs`** → 所有由 Ledger 投影出嚟嘅單（廚房單／
     * 飲品標籤單／收據／`/orders` 查看）一條規格都冇，而 Ledger 自己印嘅單有。
     * 下游（`toPrintItemLine` / `print-jobs.ts` / `buildLabelContent` /
     * `escpos-render.ts`）**一早已經支援**規格 → 缺口只喺呢一格。
     *
     * `item.specs` 由 `getOrderDetail()` 用防禦式解析抽出；再用**本地同步餐牌**
     * 補齊文字（商家口徑：菜單同 Ledger in sync，所以 group/option 定義我們有齊）。
     */
    const selectedSpecs = toResolvedSpecs(enrichSpecsFromMenu(item.specs ?? [], menu?.specGroups));
    return {
      menuItemId: menu?.id ?? item.menuItemId ?? `ext-${item.name}`,
      name: item.name,
      quantity: item.qty,
      price: item.unitPrice ?? menu?.price ?? 0,
      printerGroup: menu?.printerGroup ?? "kitchen",
      note: item.note,
      ...(selectedSpecs.length > 0 ? { selectedSpecs } : {}),
      ...(discountRate != null && discountRate > 0 && discountRate < 100 ? { discountRate } : {}),
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
  /**
   * 用嚟產生 **模板快照 + content** 嘅來源單（＝同一張單嘅 `PosOrder` 投影）。
   *
   * 🔴 唔可以唔傳：本地落單嘅廚房 job（`print-jobs.ts:buildKitchenPrintJobs`）一定帶
   * `content` + `template`（doc/60「設計 == 預覽 == 出紙」），而線上單舊寫法兩者都冇
   * → `dispatch.ts` 要 warn「冇 template 快照，將用通道 fallback 渲染」，
   * 中繼 APK 要靠 fallback 硬編渲染（字型 / 58·80mm 欄寬唔跟商家設定）。
   * 2026-09-12 實案：唯一印唔出嘅 job 正好就係唯一冇快照嗰張。
   */
  sourceOrder?: PosOrder;
}): PrintJob[] {
  // 「線上訂單」總開關（2026-09-11 新增）：呢個 builder **只**服務 Ledger 線上單
  // （`bridgeLedgerOrderToPos` / `printKitchenForLedgerOrder`）。
  //
  // Sunmi 系統本身會印線上訂單，部分店鋪唔想廚房重複出紙 → 熄咗呢個掣就完全唔出
  // 廚房單／標籤單。同「廚房 + 標籤兩個都熄」一樣：**靜默 `return []`**（店主自己
  // 決定唔印，係預期行為，唔可以當錯誤彈 toast 嚇佢）。
  if (!isPrintContentEnabled("online")) return [];

  // 細粒度開關（2026-09-08）：商家可獨立關閉「廚房單」或「飲品標籤單」。
  // 兩個都熄咗 → 直接返空（唔 throw，呢個係預期行為，唔可以當錯誤彈 toast）。
  const kitchenOn = isPrintContentEnabled("kitchen");
  const labelOn = isPrintContentEnabled("label");
  if (!kitchenOn && !labelOn) return [];

  const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
  const timestamp = new Date().toISOString();

  // 根據 toggles 過濾：kitchen off → 跳過 zone role；label off → 跳過 label role。
  // 兩者都係同一條「新單出單」路徑產出，所以共用一份 printer list，按 role 過濾。
  const kitchenTargets = configuredPrinters.filter((printer) => {
    if (printer.role === "zone") return kitchenOn;
    if (printer.role === "label") return labelOn;
    return false;
  });
  if (kitchenTargets.length === 0) {
    if (options.items.length > 0) {
      // 唔再靜默：生產環境也要讓上層 catch 到、顯示 toast。
      // 舊寫法只 dev console.warn → 用戶零打印、零記錄、零提示，完全唔知點解。
      throw new Error(
        `未配任何已啟用嘅廚房/標籤打印機（zone/label role），無法產生廚房單。請去「設置 → 打印機綁定」添加廚房打印機。`,
      );
    }
    return [];
  }
  if (options.items.length === 0) return [];

  const makeJob = (printer: DevicePrinterConfig, items: OrderItem[]): PrintJob => {
    const source = options.sourceOrder;
    // 模板快照 + content 只在有來源單時產生（同 `print-jobs.ts:buildKitchenPrintJobs` 對齊）。
    // 冇來源單（理論上唔會發生）→ 保持舊行為（交畀通道 fallback），唔會 throw。
    let content: Record<string, string> | undefined;
    let template: PrintJob["template"];
    if (source) {
      const kitchenTemplate = loadPosLocalSettings().printTemplates.kitchen;
      const storeName = loadBootstrapCache()?.storeName ?? "門店";
      content = buildKitchenContent(source, {
        storeName,
        footerText: kitchenTemplate.footerText,
        typeLabel: ticketTypeLabel("normal"),
        time: kitchenTimeText(),
        // ⚠️ 全單備註一定要帶（唔傳 → 廚房單永久冇全單備註，見 print-jobs.ts 同源註釋）。
        orderNote: source.orderNote,
      });
      // 逐機計欄寬（58mm 機 32 字 / 80mm 機 48 字），三個出紙 repo 直接讀快照。
      template = buildSnapshot("kitchen", kitchenTemplate, paperColumnsFromSize(printer.paperSize));
    }
    content = content ? { ...content, order_no: options.orderNo } : undefined;
    return {
      id: uid("print"),
      orderId: options.orderId,
      orderNo: options.orderNo,
      tableName: options.tableName,
      ticketType: "normal",
      printerGroup: printer.zoneId ?? "",
      printerId: printer.id,
      printerName: printer.name,
      items: items.map(toPrintItemLine),
      ...(content ? { content } : {}),
      ...(template ? { template } : {}),
      status: resolvePrintJobStatus(true),
      createdAt: timestamp,
    };
  };

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
    sourceOrder: order,
  });
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

/**
 * 註冊／更新一張線上單嘅本地投影 —— **兩個地方都要寫**：
 *   1) in-memory `bridgedOrders`（今次 session 內最快，接單／補打／重打都用佢）；
 *   2) store-scope 投影快取（`cacheLedgerPosOrder`）—— **reload 之後仍然搵得返**。
 *
 * 🔴 2026-09-12 修：舊寫法只有 (1)，而且**只有** `bridgeLedgerOrderToPos` /
 * `resolveLedgerPosOrderForReceipt` 會寫；快餐面板／自動接單走嘅
 * `printKitchenForLedgerOrder()` **完全冇寫** → 嗰批線上單嘅 print job
 * 由建立一刻起就冇得「重打整單」（`findPosOrderForLedger()` 兩層都搵唔到，
 * 而線上單又唔 mirror 入 POS DB）→ 用戶撳「重打整單」必彈
 * 「線上訂單資料已不在本機快取」。所以統一收喺呢個函式，所有建立投影嘅路徑都要叫。
 */
function registerLedgerProjection(order: PosOrder): void {
  if (!order.onlineOrderId) return;
  bridgedOrders.set(order.onlineOrderId, order);
  cacheLedgerPosOrder(order);
}

/** 線上單 → 落 sync queue（`ORDER_CREATED` / `ORDER_UPDATED`）＋ 即時 flush。 */
function enqueueOrderEvent(order: PosOrder, isUpdate: boolean, action?: string): void {
  if (typeof window === "undefined") return;
  const event: QueueEvent = {
    id: uid("evt"),
    type: isUpdate ? "ORDER_UPDATED" : "ORDER_CREATED",
    entityId: order.id,
    payload: isUpdate ? { order, action: action ?? "table_assigned" } : { order },
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  saveQueue(enqueueEvents(loadQueue(), withStoreScope([event])));
  notifyQueueChanged();
}

/** 反查呢張線上單**本機已知**嘅枱（排位用；冇就 null）。 */
function resolveAssignedTable(ledgerOrderId: string): { tableId: string; tableName: string } | null {
  const row =
    bridgedOrders.get(ledgerOrderId) ??
    loadOrders().find((order) => order.id === `ledger-${ledgerOrderId}`);
  if (row && row.tableId && row.tableId !== "counter") {
    return { tableId: row.tableId, tableName: row.tableName };
  }
  return null;
}

/** 接單後只送廚房打印（**唔**建立本地 PosOrder；要入枱請用 `assignLedgerOrderToTable()`）。 */
export async function printKitchenForLedgerOrder(
  ledgerOrder: LedgerOnlineOrder,
  detail?: LedgerOrderDetail,
): Promise<PrintJob[]> {
  const resolvedDetail = detail ?? (await getOrderDetail(ledgerOrder.id));
  // 已排位嘅單再出單（例如改枱後補印）要沿用枱名，唔可以打返「堂食取餐」。
  const assigned = resolveAssignedTable(ledgerOrder.id);
  const projection = buildLedgerPosOrder(
    ledgerOrder,
    resolvedDetail,
    assigned?.tableId,
    assigned?.tableName,
  );
  const printJobs = buildPrintJobsForItems({
    orderId: projection.id,
    orderNo: projection.localOrderNo,
    tableName: projection.tableName,
    items: projection.items,
    sourceOrder: projection,
  });

  // 🔴 一定要註冊投影（見 `registerLedgerProjection` 註釋）：唔做嘅話打印中心
  // 「重打整單」永遠搵唔到來源單。
  registerLedgerProjection(projection);

  // ⚠️ 必須用 `appendPrintJobsWithSync`：落本機 **＋** 推 `PRINT_JOB_CREATED` 上雲。
  //
  // 舊寫法只 `savePrintJobs()` + dispatch DOM event，令張 job 永遠只留喺本機
  // localStorage：本地 flush 行 relay 分支時 `RelayTransport.send()` 係 no-op、
  // 樂觀回 ok → 本機標「已發送」，但雲端 `pos_print_jobs` 根本冇呢行 → 中繼 APK
  // claim 唔到 → **一張紙都唔出，而且冇任何紅色失敗提示**。
  // （2026-09-11「線上訂單接單後冇出廚房單」的根因；同 2026-09-09 補打帳單印唔出同源。）
  appendPrintJobsWithSync(printJobs);

  return printJobs;
}

export type BridgeLedgerOrderOptions = {
  ledgerOrder: LedgerOnlineOrder;
  tableId?: string;
  tableName?: string;
  detail?: LedgerOrderDetail;
};

/**
 * Ledger 線上單 → 本地 `PosOrder`（純資料轉換）。
 *
 * 唔產生任何打印任務、唔寫 localStorage／POS DB，只係俾「廚房單」「收據」
 * 同「排位」寫入 orders 呢幾條路徑用嘅共通輸入。
 */
function buildLedgerPosOrder(
  ledgerOrder: LedgerOnlineOrder,
  detail: LedgerOrderDetail,
  tableId?: string,
  tableName?: string,
): PosOrder {
  const bootstrap = loadBootstrapCache();
  const { tableId: resolvedTableId, tableName: resolvedTableName } = resolveTableMeta(
    ledgerOrder,
    tableId,
    tableName,
  );
  const items = mapDetailToOrderItems(detail, bootstrap);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxRate = bootstrap?.rules.taxRate ?? 0;
  const serviceRate = bootstrap?.rules.serviceChargeRate ?? 0;
  const taxAmount = subtotal * taxRate;
  const serviceChargeAmount = subtotal * serviceRate;
  const timestamp = new Date().toISOString();
  const localOrderNo = resolveLocalOrderNo(ledgerOrder);

  return {
    id: `ledger-${ledgerOrder.id}`,
    localOrderNo,
    tableId: resolvedTableId,
    tableName: resolvedTableName,
    status: "sent_to_kitchen",
    fulfillmentStatus: "preparing",
    items,
    orderNote: ledgerOrder.note,
    subtotal,
    taxAmount,
    serviceChargeAmount,
    // 訂單層全單折扣（defensive 從 Ledger 攞）：優先 detail.discountAvos，
    // 退而求其次用 ledgerOrder.discountAmount（list view 已經 map 好）。
    discountAmount:
      (detail.discountAvos != null ? detail.discountAvos / 100 : 0) || ledgerOrder.discountAmount || 0,
    total: detail.total ?? ledgerOrder.total,
    prepaidAmount: ledgerOrder.paymentStatus === "paid" ? ledgerOrder.total : 0,
    onlineOrderId: ledgerOrder.id,
    paymentMethod: ledgerOrder.paymentMode,
    createdAt: ledgerOrder.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 攞（必要時建立）一張線上單嘅本地 `PosOrder` 表示 —— 只為**收據**用途。
 *
 * 優先返 `bridgedOrders` 入面嗰份（自動補印／接單時已經建立，內容同原單一致）；
 * 冇（例如從未喺本機接過單、或 reload 後 in-memory map 已清）就即時由 Ledger
 * `get_order_detail` 重建一份並註冊（map + 持久快取），等下一次補打唔使再打 API。
 *
 * 對應線下 `reprintReceiptForOrder` 嘅「由 storage 重讀權威版訂單」一步 ——
 * 線上單嘅權威係 Ledger，本地只係打印用嘅投影。
 */
export async function resolveLedgerPosOrderForReceipt(
  ledgerOrder: LedgerOnlineOrder,
  detail?: LedgerOrderDetail,
): Promise<PosOrder> {
  const bridged = getBridgedPosOrder(ledgerOrder.id);
  if (bridged) return bridged;
  const resolvedDetail = detail ?? (await getOrderDetail(ledgerOrder.id));
  const assigned = resolveAssignedTable(ledgerOrder.id);
  const built = buildLedgerPosOrder(ledgerOrder, resolvedDetail, assigned?.tableId, assigned?.tableName);
  registerLedgerProjection(built);
  return built;
}

export async function bridgeLedgerOrderToPos(options: BridgeLedgerOrderOptions): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
}> {
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  const posOrder = buildLedgerPosOrder(
    options.ledgerOrder,
    detail,
    options.tableId,
    options.tableName,
  );

  const printJobs = buildPrintJobs(posOrder);

  // 契約 M3 / M8：接單本身唔 mirror 入 POS DB（見檔頭 bridgedOrders），
  // 所以要入枱／落本地單，只可以行 `assignLedgerOrderToTable()`（商家人手排位）。
  registerLedgerProjection(posOrder);

  // 同 `printKitchenForLedgerOrder` 一致：**一定要上雲**，否則中繼 APK 永遠 claim 唔到
  // （見該函式嘅同源註釋）。`appendPrintJobsWithSync` 內部已處理去重 / tombstone 過濾 /
  // 保留本機 sent·failed 派發狀態，並即時 dispatch `pos-print-jobs-changed` 令
  // Print Center UI 刷新（唔靠 2.5s poll 兜底）。
  appendPrintJobsWithSync(printJobs);

  return { posOrder, printJobs };
}

export type AssignLedgerOrderTableOptions = {
  ledgerOrder: LedgerOnlineOrder;
  tableId: string;
  tableName: string;
  detail?: LedgerOrderDetail;
};

/**
 * **「排位」**：將一張線上堂食單 assign 到桌台（2026-09-12 商家需求）。
 *
 * ## 為咩要寫入 `orders`（本地 + 雲端 `pos_orders.online_order_id`）
 *
 * 合約 M3/M8 原本「線上單唔 mirror 入 POS DB」，但系統其餘部分**早就預期**呢件事會發生：
 *   - `isLocalOrTransferredDineIn()`（pos-order-filters）：「線上堂食單已轉到枱 → 當本地單管理」；
 *   - 桌台佔用 `openOrders`（含 `paid`）→ `tableOrderMap` → 排位後枱面自動有單；
 *   - 報表 `restaurant-daily-report` 已經用 `onlineOrderId` 去重（唔會雙計）；
 *   - `api/pos/orders` 清除線下單已經 `.is("online_order_id", null)`（唔會誤刪）。
 *
 * ⇒ 只差「真正寫入」呢一步。**必須係 upsert（同一 Ledger 單永遠只有一張本地單）**，
 * append 會令收入雙計。
 *
 * ## 錢嘅口徑（商家 2026-09-12 定案：全單轉本地管理）
 *
 *   - 線上已付 → `status: "paid"` ＋ `prepaidAmount = total`（＝已收足）。
 *     結帳時 `payableBeforeMember = max(0, total − prepaid)`（pos-app:1908）
 *     → **只收加菜差額**，收入仍然只認一次。
 *   - 到店付款未收 → `status: "sent_to_kitchen"` ＋ `prepaidAmount = 0`（照正常堂食流程）。
 *   - ⚠️ `prepaidAmount` 係**鎖死**嘅（見 pos-orders.ts `reopenPosOrder`）：
 *     嗰筆錢喺 Ledger，POS 冇 RPC 可以沖正。
 *
 * @returns `created` = true 代表今次係新建立（之前未排過位／未入過本地單）
 */
export async function assignLedgerOrderToTable(options: AssignLedgerOrderTableOptions): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
  created: boolean;
  ledgerProgress: OnlineDineInProgress;
}> {
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  const projection = buildLedgerPosOrder(
    options.ledgerOrder,
    detail,
    options.tableId,
    options.tableName,
  );
  const result = await upsertLedgerLocalOrder(options.ledgerOrder, projection, "table_assigned");

  // 🔴 2026-09-13 商家需求：「排位完成即代表訂單已開始製作」→ 一次過將 Ledger
  // 由 `accepted` 推上 `completed`（逐級爬梯，跳級會 invalid transition）。
  // 只認帶 Ledger 單 id ＋ 真枱號嘅單；本地單／快餐 counter 單直接跳過。
  const ledgerProgress = await syncOnlineDineInCompletion(result.posOrder);

  return { ...result, ledgerProgress };
}

export type AdoptLedgerOrderAsQuickCounterOptions = {
  ledgerOrder: LedgerOnlineOrder;
  detail?: LedgerOrderDetail;
};

/**
 * **快餐模式專用**：將線上單採納成**本地快餐 counter 單**（2026-09-12 商家口徑）。
 *
 * 「快餐店有枱但唔會安排座位」——客人自己出餐口攞餐再搵位坐，所以：
 *   - `tableId = "counter"`、`tableName` 依 `tabType`（自取 / 外賣 / 堂食）
 *     —— 同收銀台自己落快餐單完全一樣（`quickTypeTableName()` 同一套命名）；
 *   - 唔出「排位」掣；
 *   - 入本地 `orders` 之後，快餐 strip 嘅「可取餐 → 完成」直接生效
 *     （`updateQuickFulfillmentInStore()` 只查 `tableId === "counter"` + 狀態，冇 `onlineOrderId` 守門）。
 *
 * ⚠️ 本地「可取餐 / 完成」要**回寫 Ledger**（`syncOnlineQuickFulfillment()`），
 * 否則會出現「本地已 settled、Ledger 仍 accepted」嘅雙狀態機。
 *
 * ⚠️ `isLocalOrTransferredDineIn()` 對 counter 單一律返 false → 呢啲單**唔會**入
 * 「店內線下訂單」面板（快餐單由快餐 strip 管理，分工同本地快餐單一致）。
 */
export async function adoptLedgerOrderAsQuickCounter(
  options: AdoptLedgerOrderAsQuickCounterOptions,
): Promise<{ posOrder: PosOrder; printJobs: PrintJob[]; created: boolean }> {
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  // 唔傳 tableId → resolveTableMeta 會落 counter + 自取／外賣／堂食。
  const projection = buildLedgerPosOrder(options.ledgerOrder, detail);
  return upsertLedgerLocalOrder(options.ledgerOrder, projection, "quick_counter_adopted");
}

/**
 * 線上單 → 本地單嘅**唯一 upsert 入口**（排位 / 快餐採納共用）。
 *
 * 🔴 一定要 upsert：同一張 Ledger 單只可以有一張本地單，append 會令收入雙計
 * （報表靠 `onlineOrderId` 去重，重複 id 就冇得去重）。
 */
async function upsertLedgerLocalOrder(
  ledgerOrder: LedgerOnlineOrder,
  projection: PosOrder,
  action: string,
): Promise<{ posOrder: PosOrder; printJobs: PrintJob[]; created: boolean }> {
  const paid = String(ledgerOrder.paymentStatus ?? "").toLowerCase() === "paid";
  const nowIso = new Date().toISOString();

  const existing = loadOrders();
  const index = existing.findIndex((row) => row.id === projection.id);
  const localOrder: PosOrder = {
    ...projection,
    status: paid ? "paid" : "sent_to_kitchen",
    prepaidAmount: paid ? (projection.total ?? 0) : 0,
    clientUpdatedAt: nowIso,
    updatedAt: nowIso,
    // 改枱 / 重複採納要保留原本建立時間（單據／排序都靠佢）。
    ...(index >= 0 ? { createdAt: existing[index].createdAt } : {}),
  };

  const nextOrders =
    index >= 0
      ? existing.map((row, i) => (i === index ? localOrder : row))
      : [localOrder, ...existing];
  // saveOrders() 會 dispatch `pos-orders-changed` → pos-app / 線下訂單面板 / 桌台總覽即時刷新。
  saveOrders(nextOrders);
  registerLedgerProjection(localOrder);
  enqueueOrderEvent(localOrder, index >= 0, action);

  // 補印廚房單（帶枱名）：唔做嘅話廚房只知有單、唔知送去邊張枱。
  const printJobs = buildPrintJobs(localOrder);
  appendPrintJobsWithSync(printJobs);

  return { posOrder: localOrder, printJobs, created: index < 0 };
}
