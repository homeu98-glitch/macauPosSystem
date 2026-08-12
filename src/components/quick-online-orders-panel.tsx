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
} from "@/lib/ledger/order-actions";
import {
  computeSyncCursor,
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
  tables: Array<{ id: string; name: string; floorName: string }>;
  onBridgedOrder: (posOrder: PosOrder) => void;
  onToast: (payload: { tone: "success" | "info" | "error"; message: string }) => void;
};

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

export function QuickOnlineOrdersPanel({
  currency,
  autoAccept,
  onAutoAcceptChange,
  tables,
  onBridgedOrder,
  onToast,
}: QuickOnlineOrdersPanelProps) {
  const merchantId = getLedgerMerchantId();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<LedgerOnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [balanceFallbackOrderId, setBalanceFallbackOrderId] = useState<string | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);

  const ordersRef = useRef<LedgerOnlineOrder[]>([]);
  const syncCursorRef = useRef<{ since: string | null; sinceId: string | null }>({ since: null, sinceId: null });
  const hasInitializedSnapshotRef = useRef(false);
  const autoAcceptProcessingRef = useRef<Set<string>>(new Set());

  ordersRef.current = orders;

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
        status: "pending",
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
  }, [orders]);

  const visibleOrders = useMemo(() => {
    return orders
      .filter((order) => {
        const status = rawLedgerStatus(order.status);
        if (status === "pending") return true;
        if (status === "cancelled" || status === "completed") return false;
        return !bridgedOrderIds.has(order.id);
      })
      .slice(0, 16);
  }, [orders, bridgedOrderIds]);

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
    [onBridgedOrder, onToast],
  );

  useEffect(() => {
    if (!autoAccept || loading) return;

    const pending = orders.filter(
      (order) =>
        rawLedgerStatus(order.status) === "pending" &&
        order.tabType !== "dine_in" &&
        !autoAcceptProcessingRef.current.has(order.id),
    );

    for (const order of pending) {
      autoAcceptProcessingRef.current.add(order.id);
      void runAcceptAndBridge(order, { silent: true })
        .then((ok) => {
          if (ok) {
            onToast({ tone: "success", message: `已自動接單：${orderCodeLabel(order)}` });
          }
        })
        .catch(() => {
          autoAcceptProcessingRef.current.delete(order.id);
        });
    }
  }, [autoAccept, loading, orders, onToast, runAcceptAndBridge]);

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

  const assigningOrder = assigningOrderId ? orders.find((row) => row.id === assigningOrderId) ?? null : null;
  const balanceFallbackOrder = balanceFallbackOrderId
    ? orders.find((row) => row.id === balanceFallbackOrderId) ?? null
    : null;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-500">自動接單（非堂食）</div>
        <button
          className={`rounded-full px-3 py-2 text-xs font-semibold ${
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
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          正在載入 Ledger 線上訂單…
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          暫無待處理線上訂單。完整列表請至{" "}
          <Link className="font-semibold text-orange-600 underline" href="/orders">
            線上訂單
          </Link>
          。
        </div>
      ) : (
        <div className="grid gap-2">
          {visibleOrders.map((order) => {
            const isPending = rawLedgerStatus(order.status) === "pending";
            const paymentLabel =
              order.paymentStatus === "paid"
                ? `已支付 ${formatMoney(order.paidAmount, currency)}`
                : paymentModeLabel(order.paymentMode) ?? "未支付";
            const statusLabel = isPending ? "新單" : "已接單";
            const typeLabel = tabLabel(order.tabType);
            const busy = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;

            return (
              <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                      {orderCodeLabel(order)}{" "}
                      <span className="ml-2 text-xs font-semibold text-slate-500">{typeLabel}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {statusLabel} · {paymentLabel}
                    </div>
                    {order.itemSummary ? (
                      <div className="mt-2 truncate text-xs text-slate-500">{order.itemSummary}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isPending ? (
                      order.tabType === "dine_in" ? (
                        <button
                          className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={busy}
                          onClick={() => setAssigningOrderId(order.id)}
                          type="button"
                        >
                          安排桌台
                        </button>
                      ) : (
                        <button
                          className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={busy}
                          onClick={() => void runAcceptAndBridge(order)}
                          type="button"
                        >
                          {busy ? "處理中…" : "接單"}
                        </button>
                      )
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
          })}
        </div>
      )}

      {assigningOrder ? (
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
