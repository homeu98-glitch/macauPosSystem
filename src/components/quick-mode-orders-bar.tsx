"use client";

import { QuickLocalOrdersStrip } from "@/components/quick-local-orders-strip";
import { QuickOnlineOrdersPanel } from "@/components/quick-online-orders-panel";
import { PosOrder } from "@/lib/types";

type QuickModeOrdersBarProps = {
  currency: string;
  autoAcceptOnline: boolean;
  onAutoAcceptOnlineChange: (next: boolean) => void;
  onBridgedOnlineOrder: (posOrder: PosOrder) => void;
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
  onBridgedOnlineOrder,
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
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">線上訂單</div>
          <QuickOnlineOrdersPanel
            autoAccept={autoAcceptOnline}
            currency={currency}
            layout="strip"
            onAutoAcceptChange={onAutoAcceptOnlineChange}
            onBridgedOrder={onBridgedOnlineOrder}
            onToast={onOnlineToast}
            skipTableAssignment
          />
        </section>
        <section className="min-w-0 px-3 py-2.5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">線下訂單</div>
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
