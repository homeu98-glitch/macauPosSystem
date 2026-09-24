"use client";

import { LedgerOnlineOrder, normalizeLedgerStatus } from "@/lib/ledger/order-mapper";
import { toLedgerMenuItemId } from "@/lib/ledger/menu-import";
import { getOrderDetail, LedgerOrderDetail, LedgerOrderDetailItem } from "@/lib/ledger/orders";
import { enrichSpecsFromMenu, toResolvedSpecs } from "@/lib/ledger/order-item-specs";
import { resolvePrintJobStatus } from "@/lib/print-bridge/companion";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  cacheLedgerPosOrder,
  hasPrintedLedgerOrder,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPosLocalSettings,
  loadPrintJobs,
  loadQueue,
  rememberPrintedLedgerOrder,
  saveOrders,
  saveQueue,
} from "@/lib/storage";
// ⚠️ 唔可以 import `@/lib/print-jobs`（佢反過來 import 咗呢個檔 → 循環依賴）。
// 出紙入隊邏輯走獨立嘅 `@/lib/pos/print-job-enqueue`。
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import { printOnceContentSignature } from "@/lib/pos/print-dedupe";
import {
  syncOnlineDineInCompletion,
  type OnlineDineInProgress,
} from "@/lib/pos/online-dinein-fulfillment";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import { isPrintContentEnabled } from "@/lib/print-toggles";
// 補建漏帳單時要保留 Ledger 事件時間（全站唯一時間口徑）。
import { orderEventISO } from "@/lib/pos/order-event-time";
import {
  decideKitchenBackfill,
  type KitchenBackfillDecision,
} from "@/lib/pos/kitchen-backfill";
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
  /**
   * **自動路徑專用**內容唯一鍵標籤（`PrintJob.onceKey`）：接單／採納／補印兜底
   * 一律 `kitchen:normal:${reopenCount}`，令「同一張單同一件事同一部機只出一張紙」。
   *
   * 🔴 2026-09-21 實案：同一個 realtime echo / backfill 會被**兩個 POS 視窗**各自
   * 處理一次（60 秒 once-guard 係 per realm）→ 同一張廚房單出兩張（10:42:37 一張、
   * 10:56:33 同秒再兩張）。詳見 `@/lib/pos/print-dedupe`。
   */
  onceKey?: string;
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
      // 內容簽名一齊入鍵（見 `buildPrintJobsForItems` 的 onceKey 註釋）。
      ...(options.onceKey
        ? {
            onceKey: `${options.onceKey}:${printOnceContentSignature(items.map(toPrintItemLine))}`,
          }
        : {}),
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
    // 接單（`bridgeLedgerOrderToPos`）同排位／快餐採納（`upsertLedgerLocalOrder`）係
    // **同一件事**（客人落單 → 廚房要嘅係同一張紙）→ 同一個 onceKey，只出一張。
    // 內容一變（客人改單）簽名就變 → 照出新紙。
    onceKey: `kitchen:normal:${order.reopenCount ?? 0}`,
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

/**
 * 線上單 → 落 sync queue（`ORDER_CREATED` / `ORDER_UPDATED`）＋ 即時 flush。
 *
 * 🔴 payload 形狀（2026-09-16 修，勿再改返）：`/api/pos/sync` 對 **ORDER_CREATED 讀裸 order**
 * （同 `pos-app.tsx submitOrder()` / `kiosk-order.ts submitKioskOrder()` 一致）；
 * 只有 `ORDER_UPDATED` 才係 `{ order, … }`。
 *
 * 舊寫法兩種 type 都送 `{ order }` → server 攞到 `order.id === undefined` →
 * `ack(false, "事件 payload 缺少訂單 id")` + HTTP **400**（永久、重試冇用）⇒
 * ① 每張首次排位／採納嘅線上單每次都失敗，卡死喺「同步健康檢查」；
 * ② 該張單喺 POS 雲端冇完整記錄（`ORDER_SETTLED` 嘅 0 列 upsert 只補到最小欄位，冇 items）；
 * ③ `sync-flush.ts pushedOrderStatus()` 因為拆唔到 status 而唔會寫上傳回執。
 * 實案：2026-09-16 店舖 `8291f843…` 有 6 筆 `entity_id = ledger-<uuid>` 嘅 ORDER_CREATED
 * 卡死喺 attempts≥5，用戶按「放棄」reload 後又彈返。
 *
 * （server 端亦已加兼容：兩種 type 都接受兩種形狀，令已經排隊嘅舊事件可以自動補上。）
 */
function enqueueOrderEvent(order: PosOrder, isUpdate: boolean, action?: string): void {
  if (typeof window === "undefined") return;
  const event: QueueEvent = {
    id: uid("evt"),
    type: isUpdate ? "ORDER_UPDATED" : "ORDER_CREATED",
    entityId: order.id,
    payload: isUpdate ? { order, action: action ?? "table_assigned" } : order,
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
    // 接單（含補印兜底 `ensureKitchenPrintForLedgerOrderOnce`）—— 同一張單同一件事
    // 只出一張紙。2026-09-21 實案：兩個 POS 視窗各自處理同一個 echo ⇒ 同秒出兩張。
    // 客人改單後補印 → 內容簽名唔同 → 照出新紙。
    onceKey: `kitchen:normal:${projection.reopenCount ?? 0}`,
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
  if (printJobs.length > 0) rememberPrintedLedgerOrder(projection.id);

  return printJobs;
}

/**
 * 補印兜底：「呢部機錯過咗接單，但廚房應該已經收過紙」→ 補一張。
 *
 * ── 為咩要共用入口（2026-09-14 J 實案：取餐碼 005 零 job）──────────────
 * 舊寫法係 `online-orders.tsx` 自己一個 `ensureKitchenPrintForAccepted()`：
 *
 *   1. 窗口太窄（只認 `accepted`／`preparing`）→ 單一跳到 `ready`／`completed`
 *      就**永遠唔補印**（POS 冇開／Realtime 斷線／單係由另一方接）；
 *   2. **只有「線上訂單」頁有** —— POS 主介面嘅快捷面板（`quick-online-orders-panel`）
 *      完全冇兜底 → 同一張單「有冇紙」取決於當時開住邊一頁（docs/113 §725-727）。
 *
 * 兩處（線上訂單頁 / POS 主介面快捷面板）一律叫呢個函式，判定邏輯收喺
 * `@/lib/pos/kitchen-backfill`（有 `node --test` 覆蓋）。
 *
 * ── 去重（三重，全部必要）────────────────────────────────────────────
 *   1. `decideKitchenBackfill()` 查「已出過紙帳本 + 本機 job」→ 唔會重複印；
 *   2. `kitchenBackfillAttempted`：同一個 session 每張單**只試一次**
 *      （失敗都唔重試，否則每個 tick 都彈 toast 洗版）；
 *   3. `kitchenBackfillInFlight`：**跨元件**（POS 主介面 + 線上訂單頁可能同時掛住）
 *      防止兩邊同時通過判準 → 同一張單出兩張紙。
 *
 * ⚠️ **已知邊界（多終端）**：以上都係**本機**判準。若同一間店同時開住兩個 POS 介面
 * （例如 iPad + 桌面版），A 機接單出紙之後，B 機要等到**下次載入 runtime state**
 * （reload / 手動更新）才會經雲端 backfill 見到嗰張 job —— 中間呢段時間 B 機
 * 有機會補印多一張。現階段接受（商家口徑：寧多一張，好過廚房零紙），
 * 要根治就要喺伺服器按 `order_id` 查一次 `pos_print_jobs`（未做）。
 */
export type KitchenBackfillReason = KitchenBackfillDecision | "suppressed" | "error";

export type KitchenBackfillResult = {
  /** true = 真係新建立並入隊咗廚房 job。 */
  printed: boolean;
  reason: KitchenBackfillReason;
  jobs: PrintJob[];
  /** `reason === "error"` 時嘅訊息（畀 caller 決定要唔要彈 toast）。 */
  errorMessage?: string;
};

const kitchenBackfillAttempted = new Set<string>();
const kitchenBackfillInFlight = new Set<string>();

export async function ensureKitchenPrintForLedgerOrderOnce(
  order: LedgerOnlineOrder,
): Promise<KitchenBackfillResult> {
  // 先查 session 級記錄（純記憶體，唔使讀 localStorage）→ 大部分情況喺度就收工。
  if (kitchenBackfillAttempted.has(order.id) || kitchenBackfillInFlight.has(order.id)) {
    return { printed: false, reason: "in-flight", jobs: [] };
  }

  const orderId = `ledger-${order.id}`;
  const decision = decideKitchenBackfill({
    status: order.status,
    updatedAt: order.updatedAt,
    createdAt: order.createdAt,
    nowMs: Date.now(),
    hasJob: hasPrintJobForOrder(orderId),
  });
  if (decision !== "print") return { printed: false, reason: decision, jobs: [] };

  kitchenBackfillInFlight.add(order.id);
  try {
    const jobs = await printKitchenForLedgerOrder(order);
    kitchenBackfillAttempted.add(order.id);
    // `jobs.length === 0` ＝ 打印設定熄咗（「線上訂單」或「廚房單＋標籤」兩個都熄）
    // → 唔可以當「已補印」報成功（假成功），亦唔可以當錯誤（店主自己決定唔印）。
    return { printed: jobs.length > 0, reason: jobs.length > 0 ? "print" : "suppressed", jobs };
  } catch (err) {
    // 失敗都算「試過」：冇 enabled 廚房機／Ledger 讀唔到明細等，重試只會不斷彈 toast。
    kitchenBackfillAttempted.add(order.id);
    return {
      printed: false,
      reason: "error",
      jobs: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    kitchenBackfillInFlight.delete(order.id);
  }
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
    // 預約單（`scheduled_pickup_at`）：一定要帶入投影，否則收據／廚房單嘅
    // 「預約時間」區塊永遠係空（Ledger 真源 → PosOrder → buildReceiptContent）。
    scheduledPickupAt: ledgerOrder.scheduledPickupAt,
    paymentMethod: ledgerOrder.paymentMode,
    createdAt: ledgerOrder.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/**
 * 攞（必要時建立）一張線上單嘅本地 `PosOrder` 表示 —— 只為**收據／補打**用途。
 *
 * ## 🔴 2026-09-13 修（商家實測：「查看」舊單仍然冇規格）
 *
 * 舊寫法**無條件先回傳** `bridgedOrders` 嘅 in-memory 投影：
 *
 * ```ts
 * const bridged = getBridgedPosOrder(ledgerOrder.id);
 * if (bridged) return bridged;   // ← 短路
 * ```
 *
 * 問題係嗰份投影可能係「規格解析修好**之前**」建立嘅（冇 `selectedSpecs`、
 * 冇 `line_note` 備註）。一旦存在就永遠短路 —— **即使 caller 已經抓咗最新嘅
 * `get_order_detail`**，規格／備註都入唔到去 → 舊單永遠顯示唔到規格。
 *
 * ⇒ 改為：**caller 帶咗 `detail` 就一律用 `detail` 重建**（規格／備註嘅唯一
 * 來源係 detail）；只有完全冇 detail 時，才退而用快取省一次 API。
 *
 * ## ⚠️ 重建要保留本機已推進嘅狀態
 *
 * `buildLedgerPosOrder()` 嘅 `status` / `fulfillmentStatus` 係**寫死**
 * `sent_to_kitchen` / `preparing`，而 `registerLedgerProjection()` 會覆寫
 * in-memory map ＋ store 快取。所以唔保留嘅話，一張「已結帳 / 已完成」嘅單
 * 一撳補打收據，投影就會被**退回製作中**，之後 `findPosOrderForLedger()`
 * 反查到嘅狀態就係錯嘅。⇒ 只覆寫「內容」（items / 金額 / 枱），
 * 狀態類欄位沿用本機已知值。
 *
 * 對應線下 `reprintReceiptForOrder` 嘅「由 storage 重讀權威版訂單」一步 ——
 * 線上單嘅權威係 Ledger，本地只係打印用嘅投影。
 */
export async function resolveLedgerPosOrderForReceipt(
  ledgerOrder: LedgerOnlineOrder,
  detail?: LedgerOrderDetail,
): Promise<PosOrder> {
  const cached = getBridgedPosOrder(ledgerOrder.id);
  // 冇帶 detail（唔想再打 API）→ 用快取。內容同原單一致，冇規格缺失風險。
  if (!detail && cached) return cached;

  const resolvedDetail = detail ?? (await getOrderDetail(ledgerOrder.id));
  const assigned = resolveAssignedTable(ledgerOrder.id);
  const built = buildLedgerPosOrder(ledgerOrder, resolvedDetail, assigned?.tableId, assigned?.tableName);

  // 保留本機已知嘅狀態類欄位（唔可以俾 projection 嘅預設值蓋掉）。
  const known = cached ?? loadOrders().find((row) => row.id === built.id) ?? null;
  const stable: PosOrder = known
    ? {
        ...built,
        ...(known.status ? { status: known.status } : {}),
        ...(known.fulfillmentStatus ? { fulfillmentStatus: known.fulfillmentStatus } : {}),
        ...(known.prepaidAmount != null ? { prepaidAmount: known.prepaidAmount } : {}),
        ...(known.createdAt ? { createdAt: known.createdAt } : {}),
      }
    : built;

  registerLedgerProjection(stable);
  return stable;
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
  /** true = 同一張單已出過紙 → 今次排位刻意唔再出（見 `upsertLedgerLocalOrder`）。 */
  printAlreadyDone: boolean;
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
): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
  created: boolean;
  printAlreadyDone: boolean;
}> {
  const detail = options.detail ?? (await getOrderDetail(options.ledgerOrder.id));
  // 唔傳 tableId → resolveTableMeta 會落 counter + 自取／外賣／堂食。
  const projection = buildLedgerPosOrder(options.ledgerOrder, detail);
  return upsertLedgerLocalOrder(options.ledgerOrder, projection, "quick_counter_adopted");
}

export type AdoptCompletedLedgerOrderOptions = {
  ledgerOrder: LedgerOnlineOrder;
  /** 已抓過嘅明細（省一次 RPC）。唔傳就即場抓。 */
  detail?: LedgerOrderDetail;
};

/**
 * **補建漏帳單**：把「Ledger 已完成 ＋ 已付款、但 POS 從未入帳」嘅線上單，
 * 寫成一張本地 `settled` 單並推上雲（2026-09-24）。
 *
 * ## 為咩要有呢個（表嫂美食 · 取餐碼 001 · MOP 43 · 餘額扣點 實案）
 *
 * 「外賣自取」嘅線上單，POS 收到後只行**出紙兜底**（`ensureKitchenPrintForLedgerOrderOnce`），
 * 唔會建本地單。商家若冇喺 POS 撳「採納／完成」，就會出現：
 *
 * | 位置 | 有冇 |
 * |---|---|
 * | Ledger（客人真係用餘額扣咗 43） | ✅ 已完成 ＋ 已付款 |
 * | POS `pos_orders`（雲端） | ❌ 完全冇 |
 * | 營業報表 / 交班明細（讀雲端） | ❌ 見唔到 |
 *
 * ⇒ 錢收到，但**報表靜默少計**，而且冇任何提示。呢個函式就係修補入口。
 *
 * ## 安全閘（唔可以拆）
 *
 * 只接受 `paymentStatus === "paid"` 且 `status` 正規化為 `completed` 嘅單。
 * 未付款／未完成嘅單補上去 ＝ 向報表謊報收入，係造數，唔係還原真相。
 *
 * ## 去重（三重，缺一都會出錯）
 *
 * 1. `upsertLedgerLocalOrder()` 用 `id = ledger-<ledgerId>` upsert ⇒ 同一張 Ledger 單
 *    永遠只有一張本地單（append 會令收入雙計，報表靠 `onlineOrderId` 去重）。
 * 2. `skipPrint: true` ⇒ **唔會出紙**（單已經做過，廚房唔應該再收一張）。
 * 3. `updatedAtOverride` 用 Ledger 事件時間 ⇒ 補建**昨日**嘅漏單會入**昨日**，
 *    唔會被當成今日生意。
 *
 * @returns `null` ＝ 唔符安全閘（未付款／未完成），呼叫端應靜默略過。
 */
export async function adoptCompletedLedgerOrderToLocal(
  options: AdoptCompletedLedgerOrderOptions,
): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
  created: boolean;
  printAlreadyDone: boolean;
} | null> {
  const order = options.ledgerOrder;
  if (String(order.paymentStatus ?? "").toLowerCase() !== "paid") return null;
  if (normalizeLedgerStatus(String(order.status ?? "")) !== "completed") return null;

  // 🔴🔴 2026-09-24 事故修正（必讀）：**已經有本地單（任何狀態）⇒ 唔係「漏帳」，唔可以補。**
  //
  // 只靠報表當前 range 嘅 `posOnlineIds` 判斷**唔夠**：較早日期嘅 POS 單唔喺今日 range，
  // 會被誤判成「未入 POS」。一旦補建，`upsertLedgerLocalOrder()` 會 upsert **覆蓋舊單**，
  // 而 `/api/pos/sync` 嘅 `updated_at` 係 **server 蓋章**（Vercel 時鐘，見 `sync/route.ts`
  // 第 342-349 行）⇒ 舊單嘅日期被推成**今日** ⇒
  //   ① 舊日報表少一張、今日多一張；
  //   ② 同日出現兩個相同取餐碼（取餐碼每日重用）⇒ 睇落好似「重複」；
  //   ③ 用 Ledger 明細重建會覆蓋店內加菜（金額縮水）。
  //
  // 2026-09-24 實案：補建 4 張，其中 2 張係**昨日**（09-23）嘅單（取餐碼 002 / 003），
  // 被移去今日 ⇒ 報表由 28 張變 37 張、金額由 1,778 變 2,423，商家以為「補完更錯」。
  //
  // ⇒ 補建**只可以**用於「POS 從來冇記錄過」嘅單。呢個檢查零請求（讀 localStorage）。
  if (loadOrders().some((row) => row.id === `ledger-${order.id}`)) return null;

  const detail = options.detail ?? (await getOrderDetail(order.id));
  const projection = buildLedgerPosOrder(order, detail);

  // 🔴 保留 Ledger 事件時間。只接受「過去」嘅值 —— Ledger 平台單有機會回未來時間
  // （實測 `created_at` 曾出現 +1 日），夾唔到就 fallback 用 now（寧可歸屬今日，
  // 都唔可以令單嘅時間戳跑到未來）。
  const eventIso = orderEventISO(order);
  const eventMs = Date.parse(eventIso);
  const updatedAtOverride =
    Number.isFinite(eventMs) && eventMs > 0 && eventMs <= Date.now() ? eventIso : undefined;

  return upsertLedgerLocalOrder(order, projection, "completed_backfill", {
    forceSettled: true,
    skipPrint: true,
    updatedAtOverride,
  });
}

/**
 * 同一張單係唔係**已經出過紙**（廚房單 / 飲品標籤，任何 role 都算）。
 *
 * 判準 = 本機 `printJobs` 有冇 `orderId === "ledger-<ledgerOrderId>"` 嘅 job。
 * 接單（`printKitchenForLedgerOrder`）、自動補印（`online-orders.tsx`
 * `ensureKitchenPrintForAccepted`）、快餐採納產生嘅 job 全部都用呢個 id
 * （＝ `buildLedgerPosOrder()` 嘅 `id`）⇒ 一條判準蓋齊所有出紙路徑。
 *
 * ⚠️ 本機 `printJobs` 係唯一睇得到嘅真源（雲端 `pos_print_jobs` 會 backfill 返本機），
 * 所以「換機排位」嘅極端情況仍可能漏判 —— 接受：商家口徑係「寧願少印一張、
 * 由收銀手動重打」，唔係「寧願多印」。
 *
 * 🔴 2026-09-14 補（J 實案）：**唔可以淨靠 `loadPrintJobs()`** —— 打印中心
 * 「清除已發送／清除已成功」係**真刪** job 行（`clearSentPrintJobs()` 等），
 * 清完之後呢個判準就會返 false → 同一張單會再出一張紙（重複出紙）。
 * 所以要一併查獨立嘅「已出過紙」帳本（`storage.printedLedgerOrders`）。
 */
function hasPrintJobForOrder(orderId: string): boolean {
  if (loadPrintJobs().some((job) => job.orderId === orderId)) return true;
  return hasPrintedLedgerOrder(orderId);
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
  options?: {
    /**
     * 強制寫成 `settled`（2026-09-24 新增）—— 補建「Ledger 已完成＋已付款、
     * 但 POS 從未入帳」嘅線上單時用。
     *
     * 背景：正常路徑（排位／快餐採納）嘅單仲未完成，所以只可以係 `paid`；
     * 但補建嘅單係**已經做完先發現漏帳**，報表認 `settled`/`paid`、交班只認 `settled`
     * ⇒ 只有 `settled` 兩邊都入。
     */
    forceSettled?: boolean;
    /**
     * 唔出紙（2026-09-24 新增）—— 補建歷史單用。
     *
     * 補建嘅單係「已經做過、只係冇入帳」，廚房唔應該再收到一張新紙。
     * 正常路徑唔可以傳呢個（接單／採納本身就要出紙）。
     */
    skipPrint?: boolean;
    /**
     * 覆寫 `updatedAt`（2026-09-24 新增）—— 補建時保留 Ledger 事件時間。
     *
     * 🔴 唔覆寫就會用 `now` ⇒ 補一張**昨日**嘅漏單會計入**今日**營業額（錯得更厲害）。
     * ⚠️ 呼叫端必須先驗值（只可以係過去時間），呢度唔會再夾。
     */
    updatedAtOverride?: string;
  },
): Promise<{
  posOrder: PosOrder;
  printJobs: PrintJob[];
  created: boolean;
  /** true = 同一張單之前已出過紙，今次刻意唔再出（見函式尾部註釋）。 */
  printAlreadyDone: boolean;
}> {
  const paid = String(ledgerOrder.paymentStatus ?? "").toLowerCase() === "paid";
  const nowIso = new Date().toISOString();
  /** 事件時間：補建時用 Ledger 時間，否則用「現在」（＝本機最後改動時間）。 */
  const stamp = options?.updatedAtOverride ?? nowIso;

  const existing = loadOrders();
  const index = existing.findIndex((row) => row.id === projection.id);
  const localOrder: PosOrder = {
    ...projection,
    status: options?.forceSettled ? "settled" : paid ? "paid" : "sent_to_kitchen",
    prepaidAmount: paid ? (projection.total ?? 0) : 0,
    clientUpdatedAt: nowIso,
    updatedAt: stamp,
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

  // 🔴 2026-09-14 商家口徑：**同一張單只出一次紙**。
  //
  // 舊寫法喺呢度無條件 `buildPrintJobs()` + `appendPrintJobsWithSync()`
  //（註釋寫「補印廚房單（帶枱名）」）⇒ 接單已經出過一張，排位／快餐採納再出一張
  // → **同一張單兩張廚房單**（2026-09-14 商家實案：取餐碼 004 堂食線上單）。
  // 去重攔唔到係因為 `mergePrintJobs` 只按 `job.id` 去重，而每次 `uid("print")` 都係新 id。
  //
  // 排位／採納嘅職責係「把線上單轉成本地單」（枱面佔用 / 結帳 / 報表 / Ledger 爬梯），
  // **唔係再出一次紙** —— 客人落單到出餐之間，第一次出咗就足夠。
  //
  // ⚠️ 刻意**唔**做「第一張失敗就補一張」：打印中心會出「列印失敗」紅標，
  // 收銀可以喺點餐位置手動重打（商家 2026-09-14 明確指示）。
  // ⚠️ 呢個檢查只覆蓋「同一部機」；換機排位可能仍會多出一張（接受，方向係寧少唔多）。
  // ⚠️ `skipPrint`（補建歷史單）唔會出紙：單已經做過，廚房唔應該再收到新紙。
  const printAlreadyDone = options?.skipPrint === true || hasPrintJobForOrder(projection.id);
  const printJobs = printAlreadyDone ? [] : buildPrintJobs(localOrder);
  if (printJobs.length > 0) {
    appendPrintJobsWithSync(printJobs);
    // 「已出過紙」帳本：打印中心之後就算清除紀錄，排位／採納都唔會再出一張（見 storage 註釋）。
    rememberPrintedLedgerOrder(projection.id);
  }

  return { posOrder: localOrder, printJobs, created: index < 0, printAlreadyDone };
}
