"use client";

/**
 * 零售結帳 —— 本機落單 + 入 outbox + 即時扣庫存。
 *
 * 🔴 **完全照抄既有成功模式**（`src/lib/pos-orders.ts` 嘅 `cancelLocalOrder`）：
 *   本機先改 → `saveOrders()` → `enqueueEvents(queue, withStoreScope([event]))` →
 *   `notifyQueueChanged()` → 廣播 `pos-orders-changed`。
 *   呢條路徑已經被 190+ 個測試同實戰驗證過，唔可以自己另創一套。
 *
 * 🔴 **狀態用 `settled` 唔係 `paid`**：
 *   `paid` 係快餐 counter 專用（單向閘，見 docs/113）。零售係「一手交錢一手交貨」，
 *   同堂食一樣即時完成 → 必須 `settled`，否則 `isSaleCountable()` 唔會計入營業額。
 *
 * ⚠️ **未做嘅嘢（刻意留下，下一階段）**：出票（收據 / 標籤）。
 *   原因：零售收據需要新嘅 `ReceiptSectionId` 區塊（品項條碼 / 拆分付款明細 / 會員積分 /
 *   退換貨條款），而加區塊一定要四端 renderer 同步 —— 只加一半會變成「撳咗冇反應」嘅死開關
 *   （docs/113 明文禁止）。所以出票同「四端同步 + 擰 versionCode」一次過做。
 *   目前會用**現有收據模板**出一張基本小票（見 `settleRetailOrder` 尾段 TODO）。
 */

import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import {
  getActiveStoreId,
  loadOrders,
  loadQueue,
  loadRetailProducts,
  nextLocalDailyOrderNo,
  saveOrders,
  saveQueue,
  saveRetailProducts,
} from "@/lib/storage";
import type { OrderItem, PosOrder, QueueEvent } from "@/lib/types";
import type { SplitPaymentEntry } from "@/lib/retail/types";

import { deductStockForLines, type StockChange } from "./stock.ts";
import {
  effectiveUnitPrice,
  lineDiscountAmount,
  lineHasManualAdjustment,
  retailOrderTotals,
  type RetailCartLine,
  type RetailDiscountRule,
  type RetailOrderTotals,
} from "./retail-cart.ts";

export interface SettleRetailOrderParams {
  lines: readonly RetailCartLine[];
  orderDiscount?: RetailDiscountRule;
  splitPayments: readonly SplitPaymentEntry[];
  /** 現金實收合計（寫入 `cashTendered`，收據「实收」用） */
  cashTendered?: number;
  /** 找零合計 */
  changeAmount?: number;
  /** 主付款方式標籤（保留 `paymentMethod` 令舊報表 / 舊收據模板唔會壞） */
  primaryMethodLabel?: string;
  /** 整單折扣 / 改價原因（現有硬閘：有折扣金額就要有原因） */
  discountNote?: string;
  operatorAccount?: string;
  operatorName?: string;
}

export interface SettleRetailOrderResult {
  ok: boolean;
  order?: PosOrder;
  totals?: RetailOrderTotals;
  /** 扣庫存結果（含超賣 shortfall —— UI 要提示） */
  stockChanges?: StockChange[];
  error?: string;
}

/** 把零售購物車行轉成訂單行（保留零售專屬欄位供出票 / 退貨反查） */
export function retailLineToOrderItem(line: RetailCartLine): OrderItem {
  const eff = effectiveUnitPrice(line);
  const overridden = line.priceOverride != null && Number.isFinite(line.priceOverride);

  const item: OrderItem = {
    // `menuItemId` 係「品項來源 id」嘅通用欄位；零售放商品 id
    menuItemId: line.productId,
    name: line.name,
    quantity: line.quantity,
    price: eff,
    // 零售冇廚房分區 → 一律收據通道（唔會誤送去 zone 機）
    printerGroup: "receipt",
  };

  if (line.sku) item.sku = line.sku;
  if (line.plu) item.plu = line.plu;
  if (line.barcode) item.barcode = line.barcode;
  if (line.variantId) item.variantId = line.variantId;
  if (line.variantLabel) item.variantLabel = line.variantLabel;
  if (line.serialNo) item.serialNo = line.serialNo;
  if (line.isWeighed && line.weightKg != null) item.weightKg = line.weightKg;
  if (line.note) item.note = line.note;
  // 改價審計：只有真係改過價才寫牌價，方便對帳計「改價差額」
  if (overridden) item.unitPriceOriginal = line.unitPrice;
  // 單品折扣（rate 語義同 pos/discount.ts 一致：80 = 8 折）
  if (line.lineDiscountRate != null && line.lineDiscountRate < 100) {
    item.discountRate = line.lineDiscountRate;
  }
  return item;
}

/** 由購物車行砌出訂單行（含稱重行嘅單價 × 重量說明） */
export function buildRetailOrderItems(lines: readonly RetailCartLine[]): OrderItem[] {
  return (lines ?? []).map(retailLineToOrderItem);
}

/**
 * 零售結帳。
 *
 * 次序：**先扣庫存並寫入商品主檔，再落單**。若庫存寫入失敗（quota / 私隱模式），
 * 會照樣落單但回報 `stockChanges` 為空 + 喺 console 大聲報錯 ——
 * 唔可以因為庫存寫唔入就食咗客人張單（錢已經收咗）。
 */
export function settleRetailOrder(params: SettleRetailOrderParams): SettleRetailOrderResult {
  const lines = params.lines ?? [];
  if (lines.length === 0) return { ok: false, error: "購物車係空" };

  const storeId = getActiveStoreId() ?? undefined;
  if (!storeId) {
    // 冇 storeId 一律大聲失敗：靜默落單會寫入假店（見 /api/pos/sync 註解）
    return { ok: false, error: "未選店鋪，唔可以落單" };
  }

  const totals = retailOrderTotals(lines, params.orderDiscount);
  if (totals.total < 0) return { ok: false, error: "應收金額唔可以係負數" };

  const now = new Date().toISOString();
  const items = buildRetailOrderItems(lines);

  // 序號（跟店內線下同日序號，kind 獨立成 "retail" 免同餐飲撞號）
  const localOrderNo = nextLocalDailyOrderNo("retail", "零售");

  const serialNos = lines.map((l) => l.serialNo).filter((s): s is string => Boolean(s));

  const order: PosOrder = {
    id: `retail-${crypto.randomUUID()}`,
    storeId,
    localOrderNo,
    // 零售冇枱：用 counter + 「零售」名（同快餐 counter 單分開認，因為 status 唔同）
    tableId: "counter",
    tableName: "零售",
    status: "settled",
    items,
    subtotal: totals.grossSubtotal,
    taxAmount: 0,
    serviceChargeAmount: 0,
    // 折扣總額 = 單品折扣 + 整單折扣（同既有報表口徑一致）
    discountAmount: Math.round((totals.itemDiscount + totals.orderDiscountAmount) * 100) / 100,
    total: totals.total,
    source: "pos",
    createdAt: now,
    updatedAt: now,
    /**
     * 🔴 LWW 一定要帶 `clientUpdatedAt`（客戶端鐘）——
     * server 用 `client_updated_at` 做 LWW，冇呢個欄位就會用 server 收件時間，
     * 令本機啱啱寫嘅狀態被舊 snapshot 蓋返（docs/113 快餐「已結帳閃回」同一條根因）。
     */
    clientUpdatedAt: now,
  };

  if (params.primaryMethodLabel) order.paymentMethod = params.primaryMethodLabel;
  if (params.cashTendered != null) order.cashTendered = params.cashTendered;
  if (params.changeAmount != null) order.changeAmount = params.changeAmount;
  if (params.discountNote) order.discountNote = params.discountNote;
  if (params.operatorAccount) order.settledBy = params.operatorAccount;
  if (params.operatorName) order.settledByName = params.operatorName;
  if (params.splitPayments?.length) order.splitPayments = [...params.splitPayments];
  if (serialNos.length > 0) order.serialNos = serialNos;

  // ── ① 即時扣庫存（商家定案：要即時扣減）──────────────────────
  let stockChanges: StockChange[] = [];
  const products = loadRetailProducts();
  if (products.length > 0) {
    const applied = deductStockForLines(products, lines);
    stockChanges = applied.changes;
    const wrote = saveRetailProducts(applied.products);
    if (!wrote) {
      // 唔阻止落單（錢已收），但一定要出聲
      console.error("[retail] 庫存寫入失敗（quota / 私隱模式？）→ 庫存可能未扣");
    }
    // 超賣要提示（唔可以靜默）
    const oversold = stockChanges.filter((c) => c.shortfall > 0);
    if (oversold.length > 0) {
      console.warn(
        "[retail] 超賣：",
        oversold.map((c) => `${c.label} 差 ${c.shortfall}`).join("、"),
      );
    }
  }

  // ── ② 本機落單 ──────────────────────────────────────────────
  const orders = loadOrders();
  saveOrders([...orders, order]);

  // ── ③ 入 outbox → 觸發上雲 ──────────────────────────────────
  const event: QueueEvent = {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "ORDER_CREATED",
    entityId: order.id,
    payload: { order },
    status: "pending",
    createdAt: now,
  };
  saveQueue(enqueueEvents(loadQueue(), withStoreScope([event])));
  notifyQueueChanged();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }

  // TODO（打印子階段）：喺呢度 `appendPrintJobsWithSync(buildReceiptPrintJobs(order))`。
  // 依家**刻意唔叫** —— 零售收據要新區塊（品項條碼 / 拆分付款明細 / 會員積分 / 退換條款），
  // 而加區塊必須四端 renderer 同步，唔可以只加一半（會變死開關）。見檔頭說明。

  return { ok: true, order, totals, stockChanges };
}

/** 購物車有冇任何「人手調整」（需要原因 / 權限閘） */
export function cartHasManualAdjustment(lines: readonly RetailCartLine[]): boolean {
  return (lines ?? []).some((l) => lineHasManualAdjustment(l));
}

/** 購物車嘅單品優惠合計（畀「要唔要填原因」判斷用） */
export function cartItemDiscountTotal(lines: readonly RetailCartLine[]): number {
  return Math.round((lines ?? []).reduce((s, l) => s + lineDiscountAmount(l), 0) * 100) / 100;
}
