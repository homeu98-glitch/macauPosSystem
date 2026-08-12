"use client";

import { useEffect, useMemo, useState } from "react";

import { ResponsiveModal } from "@/components/responsive-modal";
import {
  dateFilterLabel,
  LedgerOrderDateFilter,
  orderMatchesDateFilter,
} from "@/lib/ledger/order-date-filter";
import {
  isLocalPosOrder,
  isQuickCounterOrder,
  localOrderStatusLabel,
  LocalOrderPanelTab,
  matchesLocalOrderPanelTab,
  orderTimestamp,
} from "@/lib/pos-order-filters";
import {
  markQuickOrderCompletedInStore,
  quickCompleteLabel,
  quickCompletionLabel,
  updateQuickFulfillmentInStore,
} from "@/lib/quick-order-fulfillment";
import { loadBootstrapCache, loadOrders } from "@/lib/storage";
import { PosOrder } from "@/lib/types";

const STATUS_TABS: Array<{ key: LocalOrderPanelTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "preparing", label: "製作中" },
  { key: "ready", label: "待取餐" },
  { key: "settled", label: "已完成" },
  { key: "cancelled", label: "已取消" },
];

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

function orderMatchesLocalDateFilter(order: PosOrder, filter: LedgerOrderDateFilter): boolean {
  const pseudo = { createdAt: order.createdAt, updatedAt: order.updatedAt };
  return orderMatchesDateFilter(pseudo, filter);
}

function QuickOrderActions({
  order,
  onChanged,
}: {
  order: PosOrder;
  onChanged: () => void;
}) {
  if (!isQuickCounterOrder(order)) return null;

  const completeText = quickCompleteLabel(order);

  if (order.status === "paid" && order.fulfillmentStatus !== "ready") {
    return (
      <button
        className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
        onClick={() => {
          updateQuickFulfillmentInStore(order.id, "ready");
          onChanged();
        }}
        type="button"
      >
        可取餐
      </button>
    );
  }

  if (order.status === "paid" && order.fulfillmentStatus === "ready") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <button
          className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white"
          onClick={() => {
            markQuickOrderCompletedInStore(order.id, { label: completeText });
            onChanged();
          }}
          type="button"
        >
          {completeText}
        </button>
        <button
          className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200"
          onClick={() => {
            updateQuickFulfillmentInStore(order.id, "preparing");
            onChanged();
          }}
          type="button"
        >
          返回製作
        </button>
      </div>
    );
  }

  return null;
}

export function LocalOrdersPanel({ dateFilter = "today" }: { dateFilter?: LedgerOrderDateFilter }) {
  const currency = loadBootstrapCache()?.currency ?? "MOP";
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders().filter(isLocalPosOrder));
  const [statusTab, setStatusTab] = useState<LocalOrderPanelTab>("all");
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function refresh() {
    setOrders(loadOrders().filter(isLocalPosOrder));
  }

  useEffect(() => {
    window.addEventListener("pos-orders-changed", refresh);
    return () => window.removeEventListener("pos-orders-changed", refresh);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredOrders = useMemo(() => {
    return orders
      .filter((order) => orderMatchesLocalDateFilter(order, dateFilter))
      .filter((order) => matchesLocalOrderPanelTab(order, statusTab))
      .sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
  }, [dateFilter, orders, statusTab]);

  const viewingOrder = viewingOrderId ? orders.find((row) => row.id === viewingOrderId) ?? null : null;

  function handleQuickAction() {
    refresh();
    setToast("已更新訂單狀態");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="text-sm font-semibold text-slate-900">店內線下訂單</div>
        <div className="mt-0.5 text-xs text-slate-500">快餐走製作中 → 待取餐 → 完成；堂食維持送廚結帳流程</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                tab.key === statusTab ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setStatusTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs text-slate-500">
          {dateFilterLabel(dateFilter)} · 共 {filteredOrders.length} 張
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
            {dateFilter === "today" ? "今天暫無線下訂單" : `${dateFilterLabel(dateFilter)}暫無線下訂單`}
          </div>
        ) : (
          <div className="grid gap-2">
            {filteredOrders.map((order) => (
              <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{order.tableName}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      {(order.updatedAt || order.createdAt || "").replace("T", " ").slice(0, 16)}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isQuickCounterOrder(order) && order.status === "paid" && order.fulfillmentStatus === "ready"
                        ? "bg-sky-50 text-sky-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {localOrderStatusLabel(order)}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold text-slate-900">{formatMoney(order.total, currency)}</div>
                <div className="mt-1 truncate text-xs text-slate-500">
                  {order.items
                    .slice(0, 3)
                    .map((item) => `${item.name}×${item.quantity}`)
                    .join(" · ")}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button
                    className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                    onClick={() => setViewingOrderId(order.id)}
                    type="button"
                  >
                    查看
                  </button>
                  <QuickOrderActions onChanged={handleQuickAction} order={order} />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {viewingOrder ? (
        <ResponsiveModal
          description={`${viewingOrder.tableName} · ${localOrderStatusLabel(viewingOrder)}`}
          onClose={() => setViewingOrderId(null)}
          title={viewingOrder.localOrderNo}
          widthClassName="max-w-md"
        >
          <div className="grid gap-2 text-sm text-slate-700">
            {isQuickCounterOrder(viewingOrder) ? (
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {viewingOrder.status === "settled"
                  ? "已完成"
                  : viewingOrder.status === "paid" && viewingOrder.fulfillmentStatus === "ready"
                    ? quickCompletionLabel(viewingOrder)
                    : "製作中"}
              </div>
            ) : null}
            {viewingOrder.orderNote ? <div>備註：{viewingOrder.orderNote}</div> : null}
            {viewingOrder.items.map((item) => (
              <div key={`${item.menuItemId}-${item.name}`} className="flex justify-between gap-2">
                <span>{item.name}</span>
                <span className="font-semibold">×{item.quantity}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 font-semibold text-slate-900">
              <span>總計</span>
              <span>{formatMoney(viewingOrder.total, currency)}</span>
            </div>
            {isQuickCounterOrder(viewingOrder) && viewingOrder.status !== "settled" ? (
              <div className="mt-2">
                <QuickOrderActions
                  onChanged={() => {
                    handleQuickAction();
                    refresh();
                    setViewingOrderId(null);
                  }}
                  order={viewingOrder}
                />
              </div>
            ) : null}
          </div>
        </ResponsiveModal>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
