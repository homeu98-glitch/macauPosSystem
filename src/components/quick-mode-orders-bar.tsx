"use client";

import { QuickLocalOrdersStrip } from "@/components/quick-local-orders-strip";
import { QuickOnlineOrdersPanel } from "@/components/quick-online-orders-panel";
import { POS_ACTION_BAR_LOCAL_MINUTES } from "@/lib/pos-order-filters";
import { PosOrder } from "@/lib/types";

type QuickModeOrdersBarProps = {
  currency: string;
  autoAcceptOnline: boolean;
  onAutoAcceptOnlineChange: (next: boolean) => void;
  onOnlineToast: (payload: { tone: "success" | "info" | "error"; message: string }) => void;
  preparingOrders: PosOrder[];
  waitingOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  onReturnPreparing: (orderId: string) => void;
};

export function QuickModeOrdersBar({
  currency,
  autoAcceptOnline,
  onAutoAcceptOnlineChange,
  onOnlineToast,
  preparingOrders,
  waitingOrders,
  completionLabel,
  completeLabel,
  onViewOrder,
  onMarkReady,
  onMarkCompleted,
  onReturnPreparing,
}: QuickModeOrdersBarProps) {
  return (
    <div className="shrink-0 border-t border-slate-200 bg-white shadow-[0_-4px_20px_rgba(15,23,42,0.06)]">
      <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線上訂單</div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-slate-500">自動接單</span>
              <button
                className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                  autoAcceptOnline ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"
                }`}
                onClick={() => onAutoAcceptOnlineChange(!autoAcceptOnline)}
                type="button"
              >
                {autoAcceptOnline ? "開" : "關"}
              </button>
            </div>
          </div>
          <QuickOnlineOrdersPanel
            autoAccept={autoAcceptOnline}
            currency={currency}
            layout="strip"
            onToast={onOnlineToast}
            showAutoAcceptControls={false}
            skipTableAssignment
          />
        </section>
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">線下訂單</div>
            <div className="mt-0.5 text-[10px] font-medium text-slate-400">
              僅顯示近 {POS_ACTION_BAR_LOCAL_MINUTES} 分鐘待處理單 · 詳情請至「訂單」
            </div>
          </div>
          <QuickLocalOrdersStrip
            completeLabel={completeLabel}
            completionLabel={completionLabel}
            currency={currency}
            onMarkCompleted={onMarkCompleted}
            onMarkReady={onMarkReady}
            onReturnPreparing={onReturnPreparing}
            onViewOrder={onViewOrder}
            preparingOrders={preparingOrders}
            waitingOrders={waitingOrders}
          />
        </section>
      </div>
    </div>
  );
}
