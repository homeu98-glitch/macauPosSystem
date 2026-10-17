/**
 * 買貨多幣值顯示共用元件（2026-10-17 J 拍板）。
 *
 * 背景：庫存收據各自帶一個幣值（MOP／HKD／RMB…），系統**唔設匯率** ⇒
 * 係咩幣值顯示咩幣值，唔同幣值**永遠唔可以加埋**做一個數。
 *
 * 使用方：報表頁（restaurant-daily-report.tsx）＋ 交班頁（shift-page.tsx），
 * 兩邊口徑必須一致，所以收喺同一處。純函式喺 `@/lib/purchase-currency`。
 */
import { useT } from "@/components/lang-provider";
import { formatMoneyValue } from "@/lib/format";
import { currencyTextClass, sortedCurrencyEntries } from "@/lib/purchase-currency";

export {
  currencyTextClass,
  currencyBgClass,
  sortedCurrencyEntries,
  currencyTotalForSort,
  pickCurrencyField,
  formatCurrencyAmount,
  currencyEntriesText,
} from "@/lib/purchase-currency";

/** KPI 用：最大幣值做大數，其餘以「另有 …」副線逐幣值列出。 */
export function MoneyByCurrency({ byCurrency }: { byCurrency?: Record<string, number> }) {
  const t = useT();
  const entries = sortedCurrencyEntries(byCurrency);
  if (entries.length === 0) {
    return (
      <span className="tabular-nums">
        <span className="mr-1 align-baseline text-sm font-medium text-slate-400">MOP</span>0
      </span>
    );
  }
  const [cur, amt] = entries[0];
  return (
    <>
      <span className="tabular-nums">
        <span className="mr-1 align-baseline text-sm font-medium text-slate-400">{cur}</span>
        {Math.round(amt).toLocaleString("en-US")}
      </span>
      {entries.length > 1 ? (
        <div className="mt-0.5 text-[11px] font-medium tabular-nums text-slate-500">
          {t("另有")}
          {" "}
          {entries.slice(1).map(([c, v], i) => (
            <span key={c}>
              {i > 0 ? " · " : ""}
              <span className={`font-bold ${currencyTextClass(c)}`}>{c}</span> {formatMoneyValue(v)}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** 表格格／彈窗合計：逐幣值金額，每幣值一行（單幣值時就單行，同以前一樣）。 */
export function CurrencyLines({ byCurrency }: { byCurrency?: Record<string, number> }) {
  const entries = sortedCurrencyEntries(byCurrency);
  if (entries.length === 0) return <span className="text-slate-300">—</span>;
  return (
    <>
      {entries.map(([c, v]) => (
        <span key={c} className="block whitespace-nowrap">
          <span className={`mr-1 text-[11px] font-bold ${currencyTextClass(c)}`}>{c}</span>
          {formatMoneyValue(v)}
        </span>
      ))}
    </>
  );
}

/** 表格明細列：逐幣值金額行內串接（`MOP 285.81 · HKD 88.00`）。 */
export function CurrencyInline({ byCurrency }: { byCurrency?: Record<string, number> }) {
  const entries = sortedCurrencyEntries(byCurrency);
  if (entries.length === 0) return <span className="text-slate-300">—</span>;
  return (
    <>
      {entries.map(([c, v], i) => (
        <span key={c} className="whitespace-nowrap">
          {i > 0 ? " · " : ""}
          <span className={`mr-1 text-[11px] font-bold ${currencyTextClass(c)}`}>{c}</span>
          {formatMoneyValue(v)}
        </span>
      ))}
    </>
  );
}
