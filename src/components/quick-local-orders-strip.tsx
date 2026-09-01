"use client";

import { PosOrder } from "@/lib/types";
import { formatMoney, formatMacauTime } from "@/lib/format";
import { compareOrderByLocalNo, isQuickCounterOrder } from "@/lib/pos-order-filters";
import { isSelfOrder } from "@/lib/pos/order-source";
import { OrderSourceBadge } from "@/components/order-source-badge";
import { OrderDiscountRow } from "@/components/order-discount-display";
import { orderItemDiscountTotal } from "@/lib/pos/discount";

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
  // 對應狀態一旦觸發，掣就從介面消失（唔係灰掉）；兩個都做齊先出現「已取餐」（settled）。
  // 收銀台落單（source="pos"）嘅快餐單維持舊嘅單鏈邏輯（可取餐 → 已取餐）。
  //
  // 「消失後唔再出現」係由兩個單向閘保證：
  // 1. `status` paid 之後唔會回到 sent_to_kitchen（confirmPayment 只寫 paid/settled，
  //    settleOnly 唔 reset；返結 reopen 會去到 reopened 而非 sent_to_kitchen，reopened
  //    嘅訂單唔再落 quick strip）。
  // 2. `fulfillmentStatus` 一旦寫成 ready 唔會被 reset（`updateQuickFulfillmentInStore`
  //    只寫 ready，markQuickOrderCompletedInStore 寫 ready + settled，唔 reset 落
  //    preparing；餐飲 join 操作唔 reset fulfillmentStatus）。
  // 所以 `isPaid` / `isReady` 一變 true 就永久 true，掣一消失就永久唔再 render。
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
      {/* 中間：品項摘要 + 訂單總額同一行（用戶約定：品項名稱與價格同一行）。
          重點：呢段固定 height + 內部 scroll，再多嘢都唔會撳到下面嘅掣。
          撳唔到掣 → 即係失去主要功能（可取餐／已取餐），所以**按鈕係第一優先**。 */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 border-t border-slate-100 pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-xs text-slate-500">
            {order.items.slice(0, 2).map((item) => `${item.name}×${item.quantity}`).join(" · ")}
            {order.items.length > 2 ? " · …" : ""}
          </div>
          {(() => {
            // 折扣顯示：計算原價（單品原價 × 數量 + 全單 subtotal/總 嘅差），
            // 唔重新計算 subtotal；用一個 heuristic：原價 = total + 全單 discountAmount + 單品節省
            const itemSaving = orderItemDiscountTotal(order.items);
            const wholeSaving = Math.max(0, order.discountAmount ?? 0);
            const totalSaving = itemSaving + wholeSaving;
            if (totalSaving <= 0) {
              return (
                <div className="shrink-0 text-sm font-bold tabular-nums text-slate-900">
                  {formatMoney(order.total, currency)}
                </div>
              );
            }
            // 有折扣：顯示原價（line-through）+ 折後價（amber）
            const original = Math.round((order.total + totalSaving) * 100) / 100;
            return (
              <div className="shrink-0 text-right">
                <div className="text-sm font-bold tabular-nums text-amber-700">{formatMoney(order.total, currency)}</div>
                <div className="text-[10px] tabular-nums text-slate-400 line-through">{formatMoney(original, currency)}</div>
              </div>
            );
          })()}
        </div>
        {/* 折扣明細行：overflow-y-auto，內容再多都唔會撳到下面嘅掣。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OrderDiscountRow
            currency={currency}
            items={order.items}
            variant="compact"
            wholeOrderDiscountAmount={order.discountAmount}
          />
        </div>
      </div>
      {/* 按鈕：永遠喺卡最下層，唔會被折扣明細撳走。
          自助單用 2 獨立按鈕 + 觸發後消失機制；收銀單維持舊單鏈。 */}
      <div className="mt-2 flex shrink-0 flex-wrap gap-1.5 border-t border-slate-100 pt-2">
        <button
          className="shrink-0 rounded-xl bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white"
          onClick={() => onViewOrder(order.id)}
          type="button"
        >
          查看
        </button>
        {showSplitActions ? (
          <>
            {/* 去結帳：未 paid 先 active；已 paid → 唔再 render（用戶要求「消失」而唔係灰掉）。
                單向閘：`status` 由 paid → settled / cancelled / refunded 都唔會回退 paid，
                所以呢個掣一消失就永久唔會再出現。draft 自助單唔顯示，要等確認出單。 */}
            {!isPaid && order.status !== "draft" ? (
              <button
                aria-label={`去結帳 ${order.localOrderNo}`}
                className="shrink-0 rounded-xl bg-slate-700 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800"
                onClick={() => onCheckout?.(order.id)}
                type="button"
              >
                去結帳
              </button>
            ) : null}
            {/* 可取餐：未 ready 先 active；已 ready → 唔再 render。單向閘：
                `fulfillmentStatus` 一旦寫成 ready 就唔會 reset（`updateQuickFulfillmentInStore`
                永遠寫 ready、唔覆寫其他值），所以呢個掣一消失就永久唔會再出現。draft 自助單唔顯示。 */}
            {!isReady && order.status !== "draft" ? (
              <button
                aria-label={`標記可取餐 ${order.localOrderNo}`}
                className="shrink-0 rounded-xl bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-orange-600"
                onClick={() => onMarkReady(order.id)}
                type="button"
              >
                可取餐
              </button>
            ) : null}
            {/* 兩個都做齊 → 出現「已取餐」按下變 settled。settled 後單離開 strip。 */}
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
  // 單一列、全部按單號由小到大：**唔分「製作中 / 待取餐」兩段**。
  // 分段的話，張單一撳「可取餐」就由左面彈去右面一段（即係「按狀態排」——
  // 狀態一改、位置就變，正是用家 2026-09-01 反映嘅問題）。
  // 每張卡嘅 mode（藥丸配色 + 掣）改由單自己嘅狀態決定，同分段時一致。
  const cards = [
    ...preparingOrders.map((order) => ({ order, mode: "preparing" as const })),
    ...waitingOrders.map((order) => ({ order, mode: "waiting" as const })),
  ].sort((a, b) => compareOrderByLocalNo(a.order, b.order));

  const hasOrders = cards.length > 0;

  if (!hasOrders) {
    return (
      <div className="flex h-[108px] items-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 text-sm text-slate-500">
        暫無線下訂單
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
      {cards.map(({ order, mode }) => (
        <OrderCard
          key={order.id}
          completeLabel={completeLabel}
          completionLabel={completionLabel}
          currency={currency}
          mode={mode}
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
