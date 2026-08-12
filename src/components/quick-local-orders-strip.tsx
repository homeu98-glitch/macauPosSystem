"use client";

import { PosOrder } from "@/lib/types";

type QuickLocalOrdersStripProps = {
  currency: string;
  preparingOrders: PosOrder[];
  waitingOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  onReturnPreparing: (orderId: string) => void;
};

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

function OrderCard({
  order,
  currency,
  mode,
  completionLabel,
  completeLabel,
  onViewOrder,
  onMarkReady,
  onMarkCompleted,
  onReturnPreparing,
}: {
  order: PosOrder;
  currency: string;
  mode: "preparing" | "waiting";
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  onReturnPreparing: (orderId: string) => void;
}) {
  const completeText = completeLabel(order);

  return (
    <article className="w-[240px] shrink-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
          <div className="mt-0.5 truncate text-xs text-slate-500">{order.tableName}</div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            mode === "waiting" ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          {mode === "waiting" ? completionLabel(order) : "製作中"}
        </span>
      </div>
      <div className="mt-2 text-xs text-slate-600">{formatMoney(order.total, currency)}</div>
      <div className="mt-1 truncate text-xs text-slate-500">
        {order.items.slice(0, 2).map((item) => `${item.name}x${item.quantity}`).join(" · ")}
        {order.items.length > 2 ? " · …" : ""}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          className="rounded-xl bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white"
          onClick={() => onViewOrder(order.id)}
          type="button"
        >
          查看
        </button>
        {mode === "preparing" && order.status === "paid" ? (
          <button
            className="rounded-xl bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white"
            onClick={() => onMarkReady(order.id)}
            type="button"
          >
            可取餐
          </button>
        ) : null}
        {mode === "waiting" ? (
          <>
            <button
              className="rounded-xl bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white"
              onClick={() => onMarkCompleted(order.id, completeText)}
              type="button"
            >
              {completeText}
            </button>
            <button
              className="rounded-xl bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200"
              onClick={() => onReturnPreparing(order.id)}
              type="button"
            >
              返回製作
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}

export function QuickLocalOrdersStrip({
  currency,
  preparingOrders,
  waitingOrders,
  completionLabel,
  completeLabel,
  onViewOrder,
  onMarkReady,
  onMarkCompleted,
  onReturnPreparing,
}: QuickLocalOrdersStripProps) {
  const hasOrders = preparingOrders.length > 0 || waitingOrders.length > 0;

  if (!hasOrders) {
    return (
      <div className="flex h-[108px] items-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 text-sm text-slate-500">
        暫無線下訂單
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
      {preparingOrders.map((order) => (
        <OrderCard
          key={order.id}
          completeLabel={completeLabel}
          completionLabel={completionLabel}
          currency={currency}
          mode="preparing"
          onMarkCompleted={onMarkCompleted}
          onMarkReady={onMarkReady}
          onReturnPreparing={onReturnPreparing}
          onViewOrder={onViewOrder}
          order={order}
        />
      ))}
      {waitingOrders.map((order) => (
        <OrderCard
          key={order.id}
          completeLabel={completeLabel}
          completionLabel={completionLabel}
          currency={currency}
          mode="waiting"
          onMarkCompleted={onMarkCompleted}
          onMarkReady={onMarkReady}
          onReturnPreparing={onReturnPreparing}
          onViewOrder={onViewOrder}
          order={order}
        />
      ))}
    </div>
  );
}
