"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import {
  acceptLedgerOrder,
  updateOrderStatus as updateLedgerOrderStatus,
} from "@/lib/ledger/order-actions";
import {
  computeSyncCursor,
  ledgerStatusLabel,
  LedgerOnlineOrder,
  LedgerOrderTab,
  mergeLedgerOrders,
  normalizeLedgerStatus,
  orderCodeLabel,
  tabLabel,
} from "@/lib/ledger/order-mapper";
import { getOrderDetail, listMerchantOrders } from "@/lib/ledger/orders";
import { getLedgerMerchantId, restoreLedgerSession } from "@/lib/ledger/session";
import { useLedgerOrdersRealtime } from "@/lib/ledger/use-ledger-orders-realtime";
import { loadPosLocalSettings } from "@/lib/storage";

const TABS: Array<{ key: LedgerOrderTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "dine_in", label: "堂食" },
  { key: "pickup", label: "外賣自取" },
  { key: "self_delivery", label: "外送" },
];

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function OnlineOrders() {
  const merchantId = getLedgerMerchantId();
  const [activeTab, setActiveTab] = useState<LedgerOrderTab>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<LedgerOnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<string>("INIT");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<Array<{ name: string; qty: number }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);

  const ordersRef = useRef<LedgerOnlineOrder[]>([]);
  const syncCursorRef = useRef<{ since: string | null; sinceId: string | null }>({ since: null, sinceId: null });
  const hasInitializedSnapshotRef = useRef(false);
  const localSettings = useMemo(() => loadPosLocalSettings(), []);
  const tables = useMemo(
    () => localSettings.floors.flatMap((floor) => floor.tables.map((table) => ({ ...table, floorName: floor.name }))),
    [localSettings.floors],
  );

  ordersRef.current = orders;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function unlock() {
      setAudioReady(true);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    }
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const playSound = useCallback(
    (kind: "new_order" | "new_delivery" | "cancel_order") => {
      if (!audioReady) return;
      const src =
        kind === "cancel_order"
          ? "/sounds/cancel-order.mp3"
          : kind === "new_delivery"
            ? "/sounds/new-delivery-order.mp3"
            : "/sounds/new-order.mp3";
      try {
        void new Audio(src).play();
      } catch {
        // ignore
      }
    },
    [audioReady],
  );

  const applyOrders = useCallback((next: LedgerOnlineOrder[]) => {
    setOrders(next);
    syncCursorRef.current = computeSyncCursor(next);
  }, []);

  const loadOrders = useCallback(
    async (mode: "full" | "incremental" = "full") => {
      if (!merchantId) {
        setError("尚未取得商戶資料，請重新登入。");
        setLoading(false);
        return;
      }

      const cursor = syncCursorRef.current;
      const rows = await listMerchantOrders({
        merchantId,
        since: mode === "incremental" ? cursor.since : null,
        sinceId: mode === "incremental" ? cursor.sinceId : null,
      });

      if (mode === "incremental" && cursor.since) {
        applyOrders(mergeLedgerOrders(ordersRef.current, rows));
      } else {
        applyOrders(rows);
      }
    },
    [applyOrders, merchantId],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      setError(null);
      try {
        await restoreLedgerSession();
        if (cancelled) return;
        await loadOrders("full");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "讀取會員通線上訂單失敗");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadOrders]);

  const handleInsert = useCallback(
    (order: LedgerOnlineOrder) => {
      const prev = ordersRef.current;
      const existed = prev.some((row) => row.id === order.id);
      applyOrders(mergeLedgerOrders(prev, [order]));

      if (hasInitializedSnapshotRef.current && !existed) {
        const isDelivery = order.fulfillmentType === "merchant_delivery";
        playSound(isDelivery ? "new_delivery" : "new_order");
      }
      hasInitializedSnapshotRef.current = true;
    },
    [applyOrders, playSound],
  );

  const handleUpdate = useCallback(
    (order: LedgerOnlineOrder) => {
      const prev = ordersRef.current;
      const previous = prev.find((row) => row.id === order.id);
      applyOrders(mergeLedgerOrders(prev, [order]));

      if (
        hasInitializedSnapshotRef.current &&
        previous &&
        normalizeLedgerStatus(previous.status) !== "cancelled" &&
        normalizeLedgerStatus(order.status) === "cancelled"
      ) {
        playSound("cancel_order");
      }
      hasInitializedSnapshotRef.current = true;
    },
    [applyOrders, playSound],
  );

  useLedgerOrdersRealtime(merchantId, Boolean(merchantId), {
    onInsert: handleInsert,
    onUpdate: handleUpdate,
    onResubscribed: () => {
      void loadOrders("incremental").catch((err) => {
        setError(err instanceof Error ? err.message : "增量同步失敗");
      });
    },
    onStatusChange: setRealtimeStatus,
  });

  useEffect(() => {
    if (!loading && orders.length >= 0) {
      hasInitializedSnapshotRef.current = true;
    }
  }, [loading, orders.length]);

  const filteredOrders = useMemo(() => {
    if (activeTab === "all") return orders;
    return orders.filter((order) => order.tabType === activeTab);
  }, [activeTab, orders]);

  const stats = useMemo(() => {
    const pending = filteredOrders.filter((order) => normalizeLedgerStatus(order.status) === "new").length;
    return { total: filteredOrders.length, pending };
  }, [filteredOrders]);

  async function manualRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await loadOrders(syncCursorRef.current.since ? "incremental" : "full");
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失敗");
    } finally {
      setRefreshing(false);
    }
  }

  async function openOrderDetail(orderId: string) {
    setViewingOrderId(orderId);
    setDetailItems(null);
    setDetailLoading(true);
    try {
      const detail = await getOrderDetail(orderId);
      setDetailItems(detail.items);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "讀取明細失敗" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function acceptOrder(order: LedgerOnlineOrder) {
    if (order.tabType === "dine_in") {
      setAssigningOrderId(order.id);
      return;
    }

    setActionLoadingKey(`${order.id}:accept`);
    try {
      await acceptLedgerOrder(order);
      setToast({ tone: "success", message: "已接單。" });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "接單失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function acceptDineInOrder(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:accept-dinein`);
    try {
      await acceptLedgerOrder(order);
      setAssigningOrderId(null);
      setToast({ tone: "success", message: "堂食線上單已接單。" });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "接單失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function pushStatus(order: LedgerOnlineOrder, nextStatus: string, successMessage: string) {
    setActionLoadingKey(`${order.id}:${nextStatus}`);
    try {
      await updateLedgerOrderStatus(order.id, nextStatus);
      setToast({ tone: "success", message: successMessage });
      if (nextStatus === "completed") setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "更新狀態失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function cancelOrder(order: LedgerOnlineOrder) {
    const ok = window.confirm("確定要取消這張訂單？");
    if (!ok) return;
    await pushStatus(order, "cancelled", "已取消訂單。");
    setViewingOrderId(null);
  }

  const viewingOrder = viewingOrderId ? orders.find((item) => item.id === viewingOrderId) ?? null : null;

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">會員通線上訂單</div>
                <div className="mt-1 text-sm text-slate-500">
                  Ledger 即時同步 · {tabLabel(activeTab)} · 共 {stats.total} 張 · 新單 {stats.pending} 張
                </div>
                <div className="mt-1 text-xs text-slate-400">Realtime：{realtimeStatus}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                  disabled={refreshing || loading}
                  onClick={() => void manualRefresh()}
                  type="button"
                >
                  {refreshing ? "刷新中…" : "手動刷新"}
                </button>
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      tab.key === activeTab ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setActiveTab(tab.key)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
            ) : null}

            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">正在載入…</div>
            ) : null}

            {!loading && filteredOrders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                目前沒有訂單
              </div>
            ) : null}

            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {filteredOrders.map((order) => {
                const normalizedStatus = normalizeLedgerStatus(order.status);
                const orderLoading = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;
                return (
                  <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {order.createdAt ? order.createdAt.replace("T", " ").slice(0, 16) : "--"}
                        </div>
                      </div>
                      <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                        {ledgerStatusLabel(order.status, order.fulfillmentType)}
                      </span>
                    </div>
                    <div className="mt-3 text-sm text-slate-700">
                      {order.customerName ? `客戶：${order.customerName}` : "客戶：--"}
                    </div>
                    <div className="mt-1 text-sm text-slate-700">
                      支付：{" "}
                      <span
                        className={
                          order.paymentStatus === "paid" ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"
                        }
                      >
                        {order.paymentStatus === "paid" ? "已支付" : "未支付"}
                      </span>
                      {order.paymentMode ? <span className="text-slate-500">（{order.paymentMode}）</span> : null}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-slate-900">{formatMoney(order.total)}</div>
                    {order.itemSummary ? (
                      <div className="mt-3 text-xs text-slate-600">
                        {order.itemSummary}
                        {order.itemCount && order.itemCount > 1 ? ` 等 ${order.itemCount} 項` : ""}
                      </div>
                    ) : null}
                    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                        onClick={() => void openOrderDetail(order.id)}
                        type="button"
                      >
                        查看
                      </button>
                      {normalizedStatus === "new" ? (
                        <>
                          <button
                            className="rounded-2xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
                            disabled={orderLoading}
                            onClick={() => void acceptOrder(order)}
                            type="button"
                          >
                            {orderLoading ? "提交中…" : order.tabType === "dine_in" ? "接單" : "接單"}
                          </button>
                          <button
                            className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                            disabled={orderLoading}
                            onClick={() => void cancelOrder(order)}
                            type="button"
                          >
                            取消
                          </button>
                        </>
                      ) : null}
                      {normalizedStatus === "preparing" ? (
                        <button
                          className="rounded-2xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                          disabled={orderLoading}
                          onClick={() => void pushStatus(order, "ready", "已標記為就緒。")}
                          type="button"
                        >
                          {order.tabType === "pickup" ? "待取餐" : "待交付"}
                        </button>
                      ) : null}
                      {normalizedStatus === "ready" && order.fulfillmentType === "merchant_delivery" ? (
                        <button
                          className="rounded-2xl bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
                          disabled={orderLoading}
                          onClick={() => void pushStatus(order, "delivering", "已標記配送中。")}
                          type="button"
                        >
                          配送中
                        </button>
                      ) : null}
                      {normalizedStatus === "ready" || normalizedStatus === "delivering" ? (
                        <button
                          className="rounded-2xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                          disabled={orderLoading}
                          onClick={() => void pushStatus(order, "completed", "訂單已完成。")}
                          type="button"
                        >
                          完成
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {assigningOrderId ? (
        <ResponsiveModal
          description="堂食線上單接單後，可在收銀台安排桌台（下一階段將自動轉入堂食單）。"
          onClose={() => setAssigningOrderId(null)}
          title="堂食線上單接單"
          widthClassName="max-w-2xl"
        >
          <div className="grid gap-3">
            <button
              className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
              disabled={Boolean(actionLoadingKey)}
              onClick={() => {
                const order = orders.find((item) => item.id === assigningOrderId);
                if (!order) return;
                void acceptDineInOrder(order);
              }}
              type="button"
            >
              確認接單
            </button>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {tables.map((table) => (
                <div
                  key={table.id}
                  className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-left text-sm text-slate-500"
                >
                  <div>{table.name}</div>
                  <div className="mt-1 text-xs">{table.floorName}</div>
                </div>
              ))}
            </div>
          </div>
        </ResponsiveModal>
      ) : null}

      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-40 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-lg ${
            toast.tone === "success" ? "bg-emerald-600" : "bg-red-600"
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {viewingOrder ? (
        <ResponsiveModal
          description={`${orderCodeLabel(viewingOrder)} · ${tabLabel(viewingOrder.tabType)}`}
          onClose={() => {
            setViewingOrderId(null);
            setDetailItems(null);
          }}
          title="訂單詳情"
          widthClassName="max-w-2xl"
        >
          <div className="grid gap-2 text-sm text-slate-700">
            <div>客戶：{viewingOrder.customerName ?? "--"}</div>
            <div>電話：{viewingOrder.phone ?? "--"}</div>
            {viewingOrder.deliveryAddress ? <div>地址：{viewingOrder.deliveryAddress}</div> : null}
            {viewingOrder.note ? <div>備註：{viewingOrder.note}</div> : null}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">菜品明細</div>
            <div className="mt-3 grid gap-2">
              {detailLoading ? <div className="text-sm text-slate-500">正在載入明細…</div> : null}
              {!detailLoading && detailItems?.length
                ? detailItems.map((item) => (
                    <div key={`${item.name}-${item.qty}`} className="flex items-center justify-between text-sm text-slate-700">
                      <span>{item.name}</span>
                      <span className="font-semibold">x{item.qty}</span>
                    </div>
                  ))
                : null}
              {!detailLoading && !detailItems?.length ? (
                <div className="text-sm text-slate-500">{viewingOrder.itemSummary ?? "--"}</div>
              ) : null}
            </div>
            <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
              <span>總計</span>
              <span className="text-base font-semibold text-slate-900">{formatMoney(viewingOrder.total)}</span>
            </div>
          </div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
