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

  function sendToKitchen() {
    if (!bootstrap || !activeTable || cartItems.length === 0) return;

    const timestamp = new Date().toISOString();
    const localOrderNo = `POS-${new Date().getTime().toString().slice(-6)}`;
    const orderId = uid("order");
    const totalsValue = orderTotals(cartItems, bootstrap);

    const order: PosOrder = {
      id: orderId,
      localOrderNo,
      tableId: activeTable.id,
      tableName: activeTable.name,
      status: "sent_to_kitchen",
      items: cartItems,
      ...totalsValue,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextOrders = [order, ...orders];
    persistOrders(nextOrders);

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const nextPrintJobs = configuredPrinters
      .filter((printer) => cartItems.some((item) => item.printerGroup === printer.group))
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId,
        printerGroup: printer.group,
        printerName: printer.name,
        status: networkOnline ? "sent" : "pending",
        createdAt: timestamp,
      }));

    persistPrintJobs([...nextPrintJobs, ...printJobs]);

    const orderEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_CREATED",
      entityId: orderId,
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
    setCartItems([]);
    setSelectedItemId("");
    setToast({
      tone: "success",
      message: networkOnline
        ? `已送廚房單，單號 ${localOrderNo}。`
        : `已離線建立 ${localOrderNo}，待恢復網絡後補傳。`,
    });
  }

  function settleLatestOrder() {
    if (!bootstrap) return;

    const targetOrder = orders.find((order) => order.status === "sent_to_kitchen");
    if (!targetOrder) {
      setToast({ tone: "info", message: "目前沒有待結帳訂單。" });
      return;
    }
    setPayingOrderId(targetOrder.id);
  }

  function simulateReconnect() {
    setNetworkOnline(true);
    void syncNow(queue);
  }

  function confirmPayment(method: PosBootstrap["rules"]["paymentMethods"][number]) {
    if (!bootstrap || !payingOrderId) return;

    const targetOrder = orders.find((order) => order.id === payingOrderId);
    if (!targetOrder) return;

    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "settled",
      paymentMethod: method,
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
        paymentMethod: method,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([paymentEvent]);
    setPayingOrderId(null);
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
    <div className="min-h-screen bg-slate-100">
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex items-baseline gap-2">
              <div className="text-lg font-semibold text-slate-900">{bootstrap.storeName}</div>
              <div className="text-sm text-slate-500">{deviceConfig.terminalName}</div>
            </div>
            <button
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                networkOnline ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
              }`}
              onClick={() => setNetworkOnline((current) => !current)}
              type="button"
            >
              {networkOnline ? "在線" : "離線"}
            </button>
            <div className="hidden items-center gap-2 text-sm text-slate-600 md:flex">
              <span className="rounded-full bg-slate-100 px-3 py-1">桌號：{activeTable?.name ?? "--"}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1">版本：{bootstrap.sourceVersion}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1">待同步：{pendingQueue.length}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!networkOnline ? (
              <button
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={simulateReconnect}
                type="button"
              >
                模擬恢復並補傳
              </button>
            ) : (
              <button
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => void syncNow(queue)}
                type="button"
              >
                立即同步
              </button>
            )}
            <Link
              className="rounded-full bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
              href="/settings"
            >
              設備設定
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-4 py-3">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[220px_1fr_380px]">
          <aside className="rounded-2xl border border-slate-200 bg-white p-2">
            <div className="px-2 pb-2 text-xs font-semibold text-slate-500">分類</div>
            <div className="grid gap-1">
              {bootstrap.categories.map((category) => (
                <button
                  key={category.id}
                  className={`flex items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold ${
                    effectiveCategoryId === category.id
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                  onClick={() => setActiveCategoryId(category.id)}
                  type="button"
                >
                  <span>{category.name}</span>
                  <span className="text-xs font-medium text-slate-400">
                    {bootstrap.menuItems.filter((item) => item.categoryId === category.id).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              第一版目標：穩定落單、離線暫存、LAN/USB 打印。
            </div>
          </aside>

          <main className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">商品</h2>
                <p className="text-sm text-slate-500">點擊商品加入訂單。長備註可在右側填寫。</p>
              </div>
              <div className="flex w-full max-w-md items-center gap-2">
                <input
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500"
                  onChange={(event) => setSearchKeyword(event.target.value)}
                  placeholder="搜尋商品"
                  value={searchKeyword}
                />
                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={() => setSearchKeyword("")}
                  type="button"
                >
                  清除
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filteredMenuItems.map((item) => (
                <button
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-white p-3 text-left transition hover:border-indigo-300 hover:shadow-sm"
                  onClick={() => addMenuItem(item)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{item.printerGroup}</div>
                    </div>
                    <div className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {formatMoney(item.price, bootstrap.currency)}
                    </div>
                  </div>
                </button>
              ))}
              {filteredMenuItems.length === 0 ? (
                <div className="col-span-full rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                  沒有符合條件的商品。
                </div>
              ) : null}
            </div>
          </main>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">當前訂單</h2>
                <p className="text-sm text-slate-500">
                  {activeTable ? `${activeTable.name} · ${activeTable.area}` : "未選桌號"}
                </p>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold text-slate-500">打印機</div>
                <div className="text-sm font-semibold text-slate-700">
                  {deviceConfig.printers.filter((printer) => printer.enabled).length} 台已啟用
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              <div className="flex flex-wrap gap-2">
                {bootstrap.tables.map((table) => (
                  <button
                    key={table.id}
                    className={`rounded-full px-3 py-1 text-sm font-semibold ${
                      table.id === activeTableId
                        ? "bg-indigo-50 text-indigo-700"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                    onClick={() => setActiveTableId(table.id)}
                    type="button"
                  >
                    {table.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 max-h-[340px] overflow-auto rounded-2xl border border-slate-100 bg-slate-50 p-3">
              {cartItems.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">未加入菜品</div>
              ) : (
                <div className="grid gap-2">
                  {cartItems.map((item) => (
                    <div
                      key={item.menuItemId}
                      className={`rounded-2xl border bg-white p-3 ${
                        selectedItemId === item.menuItemId ? "border-indigo-300" : "border-slate-100"
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
                            {formatMoney(item.price, bootstrap.currency)} · {item.note || "未加備註"}
                          </div>
                        </button>
                        <div className="flex items-center gap-2">
                          <button
                            className="h-8 w-8 rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={() => updateQuantity(item.menuItemId, -1)}
                            type="button"
                          >
                            -
                          </button>
                          <div className="w-6 text-center text-sm font-semibold text-slate-700">{item.quantity}</div>
                          <button
                            className="h-8 w-8 rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={() => updateQuantity(item.menuItemId, 1)}
                            type="button"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-2">
              <label className="text-xs font-semibold text-slate-600" htmlFor="pos-note">
                菜品備註（選中項目後更新）
              </label>
              <textarea
                className="min-h-[72px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500"
                id="pos-note"
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="例如：少飯、走甜、不要蔥"
                value={noteDraft}
              />
              <button
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={applyNote}
                type="button"
              >
                更新備註
              </button>
            </div>

            <div className="mt-4 rounded-2xl bg-slate-900 p-4 text-white">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/70">小計</span>
                <span className="font-semibold">{formatMoney(totals.subtotal, bootstrap.currency)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-white/70">服務費</span>
                <span className="font-semibold">{formatMoney(totals.serviceChargeAmount, bootstrap.currency)}</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-base">
                <span className="text-white/70">合計</span>
                <span className="text-xl font-semibold">{formatMoney(totals.total, bootstrap.currency)}</span>
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              <button
                className="rounded-2xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-700"
                onClick={sendToKitchen}
                type="button"
              >
                送廚房單
              </button>
              <button
                className="rounded-2xl bg-white px-4 py-3 text-base font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                onClick={settleLatestOrder}
                type="button"
              >
                結帳
              </button>
            </div>

            <div className="mt-4 grid gap-2">
              <div className="text-xs font-semibold text-slate-500">同步狀態</div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="flex items-center justify-between">
                  <span>待同步事件</span>
                  <span className="font-semibold">{pendingQueue.length}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span>最近打印任務</span>
                  <span className="font-semibold">{printJobs.length}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">最近訂單</h3>
                <p className="text-sm text-slate-500">目前只保留在本機，之後再回寫主系統。</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {orders.length} 筆
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              {recentOrders.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                  尚未建立訂單
                </div>
              ) : (
                recentOrders.map((order) => (
                  <div key={order.id} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {order.tableName} · {formatMoney(order.total, bootstrap.currency)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-slate-600">{order.status}</div>
                      <div className="mt-1 text-xs text-slate-400">{order.updatedAt.slice(11, 16)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">同步隊列</h3>
                <p className="text-sm text-slate-500">離線時先排隊，恢復後補傳。</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {pendingQueue.length} pending
              </span>
            </div>
            <div className="mt-3 grid gap-2">
              {pendingQueue.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                  目前沒有待同步事件
                </div>
              ) : (
                pendingQueue.slice(0, 6).map((event) => (
                  <div key={event.id} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{event.type}</div>
                      <div className="mt-1 text-xs text-slate-500">{event.entityId}</div>
                    </div>
                    <div className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                      pending
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {payingOrderId ? (
        <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">選擇付款方式</h3>
                <p className="mt-1 text-sm text-slate-500">第一版只做流程，之後再接主系統入帳。</p>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setPayingOrderId(null)}
                type="button"
              >
                取消
              </button>
            </div>
            <div className="mt-4 grid gap-2">
              {bootstrap.rules.paymentMethods.map((method) => (
                <button
                  key={method}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-indigo-300"
                  onClick={() => confirmPayment(method)}
                  type="button"
                >
                  {method === "cash" ? "現金" : method === "card" ? "卡" : "MPay"}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

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
