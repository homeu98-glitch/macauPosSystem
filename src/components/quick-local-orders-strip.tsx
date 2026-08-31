"use client";

import { PosOrder } from "@/lib/types";
import { formatMoney, formatMacauTime } from "@/lib/format";
import { isQuickCounterOrder } from "@/lib/pos-order-filters";
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
  /** 自助單獨立結帳入口（kiosk / scan），開啟付款 modal。 */
  onCheckout?: (orderId: string) => void;
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
  onCheckout,
}: {
  order: PosOrder;
  currency: string;
  mode: "preparing" | "waiting";
  completionLabel: (order: PosOrder) => string;
  completeLabel: (order: PosOrder) => string;
  onViewOrder: (orderId: string) => void;
  onMarkReady: (orderId: string) => void;
  onMarkCompleted: (orderId: string, label: string) => void;
  onCheckout?: (orderId: string) => void;
}) {
  const completeText = completeLabel(order);
  const orderTime = formatMacauTime(order.createdAt);

  // 自助單（kiosk / scan）嘅快餐 counter 單：可取餐 + 結帳 兩個動作獨立並存，
  // 先做嗰個會灰掉（disabled），兩個都做齊先出現「已取餐」（settled）。
  // 收銀台落單（source="pos"）嘅快餐單維持舊嘅單鏈邏輯（可取餐 → 已取餐）。
  const showSplitActions = onCheckout && isQuickCounterOrder(order) && isSelfOrder(order);
  const isPaid = order.status === "paid";
  const isReady = order.fulfillmentStatus === "ready";
  const isBothDone = isPaid && isReady;

  return (
    <article className="flex h-[180px] w-[240px] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      {/* 頂部：訂單號 + 枱號（左）vs 狀態藥丸（右） */}
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
          {/* 時間（HH:MM，下單時間）+ 來源 chip 並排，貼右下（齊平 OrderSourceBadge 高度）。 */}
          <div className="flex items-center gap-1.5">
            <span
              aria-label="下單時間"
              className="inline-flex shrink-0 items-center tabular-nums text-[11px] font-semibold text-slate-500"
            >
              {orderTime}
            </span>
            <OrderSourceBadge order={order} />
          </div>
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
      {/* 按鈕：mt-auto 推到底（卡 fixed height，按鈕永遠對齊底部）。
          自助單用 2 獨立按鈕 + 灰掉機制；收銀單維持舊單鏈。 */}
      <div className="mt-auto flex flex-wrap gap-1.5">
        <button
          className="shrink-0 rounded-xl bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white"
          onClick={() => onViewOrder(order.id)}
          type="button"
        >
          查看
        </button>
        {showSplitActions ? (
          <>
            {/* 去結帳：已 paid 就灰掉（disabled），否則 active。draft 自助單唔顯示，要等確認出單先見到。 */}
            {order.status !== "draft" && (
              <button
                aria-label={`去結帳 ${order.localOrderNo}`}
                className="shrink-0 rounded-xl bg-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isPaid}
                onClick={() => onCheckout?.(order.id)}
                type="button"
              >
                去結帳
              </button>
            )}
            {/* 可取餐：已 ready 就灰掉，否則 active。draft 自助單唔顯示。 */}
            {order.status !== "draft" && (
              <button
                aria-label={`標記可取餐 ${order.localOrderNo}`}
                className="shrink-0 rounded-xl bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isReady}
                onClick={() => onMarkReady(order.id)}
                type="button"
              >
                可取餐
              </button>
            )}
            {/* 兩個都做齊 → 出現「已取餐」按下變 settled。 */}
            {isBothDone ? (
              <button
                aria-label={`完成取餐 ${order.localOrderNo}`}
                className="shrink-0 rounded-xl bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
                onClick={() => onMarkCompleted(order.id, completeText)}
                type="button"
              >
                {completeText}
              </button>
            ) : null}
          </>
        ) : (
          <>
            {/* 收銀台落單舊邏輯（可取餐 → 已取餐 單鏈）。 */}
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
          </>
        )}
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
  onCheckout,
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
          onCheckout={onCheckout}
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
          onCheckout={onCheckout}
          onMarkCompleted={onMarkCompleted}
          onMarkReady={onMarkReady}
          onViewOrder={onViewOrder}
          order={order}
        />
      ))}
    </div>
  );
}
