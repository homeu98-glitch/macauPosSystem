"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ItemSpecModal } from "@/components/item-spec-modal";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadAuthSession,
  loadMembers,
  loadOfflineMode,
  loadOperatingMode,
  loadPosLocalSettings,
  loadQuickCompletedMinutes,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  loadShiftState,
  loadSoldOutState,
  saveBootstrapCache,
  saveDeviceConfig,
  saveMembers,
  saveOfflineMode,
  saveOrders,
  savePosLocalSettings,
  savePrintJobs,
  saveQueue,
  saveQuickCompletedMinutes,
  saveShiftState,
  saveSoldOutState,
} from "@/lib/storage";
import { DeviceConfig, MemberCoupon, MemberProfile, MenuItem, MenuSpecGroup, OrderItem, PosBootstrap, PosLocalSettings, PosOrder, PrintJob, QueueEvent } from "@/lib/types";

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

function ticketTypeLabel(ticketType: PrintJob["ticketType"]) {
  if (ticketType === "addon") return "加單";
  if (ticketType === "void") return "VOID / 退菜";
  return "正常下單";
}

function couponIsExpired(coupon: MemberCoupon) {
  if (!coupon.expiresAt) return false;
  return Date.parse(coupon.expiresAt) <= Date.now();
}

function couponDiscountAmount(coupon: MemberCoupon, baseAmount: number) {
  if (coupon.usedAt) return 0;
  if (couponIsExpired(coupon)) return 0;
  const minSpend = coupon.minSpend ?? 0;
  if (baseAmount < minSpend) return 0;

  if (coupon.type === "amount_off") {
    return Math.max(0, Math.min(coupon.amountOff ?? 0, baseAmount));
  }

  const percent = coupon.percentOff ?? 0;
  const raw = Math.floor((baseAmount * percent) / 100);
  const limited = coupon.maxOff ? Math.min(raw, coupon.maxOff) : raw;
  return Math.max(0, Math.min(limited, baseAmount));
}

function orderTotals(items: OrderItem[], bootstrap: PosBootstrap) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const serviceChargeAmount = subtotal * bootstrap.rules.serviceChargeRate;
  const taxAmount = subtotal * bootstrap.rules.taxRate;
  const total = subtotal + serviceChargeAmount + taxAmount;

  return { subtotal, serviceChargeAmount, taxAmount, total };
}

function quickCompletionLabel(order: Pick<PosOrder, "tableName">) {
  if (order.tableName === "自取") return "待取餐";
  if (order.tableName === "外賣") return "待交付";
  return "待出餐";
}

const CART_PAYING_ID = "__cart__";

export function PosApp() {
  const cachedBootstrapRaw = loadBootstrapCache();
  const cachedBootstrap = cachedBootstrapRaw ? normalizeBootstrapPayload(cachedBootstrapRaw) : null;
  const initialHasBootstrapRef = useRef(Boolean(cachedBootstrap));
  const [operatingMode] = useState(() => loadOperatingMode());
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(() => cachedBootstrap);
  const [activeTableId, setActiveTableId] = useState<string>(() => cachedBootstrap?.tables[0]?.id ?? "");
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const [offlineMode, setOfflineMode] = useState(() => loadOfflineMode());
  const [queue, setQueue] = useState<QueueEvent[]>(() => loadQueue());
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [toast, setToast] = useState<Toast | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(() => !loadBootstrapCache());
  const [activeCategoryId, setActiveCategoryId] = useState<string>(() => cachedBootstrap?.categories[0]?.id ?? "");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [discountValue, setDiscountValue] = useState("0");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [posMode, setPosMode] = useState<"tables" | "order">(() => (loadOperatingMode() === "quick" ? "order" : "tables"));
  const [baseOrderItems, setBaseOrderItems] = useState<OrderItem[]>([]);
  const [activeFloorId, setActiveFloorId] = useState("");
  const [itemActionKey, setItemActionKey] = useState<string | null>(null);
  const [suppressedClickKey, setSuppressedClickKey] = useState<string | null>(null);
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [specModalItem, setSpecModalItem] = useState<MenuItem | null>(null);
  const [specEditingKey, setSpecEditingKey] = useState<string | null>(null);
  const [selectedSpecValues, setSelectedSpecValues] = useState<Record<string, string[]>>({});
  const [voidRequest, setVoidRequest] = useState<{ item: OrderItem; mode: "one" | "all" } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [orderActionRequest, setOrderActionRequest] = useState<
    | {
        type: "cancel_order" | "refund_order";
        orderId: string;
      }
    | null
  >(null);
  const [orderActionReason, setOrderActionReason] = useState("");
  const [partialRefundOrderId, setPartialRefundOrderId] = useState<string | null>(null);
  const [partialRefundReason, setPartialRefundReason] = useState("");
  const [partialRefundQuantities, setPartialRefundQuantities] = useState<Record<string, number>>({});
  const [refundSummaryExportOpen, setRefundSummaryExportOpen] = useState(false);
  const [refundSummaryMode, setRefundSummaryMode] = useState<"date" | "employee">("date");
  const [refundSummaryDateFrom, setRefundSummaryDateFrom] = useState("");
  const [refundSummaryDateTo, setRefundSummaryDateTo] = useState("");
  const [membersCache, setMembersCache] = useState<MemberProfile[]>(() => loadMembers());
  const [memberPhone, setMemberPhone] = useState("");
  const [memberMatch, setMemberMatch] = useState<MemberProfile | null>(null);
  const [memberSearchHint, setMemberSearchHint] = useState<string>("");
  const [useMemberBalance, setUseMemberBalance] = useState(true);
  const [selectedCouponIds, setSelectedCouponIds] = useState<string[]>([]);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("");
  const [orderSuccessFlash, setOrderSuccessFlash] = useState(false);
  const [settlementFlash, setSettlementFlash] = useState(false);
  const [runtimeRefreshTick, setRuntimeRefreshTick] = useState(0);
  const [soldOutMap, setSoldOutMap] = useState(() => loadSoldOutState());
  const [shift, setShift] = useState(() => loadShiftState());
  const [authSession] = useState(() => loadAuthSession());
  const [orderNote, setOrderNote] = useState("");
  const [noteModal, setNoteModal] = useState<{ type: "order" | "item"; itemKey?: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [quickPanel, setQuickPanel] = useState<"cashier" | "online" | "local">(() =>
    loadOperatingMode() === "quick" ? "online" : "cashier",
  );
  const [quickCompletedMinutes, setQuickCompletedMinutes] = useState(() => loadQuickCompletedMinutes());
  const [quickOrderType, setQuickOrderType] = useState<"dine_in" | "pickup" | "delivery">("dine_in");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [audioReady, setAudioReady] = useState(false);
  const [onlineOrders, setOnlineOrders] = useState<
    Array<{
      id: string;
      sourceId?: string;
      type: string;
      status: string;
      paymentStatus?: "paid" | "unpaid";
      paidAmount?: number;
      total?: number;
      createdAt?: string;
      items?: Array<{ name: string; qty: number }>;
    }>
  >([]);
  const longPressTimerRef = useRef<number | null>(null);
  const quickOrderProcessingRef = useRef<Set<string>>(new Set());
  const quickOnlineSnapshotRef = useRef<Map<string, string>>(new Map());

  const networkOnline = !offlineMode;
  const isQuickMode = operatingMode === "quick";
  const canRefundOrder = authSession?.permissions.refundOrder ?? true;
  const canVoidItem = authSession?.permissions.voidItem ?? true;

  function showPermissionDenied(actionLabel: string) {
    setToast({ tone: "info", message: `目前帳號沒有${actionLabel}權限，請使用店長帳號操作。` });
  }

  function exportRefundDetails(order: PosOrder) {
    if (!order.refundRecords?.length || typeof window === "undefined") return;
    const rows = [
      ["訂單號", "退款時間", "退款金額", "退款原因", "菜品", "數量", "項目金額"].join(","),
      ...order.refundRecords.flatMap((record) => {
        if (!record.items?.length) {
          return [[order.localOrderNo, record.createdAt, String(record.amount), record.reason, "", "", ""].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")];
        }
        return record.items.map((item) =>
          [order.localOrderNo, record.createdAt, String(record.amount), record.reason, item.name, String(item.quantity), String(item.amount)]
            .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
            .join(","),
        );
      }),
    ];
    const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${order.localOrderNo}-退款明細.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setToast({ tone: "success", message: `${order.localOrderNo} 退款明細已導出。` });
  }

  function exportRefundSummary() {
    const refundRows = orders.flatMap((order) =>
      (order.refundRecords ?? []).map((record) => ({
        orderNo: order.localOrderNo,
        createdAt: record.createdAt,
        date: record.createdAt.slice(0, 10),
        employee: record.employeeName ?? record.employeeAccount ?? "未記錄",
        amount: record.amount,
      })),
    );
    const filtered = refundRows.filter((row) => {
      if (refundSummaryDateFrom && row.date < refundSummaryDateFrom) return false;
      if (refundSummaryDateTo && row.date > refundSummaryDateTo) return false;
      return true;
    });
    if (filtered.length === 0 || typeof window === "undefined") {
      setToast({ tone: "info", message: "目前沒有符合條件的退款資料可導出。" });
      return;
    }
    const grouped = Array.from(
      filtered.reduce(
        (map, row) => {
          const key = refundSummaryMode === "date" ? row.date : row.employee;
          const current = map.get(key) ?? { key, count: 0, amount: 0, orders: new Set<string>() };
          current.count += 1;
          current.amount += row.amount;
          current.orders.add(row.orderNo);
          map.set(key, current);
          return map;
        },
        new Map<string, { key: string; count: number; amount: number; orders: Set<string> }>(),
      ).values(),
    );
    const rows = [
      [refundSummaryMode === "date" ? "日期" : "員工", "退款次數", "退款總額", "涉及訂單數", "訂單"].join(","),
      ...grouped.map((row) =>
        [
          row.key,
          String(row.count),
          String(row.amount),
          String(row.orders.size),
          Array.from(row.orders).join(" / "),
        ]
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `退款匯總-${refundSummaryMode === "date" ? "按日期" : "按員工"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setRefundSummaryExportOpen(false);
    setToast({ tone: "success", message: "退款匯總已導出。" });
  }

  function updateOfflineMode(next: boolean) {
    setOfflineMode(next);
    saveOfflineMode(next);
    window.dispatchEvent(new CustomEvent("pos-offline-mode-changed", { detail: { offlineMode: next } }));
  }

  useEffect(() => {
    function onOfflineModeChanged(event: Event) {
      const detail = (event as CustomEvent<{ offlineMode?: boolean }>).detail;
      if (typeof detail?.offlineMode === "boolean") {
        setOfflineMode(detail.offlineMode);
      } else {
        setOfflineMode(loadOfflineMode());
      }
    }

    window.addEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
    return () => window.removeEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
  }, []);

  useEffect(() => {
    function onSoldOutChanged(event: Event) {
      const detail = (event as CustomEvent<{ soldOutMap?: ReturnType<typeof loadSoldOutState> }>).detail;
      if (detail?.soldOutMap) {
        setSoldOutMap(detail.soldOutMap);
      } else {
        setSoldOutMap(loadSoldOutState());
      }
    }
    window.addEventListener("pos-soldout-changed", onSoldOutChanged as EventListener);
    return () => window.removeEventListener("pos-soldout-changed", onSoldOutChanged as EventListener);
  }, []);

  useEffect(() => {
    function onShiftChanged(event: Event) {
      const detail = (event as CustomEvent<{ shift?: ReturnType<typeof loadShiftState> }>).detail;
      if (detail?.shift) {
        setShift(detail.shift);
      } else {
        setShift(loadShiftState());
      }
    }
    window.addEventListener("pos-shift-changed", onShiftChanged as EventListener);
    return () => window.removeEventListener("pos-shift-changed", onShiftChanged as EventListener);
  }, []);

  useEffect(() => {
    if (!isQuickMode) return;
    let cancelled = false;

    async function loadOnlineOrders() {
      try {
        const response = await fetch("/api/online-orders?type=all");
        const payload = (await response.json()) as { ok: boolean; orders?: unknown[] };
        if (!payload.ok) return;
        if (!cancelled) {
          const nextOrders = (payload.orders ?? []) as typeof onlineOrders;
          setOnlineOrders(nextOrders);

          if (audioReady) {
            const snapshot = quickOnlineSnapshotRef.current;
            const nextMap = new Map<string, string>();
            const newArrivals: Array<(typeof nextOrders)[number]> = [];
            let hasCustomerCancel = false;

            for (const order of nextOrders) {
              const id = order.sourceId ?? order.id;
              nextMap.set(id, order.status);
              if (!snapshot.has(id)) newArrivals.push(order);
              const prevStatus = snapshot.get(id);
              const status = String(order.status).toLowerCase();
              if (prevStatus && !String(prevStatus).toLowerCase().includes("cancel") && status.includes("cancel") && status.includes("customer")) {
                hasCustomerCancel = true;
              }
            }

            quickOnlineSnapshotRef.current = nextMap;

            if (snapshot.size > 0) {
              if (hasCustomerCancel) {
                void new Audio("/sounds/cancel-order.mp3").play();
              } else if (newArrivals.length > 0) {
                const hasDelivery = newArrivals.some((row) => row.type === "self_delivery" || row.type === "rider_delivery");
                void new Audio(hasDelivery ? "/sounds/new-delivery-order.mp3" : "/sounds/new-order.mp3").play();
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    void loadOnlineOrders();
    const timer = window.setInterval(loadOnlineOrders, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isQuickMode, audioReady]);

  useEffect(() => {
    if (!isQuickMode) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [isQuickMode]);

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

  function isItemSoldOut(menuItemId: string) {
    const state = soldOutMap[menuItemId];
    if (!state) return false;
    return state.remainingQty <= 0;
  }

  function consumeSoldOut(items: OrderItem[]) {
    if (!bootstrap) return;
    const next = { ...soldOutMap };
    const soldOutTriggered: Array<{ id: string; name: string }> = [];

    for (const row of items) {
      const state = next[row.menuItemId];
      if (!state) continue;
      const remaining = Math.max(0, state.remainingQty - row.quantity);
      next[row.menuItemId] = { ...state, remainingQty: remaining, updatedAt: new Date().toISOString() };
      if (state.remainingQty > 0 && remaining === 0) {
        soldOutTriggered.push({ id: row.menuItemId, name: row.name });
      }
    }

    setSoldOutMap(next);
    saveSoldOutState(next);
    window.dispatchEvent(new CustomEvent("pos-soldout-changed", { detail: { soldOutMap: next } }));

    if (!offlineMode) {
      for (const item of soldOutTriggered) {
        void fetch("/api/inventory/soldout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storeId: bootstrap.storeId,
            menuItemId: item.id,
            name: item.name,
            soldOutAt: new Date().toISOString(),
          }),
        });
      }
    }
  }

  function startWork() {
    const next = {
      ...shift,
      openedAt: new Date().toISOString(),
      closedAt: undefined,
    };
    setShift(next);
    saveShiftState(next);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: next } }));
    setToast({ tone: "success", message: "已開工，開始今日營業。" });
  }

  useEffect(() => {
    async function bootstrapApp() {
      try {
        const response = await fetch("/api/pos/bootstrap");
        const data = normalizeBootstrapPayload((await response.json()) as PosBootstrap);
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

  useEffect(() => {
    if (!orderSuccessFlash) return;
    const timer = window.setTimeout(() => setOrderSuccessFlash(false), 1000);
    return () => window.clearTimeout(timer);
  }, [orderSuccessFlash]);

  useEffect(() => {
    if (!settlementFlash) return;
    const timer = window.setTimeout(() => setSettlementFlash(false), 1000);
    return () => window.clearTimeout(timer);
  }, [settlementFlash]);

  useEffect(() => {
    if (offlineMode) return;
    async function loadRuntimeState() {
      try {
        const response = await fetch("/api/pos/state");
        const payload = (await response.json()) as {
          orders?: PosOrder[];
          queue?: QueueEvent[];
          printJobs?: PrintJob[];
          members?: MemberProfile[];
          localSettings?: PosLocalSettings;
          deviceConfig?: DeviceConfig | null;
        };

        if (Array.isArray(payload.orders)) {
          setOrders(payload.orders);
          saveOrders(payload.orders);
        }
        if (Array.isArray(payload.queue)) {
          setQueue(payload.queue);
          saveQueue(payload.queue);
        }
        if (Array.isArray(payload.printJobs)) {
          setPrintJobs(payload.printJobs);
          savePrintJobs(payload.printJobs);
        }
        if (Array.isArray(payload.members)) {
          setMembersCache(payload.members);
          saveMembers(payload.members);
        }
        if (payload.localSettings) {
          savePosLocalSettings(payload.localSettings);
        }
        if (payload.deviceConfig) {
          saveDeviceConfig(payload.deviceConfig);
        }
      } catch {
        // ignore
      }
    }

    void loadRuntimeState();
  }, [offlineMode, runtimeRefreshTick]);

  const activeTable = useMemo(() => {
    if (!bootstrap) return null;
    if (isQuickMode) {
      return { id: "counter", name: "快餐", area: "" } as PosBootstrap["tables"][number];
    }
    return bootstrap.tables.find((table) => table.id === activeTableId) ?? null;
  }, [bootstrap, activeTableId, isQuickMode]);

  const totals = useMemo(
    () => (bootstrap ? orderTotals(cartItems, bootstrap) : { subtotal: 0, serviceChargeAmount: 0, taxAmount: 0, total: 0 }),
    [bootstrap, cartItems],
  );

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings());
  const floors = localSettings.floors;
  const paymentMethods = localSettings.paymentMethods;
  const autoAcceptOnlineOrders = localSettings.onlineOrderSettings.autoAccept;

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

  useEffect(() => {
    if (!isQuickMode || !autoAcceptOnlineOrders) return;
    const pending = onlineOrders.filter((order) => order.status === "new");
    if (pending.length === 0) return;

    for (const order of pending) {
      const sourceId = order.sourceId ?? order.id;
      if (quickOrderProcessingRef.current.has(sourceId)) continue;
      quickOrderProcessingRef.current.add(sourceId);

      void (async () => {
        try {
          await fetch("/api/online-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "accept", orderId: sourceId }),
          });
          const response = await fetch("/api/online-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "convert_quick", orderId: sourceId }),
          });
          const payload = (await response.json()) as { ok: boolean; posOrder?: PosOrder; error?: string };
          if (!payload.ok || !payload.posOrder) {
            throw new Error(payload.error ?? "轉入快餐訂單失敗");
          }
          setOrders((current) => {
            const next = [payload.posOrder!, ...current.filter((item) => item.id !== payload.posOrder!.id)];
            saveOrders(next);
            return next;
          });
          setToast({ tone: "success", message: "已自動接單並加入訂單池。" });
        } catch (err) {
          setToast({ tone: "info", message: err instanceof Error ? err.message : "自動接單失敗" });
        }
      })();
    }
  }, [isQuickMode, onlineOrders, autoAcceptOnlineOrders]);
  const menuItemMap = useMemo(
    () => new Map((bootstrap?.menuItems ?? []).map((item) => [item.id, item])),
    [bootstrap],
  );

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
    () =>
      orders.filter(
        (order) =>
          order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid",
      ),
    [orders],
  );
  const recentCompletedOrders = useMemo(() => {
    if (!isQuickMode) return [];
    const threshold = nowMs - quickCompletedMinutes * 60 * 1000;
    return orders
      .filter((order) => order.tableId === "counter" && order.status === "settled")
      .filter((order) => Date.parse(order.updatedAt || order.createdAt) >= threshold)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
  }, [isQuickMode, orders, quickCompletedMinutes, nowMs]);
  const quickPreparingOrders = useMemo(
    () =>
      openOrders
        .filter((order) => order.tableId === "counter")
        .filter((order) => order.status === "draft" || order.status === "sent_to_kitchen"),
    [openOrders],
  );
  const quickWaitingOrders = useMemo(
    () => openOrders.filter((order) => order.tableId === "counter").filter((order) => order.status === "paid"),
    [openOrders],
  );

  const viewingOrder = useMemo(() => {
    if (!viewingOrderId) return null;
    return orders.find((order) => order.id === viewingOrderId) ?? null;
  }, [orders, viewingOrderId]);
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
      return (
        orders.find(
          (order) =>
            order.id === activeOrderId &&
            order.status !== "settled" &&
            order.status !== "cancelled" &&
            order.status !== "partially_refunded" &&
            order.status !== "refunded",
        ) ?? null
      );
    }
    return (activeTableId ? tableOrderMap.get(activeTableId) : null) ?? null;
  }, [activeOrderId, activeTableId, orders, tableOrderMap]);
  const unsettledOrder = useMemo(
    () => orders.find((order) => order.status === "sent_to_kitchen") ?? null,
    [orders],
  );
  const currentSettlementOrder =
    (payingOrderId && payingOrderId !== CART_PAYING_ID ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
    (!isQuickMode && activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
    (!isQuickMode ? unsettledOrder : null);
  const discountAmount = useMemo(() => {
    const value = Number(discountValue);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [discountValue]);
  const paymentBase = !isQuickMode && activeOrder && cartItems.length === 0
    ? {
        subtotal: activeOrder.subtotal,
          serviceChargeAmount: 0,
        taxAmount: activeOrder.taxAmount,
          total: activeOrder.subtotal + activeOrder.taxAmount,
      }
    : totals;
  const couponDiscount = useMemo(() => {
    if (!memberMatch || selectedCouponIds.length === 0) return 0;
    const baseAmount = Math.max(0, paymentBase.total - discountAmount);
    const selected = memberMatch.coupons.filter((coupon) => selectedCouponIds.includes(coupon.id));

    // 不可疊加券：只允許一張
    const nonStackable = selected.find((coupon) => !coupon.stackable);
    const effectiveCoupons = nonStackable ? [nonStackable] : selected;

    let remaining = baseAmount;
    let totalDiscount = 0;
    for (const coupon of effectiveCoupons) {
      const off = couponDiscountAmount(coupon, remaining);
      if (off <= 0) continue;
      totalDiscount += off;
      remaining = Math.max(0, remaining - off);
    }
    return Math.min(totalDiscount, baseAmount);
  }, [discountAmount, memberMatch, paymentBase.total, selectedCouponIds]);
  const prepaidAmount = (currentSettlementOrder?.prepaidAmount ?? activeOrder?.prepaidAmount ?? 0) || 0;
  const payableBeforeMember = Math.max(0, paymentBase.total - discountAmount - couponDiscount - prepaidAmount);
  const memberDeduction = useMemo(() => {
    if (!useMemberBalance || !memberMatch) return 0;
    return Math.min(memberMatch.balance, payableBeforeMember);
  }, [memberMatch, payableBeforeMember, useMemberBalance]);
  const paymentSummary = {
    subtotal: paymentBase.subtotal,
    serviceChargeAmount: 0,
    taxAmount: paymentBase.taxAmount,
    discountAmount: discountAmount + couponDiscount,
    manualDiscountAmount: discountAmount,
    couponDiscount,
    prepaidAmount,
    memberDeduction,
    total: Math.max(0, payableBeforeMember - memberDeduction),
  };
  const changeDue = useMemo(() => {
    const received = Number(receivedAmount);
    if (!Number.isFinite(received) || received <= 0) return 0;
    return Math.max(0, received - paymentSummary.total);
  }, [receivedAmount, paymentSummary.total]);
  const selectedTableStatus = activeTableId ? tableOrderMap.get(activeTableId)?.status ?? "idle" : "idle";
  const isAddOnOrder = activeOrder?.status === "sent_to_kitchen";
  const orderedItemQtyMap = (() => {
    const map = new Map<string, number>();
    for (const row of baseOrderItems) {
      const key = itemIdentity(row);
      map.set(key, (map.get(key) ?? 0) + row.quantity);
    }
    return map;
  })();
  const actionItem = cartItems.find((item) => itemIdentity(item) === itemActionKey) ?? null;
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
  const previewPrintJob = useMemo(() => {
    if (!timelineOrderId) return null;
    return (
      printJobs
        .filter((job) => job.orderId === timelineOrderId)
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
    );
  }, [printJobs, timelineOrderId]);

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
    setOrderNote(order?.orderNote ?? "");
    setMemberPhone("");
    setMemberMatch(null);
    setSelectedPaymentMethod("");
    setUseMemberBalance(true);
    setSelectedCouponIds([]);
  }

  function selectTable(tableId: string) {
    const order = tableOrderMap.get(tableId) ?? null;
    loadOrderIntoWorkspace(order, tableId);
    setPosMode("order");
  }

  function upsertCurrentOrder(
    nextStatus: "draft" | "sent_to_kitchen",
    allowEmpty = false,
    newLocalOrderNo?: string,
  ) {
    if (!bootstrap || !activeTable) return null;
    if (!allowEmpty && cartItems.length === 0) return null;

    const timestamp = new Date().toISOString();
    const baseTotals = orderTotals(cartItems, bootstrap);
    const existingOrder =
      (activeOrderId
        ? orders.find(
            (order) =>
              order.id === activeOrderId &&
              order.status !== "settled" &&
              order.status !== "cancelled" &&
              order.status !== "partially_refunded" &&
              order.status !== "refunded",
          )
        : null) ??
      tableOrderMap.get(activeTable.id) ??
      null;

    const fallbackNo = isQuickMode
      ? quickOrderType === "pickup"
        ? `自取${new Date().getTime().toString().slice(-2)}`
        : quickOrderType === "delivery"
          ? `外賣${new Date().getTime().toString().slice(-2)}`
          : `取餐${new Date().getTime().toString().slice(-2)}`
      : `訂單${new Date().getTime().toString().slice(-2)}`;

    const order: PosOrder = existingOrder
      ? {
          ...existingOrder,
          tableId: activeTable.id,
          tableName: isQuickMode ? quickTypeTableName() : activeTable.name,
          status: nextStatus,
          items: cartItems,
          orderNote,
          subtotal: baseTotals.subtotal,
          serviceChargeAmount: baseTotals.serviceChargeAmount,
          taxAmount: baseTotals.taxAmount,
          discountAmount,
          total: Math.max(0, baseTotals.total - discountAmount),
          updatedAt: timestamp,
        }
      : {
          id: uid("order"),
          localOrderNo: newLocalOrderNo ?? fallbackNo,
          tableId: activeTable.id,
          tableName: isQuickMode ? quickTypeTableName() : activeTable.name,
          status: nextStatus,
          items: cartItems,
          orderNote,
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
    if (isQuickMode) return;
    setPosMode("tables");
    setCartItems([]);
    setSelectedItemId("");
    setDiscountValue("0");
    setReceivedAmount("");
    setPayingOrderId(null);
    setActiveOrderId(null);
    setBaseOrderItems([]);
    setOrderNote("");
    setMemberPhone("");
    setMemberMatch(null);
    setSelectedPaymentMethod("");
    setSelectedCouponIds([]);
    setRuntimeRefreshTick((current) => current + 1);
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

  function serializeSpecs(item: OrderItem) {
    return (item.selectedSpecs ?? [])
      .map((spec) => `${spec.groupId}:${spec.optionId}`)
      .sort()
      .join("|");
  }

  function specText(item: OrderItem) {
    return (item.selectedSpecs ?? []).map((spec) => spec.optionLabel).join(" / ");
  }

  function priceWithSpecs(item: MenuItem, selectedSpecs: OrderItem["selectedSpecs"] = []) {
    return item.price + selectedSpecs.reduce((sum, spec) => sum + spec.priceDelta, 0);
  }

  function buildSelectedSpecs(
    specGroups: MenuSpecGroup[],
    selectedMap: Record<string, string[]>,
  ): OrderItem["selectedSpecs"] {
    return specGroups
      .flatMap((group) => {
        const selectedIds = selectedMap[group.id] ?? [];
        return group.options
          .filter((candidate) => selectedIds.includes(candidate.id))
          .map((option) => ({
            groupId: group.id,
            groupName: group.name,
            optionId: option.id,
            optionLabel: option.label,
            priceDelta: option.priceDelta,
          }));
      })
      .filter((item): item is NonNullable<OrderItem["selectedSpecs"]>[number] => Boolean(item));
  }

  function itemIdentity(item: OrderItem) {
    return `${item.menuItemId}|${serializeSpecs(item)}|${item.note ?? ""}`;
  }

  function refundedItemQtyMap(order: PosOrder) {
    const result = new Map<string, number>();
    for (const record of order.refundRecords ?? []) {
      for (const item of record.items ?? []) {
        result.set(item.itemKey, (result.get(item.itemKey) ?? 0) + item.quantity);
      }
    }
    return result;
  }

  function commitMenuItem(item: MenuItem, selectedSpecs: OrderItem["selectedSpecs"] = []) {
    const finalPrice = priceWithSpecs(item, selectedSpecs);
    const targetPrinterGroup = localSettings.menuPrinterOverrides[item.id] ?? item.printerGroup;
    setCartItems((current) => {
      const remaining = soldOutMap[item.id]?.remainingQty;
      if (typeof remaining === "number" && remaining >= 0) {
        const totalInCart = current.filter((row) => row.menuItemId === item.id).reduce((sum, row) => sum + row.quantity, 0);
        if (totalInCart + 1 > remaining) {
          setToast({ tone: "info", message: `只剩 ${remaining} 份，不能再加。` });
          return current;
        }
      }
      const existing = current.find(
        (cartItem) => cartItem.menuItemId === item.id && serializeSpecs(cartItem) === serializeSpecs({
          menuItemId: item.id,
          name: item.name,
          quantity: 1,
          price: finalPrice,
          printerGroup: targetPrinterGroup,
          selectedSpecs,
        }),
      );
      if (existing) {
        return current.map((cartItem) =>
          cartItem.menuItemId === item.id && serializeSpecs(cartItem) === serializeSpecs({
            menuItemId: item.id,
            name: item.name,
            quantity: 1,
            price: finalPrice,
            printerGroup: targetPrinterGroup,
            selectedSpecs,
          })
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
          price: finalPrice,
          printerGroup: targetPrinterGroup,
          selectedSpecs,
        },
      ];
    });
    setSelectedItemId(item.id);
    if (isQuickMode) {
      setQuickPanel("cashier");
    }
  }

  function openSpecPicker(
    item: MenuItem,
    editingKey?: string,
    currentSpecs?: Record<string, string[]>,
  ) {
    setSpecModalItem(item);
    setSpecEditingKey(editingKey ?? null);
    setSelectedSpecValues(currentSpecs ?? {});
    setSpecModalOpen(true);
  }

  function applySpecSelection(specMap: Record<string, string[]>) {
    if (!specModalItem) return;
    const selectedSpecs = buildSelectedSpecs(specModalItem.specGroups ?? [], specMap);
    const nextPrice = priceWithSpecs(specModalItem, selectedSpecs);

    if (specEditingKey) {
      setCartItems((current) =>
        current.map((row) =>
          itemIdentity(row) === specEditingKey ? { ...row, selectedSpecs, price: nextPrice } : row,
        ),
      );
    } else {
      commitMenuItem(specModalItem, selectedSpecs);
    }

    setSpecModalOpen(false);
    setSpecModalItem(null);
    setSpecEditingKey(null);
    setSelectedSpecValues({});
  }

  function updateItemNote(item: OrderItem) {
    const key = itemIdentity(item);
    if (suppressedClickKey === key) {
      setSuppressedClickKey(null);
      return;
    }

    setSelectedItemId(item.menuItemId);
    const menuItem = menuItemMap.get(item.menuItemId);
    if (menuItem?.specGroups?.length) {
      openSpecPicker(
        menuItem,
        key,
        (item.selectedSpecs ?? []).reduce<Record<string, string[]>>((acc, spec) => {
          acc[spec.groupId] = [...(acc[spec.groupId] ?? []), spec.optionId];
          return acc;
        }, {}),
      );
    }
  }

  function openItemNoteEditor(item: OrderItem) {
    setNoteDraft(item.note ?? "");
    setNoteModal({ type: "item", itemKey: itemIdentity(item) });
  }

  function applyItemNote(itemKey: string, note: string) {
    setCartItems((current) =>
      current.map((item) => (itemIdentity(item) === itemKey ? { ...item, note: note.trim() } : item)),
    );
  }

  function addMenuItem(item: MenuItem) {
    if (isItemSoldOut(item.id)) {
      setToast({ tone: "info", message: `${item.name} 已售罄。` });
      return;
    }
    if (item.specGroups?.length) {
      openSpecPicker(item);
      return;
    }

    commitMenuItem(item);
  }

  function updateQuantity(itemKey: string, delta: number) {
    setCartItems((current) => {
      const target = current.find((row) => itemIdentity(row) === itemKey);
      if (!target) return current;

      if (delta > 0) {
        const remaining = soldOutMap[target.menuItemId]?.remainingQty;
        if (typeof remaining === "number" && remaining >= 0) {
          const totalInCart = current
            .filter((row) => row.menuItemId === target.menuItemId)
            .reduce((sum, row) => sum + row.quantity, 0);
          if (totalInCart + delta > remaining) {
            setToast({ tone: "info", message: `只剩 ${remaining} 份，不能再加。` });
            return current;
          }
        }
      }

      return current
        .map((row) =>
          itemIdentity(row) === itemKey ? { ...row, quantity: Math.max(0, row.quantity + delta) } : row,
        )
        .filter((row) => row.quantity > 0);
    });
  }

  function voidOrderedItem(target: OrderItem, mode: "one" | "all", reason: string) {
    if (!canVoidItem) {
      showPermissionDenied("退菜");
      return;
    }
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
      serviceChargeAmount: nextTotals.serviceChargeAmount,
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

    const voidPrintJobs = (loadDeviceConfig() ?? defaultDeviceConfig).printers
      .filter(
        (printer) =>
          printer.enabled &&
          (printer.role === "zone" || printer.role === "label") &&
          (printer.zoneId ?? "") === target.printerGroup,
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: activeOrder.id,
        orderNo: activeOrder.localOrderNo,
        tableName: activeOrder.tableName,
        ticketType: "void",
        printerGroup: printer.zoneId ?? target.printerGroup,
        printerName: printer.name,
        items: [
          {
            name: target.name,
            quantity: voidQty,
            specs: (target.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
            note: reason || target.note,
          },
        ],
        status: networkOnline ? "sent" : "pending",
        createdAt: updatedOrder.updatedAt,
      }));

    persistPrintJobs([...voidPrintJobs, ...printJobs]);
    const voidPrintEvents = voidPrintJobs.map<QueueEvent>((printJob) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: printJob.id,
      payload: printJob,
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    }));

    pushEvents([voidEvent, ...voidPrintEvents]);
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
      const payload = event.payload as {
        addedItems?: OrderItem[];
        action?: "completed" | "cancelled" | "refunded";
        reason?: string;
        amount?: number;
      };
      if (payload.action === "completed") {
        return { title: "已完成", detail: "訂單已完成並離開待處理區" };
      }
      if (payload.action === "cancelled") {
        return { title: "已取消結帳", detail: payload.reason ? `原因：${payload.reason}` : "已取消本單" };
      }
      if (payload.action === "refunded") {
        return {
          title: "已退款",
          detail: `${payload.amount ? `金額 ${formatMoney(payload.amount, bootstrap?.currency ?? "MOP")} · ` : ""}${payload.reason ? `原因：${payload.reason}` : "整單退款"}`,
        };
      }
      const addedItems = payload.addedItems ?? [];
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
      const payload = event.payload as {
        printerName?: string;
        printerGroup?: string;
        ticketType?: PrintJob["ticketType"];
        items?: Array<{ name?: string; specs?: string[] }>;
      };
      const firstItem = payload.items?.[0];
      const specSuffix =
        firstItem?.specs && firstItem.specs.length > 0 ? ` · ${firstItem.specs.join(" / ")}` : "";
      return {
        title: "已打印",
        detail: `${ticketTypeLabel(payload.ticketType ?? "normal")} · ${payload.printerName ?? "--"} · ${payload.printerGroup ?? "--"}${firstItem ? ` · ${firstItem.name ?? ""}${specSuffix}` : ""}`,
      };
    }
    return { title: event.type, detail: "已記錄" };
  }

  async function syncNow(nextQueue: QueueEvent[]) {
    if (offlineMode || nextQueue.length === 0) {
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

  function quickTypeKind() {
    if (quickOrderType === "pickup") return "pickup" as const;
    if (quickOrderType === "delivery") return "delivery" as const;
    return "counter" as const;
  }

  function quickTypeTableName() {
    if (quickOrderType === "pickup") return "自取";
    if (quickOrderType === "delivery") return "外賣";
    return "堂食";
  }

  function reprintOrder(order: PosOrder) {
    if (!bootstrap) return;
    const timestamp = new Date().toISOString();

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const suffix = " (重打)";
    const nextPrintJobs = configuredPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") &&
          order.items.some((item) => item.printerGroup === (printer.zoneId ?? "")),
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: `${order.localOrderNo}${suffix}`,
        tableName: order.tableName,
        ticketType: "normal",
        printerGroup: printer.zoneId ?? "",
        printerName: printer.name,
        items: [
          ...order.items
            .filter((item) => item.printerGroup === (printer.zoneId ?? ""))
            .map((item) => ({
              name: item.name,
              quantity: item.quantity,
              specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
              note: item.note,
            })),
          ...(order.orderNote
            ? [
                {
                  name: "全單備註",
                  quantity: 1,
                  specs: [],
                  note: order.orderNote,
                },
              ]
            : []),
        ],
        status: networkOnline ? "sent" : "pending",
        createdAt: timestamp,
      }));

    if (nextPrintJobs.length === 0) {
      setToast({ tone: "info", message: "沒有可打印的菜品。" });
      return;
    }

    persistPrintJobs([...nextPrintJobs, ...printJobs]);

    const printEvents = nextPrintJobs.map<QueueEvent>((printJob) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: printJob.id,
      payload: printJob,
      status: networkOnline ? "synced" : "pending",
      createdAt: timestamp,
    }));
    pushEvents(printEvents);
    setToast({ tone: "success", message: "已加入重打單打印隊列。" });
  }

  async function sendToKitchen(options?: { silent?: boolean }) {
    if (!bootstrap || !activeTable || cartItems.length === 0) return null;

    const timestamp = new Date().toISOString();
    let nextOrderNo: string | undefined;
    if (!offlineMode && !activeOrderId && !tableOrderMap.get(activeTable.id)) {
      try {
        const response = await fetch("/api/pos/sequence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: isQuickMode ? quickTypeKind() : "pos", storeId: bootstrap.storeId }),
        });
        const payload = (await response.json()) as { display?: string };
        nextOrderNo = payload.display;
      } catch {
        // fallback
      }
    }

    const order = upsertCurrentOrder("sent_to_kitchen", false, nextOrderNo);
    if (!order) return null;

    const baseMap = new Map<string, number>();
    for (const row of baseOrderItems) {
      const key = itemIdentity(row);
      baseMap.set(key, (baseMap.get(key) ?? 0) + row.quantity);
    }
    const addedItems = cartItems
      .map((row) => {
        const key = itemIdentity(row);
        const baseQty = baseMap.get(key) ?? 0;
        const delta = row.quantity - baseQty;
        return delta > 0 ? { ...row, quantity: delta } : null;
      })
      .filter((row): row is OrderItem => Boolean(row));

    if (isAddOnOrder && addedItems.length === 0) {
      if (!options?.silent) {
        setToast({ tone: "info", message: "沒有新增菜品，無需加單。" });
      }
      return null;
    }

    const printTargetItems = isAddOnOrder ? addedItems : cartItems;

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const nextPrintJobs = configuredPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") &&
          printTargetItems.some((item) => item.printerGroup === (printer.zoneId ?? "")),
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: order.localOrderNo,
        tableName: order.tableName,
        ticketType: isAddOnOrder ? "addon" : "normal",
        printerGroup: printer.zoneId ?? "",
        printerName: printer.name,
        items: [
          ...printTargetItems
            .filter((item) => item.printerGroup === (printer.zoneId ?? ""))
            .map((item) => ({
              name: item.name,
              quantity: item.quantity,
              specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
              note: item.note,
            })),
          ...(!isAddOnOrder && order.orderNote
            ? [
                {
                  name: "全單備註",
                  quantity: 1,
                  specs: [],
                  note: order.orderNote,
                },
              ]
            : []),
        ],
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
    consumeSoldOut(printTargetItems);
    setActiveOrderId(order.id);
    setDiscountValue(String(order.discountAmount));
    setReceivedAmount("");
    setBaseOrderItems(order.items);
    setOrderSuccessFlash(true);
    if (!options?.silent) {
      setToast({
        tone: "success",
        message: networkOnline
          ? isAddOnOrder
            ? `已加單成功，單號 ${order.localOrderNo}。`
            : `已下單成功，單號 ${order.localOrderNo}。`
          : isAddOnOrder
            ? `已離線加單 ${order.localOrderNo}，待恢復網絡後補傳。`
            : `已離線下單 ${order.localOrderNo}，待恢復網絡後補傳。`,
      });
    }
    if (isQuickMode) {
      setQuickPanel("cashier");
    }
    return order;
  }

  function markOrderCompleted(orderId: string) {
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder) return;

    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "settled",
      updatedAt: new Date().toISOString(),
    };
    const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
    persistOrders(nextOrders);
    pushEvents([
      {
        id: uid("evt"),
        type: "ORDER_UPDATED",
        entityId: updatedOrder.id,
        payload: { order: updatedOrder, action: "completed" },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedOrder.updatedAt,
      },
    ]);
    setViewingOrderId(null);
    setToast({ tone: "success", message: `${updatedOrder.localOrderNo} 已完成。` });
  }

  function cancelOrder(orderId: string, reason: string) {
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder) return;
    const updatedAt = new Date().toISOString();
    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "cancelled",
      cancelledAt: updatedAt,
      cancelledReason: reason || "未填寫原因",
      updatedAt,
    };
    persistOrders(orders.map((order) => (order.id === orderId ? updatedOrder : order)));
    pushEvents([
      {
        id: uid("evt"),
        type: "ORDER_UPDATED",
        entityId: updatedOrder.id,
        payload: { order: updatedOrder, action: "cancelled", reason: updatedOrder.cancelledReason },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      },
    ]);
    if (activeOrderId === orderId) {
      setActiveOrderId(null);
      setCartItems([]);
      setBaseOrderItems([]);
      setOrderNote("");
      setDiscountValue("0");
      setReceivedAmount("");
    }
    setViewingOrderId(null);
    setOrderActionRequest(null);
    setOrderActionReason("");
    setToast({ tone: "success", message: `${updatedOrder.localOrderNo} 已取消結帳。` });
  }

  function buildRefundReceiptJobs(
    order: PosOrder,
    amount: number,
    reason: string,
    timestamp: string,
    title = "退款單號",
  ) {
    if (!bootstrap) return [] as PrintJob[];
    return (loadDeviceConfig() ?? defaultDeviceConfig).printers
      .filter((printer) => printer.enabled && printer.role === "receipt")
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: `${order.localOrderNo} 退款`,
        tableName: order.tableName,
        ticketType: "void",
        printerGroup: "receipt",
        printerName: printer.name,
        items: [
          { name: title, quantity: 1, note: order.localOrderNo },
          { name: "退款金額", quantity: 1, note: formatMoney(amount, bootstrap.currency) },
          { name: "退款原因", quantity: 1, note: reason },
        ],
        status: networkOnline ? "sent" : "pending",
        createdAt: timestamp,
      }));
  }

  function refundOrder(orderId: string, reason: string) {
    if (!canRefundOrder) {
      showPermissionDenied("退款");
      return;
    }
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder || !bootstrap) return;
    const updatedAt = new Date().toISOString();
    const alreadyRefunded = targetOrder.refundedAmount ?? 0;
    const remainingAmount = Math.max(0, targetOrder.total - alreadyRefunded);
    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "refunded",
      refundedAt: updatedAt,
      refundedAmount: targetOrder.total,
      refundedReason: reason || "未填寫原因",
      refundRecords: [
        ...(targetOrder.refundRecords ?? []),
        {
          id: uid("refund"),
          amount: remainingAmount,
          reason: reason || "未填寫原因",
          employeeAccount: authSession?.account,
          employeeName: authSession?.name,
          createdAt: updatedAt,
        },
      ],
      updatedAt,
    };
    persistOrders(orders.map((order) => (order.id === orderId ? updatedOrder : order)));
    const refundEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_UPDATED",
      entityId: updatedOrder.id,
      payload: {
        order: updatedOrder,
        action: "refunded",
        amount: updatedOrder.refundedAmount,
        reason: updatedOrder.refundedReason,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedAt,
    };
    const refundPrintJobs = buildRefundReceiptJobs(
      updatedOrder,
      remainingAmount,
      updatedOrder.refundedReason ?? "未填寫原因",
      updatedAt,
    );
    persistPrintJobs([...refundPrintJobs, ...printJobs]);
    pushEvents([
      refundEvent,
      ...refundPrintJobs.map<QueueEvent>((job) => ({
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: job.id,
        payload: job,
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      })),
    ]);
    setViewingOrderId(null);
    setOrderActionRequest(null);
    setOrderActionReason("");
    setToast({ tone: "success", message: `${updatedOrder.localOrderNo} 已退款。` });
  }

  function partialRefundOrder(orderId: string, reason: string, quantities: Record<string, number>) {
    if (!canRefundOrder) {
      showPermissionDenied("退款");
      return;
    }
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder || !bootstrap) return;
    const refundedMap = refundedItemQtyMap(targetOrder);
    type RefundLine = NonNullable<NonNullable<PosOrder["refundRecords"]>[number]["items"]>[number];
    const refundItems = targetOrder.items
      .map((item) => {
        const key = itemIdentity(item);
        const alreadyRefunded = refundedMap.get(key) ?? 0;
        const available = Math.max(0, item.quantity - alreadyRefunded);
        const requested = Math.max(0, Math.min(available, quantities[key] ?? 0));
        if (requested <= 0) return null;
        const unitAmount = item.quantity > 0 ? item.price : 0;
        return {
          itemKey: key,
          name: item.name,
          quantity: requested,
          amount: unitAmount * requested,
        };
      })
      .filter((item): item is RefundLine => Boolean(item));

    if (refundItems.length === 0) {
      setToast({ tone: "info", message: "請先選擇要退款的菜品數量。" });
      return;
    }

    const refundSubtotal = refundItems.reduce((sum, item) => sum + item.amount, 0);
    const subtotalBase = targetOrder.subtotal || 1;
    const proportionalRatio = Math.min(1, refundSubtotal / subtotalBase);
    const refundAmount = Math.max(
      0,
      Number((targetOrder.total * proportionalRatio).toFixed(0)),
    );
    const updatedAt = new Date().toISOString();
    const totalRefundedAmount = Math.min(targetOrder.total, (targetOrder.refundedAmount ?? 0) + refundAmount);
    const fullyRefunded = totalRefundedAmount >= targetOrder.total;
    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: fullyRefunded ? "refunded" : "partially_refunded",
      refundedAt: updatedAt,
      refundedAmount: totalRefundedAmount,
      refundedReason: reason || "未填寫原因",
      refundRecords: [
        ...(targetOrder.refundRecords ?? []),
        {
          id: uid("refund"),
          amount: refundAmount,
          reason: reason || "未填寫原因",
          employeeAccount: authSession?.account,
          employeeName: authSession?.name,
          items: refundItems,
          createdAt: updatedAt,
        },
      ],
      updatedAt,
    };
    persistOrders(orders.map((order) => (order.id === orderId ? updatedOrder : order)));
    const refundEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_UPDATED",
      entityId: updatedOrder.id,
      payload: {
        order: updatedOrder,
        action: "refunded",
        amount: refundAmount,
        reason: reason || "未填寫原因",
        items: refundItems,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedAt,
    };
    const refundPrintJobs = buildRefundReceiptJobs(
      updatedOrder,
      refundAmount,
      reason || "未填寫原因",
      updatedAt,
      "部分退款單號",
    );
    persistPrintJobs([...refundPrintJobs, ...printJobs]);
    pushEvents([
      refundEvent,
      ...refundPrintJobs.map<QueueEvent>((job) => ({
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: job.id,
        payload: job,
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      })),
    ]);
    setPartialRefundOrderId(null);
    setPartialRefundReason("");
    setPartialRefundQuantities({});
    setViewingOrderId(null);
    setToast({
      tone: "success",
      message: fullyRefunded ? `${updatedOrder.localOrderNo} 已全部退款。` : `${updatedOrder.localOrderNo} 已完成部分退款。`,
    });
  }

  function printReceipt(order: PosOrder) {
    if (!bootstrap) return;
    const localPrintSettings = loadPosLocalSettings().printTemplates.receipt;
    type ReceiptItem = NonNullable<PrintJob["items"]>[number];
    const receiptPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
      (printer) => printer.enabled && printer.role === "receipt",
    );
    if (receiptPrinters.length === 0) return;

    const timestamp = new Date().toISOString();
    const receiptSections: Record<(typeof localPrintSettings.sectionOrder)[number], ReceiptItem[]> = {
      store_name: localPrintSettings.showStoreName ? [{ name: "門店", quantity: 1, specs: [], note: bootstrap.storeName }] : [],
      order_no: localPrintSettings.showOrderNo ? [{ name: "單號", quantity: 1, specs: [], note: order.localOrderNo }] : [],
      table_name: localPrintSettings.showTableName ? [{ name: "類型", quantity: 1, specs: [], note: order.tableName }] : [],
      items: order.items.map<ReceiptItem>((item) => ({
        name: item.name,
        quantity: item.quantity,
        specs: (item.selectedSpecs ?? []).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
        note: item.note,
      })),
      total: [{ name: "總計", quantity: 1, specs: [], note: formatMoney(order.total, bootstrap.currency) }],
      payment_method:
        localPrintSettings.showPaymentMethod && order.paymentMethod
          ? [{ name: "付款方式", quantity: 1, specs: [], note: String(order.paymentMethod) }]
          : [],
      order_note:
        localPrintSettings.showOrderNote && order.orderNote
          ? [{ name: "全單備註", quantity: 1, specs: [], note: order.orderNote }]
          : [],
      footer: localPrintSettings.footerText ? [{ name: "頁尾", quantity: 1, specs: [], note: localPrintSettings.footerText }] : [],
    } as const;
    const receiptItems: NonNullable<PrintJob["items"]> = localPrintSettings.sectionOrder.flatMap(
      (section) => receiptSections[section],
    );

    const nextPrintJobs = receiptPrinters.map<PrintJob>((printer) => ({
      id: uid("print"),
      orderId: order.id,
      orderNo: order.localOrderNo,
      tableName: order.tableName,
      ticketType: "normal",
      printerGroup: "receipt",
      printerName: printer.name,
      items: receiptItems,
      status: networkOnline ? "sent" : "pending",
      createdAt: timestamp,
    }));

    persistPrintJobs([...nextPrintJobs, ...printJobs]);
    pushEvents(
      nextPrintJobs.map<QueueEvent>((printJob) => ({
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: printJob.id,
        payload: printJob,
        status: networkOnline ? "synced" : "pending",
        createdAt: timestamp,
      })),
    );
  }

  function confirmPayment(method: string) {
    if (!bootstrap) return;
    const applyPaymentToOrder = (targetOrder: PosOrder, sourceOrders: PosOrder[]) => {
      const settledGrandTotal = Math.max(0, paymentBase.total - discountAmount - couponDiscount);
      const quickPaidFlow = isQuickMode && targetOrder.tableId === "counter";
      const updatedOrder: PosOrder = {
        ...targetOrder,
        status: quickPaidFlow ? "paid" : "settled",
        paymentMethod:
          memberDeduction > 0
            ? paymentSummary.total > 0
              ? `會員餘額 + ${method}`
              : "會員餘額"
            : couponDiscount > 0
              ? `優惠券 + ${method}`
              : method,
        discountAmount: discountAmount + couponDiscount,
        total: settledGrandTotal,
        updatedAt: new Date().toISOString(),
      };

      const nextOrders = sourceOrders.some((order) => order.id === updatedOrder.id)
        ? sourceOrders.map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
        : [updatedOrder, ...sourceOrders];
      persistOrders(nextOrders);

      if (memberMatch && (memberDeduction > 0 || selectedCouponIds.length > 0)) {
        const nextMembers = membersCache.map((member) =>
          member.id === memberMatch.id
            ? {
                ...member,
                balance: Math.max(0, member.balance - memberDeduction),
                coupons: member.coupons.map((coupon) =>
                  selectedCouponIds.includes(coupon.id)
                    ? { ...coupon, usedAt: new Date().toISOString() }
                    : coupon,
                ),
              }
            : member,
        );
        setMembersCache(nextMembers);
        saveMembers(nextMembers);
        setMemberMatch(nextMembers.find((member) => member.id === memberMatch.id) ?? null);
      }

      const paymentEvent: QueueEvent = {
        id: uid("evt"),
        type: "ORDER_SETTLED",
        entityId: updatedOrder.id,
        payload: {
          orderId: updatedOrder.id,
          total: settledGrandTotal,
          receivedAmount: Number(receivedAmount) || paymentSummary.total,
          changeDue,
          discountAmount: discountAmount + couponDiscount,
          paymentMethod: updatedOrder.paymentMethod,
          memberPhone: memberMatch?.phone ?? null,
          memberDeduction,
          couponDiscount,
          couponIds: selectedCouponIds,
          prepaidAmount,
          status: updatedOrder.status,
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
      setMemberPhone("");
      setMemberMatch(null);
      setSelectedPaymentMethod("");
      setUseMemberBalance(true);
      setSelectedCouponIds([]);
      setToast({
        tone: "success",
        message: networkOnline
          ? quickPaidFlow
            ? `已收款 ${updatedOrder.localOrderNo}，等待製作完成。`
            : `已完成 ${updatedOrder.localOrderNo} 結帳。`
          : quickPaidFlow
            ? `已離線記錄 ${updatedOrder.localOrderNo} 付款，待恢復網絡後補傳。`
            : `已離線記錄 ${updatedOrder.localOrderNo} 付款，待補傳。`,
      });
      setSettlementFlash(true);
      if (quickPaidFlow) {
        printReceipt(updatedOrder);
        setQuickPanel("cashier");
        setViewingOrderId(null);
      } else {
        backToTables();
      }
    };

    if (isQuickMode && payingOrderId === CART_PAYING_ID) {
      void (async () => {
        const createdOrder = await sendToKitchen({ silent: true });
        if (!createdOrder) return;
        applyPaymentToOrder(createdOrder, orders);
      })();
      return;
    }

    const targetOrder =
      (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
      (activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
      unsettledOrder;
    if (!targetOrder) return;

    applyPaymentToOrder(targetOrder, orders);
  }

  function completeOnlinePaidOrder() {
    if (!bootstrap) return;
    const targetOrder =
      (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
      (activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
      unsettledOrder;
    if (!targetOrder) return;

    const settledGrandTotal = Math.max(0, paymentBase.total - discountAmount - couponDiscount);
    const quickPaidFlow = isQuickMode && targetOrder.tableId === "counter";
    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: quickPaidFlow ? "paid" : "settled",
      paymentMethod: "線上已支付",
      discountAmount: discountAmount + couponDiscount,
      total: settledGrandTotal,
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
        total: settledGrandTotal,
        receivedAmount: 0,
        changeDue: 0,
        discountAmount: discountAmount + couponDiscount,
        paymentMethod: updatedOrder.paymentMethod,
        memberPhone: null,
        memberDeduction: 0,
        couponDiscount,
        couponIds: selectedCouponIds,
        prepaidAmount,
        status: updatedOrder.status,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([paymentEvent]);
    setToast({
      tone: "success",
      message: quickPaidFlow
        ? `客人已支付 ${updatedOrder.localOrderNo}，等待製作完成。`
        : `客人已支付，已完成 ${updatedOrder.localOrderNo}。`,
    });
    setSettlementFlash(true);
    if (quickPaidFlow) {
      setQuickPanel("cashier");
      setViewingOrderId(null);
    } else {
      backToTables();
    }
  }

  async function openSettlementModal() {
    if (isQuickMode) {
      if (cartItems.length === 0) {
        setToast({ tone: "info", message: "請先點餐再結帳。" });
        return;
      }
      setPayingOrderId(CART_PAYING_ID);
      setMembersCache(loadMembers());
      setSelectedPaymentMethod(paymentMethods[0] ?? "現金");
      setSelectedCouponIds([]);
      return;
    }

    const targetOrder =
      activeOrder?.status === "sent_to_kitchen"
        ? activeOrder
        : orders.find((order) => order.status === "sent_to_kitchen");
    if (!targetOrder) {
      setToast({ tone: "info", message: "目前沒有待結帳訂單。" });
      return;
    }
    setPayingOrderId(targetOrder.id);
    setMembersCache(loadMembers());
    setSelectedPaymentMethod(paymentMethods[0] ?? "現金");
    setSelectedCouponIds([]);
  }

  if (isBootstrapping || !bootstrap) {
    return <div className="empty-state">正在載入門店設定…</div>;
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[72px]">
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

                {offlineMode ? (
                  <button
                    className="mt-3 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700"
                    onClick={() => {
                      updateOfflineMode(false);
                      void syncNow(queue);
                    }}
                    type="button"
                  >
                    退出離線並補傳
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
                {isQuickMode ? (
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    快餐模式
                  </div>
                ) : (
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    桌號 {activeTable?.name ?? "--"}
                  </div>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                {!isQuickMode ? (
                  <button
                    className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                    onClick={backToTables}
                    type="button"
                  >
                    返回桌台
                  </button>
                ) : (
                  <div className="text-xs font-semibold text-slate-600">
                    可直接點餐並結帳
                  </div>
                )}
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
              {isQuickMode ? (
                <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-slate-200 bg-white p-2">
                  <button
                    className={`rounded-2xl px-3 py-2 text-xs font-semibold ${
                      quickOrderType === "dine_in" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setQuickOrderType("dine_in")}
                    type="button"
                  >
                    堂食
                  </button>
                  <button
                    className={`rounded-2xl px-3 py-2 text-xs font-semibold ${
                      quickOrderType === "delivery" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setQuickOrderType("delivery")}
                    type="button"
                  >
                    外賣
                  </button>
                  <button
                    className={`rounded-2xl px-3 py-2 text-xs font-semibold ${
                      quickOrderType === "pickup" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setQuickOrderType("pickup")}
                    type="button"
                  >
                    自取
                  </button>
                </div>
              ) : null}

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
                            {specText(item) || item.note || "未選規格"} · {formatMoney(item.price, bootstrap.currency)}
                          </div>
                        </button>
                        <div className="flex items-center gap-1">
                          <button
                            className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700"
                            onClick={(event) => {
                              event.stopPropagation();
                              updateQuantity(itemIdentity(item), -1);
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
                              updateQuantity(itemIdentity(item), 1);
                            }}
                            type="button"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <button
                          className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                          onClick={(event) => {
                            event.stopPropagation();
                            openItemNoteEditor(item);
                          }}
                          type="button"
                        >
                          {item.note ? "編輯備註" : "加備註"}
                        </button>
                        {item.note ? <div className="truncate text-xs text-slate-500">備註：{item.note}</div> : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 px-4 py-4">
              <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-600">全單備註</div>
                  <div className="truncate text-xs text-slate-500">{orderNote ? orderNote : "（可選）"}</div>
                </div>
                <button
                  className="shrink-0 rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={() => {
                    setNoteDraft(orderNote);
                    setNoteModal({ type: "order" });
                  }}
                  type="button"
                >
                  編輯
                </button>
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
                    className={`rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-all duration-150 focus:border-orange-400 ${
                      searchFocused ? "w-full xl:w-72" : "w-32 xl:w-40"
                    }`}
                    onBlur={() => setSearchFocused(false)}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    onFocus={() => setSearchFocused(true)}
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
                {filteredMenuItems.map((item) => {
                  const soldOut = isItemSoldOut(item.id);
                  const remainingQty = soldOutMap[item.id]?.remainingQty;
                  const hasRemainingBadge =
                    typeof remainingQty === "number" && remainingQty > 0 && (soldOutMap[item.id]?.initialQty ?? 0) > 0;
                  return (
                  <button
                    key={item.id}
                    className={`rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition ${
                      soldOut ? "opacity-60" : "hover:-translate-y-0.5 hover:border-orange-300"
                    }`}
                    onClick={() => addMenuItem(item)}
                    type="button"
                  >
                    <div className="flex min-h-[92px] flex-col justify-between">
                      <div>
                        <div className="line-clamp-2 text-sm font-semibold text-slate-900">{item.name}</div>
                        <div className="mt-2 text-xs text-slate-500">
                          {localSettings.menuPrinterOverrides[item.id] ?? item.printerGroup}
                        </div>
                        {soldOut ? (
                          <div className="mt-2 inline-flex rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                            售罄
                          </div>
                        ) : hasRemainingBadge ? (
                          <div className="mt-2 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                            只剩 {remainingQty} 份
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-4 flex items-center justify-between">
                        <div className="text-base font-semibold text-slate-900">
                          {formatMoney(item.price, bootstrap.currency)}
                        </div>
                        <div
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            soldOut ? "bg-slate-100 text-slate-500" : "bg-orange-50 text-orange-600"
                          }`}
                        >
                          {soldOut ? "不可加" : "加入"}
                        </div>
                      </div>
                    </div>
                  </button>
                  );
                })}
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
              {isQuickMode ? (
                <div className="grid grid-cols-3 gap-2">
                    <button
                      className={`rounded-2xl px-3 py-2 text-sm font-semibold ${
                        quickPanel === "online" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => setQuickPanel("online")}
                      type="button"
                    >
                      線上訂單
                    </button>
                    <button
                      className={`rounded-2xl px-3 py-2 text-sm font-semibold ${
                        quickPanel === "local" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => setQuickPanel("local")}
                      type="button"
                    >
                      堂食訂單
                    </button>
                    <button
                      className={`rounded-2xl px-3 py-2 text-sm font-semibold ${
                        quickPanel === "cashier" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => setQuickPanel("cashier")}
                      type="button"
                    >
                      收銀
                    </button>
                </div>
              ) : (
                <>
                  <div className="text-base font-semibold text-slate-900">收銀與支付</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {currentSettlementOrder
                      ? `待結帳單號 ${currentSettlementOrder.localOrderNo}`
                      : selectedTableStatus === "draft"
                        ? "目前尚未下單，可繼續加菜或送廚房"
                        : "目前未有待結帳訂單，可先開台或送廚房單"}
                  </div>
                </>
              )}
            </div>

            <div className="flex-1 overflow-auto px-4 py-4">
              {isQuickMode && quickPanel === "online" ? (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-500">自動接單</div>
                    <button
                      className={`rounded-full px-3 py-2 text-xs font-semibold ${
                        autoAcceptOnlineOrders ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700"
                      }`}
                      onClick={() => {
                        const next = !autoAcceptOnlineOrders;
                        const nextSettings = {
                          ...localSettings,
                          onlineOrderSettings: {
                            ...localSettings.onlineOrderSettings,
                            autoAccept: next,
                          },
                        };
                        setLocalSettings(nextSettings);
                        savePosLocalSettings(nextSettings);
                      }}
                      type="button"
                    >
                      {autoAcceptOnlineOrders ? "開" : "關"}
                    </button>
                  </div>

                  {onlineOrders.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      暫時沒有線上訂單
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {onlineOrders.slice(0, 16).map((order) => {
                        const sourceId = order.sourceId ?? order.id;
                        const paymentLabel =
                          order.paymentStatus === "paid"
                            ? `已支付 ${formatMoney(order.paidAmount ?? 0, bootstrap.currency)}`
                            : "未支付";
                        const statusLabel =
                          order.status === "pending" ? "新單" : order.status === "accepted" ? "已接單" : order.status;
                        const typeLabel =
                          order.type === "dine_in"
                            ? "堂食"
                            : order.type === "pickup"
                              ? "自取"
                              : order.type === "rider_delivery"
                                ? "車手"
                                : "外送";

                        return (
                          <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-slate-900">
                                  {order.id} <span className="ml-2 text-xs font-semibold text-slate-500">{typeLabel}</span>
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {statusLabel} · {paymentLabel}
                                </div>
                                {order.items?.length ? (
                                  <div className="mt-2 text-xs text-slate-500">
                                    {order.items.slice(0, 3).map((item) => `${item.name}x${item.qty}`).join(" · ")}
                                    {order.items.length > 3 ? " · ..." : ""}
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {order.status === "pending" ? (
                                  <button
                                    className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
                                    onClick={() => {
                                      void (async () => {
                                        try {
                                          await fetch("/api/online-orders", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ action: "accept", orderId: sourceId }),
                                          });
                                          const response = await fetch("/api/online-orders", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ action: "convert_quick", orderId: sourceId }),
                                          });
                                          const payload = (await response.json()) as {
                                            ok: boolean;
                                            posOrder?: PosOrder;
                                            error?: string;
                                          };
                                          if (!payload.ok || !payload.posOrder) {
                                            throw new Error(payload.error ?? "轉入快餐訂單失敗");
                                          }
                                          setOrders((current) => {
                                            const next = [
                                              payload.posOrder!,
                                              ...current.filter((item) => item.id !== payload.posOrder!.id),
                                            ];
                                            saveOrders(next);
                                            return next;
                                          });
                                            setViewingOrderId(payload.posOrder.id);
                                            setQuickPanel("local");
                                        } catch (err) {
                                          setToast({ tone: "info", message: err instanceof Error ? err.message : "接單失敗" });
                                        }
                                      })();
                                    }}
                                    type="button"
                                  >
                                    接單
                                  </button>
                                ) : (
                                  <button
                                    className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                                    onClick={() => {
                                      void (async () => {
                                        try {
                                          const response = await fetch("/api/online-orders", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ action: "convert_quick", orderId: sourceId }),
                                          });
                                          const payload = (await response.json()) as {
                                            ok: boolean;
                                            posOrder?: PosOrder;
                                            error?: string;
                                          };
                                          if (!payload.ok || !payload.posOrder) {
                                            throw new Error(payload.error ?? "轉入快餐訂單失敗");
                                          }
                                          setOrders((current) => {
                                            const next = [
                                              payload.posOrder!,
                                              ...current.filter((item) => item.id !== payload.posOrder!.id),
                                            ];
                                            saveOrders(next);
                                            return next;
                                          });
                                          setViewingOrderId(payload.posOrder.id);
                                          setQuickPanel("local");
                                        } catch (err) {
                                          setToast({ tone: "info", message: err instanceof Error ? err.message : "轉入失敗" });
                                        }
                                      })();
                                    }}
                                    type="button"
                                  >
                                    查看
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : isQuickMode && quickPanel === "local" ? (
                <div className="grid gap-3">
                  <div className="text-xs font-semibold text-slate-500">製作中</div>
                  <div className="grid gap-2">
                      {quickPreparingOrders.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                          暫時沒有製作中訂單
                        </div>
                      ) : (
                        quickPreparingOrders
                          .slice(0, 12)
                          .map((order) => (
                            <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-semibold text-slate-900">
                                    {order.localOrderNo} <span className="ml-2 text-xs text-slate-500">{order.tableName}</span>
                                  </div>
                                  <div className="mt-1 text-xs text-slate-500">
                                    {formatMoney(order.total, bootstrap.currency)}
                                    {order.prepaidAmount ? ` · 已支付 ${formatMoney(order.prepaidAmount, bootstrap.currency)}` : ""}
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <span
                                      className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${
                                        order.status === "paid"
                                          ? "bg-emerald-50 text-emerald-700"
                                          : "bg-amber-50 text-amber-700"
                                      }`}
                                    >
                                      製作中
                                    </span>
                                  </div>
                                  <div className="mt-2 text-xs text-slate-500">
                                    {order.items.slice(0, 3).map((item) => `${item.name}x${item.quantity}`).join(" · ")}
                                    {order.items.length > 3 ? " · ..." : ""}
                                  </div>
                                </div>
                                <button
                                  className="h-11 min-w-[96px] shrink-0 rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold whitespace-nowrap text-white"
                                  onClick={() => {
                                    setViewingOrderId(order.id);
                                  }}
                                  type="button"
                                >
                                  查看訂單
                                </button>
                              </div>
                            </div>
                          ))
                      )}
                  </div>

                  <div className="mt-2 text-xs font-semibold text-slate-500">待取餐 / 待交付</div>
                  <div className="grid gap-2">
                    {quickWaitingOrders.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                        暫時沒有待取餐 / 待交付訂單
                      </div>
                    ) : (
                      quickWaitingOrders.slice(0, 12).map((order) => (
                        <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900">
                                {order.localOrderNo} <span className="ml-2 text-xs text-slate-500">{order.tableName}</span>
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {formatMoney(order.total, bootstrap.currency)}
                                {order.prepaidAmount ? ` · 已支付 ${formatMoney(order.prepaidAmount, bootstrap.currency)}` : ""}
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                                  已支付
                                </span>
                                <span className="inline-flex rounded-full bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-700">
                                  {quickCompletionLabel(order)}
                                </span>
                              </div>
                              <div className="mt-2 text-xs text-slate-500">
                                {order.items.slice(0, 3).map((item) => `${item.name}x${item.quantity}`).join(" · ")}
                                {order.items.length > 3 ? " · ..." : ""}
                              </div>
                            </div>
                            <button
                              className="h-11 min-w-[96px] shrink-0 rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold whitespace-nowrap text-white"
                              onClick={() => {
                                setViewingOrderId(order.id);
                              }}
                              type="button"
                            >
                              查看訂單
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-500">已完成</div>
                    <div className="flex items-center gap-2">
                      <div>
                        <span className="text-xs text-slate-500">保留</span>
                      </div>
                      <select
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setQuickCompletedMinutes(next);
                          saveQuickCompletedMinutes(next);
                        }}
                        value={String(quickCompletedMinutes)}
                      >
                        <option value="5">5 分鐘</option>
                        <option value="10">10 分鐘</option>
                        <option value="30">30 分鐘</option>
                        <option value="60">60 分鐘</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    {recentCompletedOrders.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                        暫時沒有已完成訂單
                      </div>
                    ) : (
                      recentCompletedOrders.slice(0, 12).map((order) => (
                        <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-900">
                                {order.localOrderNo} <span className="ml-2 text-xs text-slate-500">{order.tableName}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                <span>{formatMoney(order.total, bootstrap.currency)}</span>
                                <span className="inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                                  已支付
                                </span>
                              </div>
                              <div className="mt-2 text-xs text-slate-500">
                                {order.items.slice(0, 3).map((item) => `${item.name}x${item.quantity}`).join(" · ")}
                                {order.items.length > 3 ? " · ..." : ""}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                                onClick={() => setViewingOrderId(order.id)}
                                type="button"
                              >
                                查看
                              </button>
                              <button
                                className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                onClick={() => reprintOrder(order)}
                                type="button"
                              >
                                重打單
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
              <>
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
                {!isQuickMode ? (
                  <button
                    className="rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600"
                    onClick={() => void sendToKitchen()}
                    type="button"
                  >
                    {isAddOnOrder ? "加單" : "下單"}
                  </button>
                ) : null}
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800"
                  onClick={() => void openSettlementModal()}
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

              <div className="mt-5">
                <div className="mb-2 text-xs font-semibold text-slate-500">廚房單預覽</div>
                {previewPrintJob ? (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3 border-b border-dashed border-slate-200 pb-3">
                      <div>
                        <div
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                            previewPrintJob.ticketType === "void"
                              ? "bg-red-50 text-red-700"
                              : previewPrintJob.ticketType === "addon"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {ticketTypeLabel(previewPrintJob.ticketType)}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {previewPrintJob.printerName} · {previewPrintJob.printerGroup}
                        </div>
                      </div>
                      <div className="text-right text-xs text-slate-500">
                        <div>{previewPrintJob.orderNo ?? "--"}</div>
                        <div className="mt-1">{previewPrintJob.tableName ?? "--"}</div>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3">
                      {(previewPrintJob.items ?? []).map((item, index) => (
                        <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-100 pb-3 last:border-b-0 last:pb-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-sm font-semibold text-slate-900">{item.name}</div>
                            <div className="text-sm font-semibold text-slate-900">x{item.quantity}</div>
                          </div>
                          {item.specs?.length ? (
                            <div className="mt-1 text-xs text-slate-500">{item.specs.join(" / ")}</div>
                          ) : null}
                          {item.note ? <div className="mt-1 text-xs text-slate-500">備註：{item.note}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                    這張桌子還沒有打印記錄
                  </div>
                )}
              </div>

              {offlineMode ? (
                <button
                  className="mt-3 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700"
                  onClick={() => {
                    updateOfflineMode(false);
                    void syncNow(queue);
                  }}
                  type="button"
                >
                  退出離線並補傳
                </button>
              ) : null}

              {/* 最近訂單：點餐頁不顯示，避免干擾店員操作 */}
              </>
              )}
            </div>
          </section>
        </div>
        )}
      </div>

      <ItemSpecModal
        key={`${specModalItem?.id ?? "none"}-${specEditingKey ?? "new"}-${JSON.stringify(selectedSpecValues)}`}
        onClose={() => {
          setSpecModalOpen(false);
          setSpecModalItem(null);
          setSpecEditingKey(null);
          setSelectedSpecValues({});
        }}
        onConfirm={applySpecSelection}
        open={specModalOpen}
        selectedSpecs={selectedSpecValues}
        specGroups={specModalItem?.specGroups ?? []}
        title={specModalItem ? `${specModalItem.name} 規格` : "規格"}
      />

      {noteModal ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">
                  {noteModal.type === "order" ? "全單備註" : "單品備註"}
                </div>
                <div className="mt-1 text-sm text-slate-500">可多選常用備註，也可自由輸入。</div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setNoteModal(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-500">常用備註</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {localSettings.notePresets.length === 0 ? (
                  <div className="text-sm text-slate-500">尚未設定常用備註（可到 設置 → 備註 新增）。</div>
                ) : (
                  localSettings.notePresets.map((preset) => (
                    <button
                      key={preset}
                      className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                      onClick={() => {
                        const base = noteDraft.trim();
                        const next = base ? (base.includes(preset) ? base : `${base}，${preset}`) : preset;
                        setNoteDraft(next);
                      }}
                      type="button"
                    >
                      {preset}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-500">自由輸入</div>
              <textarea
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none focus:border-orange-400"
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="例如：不要吸管、少辣、走蔥..."
                rows={4}
                value={noteDraft}
              />
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setNoteDraft("")}
                type="button"
              >
                清空
              </button>
              <button
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  if (noteModal.type === "order") {
                    setOrderNote(noteDraft.trim());
                  } else if (noteModal.itemKey) {
                    applyItemNote(noteModal.itemKey, noteDraft);
                  }
                  setNoteModal(null);
                }}
                type="button"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {viewingOrder ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-900">訂單詳情</div>
                <div className="mt-1 text-sm text-slate-500">
                  {viewingOrder.localOrderNo} · {viewingOrder.tableName}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {viewingOrder.status === "refunded" ? (
                  <div className="inline-flex rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
                    已退款
                  </div>
                ) : viewingOrder.status === "partially_refunded" ? (
                  <div className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                    部分退款
                  </div>
                ) : viewingOrder.status === "cancelled" ? (
                  <div className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                    已取消
                  </div>
                ) : viewingOrder.status === "settled" ? (
                  <div className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                    已完成
                  </div>
                ) : viewingOrder.status === "paid" || (viewingOrder.prepaidAmount ?? 0) >= viewingOrder.total ? (
                  <>
                    <div className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      已支付
                    </div>
                    <div className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                      待完成
                    </div>
                  </>
                ) : (
                  <div className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                    待結帳
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-2">
              {viewingOrder.items.map((item, index) => (
                <div key={`${item.menuItemId}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                      {item.selectedSpecs?.length ? (
                        <div className="mt-1 text-xs text-slate-500">
                          {item.selectedSpecs.map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ")}
                        </div>
                      ) : null}
                      {item.note ? <div className="mt-1 text-xs text-slate-500">備註：{item.note}</div> : null}
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-slate-900">x{item.quantity}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>總計</span>
                <span className="text-base font-semibold text-slate-900">{formatMoney(viewingOrder.total, bootstrap.currency)}</span>
              </div>
              {viewingOrder.orderNote ? (
                <div className="mt-2 text-sm text-slate-500">
                  全單備註：<span className="font-semibold text-slate-900">{viewingOrder.orderNote}</span>
                </div>
              ) : null}
              {viewingOrder.prepaidAmount ? (
                <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
                  <span>已支付</span>
                  <span className="font-semibold text-slate-900">
                    {formatMoney(viewingOrder.prepaidAmount, bootstrap.currency)}
                  </span>
                </div>
              ) : null}
              {viewingOrder.cancelledReason ? (
                <div className="mt-2 text-sm text-slate-500">
                  取消原因：<span className="font-semibold text-slate-900">{viewingOrder.cancelledReason}</span>
                </div>
              ) : null}
              {viewingOrder.refundedReason ? (
                <div className="mt-2 text-sm text-slate-500">
                  退款原因：<span className="font-semibold text-slate-900">{viewingOrder.refundedReason}</span>
                </div>
              ) : null}
              {(viewingOrder.refundedAmount ?? 0) > 0 ? (
                <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
                  <span>已退款</span>
                  <span className="font-semibold text-red-700">
                    {formatMoney(viewingOrder.refundedAmount ?? 0, bootstrap.currency)}
                  </span>
                </div>
              ) : null}
              {viewingOrder.refundRecords?.length ? (
                <div className="mt-4 rounded-2xl border border-red-100 bg-red-50/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900">退款明細</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() => exportRefundDetails(viewingOrder)}
                        type="button"
                      >
                        導出明細
                      </button>
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() => setRefundSummaryExportOpen(true)}
                        type="button"
                      >
                        匯總導出
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3">
                    {viewingOrder.refundRecords
                      .slice()
                      .reverse()
                      .map((record) => (
                        <div key={record.id} className="rounded-2xl border border-red-100 bg-white p-3">
                          <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="font-semibold text-slate-900">{record.createdAt.replace("T", " ").slice(0, 16)}</span>
                            <span className="font-semibold text-red-700">
                              {formatMoney(record.amount, bootstrap.currency)}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">原因：{record.reason}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            操作人：{record.employeeName ?? record.employeeAccount ?? "未記錄"}
                          </div>
                          {record.items?.length ? (
                            <div className="mt-2 grid gap-1">
                              {record.items.map((item) => (
                                <div key={`${record.id}-${item.itemKey}`} className="flex items-center justify-between text-xs text-slate-600">
                                  <span>{item.name} × {item.quantity}</span>
                                  <span>{formatMoney(item.amount, bootstrap.currency)}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setViewingOrderId(null)}
                type="button"
              >
                關閉
              </button>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => reprintOrder(viewingOrder)}
                type="button"
              >
                重打單
              </button>
              {(viewingOrder.status === "paid" || (viewingOrder.prepaidAmount ?? 0) >= viewingOrder.total) &&
              viewingOrder.status !== "settled" &&
              viewingOrder.status !== "refunded" ? (
                <button
                  className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => markOrderCompleted(viewingOrder.id)}
                  type="button"
                >
                  已完成
                </button>
              ) : null}
              {(viewingOrder.status === "settled" || viewingOrder.status === "partially_refunded") ? (
                <>
                  <button
                    className="rounded-2xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={!canRefundOrder}
                    onClick={() => {
                      if (!canRefundOrder) {
                        showPermissionDenied("退款");
                        return;
                      }
                      setPartialRefundOrderId(viewingOrder.id);
                      setPartialRefundReason("");
                      setPartialRefundQuantities({});
                    }}
                    type="button"
                  >
                    部分退款
                  </button>
                  <button
                    className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={!canRefundOrder}
                    onClick={() => {
                      if (!canRefundOrder) {
                        showPermissionDenied("退款");
                        return;
                      }
                      setOrderActionRequest({ type: "refund_order", orderId: viewingOrder.id });
                      setOrderActionReason("");
                    }}
                    type="button"
                  >
                    整單退款
                  </button>
                </>
              ) : null}
              {(viewingOrder.status === "draft" || viewingOrder.status === "sent_to_kitchen") ? (
                <button
                  className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => {
                    setOrderActionRequest({ type: "cancel_order", orderId: viewingOrder.id });
                    setOrderActionReason("");
                  }}
                  type="button"
                >
                  取消結帳
                </button>
              ) : null}
              {viewingOrder.status !== "settled" &&
              viewingOrder.status !== "cancelled" &&
              viewingOrder.status !== "refunded" &&
              (viewingOrder.prepaidAmount ?? 0) < viewingOrder.total ? (
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => {
                    setViewingOrderId(null);
                    setPayingOrderId(viewingOrder.id);
                    setQuickPanel("cashier");
                  }}
                  type="button"
                >
                  去結帳
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {payingOrderId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-900">結帳</div>
                <div className="mt-1 text-sm text-slate-500">
                  {payingOrderId === CART_PAYING_ID
                    ? "本次結帳"
                    : currentSettlementOrder
                      ? `訂單 ${currentSettlementOrder.localOrderNo}`
                      : "待結帳訂單"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {currentSettlementOrder && currentSettlementOrder.status !== "paid" ? (
                  <button
                    className="rounded-full bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
                    onClick={() => {
                      setPayingOrderId(null);
                      setOrderActionRequest({ type: "cancel_order", orderId: currentSettlementOrder.id });
                      setOrderActionReason("");
                    }}
                    type="button"
                  >
                    取消結帳
                  </button>
                ) : null}
                <button
                  className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={() => setPayingOrderId(null)}
                  type="button"
                >
                  關閉
                </button>
              </div>
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
                      {formatMoney(paymentSummary.manualDiscountAmount, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">優惠券抵扣</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(paymentSummary.couponDiscount, bootstrap.currency)}
                    </span>
                  </div>
                  {paymentSummary.prepaidAmount > 0 ? (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">客人已支付</span>
                      <span className="font-semibold text-emerald-700">
                        {formatMoney(paymentSummary.prepaidAmount, bootstrap.currency)}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">
                      {paymentSummary.prepaidAmount > 0 ? "剩餘需收" : "應收"}
                    </span>
                    <span className="text-2xl font-semibold text-orange-600">
                      {formatMoney(paymentSummary.total, bootstrap.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500">會員扣款</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(paymentSummary.memberDeduction, bootstrap.currency)}
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
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      inputMode="decimal"
                      onChange={(event) => setDiscountValue(event.target.value)}
                      value={discountValue}
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    實收金額
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      inputMode="decimal"
                      onChange={(event) => setReceivedAmount(event.target.value)}
                      value={receivedAmount}
                    />
                  </label>
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="text-xs font-semibold text-slate-500">會員號碼</div>
                    <div className="mt-2 flex gap-2">
                      <input
                        className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        inputMode="numeric"
                        maxLength={8}
                        onChange={(event) => setMemberPhone(event.target.value.replace(/\D/g, "").slice(0, 8))}
                        placeholder="輸入 8 位手機號碼"
                        value={memberPhone}
                      />
                      <button
                        className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                        onClick={() => {
                          setMemberSearchHint("");
                          setMemberMatch(null);
                          if (!/^\d{8}$/.test(memberPhone)) {
                            setMemberSearchHint("請輸入 8 位手機號碼。");
                            return;
                          }
                          void (async () => {
                            try {
                              const response = await fetch(`/api/members?phone=${memberPhone}`);
                              const payload = (await response.json()) as { members?: MemberProfile[] };
                              const match = (payload.members ?? []).find((member) => member.phone === memberPhone) ?? null;
                              setMemberMatch(match);
                              setMemberSearchHint(match ? "" : "找不到會員。");
                            } catch {
                              const match = membersCache.find((member) => member.phone === memberPhone) ?? null;
                              setMemberMatch(match);
                              setMemberSearchHint(match ? "" : "找不到會員。");
                            }
                          })();
                        }}
                        type="button"
                      >
                        搜尋
                      </button>
                    </div>
                    {memberSearchHint ? <div className="mt-2 text-xs text-red-600">{memberSearchHint}</div> : null}
                    {memberMatch ? (
                      <div className="mt-3 rounded-2xl bg-slate-50 p-3 text-sm">
                        <div className="font-semibold text-slate-900">
                          {memberMatch.name} · {memberMatch.phone}
                        </div>
                        <div className="mt-1 text-slate-500">
                          餘額 {formatMoney(memberMatch.balance, bootstrap.currency)} · 優惠券{" "}
                          {memberMatch.coupons.filter((coupon) => !coupon.usedAt && !couponIsExpired(coupon)).length} 張可用
                        </div>
                        <label className="mt-3 grid gap-1">
                          <span className="text-xs font-semibold text-slate-600">使用優惠券</span>
                          <div className="grid gap-2">
                            {memberMatch.coupons.filter((coupon) => !coupon.usedAt && !couponIsExpired(coupon)).length === 0 ? (
                              <div className="text-xs text-slate-500">目前沒有可用優惠券</div>
                            ) : (
                              memberMatch.coupons
                                .filter((coupon) => !coupon.usedAt && !couponIsExpired(coupon))
                                .map((coupon) => {
                                  const baseAmount = Math.max(0, paymentBase.total - discountAmount);
                                  const off = couponDiscountAmount(coupon, baseAmount);
                                  const selected = selectedCouponIds.includes(coupon.id);
                                  const hasNonStackableSelected = selectedCouponIds
                                    .map((id) => memberMatch.coupons.find((c) => c.id === id))
                                    .some((c) => c && !c.stackable);
                                  const disableBecauseStackRule =
                                    !selected && (hasNonStackableSelected || (!coupon.stackable && selectedCouponIds.length > 0));
                                  const disabled = off <= 0 || disableBecauseStackRule;
                                  return (
                                    <label
                                      key={coupon.id}
                                      className={`flex items-start justify-between gap-3 rounded-2xl border px-3 py-2 ${
                                        selected
                                          ? "border-orange-300 bg-orange-50"
                                          : "border-slate-200 bg-white"
                                      } ${disabled ? "opacity-60" : ""}`}
                                    >
                                      <div>
                                        <div className="text-sm font-semibold text-slate-900">{coupon.title}</div>
                                        <div className="mt-1 text-xs text-slate-500">
                                          {coupon.minSpend ? `滿 ${formatMoney(coupon.minSpend, bootstrap.currency)} 可用` : "無門檻"} ·{" "}
                                          {coupon.stackable ? "可疊加" : "不可疊加"}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <div className="text-xs font-semibold text-slate-700">
                                          {off > 0 ? `- ${formatMoney(off, bootstrap.currency)}` : "不符合條件"}
                                        </div>
                                        <input
                                          checked={selected}
                                          disabled={disabled}
                                          onChange={(event) => {
                                            const checked = event.target.checked;
                                            setSelectedCouponIds((current) => {
                                              if (checked) {
                                                // 若選中不可疊加券，清掉其他券
                                                if (!coupon.stackable) return [coupon.id];
                                                // 若已有不可疊加券，禁止再加（理論上 disabled 已擋）
                                                return [...current, coupon.id];
                                              }
                                              return current.filter((id) => id !== coupon.id);
                                            });
                                          }}
                                          type="checkbox"
                                        />
                                      </div>
                                    </label>
                                  );
                                })
                            )}
                          </div>
                        </label>
                        <label className="mt-3 flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold text-slate-600">使用會員餘額先扣</span>
                          <input
                            checked={useMemberBalance}
                            onChange={(event) => setUseMemberBalance(event.target.checked)}
                            type="checkbox"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-900">支付方式</div>
                <div className="mt-1 text-xs text-slate-500">若會員餘額不足，剩餘金額可混支付。</div>
                <div className="mt-3 grid gap-2">
                  {paymentMethods.map((method) => (
                    <button
                      key={method}
                      className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold ${
                        selectedPaymentMethod === method
                          ? "border-orange-300 bg-orange-50 text-orange-700"
                          : "border-slate-200 bg-slate-50 text-slate-900 hover:border-orange-300"
                      }`}
                      onClick={() => setSelectedPaymentMethod(method)}
                      type="button"
                    >
                      {method}
                    </button>
                  ))}
                </div>

                <button
                  className="mt-4 w-full rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600"
                  onClick={() => {
                    if (paymentSummary.total <= 0 && paymentSummary.prepaidAmount > 0) {
                      completeOnlinePaidOrder();
                      return;
                    }
                    confirmPayment(selectedPaymentMethod || paymentMethods[0] || "現金");
                  }}
                  type="button"
                >
                  {paymentSummary.total <= 0 && paymentSummary.prepaidAmount > 0
                    ? "客人已支付，完成訂單"
                    : "去結帳"}
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
                修改規格
              </button>
              <button
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300 disabled:opacity-50"
                disabled={!canVoidItem}
                onClick={() => {
                  if (!canVoidItem) {
                    showPermissionDenied("退菜");
                    return;
                  }
                  setVoidRequest({ item: actionItem, mode: "one" });
                }}
                type="button"
              >
                退 1 份
              </button>
              <button
                className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                disabled={!canVoidItem}
                onClick={() => {
                  if (!canVoidItem) {
                    showPermissionDenied("退菜");
                    return;
                  }
                  setVoidRequest({ item: actionItem, mode: "all" });
                }}
                type="button"
              >
                全部退菜
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {orderActionRequest ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <div className="text-lg font-semibold text-slate-900">
              {orderActionRequest.type === "refund_order" ? "退款原因" : "取消結帳原因"}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {orders.find((order) => order.id === orderActionRequest.orderId)?.localOrderNo ?? "--"}
            </div>
            <input
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm"
              onChange={(event) => setOrderActionReason(event.target.value)}
              placeholder={orderActionRequest.type === "refund_order" ? "例如：客人退款 / 支付失敗" : "例如：客人不要了 / 重開一單"}
              value={orderActionReason}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => {
                  setOrderActionRequest(null);
                  setOrderActionReason("");
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  if (orderActionRequest.type === "refund_order") {
                    refundOrder(orderActionRequest.orderId, orderActionReason.trim());
                  } else {
                    cancelOrder(orderActionRequest.orderId, orderActionReason.trim());
                  }
                }}
                type="button"
              >
                {orderActionRequest.type === "refund_order" ? "確認退款" : "確認取消"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {refundSummaryExportOpen ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl">
            <div className="text-lg font-semibold text-slate-900">退款匯總導出</div>
            <div className="mt-1 text-sm text-slate-500">可按日期或按員工，把目前訂單中的退款記錄匯總導出成 CSV。</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">匯總方式</span>
                <select
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setRefundSummaryMode(event.target.value as "date" | "employee")}
                  value={refundSummaryMode}
                >
                  <option value="date">按日期</option>
                  <option value="employee">按員工</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">開始日期</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setRefundSummaryDateFrom(event.target.value)}
                  type="date"
                  value={refundSummaryDateFrom}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                <span className="text-xs text-slate-500">結束日期</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setRefundSummaryDateTo(event.target.value)}
                  type="date"
                  value={refundSummaryDateTo}
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setRefundSummaryExportOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={exportRefundSummary}
                type="button"
              >
                導出 CSV
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {partialRefundOrderId ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/45 p-4">
          <div className="flex w-full max-w-2xl max-h-[calc(100vh-32px)] flex-col rounded-3xl bg-white p-5 shadow-2xl">
            {(() => {
              const order = orders.find((item) => item.id === partialRefundOrderId);
              if (!order || !bootstrap) return null;
              const refundedMap = refundedItemQtyMap(order);
              const refundableRows = order.items
                .map((item) => {
                  const key = itemIdentity(item);
                  const alreadyRefunded = refundedMap.get(key) ?? 0;
                  const availableQty = Math.max(0, item.quantity - alreadyRefunded);
                  return {
                    item,
                    key,
                    availableQty,
                    selectedQty: Math.max(0, Math.min(availableQty, partialRefundQuantities[key] ?? 0)),
                  };
                })
                .filter((row) => row.availableQty > 0);
              const refundSubtotal = refundableRows.reduce(
                (sum, row) => sum + row.item.price * row.selectedQty,
                0,
              );
              const refundAmount = Math.max(
                0,
                Number(((order.total * (refundSubtotal / Math.max(order.subtotal || 1, 1))) || 0).toFixed(0)),
              );
              return (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-slate-900">部分退款</div>
                      <div className="mt-1 text-sm text-slate-500">{order.localOrderNo} · 選擇要退款的菜品與數量</div>
                    </div>
                    <button
                      className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                      onClick={() => {
                        setPartialRefundOrderId(null);
                        setPartialRefundReason("");
                        setPartialRefundQuantities({});
                      }}
                      type="button"
                    >
                      關閉
                    </button>
                  </div>
                  <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
                    <div className="grid gap-3">
                      {refundableRows.map(({ item, key, availableQty, selectedQty }) => (
                        <div key={key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900">{item.name}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                單價 {formatMoney(item.price, bootstrap.currency)} · 可退 {availableQty} 份
                              </div>
                              {item.selectedSpecs?.length ? (
                                <div className="mt-1 text-xs text-slate-500">
                                  {item.selectedSpecs.map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ")}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                className="rounded-full bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                                onClick={() =>
                                  setPartialRefundQuantities((current) => ({
                                    ...current,
                                    [key]: Math.max(0, (current[key] ?? 0) - 1),
                                  }))
                                }
                                type="button"
                              >
                                -
                              </button>
                              <div className="w-10 text-center text-sm font-semibold text-slate-900">{selectedQty}</div>
                              <button
                                className="rounded-full bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                                onClick={() =>
                                  setPartialRefundQuantities((current) => ({
                                    ...current,
                                    [key]: Math.min(availableQty, (current[key] ?? 0) + 1),
                                  }))
                                }
                                type="button"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <label className="grid gap-1 text-sm font-semibold text-slate-700">
                      <span className="text-xs text-slate-500">退款原因</span>
                      <input
                        className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                        onChange={(event) => setPartialRefundReason(event.target.value)}
                        placeholder="例如：少做一杯 / 客人退某款配料"
                        value={partialRefundReason}
                      />
                    </label>
                    <div className="mt-3 flex items-center justify-between text-sm">
                      <span className="text-slate-500">預計退款</span>
                      <span className="text-lg font-semibold text-red-700">
                        {formatMoney(refundAmount, bootstrap.currency)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                      onClick={() => {
                        setPartialRefundOrderId(null);
                        setPartialRefundReason("");
                        setPartialRefundQuantities({});
                      }}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => partialRefundOrder(order.id, partialRefundReason.trim(), partialRefundQuantities)}
                      type="button"
                    >
                      確認部分退款
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}

      {voidRequest ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl">
            <div className="text-lg font-semibold text-slate-900">退菜原因</div>
            <div className="mt-1 text-sm text-slate-500">{voidRequest.item.name}</div>
            <input
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm"
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="例如：客人取消 / 廚房售罄"
              value={voidReason}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => {
                  setVoidRequest(null);
                  setVoidReason("");
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  voidOrderedItem(voidRequest.item, voidRequest.mode, voidReason.trim());
                  setVoidRequest(null);
                  setVoidReason("");
                  setItemActionKey(null);
                }}
                type="button"
              >
                確認退菜
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

      {!shift.openedAt ? (
        <div className="fixed inset-0 z-[52] grid place-items-center bg-slate-950/55 p-4 lg:pl-[72px]">
          <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-2xl">
            <div className="text-sm font-semibold tracking-widest text-orange-500">今日未開工</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">開始今日營業</div>
            <div className="mt-2 text-sm text-slate-500">
              未開工前不能點餐。按下方按鈕後，今日班次正式開始。
            </div>
            <button
              className="mt-6 w-full rounded-3xl bg-orange-500 px-6 py-5 text-xl font-semibold text-white hover:bg-orange-600"
              onClick={startWork}
              type="button"
            >
              開工
            </button>
          </div>
        </div>
      ) : null}

      {orderSuccessFlash ? (
        <div className="pointer-events-none fixed inset-0 z-[55] grid place-items-center p-4">
          <div className="rounded-3xl bg-emerald-600 px-8 py-5 text-lg font-semibold text-white shadow-2xl">
            下單成功
          </div>
        </div>
      ) : null}

      {settlementFlash ? (
        <div className="pointer-events-none fixed inset-0 z-[55] grid place-items-center p-4">
          <div className="rounded-3xl bg-emerald-600 px-8 py-5 text-lg font-semibold text-white shadow-2xl">
            已結帳
          </div>
        </div>
      ) : null}
    </div>
  );
}
