import { formatMoney } from "@/lib/format";
import { actualPayout, type PlatformSettlementAmounts } from "@/lib/pos/platform-settlement";
import type { PosOrder } from "@/lib/types";

/**
 * 外賣平台（澳覓 / MFOOD）**實收**明細 —— **唯讀**顯示，用喺訂單詳情／查看彈窗。
 *
 * ── 為什麼要有佢（2026-09-26 使用者需求）────────────────────────────
 * POS 記錄嘅「總計」係**營業額**（客付，例 62.00），
 * 但商家真正落袋嘅係**平台扣費後**過數嘅錢（例 31.91）。
 * 兩個數本來就唔同，差額就係平台抽成 —— 唔係漏數。
 * 之前只顯示營業額，商家睇唔到「呢張單平台到底畀我幾錢」。
 *
 * ── 🔴 「待對帳」而唔係「0.00」──────────────────────────────────────
 * 平台帳期通常 T+1 至帳期結束才結算。未對帳時**唔可以**顯示 `MOP 0.00`：
 * 店員會以為平台冇畀錢 → 去追平台數。
 * 所以未對帳一律顯示「待平台對帳」＋一句解釋。
 *
 * ── 零影響 ─────────────────────────────────────────────────────────
 * 冇任何結算欄位（＝所有店內單、線上單、未對帳嘅平台單）→ `return null`，
 * 完全唔會多一個 DOM node，版面同以前一模一樣。
 *
 * 注：呢組件純展示，冇 hook、冇 state，唔會 trigger 任何變更。
 */
export function PlatformSettlementBreakdown({
  order,
  currency,
}: {
  /** 直接傳成張單（要讀三個結算欄位 + total 做對比）。 */
  order: Pick<
    PosOrder,
    "total" | "platformNetAmount" | "platformSubsidyNet" | "platformSettledAt" | "externalOrderId"
  >;
  currency: string;
}) {
  const settlement: PlatformSettlementAmounts = {
    netAmount: order.platformNetAmount ?? null,
    subsidyNet: order.platformSubsidyNet ?? null,
  };
  const payout = actualPayout(settlement);

  // ── 未對帳：只有在「知道呢張係平台單」時才顯示（見下面呼叫端 filter）。
  //    呢度用 `platformSettledAt` 有冇值分辨。
  const settled = Boolean(order.platformSettledAt) && payout !== null;

  // ── 平台單號（2026-09-26 使用者需求：「每張訂單都有訂單號，應能對應平時接單
  //    時的訂單號」）。店員要攞住佢去平台後台／財務頁對數。
  //    ⚠️ 同結算金額無關 —— 未對帳時一樣要顯示（正因為未對帳才更需要去對）。
  //    `select-all` 方便一鍵複製去平台搜尋。
  const platformNo = order.externalOrderId?.trim() ? order.externalOrderId.trim() : null;
  const platformNoRow = platformNo ? (
    <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-current/15 pt-1.5">
      <span className="text-[11px] opacity-80">平台單號</span>
      <span className="select-all break-all text-xs font-semibold tabular-nums">{platformNo}</span>
    </div>
  ) : null;

  if (!settled) {
    return (
      <div className="mt-2 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-amber-800">平台實收</span>
          <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
            待對帳
          </span>
        </div>
        <div className="mt-1.5 text-sm font-semibold text-amber-800">待平台對帳</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-amber-700">
          平台帳期結束後自動補上（通常 T+1）。上面「總計」係營業額（客付），
          平台費未扣 —— 兩個數唔同係正常，唔係漏數。
        </div>
        {platformNoRow}
      </div>
    );
  }

  // 補貼金額（有補貼先顯示，避免多一行 0）。
  const fee = order.platformNetAmount ?? null;
  const subsidy = order.platformSubsidyNet ?? null;
  const subsidyDiff = fee !== null && subsidy !== null ? fee - subsidy : 0;

  return (
    <div className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-emerald-800">平台實收</span>
        <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">
          已對帳
        </span>
      </div>

      <div className="mt-1.5 grid gap-1">
        {fee !== null && subsidy !== null && subsidyDiff !== 0 ? (
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words text-emerald-700">平台服務費後</span>
            <span className="shrink-0 tabular-nums font-semibold text-emerald-900">
              {formatMoney(fee, currency)}
            </span>
          </div>
        ) : null}
        {fee !== null && subsidy !== null && subsidyDiff !== 0 ? (
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words text-emerald-700">
              平台補貼
              <span className="ml-1 text-[11px] text-emerald-600">（已計入到帳）</span>
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-emerald-900">
              − {formatMoney(subsidyDiff, currency)}
            </span>
          </div>
        ) : null}
        <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-emerald-200 pt-1.5">
          <span className="text-sm font-semibold text-emerald-800">實際到帳</span>
          <span className="text-base font-bold tabular-nums text-emerald-800">
            {formatMoney(payout, currency)}
          </span>
        </div>
      </div>

      <div className="mt-1.5 text-[11px] leading-relaxed text-emerald-700">
        上面「總計」{formatMoney(order.total, currency)} 係營業額（客付）；
        呢度係平台扣費後過數畀你嘅錢。差額
        {formatMoney(Math.max(0, order.total - payout), currency)} 為平台抽成。
      </div>
      {platformNoRow}
    </div>
  );
}
