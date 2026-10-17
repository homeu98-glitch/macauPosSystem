/**
 * 買貨多幣值 —— 共用純函式（2026-10-17 J 拍板）。
 *
 * 背景：庫存收據各自帶一個幣值（MOP／HKD／RMB…），系統**唔設匯率** ⇒
 * 係咩幣值顯示咩幣值，唔同幣值**永遠唔可以加埋**做一個數。
 *
 * 使用者：
 * · `components/purchase-currency-display.tsx`（報表頁／交班頁共用元件）
 * · `lib/escpos-template.ts`（交班紙打印）
 * 兩邊口徑必須一致，所以純函式收喺同一處。
 *
 * 數據形態：`Record<string, number>`（key = 幣值碼），例如 `{ MOP: 437.81, RMB: 85.2 }`；
 * `summary.byCurrency`（每幣值 { total/paid/unpaid/count }）經
 * {@link pickCurrencyField} 轉成呢個形態。
 */
import { formatMoneyValue } from "@/lib/format";
import type { PurchaseSummary } from "@/lib/inventory-stats";

/** 幣值碼著色（純識別用，唔影響數值）：MOP 深灰、HKD 琥珀、RMB 玫紅、其他靛藍。 */
export function currencyTextClass(cur: string): string {
  if (cur === "MOP") return "text-slate-600";
  if (cur === "HKD") return "text-amber-700";
  if (cur === "RMB") return "text-rose-700";
  return "text-indigo-700";
}

/** 柱狀圖堆疊色（同 {@link currencyTextClass} 視覺對應）。 */
export function currencyBgClass(cur: string): string {
  if (cur === "MOP") return "bg-sky-600";
  if (cur === "HKD") return "bg-amber-600";
  if (cur === "RMB") return "bg-rose-600";
  return "bg-teal-700";
}

/** 逐幣值項目，按金額大→小排（並列按幣值碼，穩定可重現）；濾走 0 值。 */
export function sortedCurrencyEntries(byCurrency?: Record<string, number>): Array<[string, number]> {
  return Object.entries(byCurrency ?? {})
    .filter(([, v]) => Number(v) !== 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** 逐幣值合計（只用於排序鍵／柱高；跨幣值加數本身無意義，只作穩定顯示次序）。 */
export function currencyTotalForSort(byCurrency?: Record<string, number>): number {
  return sortedCurrencyEntries(byCurrency).reduce((a, [, v]) => a + v, 0);
}

/**
 * 由 `summary.byCurrency`（每幣值 { total/paid/unpaid/count }）取出某口径嘅
 * 逐幣值金額 map，供 KPI 三格渲染（買貨總額／已付／未付）。
 */
export function pickCurrencyField(
  byCurrency: PurchaseSummary["byCurrency"] | undefined,
  field: "total" | "paid" | "unpaid",
): Record<string, number> | undefined {
  if (!byCurrency) return undefined;
  const out: Record<string, number> = {};
  for (const [cur, b] of Object.entries(byCurrency)) {
    if (b && b[field]) out[cur] = b[field];
  }
  return out;
}

/** 單個「幣值＋金額」字串（打印／純文字用）：`MOP 437.81`。 */
export function formatCurrencyAmount(cur: string, amount: number): string {
  return `${cur} ${formatMoneyValue(amount)}`;
}

/** 逐幣值字串（打印用）：`MOP 437.81 + HKD 88.00`；空 ⇒ ""。 */
export function currencyEntriesText(byCurrency?: Record<string, number>): string {
  return sortedCurrencyEntries(byCurrency)
    .map(([c, v]) => formatCurrencyAmount(c, v))
    .join(" + ");
}
