"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  saveBootstrapCache,
  saveOrders,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { MenuItem, OrderItem, PosBootstrap, PosOrder, PrintJob, QueueEvent } from "@/lib/types";

type Toast = {
  tone: "info" | "success";
  message: string;
};

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function formatMoney(amount: number, currency: string) {
  return `${currency} ${amount.toFixed(0)}`;
}

function orderTotals(items: OrderItem[], bootstrap: PosBootstrap) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const serviceChargeAmount = subtotal * bootstrap.rules.serviceChargeRate;
  const taxAmount = subtotal * bootstrap.rules.taxRate;
  const total = subtotal + serviceChargeAmount + taxAmount;

  return { subtotal, serviceChargeAmount, taxAmount, total };
}

export function PosApp() {
  const cachedBootstrap = loadBootstrapCache();
  const initialHasBootstrapRef = useRef(Boolean(cachedBootstrap));
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(() => cachedBootstrap);
  const [activeTableId, setActiveTableId] = useState<string>(() => cachedBootstrap?.tables[0]?.id ?? "");
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [networkOnline, setNetworkOnline] = useState(true);
  const [queue, setQueue] = useState<QueueEvent[]>(() => loadQueue());
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [toast, setToast] = useState<Toast | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(() => !loadBootstrapCache());
  const [activeCategoryId, setActiveCategoryId] = useState<string>(() => cachedBootstrap?.categories[0]?.id ?? "");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [discountValue, setDiscountValue] = useState("0");
  const [receivedAmount, setReceivedAmount] = useState("");

  useEffect(() => {
    async function bootstrapApp() {
      try {
        const response = await fetch("/api/pos/bootstrap");
        const data = (await response.json()) as PosBootstrap;
        saveBootstrapCache(data);
        setBootstrap(data);
        setActiveTableId((current) => current || data.tables[0]?.id || "");
      } catch {
        if (!initialHasBootstrapRef.current) {
          setToast({ tone: "info", message: "未能連到設定來源，請稍後再試。" });
        }
      } finally {
        setIsBootstrapping(false);
      }
    }

    bootstrapApp();
  }, []);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeTable = useMemo(
    () => bootstrap?.tables.find((table) => table.id === activeTableId) ?? null,
    [bootstrap, activeTableId],
  );

  const totals = useMemo(
    () => (bootstrap ? orderTotals(cartItems, bootstrap) : { subtotal: 0, serviceChargeAmount: 0, taxAmount: 0, total: 0 }),
    [bootstrap, cartItems],
  );

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);

  const effectiveCategoryId = useMemo(() => {
    if (!bootstrap) return "";
    return activeCategoryId || bootstrap.categories[0]?.id || "";
  }, [activeCategoryId, bootstrap]);

  const filteredMenuItems = useMemo(() => {
    if (!bootstrap) return [];

    const keyword = searchKeyword.trim();
    const base = bootstrap.menuItems.filter((item) =>
      effectiveCategoryId ? item.categoryId === effectiveCategoryId : true,
    );
    if (!keyword) return base;

    return base.filter((item) => item.name.includes(keyword));
  }, [bootstrap, effectiveCategoryId, searchKeyword]);

  const recentOrders = useMemo(() => orders.slice(0, 5), [orders]);
  const pendingQueue = useMemo(() => queue.filter((event) => event.status !== "synced"), [queue]);
  const openOrders = useMemo(
    () => orders.filter((order) => order.status === "draft" || order.status === "sent_to_kitchen"),
    [orders],
  );
  const tableOrderMap = useMemo(
    () =>
      new Map(
        openOrders
          .slice()
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((order) => [order.tableId, order]),
      ),
    [openOrders],
  );
  const activeOrder = useMemo(() => {
    if (activeOrderId) {
      return orders.find((order) => order.id === activeOrderId && order.status !== "settled") ?? null;
    }
    return (activeTableId ? tableOrderMap.get(activeTableId) : null) ?? null;
  }, [activeOrderId, activeTableId, orders, tableOrderMap]);
  const unsettledOrder = useMemo(
    () => orders.find((order) => order.status === "sent_to_kitchen") ?? null,
    [orders],
  );
  const currentSettlementOrder =
    (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
    (activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
    unsettledOrder;
  const discountAmount = useMemo(() => {
    const value = Number(discountValue);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [discountValue]);
  const paymentBase = activeOrder && cartItems.length === 0
    ? {
        subtotal: activeOrder.subtotal,
        serviceChargeAmount: activeOrder.serviceChargeAmount,
        taxAmount: activeOrder.taxAmount,
        total: activeOrder.subtotal + activeOrder.serviceChargeAmount + activeOrder.taxAmount,
      }
    : totals;
  const paymentSummary = {
    subtotal: paymentBase.subtotal,
    serviceChargeAmount: paymentBase.serviceChargeAmount,
    taxAmount: paymentBase.taxAmount,
    discountAmount,
    total: Math.max(0, paymentBase.total - discountAmount),
  };
  const changeDue = useMemo(() => {
    const received = Number(receivedAmount);
    if (!Number.isFinite(received) || received <= 0) return 0;
    return Math.max(0, received - paymentSummary.total);
  }, [receivedAmount, paymentSummary.total]);
  const selectedTableStatus = activeTableId ? tableOrderMap.get(activeTableId)?.status ?? "idle" : "idle";

  function persistOrders(nextOrders: PosOrder[]) {
    setOrders(nextOrders);
    saveOrders(nextOrders);
  }

  function persistQueue(nextQueue: QueueEvent[]) {
    setQueue(nextQueue);
    saveQueue(nextQueue);
  }

  function persistPrintJobs(nextPrintJobs: PrintJob[]) {
    setPrintJobs(nextPrintJobs);
    savePrintJobs(nextPrintJobs);
  }

  function loadOrderIntoWorkspace(order: PosOrder | null, tableId: string) {
    setActiveTableId(tableId);
    setActiveOrderId(order?.id ?? null);
    setPayingOrderId(order?.status === "sent_to_kitchen" ? order.id : null);
    setCartItems(order?.items ?? []);
    setSelectedItemId("");
    setNoteDraft("");
    setDiscountValue(String(order?.discountAmount ?? 0));
    setReceivedAmount("");
  }

  function selectTable(tableId: string) {
    const order = tableOrderMap.get(tableId) ?? null;
    loadOrderIntoWorkspace(order, tableId);
  }

  function upsertCurrentOrder(nextStatus: "draft" | "sent_to_kitchen", allowEmpty = false) {
    if (!bootstrap || !activeTable) return null;
    if (!allowEmpty && cartItems.length === 0) return null;

    const timestamp = new Date().toISOString();
    const baseTotals = orderTotals(cartItems, bootstrap);
    const existingOrder =
      (activeOrderId ? orders.find((order) => order.id === activeOrderId && order.status !== "settled") : null) ??
      tableOrderMap.get(activeTable.id) ??
      null;

    const order: PosOrder = existingOrder
      ? {
          ...existingOrder,
          tableId: activeTable.id,
          tableName: activeTable.name,
          status: nextStatus,
          items: cartItems,
          subtotal: baseTotals.subtotal,
          serviceChargeAmount: baseTotals.serviceChargeAmount,
          taxAmount: baseTotals.taxAmount,
          discountAmount,
          total: Math.max(0, baseTotals.total - discountAmount),
          updatedAt: timestamp,
        }
      : {
          id: uid("order"),
          localOrderNo: `POS-${new Date().getTime().toString().slice(-6)}`,
          tableId: activeTable.id,
          tableName: activeTable.name,
          status: nextStatus,
          items: cartItems,
          subtotal: baseTotals.subtotal,
          serviceChargeAmount: baseTotals.serviceChargeAmount,
          taxAmount: baseTotals.taxAmount,
          discountAmount,
          total: Math.max(0, baseTotals.total - discountAmount),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    const nextOrders = existingOrder
      ? orders.map((current) => (current.id === order.id ? order : current))
      : [order, ...orders];

    persistOrders(nextOrders);
    setActiveOrderId(order.id);
    return order;
  }

  function openTable() {
    if (!activeTable) return;

    const existingOrder = tableOrderMap.get(activeTable.id) ?? null;
    if (existingOrder) {
      loadOrderIntoWorkspace(existingOrder, activeTable.id);
      setToast({ tone: "info", message: `已打開 ${activeTable.name} 的當前訂單。` });
      return;
    }

    const order = upsertCurrentOrder("draft", true);
    if (!order) return;

    setToast({ tone: "success", message: `${activeTable.name} 已開台。` });
  }

  function addMenuItem(item: MenuItem) {
    setCartItems((current) => {
      const existing = current.find((cartItem) => cartItem.menuItemId === item.id && !cartItem.note);
      if (existing) {
        return current.map((cartItem) =>
          cartItem.menuItemId === item.id && !cartItem.note
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem,
        );
      }

      return [
        ...current,
        {
          menuItemId: item.id,
          name: item.name,
          quantity: 1,
          price: item.price,
          printerGroup: item.printerGroup,
        },
      ];
    });
  }

  function updateQuantity(menuItemId: string, delta: number) {
    setCartItems((current) =>
      current
        .map((item) =>
          item.menuItemId === menuItemId ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item,
        )
        .filter((item) => item.quantity > 0),
    );
  }

  function applyNote() {
    if (!selectedItemId || !noteDraft.trim()) return;

    setCartItems((current) =>
      current.map((item) =>
        item.menuItemId === selectedItemId ? { ...item, note: noteDraft.trim() } : item,
      ),
    );
    setNoteDraft("");
    setToast({ tone: "success", message: "已更新菜品備註。" });
  }

  async function syncNow(nextQueue: QueueEvent[]) {
    if (!networkOnline || nextQueue.length === 0) {
      return;
    }

    try {
      await fetch("/api/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: nextQueue }),
      });

      const synced = nextQueue.map((event) => ({ ...event, status: "synced" as const }));
      persistQueue(synced);
      setToast({ tone: "success", message: `已同步 ${synced.length} 筆待辦資料。` });
    } catch {
      setToast({ tone: "info", message: "同步暫時失敗，資料已保留在本機。" });
    }
  }

  function pushEvents(events: QueueEvent[]) {
    const nextQueue = [...queue, ...events];
    persistQueue(nextQueue);
    void syncNow(nextQueue);
  }

  function holdOrder() {
    const order = upsertCurrentOrder("draft");
    if (!order) {
      setToast({ tone: "info", message: "請先加入菜品後再掛單。" });
      return;
    }

    setToast({ tone: "success", message: `${order.localOrderNo} 已掛單。` });
  }

  function sendToKitchen() {
    if (!bootstrap || !activeTable || cartItems.length === 0) return;

    const timestamp = new Date().toISOString();
    const order = upsertCurrentOrder("sent_to_kitchen");
    if (!order) return;

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const nextPrintJobs = configuredPrinters
      .filter((printer) => cartItems.some((item) => item.printerGroup === printer.group))
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        printerGroup: printer.group,
        printerName: printer.name,
        status: networkOnline ? "sent" : "pending",
        createdAt: timestamp,
      }));

    persistPrintJobs([...nextPrintJobs, ...printJobs]);

    const orderEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_CREATED",
      entityId: order.id,
      payload: order,
      status: networkOnline ? "synced" : "pending",
      createdAt: timestamp,
    };

    const printEvents = nextPrintJobs.map<QueueEvent>((printJob) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: printJob.id,
      payload: printJob,
      status: networkOnline ? "synced" : "pending",
      createdAt: timestamp,
    }));

    pushEvents([orderEvent, ...printEvents]);
    setActiveOrderId(order.id);
    setPayingOrderId(order.id);
    setDiscountValue(String(order.discountAmount));
    setReceivedAmount("");
    setToast({
      tone: "success",
      message: networkOnline
        ? `已送廚房單，單號 ${order.localOrderNo}。`
        : `已離線建立 ${order.localOrderNo}，待恢復網絡後補傳。`,
    });
  }

  function settleLatestOrder() {
    const targetOrder =
      activeOrder?.status === "sent_to_kitchen"
        ? activeOrder
        : orders.find((order) => order.status === "sent_to_kitchen");
    if (!targetOrder) {
      setToast({ tone: "info", message: "目前沒有待結帳訂單。" });
      return;
    }
    setPayingOrderId(targetOrder.id);
    setToast({ tone: "info", message: `已選中 ${targetOrder.localOrderNo}，可直接在右側完成收款。` });
  }

  function confirmPayment(method: PosBootstrap["rules"]["paymentMethods"][number]) {
    if (!bootstrap) return;

    const targetOrder =
      (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
      (activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
      unsettledOrder;
    if (!targetOrder) return;

    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "settled",
      paymentMethod: method,
      discountAmount,
      total: paymentSummary.total,
      updatedAt: new Date().toISOString(),
    };

    const nextOrders = orders.map((order) => (order.id === targetOrder.id ? updatedOrder : order));
    persistOrders(nextOrders);

    const paymentEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_SETTLED",
      entityId: updatedOrder.id,
      payload: {
        orderId: updatedOrder.id,
        total: updatedOrder.total,
        receivedAmount: Number(receivedAmount) || updatedOrder.total,
        changeDue,
        discountAmount,
        paymentMethod: method,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([paymentEvent]);
    setPayingOrderId(null);
    setActiveOrderId(null);
    setCartItems([]);
    setDiscountValue("0");
    setReceivedAmount("");
    setSelectedItemId("");
    setNoteDraft("");
    setToast({
      tone: "success",
      message: networkOnline
        ? `已完成 ${updatedOrder.localOrderNo} 結帳。`
        : `已離線記錄 ${updatedOrder.localOrderNo} 付款，待補傳。`,
    });
  }

  if (isBootstrapping || !bootstrap) {
    return <div className="empty-state">正在載入門店設定…</div>;
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-[72px] shrink-0 flex-col justify-between bg-slate-900 px-2 py-3 text-white lg:flex">
          <div className="grid gap-2">
            {[
              ["首頁", "首"],
              ["點餐", "點"],
              ["掛單", "掛"],
              ["訂單", "單"],
              ["結算", "結"],
              ["報表", "報"],
            ].map(([label, short], index) => (
              <button
                key={label}
                className={`flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-semibold ${
                  index === 1 ? "bg-orange-500 text-white" : "text-slate-300 hover:bg-slate-800"
                }`}
                type="button"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">{short}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-2">
            <button
              className={`rounded-2xl px-2 py-2 text-xs font-semibold ${
                networkOnline ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
              }`}
              onClick={() => setNetworkOnline((current) => !current)}
              type="button"
            >
              {networkOnline ? "在線" : "離線"}
            </button>
            <Link
              className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-xs font-semibold text-slate-200"
              href="/settings"
            >
              設備
            </Link>
          </div>
        </aside>

        <div className="grid h-screen flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)_330px]">
          <section className="flex h-full flex-col overflow-hidden border-r border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold text-slate-900">{bootstrap.storeName}</div>
                  <div className="mt-1 text-xs text-slate-500">{deviceConfig.terminalName}</div>
                </div>
                <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                  桌號 {activeTable?.name ?? "--"}
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {bootstrap.tables.map((table) => (
                  <button
                    key={table.id}
                    className={`rounded-2xl px-3 py-2 text-left text-xs font-semibold ${
                      table.id === activeTableId
                        ? "bg-orange-50 text-orange-600 ring-1 ring-orange-200"
                        : "bg-slate-100 text-slate-600"
                    }`}
                    onClick={() => selectTable(table.id)}
                    type="button"
                  >
                    <div>{table.name}</div>
                    <div className="mt-1 text-[11px] font-medium">
                      {tableOrderMap.get(table.id)?.status === "draft"
                        ? "掛單"
                        : tableOrderMap.get(table.id)?.status === "sent_to_kitchen"
                          ? "已下單"
                          : "空閒"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-900">訂單明細</span>
                <span className="text-xs text-slate-500">{cartItems.length} 項</span>
              </div>
            </div>

            <div className="flex-1 overflow-auto px-3 pb-3">
              {cartItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                  請從右側商品區加入菜品
                </div>
              ) : (
                <div className="grid gap-2">
                  {cartItems.map((item) => (
                    <article
                      key={item.menuItemId}
                      className={`rounded-2xl border px-3 py-3 ${
                        selectedItemId === item.menuItemId ? "border-orange-300 bg-orange-50/50" : "border-slate-100 bg-slate-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          className="min-w-0 text-left"
                          onClick={() => setSelectedItemId(item.menuItemId)}
                          type="button"
                        >
                          <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {item.note || "未加備註"} · {formatMoney(item.price, bootstrap.currency)}
                          </div>
                        </button>
                        <div className="flex items-center gap-1">
                          <button
                            className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={() => updateQuantity(item.menuItemId, -1)}
                            type="button"
                          >
                            -
                          </button>
                          <div className="w-7 text-center text-sm font-semibold text-slate-800">{item.quantity}</div>
                          <button
                            className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={() => updateQuantity(item.menuItemId, 1)}
                            type="button"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 px-4 py-4">
              <label className="block text-xs font-semibold text-slate-500" htmlFor="pos-note">
                當前選中商品備註
              </label>
              <textarea
                className="mt-2 min-h-[84px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                id="pos-note"
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="例如：少飯、走甜、不要蔥"
                value={noteDraft}
              />
              <button
                className="mt-2 w-full rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={applyNote}
                type="button"
              >
                更新備註
              </button>
            </div>
          </section>

          <main className="flex h-full flex-col overflow-hidden bg-slate-100">
            <div className="border-b border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  {bootstrap.categories.map((category) => (
                    <button
                      key={category.id}
                      className={`rounded-full px-4 py-2 text-sm font-semibold ${
                        effectiveCategoryId === category.id
                          ? "bg-orange-500 text-white"
                          : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => setActiveCategoryId(category.id)}
                      type="button"
                    >
                      {category.name}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400 xl:w-72"
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder="搜尋商品"
                    value={searchKeyword}
                  />
                  <button
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                    onClick={() => setSearchKeyword("")}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {filteredMenuItems.map((item) => (
                  <button
                    key={item.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300"
                    onClick={() => addMenuItem(item)}
                    type="button"
                  >
                    <div className="flex min-h-[92px] flex-col justify-between">
                      <div>
                        <div className="line-clamp-2 text-sm font-semibold text-slate-900">{item.name}</div>
                        <div className="mt-2 text-xs text-slate-500">{item.printerGroup}</div>
                      </div>
                      <div className="mt-4 flex items-center justify-between">
                        <div className="text-base font-semibold text-slate-900">
                          {formatMoney(item.price, bootstrap.currency)}
                        </div>
                        <div className="rounded-full bg-orange-50 px-2 py-1 text-xs font-semibold text-orange-600">
                          加入
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
                {filteredMenuItems.length === 0 ? (
                  <div className="col-span-full rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                    沒有符合條件的商品
                  </div>
                ) : null}
              </div>
            </div>
          </main>

          <section className="flex h-full flex-col overflow-hidden border-l border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-4">
              <div className="text-base font-semibold text-slate-900">收銀與支付</div>
              <div className="mt-1 text-xs text-slate-500">
                {currentSettlementOrder
                  ? `待結帳單號 ${currentSettlementOrder.localOrderNo}`
                  : selectedTableStatus === "draft"
                    ? "目前為掛單狀態，可繼續加菜或送廚房"
                    : "目前未有待結帳訂單，可先開台或送廚房單"}
              </div>
            </div>

            <div className="flex-1 overflow-auto px-4 py-4">
              <div className="rounded-3xl bg-slate-50 p-4">
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>小計</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(paymentSummary.subtotal, bootstrap.currency)}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
                  <span>服務費</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(paymentSummary.serviceChargeAmount, bootstrap.currency)}
                  </span>
                </div>
                <div className="mt-4 border-t border-slate-200 pt-4">
                  <div className="mb-3 flex items-center justify-between text-sm text-slate-500">
                    <span>折扣</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(paymentSummary.discountAmount, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-500">應收</div>
                  <div className="mt-2 text-3xl font-semibold tracking-tight text-orange-600">
                    {formatMoney(paymentSummary.total, bootstrap.currency)}
                  </div>
                </div>
              </div>

              <div className="mt-5 grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    折扣金額
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-400"
                      onChange={(event) => setDiscountValue(event.target.value)}
                      placeholder="0"
                      value={discountValue}
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    實收金額
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-400"
                      onChange={(event) => setReceivedAmount(event.target.value)}
                      placeholder="0"
                      value={receivedAmount}
                    />
                  </label>
                </div>
                <div className="flex items-center justify-between rounded-2xl bg-white px-3 py-3 text-sm">
                  <span className="text-slate-500">找續</span>
                  <span className="text-lg font-semibold text-emerald-600">
                    {formatMoney(changeDue, bootstrap.currency)}
                  </span>
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-2 text-xs font-semibold text-slate-500">支付方式</div>
                <div className="grid grid-cols-3 gap-2">
                  {bootstrap.rules.paymentMethods.map((method) => (
                    <button
                      key={method}
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-700 hover:border-orange-300"
                      onClick={() => confirmPayment(method)}
                      type="button"
                    >
                      {method === "cash" ? "現金" : method === "card" ? "銀行卡" : "MPay"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={openTable}
                  type="button"
                >
                  開台
                </button>
                <button
                  className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={holdOrder}
                  type="button"
                >
                  掛單
                </button>
              </div>

              <div className="mt-2 grid gap-2">
                <button
                  className="rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600"
                  onClick={sendToKitchen}
                  type="button"
                >
                  下單並送廚房
                </button>
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800"
                  onClick={settleLatestOrder}
                  type="button"
                >
                  去結帳
                </button>
              </div>

              <div className="mt-5 grid gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">待同步</span>
                  <span className="font-semibold text-slate-900">{pendingQueue.length}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">打印任務</span>
                  <span className="font-semibold text-slate-900">{printJobs.length}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">打印設備</span>
                  <span className="font-semibold text-slate-900">
                    {deviceConfig.printers.filter((printer) => printer.enabled).length}
                  </span>
                </div>
              </div>

              {!networkOnline ? (
                <button
                  className="mt-3 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700"
                  onClick={() => {
                    setNetworkOnline(true);
                    void syncNow(queue);
                  }}
                  type="button"
                >
                  恢復網絡並補傳
                </button>
              ) : null}

              <div className="mt-5">
                <div className="mb-2 text-xs font-semibold text-slate-500">掛單 / 最近訂單</div>
                <div className="grid gap-2">
                  {recentOrders.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                      尚未建立訂單
                    </div>
                  ) : (
                    recentOrders.slice(0, 4).map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-3"
                      >
                        <div>
                          <div className="text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {order.tableName} · {formatMoney(order.total, bootstrap.currency)}
                          </div>
                        </div>
                        <div className="text-xs font-semibold text-slate-500">{order.status}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {toast ? (
        <div
          className={`fixed bottom-4 right-4 z-40 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-lg ${
            toast.tone === "success" ? "bg-emerald-600" : "bg-slate-900"
          }`}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
