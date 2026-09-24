import { formatMoney } from "@/lib/format";
import { splitPlatformFees } from "@/lib/receipt/subtotal-block";
import type { PosOrder } from "@/lib/types";

/**
 * 外賣平台（澳覓 / MFOOD）費用明細 —— **唯讀**顯示，用喺訂單詳情／查看彈窗。
 *
 * ── 為什麼要有佢（2026-09-24 使用者反饋）────────────────────────────
 * 之前費用明細**只喺收據**出現（`buildSubtotalBlock`），訂單詳情完全冇 →
 * 使用者喺 POS 睇極都睇唔到「餐盒費／膠袋費／商家優惠／配送費」，
 * 以為插件冇推到（其實 DB 一直都正確）。所以詳情都要顯示。
 *
 * 🔴 資料來源同收據**共用** `splitPlatformFees()` —— 唔可以各自寫一套過濾／分組，
 *    否則兩邊遲早顯示唔同嘅數（同一個 bug 再出現一次）。
 *
 * ── 零影響 ─────────────────────────────────────────────────────────
 * 冇 `platformFees`（＝所有店內單、舊平台單）→ `return null`，
 * 完全唔會多一個 DOM node，版面同以前一模一樣。
 *
 * 注：呢組件純展示，冇 hook、冇 state，唔會 trigger 任何變更。
 */
export function PlatformFeeBreakdown({
  fees,
  currency,
}: {
  /** `order.platformFees`。冇 / 空 → 唔 render。 */
  fees?: PosOrder["platformFees"];
  currency: string;
}) {
  const { included, excluded } = splitPlatformFees(fees);
  if (included.length === 0 && excluded.length === 0) return null;

  /** 負數（商家承擔嘅優惠）統一用前置減號，同 `OrderDiscountRow` 嘅寫法一致。 */
  const money = (amount: number) =>
    amount < 0 ? `-${formatMoney(Math.abs(amount), currency)}` : formatMoney(amount, currency);

  return (
    <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-slate-600">平台費用明細</span>
        {/* 講清楚「呢幾行已經計入上面個總計」，否則店員會以為要另外加 */}
        <span className="text-[11px] text-slate-500">已計入總計（營業額）</span>
      </div>

      <div className="mt-1.5 grid gap-1">
        {included.map((fee) => (
          <div key={`inc-${fee.label}`} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words text-slate-500">{fee.label}</span>
            <span
              className={`shrink-0 tabular-nums font-semibold ${
                fee.amount < 0 ? "text-amber-700" : "text-slate-900"
              }`}
            >
              {money(fee.amount)}
            </span>
          </div>
        ))}
      </div>

      {/* 唔計入營業額嘅資訊行：另開一組並寫明，免得店員以為加總少咗一筆 */}
      {excluded.length > 0 ? (
        <div className="mt-2 border-t border-slate-200 pt-1.5">
          <div className="text-[11px] text-slate-400">以下不計入營業額（顧客支付）</div>
          <div className="mt-1 grid gap-1">
            {excluded.map((fee) => (
              <div key={`exc-${fee.label}`} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 break-words text-slate-400">{fee.label}</span>
                <span className="shrink-0 tabular-nums text-slate-400">{money(fee.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
