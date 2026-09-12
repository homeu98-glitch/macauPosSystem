/**
 * 零售購物車 —— **純函式，零 runtime 依賴**（除咗刻意重用嘅 `../pos/discount.ts`，
 * 佢亦係零 runtime 依賴，所以 `node --test` 載入得到）。
 *
 * 【為何唔直接擴 `kiosk-cart.ts` 嘅 `CartLine`】
 * `kiosk-cart.ts` 係**餐飲／掃碼點餐**共用嘅，`lineSignature` 一改就會影響落單合併行為
 * （已有 199+ 個回歸測試鎖住）。零售嘅行形狀差太遠（改價、定額折、稱重、變體、序號），
 * 夾硬塞入去只會令兩邊都難維護。所以呢度用同一套**設計慣例**（純函式、signature 合併、
 * 金額單一真源）另寫一份，而**折扣數學真正重用** `pos/discount.ts`（rate 語義完全一致）。
 *
 * 🔴 【簽名必須納入折扣同改價】否則「原價可樂」同「特價可樂」會被合併成一行 → 帳目錯。
 * 🔴 【稱重 / 序號行永遠唔合併】每次秤重、每個序號都係獨立一件實物。
 */

import { discountAmountFromRate } from "../pos/discount.ts";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type RetailCartLine = {
  lineId: string;
  productId: string;
  /** 掃到變體條碼 / 揀過變體時有值 */
  variantId?: string;
  /** 顯示用：「黑 / L」 */
  variantLabel?: string;
  sku?: string;
  /** 實際掃入嘅條碼（出票要印，退換貨靠佢） */
  barcode?: string;
  plu?: string;
  name: string;
  /**
   * **牌價**（商品 / 變體本身嘅價，改價前）。
   * 稱重商品 = 每 kg 價。
   */
  unitPrice: number;
  quantity: number;
  /** 件 / kg / 包 */
  unit: string;
  /** 稱重商品淨重（kg）；有值時金額 = `effectiveUnitPrice × weightKg` */
  weightKg?: number;
  /**
   * 改價（覆寫 `unitPrice`）。零售高頻操作，亦係舞弊高風險位 →
   * 一定要配權限閘 + 審計（`unitPrice` 保留做原價比對）。
   */
  priceOverride?: number;
  /** 單品折扣率（0-100，80 = 8 折）。語義同 `pos/discount.ts` 完全一致。 */
  lineDiscountRate?: number;
  /** 單品定額折（元）。零售「減 $5」用；同 rate 可以同時存在。 */
  lineDiscountAmount?: number;
  isWeighed?: boolean;
  /** 序號 / IMEI（序號商品售出時綁定） */
  serialNo?: string;
  note?: string;
  /** 明確標記唔可以合併（一物一條碼之類） */
  nonMergeable?: boolean;
};

export type RetailDiscountRule = {
  /** 整單折扣率（0-100，80 = 8 折） */
  rate?: number;
  /** 整單定額折（元） */
  amount?: number;
};

export type RetailOrderTotals = {
  /** 行數 */
  lineCount: number;
  /** 總件數（稱重行算 1 件；睇重量請用 `weighedTotalKg`） */
  quantity: number;
  /** 稱重行淨重合計（kg） */
  weighedTotalKg: number;
  /** 牌價合計（改價、折扣之前） */
  listTotal: number;
  /** 改價造成嘅差額（listTotal − grossSubtotal），正數 = 減咗幾多 */
  overrideSaving: number;
  /** 改價後、未扣折扣嘅商品小計 */
  grossSubtotal: number;
  /** 單品折扣合計 */
  itemDiscount: number;
  /** 商品小計（= grossSubtotal − itemDiscount） */
  netSubtotal: number;
  /** 整單折扣金額 */
  orderDiscountAmount: number;
  /** 應收 */
  total: number;
  /** 總共優惠（牌價合計 − 應收） */
  totalSaving: number;
};

/** 行係咪可以同其他行合併 */
export function isMergeableLine(
  line: Omit<RetailCartLine, "lineId" | "quantity">,
): boolean {
  if (line.nonMergeable) return false;
  if (line.isWeighed) return false; // 每次秤重係獨立一件實物
  if ((line.serialNo ?? "").trim()) return false; // 序號商品一物一碼
  return true;
}

/**
 * 行簽名：同「商品 + 變體 + 牌價 + 改價 + 折扣 + 備註」就當同一行（自動合併數量）。
 *
 * 🔴 折扣 / 改價一定要入簽名：唔入就會出現「$199 原價 T 恤」同「8 折 T 恤」
 * 合併成一行、數量變 2、但只收一個價 → **帳目錯**（docs/124 §R2）。
 */
export function retailLineSignature(
  line: Omit<RetailCartLine, "lineId" | "quantity">,
): string {
  return [
    line.productId,
    line.variantId ?? "",
    num(line.unitPrice).toFixed(2),
    line.priceOverride == null ? "" : num(line.priceOverride).toFixed(2),
    line.lineDiscountRate == null ? "" : String(line.lineDiscountRate),
    line.lineDiscountAmount == null ? "" : num(line.lineDiscountAmount).toFixed(2),
    (line.note ?? "").trim(),
  ].join("|");
}

/** 加一行：可合併就數量 +1，否則新增一行 */
export function addRetailLine(
  cart: readonly RetailCartLine[],
  base: Omit<RetailCartLine, "lineId" | "quantity">,
  newLineId: string,
): RetailCartLine[] {
  const list = [...cart];
  if (isMergeableLine(base)) {
    const sig = retailLineSignature(base);
    /**
     * 🔴 兩邊都要檢查「可以合併」：
     * 簽名**唔包含** `serialNo` / `nonMergeable`，所以一就緒「已綁序號嘅行」會被
     * 一個簽名相同嘅新行match 到 → 序號行被合併 → 一物一碼失效。
     * （2026-09-12 由單測捉到。）
     */
    const idx = list.findIndex((l) => isMergeableLine(l) && retailLineSignature(l) === sig);
    if (idx >= 0) {
      list[idx] = { ...list[idx], quantity: list[idx].quantity + 1 };
      return list;
    }
  }
  list.push({ ...base, lineId: newLineId, quantity: 1 });
  return list;
}

/** 改數量（加減）；數量歸零就移除該行 */
export function changeRetailQty(
  cart: readonly RetailCartLine[],
  lineId: string,
  delta: number,
): RetailCartLine[] {
  return cart
    .map((l) => (l.lineId === lineId ? { ...l, quantity: Math.max(0, l.quantity + delta) } : l))
    .filter((l) => l.quantity > 0);
}

/** 直接設定數量；<= 0 就移除 */
export function setRetailQty(
  cart: readonly RetailCartLine[],
  lineId: string,
  qty: number,
): RetailCartLine[] {
  const q = Math.floor(num(qty));
  if (!Number.isFinite(q) || q <= 0) return removeRetailLine(cart, lineId);
  return cart.map((l) => (l.lineId === lineId ? { ...l, quantity: q } : l));
}

export function removeRetailLine(
  cart: readonly RetailCartLine[],
  lineId: string,
): RetailCartLine[] {
  return cart.filter((l) => l.lineId !== lineId);
}

export function findRetailLine(
  cart: readonly RetailCartLine[],
  lineId: string,
): RetailCartLine | undefined {
  return cart.find((l) => l.lineId === lineId);
}

/** 改價：`price` 傳 `undefined` = 取消改價、回復牌價 */
export function setLinePriceOverride(
  cart: readonly RetailCartLine[],
  lineId: string,
  price?: number,
): RetailCartLine[] {
  return cart.map((l) => {
    if (l.lineId !== lineId) return l;
    if (price == null || !Number.isFinite(price)) {
      // 取消改價：一定要**真正刪走個欄位**，留 `undefined` 會令簽名變成另一串
      const rest: RetailCartLine = { ...l };
      delete rest.priceOverride;
      return rest;
    }
    return { ...l, priceOverride: round2(Math.max(0, price)) };
  });
}

/** 設定單品折扣；兩個都傳 `undefined` = 清除折扣 */
export function setLineDiscount(
  cart: readonly RetailCartLine[],
  lineId: string,
  patch: { rate?: number; amount?: number },
): RetailCartLine[] {
  return cart.map((l) => {
    if (l.lineId !== lineId) return l;
    const rate =
      patch.rate == null || !Number.isFinite(patch.rate) || patch.rate >= 100
        ? undefined
        : Math.max(0, patch.rate);
    const amount =
      patch.amount == null || !Number.isFinite(patch.amount) || patch.amount <= 0
        ? undefined
        : round2(patch.amount);
    const next: RetailCartLine = { ...l };
    if (rate == null) delete next.lineDiscountRate;
    else next.lineDiscountRate = rate;
    if (amount == null) delete next.lineDiscountAmount;
    else next.lineDiscountAmount = amount;
    return next;
  });
}

/** 綁定 / 清除序號（序號商品售出時登記，退貨可反查） */
export function setLineSerial(
  cart: readonly RetailCartLine[],
  lineId: string,
  serialNo?: string,
): RetailCartLine[] {
  return cart.map((l) => {
    if (l.lineId !== lineId) return l;
    const s = (serialNo ?? "").trim();
    const next: RetailCartLine = { ...l };
    if (!s) delete next.serialNo;
    else next.serialNo = s;
    // 綁咗序號就唔應該再合併
    if (s) next.nonMergeable = true;
    return next;
  });
}

/** 行備註 */
export function setLineNote(
  cart: readonly RetailCartLine[],
  lineId: string,
  note?: string,
): RetailCartLine[] {
  return cart.map((l) => {
    if (l.lineId !== lineId) return l;
    const s = (note ?? "").trim();
    const next: RetailCartLine = { ...l };
    if (!s) delete next.note;
    else next.note = s;
    return next;
  });
}

// ─────────────────────────────────────────────────────────────
// 金額（單一真源）
// ─────────────────────────────────────────────────────────────

/** 實際計價單價：改價優先，否則牌價 */
export function effectiveUnitPrice(line: Pick<RetailCartLine, "unitPrice" | "priceOverride">): number {
  if (line.priceOverride != null && Number.isFinite(line.priceOverride)) {
    return round2(Math.max(0, line.priceOverride));
  }
  return round2(Math.max(0, num(line.unitPrice)));
}

/** 計價乘數：稱重行用重量（kg），否則用數量 */
export function lineQuantityFactor(
  line: Pick<RetailCartLine, "quantity" | "weightKg" | "isWeighed">,
): number {
  if (line.isWeighed && line.weightKg != null && Number.isFinite(line.weightKg)) {
    return Math.max(0, line.weightKg);
  }
  return Math.max(0, num(line.quantity));
}

/** 牌價小計（改價、折扣之前）*/
export function lineListTotal(line: RetailCartLine): number {
  const factor =
    line.isWeighed && line.weightKg != null && Number.isFinite(line.weightKg)
      ? Math.max(0, line.weightKg)
      : Math.max(0, num(line.quantity));
  return round2(num(line.unitPrice) * factor);
}

/** 改價後、未扣折扣嘅小計 */
export function lineGross(line: RetailCartLine): number {
  return round2(effectiveUnitPrice(line) * lineQuantityFactor(line));
}

/**
 * 單品折扣金額。
 * 次序：**先按折扣率、再加定額**，總額夾喺 `[0, gross]`（唔可以折到負數）。
 */
export function lineDiscountAmount(line: RetailCartLine): number {
  const gross = lineGross(line);
  let d = 0;
  const rate = line.lineDiscountRate;
  if (typeof rate === "number" && Number.isFinite(rate) && rate < 100) {
    d += discountAmountFromRate(gross, rate);
  }
  const fixed = line.lineDiscountAmount;
  if (typeof fixed === "number" && Number.isFinite(fixed) && fixed > 0) {
    d += fixed;
  }
  return Math.min(gross, round2(Math.max(0, d)));
}

/** 行實收（扣完單品折扣） */
export function lineNet(line: RetailCartLine): number {
  return round2(Math.max(0, lineGross(line) - lineDiscountAmount(line)));
}

/** 行總優惠 = 牌價小計 − 行實收（含改價 + 折扣） */
export function lineTotalSaving(line: RetailCartLine): number {
  return round2(Math.max(0, lineListTotal(line) - lineNet(line)));
}

/** 行有冇任何「人手調整」（改價 / 折扣）—— 出票同對帳要顯示，亦係權限閘嘅依據 */
export function lineHasManualAdjustment(line: RetailCartLine): boolean {
  return (
    (line.priceOverride != null && Number.isFinite(line.priceOverride)) ||
    (line.lineDiscountRate != null && line.lineDiscountRate < 100) ||
    (line.lineDiscountAmount != null && line.lineDiscountAmount > 0)
  );
}

/**
 * 整張零售單嘅金額**單一真源**。
 *
 * 次序：牌價 → 改價 → 逐行折扣 → 整單折扣 → 應收。
 * 同 `computeOrderTotals()`（餐飲）嘅分別：餐飲係「小計 + 稅 + 服務費」，
 * 零售冇服務費、改價同定額折係常態，所以另立一個唔好污染餐飲口徑。
 */
export function retailOrderTotals(
  lines: readonly RetailCartLine[],
  orderDiscount?: RetailDiscountRule,
): RetailOrderTotals {
  let listTotal = 0;
  let grossSubtotal = 0;
  let itemDiscount = 0;
  let quantity = 0;
  let weighedTotalKg = 0;

  for (const line of lines ?? []) {
    listTotal += lineListTotal(line);
    grossSubtotal += lineGross(line);
    itemDiscount += lineDiscountAmount(line);
    quantity += Math.max(0, num(line.quantity));
    if (line.isWeighed && line.weightKg != null && Number.isFinite(line.weightKg)) {
      weighedTotalKg += Math.max(0, line.weightKg);
    }
  }

  listTotal = round2(listTotal);
  grossSubtotal = round2(grossSubtotal);
  itemDiscount = round2(itemDiscount);
  const netSubtotal = round2(Math.max(0, grossSubtotal - itemDiscount));

  let orderDiscountAmount = 0;
  if (orderDiscount) {
    if (typeof orderDiscount.rate === "number" && Number.isFinite(orderDiscount.rate)) {
      orderDiscountAmount += discountAmountFromRate(netSubtotal, orderDiscount.rate);
    }
    if (typeof orderDiscount.amount === "number" && Number.isFinite(orderDiscount.amount)) {
      orderDiscountAmount += orderDiscount.amount;
    }
  }
  orderDiscountAmount = Math.min(netSubtotal, round2(Math.max(0, orderDiscountAmount)));
  const total = round2(netSubtotal - orderDiscountAmount);

  return {
    lineCount: (lines ?? []).length,
    quantity,
    weighedTotalKg: Math.round(weighedTotalKg * 1000) / 1000,
    listTotal,
    overrideSaving: round2(Math.max(0, listTotal - grossSubtotal)),
    grossSubtotal,
    itemDiscount,
    netSubtotal,
    orderDiscountAmount,
    total,
    totalSaving: round2(Math.max(0, listTotal - total)),
  };
}

/**
 * 折扣 / 改價係唔係「需要權限」。
 *
 * 零售舞弊高風險位：大額折扣、低於成本改價。
 * 純函式，唔知登入者係邊個 —— 判斷「呢次操作要唔要閘」就夠，權限查核由 caller 做。
 */
export function adjustmentRequiresApproval(
  line: RetailCartLine,
  opts: {
    /** 折扣率低於呢個數就要閘（例如 90 = 低於 9 折） */
    minDiscountRate?: number;
    /** 單品優惠金額超過呢個數就要閘 */
    maxLineSaving?: number;
    /** 成本價（有值時：改到低於成本一定閘） */
    cost?: number;
  } = {},
): boolean {
  const minRate = opts.minDiscountRate ?? 90;
  const maxSaving = opts.maxLineSaving ?? 50;

  if (line.priceOverride != null && Number.isFinite(line.priceOverride)) {
    if (opts.cost != null && Number.isFinite(opts.cost) && line.priceOverride < opts.cost) return true;
    return effectiveUnitPrice(line) < num(line.unitPrice) - 0.005;
  }
  if (line.lineDiscountRate != null && line.lineDiscountRate < minRate) return true;
  if (line.lineDiscountAmount != null && line.lineDiscountAmount > maxSaving) return true;
  return false;
}
