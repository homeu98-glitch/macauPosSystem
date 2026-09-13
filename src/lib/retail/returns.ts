/**
 * 零售退換貨 —— **純函式，零 runtime 依賴**。
 *
 * 【為何唔直接重用 `pos-orders.ts` 嘅退菜】
 * 餐飲退菜係**整項退**（`voidedItems`，唔退款流程、唔回補庫存 —— 出咗廚房就係成本）。
 * 零售完全相反：**要回補庫存**（件貨退得返貨架）、**要真金白銀退款**、
 * **要按拆分付款比例分攤退款**（收咗現金 300 + 卡 200，退 100 要講明退邊筆）。
 * 兩者語義唔同 → 另立模組，唔好互相污染（同 `retail-cart.ts` vs `kiosk-cart.ts` 同一個判斷）。
 *
 * 【三條紅線】
 *   1. 🔴 **退款金額一定唔可以憑商品牌價計** —— 一定要用**原單實際實收**
 *      （`lineNet()` 口徑），否則打過折 / 改過價嘅單會退多錢。
 *   2. 🔴 **部分退 → 按比例分攤退款金額落各行**，尾差一定要補落最後一行，
 *      否則各行退款加起來 ≠ 整單退款（有單測鎖住）。
 *   3. 🔴 **已退數量唔可以超過原單數量**（可以分多次退：先退 1 件、隔日再退 1 件）。
 */

import type { OrderItem, PosOrder } from "@/lib/types";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ─────────────────────────────────────────────────────────────
// 原單查詢
// ─────────────────────────────────────────────────────────────

/**
 * 零售單判別。
 *
 * 🔴 一定要用 `tableId === "counter" && tableName === "零售"` 雙條件（唔可以只睇 `source`）：
 * 餐飲快餐 counter 單同樣係 `tableId:"counter"` + `source:"pos"`，只靠 source 會撈到餐飲單
 * → 退貨時會去回補「餐飲商品」嘅庫存（零售商品庫完全冇呢啲 id）→ 靜默失敗。
 */
export function isRetailOrder(order: Pick<PosOrder, "tableId" | "tableName">): boolean {
  return order.tableId === "counter" && order.tableName === "零售";
}

/** 可以退貨嘅狀態（未結帳 / 已取消嘅單冇得退） */
export function isRefundableStatus(
  status: PosOrder["status"],
): boolean {
  return status === "settled" || status === "partially_refunded";
}

export type ReturnLookupKind = "order-no" | "serial" | "barcode";

export interface ReturnLookupHit {
  order: PosOrder;
  kind: ReturnLookupKind;
  /** 命中嘅明細行索引（`barcode` / `serial` 命中時有值） */
  itemIndex?: number;
}

/**
 * 由「單號 / 序號 / 條碼」反查原單。
 *
 * 收銀現場三種入口都要支援：
 *   - 客人拎住**收據** → 打單號（`零售07`）
 *   - 客人拎住**貨品**（電器 / 手機）→ 掃機身序號
 *   - 客人只拎住**貨品**（普通貨）→ 掃條碼，再喺命中嘅單入面揀
 */
export function lookupReturnableOrders(
  orders: readonly PosOrder[],
  query: string,
  opts: { limit?: number } = {},
): ReturnLookupHit[] {
  const q = (query ?? "").trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const out: ReturnLookupHit[] = [];
  const lower = q.toLowerCase();

  for (const order of orders ?? []) {
    if (!isRetailOrder(order)) continue;
    if (!isRefundableStatus(order.status)) continue;

    // ① 單號（支援 `零售07` / `07` / 大小寫無關）
    const no = String(order.localOrderNo ?? "").trim();
    if (no && (no === q || no.toLowerCase() === lower || no.replace(/\D/g, "") === q.replace(/\D/g, ""))) {
      out.push({ order, kind: "order-no" });
      if (out.length >= limit) return out;
      continue;
    }

    // ② 序號 / ③ 條碼：逐行比對
    const items = order.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const sn = String(it.serialNo ?? "").trim();
      if (sn && sn.toLowerCase() === lower) {
        out.push({ order, kind: "serial", itemIndex: i });
        break;
      }
      const codes = [it.barcode, it.sku, it.plu]
        .map((c) => String(c ?? "").trim())
        .filter(Boolean);
      if (codes.some((c) => c.toLowerCase() === lower)) {
        out.push({ order, kind: "barcode", itemIndex: i });
        break;
      }
    }
    if (out.length >= limit) return out;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 可退數量 / 行級勾選
// ─────────────────────────────────────────────────────────────

/** 明細行嘅唯一鍵（同一商品唔同規格 / 序號要分開認） */
export function returnItemKey(item: OrderItem, index: number): string {
  const productId = String(item.menuItemId ?? "").trim();
  const variantId = String(item.variantId ?? "").trim();
  const serialNo = String(item.serialNo ?? "").trim();
  /**
   * 🔴 三個識別欄位**全空**（極舊單 / 人手插入嘅行）→ 一定要用索引兜底。
   * 唔可以靠「拼出嚟嘅字串係唔係空」判斷 —— `["","","","0.00"].join("::")` 會得到
   * `"::::::0.00"`（唔係空字串），但呢個 key 對所有「冇 id 又同價」嘅行都一樣
   * → 兩行會撞同一個 key → 退 A 行會當成退咗 B 行。
   */
  if (!productId && !variantId && !serialNo) return `idx-${index}`;
  return [productId, variantId, serialNo, num(item.price).toFixed(2)].join("::");
}

export interface ReturnableLine {
  key: string;
  index: number;
  item: OrderItem;
  name: string;
  /** 原單售出數量（稱重行 = 1） */
  soldQty: number;
  /** 已經退過嘅數量（累計，來自 `refundRecords`） */
  returnedQty: number;
  /** 仲可以退幾多 */
  remainingQty: number;
  /** 原單行實收（未分攤整單折扣） */
  lineNet: number;
  /** 單位（件 / kg） */
  unit: string;
  /** 稱重行：原單淨重（kg） */
  weightKg?: number;
  /** 已經退過嘅重量（kg） */
  returnedKg: number;
  /** 稱重行：仲可以退幾多 kg */
  remainingKg: number;
}

/**
 * 由歷史 `refundRecords` 累加出「每行已退數量」。
 *
 * 🔴 一定要累加**全部**紀錄，唔可以只睇最後一筆 ——
 * 分兩次退（先 1 件、後 1 件）嘅話只睇最後一筆會算出仲可以退 2 件 → **超退**。
 */
export function returnedQtyByKey(order: PosOrder): Map<string, { qty: number; kg: number }> {
  const map = new Map<string, { qty: number; kg: number }>();
  for (const rec of order.refundRecords ?? []) {
    for (const it of rec.items ?? []) {
      const key = String(it.itemKey ?? "");
      if (!key) continue;
      const prev = map.get(key) ?? { qty: 0, kg: 0 };
      map.set(key, {
        qty: round3(prev.qty + num(it.quantity)),
        kg: round3(prev.kg + num((it as { weightKg?: number }).weightKg)),
      });
    }
  }
  return map;
}

/** 砌出原單嘅可退行清單（含已退 / 剩餘數量） */
export function returnableLines(order: PosOrder): ReturnableLine[] {
  const items = order.items ?? [];
  const used = returnedQtyByKey(order);
  const out: ReturnableLine[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = returnItemKey(item, i);
    const isWeighed = item.weightKg != null && num(item.weightKg) > 0;
    const soldQty = isWeighed ? 1 : Math.max(0, num(item.quantity));
    const soldKg = isWeighed ? num(item.weightKg) : 0;

    const rec = used.get(key) ?? { qty: 0, kg: 0 };
    // 稱重行：以 kg 為準；普通行：以件數為準
    const returnedQty = isWeighed ? (rec.kg > 0 ? 1 : 0) : rec.qty;
    const returnedKg = rec.kg;

    out.push({
      key,
      index: i,
      item,
      name: item.name,
      soldQty,
      returnedQty,
      remainingQty: round3(Math.max(0, soldQty - returnedQty)),
      lineNet: lineNetOfItem(item),
      unit: isWeighed ? "kg" : "件",
      ...(isWeighed ? { weightKg: soldKg } : {}),
      returnedKg,
      remainingKg: round3(Math.max(0, soldKg - returnedKg)),
    });
  }
  return out;
}

/**
 * 單行實收金額。
 *
 * 🔴 **唔可以只用 `item.price × quantity`** —— 零售行有改價（`unitPriceOriginal`）、
 * 單品折扣（`discountRate`）兩種調整，要用當時嘅實際計價口徑：
 *   實際單價 = `price`（已係改價後）→ 再乘折扣率。
 * 稱重行乘數係 `weightKg`。
 */
export function lineNetOfItem(item: OrderItem): number {
  const factor =
    item.weightKg != null && num(item.weightKg) > 0 ? num(item.weightKg) : Math.max(0, num(item.quantity));
  const gross = round2(num(item.price) * factor);
  const rate = item.discountRate;
  let net = gross;
  if (typeof rate === "number" && Number.isFinite(rate) && rate < 100) {
    // rate 語義同 pos/discount.ts 一致：80 = 8 折 → 收 80%
    net = round2((gross * Math.max(0, rate)) / 100);
  }
  return round2(Math.max(0, net));
}

// ─────────────────────────────────────────────────────────────
// 退貨請求 / 計算
// ─────────────────────────────────────────────────────────────

/** 揀一行要退幾多 */
export interface ReturnPick {
  key: string;
  /** 普通行：退幾件 */
  qty?: number;
  /** 稱重行：退幾多 kg */
  kg?: number;
}

export type ReturnPickError =
  | { key: string; reason: "not-found" }
  | { key: string; reason: "exceeds"; asked: number; remaining: number }
  | { key: string; reason: "invalid" };

export interface ReturnComputation {
  ok: boolean;
  errors: ReturnPickError[];
  /** 逐行退款明細（正數 = 退幾多） */
  lines: Array<{
    key: string;
    name: string;
    qty: number;
    kg: number;
    /** 退款金額（未分攤整單折扣） */
    amount: number;
    restockQty: number;
    restockKg: number;
  }>;
  /** 商品小計退款（= 各行加總） */
  goodsRefund: number;
  /** 整單折扣回贈（原單有整單折扣時，退貨要按比例退回客人） */
  orderDiscountRefund: number;
  /** 應退總額 */
  totalRefund: number;
  /** 按原單付款方式分攤（退現金 / 退卡 各幾多） */
  refundByMethod: Array<{ methodId: string; label: string; amount: number }>;
  /** 全退？（= 可以將單標記 `refunded`，否則 `partially_refunded`） */
  isFullRefund: boolean;
}

/**
 * 計算一次退貨。
 *
 * 【整單折扣點分攤】
 * 原單有整單折扣（`order.discountAmount > 商品折扣`）時，客人實付少過商品小計。
 * 退貨唔可以退足商品價（會退多錢）→ 按**該行佔商品小計嘅比例**退回對應折扣。
 *
 * 【拆分付款點分攤】
 * 原單收咗現金 + 卡 → 退款按**各筆佔比**分攤，尾差補落最後一筆。
 * （現實中多數全額退現金，但帳目上一定要對得上，唔可以退多過實收。）
 */
export function computeReturn(
  order: PosOrder,
  picks: readonly ReturnPick[],
  opts: { reason?: string } = {},
): ReturnComputation {
  void opts;
  const errors: ReturnPickError[] = [];
  const available = new Map(returnableLines(order).map((l) => [l.key, l]));
  const lines: ReturnComputation["lines"] = [];

  for (const pick of picks ?? []) {
    const line = available.get(pick.key);
    if (!line) {
      errors.push({ key: pick.key, reason: "not-found" });
      continue;
    }

    // ⚠️ 用局部變數而唔靠 `isWeighed` 去 narrow —— TS 唔會由 boolean 變數反推 `line.weightKg`
    const soldKg = line.weightKg ?? 0;
    const isWeighed = soldKg > 0;

    if (isWeighed) {
      const kg = round3(num(pick.kg));
      if (kg <= 0) {
        errors.push({ key: pick.key, reason: "invalid" });
        continue;
      }
      if (kg > line.remainingKg + 1e-9) {
        errors.push({ key: pick.key, reason: "exceeds", asked: kg, remaining: line.remainingKg });
        continue;
      }
      // 稱重行：按比例退（退 0.3kg / 原 0.5kg → 退 6 成錢）
      const ratio = soldKg > 0 ? kg / soldKg : 0;
      const amount = round2(line.lineNet * ratio);
      lines.push({
        key: pick.key,
        name: line.name,
        qty: 0,
        kg,
        amount,
        restockQty: 0,
        restockKg: kg,
      });
      continue;
    }

    const rawQty = pick.qty;
    const qty = rawQty == null || !Number.isFinite(rawQty) ? 0 : Math.floor(num(rawQty));
    if (qty <= 0) {
      errors.push({ key: pick.key, reason: "invalid" });
      continue;
    }
    if (qty > line.remainingQty) {
      errors.push({ key: pick.key, reason: "exceeds", asked: qty, remaining: line.remainingQty });
      continue;
    }
    // 普通行：按件數均攤（行實收 ÷ 售出件數 × 退件數）
    const perUnit = line.soldQty > 0 ? line.lineNet / line.soldQty : 0;
    const amount = round2(perUnit * qty);
    lines.push({
      key: pick.key,
      name: line.name,
      qty,
      kg: 0,
      amount,
      restockQty: qty,
      restockKg: 0,
    });
  }

  if (errors.length > 0 || lines.length === 0) {
    return {
      ok: false,
      errors: errors.length > 0 ? errors : [{ key: "", reason: "invalid" }],
      lines: [],
      goodsRefund: 0,
      orderDiscountRefund: 0,
      totalRefund: 0,
      refundByMethod: [],
      isFullRefund: false,
    };
  }

  const goodsRefund = round2(lines.reduce((s, l) => s + l.amount, 0));

  // ── 整單折扣回贈 ────────────────────────────────────────────
  /**
   * 原單「整單折扣」= `order.discountAmount` 入面**唔屬於單品折扣**嘅部分。
   * 單品折扣已經反映喺 `item.price` / `discountRate`，所以唔可以重複計。
   * 保守做法：以 `order.discountAmount` 為上限，按「今次退貨佔原單商品小計」比例退回。
   */
  const orderLevelDiscount = Math.max(
    0,
    num(order.discountAmount) - itemDiscountTotalOfOrder(order),
  );
  const orderGoodsTotal = round2(
    (order.items ?? []).reduce((s, it) => s + lineGrossOfItem(it), 0),
  );
  let orderDiscountRefund = 0;
  if (orderLevelDiscount > 0 && orderGoodsTotal > 0) {
    const ratio = Math.min(1, goodsRefund / orderGoodsTotal);
    orderDiscountRefund = round2(orderLevelDiscount * ratio);
  }

  const totalRefund = round2(Math.max(0, goodsRefund - orderDiscountRefund));

  // ── 全退判定 ────────────────────────────────────────────────
  /**
   * 🔴 **用「剩餘可退金額」判定，唔可以用「剩餘件數」**。
   *
   * 原因：稱重行嘅「剩餘」係 kg（1.5kg 退 0.5kg → 剩 1kg ≠ 0），
   * 但按件數睇「soldQty 1 − returnedQty 1 = 0」會被當成全退 → **單會被標成 `refunded`、
   * 之後客人再退 1kg 就冇得退**。
   * 金額口徑天然處理「按比例退」，亦同「客人實付」對得上。
   */
  const before = returnableLines(order);
  const remainingValueBefore = round2(
    before.reduce((s, l) => s + remainingValueOfLine(l), 0),
  );
  // 今次退嘅商品金額（唔計整單折扣回贈 —— 折扣係隨貨退回，唔可以當成「仲有貨未退」）
  const remainingValueAfter = round2(remainingValueBefore - goodsRefund);
  const isFullRefund =
    before.length > 0 && remainingValueAfter <= 1e-9 && Math.abs(remainingValueAfter) < 0.005;

  // ── 拆分付款分攤 ────────────────────────────────────────────
  const refundByMethod = splitRefundByMethod(order, totalRefund);

  return {
    ok: true,
    errors: [],
    lines,
    goodsRefund,
    orderDiscountRefund,
    totalRefund,
    refundByMethod,
    isFullRefund,
  };
}

/** 行牌價毛額（未計任何折扣）—— 只作分攤基數，唔作退款金額 */
function lineGrossOfItem(item: OrderItem): number {
  const factor =
    item.weightKg != null && num(item.weightKg) > 0 ? num(item.weightKg) : Math.max(0, num(item.quantity));
  return round2(num(item.price) * factor);
}

/**
 * 一行「仲有幾多錢可以退」（＝行實收 × 剩餘比例）。
 *
 * 稱重行：按剩餘 kg 佔比；普通行：按剩餘件數佔比。
 */
function remainingValueOfLine(line: ReturnableLine): number {
  if (line.lineNet <= 0) return 0;
  if (line.weightKg != null && line.weightKg > 0) {
    const ratio = line.weightKg > 0 ? line.remainingKg / line.weightKg : 0;
    return round2(line.lineNet * Math.max(0, Math.min(1, ratio)));
  }
  if (line.soldQty <= 0) return 0;
  const ratio = line.remainingQty / line.soldQty;
  return round2(line.lineNet * Math.max(0, Math.min(1, ratio)));
}

/** 原單「單品折扣」總額（整單折扣 = discountAmount − 呢個） */
export function itemDiscountTotalOfOrder(order: PosOrder): number {
  let total = 0;
  for (const item of order.items ?? []) {
    const gross = lineGrossOfItem(item);
    const rate = item.discountRate;
    if (typeof rate === "number" && Number.isFinite(rate) && rate < 100) {
      total += gross - round2((gross * Math.max(0, rate)) / 100);
    }
  }
  return round2(Math.max(0, total));
}

/**
 * 退款按原單付款方式分攤。
 *
 * 🔴 **尾差一定要補落最後一筆** —— 用 `round2` 逐筆計會令總和差 0.01，
 * 對帳時會出現「退款總額 ≠ 各筆加總」（有單測鎖住）。
 * 冇 `splitPayments`（單一付款）→ 出一筆，label 用 `paymentMethod`。
 */
export function splitRefundByMethod(
  order: PosOrder,
  totalRefund: number,
): Array<{ methodId: string; label: string; amount: number }> {
  const total = round2(Math.max(0, totalRefund));
  if (total <= 0) return [];

  const entries = order.splitPayments ?? [];
  const paid = entries.reduce((s, e) => s + num(e.amount), 0);

  if (entries.length === 0 || paid <= 0) {
    return [
      {
        methodId: "default",
        label: order.paymentMethod || "現金",
        amount: total,
      },
    ];
  }

  const out: Array<{ methodId: string; label: string; amount: number }> = [];
  let allocated = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isLast = i === entries.length - 1;
    const share = isLast
      ? round2(total - allocated)
      : round2((total * num(e.amount)) / paid);
    allocated = round2(allocated + share);
    out.push({
      methodId: e.methodId || "default",
      label: e.label || order.paymentMethod || "現金",
      amount: Math.max(0, share),
    });
  }
  return out.filter((e) => e.amount > 0);
}

// ─────────────────────────────────────────────────────────────
// 落帳：更新原單
// ─────────────────────────────────────────────────────────────

export interface ApplyReturnParams {
  order: PosOrder;
  computation: ReturnComputation;
  reason: string;
  employeeAccount?: string;
  employeeName?: string;
  /** 退款方式（人手改：例如原單刷卡但今次退現金） */
  refundByMethod?: Array<{ methodId: string; label: string; amount: number }>;
  now?: string;
}

export interface ApplyReturnResult {
  ok: boolean;
  order?: PosOrder;
  error?: string;
}

/**
 * 將一次退貨寫入原單（**純函式，唔碰 localStorage**）。
 *
 * 寫入內容：
 *   - `refundRecords` 追加一筆（`itemKey` 用 `returnItemKey()` 口徑，供下次累加）
 *   - `refundedAmount` / `refundedAt` / `refundedReason` 更新為**累計值**
 *   - `status` → 全退 `refunded`、部分退 `partially_refunded`
 *
 * 🔴 唔可以覆寫 `refundRecords`（要追加）—— 覆寫會令上次退嘅數量消失 → 可以再退一次。
 */
export function applyReturnToOrder(params: ApplyReturnParams): ApplyReturnResult {
  const { order, computation } = params;
  if (!computation.ok || computation.lines.length === 0) {
    return { ok: false, error: "退貨計算未通過，唔可以落帳" };
  }
  if (!isRefundableStatus(order.status)) {
    return { ok: false, error: `單狀態「${order.status}」唔可以退貨` };
  }

  const now = params.now ?? new Date().toISOString();
  const record: NonNullable<PosOrder["refundRecords"]>[number] = {
    id: `refund-${now}-${Math.random().toString(36).slice(2, 8)}`,
    amount: computation.totalRefund,
    reason: params.reason,
    ...(params.employeeAccount ? { employeeAccount: params.employeeAccount } : {}),
    ...(params.employeeName ? { employeeName: params.employeeName } : {}),
    items: computation.lines.map((l) => ({
      itemKey: l.key,
      name: l.name,
      quantity: l.kg > 0 ? 0 : l.qty,
      amount: l.amount,
      // 稱重行要記重量（`refundRecords.items` 冇正式欄位，用 extra 欄位帶住）
      ...(l.kg > 0 ? { weightKg: l.kg } : {}),
    })),
    createdAt: now,
  };

  const prevRecords = order.refundRecords ?? [];
  const prevAmount = num(order.refundedAmount);
  const nextAmount = round2(prevAmount + computation.totalRefund);

  const next: PosOrder = {
    ...order,
    status: computation.isFullRefund ? "refunded" : "partially_refunded",
    refundRecords: [...prevRecords, record],
    refundedAmount: nextAmount,
    refundedAt: now,
    refundedReason: params.reason,
    updatedAt: now,
    // 🔴 LWW：一定要帶客戶端鐘，否則退款狀態會被舊 snapshot 蓋返（docs/113 同一條根因）
    clientUpdatedAt: now,
  };

  return { ok: true, order: next };
}

// ─────────────────────────────────────────────────────────────
// 庫存回補
// ─────────────────────────────────────────────────────────────

/** 由退貨結果砌出「入庫」行（可餵 `restoreStockForLines()`） */
export function restockLines(computation: ReturnComputation): Array<{
  productId: string;
  variantId?: string;
  quantity: number;
  weightKg?: number;
  isWeighed?: boolean;
}> {
  return computation.lines
    .map((l) => {
      const productId = l.key.split("::")[0] ?? "";
      const variantId = l.key.split("::")[1] || undefined;
      if (l.kg > 0) {
        return { productId, variantId, quantity: 1, weightKg: l.kg, isWeighed: true };
      }
      return { productId, variantId, quantity: l.qty };
    })
    .filter((l) => Boolean(l.productId) && (l.quantity > 0 || (l.weightKg ?? 0) > 0));
}

/**
 * 唔應該回補庫存嘅退貨原因。
 *
 * 現實：客人退嘅貨**未必入得返貨架**（過期 / 破損 / 已拆封）。
 * 呢類一律照退款但唔回補庫存 —— 否則庫存會虛高，之後盤點又要再改一次。
 * 條款由商家自訂，所以用 `includes` 寬鬆比對（唔逼商家打特定字）。
 */
const NO_RESTOCK_KEYWORDS = [
  "過期",
  "过期",
  "破損",
  "破损",
  "損壞",
  "损坏",
  "已開封",
  "已开封",
  "拆封",
  "報廢",
  "报废",
  "食品",
  "生鮮",
  "生鲜",
];

/** 呢個原因要唔要回補庫存 */
export function shouldRestock(reason: string): boolean {
  const r = (reason ?? "").trim();
  if (!r) return true;
  return !NO_RESTOCK_KEYWORDS.some((k) => r.includes(k));
}

// ─────────────────────────────────────────────────────────────
// 換貨
// ─────────────────────────────────────────────────────────────

/**
 * 換貨 = 退貨 + 新單。
 *
 * 唔喺呢度直接落新單（新單要經 `settleRetailOrder()` 行正常結帳路徑 ——
 * 出票 / outbox / 扣庫存一步都唔可以少）；呢度只負責**計差額**同**帶原單號**。
 */
export interface ExchangePlan {
  /** 應退（原單退貨部分） */
  refund: number;
  /** 新貨應收 */
  charge: number;
  /** 正數 = 客人要補錢；負數 = 要退返客人 */
  difference: number;
  /** 收銀台要顯示嘅一句（口語化，唔露欄位名） */
  summary: string;
}

export function planExchange(refund: number, charge: number): ExchangePlan {
  const r = round2(Math.max(0, num(refund)));
  const c = round2(Math.max(0, num(charge)));
  const difference = round2(c - r);
  const summary =
    difference > 0
      ? `客人需補 ${difference.toFixed(2)}`
      : difference < 0
        ? `需退返客人 ${Math.abs(difference).toFixed(2)}`
        : "金額相同，唔需找補";
  return { refund: r, charge: c, difference, summary };
}
