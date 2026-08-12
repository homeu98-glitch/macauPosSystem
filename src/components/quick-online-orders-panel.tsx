"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ResponsiveModal } from "@/components/responsive-modal";
import { bridgeLedgerOrderToPos } from "@/lib/ledger/ledger-pos-bridge";
import {
  printReceiptForLedgerOrderOnce,
  printVoidForLedgerOrderOnce,
} from "@/lib/print-jobs";
import {
  acceptLedgerOrder,
  acceptLedgerOrderInStore,
  updateOrderStatus,
} from "@/lib/ledger/order-actions";
import {
  changeRequestLabel,
  computeSyncCursor,
  hasPendingCancelRequest,
  LedgerOnlineOrder,
  mergeLedgerOrders,
  normalizeLedgerStatus,
  orderCodeLabel,
  paymentModeLabel,
  rawLedgerStatus,
  tabLabel,
} from "@/lib/ledger/order-mapper";
import { getOrderDetail, listMerchantOrders } from "@/lib/ledger/orders";
import { getLedgerMerchantId, restoreLedgerSession } from "@/lib/ledger/session";
import { useLedgerOrdersRealtime } from "@/lib/ledger/use-ledger-orders-realtime";
import { loadOrders } from "@/lib/storage";
import { PosOrder } from "@/lib/types";

type QuickOnlineOrdersPanelProps = {
  currency: string;
  autoAccept: boolean;
  onAutoAcceptChange: (next: boolean) => void;
  onBridgedOrder: (posOrder: PosOrder) => void;
  onToast: (payload: { tone: "success" | "info" | "error"; message: string }) => void;
  /** 快餐模式：堂食線上單不安排桌台，直接接單送廚 */
  skipTableAssignment?: boolean;
  layout?: "stack" | "strip";
  tables?: Array<{ id: string; name: string; floorName: string }>;
};

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

export function QuickOnlineOrdersPanel({
  currency,
  autoAccept,
  onAutoAcceptChange,
  onBridgedOrder,
  onToast,
  skipTableAssignment = false,
  layout = "stack",
  tables = [],
}: QuickOnlineOrdersPanelProps) {
  const merchantId = getLedgerMerchantId();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<LedgerOnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [balanceFallbackOrderId, setBalanceFallbackOrderId] = useState<string | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState("INIT");
  const [posOrdersVersion, setPosOrdersVersion] = useState(0);

  const ordersRef = useRef<LedgerOnlineOrder[]>([]);
  const syncCursorRef = useRef<{ since: string | null; sinceId: string | null }>({ since: null, sinceId: null });
  const hasInitializedSnapshotRef = useRef(false);
  const autoAcceptProcessingRef = useRef<Set<string>>(new Set());

  ordersRef.current = orders;

  useEffect(() => {
    function onPosOrdersChanged() {
      setPosOrdersVersion((value) => value + 1);
    }
    window.addEventListener("pos-orders-changed", onPosOrdersChanged);
    return () => window.removeEventListener("pos-orders-changed", onPosOrdersChanged);
  }, []);

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

  const loadLedgerOrders = useCallback(
    async (mode: "full" | "incremental" = "full") => {
      if (!merchantId) {
        setError("尚未取得商戶資料，請重新登入。");
        setLoading(false);
        return;
      }

      const cursor = syncCursorRef.current;
      const rows = await listMerchantOrders({
        merchantId,
        limit: 50,
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
        await loadLedgerOrders("full");
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
  }, [loadLedgerOrders]);

  const handleInsert = useCallback(
    (order: LedgerOnlineOrder) => {
      const prev = ordersRef.current;
      const existed = prev.some((row) => row.id === order.id);
      applyOrders(mergeLedgerOrders(prev, [order]));

      if (hasInitializedSnapshotRef.current && !existed && rawLedgerStatus(order.status) === "pending") {
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
        printVoidForLedgerOrderOnce(order.id);
      }
      if (
        hasInitializedSnapshotRef.current &&
        previous &&
        normalizeLedgerStatus(previous.status) !== "completed" &&
        normalizeLedgerStatus(order.status) === "completed" &&
        order.paymentStatus === "paid"
      ) {
        void printReceiptForLedgerOrderOnce(order.id, {
          paymentMethod: paymentModeLabel(order.paymentMode) || "線上已支付",
        });
      }
      hasInitializedSnapshotRef.current = true;
    },
    [applyOrders, playSound],
  );

  useLedgerOrdersRealtime(merchantId, Boolean(merchantId), {
    onInsert: handleInsert,
    onUpdate: handleUpdate,
    onResubscribed: () => {
      void loadLedgerOrders("incremental").catch((err) => {
        setError(err instanceof Error ? err.message : "增量同步失敗");
      });
    },
    onStatusChange: setRealtimeStatus,
  });

  useEffect(() => {
    if (!loading) hasInitializedSnapshotRef.current = true;
  }, [loading]);

  const bridgedOrderIds = useMemo(() => {
    return new Set(
      loadOrders()
        .map((order) => order.onlineOrderId)
        .filter((id): id is string => Boolean(id)),
    );
  }, [orders, posOrdersVersion]);

  const visibleOrders = useMemo(() => {
    return orders
      .filter((order) => {
        const status = rawLedgerStatus(order.status);
        if (status === "pending") return true;
        if (status === "cancelled" || status === "completed") return false;
        return !bridgedOrderIds.has(order.id);
      })
      .slice(0, layout === "strip" ? 24 : 16);
  }, [orders, bridgedOrderIds, layout]);

  const runAcceptAndBridge = useCallback(
    async (
      order: LedgerOnlineOrder,
      options?: { tableId?: string; tableName?: string; silent?: boolean },
    ): Promise<boolean> => {
      setActionLoadingKey(`${order.id}:accept`);
      try {
        const result = await acceptLedgerOrder(order);
        if (!result.ok) {
          if (result.code === "insufficient_balance") {
            setBalanceFallbackOrderId(order.id);
            onToast({ tone: "error", message: result.message });
            return false;
          }
          onToast({ tone: "error", message: result.message });
          return false;
        }

        const detail = await getOrderDetail(order.id);
        const { posOrder } = await bridgeLedgerOrderToPos({
          ledgerOrder: order,
          tableId: options?.tableId,
          tableName: options?.tableName,
          detail,
        });

        onBridgedOrder(posOrder);
        applyOrders(
          mergeLedgerOrders(ordersRef.current, [{ ...order, status: "accepted", updatedAt: new Date().toISOString() }]),
        );
        if (!options?.silent) {
          onToast({
            tone: "success",
            message: options?.tableId ? `已接單並安排到 ${options.tableName}。` : "已接單並已送廚。",
          });
        }
        return true;
      } catch (err) {
        onToast({ tone: "info", message: err instanceof Error ? err.message : "接單失敗" });
        return false;
      } finally {
        setActionLoadingKey(null);
      }
    },
    [applyOrders, onBridgedOrder, onToast],
  );

  useEffect(() => {
    if (!autoAccept || loading) return;

    const pending = orders.filter((order) => {
      if (rawLedgerStatus(order.status) !== "pending") return false;
      if (autoAcceptProcessingRef.current.has(order.id)) return false;
      if (!skipTableAssignment && order.tabType === "dine_in") return false;
      return true;
    });

    for (const order of pending) {
      autoAcceptProcessingRef.current.add(order.id);
      void runAcceptAndBridge(order, { silent: true })
        .then((ok) => {
          if (ok) {
            onToast({ tone: "success", message: `已自動接單：${orderCodeLabel(order)}` });
          }
        })
        .finally(() => {
          autoAcceptProcessingRef.current.delete(order.id);
        });
    }
  }, [autoAccept, loading, orders, onToast, runAcceptAndBridge, skipTableAssignment]);

  async function rejectOrder(order: LedgerOnlineOrder) {
    const ok = window.confirm("確定拒絕這張線上訂單？");
    if (!ok) return;
    setActionLoadingKey(`${order.id}:reject`);
    try {
      await updateOrderStatus(order.id, "cancelled");
      applyOrders(
        mergeLedgerOrders(ordersRef.current, [{ ...order, status: "cancelled", updatedAt: new Date().toISOString() }]),
      );
      printVoidForLedgerOrderOnce(order.id);
      onToast({ tone: "success", message: "已拒絕訂單。" });
    } catch (err) {
      onToast({ tone: "error", message: err instanceof Error ? err.message : "拒絕訂單失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function bridgeExistingOrder(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:bridge`);
    try {
      const detail = await getOrderDetail(order.id);
      const { posOrder } = await bridgeLedgerOrderToPos({ ledgerOrder: order, detail });
      onBridgedOrder(posOrder);
      onToast({ tone: "success", message: "已轉入快餐訂單。" });
    } catch (err) {
      onToast({ tone: "info", message: err instanceof Error ? err.message : "轉入失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function acceptInStoreFallback(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:in-store`);
    try {
      await acceptLedgerOrderInStore(order);
      setBalanceFallbackOrderId(null);
      await runAcceptAndBridge(order);
    } catch (err) {
      onToast({ tone: "error", message: err instanceof Error ? err.message : "改到店付款失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  function startAccept(order: LedgerOnlineOrder) {
    if (!skipTableAssignment && order.tabType === "dine_in") {
      setAssigningOrderId(order.id);
      return;
    }
    void runAcceptAndBridge(order);
  }

  const assigningOrder = assigningOrderId ? orders.find((row) => row.id === assigningOrderId) ?? null : null;
  const balanceFallbackOrder = balanceFallbackOrderId
    ? orders.find((row) => row.id === balanceFallbackOrderId) ?? null
    : null;

  const autoAcceptLabel = skipTableAssignment ? "自動接單" : "自動接單（非堂食）";

  function renderOrderCard(order: LedgerOnlineOrder) {
    const isPending = rawLedgerStatus(order.status) === "pending";
    const cancelRequest = changeRequestLabel(order);
    const paymentLabel =
      order.paymentStatus === "paid"
        ? `已支付 ${formatMoney(order.paidAmount, currency)}`
        : paymentModeLabel(order.paymentMode) ?? "未支付";
    const statusLabel = isPending ? "新單" : "已接單";
    const typeLabel = tabLabel(order.tabType);
    const busy = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;

    if (layout === "strip") {
      return (
        <article key={order.id} className="w-[240px] shrink-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>
              <div className="mt-0.5 text-xs text-slate-500">{typeLabel}</div>
            </div>
            <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold text-orange-700">
              {statusLabel}
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-600">{paymentLabel}</div>
          {cancelRequest ? (
            <div className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-700">{cancelRequest}</div>
          ) : null}
          {order.itemSummary ? <div className="mt-1 truncate text-xs text-slate-500">{order.itemSummary}</div> : null}
          <div className="mt-3">
            {isPending ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                  disabled={busy}
                  onClick={() => startAccept(order)}
                  type="button"
                >
                  {busy ? "處理中…" : "接單"}
                </button>
                <button
                  className="rounded-xl bg-slate-200 px-3 py-2 text-xs font-semibold text-slate-800 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void rejectOrder(order)}
                  type="button"
                >
                  拒單
                </button>
              </div>
            ) : hasPendingCancelRequest(order) ? (
              <div className="rounded-xl bg-rose-50 px-3 py-2 text-[10px] font-semibold text-rose-700">
                請至 Ledger Web 確認取消
              </div>
            ) : (
              <button
                className="w-full rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void bridgeExistingOrder(order)}
                type="button"
              >
                {busy ? "處理中…" : "轉入"}
              </button>
            )}
          </div>
        </article>
      );
    }

    return (
      <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">
              {orderCodeLabel(order)} <span className="ml-2 text-xs font-semibold text-slate-500">{typeLabel}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {statusLabel} · {paymentLabel}
            </div>
            {cancelRequest ? (
              <div className="mt-1 text-xs font-semibold text-rose-600">{cancelRequest}</div>
            ) : null}
            {order.itemSummary ? <div className="mt-2 truncate text-xs text-slate-500">{order.itemSummary}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isPending ? (
              <>
                <button
                  className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                  disabled={busy}
                  onClick={() => startAccept(order)}
                  type="button"
                >
                  {busy ? "處理中…" : skipTableAssignment || order.tabType !== "dine_in" ? "接單" : "安排桌台"}
                </button>
                <button
                  className="rounded-2xl bg-slate-200 px-3 py-2 text-xs font-semibold text-slate-800 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void rejectOrder(order)}
                  type="button"
                >
                  拒單
                </button>
              </>
            ) : hasPendingCancelRequest(order) ? (
              <span className="rounded-2xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">待確認取消</span>
            ) : (
              <button
                className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void bridgeExistingOrder(order)}
                type="button"
              >
                {busy ? "處理中…" : "轉入"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={layout === "strip" ? "grid gap-2" : "grid gap-3"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-xs font-semibold text-slate-500">{autoAcceptLabel}</div>
          <span
            className={`truncate text-[10px] font-medium ${
              realtimeStatus === "SUBSCRIBED" ? "text-emerald-600" : "text-amber-600"
            }`}
            title={`Realtime: ${realtimeStatus}`}
          >
            {realtimeStatus === "SUBSCRIBED" ? "即時同步中" : "同步連線中…"}
          </span>
        </div>
        <button
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            autoAccept ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"
          }`}
          onClick={() => onAutoAcceptChange(!autoAccept)}
          type="button"
        >
          {autoAccept ? "開" : "關"}
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</div>
      ) : null}

      {loading ? (
        <div
          className={`rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500 ${
            layout === "strip" ? "flex h-[108px] items-center px-4" : "p-4"
          }`}
        >
          正在載入 Ledger 線上訂單…
        </div>
      ) : visibleOrders.length === 0 ? (
        <div
          className={`rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500 ${
            layout === "strip" ? "flex h-[108px] items-center px-4" : "p-4"
          }`}
        >
          暫無待處理線上訂單。
          {layout === "stack" ? (
            <>
              {" "}
              完整列表請至{" "}
              <Link className="font-semibold text-orange-600 underline" href="/orders">
                線上訂單
              </Link>
              。
            </>
          ) : null}
        </div>
      ) : layout === "strip" ? (
        <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
          {visibleOrders.map(renderOrderCard)}
        </div>
      ) : (
        <div className="grid gap-2">{visibleOrders.map(renderOrderCard)}</div>
      )}

      {!skipTableAssignment && assigningOrder ? (
        <ResponsiveModal
          description="選擇堂食桌台後接單並送廚。"
          onClose={() => setAssigningOrderId(null)}
          title={`安排桌台 · ${orderCodeLabel(assigningOrder)}`}
          widthClassName="max-w-md"
        >
          <div className="grid max-h-64 gap-2 overflow-auto">
            {tables.length === 0 ? (
              <div className="text-sm text-slate-500">尚未設定桌台，請至設置頁新增。</div>
            ) : (
              tables.map((table) => (
                <button
                  key={table.id}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50"
                  onClick={() => {
                    void runAcceptAndBridge(assigningOrder, {
                      tableId: table.id,
                      tableName: table.name,
                    }).then((ok) => {
                      if (ok) setAssigningOrderId(null);
                    });
                  }}
                  type="button"
                >
                  {table.name}
                  <span className="ml-2 text-xs font-normal text-slate-500">{table.floorName}</span>
                </button>
              ))
            )}
          </div>
        </ResponsiveModal>
      ) : null}

      {balanceFallbackOrder ? (
        <ResponsiveModal
          description="會員餘額不足，可改為到店付款接單。"
          onClose={() => setBalanceFallbackOrderId(null)}
          title="餘額不足"
          widthClassName="max-w-sm"
          actions={
            <>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setBalanceFallbackOrderId(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => void acceptInStoreFallback(balanceFallbackOrder)}
                type="button"
              >
                改到店付款接單
              </button>
            </>
          }
        >
          <div className="text-sm text-slate-600">{orderCodeLabel(balanceFallbackOrder)}</div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
