"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { InputPadModal } from "@/components/input-pad-modal";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadPosLocalSettings,
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
  const router = useRouter();
  const cachedBootstrap = loadBootstrapCache();
  const initialHasBootstrapRef = useRef(Boolean(cachedBootstrap));
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(() => cachedBootstrap);
  const [activeTableId, setActiveTableId] = useState<string>(() => cachedBootstrap?.tables[0]?.id ?? "");
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [networkOnline, setNetworkOnline] = useState(true);
  const [queue, setQueue] = useState<QueueEvent[]>(() => loadQueue());
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [toast, setToast] = useState<Toast | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(() => !loadBootstrapCache());
  const [activeCategoryId, setActiveCategoryId] = useState<string>(() => cachedBootstrap?.categories[0]?.id ?? "");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [discountValue, setDiscountValue] = useState("0");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [posMode, setPosMode] = useState<"tables" | "order">("tables");
  const [baseOrderItems, setBaseOrderItems] = useState<OrderItem[]>([]);
  const [activeFloorId, setActiveFloorId] = useState("");
  const [padOpen, setPadOpen] = useState(false);
  const [padMode, setPadMode] = useState<"number" | "text">("number");
  const [padTitle, setPadTitle] = useState("");
  const [padValue, setPadValue] = useState("");
  const [padApply, setPadApply] = useState<(value: string) => void>(() => () => {});
  const [itemActionKey, setItemActionKey] = useState<string | null>(null);
  const [suppressedClickKey, setSuppressedClickKey] = useState<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

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
  const localSettings = useMemo(() => loadPosLocalSettings(), []);
  const floors = localSettings.floors;
  const paymentMethods = localSettings.paymentMethods;

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
  const effectiveFloorId = activeFloorId || floors[0]?.id || "";
  const visibleTables = useMemo(
    () => floors.find((floor) => floor.id === effectiveFloorId)?.tables ?? [],
    [effectiveFloorId, floors],
  );

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
          serviceChargeAmount: 0,
        taxAmount: activeOrder.taxAmount,
          total: activeOrder.subtotal + activeOrder.taxAmount,
      }
    : totals;
  const paymentSummary = {
    subtotal: paymentBase.subtotal,
    serviceChargeAmount: 0,
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
  const isAddOnOrder = activeOrder?.status === "sent_to_kitchen";
  const orderedItemQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of baseOrderItems) {
      const key = `${row.menuItemId}|${row.note ?? ""}`;
      map.set(key, (map.get(key) ?? 0) + row.quantity);
    }
    return map;
  }, [baseOrderItems]);
  const actionItem = useMemo(
    () => cartItems.find((item) => itemIdentity(item) === itemActionKey) ?? null,
    [cartItems, itemActionKey],
  );
  const timelineOrderId = activeOrder?.id ?? currentSettlementOrder?.id ?? null;
  const orderTimeline = useMemo(() => {
    if (!timelineOrderId) return [];

    return queue
      .filter((event) => {
        if (event.entityId === timelineOrderId) return true;
        if (typeof event.payload === "object" && event.payload !== null && "orderId" in event.payload) {
          return (event.payload as { orderId?: string }).orderId === timelineOrderId;
        }
        return false;
      })
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [queue, timelineOrderId]);

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
    setPayingOrderId(null);
    setCartItems(order?.items ?? []);
    setSelectedItemId("");
    setDiscountValue(String(order?.discountAmount ?? 0));
    setReceivedAmount("");
    setBaseOrderItems(order?.status === "sent_to_kitchen" ? order.items : []);
  }

  function selectTable(tableId: string) {
    const order = tableOrderMap.get(tableId) ?? null;
    loadOrderIntoWorkspace(order, tableId);
    setPosMode("order");
  }

  function openPad(
    title: string,
    mode: "number" | "text",
    value: string,
    apply: (nextValue: string) => void,
  ) {
    setPadTitle(title);
    setPadMode(mode);
    setPadValue(value);
    setPadApply(() => apply);
    setPadOpen(true);
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

  // 開台：本輪需求中不再在點餐界面提供入口（桌台點入即可開始操作）

  function backToTables() {
    setPosMode("tables");
    setCartItems([]);
    setSelectedItemId("");
    setDiscountValue("0");
    setReceivedAmount("");
    setPayingOrderId(null);
    setActiveOrderId(null);
    setBaseOrderItems([]);
  }

  function startItemLongPress(itemKey: string, orderedQty: number) {
    if (orderedQty <= 0) return;
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = window.setTimeout(() => {
      setItemActionKey(itemKey);
      setSuppressedClickKey(itemKey);
    }, 550);
  }

  function clearItemLongPress() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function itemIdentity(item: OrderItem) {
    return `${item.menuItemId}|${item.note ?? ""}`;
  }

  function updateItemNote(item: OrderItem) {
    const key = itemIdentity(item);
    if (suppressedClickKey === key) {
      setSuppressedClickKey(null);
      return;
    }

    setSelectedItemId(item.menuItemId);
    openPad("菜品備註", "text", item.note ?? "", (value) => {
      const note = value.trim();
      setCartItems((current) =>
        current.map((row) =>
          itemIdentity(row) === key ? { ...row, note: note || undefined } : row,
        ),
      );
    });
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

    // 新增菜品後立即彈出備註窗口（符合門店操作習慣）
    setSelectedItemId(item.id);
    openPad("菜品備註", "text", "", (value) => {
      const note = value.trim();
      setCartItems((current) =>
        current.map((row) => (row.menuItemId === item.id ? { ...row, note: note || undefined } : row)),
      );
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

  function voidOrderedItem(target: OrderItem, mode: "one" | "all", reason: string) {
    if (!bootstrap || !activeOrder || activeOrder.status !== "sent_to_kitchen") return;

    const key = itemIdentity(target);
    const orderedQty = orderedItemQtyMap.get(key) ?? 0;
    if (orderedQty <= 0) {
      setToast({ tone: "info", message: "這個菜品尚未正式下單，不能退菜。" });
      return;
    }

    const voidQty = mode === "one" ? 1 : orderedQty;
    const reduceQty = (list: OrderItem[]) =>
      list
        .map((row) => {
          if (itemIdentity(row) !== key) return row;
          const nextQty = row.quantity - voidQty;
          return nextQty > 0 ? { ...row, quantity: nextQty } : null;
        })
        .filter((row): row is OrderItem => Boolean(row));

    const nextCartItems = reduceQty(cartItems);
    const nextBaseItems = reduceQty(baseOrderItems);
    const nextTotals = orderTotals(nextCartItems, bootstrap);
    const updatedOrder: PosOrder = {
      ...activeOrder,
      items: nextCartItems,
      subtotal: nextTotals.subtotal,
      serviceChargeAmount: 0,
      taxAmount: nextTotals.taxAmount,
      total: Math.max(0, nextTotals.total - activeOrder.discountAmount),
      updatedAt: new Date().toISOString(),
    };

    persistOrders(orders.map((order) => (order.id === activeOrder.id ? updatedOrder : order)));
    setCartItems(nextCartItems);
    setBaseOrderItems(nextBaseItems);
    setItemActionKey(null);

    const voidEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_ITEM_VOIDED",
      entityId: activeOrder.id,
      payload: {
        orderId: activeOrder.id,
        menuItemId: target.menuItemId,
        itemName: target.name,
        note: target.note ?? null,
        voidQuantity: voidQty,
        mode,
        reason: reason || "未填寫原因",
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([voidEvent]);
    setToast({
      tone: "success",
      message: mode === "one" ? `已退 1 份 ${target.name}` : `已退掉 ${target.name}`,
    });
  }

  function describeTimelineEvent(event: QueueEvent) {
    if (event.type === "ORDER_CREATED") {
      return { title: "已下單", detail: "已送出本次點餐並打印廚房單" };
    }
    if (event.type === "ORDER_UPDATED") {
      const addedItems = (event.payload as { addedItems?: OrderItem[] }).addedItems ?? [];
      const count = addedItems.reduce((sum, item) => sum + item.quantity, 0);
      return { title: "已加單", detail: `新增 ${count} 份菜品並打印加單單據` };
    }
    if (event.type === "ORDER_ITEM_VOIDED") {
      const payload = event.payload as {
        itemName?: string;
        voidQuantity?: number;
        reason?: string;
      };
      return {
        title: "VOID / 退菜",
        detail: `${payload.itemName ?? "菜品"} ×${payload.voidQuantity ?? 0} · ${payload.reason ?? "未填寫原因"}`,
      };
    }
    if (event.type === "ORDER_SETTLED") {
      const payload = event.payload as { paymentMethod?: string };
      return { title: "已結帳", detail: `支付方式：${payload.paymentMethod ?? "--"}` };
    }
    if (event.type === "PRINT_JOB_CREATED") {
      const payload = event.payload as { printerName?: string; printerGroup?: string };
      return { title: "已打印", detail: `${payload.printerName ?? "--"} · ${payload.printerGroup ?? "--"}` };
    }
    return { title: event.type, detail: "已記錄" };
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
    const order = upsertCurrentOrder("sent_to_kitchen");
    if (!order) return;

    const baseMap = new Map<string, number>();
    for (const row of baseOrderItems) {
      const key = `${row.menuItemId}|${row.note ?? ""}`;
      baseMap.set(key, (baseMap.get(key) ?? 0) + row.quantity);
    }
    const addedItems = cartItems
      .map((row) => {
        const key = `${row.menuItemId}|${row.note ?? ""}`;
        const baseQty = baseMap.get(key) ?? 0;
        const delta = row.quantity - baseQty;
        return delta > 0 ? { ...row, quantity: delta } : null;
      })
      .filter((row): row is OrderItem => Boolean(row));

    if (isAddOnOrder && addedItems.length === 0) {
      setToast({ tone: "info", message: "沒有新增菜品，無需加單。" });
      return;
    }

    const printTargetItems = isAddOnOrder ? addedItems : cartItems;

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const nextPrintJobs = configuredPrinters
      .filter((printer) => printTargetItems.some((item) => item.printerGroup === printer.group))
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
      type: isAddOnOrder ? "ORDER_UPDATED" : "ORDER_CREATED",
      entityId: order.id,
      payload: isAddOnOrder ? { order, addedItems } : order,
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
    setDiscountValue(String(order.discountAmount));
    setReceivedAmount("");
    setBaseOrderItems(order.items);
    setToast({
      tone: "success",
      message: networkOnline
        ? isAddOnOrder
          ? `已加單並打印，單號 ${order.localOrderNo}。`
          : `已下單並打印，單號 ${order.localOrderNo}。`
        : isAddOnOrder
          ? `已離線加單 ${order.localOrderNo}，待恢復網絡後補傳。`
          : `已離線下單 ${order.localOrderNo}，待恢復網絡後補傳。`,
    });
  }

  function confirmPayment(method: string) {
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
    setBaseOrderItems([]);
    setToast({
      tone: "success",
      message: networkOnline
        ? `已完成 ${updatedOrder.localOrderNo} 結帳。`
        : `已離線記錄 ${updatedOrder.localOrderNo} 付款，待補傳。`,
    });
  }

  function openSettlementModal() {
    const targetOrder =
      activeOrder?.status === "sent_to_kitchen"
        ? activeOrder
        : orders.find((order) => order.status === "sent_to_kitchen");
    if (!targetOrder) {
      setToast({ tone: "info", message: "目前沒有待結帳訂單。" });
      return;
    }
    setPayingOrderId(targetOrder.id);
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
              ["點餐", "點"],
              ["訂單", "單"],
            ].map(([label, short]) => (
              <button
                key={label}
                className={`flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-semibold ${
                  label === "點餐" ? "bg-orange-500 text-white" : "text-slate-300 hover:bg-slate-800"
                }`}
                onClick={() => {
                  if (label === "訂單") {
                    router.push("/orders");
                  }
                }}
                type="button"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">{short}</span>
                <span>{label}</span>
              </button>
            ))}
            <button
              className="flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-semibold text-slate-300 hover:bg-slate-800"
              onClick={() => router.push("/reports")}
              type="button"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">報</span>
              <span>報表</span>
            </button>
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
              設置
            </Link>
          </div>
        </aside>

        {posMode === "tables" ? (
          <div className="grid h-screen flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_330px]">
            <main className="flex h-full flex-col overflow-hidden bg-slate-100">
              <div className="border-b border-slate-200 bg-white px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-slate-900">桌台總覽</div>
                    <div className="mt-1 text-sm text-slate-500">
                      點開桌子後進入點餐介面。桌台狀態：空閒 / 未下單 / 已下單
                    </div>
                  </div>
                  <Link
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                    href="/orders"
                  >
                    查看線上訂單
                  </Link>
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4">
                <div className="mb-4 flex flex-wrap gap-2">
                  {floors.map((floor) => (
                    <button
                      key={floor.id}
                      className={`rounded-full px-4 py-2 text-sm font-semibold ${
                        effectiveFloorId === floor.id ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
                      }`}
                      onClick={() => setActiveFloorId(floor.id)}
                      type="button"
                    >
                      {floor.name}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-3 md:grid-cols-4 xl:grid-cols-6">
                  {visibleTables.map((table) => {
                    const status = tableOrderMap.get(table.id)?.status ?? "idle";
                    const label =
                      status === "sent_to_kitchen" ? "已下單" : status === "draft" ? "未下單" : "空閒";
                    return (
                      <button
                        key={table.id}
                        className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-orange-300"
                        onClick={() => selectTable(table.id)}
                        type="button"
                      >
                        <div className="text-base font-semibold text-slate-900">{table.name}</div>
                        <div className="mt-2 text-xs text-slate-500">{table.area}</div>
                        <div className="mt-4 inline-flex rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
                          {label}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </main>

            <section className="flex h-full flex-col overflow-hidden border-l border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-4">
                <div className="text-base font-semibold text-slate-900">快捷操作</div>
                <div className="mt-1 text-xs text-slate-500">適合平板橫屏操作</div>
              </div>
              <div className="flex-1 overflow-auto px-4 py-4">
                <div className="grid gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">待同步</span>
                    <span className="font-semibold text-slate-900">{pendingQueue.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">打印任務</span>
                    <span className="font-semibold text-slate-900">{printJobs.length}</span>
                  </div>
                  <div className="flex items-center justify-between">
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
                ) : (
                  <button
                    className="mt-3 w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                    onClick={() => void syncNow(queue)}
                    type="button"
                  >
                    立即同步
                  </button>
                )}
              </div>
            </section>
          </div>
        ) : (
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
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={backToTables}
                  type="button"
                >
                  返回桌台
                </button>
                <div className="text-xs text-slate-500">
                  狀態：{selectedTableStatus === "sent_to_kitchen" ? "已下單" : selectedTableStatus === "draft" ? "未下單" : "空閒"}
                </div>
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
                      key={itemIdentity(item)}
                      className={`rounded-2xl border px-3 py-3 ${
                        selectedItemId === item.menuItemId ? "border-orange-300 bg-orange-50/50" : "border-slate-100 bg-slate-50"
                      }`}
                      onMouseDown={() => startItemLongPress(itemIdentity(item), orderedItemQtyMap.get(itemIdentity(item)) ?? 0)}
                      onMouseLeave={clearItemLongPress}
                      onMouseUp={clearItemLongPress}
                      onTouchEnd={clearItemLongPress}
                      onTouchStart={() => startItemLongPress(itemIdentity(item), orderedItemQtyMap.get(itemIdentity(item)) ?? 0)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          className="min-w-0 text-left"
                          onClick={() => updateItemNote(item)}
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
                            onClick={(event) => {
                              event.stopPropagation();
                              updateQuantity(item.menuItemId, -1);
                            }}
                            type="button"
                          >
                            -
                          </button>
                          <div className="w-7 text-center text-sm font-semibold text-slate-800">{item.quantity}</div>
                          <button
                            className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={(event) => {
                              event.stopPropagation();
                              updateQuantity(item.menuItemId, 1);
                            }}
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
              <div className="text-xs font-semibold text-slate-500">備註</div>
              <div className="mt-2 text-sm text-slate-700">
                點選訂單明細中的菜品，可直接新增/修改備註。
              </div>
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
                    readOnly
                    className={`rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-all duration-150 focus:border-orange-400 ${
                      searchFocused ? "w-full xl:w-72" : "w-32 xl:w-40"
                    }`}
                    onClick={() => {
                      setSearchFocused(true);
                      openPad("搜尋商品", "text", searchKeyword, (value) => setSearchKeyword(value));
                    }}
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
                    ? "目前尚未下單，可繼續加菜或送廚房"
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

              <div className="mt-2 grid gap-2">
                <button
                  className="rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600"
                  onClick={sendToKitchen}
                  type="button"
                >
                  {isAddOnOrder ? "加單" : "下單"}
                </button>
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800"
                  onClick={openSettlementModal}
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

              <div className="mt-5">
                <div className="mb-2 text-xs font-semibold text-slate-500">訂單時間線</div>
                <div className="grid gap-2">
                  {orderTimeline.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      目前還沒有事件記錄
                    </div>
                  ) : (
                    orderTimeline.slice(0, 8).map((event) => {
                      const info = describeTimelineEvent(event);
                      return (
                        <div
                          key={event.id}
                          className="rounded-2xl border border-slate-100 bg-slate-50 p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-semibold text-slate-900">{info.title}</div>
                            <div className="text-[11px] text-slate-400">
                              {event.createdAt.replace("T", " ").slice(5, 16)}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">{info.detail}</div>
                        </div>
                      );
                    })
                  )}
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

              {/* 最近訂單：點餐頁不顯示，避免干擾店員操作 */}
            </div>
          </section>
        </div>
        )}
      </div>

      <InputPadModal
        mode={padMode}
        onChange={setPadValue}
        onClose={() => {
          setPadOpen(false);
          setSearchFocused(false);
        }}
        onConfirm={() => {
          padApply(padValue);
          setPadOpen(false);
          setSearchFocused(false);
        }}
        open={padOpen}
        title={padTitle}
        value={padValue}
      />

      {payingOrderId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-900">結帳</div>
                <div className="mt-1 text-sm text-slate-500">
                  {currentSettlementOrder ? `訂單 ${currentSettlementOrder.localOrderNo}` : "待結帳訂單"}
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setPayingOrderId(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">本次支付內容</div>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">小計</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(paymentSummary.subtotal, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">折扣</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(paymentSummary.discountAmount, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">應收</span>
                    <span className="text-2xl font-semibold text-orange-600">
                      {formatMoney(paymentSummary.total, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">找續</span>
                    <span className="font-semibold text-emerald-600">
                      {formatMoney(changeDue, bootstrap.currency)}
                    </span>
                  </div>
                </div>

                <div className="mt-4 grid gap-3">
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    折扣金額
                    <input
                      readOnly
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      onClick={() =>
                        openPad("折扣金額", "number", discountValue, (value) => setDiscountValue(value || "0"))
                      }
                      value={discountValue}
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    實收金額
                    <input
                      readOnly
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      onClick={() =>
                        openPad("實收金額", "number", receivedAmount, (value) => setReceivedAmount(value))
                      }
                      value={receivedAmount}
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">支付方式</div>
                <div className="mt-3 grid gap-2">
                  {paymentMethods.map((method) => (
                    <button
                      key={method}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300"
                      onClick={() => confirmPayment(method)}
                      type="button"
                    >
                      {method}
                    </button>
                  ))}
                </div>

                <button
                  className="mt-4 w-full rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600"
                  onClick={() => confirmPayment(paymentMethods[0] ?? "現金")}
                  type="button"
                >
                  已結帳
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {actionItem ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">{actionItem.name}</div>
                <div className="mt-1 text-sm text-slate-500">
                  已下單菜品可長按打開這個操作面板
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => {
                  setItemActionKey(null);
                  setSuppressedClickKey(null);
                }}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4 grid gap-2">
              <button
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300"
                onClick={() => {
                  setItemActionKey(null);
                  setSuppressedClickKey(null);
                  updateItemNote(actionItem);
                }}
                type="button"
              >
                修改備註
              </button>
              <button
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300"
                onClick={() =>
                  openPad("退菜原因", "text", "", (value) => {
                    setItemActionKey(null);
                    voidOrderedItem(actionItem, "one", value.trim());
                  })
                }
                type="button"
              >
                退 1 份
              </button>
              <button
                className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-semibold text-red-700 hover:bg-red-100"
                onClick={() =>
                  openPad("退菜原因", "text", "", (value) => {
                    setItemActionKey(null);
                    voidOrderedItem(actionItem, "all", value.trim());
                  })
                }
                type="button"
              >
                全部退菜
              </button>
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
