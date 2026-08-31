"use client";

import { PosOrder } from "@/lib/types";
import { formatMoney, formatMacauTime } from "@/lib/format";
import { isSelfOrder } from "@/lib/pos/order-source";
import { OrderSourceBadge } from "@/components/order-source-badge";

type QuickLocalOrdersStripProps = {
  currency: string;
  preparingOrders: PosOrder[];
  waitingOrders: PosOrder[];
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
};

function OrderCard({
  order,
  currency,
  mode,
  completionLabel,
  completeLabel,
  onViewOrder,
  onMarkReady,
  onMarkCompleted,
}: {
  order: PosOrder;
  currency: string;
  mode: "preparing" | "waiting";
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
}) {
  const completeText = completeLabel(order);

  return (
    <article className="flex h-[180px] w-[240px] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      {/* 頂部：訂單號 + 枱號（左）vs 狀態藥丸 + 來源標記（右，顯示位 ②） */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight text-slate-900">{order.localOrderNo}</div>
          <div className="mt-1 truncate text-xs text-slate-500">{order.tableName}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[20px] font-semibold ${
              mode === "waiting" ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full ${
                mode === "waiting" ? "bg-sky-500" : "bg-amber-500"
              }`}
            />
            {mode === "waiting" ? completionLabel(order) : "製作中"}
          </span>
          <OrderSourceBadge order={order} />
        </div>
      </div>
      {/* 中間：分隔線 + 品項摘要 + 訂單總額同一行（用戶約定：品項名稱與價格同一行） */}
      <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-slate-100 pt-2">
        <div className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {order.items.slice(0, 2).map((item) => `${item.name}×${item.quantity}`).join(" · ")}
          {order.items.length > 2 ? " · …" : ""}
        </div>
        <div className="shrink-0 text-sm font-bold tabular-nums text-slate-900">
          {formatMoney(order.total, currency)}
        </div>
      </div>
      {/* 按鈕：mt-auto 推到底（卡 fixed height，按鈕永遠對齊底部） */}
      <div className="mt-auto flex flex-nowrap gap-1.5">
        <button
          className="shrink-0 rounded-xl bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white"
          onClick={() => onViewOrder(order.id)}
          type="button"
        >
          查看
        </button>
        {/* docs/87 §6.3：放寬閘門，sent_to_kitchen / paid 標記 ready（先出餐後付款）。
            draft 自助單唔顯示「可取餐」——要等「確認出單」先變 sent_to_kitchen。 */}
        {mode === "preparing" &&
        (order.status === "sent_to_kitchen" || order.status === "paid") ? (
          <button
            className="shrink-0 rounded-xl bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white"
            onClick={() => onMarkReady(order.id)}
            type="button"
          >
            可取餐
          </button>
        ) : null}
        {mode === "waiting" ? (
          <button
            className="shrink-0 rounded-xl bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white"
            onClick={() => onMarkCompleted(order.id, completeText)}
            type="button"
          >
            {completeText}
          </button>
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
          onViewOrder={onViewOrder}
          order={order}
        />
      ))}
    </div>
  );
}
