/**
 * 外賣平台**結算（實收）**計算與配對規則 —— 純函式，零 import。
 *
 * ── 為什麼要有呢支（2026-09-26 使用者需求）────────────────────────────
 * POS 記錄嘅「營業額」係**客付**金額（例 62.00），
 * 但商家真正落袋嘅係**平台扣費後**過數嘅錢（例 31.91）。
 * 兩個數唔同，差額就係平台抽成 —— 商家最想知嘅正正係呢個比例。
 *
 * 資料來源：mfood 財務頁 transaction detail
 *   （`/merchants/summarys/summary/_get-order-summary-list`）
 *   · `tradeNo`                 平台訂單號 ＝ `pos_orders.external_order_id`
 *   · `storeBusinessAmtn`       營業額
 *   · `storeReceiveAmtn`        實收（扣平台服務費後）
 *   · `subsidyStoreReceiveAmtn` 補貼後實收（＝實際到帳）
 *
 * ── 零 import ────────────────────────────────────────────────────
 * 同 `platform-order.ts` / `pos-order-row.ts` 同一理由：保持零 import 先可以被
 * `node --test` 直接載入驗證（TS 型別寫 inline，唔靠外部 module）。
 */

/** 結算金額嘅最小欄位集（收 `unknown` 方便單測同避免 type cast）。 */
export interface PlatformSettlementAmounts {
  /** 平台實收（扣平台服務費後）＝ mfood `storeReceiveAmtn`。 */
  netAmount?: number | null;
  /** 補貼後實收（＝實際到帳）＝ mfood `subsidyStoreReceiveAmtn`。 */
  subsidyNet?: number | null;
}

/** 一筆平台 transaction（由 grabber 推入）。 */
export interface PlatformSettlementTxn {
  /** 平台訂單號 ＝ `pos_orders.external_order_id`。空 / 缺 → 無法配對。 */
  externalOrderId?: string | null;
  /** 平台實收（扣費後）。 */
  netAmount?: number | null;
  /** 補貼後實收（實際到帳）。 */
  subsidyNet?: number | null;
  /** 平台訂單營業額（只作核對用，唔寫入 POS）。 */
  businessAmount?: number | null;
  /** 平台服務費（只作核對用）。 */
  serviceFee?: number | null;
}

/** 配對／加總後，單一 POS 訂單嘅結算結果。 */
export interface PlatformSettlementForOrder {
  /** 平台實收合計（多筆 transaction 加總）。 */
  netAmount: number;
  /** 補貼後實收合計。 */
  subsidyNet: number;
  /** 加總用咗幾多筆 transaction（審計／UI 提示「N 筆」）。 */
  txnCount: number;
}

/** 一位小數都唔可以漏 —— 金額一律四捨五入到 2 位（避免 0.1+0.2 類誤差入庫）。 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 安全轉數：`null` / `undefined` / `""` / `NaN` / 非數字 → `null`（唔會當 0）。 */
export function toAmountOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 正規化平台訂單號（去前後空白；空字串 → `null`）。 */
export function normalizeTradeNo(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * 一批 transaction 按 `tradeNo` 分組加總。
 *
 * ── 為什麼要分組加總（而唔係一單對一筆）──────────────────────────────
 * 同一個平台訂單號可能對應**多筆** transaction（拆單、部分退款、補貼分開入帳）。
 * 只取其中一筆會令實收靜默偏少 —— 而且金額係「有值但少咗」，睇落完全唔似 bug。
 * ⇒ 一律加總。
 *
 * 冇 `tradeNo` 嘅 transaction（配對唔到任何訂單）**唔會**出現在結果 map 裡面，
 * 但會喺 `unmatchedCount` 計數，令 UI 可以顯示「有 N 筆未配對」（唔好靜默掉數）。
 *
 * ⚠️ 兩個金額**獨立**判斷「有冇值」：
 *    某筆只有 `netAmount`、另一筆只有 `subsidyNet` 係有可能嘅（平台資料形態），
 *    所以唔可以「兩個都冇才當 0」。只要有任何一筆有值，該欄就有值。
 */
export function groupSettlementByOrder(txns: readonly PlatformSettlementTxn[]): {
  /** key = 正規化後嘅 `tradeNo`。 */
  byOrder: Map<string, PlatformSettlementForOrder>;
  /** 冇 `tradeNo`（無法配對）嘅 transaction 筆數。 */
  unmatchedCount: number;
} {
  const byOrder = new Map<string, PlatformSettlementForOrder>();
  let unmatchedCount = 0;

  for (const txn of txns ?? []) {
    const key = normalizeTradeNo(txn?.externalOrderId);
    if (!key) {
      unmatchedCount += 1;
      continue;
    }

    const net = toAmountOrNull(txn?.netAmount);
    const sub = toAmountOrNull(txn?.subsidyNet);

    const cur =
      byOrder.get(key) ?? { netAmount: 0, subsidyNet: 0, txnCount: 0 };

    // 只有「本身有值」才加 —— 否則 `null` 會被當 0 混入（而 0 同「冇資料」唔同）。
    cur.netAmount = round2(cur.netAmount + (net ?? 0));
    cur.subsidyNet = round2(cur.subsidyNet + (sub ?? 0));
    cur.txnCount += 1;

    byOrder.set(key, cur);
  }

  return { byOrder, unmatchedCount };
}

/**
 * 單一訂單嘅結算結果（冇配對到 → `null`）。
 * `null` 嘅意思係「**待對帳**」，唔係「0」。
 */
export function settlementForOrder(
  byOrder: ReadonlyMap<string, PlatformSettlementForOrder>,
  externalOrderId: unknown,
): PlatformSettlementForOrder | null {
  const key = normalizeTradeNo(externalOrderId);
  if (!key) return null;
  return byOrder.get(key) ?? null;
}

// ============================================================================
// 帳期級結算（2026-09-28 新增）—— 報表三格嘅**保底**來源
// ============================================================================

/**
 * 平台帳期級金額（由插件抓平台財務頁帳期列表得嚟）。
 *
 * ── 為什麼要另設一層（真機實證）────────────────────────────────────
 * 逐單口徑（`PlatformSettlementTxn`）要靠 `tradeNo` 配 `external_order_id`，
 * 但**實測配對唔上** ⇒ 全部 `notFound` ⇒ 報表三格永遠「待對帳」。
 * 而平台頁面**一載入就已經有**帳期級金額（`_list` 回應自帶）。
 * ⇒ 逐單配唔上唔應該拖死整件事：帳期數字一定有，報表就用佢。
 *
 * ⚠️ 帳期口徑同逐單口徑**唔可以相加**（帳期含平台側雜項、期間亦可能唔對齊）。
 */
export interface PlatformPeriodAmounts {
  /** 帳期識別（日期區間字串，例 `"2026-09-16 ~ 2026-09-30"`）。空 → 唔可以入庫。 */
  period?: string | null;
  /** 應收＝平台側營業額。 */
  should?: number | null;
  /** 實收＝扣平台服務費後。 */
  receive?: number | null;
  /** 補貼後實收＝實際到帳。 */
  subsidy?: number | null;
  /** 平台服務費（核對用）。 */
  fee?: number | null;
}

/** 正規化後嘅帳期金額（可以直接 upsert 落 DB）。 */
export interface NormalizedPeriodAmounts {
  period: string;
  should: number | null;
  receive: number | null;
  subsidy: number | null;
  fee: number | null;
}

/**
 * 正規化插件送嚟嘅 `periodAmounts`。
 *
 * @returns `null` ＝ 唔可用（冇 period、或者三個金額全部冇值）——
 *          呼叫端**唔應該**寫一筆空帳期落 DB。
 *
 * 🔴 全 `null` 唔可以寫成 0：報表睇到 0 會以為「平台一毫都冇畀」而去追數。
 * 🔴 `period` 一定要有：佢係唯一鍵一部分，冇咗就分唔清係邊個帳期
 *    （重抓時會互相覆蓋，變成永遠只有一筆）。
 */
export function normalizePeriodAmounts(
  raw: unknown,
): NormalizedPeriodAmounts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const period = typeof r.period === "string" ? r.period.trim() : "";
  if (!period) return null;

  const should = toAmountOrNull(r.should);
  const receive = toAmountOrNull(r.receive);
  const subsidy = toAmountOrNull(r.subsidy);
  const fee = toAmountOrNull(r.fee);

  // 一個金額都冇 → 唔寫（避免落一筆全 NULL 嘅帳期，之後睇落似「已對帳」）
  if (should === null && receive === null && subsidy === null) return null;

  return { period, should, receive, subsidy, fee };
}

/**
 * 「帳期實際到帳」口徑：補貼後優先，否則落返實收。
 * @returns `null` ＝ 兩者都冇（待對帳）。
 */
export function periodPayout(
  p: PlatformPeriodAmounts | null | undefined,
): number | null {
  if (!p) return null;
  const sub = toAmountOrNull(p.subsidy);
  if (sub !== null) return sub;
  return toAmountOrNull(p.receive);
}

/**
 * 「實際到帳」口徑：有 `subsidyNet` 用佢，否則落返 `netAmount`。
 *
 * ── 為什麼補貼後優先 ────────────────────────────────────────────────
 * 使用者（2026-09-26 確認稿）要嘅係「平台真係過數畀我嘅錢」。
 * `storeReceiveAmtn` 係扣平台服務費後，但**未計平台補貼**；
 * `subsidyStoreReceiveAmtn` 才係最終入帳。冇補貼時兩者相等（落返 net 即可）。
 *
 * @returns `null` = 兩者都冇（待對帳）。
 */
export function actualPayout(
  settlement: PlatformSettlementAmounts | null | undefined,
): number | null {
  if (!settlement) return null;
  const sub = toAmountOrNull(settlement.subsidyNet);
  if (sub !== null) return sub;
  return toAmountOrNull(settlement.netAmount);
}

/** 報表 MFOOD 區塊嘅三格數據。 */
export interface MfoodTotals {
  /** 應收金額＝所有 MFOOD 訂單營業額總和（POS 即時有）。 */
  receivable: number;
  /**
   * 實收金額＝已抓到嘅平台實收總和。
   * `null` ＝**完全冇**任何一張對到帳（UI 顯示「待對帳」）。
   */
  received: number | null;
  /** 已對到帳嘅單數。 */
  settledCount: number;
  /** 屬 MFOOD 但未對到帳嘅單數（> 0 時 UI 要標示「部分未對帳」）。 */
  pendingCount: number;
  /**
   * 差額率（＝平台抽成比例）＝ `1 − 實收 ÷ 應收`（0~1）。
   * `null` ＝ 冇實收 或 應收為 0 → 計唔到。
   */
  feeRate: number | null;
}

/**
 * 報表用嘅訂單最小介面：只要有「營業額」同一個配對用嘅識別碼。
 *
 * ⚠️ 唔綁死 `PosOrder` —— 呼叫端通常係「已 filter 嘅平台單」，
 *    可能係 `PosOrder`／投影單／任何有 `total` + `externalOrderId` 嘅物件。
 */
export interface SettlementOrderLike {
  /** 營業額（＝ POS 記錄嘅客付金額）。 */
  total?: number | null;
  /** 平台訂單號（＝ `pos_orders.external_order_id`）。配對結算資料用。 */
  externalOrderId?: string | null;
}

/**
 * 由訂單清單計算 MFOOD 區塊三格。
 *
 * ── 口徑（使用者 2026-09-26 原話）──────────────────────────────────
 *   「第三格為實收與營業額的差額率，例如營業額 100、實收 50 即 50%，
 *     用以反映平台收取的費率。」
 *   ⇒ `feeRate = 1 − 實收 ÷ 應收`（應收 100、實收 50 → 0.5 → 顯示 50%）。
 *
 * ── 🔴 部分對帳嘅處理（最容易出錯嘅位）──────────────────────────────
 * 若 10 張單只有 6 張對到帳，**唔可以**直接用 `實收 ÷ 全部應收` 計差額率 ——
 * 分子只計咗 6 張、分母係 10 張，得出嘅比率會被「未對帳」拉低，
 * 睇落好似平台抽成特別高。正確做法：**分子分母都只計已對帳嗰批**，
 * 另用 `pendingCount` 標示「仲有 N 張未對帳」。
 *
 * @param orders 只傳**平台單**（呼叫端已 filter），每筆要有 `total`（營業額）。
 * @param settlementOf 由訂單取得其結算結果（`null` ＝ 未對帳）。
 */
export function computeMfoodTotals<T extends SettlementOrderLike>(
  orders: readonly T[],
  settlementOf: (order: T) => PlatformSettlementAmounts | null | undefined,
): MfoodTotals {
  let receivable = 0;
  let settledReceivable = 0;
  let received = 0;
  let settledCount = 0;
  let pendingCount = 0;

  for (const order of orders ?? []) {
    const gross = toAmountOrNull(order?.total) ?? 0;
    receivable = round2(receivable + gross);

    const payout = actualPayout(settlementOf(order));
    if (payout === null) {
      pendingCount += 1;
      continue;
    }

    settledCount += 1;
    settledReceivable = round2(settledReceivable + gross);
    received = round2(received + payout);
  }

  // 冇任何一張對到帳 → received 用 null（唔用 0）＋ 差額率計唔到。
  const receivedOrNull = settledCount > 0 ? received : null;

  // 🔴 分子分母同一批（settledReceivable，唔係 receivable）。
  const feeRate =
    receivedOrNull === null || settledReceivable <= 0
      ? null
      : Math.max(0, Math.min(1, 1 - receivedOrNull / settledReceivable));

  return {
    receivable,
    received: receivedOrNull,
    settledCount,
    pendingCount,
    feeRate,
  };
}

// ============================================================================
// 報表三格：逐單 ＋ 帳期級 兩級口徑合併
// ============================================================================

/**
 * 報表三格最終結果（連口徑標示）。
 *
 * `basis` 係**必要**嘅：兩種口徑嘅數字唔同，UI 唔講清楚用邊個，
 * 商家見到今日 1803、聽日 1850 會以為報表有 bug。
 */
export interface SettlementTotals {
  /** 應收金額。 */
  receivable: number;
  /** 實收金額；`null` ＝ 完全冇數（UI 顯示「待對帳」）。 */
  received: number | null;
  /** 差額率 ＝ `1 − 實收 ÷ 對應應收`；`null` ＝ 計唔到。 */
  feeRate: number | null;
  /**
   * 口徑：
   *   `"per-order"` → 全部用逐單加總（最準，但有未對帳單）
   *   `"period"`    → 用帳期金額（**唔受逐單配對成敗影響**）
   *   `"none"`      → 兩者都冇（顯示「待對帳」）
   */
  basis: "per-order" | "period" | "none";
  /** 逐單口徑下屬平台但未對帳嘅單數。 */
  pendingCount: number;
  /** 逐單口徑下已對到帳嘅單數（帳期口徑時仍會帶出，供 UI 顯示「逐單仲有 N 張未對帳」）。 */
  settledCount: number;
  /** 帳期口徑下嘅帳期標示（UI 顯示「帳期 2026-09-16 ~ 09-30」）。 */
  periodLabel: string | null;
  /**
   * 🔴 是否用咗帳期口徑 —— 即「逐單有數但**未齊**」而改用帳期。
   * UI 要藉此顯示「明細仲有 N 張未對帳」嘅提示，唔好靜默換口徑。
   */
  usedPeriodFallback: boolean;
}

/**
 * 報表 MFOOD 區塊三格 —— 逐單優先，唔齊就落帳期。
 *
 * ── 🔴 為什麼要落帳期（2026-09-28 真機實證）────────────────────────
 * 逐單口徑要靠 `tradeNo` ↔ `external_order_id` 配對，**實測配對唔上**
 * （平台 transaction 號同 POS 記錄嘅平台單號唔一致）⇒ `received` 永遠 `null`
 * ⇒ 商家永遠見唔到實收。而帳期金額平台**一定**有（頁面自帶）。
 * ⇒ 逐單配唔上唔應該令報表三格變「待對帳」。
 *
 * ── 何時用邊個（次序）──────────────────────────────────────────────
 *   ① 逐單對齊（`pendingCount === 0` 且 `settledCount > 0`）→ 用逐單
 *   ② 否則（完全冇 / 只有部分對到帳）而**有帳期金額** → 用帳期
 *   ③ 兩者都冇 → `basis: "none"`，`received: null`
 *
 * ⚠️ **唔可以**逐單實收 ＋ 帳期實收相加 —— 帳期本身已包含嗰批單，
 *    相加 = 雙計（2026-09-14 線上/線下雙計同類事故）。
 *
 * @param orders 只傳**平台單**（呼叫端已 filter 過）。
 * @param settlementOf 由訂單取逐單結算結果（`null` ＝ 未對帳）。
 * @param periodAmounts 帳期金額（插件已寫落 DB 嗰筆）；冇 → 傳 `null`。
 */
export function computeSettlementTotals<T extends SettlementOrderLike>(
  orders: readonly T[],
  settlementOf: (order: T) => PlatformSettlementAmounts | null | undefined,
  periodAmounts?: PlatformPeriodAmounts | null,
): SettlementTotals {
  const perOrder = computeMfoodTotals(orders, settlementOf);
  const period = normalizePeriodAmounts(periodAmounts ?? null);

  const periodPayoutValue = periodPayout(period);
  const periodShould = period ? period.should : null;

  // 帳期口徑要計得出差額率：應收同實收**都**要有值
  const periodUsable = periodPayoutValue !== null && periodShould !== null && periodShould > 0;

  // ① 逐單完全對齊 → 用逐單（最準）
  if (perOrder.settledCount > 0 && perOrder.pendingCount === 0) {
    return {
      receivable: perOrder.receivable,
      received: perOrder.received,
      feeRate: perOrder.feeRate,
      basis: "per-order",
      pendingCount: 0,
      settledCount: perOrder.settledCount,
      periodLabel: null,
      usedPeriodFallback: false,
    };
  }

  // ② 逐單唔齊（或者完全冇）→ 有帳期就落帳期
  if (periodUsable) {
    const received = round2(periodPayoutValue);
    const receivable = round2(periodShould);
    return {
      receivable,
      received,
      feeRate: Math.max(0, Math.min(1, 1 - received / receivable)),
      basis: "period",
      pendingCount: perOrder.pendingCount,
      settledCount: perOrder.settledCount,
      periodLabel: period ? period.period : null,
      // 逐單有對到帳但唔齊 → 標示「換咗口徑」，UI 要提示
      usedPeriodFallback: perOrder.settledCount > 0,
    };
  }

  // ③ 兩者都冇
  return {
    receivable: perOrder.receivable,
    received: perOrder.received,
    feeRate: perOrder.feeRate,
    basis: "none",
    pendingCount: perOrder.pendingCount,
    settledCount: perOrder.settledCount,
    periodLabel: period ? period.period : null,
    usedPeriodFallback: false,
  };
}
