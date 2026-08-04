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

  const menuByCategory = useMemo(() => {
    if (!bootstrap) return [];

    return bootstrap.categories.map((category) => ({
      category,
      items: bootstrap.menuItems.filter((item) => item.categoryId === category.id),
    }));
  }, [bootstrap]);

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

    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "settled",
      paymentMethod: "cash",
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
        paymentMethod: "cash",
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([paymentEvent]);
    setToast({
      tone: "success",
      message: networkOnline
        ? `已完成 ${updatedOrder.localOrderNo} 結帳。`
        : `已離線記錄 ${updatedOrder.localOrderNo} 付款，待補傳。`,
    });
  }

  function simulateReconnect() {
    setNetworkOnline(true);
    void syncNow(queue);
  }

  if (isBootstrapping || !bootstrap) {
    return <div className="empty-state">正在載入門店設定…</div>;
  }

  return (
    <div className="pos-page">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Macau POS MVP</p>
          <h1>{bootstrap.storeName} 收銀台</h1>
          <p className="hero-copy">
            第一版按「先落單送廚房，後收錢」設計，會員暫不接入，收銀規則全部來自主系統。
          </p>
        </div>
        <div className="hero-actions">
          <button
            className={`network-toggle ${networkOnline ? "online" : "offline"}`}
            onClick={() => setNetworkOnline((current) => !current)}
            type="button"
          >
            {networkOnline ? "目前在線" : "目前離線"}
          </button>
          <Link className="secondary-link" href="/settings">
            設備與打印設定
          </Link>
        </div>
      </header>

      <section className="summary-grid">
        <article className="summary-card">
          <span className="summary-label">設定來源版本</span>
          <strong>{bootstrap.sourceVersion}</strong>
          <p>{bootstrap.lastUpdatedAt.slice(0, 10)}</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">待同步事件</span>
          <strong>{pendingQueue.length}</strong>
          <p>訂單、付款、打印與設備設定</p>
        </article>
        <article className="summary-card">
          <span className="summary-label">最近打印任務</span>
          <strong>{printJobs.length}</strong>
          <p>只做 USB / LAN，不做藍牙</p>
        </article>
      </section>

      <div className="workspace">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>桌號與菜單</h2>
              <p>主系統下發的設定已快取到本機，斷網時繼續使用。</p>
            </div>
          </div>

          <div className="table-strip">
            {bootstrap.tables.map((table) => (
              <button
                key={table.id}
                className={table.id === activeTableId ? "table-chip active" : "table-chip"}
                onClick={() => setActiveTableId(table.id)}
                type="button"
              >
                {table.name}
              </button>
            ))}
          </div>

          <div className="category-sections">
            {menuByCategory.map(({ category, items }) => (
              <section key={category.id} className="category-block">
                <div className="category-title">
                  <h3>{category.name}</h3>
                  <span>{items.length} 項</span>
                </div>
                <div className="menu-grid">
                  {items.map((item) => (
                    <button key={item.id} className="menu-card" onClick={() => addMenuItem(item)} type="button">
                      <span className="menu-name">{item.name}</span>
                      <span className="menu-meta">
                        {formatMoney(item.price, bootstrap.currency)} · {item.printerGroup}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        <aside className="panel order-panel">
          <div className="panel-head">
            <div>
              <h2>當前訂單</h2>
              <p>{activeTable ? `${activeTable.name} · ${activeTable.area}` : "未選桌號"}</p>
            </div>
          </div>

          <div className="cart-list">
            {cartItems.length === 0 ? (
              <div className="empty-inline">未加入菜品。先在左邊點選品項。</div>
            ) : (
              cartItems.map((item) => (
                <div key={item.menuItemId} className="cart-row">
                  <div>
                    <button
                      className={`item-selector ${selectedItemId === item.menuItemId ? "selected" : ""}`}
                      onClick={() => setSelectedItemId(item.menuItemId)}
                      type="button"
                    >
                      {item.name}
                    </button>
                    <p>{formatMoney(item.price, bootstrap.currency)} · {item.note || "未加備註"}</p>
                  </div>
                  <div className="qty-control">
                    <button onClick={() => updateQuantity(item.menuItemId, -1)} type="button">
                      -
                    </button>
                    <span>{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.menuItemId, 1)} type="button">
                      +
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="note-box">
            <label htmlFor="item-note">菜品備註</label>
            <textarea
              id="item-note"
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="例如：少飯、走甜、不要蔥"
              rows={3}
              value={noteDraft}
            />
            <button className="ghost-button" onClick={applyNote} type="button">
              更新備註
            </button>
          </div>

          <div className="totals-box">
            <div>
              <span>小計</span>
              <strong>{formatMoney(totals.subtotal, bootstrap.currency)}</strong>
            </div>
            <div>
              <span>服務費</span>
              <strong>{formatMoney(totals.serviceChargeAmount, bootstrap.currency)}</strong>
            </div>
            <div>
              <span>合計</span>
              <strong>{formatMoney(totals.total, bootstrap.currency)}</strong>
            </div>
          </div>

          <div className="action-stack">
            <button className="primary-button" onClick={sendToKitchen} type="button">
              送廚房單
            </button>
            <button className="secondary-button" onClick={settleLatestOrder} type="button">
              現金結帳
            </button>
            {!networkOnline ? (
              <button className="ghost-button" onClick={simulateReconnect} type="button">
                模擬恢復網絡並補傳
              </button>
            ) : null}
          </div>
        </aside>
      </div>

      <div className="workspace">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>最近訂單</h2>
              <p>展示本地已落單的堂食訂單，之後再接主系統回寫。</p>
            </div>
          </div>
          <div className="history-list">
            {recentOrders.length === 0 ? (
              <div className="empty-inline">尚未建立訂單。</div>
            ) : (
              recentOrders.map((order) => (
                <article key={order.id} className="history-card">
                  <div className="history-top">
                    <strong>{order.localOrderNo}</strong>
                    <span className={`status-pill ${order.status}`}>{order.status}</span>
                  </div>
                  <p>
                    {order.tableName} · {formatMoney(order.total, bootstrap.currency)}
                  </p>
                  <small>{order.updatedAt.replace("T", " ").slice(0, 16)}</small>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>同步與打印狀態</h2>
              <p>待辦事件與打印狀態都會先本地保存，避免高峰時段漏單。</p>
            </div>
          </div>
          <div className="sync-list">
            {pendingQueue.length === 0 ? (
              <div className="empty-inline">目前沒有待同步事件。</div>
            ) : (
              pendingQueue.map((event) => (
                <article key={event.id} className="sync-row">
                  <div>
                    <strong>{event.type}</strong>
                    <p>{event.entityId}</p>
                  </div>
                  <span className="status-pill pending">{event.status}</span>
                </article>
              ))
            )}
          </div>
          <div className="print-list">
            {printJobs.slice(0, 4).map((job) => (
              <article key={job.id} className="sync-row">
                <div>
                  <strong>{job.printerName}</strong>
                  <p>{job.printerGroup}</p>
                </div>
                <span className={`status-pill ${job.status}`}>{job.status}</span>
              </article>
            ))}
          </div>
        </section>
      </div>

      {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}
    </div>
  );
}
