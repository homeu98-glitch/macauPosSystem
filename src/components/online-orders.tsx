"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { loadPosLocalSettings, savePosLocalSettings } from "@/lib/storage";

type OrderTypeKey = "all" | "dine_in" | "pickup" | "self_delivery" | "rider_delivery";

type OnlineOrder = {
  id: string;
  sourceId?: string;
  type: OrderTypeKey;
  status: string;
  paymentStatus?: "paid" | "unpaid";
  paidAmount?: number;
  customerName?: string;
  phone?: string;
  total?: number;
  createdAt?: string;
  items?: Array<{ name: string; qty: number }>;
  riderFee?: number;
  riderNote?: string;
};

const TABS: Array<{ key: OrderTypeKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "dine_in", label: "堂食" },
  { key: "pickup", label: "外賣自取" },
  { key: "self_delivery", label: "自送" },
  { key: "rider_delivery", label: "車手送單" },
];

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

function normalizeOrderStatus(status: string) {
  const s = String(status).toLowerCase();
  if (s.includes("cancel")) return "cancelled";
  if (s === "completed" || s === "done" || s === "settled") return "completed";
  if (s === "accepted" || s === "preparing") return "preparing";
  return "new";
}

function statusLabel(status: string) {
  const normalized = normalizeOrderStatus(status);
  if (normalized === "cancelled") return "已取消";
  if (normalized === "completed") return "已完成";
  if (normalized === "preparing") return "製作中";
  return "新單";
}

function orderCodeLabel(order: Pick<OnlineOrder, "id" | "type">) {
  const raw = String(order.id ?? "");
  const suffix = raw.includes("-") ? raw.split("-").slice(1).join("-") : raw;
  if (/^ONL-/i.test(raw)) {
    return `線上單 ${suffix}`;
  }
  if (/^online-/i.test(raw)) {
    return `線上單 ${suffix}`;
  }
  if (order.type === "pickup") return `自取單 ${suffix}`;
  if (order.type === "self_delivery") return `自送單 ${suffix}`;
  if (order.type === "rider_delivery") return `車手單 ${suffix}`;
  if (order.type === "dine_in") return `堂食線上單 ${suffix}`;
  return `線上單 ${suffix}`;
}

export function OnlineOrders() {
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings());
  const autoAccept = localSettings.onlineOrderSettings.autoAccept;
  const [activeTab, setActiveTab] = useState<OrderTypeKey>("all");
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [riderModalOrderId, setRiderModalOrderId] = useState<string | null>(null);
  const [riderFee, setRiderFee] = useState("");
  const [riderNote, setRiderNote] = useState("");
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const hasInitializedSnapshotRef = useRef(false);

  const viewingOrder = useMemo(
    () => (viewingOrderId ? orders.find((item) => item.id === viewingOrderId) ?? null : null),
    [orders, viewingOrderId],
  );
  const tables = useMemo(
    () => localSettings.floors.flatMap((floor) => floor.tables.map((table) => ({ ...table, floorName: floor.name }))),
    [localSettings.floors],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    // iOS/Safari 需要用戶互動後才允許播放聲音
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

  useEffect(() => {
    function onLocalSettingsChanged(event: Event) {
      const detail = (event as CustomEvent<{ localSettings?: ReturnType<typeof loadPosLocalSettings> }>).detail;
      if (detail?.localSettings) {
        setLocalSettings(detail.localSettings);
      } else {
        setLocalSettings(loadPosLocalSettings());
      }
    }
    window.addEventListener("pos-local-settings-changed", onLocalSettingsChanged as EventListener);
    return () => window.removeEventListener("pos-local-settings-changed", onLocalSettingsChanged as EventListener);
  }, []);

  const playSound = useCallback((kind: "new_order" | "new_delivery" | "cancel_order") => {
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
  }, [audioReady]);

  function isCancelStatus(status: string) {
    const s = status.toLowerCase();
    return s.includes("cancel") || s.includes("canceled") || s.includes("cancelled");
  }

  async function writeBackOrder(payload: {
    action:
      | "accept"
      | "complete"
      | "assign_table"
      | "auto_accept"
      | "handoff_to_rider"
      | "cancel"
      | "confirm_customer_cancel"
      | "reject_customer_cancel";
    orderId?: string;
    orderIds?: string[];
    tableName?: string;
    tableId?: string;
    riderFee?: number;
    riderNote?: string;
  }) {
    const response = await fetch("/api/online-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      throw new Error(result.error ?? "寫回失敗");
    }
  }

  useEffect(() => {
    let cancelled = false;
    let prevSnapshot: Array<{ id: string; sourceId?: string; status: string; type: OrderTypeKey }> = [];

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/online-orders?type=${activeTab}`);
        const payload = (await response.json()) as {
          ok: boolean;
          orders: OnlineOrder[];
          error?: string;
        };

        if (!payload.ok) {
          throw new Error(payload.error ?? "讀取線上訂單失敗");
        }

        if (!cancelled) {
          // 聲音：新單 / 取消單
          const currentRaw = payload.orders ?? [];
          const prevIds = new Set(prevSnapshot.map((row) => row.sourceId ?? row.id));
          const newOrders = currentRaw.filter((row) => !prevIds.has(row.sourceId ?? row.id));
          const cancelOrders = currentRaw.filter((row) => {
            const id = row.sourceId ?? row.id;
            const prev = prevSnapshot.find((p) => (p.sourceId ?? p.id) === id);
            if (!prev) return false;
            return !isCancelStatus(prev.status) && isCancelStatus(row.status);
          });

          if (hasInitializedSnapshotRef.current) {
            if (cancelOrders.length > 0) {
              playSound("cancel_order");
            } else if (newOrders.length > 0) {
              const hasDelivery = newOrders.some((row) => row.type === "self_delivery" || row.type === "rider_delivery");
              playSound(hasDelivery ? "new_delivery" : "new_order");
            }
          }

          const baseOrders = (payload.orders ?? []).map((order) =>
            autoAccept && order.status === "new" && order.type !== "dine_in"
              ? { ...order, status: "accepted" }
              : order,
          );
          if (autoAccept) {
            const newOrderIds = (payload.orders ?? [])
              .filter((order) => order.status === "new" && order.type !== "dine_in")
              .map((order) => order.sourceId ?? order.id);
            if (newOrderIds.length > 0) {
              void writeBackOrder({ action: "auto_accept", orderIds: newOrderIds }).catch((err) =>
                setToast({ tone: "error", message: err instanceof Error ? err.message : "自動接單回寫失敗" }),
              );
            }
          }
          setOrders(baseOrders);
          prevSnapshot = currentRaw.map((row) => ({
            id: row.id,
            sourceId: row.sourceId,
            status: row.status,
            type: row.type,
          }));
          hasInitializedSnapshotRef.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "讀取失敗");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    const timer = window.setInterval(load, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTab, autoAccept, playSound]);

  const stats = useMemo(() => {
    const effectiveOrders = orders.map((order) => ({
      ...order,
      status: statusMap[order.id] ?? order.status,
    }));
    const total = effectiveOrders.length;
    const pending = effectiveOrders.filter((order) => normalizeOrderStatus(order.status) === "new").length;
    return { total, pending };
  }, [orders, statusMap]);

  async function acceptOrder(order: OnlineOrder) {
    try {
      if (order.type === "dine_in") {
        setAssigningOrderId(order.id);
        return;
      }
      if (normalizeOrderStatus(statusMap[order.id] ?? order.status) !== "preparing") {
        await writeBackOrder({
          action: "accept",
          orderId: order.sourceId ?? order.id,
        });
      }

      setStatusMap((current) => ({ ...current, [order.id]: "preparing" }));
      setToast({ tone: "success", message: "已接單，進入製作中。" });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "接單回寫失敗" });
    }
  }

  async function assignDineInTable(order: OnlineOrder, tableId: string, tableName: string) {
    try {
      await writeBackOrder({
        action: "assign_table",
        orderId: order.sourceId ?? order.id,
        tableId,
        tableName,
      });
      setStatusMap((current) => ({ ...current, [order.id]: "preparing" }));
      setOrders((current) => current.filter((row) => row.id !== order.id));
      setAssigningOrderId(null);
      setViewingOrderId(null);
      setToast({ tone: "success", message: `已接單並安排到 ${tableName}。` });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "安排桌台失敗" });
    }
  }

  async function completeOrder(order: OnlineOrder) {
    try {
      await writeBackOrder({ action: "complete", orderId: order.sourceId ?? order.id });
      setStatusMap((current) => ({ ...current, [order.id]: "completed" }));
      setOrders((current) => current.map((row) => (row.id === order.id ? { ...row, status: "completed" } : row)));
      setToast({ tone: "success", message: "訂單已完成。" });
      setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "完成訂單失敗" });
    }
  }

  async function confirmRiderHandoff() {
    if (!riderModalOrderId) return;
    const order = orders.find((item) => item.id === riderModalOrderId);
    if (!order) return;

    const feeValue = Number(riderFee);
    const fee = Number.isFinite(feeValue) && feeValue > 0 ? feeValue : 0;

    try {
      await writeBackOrder({
        action: "handoff_to_rider",
        orderId: order.sourceId ?? order.id,
        riderFee: fee,
        riderNote: riderNote.trim() || undefined,
      });

      setOrders((current) =>
        current
          .map((row) =>
            row.id === order.id
              ? {
                  ...row,
                  type: "rider_delivery" as const,
                  status: "accepted",
                  riderFee: fee,
                  riderNote: riderNote.trim(),
                }
              : row,
          )
          .filter((row) => !(activeTab === "self_delivery" && row.id === order.id)),
      );
      setToast({ tone: "success", message: "已轉為車手送單。" });
      setRiderModalOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "轉車手送單失敗" });
    }
  }

  async function cancelOrder(order: OnlineOrder) {
    const ok = window.confirm("確定要取消這張訂單？");
    if (!ok) return;
    try {
      await writeBackOrder({ action: "cancel", orderId: order.sourceId ?? order.id });
      setOrders((current) => current.map((row) => (row.id === order.id ? { ...row, status: "cancelled_by_merchant" } : row)));
      setToast({ tone: "success", message: "已取消訂單，已回寫主系統。" });
      setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "取消訂單失敗" });
    }
  }

  async function confirmCustomerCancel(order: OnlineOrder) {
    try {
      await writeBackOrder({ action: "confirm_customer_cancel", orderId: order.sourceId ?? order.id });
      setOrders((current) => current.map((row) => (row.id === order.id ? { ...row, status: "cancelled_by_customer" } : row)));
      setToast({ tone: "success", message: "已確認客人取消。" });
      setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "操作失敗" });
    }
  }

  async function rejectCustomerCancel(order: OnlineOrder) {
    try {
      await writeBackOrder({ action: "reject_customer_cancel", orderId: order.sourceId ?? order.id });
      setOrders((current) => current.map((row) => (row.id === order.id ? { ...row, status: "cancel_rejected" } : row)));
      setToast({ tone: "success", message: "已不認同取消。" });
      setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "操作失敗" });
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">線上訂單</div>
                <div className="mt-1 text-sm text-slate-500">
                  類型：{TABS.find((tab) => tab.key === activeTab)?.label} · 共 {stats.total} 張 · 新單{" "}
                  {stats.pending} 張
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="mr-2 flex items-center gap-2 rounded-full bg-slate-100 px-3 py-2">
                  <span className="text-xs font-semibold text-slate-600">自動接單</span>
                  <button
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      autoAccept ? "bg-emerald-600 text-white" : "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
                    }`}
                    onClick={() => {
                      const nextSettings = {
                        ...localSettings,
                        onlineOrderSettings: { ...localSettings.onlineOrderSettings, autoAccept: !autoAccept },
                      };
                      setLocalSettings(nextSettings);
                      savePosLocalSettings(nextSettings);
                    }}
                    type="button"
                  >
                    {autoAccept ? "開" : "關"}
                  </button>
                </div>
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      tab.key === activeTab
                        ? "bg-orange-500 text-white"
                        : "bg-slate-100 text-slate-700"
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
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                正在載入…
              </div>
            ) : null}

            {!loading && orders.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                目前沒有訂單
              </div>
            ) : null}

            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {orders.map((order) => {
                const effectiveStatus = statusMap[order.id] ?? order.status;
                const normalizedStatus = normalizeOrderStatus(effectiveStatus);
                return (
                <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {order.createdAt ? order.createdAt.replace("T", " ").slice(0, 16) : "--"}
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        normalizedStatus === "completed"
                          ? "bg-slate-100 text-slate-700"
                          : normalizedStatus === "cancelled"
                            ? "bg-red-50 text-red-700"
                            : normalizedStatus === "preparing"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-orange-50 text-orange-700"
                      }`}
                    >
                      {statusLabel(effectiveStatus)}
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-slate-700">
                    {order.customerName ? `客戶：${order.customerName}` : "客戶：--"}
                  </div>
                  <div className="mt-1 text-sm text-slate-700">
                    支付：{" "}
                    <span className={order.paymentStatus === "paid" ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                      {order.paymentStatus === "paid" ? "已支付" : "未支付"}
                    </span>
                    {order.paymentStatus === "paid" ? (
                      <span className="text-slate-500">（{formatMoney(order.paidAmount ?? order.total ?? 0)}）</span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-slate-500">{order.type === "dine_in" ? "堂食訂單" : "非堂食訂單"}</div>
                  <div className="mt-2 text-sm font-semibold text-slate-900">
                    {typeof order.total === "number" ? formatMoney(order.total) : "金額：--"}
                  </div>
                  {order.items?.length ? (
                    <div className="mt-3 grid gap-1 text-xs text-slate-600">
                      {order.items.slice(0, 4).map((item) => (
                        <div key={item.name} className="flex items-center justify-between">
                          <span>{item.name}</span>
                          <span>x{item.qty}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div
                    className={`mt-4 grid gap-2 ${
                      normalizedStatus === "new" ? "grid-cols-3" : normalizedStatus === "preparing" ? "grid-cols-2" : "grid-cols-1"
                    }`}
                  >
                    <button
                      className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                      onClick={() => setViewingOrderId(order.id)}
                      type="button"
                    >
                      查看
                    </button>
                    {normalizedStatus === "new" ? (
                      <>
                        <button
                          className="rounded-2xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
                          onClick={() => void acceptOrder(order)}
                          type="button"
                        >
                          {order.type === "dine_in" ? "接單並安排桌台" : "接單"}
                        </button>
                        <button
                          className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                          onClick={() => void cancelOrder(order)}
                          type="button"
                        >
                          取消
                        </button>
                      </>
                    ) : null}
                    {normalizedStatus === "preparing" ? (
                      <button
                        className="rounded-2xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                        onClick={() => void completeOrder(order)}
                        type="button"
                      >
                        已完成
                      </button>
                    ) : null}
                  </div>
                </article>
              )})}
            </div>
          </div>
        </main>
      </div>

      {assigningOrderId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">安排堂食桌台</div>
                <div className="mt-1 text-sm text-slate-500">接单后，把这张线上堂食单直接安排到桌台，不会再留在右侧待操作区。</div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setAssigningOrderId(null)}
                type="button"
              >
                关闭
              </button>
            </div>
            <div className="mt-4 grid max-h-[60vh] grid-cols-2 gap-2 overflow-auto md:grid-cols-4">
              {tables.map((table) => (
                <button
                  key={table.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300 hover:bg-orange-50"
                  onClick={() => {
                    const order = orders.find((item) => item.id === assigningOrderId);
                    if (!order) return;
                    const tableName = `${table.floorName} · ${table.name}`;
                    void assignDineInTable(order, table.id, tableName);
                  }}
                  type="button"
                >
                  <div>{table.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{table.floorName}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {riderModalOrderId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">給車手接送</div>
                <div className="mt-1 text-sm text-slate-500">設定車手價錢與備註，確認後會轉成車手送單。</div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setRiderModalOrderId(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">給車手價錢（MOP）</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  inputMode="decimal"
                  onChange={(event) => setRiderFee(event.target.value)}
                  placeholder="例如：20"
                  value={riderFee}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">備註</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setRiderNote(event.target.value)}
                  placeholder="例如：請先致電客人"
                  value={riderNote}
                />
              </label>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setRiderModalOrderId(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() => void confirmRiderHandoff()}
                type="button"
              >
                確認轉車手送單
              </button>
            </div>
          </div>
        </div>
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">訂單詳情</div>
                <div className="mt-1 text-sm text-slate-500">
                  {orderCodeLabel(viewingOrder)} · {TABS.find((tab) => tab.key === viewingOrder.type)?.label ?? viewingOrder.type}
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setViewingOrderId(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4 grid gap-2 text-sm text-slate-700">
              <div>客戶：{viewingOrder.customerName ?? "--"}</div>
              <div>電話：{viewingOrder.phone ?? "--"}</div>
              <div>
                支付：
                <span
                  className={
                    viewingOrder.paymentStatus === "paid"
                      ? "ml-2 font-semibold text-emerald-700"
                      : "ml-2 font-semibold text-amber-700"
                  }
                >
                  {viewingOrder.paymentStatus === "paid" ? "已支付" : "未支付"}
                </span>
                {typeof viewingOrder.paidAmount === "number" ? (
                  <span className="ml-2 text-slate-500">（{formatMoney(viewingOrder.paidAmount)}）</span>
                ) : null}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">菜品明細</div>
              <div className="mt-3 grid gap-2">
                {viewingOrder.items?.length ? (
                  viewingOrder.items.map((item) => (
                    <div key={item.name} className="flex items-center justify-between text-sm text-slate-700">
                      <span>{item.name}</span>
                      <span className="font-semibold">x{item.qty}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-slate-500">--</div>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
                <span>總計</span>
                <span className="text-base font-semibold text-slate-900">
                  {typeof viewingOrder.total === "number" ? formatMoney(viewingOrder.total) : "--"}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {(() => {
                const s = String(viewingOrder.status).toLowerCase();
                return s.includes("cancel") && s.includes("customer");
              })() ? (
                <>
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => void rejectCustomerCancel(viewingOrder)}
                    type="button"
                  >
                    不認同取消
                  </button>
                  <button
                    className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => void confirmCustomerCancel(viewingOrder)}
                    type="button"
                  >
                    確認取消
                  </button>
                </>
              ) : normalizeOrderStatus(statusMap[viewingOrder.id] ?? viewingOrder.status) === "new" ? (
                <>
                  <button
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                    onClick={() => void cancelOrder(viewingOrder)}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                    onClick={() => void acceptOrder(viewingOrder)}
                    type="button"
                  >
                    {viewingOrder.type === "dine_in" ? "接單並安排桌台" : "接單"}
                  </button>
                </>
              ) : normalizeOrderStatus(statusMap[viewingOrder.id] ?? viewingOrder.status) === "preparing" ? (
                <button
                  className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => void completeOrder(viewingOrder)}
                  type="button"
                >
                  已完成
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
