"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ResponsiveModal } from "@/components/responsive-modal";
import { TableAssignModal, type AssignableTable } from "@/components/table-assign-modal";
import { assignLedgerOrderToTable, adoptLedgerOrderAsQuickCounter, printKitchenForLedgerOrder } from "@/lib/ledger/ledger-pos-bridge";
import {
  isOnlineDineIn,
  needsTableAssignment,
  onlinePaymentBadge,
  onlineTableAssignLabel,
  onlineTableBadge,
} from "@/lib/pos/online-dinein-labels";
import { loadOrders } from "@/lib/storage";
import {
  printReceiptForLedgerOrderOnce,
  printVoidForLedgerOrderOnce,
} from "@/lib/print-jobs";
import {
  acceptLedgerOrder,
  acceptLedgerOrderInStore,
  resolveOrderChange,
  setOrderPaidInStore,
  markPaidIfInStoreUnpaid,
  updateOrderStatus,
} from "@/lib/ledger/order-actions";
import {
  changeRequestLabel,
  computeSyncCursor,
  hasPendingChangeRequest,
  ledgerStatusLabel,
  LedgerOnlineOrder,
  mergeLedgerOrders,
  normalizeLedgerStatus,
  orderCodeLabel,
  paymentModeLabel,
  rawLedgerStatus,
  tabLabel,
} from "@/lib/ledger/order-mapper";
import {
  getPrimaryOnlineOrderAction,
  getChangeRequestActions,
  isActiveOnlineOrder,
  ledgerStatusBadgeLabel,
  onlineOrderActionButtonClass,
  OnlineOrderAction,
  paymentSummaryLabel,
} from "@/lib/ledger/online-order-actions";
import { getOrderDetail, listMerchantOrders } from "@/lib/ledger/orders";
import { getLedgerMerchantId, restoreLedgerSession } from "@/lib/ledger/session";
import { useLedgerOrdersRealtime } from "@/lib/ledger/use-ledger-orders-realtime";
import { formatMoney } from "@/lib/format";

type QuickOnlineOrdersPanelProps = {
  currency: string;
  autoAccept: boolean;
  onAutoAcceptChange?: (next: boolean) => void;
  onToast: (payload: { tone: "success" | "info" | "error"; message: string }) => void;
  /** 快餐模式：堂食線上單不安排桌台，出餐口取餐 */
  skipTableAssignment?: boolean;
  layout?: "stack" | "strip";
  /** strip 模式由外層標題列控制自動接單 */
  showAutoAcceptControls?: boolean;
  tables?: Array<{ id: string; name: string; floorName: string }>;
  /**
   * 快餐模式：線上單一律當**本地快餐 counter 單**處理（出餐口自取、唔排位）。
   *
   * 同 `skipTableAssignment` 唔同：後者只係「唔彈安排桌台彈窗」，堂食模式一樣會傳 true。
   * 呢個旗標直接決定「接單後要唔要採納成本地 counter 單 + 標籤顯示出餐口自取」，
   * 只有 `QuickModeOrdersBar`（快餐模式）會傳。
   */
  quickCounter?: boolean;
  /**
   * 出「排位」掣（線上**堂食**單 assign 到桌台）。
   *
   * ⚠️ 堂食模式要開、**快餐模式要熄**：快餐店有枱但唔會安排座位
   * （出餐口自取、客人自己搵位）→ 出咗掣只會誤導收銀。
   */
  tableAssign?: boolean;
};

function optimisticPatch(order: LedgerOnlineOrder, status: string): LedgerOnlineOrder {
  return { ...order, status, updatedAt: new Date().toISOString() };
}

export function QuickOnlineOrdersPanel({
  currency,
  autoAccept,
  onAutoAcceptChange,
  onToast,
  skipTableAssignment = false,
  layout = "stack",
  showAutoAcceptControls = true,
  tables = [],
  quickCounter = false,
  tableAssign = false,
}: QuickOnlineOrdersPanelProps) {
  const merchantId = getLedgerMerchantId();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<LedgerOnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [balanceFallbackOrderId, setBalanceFallbackOrderId] = useState<string | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [assigningTableId, setAssigningTableId] = useState<string | null>(null);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<Array<{ name: string; qty: number; discountRate?: number; discountAvos?: number }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const ordersRef = useRef<LedgerOnlineOrder[]>([]);
  const syncCursorRef = useRef<{ since: string | null; sinceId: string | null }>({ since: null, sinceId: null });
  const hasInitializedSnapshotRef = useRef(false);
  const autoAcceptProcessingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

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
    (kind: "new_order" | "new_delivery" | "cancel_order" | "cancel_request" | "modify_request") => {
      if (!audioReady) return;
      const src =
        kind === "cancel_order" || kind === "cancel_request"
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

  const patchOrder = useCallback(
    (order: LedgerOnlineOrder, status: string) => {
      applyOrders(mergeLedgerOrders(ordersRef.current, [optimisticPatch(order, status)]));
    },
    [applyOrders],
  );

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

      // 客人取消／改單申請：status 唔變，只係 `change_request_type` 由 null 變 'cancel' / 'modify'。
      const prevRequestType = String(previous?.changeRequestType ?? "").toLowerCase();
      const nextRequestType = String(order.changeRequestType ?? "").toLowerCase();

      if (hasInitializedSnapshotRef.current) {
        if (prevRequestType !== "cancel" && nextRequestType === "cancel") {
          playSound("cancel_request");
          onToast({ tone: "error", message: `客人申請取消：${orderCodeLabel(order)}` });
        }
        if (prevRequestType !== "modify" && nextRequestType === "modify") {
          playSound("modify_request");
          onToast({ tone: "info", message: `客人申請修改：${orderCodeLabel(order)}` });
        }
        if (prevRequestType && !nextRequestType && normalizeLedgerStatus(order.status) !== "cancelled") {
          onToast({ tone: "info", message: "客人申請已處理，訂單繼續。" });
        }
      }

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
    [applyOrders, onToast, playSound],
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

  useEffect(() => {
    if (!viewingOrderId) {
      setDetailItems(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void getOrderDetail(viewingOrderId)
      .then((detail) => {
        if (!cancelled) {
          setDetailItems(
              detail.items.map((item) => ({
                name: item.name,
                qty: item.qty,
                discountRate: item.discountRate,
                discountAvos: item.discountAvos,
              })),
            );
        }
      })
      .catch(() => {
        if (!cancelled) setDetailItems(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewingOrderId]);

  const visibleOrders = useMemo(() => {
    return orders.filter(isActiveOnlineOrder).slice(0, layout === "strip" ? 24 : 16);
  }, [orders, layout]);

  const runAccept = useCallback(
    async (
      order: LedgerOnlineOrder,
      options?: { silent?: boolean; autoStartPreparing?: boolean; tableId?: string; tableName?: string },
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
        let kitchenJobCount = 0;
        try {
          if (quickCounter) {
            // 快餐模式：採納成本地 counter 單（會一併出廚房單）。
            // 之後快餐 strip 嘅「可取餐 → 完成」即刻管得到，本地狀態亦會回寫 Ledger。
            const adopted = await adoptLedgerOrderAsQuickCounter({ ledgerOrder: order, detail });
            kitchenJobCount = adopted.printJobs.length;
          } else {
            kitchenJobCount = (await printKitchenForLedgerOrder(order, detail)).length;
          }
        } catch (err) {
          // 🔴 自動接單（silent）時呢個 catch 以前完全靜默 —— 出單失敗收銀零提示，
          // 只會見到「已自動接單」＝假成功。至少要留一條 log 俾人追（2026-09-12）。
          console.error(
            `[quick-online-orders] 廚房單建立失敗 ${order.id}：`,
            err instanceof Error ? err.message : err,
          );
          if (!options?.silent) {
            onToast({ tone: "error", message: "已接單，但廚房單送出失敗，可稍後重打。" });
          }
        }

        if (options?.autoStartPreparing) {
          await updateOrderStatus(order.id, "preparing");
          patchOrder(order, "preparing");
        } else {
          patchOrder(order, "accepted");
        }

        if (!options?.silent) {
          // 🔴 自動接單（`autoStartPreparing`）以前寫死「已接單並開始製作」，
          // **完全忽略 `kitchenJobCount`** → 明明 0 張廚房 job 都照講成功（假成功）。
          // 2026-09-12 修：兩個分支一律帶出「有冇真係送咗廚」。
          const kitchenHint = kitchenJobCount > 0 ? "並已送廚" : "（按打印設定未出廚房單）";
          onToast({
            tone: "success",
            message: options?.autoStartPreparing
              ? `已接單並開始製作${kitchenHint}：${orderCodeLabel(order)}`
              : `已接單${kitchenHint}：${orderCodeLabel(order)}`,
          });
        }
        return true;
      } catch (err) {
        onToast({ tone: "error", message: err instanceof Error ? err.message : "接單失敗" });
        return false;
      } finally {
        setActionLoadingKey(null);
      }
    },
    // `quickCounter` 要入 deps：快餐模式行「採納成本地 counter 單」，堂食模式行「只出廚房單」。
    [onToast, patchOrder, quickCounter],
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
      void runAccept(order, { silent: true, autoStartPreparing: true })
        .then((ok) => {
          if (ok) {
            onToast({ tone: "success", message: `已自動接單：${orderCodeLabel(order)}` });
          }
        })
        .finally(() => {
          autoAcceptProcessingRef.current.delete(order.id);
        });
    }
  }, [autoAccept, loading, onToast, orders, runAccept, skipTableAssignment]);

  const runAction = useCallback(
    async (order: LedgerOnlineOrder, action: OnlineOrderAction) => {
      if (action.key === "accept") {
        // 🔴 2026-09-12 商家定案：接單**唔會**再被「安排桌台」攔住。
        // 自動接單／人手接單之後張單只係「待安排座位」，收銀得閒再按「排位」。
        // （舊寫法 `if (!skipTableAssignment && order.tabType === "dine_in")` 會彈舊嘅
        //  安排桌台彈窗並中止接單 → 同新 UI 嘅「排位」掣撞，而且嗰個彈窗從來冇真正落枱號。）
        await runAccept(order);
        return;
      }

      if (action.key === "reject") {
        const ok = window.confirm("確定拒絕這張線上訂單？");
        if (!ok) return;
      }

      if (action.key === "approve_change") {
        const isCancel = String(order.changeRequestType ?? "").toLowerCase() === "cancel";
        const ok = window.confirm(
          isCancel
            ? "確定同意客人取消這張訂單？取消後不可復原。"
            : "確定同意客人的修改申請？套用後以新明細／新金額為準。",
        );
        if (!ok) return;
      }

      if (action.key === "reject_change") {
        const ok = window.confirm("確定拒絕客人的申請？訂單會繼續處理。");
        if (!ok) return;
      }

      setActionLoadingKey(`${order.id}:${action.key}`);
      try {
        if (action.key === "mark_paid_in_store") {
          await setOrderPaidInStore(order.id);
          await printReceiptForLedgerOrderOnce(order.id, { paymentMethod: "到店付款" });
          onToast({ tone: "success", message: action.successMessage ?? "已標記到店付款。" });
          return;
        }

        // 審核客人取消／改單申請：一律打 Ledger RPC merchant_resolve_order_change。
        // ⚠️ 同意取消唔可以用 update_order_status(..., 'cancelled') —— 嗰個係商戶自己取消，唔會沖正。
        if (action.key === "approve_change" || action.key === "reject_change") {
          const approve = action.key === "approve_change";
          const isCancel = String(order.changeRequestType ?? "").toLowerCase() === "cancel";
          const result = await resolveOrderChange(order.id, approve ? "approve" : "reject");
          if (approve && isCancel) {
            // POS 直連 RPC 唔會觸發 Ledger 作廢單 MQTT → 自行 LAN 印作廢單
            //（realtime echo 嗰邊 printVoidForLedgerOrderOnce 有冪等保護）。
            printVoidForLedgerOrderOnce(order.id);
          }
          if (approve && !isCancel) {
            // 改單：套用新明細後補印廚房單
            try {
              const detail = await getOrderDetail(order.id);
              await printKitchenForLedgerOrder(order, detail);
            } catch {
              onToast({ tone: "info", message: "已同意修改，但廚房單補印失敗，可稍後重打。" });
            }
          }
          applyOrders(
            mergeLedgerOrders(ordersRef.current, [
              {
                ...order,
                changeRequestType: undefined,
                status: approve ? result?.status ?? order.status : order.status,
                updatedAt: new Date().toISOString(),
              },
            ]),
          );
          onToast({ tone: "success", message: action.successMessage ?? "已處理客人申請。" });
          if (approve && isCancel) setViewingOrderId(null);
          return;
        }

        if (!action.nextStatus) return;

        // 到店付款單：完成前先收錢，避免「已完成但未付、唔入帳」
        const justPaid =
          action.nextStatus === "completed"
            ? await markPaidIfInStoreUnpaid(order.id, order.paymentMode, order.paymentStatus)
            : false;

        await updateOrderStatus(order.id, action.nextStatus);

        if (action.nextStatus === "cancelled") {
          printVoidForLedgerOrderOnce(order.id);
          setViewingOrderId(null);
        }
        if (action.nextStatus === "completed" && (justPaid || order.paymentStatus === "paid")) {
          await printReceiptForLedgerOrderOnce(order.id, {
            paymentMethod: justPaid ? "到店付款" : paymentModeLabel(order.paymentMode) || "線上已支付",
          });
          setViewingOrderId(null);
        }

        patchOrder(order, action.nextStatus);
        onToast({ tone: "success", message: action.successMessage ?? "已更新訂單。" });
      } catch (err) {
        onToast({ tone: "error", message: err instanceof Error ? err.message : "操作失敗" });
      } finally {
        setActionLoadingKey(null);
      }
    },
    [applyOrders, onToast, patchOrder, runAccept],
  );

  async function acceptInStoreFallback(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:in-store`);
    try {
      await acceptLedgerOrderInStore(order);
      setBalanceFallbackOrderId(null);
      await runAccept(order, { autoStartPreparing: autoAccept });
    } catch (err) {
      onToast({ tone: "error", message: err instanceof Error ? err.message : "改到店付款失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  const viewingOrder = viewingOrderId ? orders.find((row) => row.id === viewingOrderId) ?? null : null;
  const assigningOrder = assigningOrderId ? orders.find((row) => row.id === assigningOrderId) ?? null : null;
  const balanceFallbackOrder = balanceFallbackOrderId
    ? orders.find((row) => row.id === balanceFallbackOrderId) ?? null
    : null;

  /**
   * 排位彈窗入面「唔可以揀」嘅枱：本機任何**進行中**（draft / 製作中 / 已收款未完成 / 返結）
   * 而且有真枱號嘅單。**要剔除目標單自己**，否則改枱時原本張枱會變咗不可選。
   */
  const occupiedTableIds = useMemo(() => {
    if (!assigningOrder) return [] as string[];
    const openStatuses = new Set(["draft", "sent_to_kitchen", "paid", "reopened"]);
    return loadOrders()
      .filter(
        (row) =>
          row.id !== assigningOrder.id &&
          !!row.tableId &&
          row.tableId !== "counter" &&
          openStatuses.has(row.status),
      )
      .map((row) => row.tableId as string);
  }, [assigningOrder]);

  const assignTable = useCallback(
    async (order: LedgerOnlineOrder, table: AssignableTable): Promise<boolean> => {
      setAssigningTableId(table.id);
      try {
        const detail = await getOrderDetail(order.id);
        const result = await assignLedgerOrderToTable({
          ledgerOrder: order,
          tableId: table.id,
          tableName: table.name,
          detail,
        });
        onToast({
          tone: "success",
          message: result.created
            ? `已排位 ${table.name}：${orderCodeLabel(order)}`
            : `已改枱到 ${table.name}：${orderCodeLabel(order)}`,
        });
        // 枱位狀態存在本機投影（Ledger 側冇枱概念）→ 用新 ref 逼一次 re-render 更新標籤。
        applyOrders(mergeLedgerOrders(ordersRef.current, [{ ...order }]));
        setAssigningOrderId(null);
        return true;
      } catch (err) {
        onToast({ tone: "error", message: err instanceof Error ? err.message : "排位失敗" });
        return false;
      } finally {
        setAssigningTableId(null);
      }
    },
    [applyOrders, onToast],
  );

  const autoAcceptLabel = skipTableAssignment ? "自動接單" : "自動接單（非堂食）";

  function renderCancelRequestActions(order: LedgerOnlineOrder) {
    const busy = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;
    const cancelActions = getChangeRequestActions(order);
    if (cancelActions.length === 0) return null;
    return (
      <>
        {cancelActions.map((action) => (
          <button
            key={action.key}
            className={onlineOrderActionButtonClass(action.tone, layout === "strip")}
            disabled={busy}
            onClick={() => void runAction(order, action)}
            type="button"
          >
            {busy ? "處理中…" : action.label}
          </button>
        ))}
      </>
    );
  }

  function renderModalActions(order: LedgerOnlineOrder) {
    const busy = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;
    const primary = getPrimaryOnlineOrderAction(order);

    if (hasPendingChangeRequest(order)) {
      return renderCancelRequestActions(order);
    }

    return (
      <>
        {tableAssign && isOnlineDineIn(order) ? (
          <button
            className="rounded-2xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={() => setAssigningOrderId(order.id)}
            type="button"
          >
            {onlineTableAssignLabel(order)}
          </button>
        ) : null}
        {primary ? (
          <button
            className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={() => void runAction(order, primary)}
            type="button"
          >
            {busy ? "處理中…" : primary.label}
          </button>
        ) : null}
        {rawLedgerStatus(order.status) === "pending" ? (
          <button
            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
            disabled={busy}
            onClick={() =>
              void runAction(order, {
                key: "reject",
                label: "拒單",
                tone: "slate",
                nextStatus: "cancelled",
                successMessage: "已拒絕訂單。",
              })
            }
            type="button"
          >
            拒單
          </button>
        ) : null}
      </>
    );
  }

  function renderStackActions(order: LedgerOnlineOrder) {
    return renderModalActions(order);
  }

  function renderOrderCard(order: LedgerOnlineOrder) {
    const cancelRequest = changeRequestLabel(order);
    const paymentLabel = paymentSummaryLabel(order, currency);
    const statusLabel = ledgerStatusBadgeLabel(order.status, order.fulfillmentType);
    const typeLabel = tabLabel(order.tabType);
    const busy = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;
    const primary = getPrimaryOnlineOrderAction(order);
    // 「排位」只喺堂食模式、而且係線上**堂食**單才出（快餐模式 → 出餐口自取，唔排位）。
    const showTableAssign = tableAssign && isOnlineDineIn(order);
    // ⚠️ 一定要用 `quickCounter`（唔係 `skipTableAssignment`）：堂食模式一樣傳 skipTableAssignment=true，
    // 用錯會令堂食單嘅枱位標籤變成「出餐口自取」，睇落好似唔需要排位。
    const tableBadge = onlineTableBadge(order, { quickMode: quickCounter });
    // 雙標籤（同 docs/113 快餐做法一致）：付款維度「已結帳（綠）」＋枱位維度「待安排座位 / 枱名」。
    const dineInBadges = isOnlineDineIn(order) ? (
      <div className="flex flex-wrap items-center gap-1">
        {[onlinePaymentBadge(order), tableBadge].map((item) => (
          <span
            key={item.label}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.bgClass} ${item.textClass}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${item.dotClass}`} />
            {item.label}
          </span>
        ))}
      </div>
    ) : null;

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
          <div className="mt-2 flex items-baseline justify-between gap-2 text-xs">
            <span className="text-slate-600">{paymentLabel}</span>
            {order.discountAmount && order.discountAmount > 0 ? (
              <span className="font-semibold text-amber-700">已優惠 -{formatMoney(order.discountAmount, currency)}</span>
            ) : null}
          </div>
          {cancelRequest ? (
            <div className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-700">{cancelRequest}</div>
          ) : null}
          {order.itemSummary ? <div className="mt-1 truncate text-xs text-slate-500">{order.itemSummary}</div> : null}
          {dineInBadges ? <div className="mt-1">{dineInBadges}</div> : null}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              className="rounded-xl bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white"
              onClick={() => setViewingOrderId(order.id)}
              type="button"
            >
              查看
            </button>
            {showTableAssign ? (
              <button
                className={onlineOrderActionButtonClass("orange", true)}
                disabled={busy}
                onClick={() => setAssigningOrderId(order.id)}
                type="button"
              >
                {onlineTableAssignLabel(order)}
              </button>
            ) : null}
            {hasPendingChangeRequest(order) ? (
              renderCancelRequestActions(order)
            ) : (
              <>
                {primary ? (
                  <button
                    className={onlineOrderActionButtonClass(primary.tone, true)}
                    disabled={busy}
                    onClick={() => void runAction(order, primary)}
                    type="button"
                  >
                    {busy ? "處理中…" : primary.label}
                  </button>
                ) : null}
                {rawLedgerStatus(order.status) === "pending" ? (
                  <button
                    className={onlineOrderActionButtonClass("slate", true)}
                    disabled={busy}
                    onClick={() => void runAction(order, { key: "reject", label: "拒單", tone: "slate", nextStatus: "cancelled", successMessage: "已拒絕訂單。" })}
                    type="button"
                  >
                    拒單
                  </button>
                ) : null}
              </>
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
            {order.discountAmount && order.discountAmount > 0 ? (
              <div className="mt-1 text-xs font-semibold text-amber-700 tabular-nums">
                已優惠 -{formatMoney(order.discountAmount, currency)}
              </div>
            ) : null}
            {cancelRequest ? <div className="mt-1 text-xs font-semibold text-rose-600">{cancelRequest}</div> : null}
            {order.itemSummary ? <div className="mt-2 truncate text-xs text-slate-500">{order.itemSummary}</div> : null}
            {dineInBadges ? <div className="mt-2">{dineInBadges}</div> : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
              onClick={() => setViewingOrderId(order.id)}
              type="button"
            >
              查看
            </button>
            {/* ⚠️ stack 版面嘅「排位」掣由 `renderStackActions() → renderModalActions()` 出，
                呢度唔可以再加，否則會出現兩粒（strip 版面唔行 renderModalActions，所以要自己出）。 */}
            {/* ⚠️ stack 版面嘅「排位」掣由 `renderStackActions() → renderModalActions()` 出，
                呢度唔可以再加，否則會出現兩粒。 */}
            {renderStackActions(order)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={layout === "strip" ? "grid gap-2" : "grid gap-3"}>
      {showAutoAcceptControls ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-500">{autoAcceptLabel}</div>
          {onAutoAcceptChange ? (
            <button
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                autoAccept ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => onAutoAcceptChange(!autoAccept)}
              type="button"
            >
              {autoAccept ? "開" : "關"}
            </button>
          ) : null}
        </div>
      ) : null}

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

      {assigningOrder ? (
        <TableAssignModal
          busyTableId={assigningTableId}
          description={
            needsTableAssignment(assigningOrder, { quickMode: quickCounter })
              ? "選擇桌台後會將線上單轉到該枱，並補印一張帶枱名嘅廚房單。"
              : `現時：${onlineTableBadge(assigningOrder, { quickMode: quickCounter }).label}。選擇新桌台即改枱。`
          }
          occupiedTableIds={occupiedTableIds}
          onClose={() => setAssigningOrderId(null)}
          onSelect={(table) => void assignTable(assigningOrder, table)}
          tables={tables}
          title={`${onlineTableAssignLabel(assigningOrder)} · ${orderCodeLabel(assigningOrder)}`}
        />
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

      {viewingOrder ? (
        <ResponsiveModal
          actions={renderModalActions(viewingOrder)}
          description={`${orderCodeLabel(viewingOrder)} · ${tabLabel(viewingOrder.tabType)} · ${ledgerStatusLabel(viewingOrder.status, viewingOrder.fulfillmentType)}`}
          onClose={() => setViewingOrderId(null)}
          title="線上訂單詳情"
          widthClassName="max-w-md"
        >
          <div className="grid gap-2 text-sm text-slate-700">
            <div>客戶：{viewingOrder.customerName ?? "--"}</div>
            <div>電話：{viewingOrder.phone ?? "--"}</div>
            {viewingOrder.deliveryAddress ? <div>地址：{viewingOrder.deliveryAddress}</div> : null}
            {viewingOrder.note ? <div>備註：{viewingOrder.note}</div> : null}
            <div>
              支付：{paymentModeLabel(viewingOrder.paymentMode)} ·{" "}
              {viewingOrder.paymentStatus === "paid" ? "已支付" : "未支付"}
            </div>
            {/* 折扣指示（用戶要求所有訂單明細位都要見到「折扣多少」） */}
            {viewingOrder.discountAmount && viewingOrder.discountAmount > 0 ? (
              <div className="flex items-baseline justify-between">
                <span className="font-semibold text-amber-700">已優惠</span>
                <span className="font-semibold text-amber-700 tabular-nums">
                  -{formatMoney(viewingOrder.discountAmount, currency)}
                </span>
              </div>
            ) : null}
            <div className="font-semibold text-slate-900">{formatMoney(viewingOrder.total, currency)}</div>
            {detailLoading ? <div className="text-slate-500">載入品項…</div> : null}
            {detailItems?.map((item) => {
              const itemHasDiscount =
                item.discountRate != null ||
                (item.discountAvos != null && item.discountAvos > 0);
              return (
                <div
                  key={`${item.name}-${item.qty}`}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>
                    {item.name} × {item.qty}
                    {itemHasDiscount ? (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        {item.discountRate != null ? `${item.discountRate}% off` : "已優惠"}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
