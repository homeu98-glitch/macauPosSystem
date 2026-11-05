"use client";

import { formatMoney } from "@/lib/format";
import { avosToMop } from "@/lib/ledger/member-types";
import type { RedeemByCodeResult } from "@/lib/ledger/rewards";

/**
 * 掃碼核銷成功動畫（2026-11-05）。
 *
 * CSS keyframes 放 `src/app/globals.css`（`pos-redeem-*`），
 * 全部支援 `prefers-reduced-motion`，唔會喺系統關閉動畫時照跳。
 *
 * 🔴 `customerPhone` 只喺呢次 render 顯示（遮罩後 4 位），
 *    唔寫 state／localStorage／log（契約 §7.2）。
 */
export function CouponRedeemSuccess({
  result,
  onDone,
}: {
  result: RedeemByCodeResult;
  onDone: () => void;
}) {
  const isMoneyVoucher = result.prizeType === "money_voucher" || result.rewardAmountAvos > 0;
  const amount = formatMoney(avosToMop(result.rewardAmountAvos));
  const maskedPhone = result.customerPhone
    ? `***${String(result.customerPhone).slice(-4)}`
    : null;

  const confetti = [
    { left: "8%", background: "#f97316", animationDelay: "0.05s" },
    { left: "18%", background: "#10b981", animationDelay: "0.35s" },
    { left: "30%", background: "#f59e0b", animationDelay: "0.15s" },
    { left: "42%", background: "#38bdf8", animationDelay: "0.55s" },
    { left: "54%", background: "#f97316", animationDelay: "0.25s" },
    { left: "66%", background: "#10b981", animationDelay: "0.45s" },
    { left: "78%", background: "#a78bfa", animationDelay: "0.10s" },
    { left: "90%", background: "#f59e0b", animationDelay: "0.65s" },
  ];

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center overflow-hidden bg-slate-950/60 px-4">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {confetti.map((piece, index) => (
          <i
            key={index}
            className="pos-redeem-confetti"
            style={piece}
          />
        ))}
      </div>

      <div className="pos-redeem-card relative z-10 w-full max-w-md rounded-3xl bg-white px-8 py-8 text-center shadow-2xl">
        <div className="pos-redeem-ring mx-auto grid h-24 w-24 place-items-center rounded-full border-[3px] border-emerald-200 bg-emerald-50">
          <svg className="h-14 w-14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              className="pos-redeem-check"
              d="M4 12.5 L9.5 18 L20 6.5"
              fill="none"
              stroke="#059669"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h2 className="pos-redeem-fade mt-5 text-2xl font-bold text-emerald-600">兌換成功</h2>
        <div className="pos-redeem-fade mt-3 text-base font-semibold text-slate-900">
          {result.title}
          {isMoneyVoucher ? ` · 現金券 ${amount}` : " · 禮品券"}
        </div>
        <div className="pos-redeem-fade mt-1 text-xs leading-relaxed text-slate-500">
          {maskedPhone ? `會員 ${maskedPhone}　` : null}
          已同步至 Ledger，券列表會自動更新
        </div>

        {isMoneyVoucher ? (
          <div className="pos-redeem-fade mt-5 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
            贈送餘額 + {amount}
          </div>
        ) : (
          <div className="pos-redeem-fade mt-5 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
            請現場將禮品交予客人
          </div>
        )}

        <button
          type="button"
          onClick={onDone}
          className="mt-6 h-11 w-full rounded-2xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          完成
        </button>
      </div>
    </div>
  );
}
