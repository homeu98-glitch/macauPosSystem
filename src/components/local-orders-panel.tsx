"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";
import { useRouter } from "next/navigation";

import { ResponsiveModal } from "@/components/responsive-modal";
import {
  dateFilterLabel,
  LedgerOrderDateFilter,
  orderMatchesDateFilter,
} from "@/lib/ledger/order-date-filter";
import {
  isLocalOrTransferredDineIn,
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
import { isReopenable, reopenPosOrder } from "@/lib/pos-orders";
import { loadAuthSession, loadBootstrapCache, loadOrders, loadPosLocalSettings } from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { formatMoney } from "@/lib/format";

const STATUS_TABS: Array<{ key: LocalOrderPanelTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "preparing", label: "製作中" },
  { key: "ready", label: "待取餐" },
  { key: "settled", label: "已完成" },
  { key: "reopened", label: "已返結" },
  { key: "cancelled", label: "已取消" },
];

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
  const router = useRouter();
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders().filter(isLocalOrTransferredDineIn));
  const [statusTab, setStatusTab] = useState<LocalOrderPanelTab>("all");
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [reopenTargetOrderId, setReopenTargetOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState<string>("");
  const [reopenSubmitting, setReopenSubmitting] = useState(false);

  function refresh() {
    setOrders(loadOrders().filter(isLocalOrTransferredDineIn));
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
  const reopenTarget = reopenTargetOrderId ? orders.find((row) => row.id === reopenTargetOrderId) ?? null : null;

  function handleQuickAction() {
    refresh();
    setToast("已更新訂單狀態");
  }

  async function handleReopen(order: PosOrder) {
    if (!reopenReason.trim()) {
      setToast("請先揀返結原因");
      return;
    }
    setReopenSubmitting(true);
    try {
      const session = loadAuthSession();
      const operator = session?.name ?? session?.account ?? "收銀";
      const result = await reopenPosOrder({ orderId: order.id, reason: reopenReason, operator });
      if (!result.ok) {
        setToast(result.error ?? "返結失敗");
        return;
      }
      if (result.memberReverseError) {
        setToast("已返結並印單；會員餘額退回待 Ledger 對接");
      } else {
        setToast(result.memberReversed ? "已返結、會員餘額已退回並印單" : "已返結並印返結單");
      }
      setReopenReason("");
      setViewingOrderId(null);
      setReopenTargetOrderId(null);
      // 跳去點餐枱面：進入 temp 枱可編輯「返結帳」狀態，可加餐 / 改價 / 重結（原枱唔會被取代）
      const tableId = result.tempTable?.id ?? (order.tableId && order.tableId !== "counter" ? order.tableId : "");
      router.push(`/?tableId=${encodeURIComponent(tableId)}&orderId=${encodeURIComponent(order.id)}`);
    } finally {
      setReopenSubmitting(false);
    }
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
                      {formatMacauDateTime(order.updatedAt || order.createdAt || "")}
                    </div>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[20px] font-semibold ${
                      isQuickCounterOrder(order) && order.status === "paid" && order.fulfillmentStatus === "ready"
                        ? "bg-sky-50 text-sky-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    <span
                      className={`h-4 w-4 rounded-full ${
                        isQuickCounterOrder(order) && order.status === "paid" && order.fulfillmentStatus === "ready"
                          ? "bg-sky-500"
                          : "bg-slate-500"
                      }`}
                    />
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
                    onClick={() => {
                      if (order.status === "settled" && isReopenable(order)) {
                        // 已結堂食單 → 跳點餐介面（唯讀灰掣模式），入面掣全部鎖定
                        const tableId = order.tableId && order.tableId !== "counter" ? order.tableId : "";
                        router.push(
                          `/?tableId=${encodeURIComponent(tableId)}&orderId=${encodeURIComponent(order.id)}`,
                        );
                      } else if (!order.tableId || order.tableId === "counter") {
                        // 快餐/外賣/無枱 → 保留小窗唯讀
                        setReopenReason("");
                        setViewingOrderId(order.id);
                      } else {
                        // 未結堂食單（本地枱單 + 已轉枱線上堂食單）→ 直接跳枱面編輯
                        router.push(
                          `/?tableId=${encodeURIComponent(order.tableId)}&orderId=${encodeURIComponent(order.id)}`,
                        );
                      }
                    }}
                    type="button"
                  >
                    查看
                  </button>
                  {order.status === "settled" && isReopenable(order) ? (
                    <button
                      className="rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white"
                      onClick={() => {
                        setReopenReason("");
                        setReopenTargetOrderId(order.id);
                      }}
                      type="button"
                    >
                      返結帳
                    </button>
                  ) : null}
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
            {(viewingOrder.voidedItems ?? []).map((item, idx) => (
              <div key={`voided-${item.menuItemId}-${idx}`} className="flex justify-between gap-2 text-red-600 line-through">
                <span>
                  {item.name}
                  <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">已退菜</span>
                </span>
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

      {reopenTarget ? (
        <ResponsiveModal
          description="把此單退回可編輯，改正後重新結帳"
          onClose={() => {
            setReopenTargetOrderId(null);
            setReopenReason("");
          }}
          title="返結帳（反結賬）"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-[11px] text-amber-700">
              必須揀返結原因，確認後跳去點餐枱面操作（可改價／加餐／重結）。
            </p>
            <select
              className="w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
            >
              <option value="" disabled>
                揀返結原因…
              </option>
              {(loadPosLocalSettings()?.reopenReasons ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="w-full rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              disabled={!reopenReason || reopenSubmitting}
              onClick={() => handleReopen(reopenTarget)}
            >
              {reopenSubmitting ? "處理中…" : "返結帳"}
            </button>
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
