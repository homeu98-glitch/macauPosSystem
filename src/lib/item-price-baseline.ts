/**
 * 「庫存 › 品項分析」嘅**基準價 / 上漲金額**計算（零 import 純函式）。
 *
 * 🔴 為何獨立一個檔（唔塞入 `inventory-stats.ts`）：
 *    本專案 `npm test` 係 `node --test`，**唔識解析 `@/` alias**；
 *    `inventory-stats.ts` 有 `@/lib/ledger/...` import ⇒ 一 import 就爆。
 *    所以本體放喺呢個**零 import** 檔（同 `purchase-items.ts`、`inventory-order.ts` 同一套路），
 *    `inventory-stats.ts` 只做 re-export。
 *
 * ── J 2026-10-07 拍板口徑 ────────────────────────────────────────────
 * **基準價 ＝ 該品項「首次進貨紀錄」嘅單價**（歷史最早一筆 `receipt_items.unit_price`）。
 *   · 一經鎖定就**永不覆寫**：後續批次、更新後嘅加權價一律唔用。
 *   · 計算對象係「最新單價 vs 基準價」，**唔係**「最新 vs 上一次」。
 *   · 冇首次進貨紀錄 ⇒ `baselineUnitCost === null` ⇒ direction 固定 `"new"`，
 *     UI 標「首次記錄」並**排除喺漲跌統計之外**（唔可以當 0% 報，會渲染假零）。
 */

/** 一筆收據行（只取聚合需要嘅欄位；其餘用 index signature 放行）。 */
export type BaselineLineInput = {
  name: string;
  unit_price: number;
  [key: string]: unknown;
};

/** 一張收據（只需要 `receipt_date` 同 `items`）。 */
export type BaselineReceiptInput = {
  receipt_date: string | null;
  items: BaselineLineInput[];
  [key: string]: unknown;
};

/** 同一品項嘅「基準價」證據：首次見到嘅單價 + 生效日。 */
export type BaselinePick = {
  /** 首次進貨單價（MOP）。 */
  unitCost: number;
  /** 該筆收據嘅 `receipt_date`（YYYY-MM-DD）；收據冇日期時為 null。 */
  date: string | null;
};

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 日期字串可比較性：null 視為最舊（排最前），避免「冇日期嘅收據」永遠爭唔到基準。 */
function dateRank(date: string | null): number {
  if (!date) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * 「兩個候選基准，邊個更早？」——**共用規則**，令 `collectBaselines()`（查詢端）
 * 同 `syncFromReceipts()`（寫入端）嘅判斷**唔會漂移**。
 *
 * 規則：日期早者勝；日期相同則單價低者勝（保守，令漲幅偏細）；否則保留現有。
 * `unitPrice <= 0` 嘅候選**直接淘汰**（唔會贏）。
 *
 * @param current 已記錄嘅基準（`null` ＝ 尚未有）
 * @param candidate 新候選
 * @returns 應該寫入嘅值（同傳入其中一個 reference，或 null）
 */
export function pickEarlierBaseline(
  current: BaselinePick | null,
  candidate: BaselinePick,
): BaselinePick | null {
  if (!candidate || candidate.unitCost <= 0) return current;
  if (!current) return candidate;
  const a = dateRank(candidate.date);
  const b = dateRank(current.date);
  if (a < b) return candidate;
  if (a === b && candidate.unitCost < current.unitCost) return candidate;
  return current;
}

/**
 * 逐行掃描，收積每個品項嘅**首次進貨單價**。
 *
 * ── 挑「首次」嘅規則（次序刻意寫成可預測）────────────────────────
 * 1. `receipt_date` **較早**者勝出。
 * 2. 日期相同 ⇒ **單價較低**者勝出。
 *    ⚠️ 點解唔揀價高？因為基準價係「起點」，揀低 = 保守，
 *    令計出嚟嘅漲幅**偏細**，唔會誇大成嚟呃老闆加價。
 * 3. 單價都相同 ⇒ 保留先遇到嗰個（穩定、可重現）。
 *
 * ⚠️ `unit_price <= 0` 嘅行**唔可以**做基準（會令除零／負數漲幅）。
 *    照樣保留做「曾經出現過」嘅證據，唔會令基準變 null。
 */
export function collectBaselines(receipts: BaselineReceiptInput[]): Map<string, BaselinePick> {
  const out = new Map<string, BaselinePick>();
  for (const r of receipts ?? []) {
    for (const it of r?.items ?? []) {
      const rawName = typeof it?.name === "string" ? it.name.trim() : "";
      if (!rawName) continue;
      const key = rawName.toLowerCase();
      const unitCost = round2(toNumber(it.unit_price, 0));
      if (unitCost <= 0) continue; // 唔合格嘅單價唔做基準
      const next = pickEarlierBaseline(out.get(key) ?? null, { unitCost, date: r.receipt_date ?? null });
      if (next) out.set(key, next);
    }
  }
  return out;
}

/** 方向標記。同 `buildItemRows()` 嘅 `"up" | "down" | "same" | "new"` 對齊。 */
export type PriceDirection = "up" | "down" | "same" | "new";

/** 單一品項嘅漲跌分析結果。 */
export type PriceChange = {
  /** 最新單價（MOP，round2）。 */
  latestUnitCost: number;
  /** 基準價（MOP）；`null` ＝ 未有基準（首次記錄）。 */
  baselineUnitCost: number | null;
  /** 單價漲跌額（`latest − baseline`）；`null` ＝ 未有基準。 */
  deltaUnitCost: number | null;
  /** 漲跌幅 %（`delta ÷ baseline × 100`）；`null` ＝ 未有基準或基準為 0。 */
  changePercent: number | null;
  /** 受影響金額（`deltaUnitCost × currentQty`）；`null` ＝ 未有基準。 */
  changeAmount: number | null;
  direction: PriceDirection;
};

export type PriceChangeInput = {
  latestUnitCost: number;
  baselineUnitCost: number | null;
  currentQty: number;
};

/**
 * 計單一品項嘅漲跌。
 *
 * 🔴 分母保護：`baseline <= 0` 時 `changePercent` 回 `null`（唔會出 `Infinity`／`NaN`）。
 *    呢種情況同「未有基準」一樣處理（`direction: "new"`），因為兩個都**冇可比嘅起點**。
 */
export function computePriceChange(input: PriceChangeInput): PriceChange {
  const latest = round2(input.latestUnitCost);
  const qty = Number(input.currentQty) || 0;
  const base = input.baselineUnitCost === null || input.baselineUnitCost === undefined
    ? null
    : round2(input.baselineUnitCost);

  if (base === null || base <= 0) {
    return {
      latestUnitCost: latest,
      baselineUnitCost: base,
      deltaUnitCost: null,
      changePercent: null,
      changeAmount: null,
      direction: "new",
    };
  }

  const delta = round2(latest - base);
  const pct = (delta / base) * 100;
  return {
    latestUnitCost: latest,
    baselineUnitCost: base,
    deltaUnitCost: delta,
    changePercent: pct,
    changeAmount: round2(delta * qty),
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "same",
  };
}

/** 判定 `direction` 是否應該計入漲跌統計（「首次記錄」唔計）。 */
export function isComparable(direction: PriceDirection): boolean {
  return direction === "up" || direction === "down" || direction === "same";
}

/** 摘要用嘅加總。`new` 品項嘅金額一律唔加（避免渲染假零）。 */
export type PriceChangeSummary = {
  up: number;
  down: number;
  same: number;
  newItems: number;
  /** Σ 漲價品項嘅 `changeAmount`（只加正數，即真係推高成本嗰批）。 */
  totalUpAmount: number;
  /** Σ 跌價品項嘅 `changeAmount`（負數）。 */
  totalDownAmount: number;
};

export function summarizePriceChanges(rows: PriceChange[]): PriceChangeSummary {
  const out: PriceChangeSummary = {
    up: 0, down: 0, same: 0, newItems: 0, totalUpAmount: 0, totalDownAmount: 0,
  };
  for (const r of rows ?? []) {
    if (r.direction === "new") { out.newItems += 1; continue; }
    if (r.direction === "up") out.up += 1;
    else if (r.direction === "down") out.down += 1;
    else out.same += 1;
    const amt = r.changeAmount ?? 0;
    if (amt > 0) out.totalUpAmount = round2(out.totalUpAmount + amt);
    else if (amt < 0) out.totalDownAmount = round2(out.totalDownAmount + amt);
  }
  return out;
}
