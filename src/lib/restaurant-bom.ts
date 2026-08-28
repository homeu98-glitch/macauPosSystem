// Phase B（模塊 1 / 2）：食材消耗精確化。
// 出餐時間之外，食材消耗需要「每款菜品用到咩食材、幾多」嘅配方（BOM）。
// 呢層用 localStorage 儲存 per-store 配方（離線優先，同 POS 其餘設定一致），
// 報表端用 BOM × 已售菜品份數 計出食材用量與成本，唔使喺落單時記錄。
// 真後端（Ledger menu_item_ingredients）到位後，只要將 loadBom / saveBom 換做 RPC 即可。

import { orderMatchesReportRange, type ReportRangeKey } from "@/lib/ledger/report-period";
import type { PosOrder } from "@/lib/types";

export interface BomIngredient {
  /** 食材名稱（例如「雞髀」「米」） */
  name: string;
  /** 每份菜品用量 */
  quantity: number;
  /** 單位（份 / g / ml / 隻 / 包 ...） */
  unit: string;
  /** 單位成本（MOP / unit），商家填寫或示例；用嚟計食材成本 */
  unitCost: number;
}

export interface BomEntry {
  menuItemId: string;
  ingredients: BomIngredient[];
}

export interface IngredientConsumptionRow {
  name: string;
  qty: number;
  unit: string;
  amount: number; // MOP
}

export interface IngredientConsumption {
  /** 食材成本總額（MOP） */
  totalAmount: number;
  /** 涉及嘅食材種類數 */
  kinds: number;
  rows: IngredientConsumptionRow[];
  /** 有冇設定過任何配方（false = 模塊顯示空白提示） */
  hasRecipes: boolean;
}

const BOM_PREFIX = "macau-pos-bom:";

export function bomKey(merchantId: string): string {
  return BOM_PREFIX + (merchantId || "default");
}

export function loadBom(merchantId: string): BomEntry[] {
  try {
    const raw = localStorage.getItem(bomKey(merchantId));
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as BomEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveBom(merchantId: string, entries: BomEntry[]): void {
  localStorage.setItem(bomKey(merchantId), JSON.stringify(entries));
}

/** 計某個範圍內、按 BOM × 已售份數 展開嘅食材消耗。 */
export function computeIngredientConsumption(
  orders: PosOrder[],
  predicate: (o: PosOrder) => boolean,
  bom: BomEntry[],
): IngredientConsumption {
  const bomMap = new Map(bom.map((b) => [b.menuItemId, b.ingredients]));
  const rowMap = new Map<string, IngredientConsumptionRow>();
  const hasRecipes = bom.length > 0;

  for (const o of orders) {
    if (o.status !== "settled" && o.status !== "partially_refunded" && o.status !== "refunded") continue;
    if (!predicate(o)) continue;
    for (const it of o.items) {
      if (it.voided) continue;
      const ings = bomMap.get(it.menuItemId);
      if (!ings || ings.length === 0) continue;
      for (const ing of ings) {
        const q = ing.quantity * it.quantity;
        const amt = q * ing.unitCost;
        const r = rowMap.get(ing.name) ?? { name: ing.name, qty: 0, unit: ing.unit, amount: 0 };
        r.qty += q;
        r.amount += amt;
        rowMap.set(ing.name, r);
      }
    }
  }

  const rows = Array.from(rowMap.values()).sort((a, b) => b.amount - a.amount);
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  return { totalAmount, kinds: rows.length, rows, hasRecipes };
}

/** 訂單所屬嘅澳門年月（YYYY-MM），用嚟計「本月」消耗。 */
export function orderMacauMonthKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "2-digit",
  }).format(new Date(iso));
}

export function inMacauMonth(o: PosOrder, ym: string): boolean {
  return orderMacauMonthKey(o.createdAt) === ym;
}

export function rangePredicate(range: ReportRangeKey): (o: PosOrder) => boolean {
  return (o) => orderMatchesReportRange(o, range);
}
