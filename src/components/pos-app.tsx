"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { tryAutoPairCompanion } from "@/lib/print-bridge/auto-pair-companion";

import { AppSidebar } from "@/components/app-sidebar";
import { ItemSpecModal } from "@/components/item-spec-modal";
import { FixedNumberPad } from "@/components/fixed-number-pad";
import { NumericKeypad } from "@/components/numeric-keypad";
import { OrderSourceBadge } from "@/components/order-source-badge";
import { QuickModeOrdersBar } from "@/components/quick-mode-orders-bar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { applyLedgerMerchantToBootstrap, resolveStoreDisplaySubtitle, resolveStoreDisplayTitle } from "@/lib/store-display";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { resolvePrintJobStatus } from "@/lib/print-bridge/companion";
import { mergePrintJobs } from "@/lib/pos/print-job-merge";
import {
  isOrderNoteLocked,
  ITEM_SPEC_LOCKED_MESSAGE,
  ORDER_NOTE_LOCKED_MESSAGE,
} from "@/lib/pos/order-note-lock";
import {
  appendPrintJobs,
  buildKitchenPrintJobs,
  buildKioskReceiptPrintJobs,
  buildLabelPrintJobs,
  buildReceiptPrintJobs,
  buildVoidPrintJobsForOrder,
} from "@/lib/print-jobs";
import { isSelfOrder } from "@/lib/pos/order-source";
import { isTerminalOrderStatus, filterResurrectedOrders, getOrderStatusBadge } from "@/lib/pos-order-filters";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadBootstrapCache,
  loadDeviceConfig,
  loadAuthSession,
  clearLegacyMembersCache,
  loadOperatingMode,
  saveOperatingMode,
  loadPosLocalSettings,
  loadQuickCompletedMinutes,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  loadShiftState,
  loadSoldOutState,
  loadClearedPrintJobIds,
  loadDeletedOrderIds,
  addDeletedOrderIds,
  nextLocalDailyOrderNo,
  saveBootstrapCache,
  saveDeviceConfig,
  saveOrders,
  savePosLocalSettings,
  savePrintJobs,
  saveQueue,
  saveQuickCompletedMinutes,
  saveShiftState,
  saveSoldOutState,
} from "@/lib/storage";
import { executeLedgerMemberCheckout, LedgerMemberCheckoutError } from "@/lib/ledger/checkout-member";
import { friendlyLedgerMemberError } from "@/lib/ledger/member-errors";
import { getLedgerMerchantId } from "@/lib/ledger/session";
import { lookupCustomerWallet } from "@/lib/ledger/members";
import {
  avosToMop,
  grantTypeLabel,
  LedgerCheckoutMember,
  mopToAvos,
  sumMoneyVoucherAvos,
} from "@/lib/ledger/member-types";
import { listRedeemableGrantsForCustomer } from "@/lib/ledger/rewards";
import { patchMenuFromRealtimeRecord } from "@/lib/ledger/menu-import";
import { useLedgerProductsRealtime } from "@/lib/ledger/use-ledger-products-realtime";
import {
  quickCompleteLabel,
  quickCompletionLabel,
} from "@/lib/quick-order-fulfillment";
import { useNetworkOnline } from "@/lib/use-network-online";
import { filterQuickActionBarOrders, localOrderStatusLabel, mergeOrderLists } from "@/lib/pos-order-filters";
import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import { confirmSelfOrder, reopenPosOrder, rejectSelfOrder, removeReopenTempTable } from "@/lib/pos-orders";
import { DeviceConfig, MenuItem, MenuSpecGroup, OrderItem, PosBootstrap, PosLocalSettings, PosOrder, PrintJob, QueueEvent, StoreTable } from "@/lib/types";
import { formatMoney, formatMacauDateTime } from "@/lib/format";

type Toast = {
  tone: "info" | "success" | "warning" | "error";
  message: string;
};

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function ticketTypeLabel(ticketType: PrintJob["ticketType"]) {
  if (ticketType === "addon") return "加單";
  if (ticketType === "void") return "VOID / 退菜";
  return "正常下單";
}

function orderTotals(items: OrderItem[], bootstrap: PosBootstrap) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const serviceChargeAmount = subtotal * bootstrap.rules.serviceChargeRate;
  const taxAmount = subtotal * bootstrap.rules.taxRate;
  const total = subtotal + serviceChargeAmount + taxAmount;

  return { subtotal, serviceChargeAmount, taxAmount, total };
}

/**
 * 枱檯 view 嘅樓層來源：以 `bootstrap.tables`（DB 共享真源）為基，按 area 分組；
 * 再疊加本地獨有枱（唔喺 bootstrap，例如返結 temp 枱 / 本地新增）保留原 floor。
 * 目的：kiosk / 掃碼落單用嘅枱 ID 來自 bootstrap.tables，收銀枱檯 view 必須收佢哋，
 * 否則張單喺枱檯 view 無處可放（之前 localSettings.floors 唔包 bootstrap 枱 → 單 invisible）。
 */
function buildDisplayFloors(
  bootstrapTables: PosBootstrap["tables"],
  localFloors: PosLocalSettings["floors"],
): PosLocalSettings["floors"] {
  const bootstrapIds = new Set(bootstrapTables.map((t) => t.id));
  // 本地枱按 id 建索引：枱嘅 name / area / capacity 等以 localSettings 為準（per-terminal 編輯真源），
  // bootstrap.tables 只負責補「枱 ID 存在性」呢層（kiosk / 掃碼落單共享真源），唔再話事 area。
  const localTableById = new Map<string, StoreTable>();
  for (const lf of localFloors) {
    for (const t of lf.tables) localTableById.set(t.id, t);
  }

  // 統一按 area 名（trim）分組：bootstrap 枱 + 本地獨有枱都併入同一個 floor，
  // floor id 固定用 `area:<名>`，確保「一個樓層名 = 一個 floor」，唔會重複（如兩個「1樓」）。
  const byArea = new Map<string, StoreTable[]>();

  const addTable = (table: StoreTable, area: string | undefined) => {
    const key = area && area.trim() ? area.trim() : table.area && table.area.trim() ? table.area.trim() : "未分區";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key)!.push(table);
  };

  // 1) 共享真源：bootstrap.tables 提供枱 ID；有對應本地枱就用本地版本（area 以本地編輯為準）
  for (const t of bootstrapTables) {
    const local = localTableById.get(t.id) ?? t;
    addTable(local, local.area);
  }

  // 2) overlay：本地獨有枱（唔喺 bootstrap）按 area 併入同層，避免重複樓層名
  for (const lf of localFloors) {
    for (const t of lf.tables) {
      if (bootstrapIds.has(t.id)) continue;
      addTable(t, t.area || lf.name);
    }
  }

  return Array.from(byArea.entries()).map(([area, tables]) => ({
    id: `area:${area}`,
    name: area,
    tables,
  }));
}

/** 樓層選擇器嘅「全部」特殊值：一掣顯示所有樓層嘅枱。 */
const ALL_FLOOR_ID = "__all__";

const CART_PAYING_ID = "__cart__";
const ALL_MENU_CATEGORY_ID = "__all__";

export function PosApp() {
  const router = useRouter();
  const cachedBootstrapRaw = loadBootstrapCache();
  const cachedBootstrap = cachedBootstrapRaw
    ? applyLedgerMerchantToBootstrap(normalizeBootstrapPayload(cachedBootstrapRaw), loadAuthSession())
    : null;
  const initialHasBootstrapRef = useRef(Boolean(cachedBootstrap));
  const [operatingMode, setOperatingModeState] = useState(() => loadOperatingMode());
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(() => cachedBootstrap);
  const [activeTableId, setActiveTableId] = useState<string>(() => cachedBootstrap?.tables[0]?.id ?? "");
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [voidedItems, setVoidedItems] = useState<OrderItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const networkOnline = useNetworkOnline();
  const offlineMode = !networkOnline;
  const [queue, setQueue] = useState<QueueEvent[]>(() => loadQueue());
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [toast, setToast] = useState<Toast | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(() => !loadBootstrapCache());
  const [activeCategoryId, setActiveCategoryId] = useState<string>(() => cachedBootstrap?.categories[0]?.id ?? "");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [roReason, setRoReason] = useState("");
  // ── 開桌彈窗（空閒枱 click → 揀入座人數）──
  const [openTableModalTableId, setOpenTableModalTableId] = useState<string | null>(null);
  const [openTablePartySize, setOpenTablePartySize] = useState<number>(1);
  const [seatedPartySizes, setSeatedPartySizes] = useState<Record<string, number>>(() => {
    const all = loadOrders();
    return Object.fromEntries(all.filter((o) => o.partySize != null).map((o) => [o.tableId, o.partySize as number]));
  });
  const [roModalOpen, setRoModalOpen] = useState(false);
  const [roSubmitting, setRoSubmitting] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [discountValue, setDiscountValue] = useState("0");
  const [receivedAmount, setReceivedAmount] = useState("");
  const [posMode, setPosMode] = useState<"tables" | "order">(() => (loadOperatingMode() === "quick" ? "order" : "tables"));

  // ── 自動配對桌面 Companion：mount 嗰陣 ran 一次，唔使用家手動填 URL（見 auto-pair-companion.ts）──
  useEffect(() => {
    tryAutoPairCompanion();
  }, []);

  // ── M7：Ledger 餐牌 realtime ── 單筆 patch/upsert bootstrap cache，唔全 re-fetch。
  const ledgerMerchantId = getLedgerMerchantId();
  useLedgerProductsRealtime(ledgerMerchantId, Boolean(ledgerMerchantId), {
    onChange: ({ record, eventType }) => {
      patchMenuFromRealtimeRecord(record, eventType);
    },
  });

  // 餐牌被 realtime / 匯入改動後，重讀 bootstrap 令收銀介面即時反映（kiosk 側已聽同一事件）。
  useEffect(() => {
    function onBootstrapChanged() {
      const fresh = loadBootstrapCache();
      if (fresh) {
        setBootstrap(applyLedgerMerchantToBootstrap(normalizeBootstrapPayload(fresh), loadAuthSession()));
      }
    }
    window.addEventListener("pos-bootstrap-changed", onBootstrapChanged);
    return () => window.removeEventListener("pos-bootstrap-changed", onBootstrapChanged);
  }, []);

  // ── Deep-link：orders 面板「查看」非 counter 單會跳到 /?tableId=...&orderId=... ──
  // 喺呢度載入單到工作台（已結/未結/已返結一律支援，搵全量 orders 唔靠 openOrders）。
  // quick mode 下 activeTable 鎖死 counter、真枱載唔到，故遇到堂食單要切返 dinein。
  // 用 ref 做 one-shot，避免 router.replace 後重複觸發。
  // 用 window.location.search 讀 query，避開 useSearchParams 喺 server page 嘅 Suspense 要求。
  const deepLinkConsumedRef = useRef(false);
  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tableId = params.get("tableId");
    const orderId = params.get("orderId");
    if (!tableId || !orderId) return;
    const order = orders.find((o) => o.id === orderId) ?? null;
    if (!order) return;
    deepLinkConsumedRef.current = true;
    if (operatingMode === "quick") {
      setOperatingModeState("dinein");
      saveOperatingMode("dinein");
    }
    loadOrderIntoWorkspace(order, order.tableId);
    setPosMode("order");
    // 鎖定枱所屬 floor（普通枱同 temp 返結枱都鎖），方便返枱面時直接見到該枱
    const targetFloor = floors.find((floor) => floor.tables.some((table) => table.id === order.tableId));
    if (targetFloor) setActiveFloorId(targetFloor.id);
    // 用 history.replaceState 清 query，唔用 router.replace —— 否則會觸發 Next 導航令 PosApp 重掛載、
    // posMode 被重置做初始 "tables" 而彈返枱面介面。
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
    // loadOrderIntoWorkspace 只用穩定 setter，無需入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, operatingMode]);

  // 外部（面板 / 本頁「返結帳」）改完 orders 後，刷新本地 state，令 activeOrder 重算（settled→reopened 後變可編輯）
  useEffect(() => {
    const onChanged = () => setOrders(loadOrders());
    window.addEventListener("pos-orders-changed", onChanged);
    return () => window.removeEventListener("pos-orders-changed", onChanged);
  }, []);

  const [baseOrderItems, setBaseOrderItems] = useState<OrderItem[]>([]);
  const [activeFloorId, setActiveFloorId] = useState("");
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [specModalItem, setSpecModalItem] = useState<MenuItem | null>(null);
  const [specEditingKey, setSpecEditingKey] = useState<string | null>(null);
  const [selectedSpecValues, setSelectedSpecValues] = useState<Record<string, string[]>>({});
  const [marketPriceItem, setMarketPriceItem] = useState<MenuItem | null>(null);
  const [marketPriceValue, setMarketPriceValue] = useState("");
  const [marketPriceSpecs, setMarketPriceSpecs] = useState<NonNullable<OrderItem["selectedSpecs"]>>([]);
  const [specThenMarketPrice, setSpecThenMarketPrice] = useState(false);
  const [voidRequest, setVoidRequest] = useState<{ item: OrderItem; mode: "one" | "all"; isFullOrder?: boolean } | null>(null);
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
  const [voidTableRequest, setVoidTableRequest] = useState<string | null>(null);
  const [voidTableReason, setVoidTableReason] = useState("");
  const [refundSummaryExportOpen, setRefundSummaryExportOpen] = useState(false);
  const [refundSummaryMode, setRefundSummaryMode] = useState<"date" | "employee">("date");
  const [refundSummaryDateFrom, setRefundSummaryDateFrom] = useState("");
  const [refundSummaryDateTo, setRefundSummaryDateTo] = useState("");
  const [memberPhone, setMemberPhone] = useState("");
  const [ledgerMember, setLedgerMember] = useState<LedgerCheckoutMember | null>(null);
  const [memberSearchHint, setMemberSearchHint] = useState<string>("");
  const [memberSearching, setMemberSearching] = useState(false);
  const memberSearchTimerRef = useRef<number | null>(null);
  const memberCheckoutIdempotencyRef = useRef<string | null>(null);
  const [memberCheckoutRedeemDone, setMemberCheckoutRedeemDone] = useState(false);
  const [memberCheckoutSubmitting, setMemberCheckoutSubmitting] = useState(false);
  const [useMemberBalance, setUseMemberBalance] = useState(false);
  const [selectedGrantIds, setSelectedGrantIds] = useState<string[]>([]);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("");
  const [orderSuccessFlash, setOrderSuccessFlash] = useState(false);
  const [settlementFlash, setSettlementFlash] = useState(false);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [runtimeRefreshTick, setRuntimeRefreshTick] = useState(0);
  // 追蹤上一次 backfill 載入嘅 queue 簽名（id+status），避免 setQueue 建立新 array reference
  // 觸發自身 effect 依賴造成無限輪詢。saveQueue 仍然每次寫 localStorage，保持磁碟同步。
  const lastLoadedQueueRef = useRef<string>("");
  const [soldOutMap, setSoldOutMap] = useState(() => loadSoldOutState());
  const [shift, setShift] = useState(() => loadShiftState());
  const [authSession] = useState(() => loadAuthSession());
  const [orderNote, setOrderNote] = useState("");
  const [noteModal, setNoteModal] = useState<{ type: "order" | "item"; itemKey?: string } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [quickCompletedMinutes, setQuickCompletedMinutes] = useState(() => loadQuickCompletedMinutes());
  const [quickOrderType, setQuickOrderType] = useState<"dine_in" | "pickup" | "delivery">("dine_in");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [audioReady, setAudioReady] = useState(false);
  const quickOrderProcessingRef = useRef<Set<string>>(new Set());

  const isQuickMode = operatingMode === "quick";
  const canRefundOrder = authSession?.permissions.refundOrder ?? true;
  const canVoidItem = authSession?.permissions.voidItem ?? true;

  function showPermissionDenied(actionLabel: string) {
    setToast({ tone: "info", message: `目前帳號沒有${actionLabel}權限，請使用店長帳號操作。` });
  }

  function resetMemberCheckoutState() {
    setMemberPhone("");
    setLedgerMember(null);
    setMemberSearchHint("");
    setSelectedGrantIds([]);
    setUseMemberBalance(false);
    memberCheckoutIdempotencyRef.current = null;
    setMemberCheckoutRedeemDone(false);
    setMemberCheckoutSubmitting(false);
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

  function isSpecOptionSoldOut(optionId: string) {
    const state = soldOutMap[`specopt:${optionId}`];
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
        const merchantId = loadAuthSession()?.merchantId;
        const bootstrapUrl = merchantId
          ? `/api/pos/bootstrap?storeId=${encodeURIComponent(merchantId)}`
          : "/api/pos/bootstrap";
        const response = await fetch(bootstrapUrl);
        const raw = normalizeBootstrapPayload((await response.json()) as PosBootstrap);
        const data = applyLedgerMerchantToBootstrap(raw, loadAuthSession());
        // merge：本地 cache 優先（枱 area / name 等 per-terminal 編輯唔應該被 server 舊數據覆蓋）；
        // server 獨有枱（其他 terminal / kiosk 新加）保留；本地獨有枱亦保留。
        // 咁 server bootstrap 每次啟動載到最新之餘，唔會清走本地嘅枱樓層編輯。
        const localCache = loadBootstrapCache();
        const localTableMap = new Map((localCache?.tables ?? []).map((t) => [t.id, t]));
        const mergedTables: StoreTable[] = data.tables.map((st) => localTableMap.get(st.id) ?? st);
        for (const lt of localCache?.tables ?? []) {
          if (!mergedTables.some((t) => t.id === lt.id)) mergedTables.push(lt);
        }
        const merged: PosBootstrap = { ...data, tables: mergedTables };
        saveBootstrapCache(merged);
        setBootstrap(merged);
        setActiveTableId((current) => current || merged.tables[0]?.id || "");
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
    clearLegacyMembersCache();
  }, []);

  // 收銀 mount / 重連 / queue 清空時一次過 pull 現有 state（event-driven，非 polling）
  useEffect(() => {
    if (offlineMode) return;
    // 方案B：若本機仍有待同步事件，先不要拉取後台狀態，避免後台舊資料覆蓋本機即時狀態。
    if (queue.some((event) => event.status !== "synced")) return;
    void loadRuntimeState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineMode, runtimeRefreshTick, queue]);

  // 一次過 backfill 現有 state（realtime 唔 backfill 舊 row；realtime (re)subscribe 時 call）。
  // 以 localStorage 為底 merge，唔會 overwrite 本機即時狀態。component scope 定義俾 usePosRealtime onResubscribed 共用。
  async function loadRuntimeState() {
    try {
      const merchantId = loadAuthSession()?.merchantId;
      const stateUrl = merchantId
        ? `/api/pos/state?storeId=${encodeURIComponent(merchantId)}`
        : "/api/pos/state";
      const response = await fetch(stateUrl);
      const payload = (await response.json()) as {
        orders?: PosOrder[];
        queue?: QueueEvent[];
        printJobs?: PrintJob[];
        localSettings?: PosLocalSettings;
        deviceConfig?: DeviceConfig | null;
      };

      if (Array.isArray(payload.orders)) {
        // 以 localStorage 為底，再合併 React state 與後台，避免 async 競態把剛結帳的單洗掉。
        // docs/52：合併後過濾本機已真刪（tombstone）+ 伺服器單邊終態單，防 backfill 復活。
        setOrders((current) => {
          const merged = mergeOrderLists(loadOrders(), current, payload.orders!);
          const cleaned = filterResurrectedOrders(merged, loadDeletedOrderIds(), loadOrders());
          saveOrders(cleaned);
          // backfill 補建：收銀端恢復在線時，檢查有冇未出廚房單嘅自助單（docs/87 §11）
          const selfOrdersNeedKitchen = cleaned.filter(
            (o) =>
              isSelfOrder(o) &&
              o.status === "sent_to_kitchen" &&
              !loadPrintJobs().some(
                (job) =>
                  job.orderId === o.id &&
                  job.ticketType === "normal" &&
                  job.printerGroup !== "receipt" &&
                  (job.items?.length ?? 0) > 0,
              ),
          );
          for (const o of selfOrdersNeedKitchen) {
            const storeName = bootstrap?.storeName ?? "門店";
            const jobs = [
              ...buildKitchenPrintJobs(o, { ticketType: "normal", storeName }),
              ...buildLabelPrintJobs(o, { ticketType: "normal", storeName }),
            ];
            if (o.source === "scan" && bootstrap) {
              jobs.push(...buildKioskReceiptPrintJobs(o, bootstrap));
            }
            appendPrintJobs(jobs);
          }
          return cleaned;
        });
      }
      if (Array.isArray(payload.queue)) {
        // 以 localStorage 為底 merge：保留本地（含未同步）事件，只補本機冇嘅 server 事件，
        // 唔整份取代，避免清走本地 pending（R4）。pos_queue_events 無 store_id，server 列表含其他店，
        // 但本地優先 + 去重已避免本地事件被覆寫（跨店 queue 污染另見 follow-up）。
        const localQueue = loadQueue();
        const localById = new Map(localQueue.map((e) => [e.id, e]));
        const mergedQueue: QueueEvent[] = [];
        const seen = new Set<string>();
        for (const e of payload.queue) {
          seen.add(e.id);
          mergedQueue.push(localById.get(e.id) ?? e); // 本機有就用本機（保留 pending 狀態）
        }
        for (const e of localQueue) {
          if (!seen.has(e.id)) mergedQueue.push(e);
        }
        // 只有內容真正改變先 setQueue：避免 effect 依賴 queue 觸發自激迴圈
        // （loadRuntimeState → setQueue(新 array ref) → effect 重跑 → loadRuntimeState → ...）。
        // saveQueue 仍然每次寫 localStorage 保持磁碟同步。
        const signature = mergedQueue
          .map((e) => `${e.id}:${e.status}`)
          .sort()
          .join("|");
        if (signature !== lastLoadedQueueRef.current) {
          lastLoadedQueueRef.current = signature;
          setQueue(mergedQueue);
        }
        saveQueue(mergedQueue);
      }
      if (Array.isArray(payload.printJobs)) {
        // P0-1：以 localStorage 為底 merge（復用 persistPrintJobs 語義），保留本地 sent/failed 狀態、
        // 絕不刪本地單、只補本機冇嘅 server 單。修正整份硬覆寫導致嘅清單 / 重印（R1/R5）。
        persistPrintJobs(payload.printJobs);
      }
      if (payload.localSettings) {
        // 枱（floors）係 per-terminal 編輯真源：枱名 / 區 / 座位數（capacity）都喺本地
        // localSettings.floors（見 docs/54 樓層修復）。後台 device_config.local_settings 冇呢啲
        // per-terminal 枱編輯，直接用 server 版會沖走本地改動（例如座位數變空白）。
        // printTemplates 係 client-only 設計（docs/71 §8）：print-center 從未 POST 去後台，
        // server 嘅 printTemplates 永遠係預設；直接用 server 版會令用家設嘅字型大小每逢同步
        // 就彈返預設。故同步時保留本地 printTemplates，唔畀 server 預設蓋走。
        // onlineOrderSettings（自動接單）係 per-terminal 設定，本機 localStorage 先係真源。
        // 舊 bug：server 份 local_settings 係「全店最新一條（任何 terminal）」（見
        // device-settings.tsx 既有警告註釋 + /api/pos/device-config GET 冇 terminal filter），
        // 且 device-settings syncConfig() 會 POST 成份 localSettings 上去（含 autoAccept）。
        // 結果只要曾經喺「自動接單 ON」時撳過任何儲存，server 就記低 autoAccept:true，
        // 之後每次 loadRuntimeState() 同步都將本地「熄咗」嘅開關還原做 ON → 繼續自動接單。
        // 故同 floors 一樣：本地優先，唔畀 server 蓋走。
        // 其餘 field 用 server 版本（server 優先，確保後台改嘅全局設定生效）。
        const local = loadPosLocalSettings();
        const merged: PosLocalSettings = {
          ...payload.localSettings,
          floors: local.floors?.length ? local.floors : payload.localSettings.floors,
          printTemplates: local.printTemplates,
          onlineOrderSettings: local.onlineOrderSettings,
        };
        savePosLocalSettings(merged);
      }
      if (payload.deviceConfig) {
        saveDeviceConfig(payload.deviceConfig);
      }
    } catch {
      // ignore
    }
  }

  // Kiosk 客人自點：即時訂閱 pos_orders / pos_print_jobs（Realtime，禁 polling）。
  // 設計要求收銀「秒級」見單、出廚房單；此訂閱係即時來源，/api/pos/state 只喺 mount / (re)subscribe 一次過 backfill（event-driven，非週期）。
  const kioskStoreId = useMemo(
    () => (authSession as { merchantId?: string } | null)?.merchantId ?? null,
    [authSession],
  );
  usePosRealtime(kioskStoreId, !offlineMode, {
    onOrderUpsert: (order) => {
      // docs/52：本機已真刪除（tombstone）嘅訂單唔可以經 realtime 復活
      if (loadDeletedOrderIds().includes(order.id)) return;

      // 判斷是否新收到嘅自助單（realtime push 時本機未有）
      const existing = loadOrders().find((o) => o.id === order.id);
      const isNewSelfOrder = !existing && isSelfOrder(order);

      setOrders((current) => {
        const merged = mergeOrderLists(loadOrders(), current, [order]);
        const cleaned = filterResurrectedOrders(merged, loadDeletedOrderIds(), loadOrders());
        saveOrders(cleaned);
        return cleaned;
      });

      // 新收到嘅自助單（已自動確認 = sent_to_kitchen）→ 收銀端建廚房單 + 標籤單（docs/87 §3.1）
      if (isNewSelfOrder && order.status === "sent_to_kitchen") {
        // 用 print job 去重：若已經有該單嘅 kitchen job（normal ticket + 非 receipt + 有 items），就唔再建
        const hasKitchen = loadPrintJobs().some(
          (job) =>
            job.orderId === order.id &&
            job.ticketType === "normal" &&
            job.printerGroup !== "receipt" &&
            (job.items?.length ?? 0) > 0,
        );
        if (!hasKitchen) {
          const storeName = bootstrap?.storeName ?? "門店";
          const jobs = [
            ...buildKitchenPrintJobs(order, { ticketType: "normal", storeName }),
            ...buildLabelPrintJobs(order, { ticketType: "normal", storeName }),
          ];
          // 掃碼單冇本機打印機 → 收銀端補印顧客小票
          if (order.source === "scan" && bootstrap) {
            jobs.push(...buildKioskReceiptPrintJobs(order, bootstrap));
          }
          appendPrintJobs(jobs);
        }
      }

      // 自助單 draft → 彈 toast 提示待確認（規格 6：開關熄咗時）
      if (order.status === "draft" && isSelfOrder(order)) {
        setToast({ tone: "info", message: `自助單 ${order.localOrderNo} 待確認` });
      }

      // 堂食 dine_in_confirm 單落 draft：彈「X 枱已落單請確認」，等員工確認才落廚房
      if (order.status === "draft" && order.tableId && order.tableId !== "counter" && !isSelfOrder(order)) {
        setToast({ tone: "info", message: `${order.tableName} 已落單，請確認` });
      }
    },
    onPrintJobUpsert: (job) => {
      // docs/52：本機已主動清除（tombstone）嘅 job 唔可以經 realtime 復活
      if (loadClearedPrintJobIds().includes(job.id)) return;
      setPrintJobs((current) => {
        // 以 localStorage 為基底合併，唔用 React state current —
        // 因為 bridgeLedgerOrderToPos / printKitchenForLedgerOrder 等
        // 線上訂單打印路徑直接 savePrintJobs 寫 localStorage 但唔更新 React state，
        // 用 current 做 savePrintJobs 會沖走呢啲線上訂單嘅 print jobs。
        const fromStorage = loadPrintJobs();
        const existing = fromStorage.find((p) => p.id === job.id);
        if (existing) {
          // 本地已有 → 保留本地版本（sent/failed），唔用後台 status 覆寫 → 防重印
          savePrintJobs(fromStorage);
          return fromStorage;
        }
        const next = [job, ...fromStorage];
        savePrintJobs(next);
        return next;
      });
    },
    // realtime (re)subscribe 成功 → 一次過 backfill 現有 open 單（event-driven，非 polling）。
    // 補返 realtime 唔 backfill 舊 row 嘅缺口；visibilitychange / CHANNEL_ERROR 重連都會觸發。
    onResubscribed: () => {
      // P0-2（R2）：加返 queue 同步保護，避免重連競態——未 sync 嘅離線新單未入 DB 前就 pull 清走。
      if (offlineMode) return;
      if (queue.some((event) => event.status !== "synced")) return;
      void loadRuntimeState();
    },
  });

  const activeTable = useMemo(() => {
    if (!bootstrap) return null;
    if (isQuickMode) {
      return { id: "counter", name: "快餐", area: "" } as PosBootstrap["tables"][number];
    }
    const fromBootstrap = bootstrap.tables.find((table) => table.id === activeTableId);
    if (fromBootstrap) return fromBootstrap;
    // 返結 temp 枱只喺 localSettings.floors（唔喺 bootstrap.tables），呢度補回解析
    const floors = loadPosLocalSettings().floors ?? [];
    for (const floor of floors) {
      const found = floor.tables.find((table) => table.id === activeTableId);
      if (found) return found;
    }
    return null;
  }, [bootstrap, activeTableId, isQuickMode]);

  const totals = useMemo(
    () => (bootstrap ? orderTotals(cartItems, bootstrap) : { subtotal: 0, serviceChargeAmount: 0, taxAmount: 0, total: 0 }),
    [bootstrap, cartItems],
  );

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const displayStoreName = useMemo(
    () => resolveStoreDisplayTitle(authSession, bootstrap),
    [authSession, bootstrap],
  );
  const displayStoreSubtitle = useMemo(
    () => resolveStoreDisplaySubtitle(authSession, deviceConfig.terminalName),
    [authSession, deviceConfig.terminalName],
  );
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings());
  // 枱檯 view 改讀 bootstrap.tables（共享真源）而非 localSettings.floors，確保 kiosk / 掃碼落單嘅枱一定 render；
  // 本地獨有枱（返結 temp 枱等）經 buildDisplayFloors overlay 保留。
  const floors = useMemo(
    () => buildDisplayFloors(bootstrap?.tables ?? [], localSettings.floors),
    [bootstrap, localSettings],
  );
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

  const effectiveCategoryId = useMemo(() => {
    if (!bootstrap) return "";
    // 搜尋時一律視為「全部」，避免找不到商品
    if (searchKeyword.trim()) return "";
    if (activeCategoryId === ALL_MENU_CATEGORY_ID) return "";
    return activeCategoryId || bootstrap.categories[0]?.id || "";
  }, [activeCategoryId, bootstrap, searchKeyword]);

  const filteredMenuItems = useMemo(() => {
    if (!bootstrap) return [];

    const keyword = searchKeyword.trim();
    const base = bootstrap.menuItems.filter((item) => (effectiveCategoryId ? item.categoryId === effectiveCategoryId : true));
    if (!keyword) return base;

    return base.filter((item) => item.name.includes(keyword));
  }, [bootstrap, effectiveCategoryId, searchKeyword]);
  // activeFloorId 可能係舊嘅本地 floor id（改讀 bootstrap.tables 後 display floor id 變 area:<area>），
  // 若佢已唔存在於 display floors，fallback 去第一個 display floor，避免枱 grid 變空。
  const effectiveFloorId =
    activeFloorId && (activeFloorId === ALL_FLOOR_ID || floors.some((f) => f.id === activeFloorId))
      ? activeFloorId
      : floors[0]?.id ?? "";
  const visibleTables = useMemo(() => {
    if (effectiveFloorId === ALL_FLOOR_ID) return floors.flatMap((floor) => floor.tables);
    return floors.find((floor) => floor.id === effectiveFloorId)?.tables ?? [];
  }, [effectiveFloorId, floors]);

  const pendingQueue = useMemo(() => queue.filter((event) => event.status !== "synced"), [queue]);
  const openOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          order.status === "draft" ||
          order.status === "sent_to_kitchen" ||
          order.status === "paid" ||
          order.status === "reopened",
      ),
    [orders],
  );

  // 30s 批量同步（只在在線 + 有 pending 時進行；成功/失敗不彈 toast，避免打擾收銀）
  useEffect(() => {
    if (offlineMode) return;
    const timer = window.setInterval(() => {
      const next = pendingQueue;
      if (next.length === 0) return;
      void syncNow(next, { silent: true });
    }, 30_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineMode, pendingQueue]);

  // ⚠️ 即時架構（用家要求：禁用 polling）：收銀見 kiosk 單唯一靠 Supabase Realtime 推。
  // 冇任何 setInterval 輪詢。realtime (re)subscribe 成功後靠 onResubscribed 一次過 backfill
  // 現有 open 單（event-driven，非週期性），之後新單全靠 postgres_changes 推入。
  // → 前置條件：pos_orders 必須加落 supabase_realtime publication + anon read RLS（見 0011 / 下方 SQL）。
  const recentCompletedOrders = useMemo(() => {
    if (!isQuickMode) return [];
    const threshold = nowMs - quickCompletedMinutes * 60 * 1000;
    return orders
      .filter((order) => order.tableId === "counter" && order.status === "settled")
      .filter((order) => Date.parse(order.updatedAt || order.createdAt) >= threshold)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
  }, [isQuickMode, orders, quickCompletedMinutes, nowMs]);
  const actionBarLocalOrders = useMemo(
    () => filterQuickActionBarOrders(openOrders).filter((order) => order.tableId === "counter" && !order.onlineOrderId),
    [openOrders],
  );
  // 桌台總覽（dine-in）模式：kiosk / 掃碼落嘅自取、外賣單（table_id=counter）唔喺枱 grid 入面，
  // 必須有專屬面板先會見到，否則收銀喺預設 dine-in 模式永遠睇唔到呢啲單（之前只喺 quick mode bar 出）。
  const counterKioskOrders = useMemo(
    () => openOrders.filter((order) => order.tableId === "counter" && !order.onlineOrderId),
    [openOrders],
  );
  const quickPreparingOrders = useMemo(
    () =>
      actionBarLocalOrders.filter(
        (order) =>
          order.status === "draft" ||
          order.status === "sent_to_kitchen" ||
          (order.status === "paid" && order.fulfillmentStatus !== "ready"),
      ),
    [actionBarLocalOrders],
  );
  const quickWaitingOrders = useMemo(
    () => actionBarLocalOrders.filter((order) => order.status === "paid" && order.fulfillmentStatus === "ready"),
    [actionBarLocalOrders],
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
    // 快餐模式：activeTableId 喺 boot 時會落到第一張真枱（bootstrap.tables[0]），
    // 唔可以靠佢去 resolve activeOrder，否則會鬼鬼祟祟將張枱嘅堂食單載入 workspace
    //（「跳去桌面模式」）。快餐模式嘅單靠 activeOrderId 追蹤（落單時 setActiveOrderId）。
    return (!isQuickMode && activeTableId ? tableOrderMap.get(activeTableId) : null) ?? null;
  }, [activeOrderId, activeTableId, orders, tableOrderMap, isQuickMode]);
  // 唯讀鎖定：已結帳單經 deep-link 載入工作台（activeOrder 因 status=settled 被排除，但 activeOrderId/cartItems 已設）
  const workspaceOrder = useMemo(
    () => (activeOrderId ? orders.find((order) => order.id === activeOrderId) ?? null : null),
    [activeOrderId, orders],
  );
  const isReadOnlySettled = workspaceOrder?.status === "settled";
  // 全單備註鎖定（docs/84）：一送出（sent_to_kitchen）即固定。
  // draft（未送出）同 reopened（返結帳）先改得；結完帳 setActiveOrderId(null) → 自動解鎖，唔影響下一張單。
  const orderNoteLocked = isOrderNoteLocked(workspaceOrder);
  const unsettledOrder = useMemo(
    () => orders.find((order) => order.status === "sent_to_kitchen") ?? null,
    [orders],
  );
  const currentSettlementOrder =
    (payingOrderId && payingOrderId !== CART_PAYING_ID ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
    (!isQuickMode && (activeOrder?.status === "sent_to_kitchen" || activeOrder?.status === "reopened") ? activeOrder : null) ??
    (!isQuickMode ? unsettledOrder : null);
  const discountAmount = useMemo(() => {
    const value = Number(discountValue);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [discountValue]);
  // docs/87：結帳金額必須跟住用戶撳「結帳」嗰張單（currentSettlementOrder），
  // 唔可以跟 activeOrder（當前選中枱嘅單）——否則喺 dine-in 模式從 counterKioskOrders 面板結帳會金額變 0。
  const paymentBase = currentSettlementOrder
    ? {
        subtotal: currentSettlementOrder.subtotal,
        serviceChargeAmount: 0,
        taxAmount: currentSettlementOrder.taxAmount,
        total: currentSettlementOrder.subtotal + currentSettlementOrder.taxAmount,
      }
    : !isQuickMode && activeOrder && cartItems.length === 0
      ? {
          subtotal: activeOrder.subtotal,
          serviceChargeAmount: 0,
          taxAmount: activeOrder.taxAmount,
          total: activeOrder.subtotal + activeOrder.taxAmount,
        }
      : totals;
  const prepaidAmount = (currentSettlementOrder?.prepaidAmount ?? activeOrder?.prepaidAmount ?? 0) || 0;
  const payableBeforeMember = Math.max(0, paymentBase.total - discountAmount - prepaidAmount);
  const selectedMoneyVoucherAvos = useMemo(
    () => (ledgerMember ? sumMoneyVoucherAvos(ledgerMember.redeemableGrants, selectedGrantIds) : 0),
    [ledgerMember, selectedGrantIds],
  );
  const memberAvailableAvos = useMemo(() => {
    if (!ledgerMember) return 0;
    return ledgerMember.balanceAvos + selectedMoneyVoucherAvos;
  }, [ledgerMember, selectedMoneyVoucherAvos]);
  const memberDeduction = useMemo(() => {
    if (!useMemberBalance || !ledgerMember) return 0;
    return Math.min(avosToMop(memberAvailableAvos), payableBeforeMember);
  }, [ledgerMember, memberAvailableAvos, payableBeforeMember, useMemberBalance]);
  const memberLedgerOpsNeeded = Boolean(
    ledgerMember && (selectedGrantIds.length > 0 || (useMemberBalance && memberDeduction > 0)),
  );

  function scheduleMemberLookup(phone: string) {
    if (memberSearchTimerRef.current) {
      window.clearTimeout(memberSearchTimerRef.current);
      memberSearchTimerRef.current = null;
    }
    memberSearchTimerRef.current = window.setTimeout(() => {
      void (async () => {
        if (offlineMode) {
          setLedgerMember(null);
          setMemberSearchHint("會員查詢須連線，請恢復網絡後再試。");
          return;
        }
        const merchantId = getLedgerMerchantId();
        if (!merchantId) {
          setLedgerMember(null);
          setMemberSearchHint("無法取得商家 ID，請重新登入。");
          return;
        }
        setMemberSearching(true);
        try {
          const wallet = await lookupCustomerWallet(merchantId, phone);
          if (!wallet.registered || !wallet.customerId) {
            setLedgerMember(null);
            setMemberSearchHint("此電話尚未註冊會員通。");
            return;
          }
          const redeemableGrants = await listRedeemableGrantsForCustomer(merchantId, wallet.customerId);
          setLedgerMember({ ...wallet, redeemableGrants });
          setMemberSearchHint("");
          setSelectedGrantIds([]);
          memberCheckoutIdempotencyRef.current = null;
          setMemberCheckoutRedeemDone(false);
        } catch (error) {
          setLedgerMember(null);
          setMemberSearchHint(
            friendlyLedgerMemberError(error instanceof Error ? error.message : String(error)),
          );
        } finally {
          setMemberSearching(false);
        }
      })();
    }, 300);
  }

  function handleMemberPhoneChange(input: string) {
    const normalized = input.replace(/\D/g, "").slice(0, 8);
    setMemberPhone(normalized);
    setMemberSearchHint("");
    memberCheckoutIdempotencyRef.current = null;
    setMemberCheckoutRedeemDone(false);

    if (memberSearchTimerRef.current) {
      window.clearTimeout(memberSearchTimerRef.current);
      memberSearchTimerRef.current = null;
    }

    if (normalized.length !== 8) {
      setMemberSearching(false);
      setLedgerMember(null);
      setSelectedGrantIds([]);
      setUseMemberBalance(false);
      return;
    }

    scheduleMemberLookup(normalized);
  }

  useEffect(() => {
    if (!payingOrderId && memberSearchTimerRef.current) {
      window.clearTimeout(memberSearchTimerRef.current);
      memberSearchTimerRef.current = null;
    }
  }, [payingOrderId]);
  const paymentSummary = {
    subtotal: paymentBase.subtotal,
    serviceChargeAmount: 0,
    taxAmount: paymentBase.taxAmount,
    discountAmount,
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
    // 以 localStorage 為真源合併，保留已派發（sent / failed）狀態。
    // 否則 stale React state（flush worker 改咗 localStorage 但冇 update state）會將已打印嘅
    // job 復活成 pending，下一次 flush 又印一次 → 無限重複打印同一張單（見 2026-08-25 修復）。
    // 合併邏輯抽出做純函式 mergePrintJobs（src/lib/pos/print-job-merge.ts），backfill 同處重用。
    const merged = mergePrintJobs(loadPrintJobs(), nextPrintJobs, loadClearedPrintJobIds());
    setPrintJobs(merged);
    savePrintJobs(merged);
    // Dispatch event 令 Print Center UI 即時刷新（唔靠下次 route 切換先 reload）
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
    }
  }

  function loadOrderIntoWorkspace(order: PosOrder | null, tableId: string) {
    setActiveTableId(tableId);
    setActiveOrderId(order?.id ?? null);
    setPayingOrderId(null);
    setCartItems(order?.items ?? []);
    setSelectedItemId("");
    setDiscountValue(String(order?.discountAmount ?? 0));
    setReceivedAmount("");
    setVoidedItems(order?.voidedItems ?? []);
    setBaseOrderItems(order?.status === "sent_to_kitchen" ? order.items : []);
    setOrderNote(order?.orderNote ?? "");
    resetMemberCheckoutState();
    setSelectedPaymentMethod("");
  }

  function selectTable(tableId: string) {
    const existing = tableOrderMap.get(tableId);
    if (!existing) {
      // 空閒枱 → 彈開桌窗揀入座人數，唔直接入點餐
      setOpenTablePartySize(1);
      setOpenTableModalTableId(tableId);
      return;
    }
    loadOrderIntoWorkspace(existing, tableId);
    setPosMode("order");
  }

  function confirmOpenTable() {
    const tableId = openTableModalTableId;
    if (!tableId) return;
    const size = openTablePartySize > 0 ? openTablePartySize : 1;
    setSeatedPartySizes((current) => ({ ...current, [tableId]: size }));
    setOpenTableModalTableId(null);
    loadOrderIntoWorkspace(null, tableId);
    setPosMode("order");
  }

  function resolveExistingOrderForUpsert(options?: { forceNewOrder?: boolean }) {
    if (!activeTable) return null;
    if (options?.forceNewOrder && isQuickMode && activeTable.id === "counter") {
      return null;
    }
    if (activeOrderId) {
      const byId = orders.find(
        (order) =>
          order.id === activeOrderId &&
          order.status !== "settled" &&
          order.status !== "cancelled" &&
          order.status !== "partially_refunded" &&
          order.status !== "refunded",
      );
      if (byId) return byId;
    }
    // 快餐 counter 可並存多張已收款單；僅合併未送廚的 draft / sent_to_kitchen
    if (isQuickMode && activeTable.id === "counter") {
      return (
        orders.find(
          (order) =>
            order.tableId === "counter" &&
            !order.onlineOrderId &&
            (order.status === "draft" || order.status === "sent_to_kitchen"),
        ) ?? null
      );
    }
    const mapped = tableOrderMap.get(activeTable.id) ?? null;
    if (mapped?.status === "paid") return null;
    return mapped;
  }

  function upsertCurrentOrder(
    nextStatus: "draft" | "sent_to_kitchen",
    allowEmpty = false,
    newLocalOrderNo?: string,
    options?: { forceNewOrder?: boolean },
  ) {
    if (!bootstrap || !activeTable) return null;
    if (!allowEmpty && cartItems.length === 0) return null;

    const timestamp = new Date().toISOString();
    const baseTotals = orderTotals(cartItems, bootstrap);
    const existingOrder = resolveExistingOrderForUpsert(options);

    const sequenceKind = isQuickMode ? quickTypeKind() : "pos";
    const sequencePrefix = isQuickMode ? quickTypeTableName() : "訂單";
    // B1（docs/56）：fallback 唔再用隨機時戳末兩位（會出「訂單84」呢類非順序號），
    // 改用本地按 日期+kind 遞增嘅每日序號，保證 fallback 都單調易讀、同 server 序號對齊。
    const fallbackNo = nextLocalDailyOrderNo(sequenceKind, sequencePrefix);

    const order: PosOrder = existingOrder
      ? {
          ...existingOrder,
          tableId: activeTable.id,
          tableName: isQuickMode ? quickTypeTableName() : activeTable.name,
          partySize: existingOrder.partySize ?? seatedPartySizes[activeTable.id],
          status: nextStatus,
          sentToKitchenAt:
            nextStatus === "sent_to_kitchen"
              ? existingOrder.sentToKitchenAt ?? timestamp
              : existingOrder.sentToKitchenAt,
          fulfillmentStatus:
            isQuickMode && activeTable.id === "counter"
              ? nextStatus === "sent_to_kitchen"
                ? "preparing"
                : existingOrder.fulfillmentStatus
              : undefined,
          items: cartItems,
          orderNote,
          subtotal: baseTotals.subtotal,
          serviceChargeAmount: baseTotals.serviceChargeAmount,
          taxAmount: baseTotals.taxAmount,
          discountAmount,
          total: Math.max(0, baseTotals.total - discountAmount),
          voidedItems,
          updatedAt: timestamp,
        }
      : {
          id: uid("order"),
          localOrderNo: newLocalOrderNo ?? fallbackNo,
          tableId: activeTable.id,
          tableName: isQuickMode ? quickTypeTableName() : activeTable.name,
          partySize: seatedPartySizes[activeTable.id],
          status: nextStatus,
          sentToKitchenAt: nextStatus === "sent_to_kitchen" ? timestamp : undefined,
          fulfillmentStatus: isQuickMode && activeTable.id === "counter" ? "preparing" : undefined,
          items: cartItems,
          orderNote,
          subtotal: baseTotals.subtotal,
          serviceChargeAmount: baseTotals.serviceChargeAmount,
          taxAmount: baseTotals.taxAmount,
          discountAmount,
          total: Math.max(0, baseTotals.total - discountAmount),
          voidedItems: [],
          source: "pos",
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    const baseline = mergeOrderLists(loadOrders(), orders);
    const nextOrders = existingOrder
      ? baseline.map((current) => (current.id === order.id ? order : current))
      : [order, ...baseline.filter((current) => current.id !== order.id)];

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
    setVoidedItems([]);
    setOrderNote("");
    resetMemberCheckoutState();
    setSelectedPaymentMethod("");
    setRuntimeRefreshTick((current) => current + 1);
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
    return `${item.menuItemId}|${serializeSpecs(item)}|${item.price}|${item.note ?? ""}`;
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

  function commitMenuItem(
    item: MenuItem,
    selectedSpecs: OrderItem["selectedSpecs"] = [],
    overridePrice?: number,
  ) {
    const isMarket = typeof overridePrice === "number";
    const finalPrice = isMarket ? overridePrice : priceWithSpecs(item, selectedSpecs);
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

      // 時價菜：每次落單都係獨立一行，唔可以同其他價錢合併
      if (isMarket) {
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
      }

      const existing = current.find(
        (cartItem) => cartItem.menuItemId === item.id && serializeSpecs(cartItem) === serializeSpecs({
          menuItemId: item.id,
          name: item.name,
          quantity: 1,
          price: finalPrice,
          printerGroup: targetPrinterGroup,
          selectedSpecs,
        }) && (orderedItemQtyMap.get(itemIdentity(cartItem)) ?? 0) <= 0,
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
      // 資料層防線：已下單嘅菜唔准改規格。規格同 note 一樣係 itemIdentity 一部分，
      // 改咗會令「已下單」標記失效、退菜彈「尚未正式下單」，而且廚房單唔會補印。
      if ((orderedItemQtyMap.get(specEditingKey) ?? 0) > 0) {
        setToast({ tone: "info", message: ITEM_SPEC_LOCKED_MESSAGE });
      } else {
        setCartItems((current) =>
          current.map((row) =>
            itemIdentity(row) === specEditingKey ? { ...row, selectedSpecs, price: nextPrice } : row,
          ),
        );
      }
    } else if (specThenMarketPrice) {
      setMarketPriceSpecs(selectedSpecs ?? []);
      setMarketPriceValue("");
      setMarketPriceItem(specModalItem);
    } else {
      commitMenuItem(specModalItem, selectedSpecs);
    }

    setSpecModalOpen(false);
    setSpecModalItem(null);
    setSpecEditingKey(null);
    setSelectedSpecValues({});
    setSpecThenMarketPrice(false);
  }

  function openItemNoteEditor(item: OrderItem) {
    if (isReadOnlySettled) return;
    // 已下單（送咗廚房）嘅菜：備註喺送出嗰刻已固定，唔可以再改。
    if ((orderedItemQtyMap.get(itemIdentity(item)) ?? 0) > 0) {
      setToast({ tone: "info", message: ORDER_NOTE_LOCKED_MESSAGE });
      return;
    }
    setNoteDraft(item.note ?? "");
    setNoteModal({ type: "item", itemKey: itemIdentity(item) });
  }

  /**
   * 資料層防線：就算 UI 入口被繞過（日後新增入口 / 深層呼叫），已下單嘅菜都唔准改備註。
   * 否則改咗會寫入 order.items 同步去後台同收據，但廚房單唔會補印 → 廚房同帳目對唔上；
   * 而且 note 係 itemIdentity 一部分，改咗會令「已下單」標記消失、退菜失敗。
   * @returns 係咪成功寫入（false = 被鎖定擋咗）
   */
  function applyItemNote(itemKey: string, note: string): boolean {
    if ((orderedItemQtyMap.get(itemKey) ?? 0) > 0) {
      setToast({ tone: "info", message: ORDER_NOTE_LOCKED_MESSAGE });
      return false;
    }
    setCartItems((current) =>
      current.map((item) => (itemIdentity(item) === itemKey ? { ...item, note: note.trim() } : item)),
    );
    return true;
  }

  function addMenuItem(item: MenuItem) {
    if (isReadOnlySettled) return;
    if (isItemSoldOut(item.id)) {
      setToast({ tone: "info", message: `${item.name} 已售罄。` });
      return;
    }
    if (item.isMarketPrice) {
      if (item.specGroups?.length) {
        setSpecThenMarketPrice(true);
        openSpecPicker(item);
        return;
      }
      setMarketPriceSpecs([]);
      setMarketPriceValue("");
      setMarketPriceItem(item);
      return;
    }
    setSpecThenMarketPrice(false);
    if (item.specGroups?.length) {
      openSpecPicker(item);
      return;
    }

    commitMenuItem(item);
  }

  function confirmMarketPrice() {
    if (!marketPriceItem) return;
    const parsed = Number(marketPriceValue);
    if (!marketPriceValue || Number.isNaN(parsed) || parsed <= 0) {
      setToast({ tone: "info", message: "請輸入有效的時價金額。" });
      return;
    }
    commitMenuItem(marketPriceItem, marketPriceSpecs, parsed);
    setMarketPriceItem(null);
    setMarketPriceValue("");
    setMarketPriceSpecs([]);
  }

  function updateQuantity(itemKey: string, delta: number) {
    if (isReadOnlySettled) return;
    setCartItems((current) => {
      const target = current.find((row) => itemIdentity(row) === itemKey);
      if (!target) return current;
      if ((orderedItemQtyMap.get(itemKey) ?? 0) > 0) return current;

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
    // 只減「未退菜」嘅線；退菜記錄會另存一份，唔會喺購物車入面消失
    const reduceQty = (list: OrderItem[]) =>
      list
        .map((row) => {
          if (row.voided || itemIdentity(row) !== key) return row;
          const nextQty = row.quantity - voidQty;
          return nextQty > 0 ? { ...row, quantity: nextQty } : null;
        })
        .filter((row): row is OrderItem => Boolean(row));

    const nextCartItems = reduceQty(cartItems);
    const nextBaseItems = reduceQty(baseOrderItems);
    const session = loadAuthSession();
    const operator = session?.name ?? session?.account ?? "收銀";
    const voidedAt = new Date().toISOString();
    const voidedLine: OrderItem = {
      ...target,
      quantity: voidQty,
      voided: true,
      voidedAt,
      voidedReason: reason || "未填寫原因",
      voidedBy: operator,
    };
    const nextVoided = [...voidedItems, voidedLine];

    const nextTotals = orderTotals(nextCartItems, bootstrap);
    const updatedOrder: PosOrder = {
      ...activeOrder,
      items: nextCartItems,
      voidedItems: nextVoided,
      subtotal: nextTotals.subtotal,
      serviceChargeAmount: nextTotals.serviceChargeAmount,
      taxAmount: nextTotals.taxAmount,
      total: Math.max(0, nextTotals.total - activeOrder.discountAmount),
      updatedAt: voidedAt,
    };

    persistOrders(orders.map((order) => (order.id === activeOrder.id ? updatedOrder : order)));
    setCartItems(nextCartItems);
    setBaseOrderItems(nextBaseItems);
    setVoidedItems(nextVoided);

    // B2/B3（docs/56）：建印 job 前由 localStorage re-fetch 最新 order，取本地真值 localOrderNo，
    // 唔好直接讀 in-memory activeOrder（state 同 localStorage 唔同步會印錯號，見 8/84 bug）。
    const authoritativeOrder = loadOrders().find((row) => row.id === activeOrder.id) ?? activeOrder;

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

    const voidPrintJobs = buildVoidPrintJobsForOrder(authoritativeOrder, reason, {
      itemsOverride: [{ ...target, quantity: voidQty }],
    });

    persistPrintJobs([...voidPrintJobs, ...printJobs]);
    // A3（docs/56）：有啟用打印機但退菜 0 張 job 入隊 → 廚房退菜單唔會打印，提示用家。
    const voidPrinted = voidPrintJobs.length > 0;
    const voidConfiguredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const voidHasZonePrinter = voidConfiguredPrinters.some((p) => p.role === "zone" || p.role === "label");
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
      tone: voidPrinted ? "success" : "warning",
      message: voidPrinted
        ? mode === "one"
          ? `已退 1 份 ${target.name}`
          : `已退掉 ${target.name}`
        : `${mode === "one" ? `已退 1 份 ${target.name}` : `已退掉 ${target.name}`}，但廚房退菜單未打印（${voidHasZonePrinter ? "菜品分區對唔中打印機" : "未配置分區打印機"}）`,
    });
  }

  function updateQuickFulfillment(orderId: string) {
    const target = orders.find((order) => order.id === orderId) ?? null;
    if (!target) return;
    // docs/87 §6.3：放寬閘門，容許 sent_to_kitchen（自助單先出餐後付款）標記 ready
    const allowed = new Set<PosOrder["status"]>(["paid", "sent_to_kitchen"]);
    if (target.tableId !== "counter" || !allowed.has(target.status)) return;
    const updatedAt = new Date().toISOString();
    const updatedOrder: PosOrder = {
      ...target,
      fulfillmentStatus: "ready",
      servedAt: target.servedAt ?? updatedAt,
      updatedAt,
    };
    persistOrders(orders.map((order) => (order.id === updatedOrder.id ? updatedOrder : order)));
    pushEvents([
      {
        id: uid("evt"),
        type: "ORDER_UPDATED",
        entityId: updatedOrder.id,
        payload: {
          order: updatedOrder,
          action: "ready_pickup",
        },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      },
    ]);
    setToast({
      tone: "success",
      message: `${updatedOrder.localOrderNo} 已標記可取餐。`,
    });
  }

  function voidEntireOrder(reason: string) {
    if (!canVoidItem) {
      showPermissionDenied("退菜");
      return;
    }
    if (!bootstrap || !activeOrder || activeOrder.status !== "sent_to_kitchen") return;
    const uniqueOrderedItems = cartItems.filter((item) => (orderedItemQtyMap.get(itemIdentity(item)) ?? 0) > 0);
    if (uniqueOrderedItems.length === 0) {
      setToast({ tone: "info", message: "目前沒有已下單菜品可退。" });
      return;
    }
    const nextCartItems = cartItems.filter((item) => (orderedItemQtyMap.get(itemIdentity(item)) ?? 0) <= 0);
    const nextBaseItems = baseOrderItems.filter(() => false);
    const updatedAt = new Date().toISOString();
    const fullVoidBehavior = localSettings.fullVoidBehavior;
    const isRefundedRule = fullVoidBehavior === "refunded";
    const updatedOrder: PosOrder = {
      ...activeOrder,
      status: isRefundedRule ? "refunded" : "cancelled",
      items: nextCartItems,
      subtotal: 0,
      serviceChargeAmount: 0,
      taxAmount: 0,
      total: 0,
      cancelledAt: isRefundedRule ? undefined : updatedAt,
      cancelledReason: isRefundedRule ? undefined : reason || "全部退菜",
      refundedAt: isRefundedRule ? updatedAt : undefined,
      refundedAmount: isRefundedRule ? activeOrder.total : activeOrder.refundedAmount,
      refundedReason: isRefundedRule ? reason || "全部退菜" : activeOrder.refundedReason,
      updatedAt,
    };
    persistOrders(orders.map((order) => (order.id === activeOrder.id ? updatedOrder : order)));
    setActiveOrderId(null);
    setCartItems(nextCartItems);
    setBaseOrderItems(nextBaseItems);
    setOrderNote("");
    const voidEvents: QueueEvent[] = [];
    uniqueOrderedItems.forEach((item) => {
      const orderedQty = orderedItemQtyMap.get(itemIdentity(item)) ?? 0;
      if (orderedQty <= 0) return;
      voidEvents.push({
        id: uid("evt"),
        type: "ORDER_ITEM_VOIDED",
        entityId: activeOrder.id,
        payload: {
          orderId: activeOrder.id,
          menuItemId: item.menuItemId,
          itemName: item.name,
          note: item.note ?? null,
          voidQuantity: orderedQty,
          mode: "all",
          reason: reason || "未填寫原因",
        },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      });
    });
    const voidPrintJobs = buildVoidPrintJobsForOrder(activeOrder, reason);
    persistPrintJobs([...voidPrintJobs, ...printJobs]);
    pushEvents([
      {
        id: uid("evt"),
        type: "ORDER_UPDATED",
        entityId: updatedOrder.id,
        payload: {
          order: updatedOrder,
          action: isRefundedRule ? "refunded" : "cancelled",
          reason: reason || "全部退菜",
          amount: isRefundedRule ? activeOrder.total : undefined,
        },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      },
      ...voidEvents,
      ...voidPrintJobs.map<QueueEvent>((printJob) => ({
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: printJob.id,
        payload: printJob,
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      })),
    ]);
    setToast({ tone: "success", message: isRefundedRule ? "已全部退菜，整單已退完。" : "已全部退菜，整單已取消。" });
  }

  // 退桌：堂食枱客人離場，枱上所有菜作廢並釋放枱位。只接 draft / sent_to_kitchen 且非線上訂單。
  function findVoidableTableOrder(tableId: string): PosOrder | null {
    return (
      orders.find(
        (order) =>
          order.tableId === tableId &&
          order.tableId !== "counter" &&
          !order.onlineOrderId &&
          (order.status === "draft" || order.status === "sent_to_kitchen"),
      ) ?? null
    );
  }

  function voidTable(tableId: string, reason: string) {
    if (!canVoidItem) {
      showPermissionDenied("退桌");
      return;
    }
    if (!bootstrap) return;
    const order = findVoidableTableOrder(tableId);
    if (!order) {
      setToast({ tone: "info", message: "呢張枱冇可退桌嘅單。" });
      return;
    }
    const updatedAt = new Date().toISOString();
    const reasonText = reason?.trim() || "退桌";
    const voidEvents: QueueEvent[] = [];
    // 只有已送廚房（sent_to_kitchen）嘅菜需要廚房退菜單 + 推單項作廢事件；未下單（draft）嘅菜安靜放棄
    const sentItems = order.status === "sent_to_kitchen" ? (order.items ?? []) : [];
    sentItems.forEach((item) => {
      const orderedQty = item.quantity;
      if (orderedQty <= 0) return;
      voidEvents.push({
        id: uid("evt"),
        type: "ORDER_ITEM_VOIDED",
        entityId: order.id,
        payload: {
          orderId: order.id,
          menuItemId: item.menuItemId,
          itemName: item.name,
          note: item.note ?? null,
          voidQuantity: orderedQty,
          mode: "all",
          reason: reasonText,
        },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      });
    });
    const voidPrintJobs = buildVoidPrintJobsForOrder(order, reasonText, { itemsOverride: sentItems });
    // 推整單取消事件，server 標為已退/已取消；隨後由本地 orders 移除該單，枱位自動回落空閒
    const cancelEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_UPDATED",
      entityId: order.id,
      payload: {
        order: {
          ...order,
          status: "cancelled",
          items: sentItems,
          subtotal: 0,
          serviceChargeAmount: 0,
          taxAmount: 0,
          total: 0,
          cancelledAt: updatedAt,
          cancelledReason: reasonText,
          updatedAt,
        },
        action: "cancelled",
        reason: reasonText,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedAt,
    };
    persistPrintJobs([...voidPrintJobs, ...printJobs]);
    pushEvents([
      cancelEvent,
      ...voidEvents,
      ...voidPrintJobs.map<QueueEvent>((printJob) => ({
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: printJob.id,
        payload: printJob,
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedAt,
      })),
    ]);
    // 本地移除這張單（退桌：直接刪除記錄），枱位因 cancelled 不再計入 openOrders 而變空閒
    persistOrders(orders.filter((o) => o.id !== order.id));
    backToTables();
    setToast({ tone: "success", message: `${order.tableName ?? tableId} 已退桌，枱位已釋放。` });
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

  async function syncNow(nextQueue: QueueEvent[], options?: { silent?: boolean }) {
    if (offlineMode || nextQueue.length === 0) {
      return;
    }

    try {
      await fetch("/api/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: nextQueue,
          storeId: bootstrap?.storeId ?? loadAuthSession()?.merchantId ?? undefined,
        }),
      });

      const synced = nextQueue.map((event) => ({ ...event, status: "synced" as const }));
      persistQueue(synced);
      if (!options?.silent) {
        setToast({ tone: "success", message: `已同步 ${synced.length} 筆待辦資料。` });
      }
    } catch {
      if (!options?.silent) {
        setToast({ tone: "info", message: "同步暫時失敗，資料已保留在本機。" });
      }
    }
  }

  function pushEvents(events: QueueEvent[]) {
    const nextQueue = [...queue, ...events];
    persistQueue(nextQueue);
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
    const storeName = bootstrap.storeName;
    const nextPrintJobs = [
      ...buildKitchenPrintJobs(order, { ticketType: "normal", storeName, orderNoSuffix: " (重打)" }),
      ...buildLabelPrintJobs(order, { ticketType: "normal", storeName, orderNoSuffix: " (重打)" }),
    ];

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

  async function sendToKitchen(options?: { silent?: boolean; forceNewOrder?: boolean }) {
    if (isReadOnlySettled) return null;
    if (!bootstrap || !activeTable || cartItems.length === 0) return null;
    if (orderSubmitting) return null;
    setOrderSubmitting(true);

    try {
      const timestamp = new Date().toISOString();
      let nextOrderNo: string | undefined;
      let sequenceFetchFailed = false;
      const counterHasOpenOrder =
        !options?.forceNewOrder &&
        (activeOrderId
          ? orders.some(
              (order) =>
                order.id === activeOrderId &&
                order.tableId === activeTable.id &&
                (order.status === "draft" || order.status === "sent_to_kitchen"),
            )
          : orders.some(
              (order) =>
                order.tableId === activeTable.id &&
                (order.status === "draft" || order.status === "sent_to_kitchen"),
            ));
      if (!offlineMode && !counterHasOpenOrder) {
        try {
          const response = await fetch("/api/pos/sequence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: isQuickMode ? quickTypeKind() : "pos", storeId: bootstrap.storeId }),
          });
          const payload = (await response.json()) as { display?: string };
          nextOrderNo = payload.display;
        } catch {
          // 連線失敗 → nextOrderNo 保持 undefined，upsertCurrentOrder 會用本地每日序號 fallback
          sequenceFetchFailed = true;
        }
      }

      const order = upsertCurrentOrder("sent_to_kitchen", false, nextOrderNo, {
        forceNewOrder: options?.forceNewOrder,
      });
      if (!order) return null;

      // B1（docs/56）：連網取得店內序號失敗，落咗本地序號，提示用家連網後會對齊。
      if (sequenceFetchFailed && !nextOrderNo && !options?.silent) {
        setToast({
          tone: "warning",
          message: "單號使用本地序號（連線取得店內序號失敗），連網後會自動對齊。",
        });
      }

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

      const treatAsAddOn = !options?.forceNewOrder && isAddOnOrder;
      if (treatAsAddOn && addedItems.length === 0) {
        if (!options?.silent) {
          setToast({ tone: "info", message: "沒有新增菜品，無需加單。" });
        }
        return null;
      }

      const printTargetItems = treatAsAddOn ? addedItems : cartItems;

    const configuredPrinters = (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter((printer) => printer.enabled);
    const ticketType: "normal" | "addon" = treatAsAddOn ? "addon" : "normal";
    const nextPrintJobs = [
      ...buildKitchenPrintJobs(order, {
        ticketType,
        storeName: bootstrap.storeName,
        itemsOverride: printTargetItems,
      }),
      ...buildLabelPrintJobs(order, {
        ticketType,
        storeName: bootstrap.storeName,
        itemsOverride: printTargetItems,
      }),
    ];

    persistPrintJobs([...nextPrintJobs, ...printJobs]);

      // A3（docs/56）：有啟用打印機但呢張單 0 張 job 入隊 → 單據唔會打印，彈警告提示。
      // 兩種成因：① 冇任何 zone/label 打印機；② 菜品 printerGroup 對唔中任何 printer.zoneId。
      if (nextPrintJobs.length === 0 && !options?.silent) {
        const hasZonePrinter = configuredPrinters.some((p) => p.role === "zone" || p.role === "label");
        setToast({
          tone: "warning",
          message: hasZonePrinter
            ? "菜品分區對唔中打印機，廚房單不會打印，請檢查設備設置嘅打印機分區。"
            : "未配置廚房（分區/標籤）打印機，落單唔會打印，請到設備設置添加。",
        });
      }

    const orderEvent: QueueEvent = {
      id: uid("evt"),
      type: treatAsAddOn ? "ORDER_UPDATED" : "ORDER_CREATED",
      entityId: order.id,
      payload: treatAsAddOn ? { order, addedItems } : order,
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
            ? treatAsAddOn
              ? `已加單成功，單號 ${order.localOrderNo}。`
              : `已下單成功，單號 ${order.localOrderNo}。`
            : treatAsAddOn
              ? `已離線加單 ${order.localOrderNo}，待恢復網絡後補傳。`
              : `已離線下單 ${order.localOrderNo}，待恢復網絡後補傳。`,
        });
      }
      return order;
    } finally {
      setOrderSubmitting(false);
    }
  }

  function markOrderCompleted(orderId: string, options?: { label?: string }) {
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder) return;

    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: "settled",
      fulfillmentStatus: targetOrder.tableId === "counter" ? "ready" : targetOrder.fulfillmentStatus,
      servedAt: targetOrder.servedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
    persistOrders(nextOrders);
    pushEvents([
      {
        id: uid("evt"),
        type: "ORDER_UPDATED",
        entityId: updatedOrder.id,
        payload: { order: updatedOrder, action: "completed", label: options?.label ?? "已完成" },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedOrder.updatedAt,
      },
    ]);
    setViewingOrderId(null);
    setToast({ tone: "success", message: `${updatedOrder.localOrderNo} ${options?.label ?? "已完成"}。` });
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
    removeReopenTempTable(orderId);
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

  /**
   * 真刪除訂單（docs/52）：本機移除 + 記 deletedOrderIds tombstone（防 backfill / realtime 復活）
   * + 推 ORDER_DELETED 事件入 queue，syncNow 成功 POST 去 /api/pos/sync 真刪伺服器 `pos_orders` 行。
   * 離線：事件 status=pending，重連後 syncNow 補傳；tombstone 已經擋住本地復活。
   */
  function deleteOrderPermanently(orderId: string) {
    const targetOrder = orders.find((order) => order.id === orderId);
    if (!targetOrder) return;
    const deleteEvent: QueueEvent = {
      id: uid("evt"),
      type: "ORDER_DELETED",
      entityId: orderId,
      payload: { orderId },
      status: networkOnline ? "synced" : "pending",
      createdAt: new Date().toISOString(),
    };
    addDeletedOrderIds([orderId]);
    persistOrders(orders.filter((o) => o.id !== orderId));
    pushEvents([deleteEvent]);
    // 在線即 push 去伺服器真刪；離線則留 pending，重連後 syncNow 補傳（tombstone 已擋本地復活）
    if (!offlineMode) {
      void syncNow([...queue, deleteEvent], { silent: true });
    }
    if (activeOrderId === orderId) {
      setActiveOrderId(null);
      setCartItems([]);
      setBaseOrderItems([]);
      setOrderNote("");
      setDiscountValue("0");
      setReceivedAmount("");
    }
    setViewingOrderId(null);
    setToast({ tone: "success", message: `${targetOrder.localOrderNo} 已刪除。` });
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
        printerId: printer.id,
        printerName: printer.name,
        items: [
          { name: title, quantity: 1, note: order.localOrderNo },
          { name: "退款金額", quantity: 1, note: formatMoney(amount, bootstrap.currency) },
          { name: "退款原因", quantity: 1, note: reason },
        ],
        status: resolvePrintJobStatus(networkOnline),
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
    // B2/B3（docs/56）：建退款印 job 前由 localStorage re-fetch 最新 order 取本地真值 localOrderNo，
    // 唔好直接用 in-memory targetOrder（見 8/84 bug）。
    const authoritativeOrder = loadOrders().find((row) => row.id === orderId) ?? updatedOrder;
    removeReopenTempTable(orderId);
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
      authoritativeOrder,
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
    removeReopenTempTable(orderId);
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
    // B2/B3（docs/56）：partial refund 同樣 re-fetch 本地真值 localOrderNo。
    const partialAuthoritativeOrder = loadOrders().find((row) => row.id === orderId) ?? updatedOrder;
    const refundPrintJobs = buildRefundReceiptJobs(
      partialAuthoritativeOrder,
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
    const nextPrintJobs = buildReceiptPrintJobs(order, bootstrap);
    if (nextPrintJobs.length === 0) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[printReceipt] No receipt printer configured — skipping receipt print");
      }
      return;
    }

    const timestamp = nextPrintJobs[0]?.createdAt ?? new Date().toISOString();
    persistPrintJobs([...nextPrintJobs, ...printJobs]);
    // Dispatch event 令 Print Center UI 即時刷新（persistPrintJobs 本身唔 dispatch）
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
    }
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

  async function confirmPayment(method: string) {
    if (!bootstrap || memberCheckoutSubmitting) return;

    if (memberLedgerOpsNeeded && offlineMode) {
      setToast({ tone: "info", message: "會員扣款／核銷券須連線，請恢復網絡後再試。" });
      return;
    }

    const merchantId = getLedgerMerchantId();
    if (memberLedgerOpsNeeded && !merchantId) {
      setToast({ tone: "info", message: "無法取得商家 ID，請重新登入後再試。" });
      return;
    }

    const deductAvos = useMemberBalance && ledgerMember ? mopToAvos(memberDeduction) : 0;
    if (memberLedgerOpsNeeded && deductAvos > memberAvailableAvos) {
      setToast({ tone: "info", message: "會員餘額不足（含所選現金券）。" });
      return;
    }

    const applyPaymentToOrder = (targetOrder: PosOrder) => {
      const now = new Date().toISOString();
      const settledGrandTotal = Math.max(0, paymentBase.total - discountAmount);
      const quickPaidFlow = isQuickMode && targetOrder.tableId === "counter";
      const hasGrantRedeem = selectedGrantIds.length > 0;
      // 返結 temp 枱重結：還原原枱並清掉 temp 標記
      const isReopenRestore = Boolean(targetOrder.reopenOriginalTableId);
      const updatedOrder: PosOrder = {
        ...targetOrder,
        status: quickPaidFlow ? "paid" : "settled",
        fulfillmentStatus: quickPaidFlow ? targetOrder.fulfillmentStatus ?? "preparing" : undefined,
        // 堂食結帳＝出餐；快餐 counter 出餐喺標記 ready 嗰刻（updateQuickFulfillment / markQuickOrderCompletedInStore）
        servedAt: quickPaidFlow ? targetOrder.servedAt : targetOrder.servedAt ?? now,
        tableId: isReopenRestore ? targetOrder.reopenOriginalTableId! : targetOrder.tableId,
        tableName: isReopenRestore ? targetOrder.reopenOriginalTableName! : targetOrder.tableName,
        reopenOriginalTableId: undefined,
        reopenOriginalTableName: undefined,
        paymentMethod:
          memberDeduction > 0
            ? paymentSummary.total > 0
              ? `會員餘額 + ${method}`
              : "會員餘額"
            : hasGrantRedeem
              ? `會員券 + ${method}`
              : method,
        discountAmount,
        total: settledGrandTotal,
        // ── 會員扣款快照：供返結反向回滾；無會員扣款則清掉 ──
        ledgerMemberPhone:
          deductAvos > 0 ? (ledgerMember?.customerPhone ?? targetOrder.ledgerMemberPhone ?? undefined) : undefined,
        memberDeductionAvos: deductAvos > 0 ? deductAvos : 0,
        // ── 保留返結審計（重結不重置；originalSettledAt 鎖定首次結帳時間）──
        originalSettledAt: targetOrder.originalSettledAt ?? now,
        reopenCount: targetOrder.reopenCount ?? 0,
        reopenedAt: targetOrder.reopenedAt,
        reopenedBy: targetOrder.reopenedBy,
        reopenReason: targetOrder.reopenReason,
        updatedAt: now,
      };

      setOrders((currentOrders) => {
        const baseline = mergeOrderLists(loadOrders(), currentOrders);
        const nextOrders = baseline.some((order) => order.id === updatedOrder.id)
          ? baseline.map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
          : [updatedOrder, ...baseline];
        saveOrders(nextOrders);
        return nextOrders;
      });

      // 返結 temp 枱重結完成：移除 temp 枱（訂單記錄唔新增，只改返結嗰條）
      if (isReopenRestore) {
        removeReopenTempTable(targetOrder.id);
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
          discountAmount,
          paymentMethod: updatedOrder.paymentMethod,
          memberPhone: ledgerMember?.customerPhone ?? null,
          memberDeduction,
          couponDiscount: 0,
          couponIds: selectedGrantIds,
          prepaidAmount,
          status: updatedOrder.status,
          fulfillmentStatus: updatedOrder.fulfillmentStatus ?? null,
          sentToKitchenAt: updatedOrder.sentToKitchenAt ?? null,
          servedAt: updatedOrder.servedAt ?? null,
          // 入座人數上雲（docs/89 §3）：結帳時補傳 partySize，確保報表「覆蓋人數」有數。
          partySize: updatedOrder.partySize ?? null,
        },
        status: networkOnline ? "synced" : "pending",
        createdAt: updatedOrder.updatedAt,
      };

      pushEvents([paymentEvent]);
      // 即時同步結帳狀態去 backend（唔等 30s 批量 flush）：收銀按結帳 → 客人掃碼 resume
      // 即刻見到「枱已完結」，唔會再因 backend 仲係 sent_to_kitchen 而顯示「已落單」。
      void syncNow([...queue, paymentEvent], { silent: true });
      setPayingOrderId(null);
      setActiveOrderId(null);
      setCartItems([]);
      setDiscountValue("0");
      setReceivedAmount("");
      setSelectedItemId("");
      setBaseOrderItems([]);
      resetMemberCheckoutState();
      setSelectedPaymentMethod("");
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
      printReceipt(updatedOrder);
      if (quickPaidFlow) {
        setViewingOrderId(null);
      } else {
        backToTables();
      }
    };

    const runCheckout = async (targetOrder: PosOrder) => {
      if (memberLedgerOpsNeeded && merchantId && ledgerMember) {
        setMemberCheckoutSubmitting(true);
        try {
          const idempotencyKey =
            memberCheckoutIdempotencyRef.current ?? crypto.randomUUID();
          memberCheckoutIdempotencyRef.current = idempotencyKey;

          const grantIdsToRedeem = memberCheckoutRedeemDone ? [] : selectedGrantIds;
          const result = await executeLedgerMemberCheckout({
            merchantId,
            phone: ledgerMember.customerPhone,
            deductAvos,
            grantIds: grantIdsToRedeem,
            idempotencyKey,
            skipRedeem: memberCheckoutRedeemDone,
          });

          if (grantIdsToRedeem.length > 0) {
            setMemberCheckoutRedeemDone(true);
          }

          if (typeof result.balanceAfterAvos === "number" && ledgerMember) {
            setLedgerMember({
              ...ledgerMember,
              balanceAvos: result.balanceAfterAvos,
              redeemableGrants: ledgerMember.redeemableGrants.filter(
                (grant) => !selectedGrantIds.includes(grant.grantId),
              ),
            });
          }

          applyPaymentToOrder(targetOrder);
        } catch (error) {
          if (error instanceof LedgerMemberCheckoutError && error.redeemCompleted) {
            setMemberCheckoutRedeemDone(true);
            setMemberSearchHint("券已核銷，扣款失敗。請重試扣款（勿重複核銷券）。");
          }
          setToast({
            tone: "info",
            message: friendlyLedgerMemberError(error instanceof Error ? error.message : String(error)),
          });
        } finally {
          setMemberCheckoutSubmitting(false);
        }
        return;
      }

      applyPaymentToOrder(targetOrder);
    };

    if (isQuickMode && payingOrderId === CART_PAYING_ID) {
      const createdOrder = await sendToKitchen({ silent: true, forceNewOrder: true });
      if (!createdOrder) {
        setToast({ tone: "info", message: "下單失敗，請確認購物車有菜品後再試。" });
        return;
      }
      await runCheckout(createdOrder);
      return;
    }

    const targetOrder =
      (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
      (activeOrder && (activeOrder.status === "sent_to_kitchen" || activeOrder.status === "reopened")
        ? activeOrder
        : null) ??
      unsettledOrder;
    if (!targetOrder) return;

    await runCheckout(targetOrder);
  }

  function completeOnlinePaidOrder() {
    if (!bootstrap) return;
    const targetOrder =
      (payingOrderId ? orders.find((order) => order.id === payingOrderId) ?? null : null) ??
      (activeOrder?.status === "sent_to_kitchen" ? activeOrder : null) ??
      unsettledOrder;
    if (!targetOrder) return;

    const settledGrandTotal = Math.max(0, paymentBase.total - discountAmount);
    const quickPaidFlow = isQuickMode && targetOrder.tableId === "counter";
    const updatedOrder: PosOrder = {
      ...targetOrder,
      status: quickPaidFlow ? "paid" : "settled",
      paymentMethod: "線上已支付",
      discountAmount,
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
        discountAmount,
        paymentMethod: updatedOrder.paymentMethod,
        memberPhone: null,
        memberDeduction: 0,
        couponDiscount: 0,
        couponIds: [],
        prepaidAmount,
        status: updatedOrder.status,
        // 入座人數上雲（docs/89 §3）：線上支付結帳都要補傳。
        partySize: updatedOrder.partySize ?? null,
      },
      status: networkOnline ? "synced" : "pending",
      createdAt: updatedOrder.updatedAt,
    };

    pushEvents([paymentEvent]);
    // 即時同步結帳狀態去 backend（唔等 30s 批量 flush），同上。
    void syncNow([...queue, paymentEvent], { silent: true });
    setToast({
      tone: "success",
      message: quickPaidFlow
        ? `客人已支付 ${updatedOrder.localOrderNo}，等待製作完成。`
        : `客人已支付，已完成 ${updatedOrder.localOrderNo}。`,
    });
    setSettlementFlash(true);
    printReceipt(updatedOrder);
    if (quickPaidFlow) {
      setViewingOrderId(null);
    } else {
      backToTables();
    }
  }

  async function openSettlementModal() {
    if (isReadOnlySettled) return;
    if (isQuickMode) {
      if (cartItems.length === 0) {
        setToast({ tone: "info", message: "請先點餐再結帳。" });
        return;
      }
      setPayingOrderId(CART_PAYING_ID);
      resetMemberCheckoutState();
      setSelectedPaymentMethod(paymentMethods[0] ?? "現金");
      return;
    }

    const targetOrder =
      activeOrder?.status === "sent_to_kitchen" || activeOrder?.status === "reopened"
        ? activeOrder
        : orders.find((order) => order.status === "sent_to_kitchen" || order.status === "reopened");
    if (!targetOrder) {
      setToast({ tone: "info", message: "目前沒有待結帳訂單。" });
      return;
    }
    setPayingOrderId(targetOrder.id);
    resetMemberCheckoutState();
    setSelectedPaymentMethod(paymentMethods[0] ?? "現金");
  }

  // 本頁「返結帳」：把已結單退回可編輯（status → reopened）。
  // 成功後 pos-orders-changed listener 會刷新 orders → activeOrder 變 reopened → 工作台變可編輯。
  async function handlePosReopen() {
    if (!activeOrderId) return;
    if (!roReason.trim()) {
      setToast({ tone: "info", message: "請先揀返結原因" });
      return;
    }
    setRoSubmitting(true);
    try {
      const session = loadAuthSession();
      const operator = session?.name ?? session?.account ?? "收銀";
      const result = await reopenPosOrder({ orderId: activeOrderId, reason: roReason, operator });
      if (!result.ok) {
        setToast({ tone: "info", message: result.error ?? "返結失敗" });
        return;
      }
      setRoReason("");
      setRoModalOpen(false);
      // 進入 temp 枱工作枱（原枱唔會被取代；亦可唔改直接結帳）
      const temp = result.tempTable;
      if (temp) {
        setActiveFloorId(temp.floorId);
        setPosMode("order");
        loadOrderIntoWorkspace(result.order ?? null, temp.id);
      }
      setToast({
        tone: "success",
        message: result.memberReversed
          ? "已返結、會員餘額已退回並印單"
          : result.memberReverseError
            ? "已返結並印單；會員餘額退回待 Ledger 對接"
            : "已返結並印返結單",
      });
    } finally {
      setRoSubmitting(false);
    }
  }

  if (isBootstrapping || !bootstrap) {
    return <div className="empty-state">正在載入門店設定…</div>;
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        {posMode === "tables" ? (
          <div className="grid h-[100dvh] flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_330px]">
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
                <button
                  key={ALL_FLOOR_ID}
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    effectiveFloorId === ALL_FLOOR_ID ? "bg-orange-500 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200"
                  }`}
                  onClick={() => setActiveFloorId(ALL_FLOOR_ID)}
                  type="button"
                >
                  全部
                </button>
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
                    const isReopenedTable = status === "reopened";
                    const isOccupied = status !== "idle";
                    const seatedCount = seatedPartySizes[table.id] ?? 0;
                    const total = table.capacity ?? 0;
                    const occupancy = total > 0 ? `${seatedCount}/${total}` : `${seatedCount}/—`;
                    const label =
                      isReopenedTable
                        ? "待重結"
                        : status === "sent_to_kitchen"
                          ? "已下單"
                          : status === "draft"
                            ? "未下單"
                            : "空閒";
                    const labelFull = label;
                    // 開桌（非空閒）枱：整張格子實底高對比配色，方便一眼分開「有單」vs「空閒」
                    // —— 待重結用琥珀、已下單/未下單用橙；空閒維持白底。
                    const cardTone = isReopenedTable
                      ? "border-amber-600 bg-amber-500 text-white"
                      : isOccupied
                        ? "border-orange-600 bg-orange-500 text-white"
                        : "border-slate-200 bg-white text-slate-900";
                    const areaTone = isOccupied ? "text-white/85" : "text-slate-500";
                    const badgeTone = isOccupied ? "bg-white/25 text-white" : "bg-orange-50 text-orange-700";
                    return (
                      <button
                        key={table.id}
                        className={`rounded-2xl border p-4 text-left shadow-sm transition-colors ${cardTone} ${
                          isOccupied ? "" : "hover:border-orange-300"
                        }`}
                        onClick={() => selectTable(table.id)}
                        type="button"
                      >
                        <div className="text-base font-semibold text-inherit">
                          {table.name}
                        </div>
                        <div className={`mt-2 text-xs ${areaTone}`}>
                          {table.area}
                        </div>
                        <div
                          className={`mt-1 text-xs font-semibold ${isOccupied ? "text-white/90" : "text-slate-700"}`}
                        >
                          已坐 {occupancy}
                        </div>
                        <div
                          className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${badgeTone}`}
                        >
                          {labelFull}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </main>

            {openTableModalTableId ? (
              <ResponsiveModal
                title="開桌"
                onClose={() => setOpenTableModalTableId(null)}
                actions={
                  <>
                    <button
                      className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200"
                      onClick={() => setOpenTableModalTableId(null)}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
                      onClick={() => confirmOpenTable()}
                      type="button"
                    >
                      開桌
                    </button>
                  </>
                }
              >
                <div className="space-y-3">
                  <div className="text-sm text-slate-600">
                    桌台：
                    {visibleTables.find((t) => t.id === openTableModalTableId)?.name ?? ""}
                    {visibleTables.find((t) => t.id === openTableModalTableId)?.capacity
                      ? `（${visibleTables.find((t) => t.id === openTableModalTableId)?.capacity} 座位）`
                      : ""}
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-900">入座人數</label>
                    <input
                      type="number"
                      min={1}
                      className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"
                      onChange={(event) => setOpenTablePartySize(Number(event.target.value) || 1)}
                      value={openTablePartySize}
                    />
                  </div>
                </div>
              </ResponsiveModal>
            ) : null}

            <section className="flex h-full flex-col overflow-hidden border-l border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-4">
                <div className="text-base font-semibold text-slate-900">快捷操作</div>
                <div className="mt-1 text-xs text-slate-500">桌台流程、收銀入口與營運操作集中在這裡</div>
              </div>
              <div className="flex-1 overflow-auto px-4 py-4">
                {!isQuickMode && counterKioskOrders.length > 0 ? (
                  <div className="mt-4 rounded-2xl border border-orange-200 bg-orange-50/70 p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold text-orange-700">自取 / 掃碼訂單</div>
                      <div className="text-[11px] text-orange-500">{counterKioskOrders.length} 張待處理</div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {counterKioskOrders.map((order) => (
                        <div key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                              <div className="mt-0.5 truncate text-xs text-slate-500">
                                {order.tableName} · {order.items.reduce((n, it) => n + it.quantity, 0)} 件
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1.5">
                              <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-orange-50 px-3 py-1 text-sm font-semibold text-orange-700">
                                <span className="h-4 w-4 rounded-full bg-orange-500" />
                                {localOrderStatusLabel(order)}
                              </div>
                              <OrderSourceBadge order={order} />
                            </div>
                          </div>
                          <div className="mt-2 flex gap-2">
                            <button
                              className="flex-1 rounded-xl bg-white px-2 py-1.5 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                              onClick={() => setViewingOrderId(order.id)}
                              type="button"
                            >
                              查看
                            </button>
                            {/* 自助單 draft → 顯示確認 / 拒絕（規格 6） */}
                            {order.status === "draft" && isSelfOrder(order) ? (
                              <>
                                <button
                                  className="flex-1 rounded-xl bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                                  onClick={() => {
                                    const result = confirmSelfOrder(order.id);
                                    if (result.ok) {
                                      setToast({ tone: "success", message: `已確認自助單 ${order.localOrderNo}` });
                                    } else {
                                      setToast({ tone: "error", message: result.error ?? "確認失敗" });
                                    }
                                  }}
                                  type="button"
                                >
                                  確認出單
                                </button>
                                <button
                                  className="flex-1 rounded-xl bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                                  onClick={() => {
                                    const result = rejectSelfOrder(order.id);
                                    if (result.ok) {
                                      setToast({ tone: "success", message: `已拒絕自助單 ${order.localOrderNo}` });
                                    } else {
                                      setToast({ tone: "error", message: result.error ?? "拒絕失敗" });
                                    }
                                  }}
                                  type="button"
                                >
                                  拒絕
                                </button>
                              </>
                            ) : (
                              <>
                                {/* docs/87 §6.3：放寬可取餐閘門 */}
                                {(order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid") &&
                                order.fulfillmentStatus !== "ready" ? (
                                  <button
                                    className="flex-1 rounded-xl bg-orange-500 px-2 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
                                    onClick={() => updateQuickFulfillment(order.id)}
                                    type="button"
                                  >
                                    標記可取
                                  </button>
                                ) : null}
                                <button
                                  className="flex-1 rounded-xl bg-slate-900 px-2 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                                  onClick={() => setPayingOrderId(order.id)}
                                  type="button"
                                >
                                  結帳
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {offlineMode ? (
                  <div className="mt-3 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
                    目前離線，恢復網絡後會自動補傳資料
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        ) : (
        <div className="flex h-[100dvh] flex-1 flex-col overflow-hidden">
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[260px_minmax(0,1fr)_280px] xl:grid-cols-[300px_minmax(0,1fr)_330px]">
          <section className="flex h-full flex-col overflow-hidden border-r border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold text-slate-900">{displayStoreName}</div>
                  {displayStoreSubtitle ? (
                    <div className="mt-1 text-xs text-slate-500">{displayStoreSubtitle}</div>
                  ) : null}
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

            {activeOrder?.status === "reopened" ? (
              <div className="mx-4 mb-1 mt-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500 px-3 py-1 text-sm font-bold text-white">
                    <span className="h-4 w-4 rounded-full bg-white" />
                    返結帳
                  </span>
                  <span className="min-w-0 flex-1 text-xs font-semibold text-amber-800">此單為返結單，可改價／加餐後重新結帳</span>
                </div>
                {activeOrder.reopenReason ? (
                  <div className="mt-1 text-[11px] text-amber-700">返結原因：{activeOrder.reopenReason}</div>
                ) : null}
                {activeOrder.originalSettledAt ? (
                  <div className="mt-0.5 text-[11px] text-amber-600">
                    原結帳時間：{formatMacauDateTime(activeOrder.originalSettledAt)}
                  </div>
                ) : null}
              </div>
            ) : null}

            {isReadOnlySettled ? (
              <div className="mx-4 mb-1 mt-2 rounded-2xl border border-slate-300 bg-slate-100 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-500 px-3 py-1 text-sm font-bold text-white">
                      <span className="h-4 w-4 rounded-full bg-white" />
                      已結帳
                    </span>
                    <span className="min-w-0 flex-1 text-xs font-semibold text-slate-700">唯讀預覽 · 所有操作已鎖定</span>
                  </div>
                  <button
                    className="rounded-2xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={roSubmitting}
                    onClick={() => setRoModalOpen(true)}
                    type="button"
                  >
                    返結帳
                  </button>
                </div>
                {workspaceOrder?.originalSettledAt || workspaceOrder?.updatedAt ? (
                  <div className="mt-1 text-[11px] text-slate-500">
                    結帳時間：{formatMacauDateTime(workspaceOrder.originalSettledAt ?? workspaceOrder.updatedAt)}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="px-4 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-900">訂單明細</span>
                <span className="text-xs text-slate-500">{cartItems.length + voidedItems.length} 項</span>
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
              {cartItems.length === 0 && voidedItems.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                  請從右側商品區加入菜品
                </div>
              ) : (
                  <div className="grid gap-2">
                  {cartItems.map((item) => {
                    const itemKey = itemIdentity(item);
                    const orderedQty = orderedItemQtyMap.get(itemKey) ?? 0;
                    const locked = orderedQty > 0;
                    return (
                    <article
                      key={itemKey}
                      className={`rounded-2xl border px-3 py-3 ${
                        locked
                          ? "border-slate-200 bg-slate-100 opacity-75"
                          : selectedItemId === item.menuItemId
                            ? "border-orange-300 bg-orange-50/50"
                            : "border-slate-100 bg-slate-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">
                            {item.name}
                            {locked ? (
                              <span className="ml-2 inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                                已下單
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {specText(item) || item.note || "未選規格"} · {formatMoney(item.price, bootstrap.currency)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {locked ? (
                            <div className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                              已下單 x{item.quantity}
                            </div>
                          ) : (
                            <>
                              <button
                                className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={isReadOnlySettled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  updateQuantity(itemKey, -1);
                                }}
                                type="button"
                              >
                                -
                              </button>
                              <div className="w-7 text-center text-sm font-semibold text-slate-800">{item.quantity}</div>
                              <button
                                className="grid h-7 w-7 place-items-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={isReadOnlySettled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  updateQuantity(itemKey, 1);
                                }}
                                type="button"
                              >
                                +
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {/* 動作列：只放掣 + 短狀態（「已退 N 份」），保持單行，唔會俾長備註擠走位 */}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex flex-nowrap items-center gap-2">
                          {!locked ? (
                              <button
                                className="whitespace-nowrap rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={isReadOnlySettled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openItemNoteEditor(item);
                                }}
                                type="button"
                              >
                              {item.note ? "編輯備註" : "加備註"}
                            </button>
                          ) : null}
                          {locked ? (
                              <button
                                className="whitespace-nowrap rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 shadow-sm ring-1 ring-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={isReadOnlySettled}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!canVoidItem) {
                                    showPermissionDenied("退菜");
                                    return;
                                  }
                                  setVoidRequest({ item, mode: "one" });
                                }}
                                type="button"
                              >
                              退 1 份
                            </button>
                          ) : null}
                        </div>
                        {locked && item.quantity < orderedQty ? (
                          <div className="shrink-0 text-xs font-semibold text-red-600">
                            已退 {orderedQty - item.quantity} 份
                          </div>
                        ) : null}
                      </div>
                      {/* 單品備註（docs/84 §7）：獨立一行、整寬。長文字向下自動換行，
                          break-words 令 CJK 都可靠邊斷行（純 break-normal 對長串中文無效）。
                          唔再用 truncate 切走，亦唔會向右撐破 card 或產生橫向捲軸。 */}
                      {item.note ? (
                        <div className="mt-1.5 whitespace-pre-wrap break-words text-xs text-slate-500">
                          備註：{item.note}
                          {locked ? <span className="ml-1 text-[11px] font-medium text-amber-600">已鎖定</span> : null}
                        </div>
                      ) : null}
                    </article>
                    );
                  })}
                  {voidedItems.map((item, idx) => (
                    <article
                      key={`voided-${idx}-${itemIdentity(item)}`}
                      className="rounded-2xl border border-red-200 bg-red-50/60 px-3 py-3 opacity-80"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900 line-through">
                            {item.name}
                            <span className="ml-2 inline-flex rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                              已退菜
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {specText(item) || item.note || "未選規格"} · {formatMoney(item.price, bootstrap.currency)}
                          </div>
                          {item.voidedReason ? (
                            <div className="mt-1 text-[11px] text-red-600">退菜原因：{item.voidedReason}</div>
                          ) : null}
                        </div>
                        <div className="shrink-0 rounded-full bg-red-200 px-3 py-1 text-xs font-semibold text-red-700">
                          已退 x{item.quantity}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 px-4 py-4">
              <div className="mb-3 flex flex-wrap justify-end gap-2">
                {isAddOnOrder && cartItems.some((item) => (orderedItemQtyMap.get(itemIdentity(item)) ?? 0) > 0) ? (
                  <button
                    className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 shadow-sm ring-1 ring-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isReadOnlySettled}
                    onClick={() => {
                      if (!canVoidItem) {
                        showPermissionDenied("退菜");
                        return;
                      }
                      setVoidRequest({
                        item: cartItems.find((item) => (orderedItemQtyMap.get(itemIdentity(item)) ?? 0) > 0) ?? cartItems[0],
                        mode: "all",
                        isFullOrder: true,
                      });
                    }}
                    type="button"
                  >
                    全部退菜
                  </button>
                ) : null}
                {findVoidableTableOrder(activeTableId) ? (
                  <button
                    className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 shadow-sm ring-1 ring-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isReadOnlySettled}
                    onClick={() => {
                      if (!canVoidItem) {
                        showPermissionDenied("退桌");
                        return;
                      }
                      setVoidTableRequest(activeTableId);
                    }}
                    type="button"
                  >
                    退桌
                  </button>
                ) : null}
              </div>
              {/* items-start：備註換行增高時，「編輯」掣留喺頂部唔會被拉到垂直居中而走位 */}
              <div className="flex items-start justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                {/* flex-1 + min-w-0：文字區塊食晒剩餘寬度並以 card 邊界為限向下換行（docs/84 §7） */}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-slate-600">全單備註</div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-500">
                    {orderNote ? orderNote : <span className="text-slate-400">（可選）</span>}
                  </div>
                  {orderNoteLocked ? (
                    <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] font-medium text-amber-600">
                      訂單已送出，備註已鎖定
                    </div>
                  ) : null}
                </div>
                  <button
                    className="shrink-0 rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isReadOnlySettled || orderNoteLocked}
                    onClick={() => {
                      setNoteDraft(orderNote);
                      setNoteModal({ type: "order" });
                    }}
                    type="button"
                  >
                  {orderNoteLocked ? "已鎖定" : "編輯"}
                </button>
              </div>
            </div>
          </section>

          <main className="flex h-full flex-col overflow-hidden bg-slate-100">
            <div className="border-b border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-w-0">
                  <button
                    key="all"
                    className={`h-10 whitespace-nowrap shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
                      effectiveCategoryId === "" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setActiveCategoryId(ALL_MENU_CATEGORY_ID)}
                    type="button"
                  >
                    全部
                  </button>
                  {bootstrap.categories.map((category) => (
                    <button
                      key={category.id}
                      className={`h-10 whitespace-nowrap shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
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
                <div className="flex w-full shrink-0 items-center gap-2 xl:w-56">
                  <input
                    className="h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-all duration-150 focus:border-orange-400"
                    onChange={(event) => {
                      const next = event.target.value;
                      setSearchKeyword(next);
                      if (next.trim()) {
                        // 搜尋時自動切到「全部」
                        setActiveCategoryId(ALL_MENU_CATEGORY_ID);
                      }
                    }}
                    placeholder="搜尋商品"
                    value={searchKeyword}
                  />
                  <button
                    className="h-10 whitespace-nowrap shrink-0 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
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
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                    disabled={isReadOnlySettled}
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
              <div className="text-base font-semibold text-slate-900">收銀與支付</div>
              <div className="mt-1 text-xs text-slate-500">
                {isQuickMode
                  ? "點餐結帳在此；線上／線下訂單見螢幕下方"
                  : currentSettlementOrder
                    ? `待結帳單號 ${currentSettlementOrder.localOrderNo}`
                    : selectedTableStatus === "draft"
                      ? "目前尚未下單，可繼續加菜或送廚房"
                      : "目前未有待結帳訂單，可先開台或送廚房單"}
              </div>
            </div>

            <div className="flex-1 overflow-auto px-4 py-4">
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
                    className="rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-busy={orderSubmitting}
                    disabled={orderSubmitting || isReadOnlySettled}
                    onClick={() => void sendToKitchen()}
                    type="button"
                  >
                    {orderSubmitting ? "提交中…" : isAddOnOrder ? "加單" : "下單"}
                  </button>
                ) : null}
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={isReadOnlySettled}
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
                              {formatMacauDateTime(event.createdAt).slice(5)}
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
                          {/* docs/84 §7：break-words 預防窄容器下長備註向右撐破版面 */}
                          {item.note ? (
                            <div className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-500">備註：{item.note}</div>
                          ) : null}
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
                <div className="mt-3 w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
                  目前離線，恢復網絡後可補傳資料
                </div>
              ) : null}

              {/* 最近訂單：點餐頁不顯示，避免干擾店員操作 */}
              </>
            </div>
          </section>
        </div>
        {isQuickMode && !offlineMode && bootstrap ? (
          <QuickModeOrdersBar
            autoAcceptOnline={autoAcceptOnlineOrders}
            completeLabel={quickCompleteLabel}
            completionLabel={quickCompletionLabel}
            currency={bootstrap.currency}
            onAutoAcceptOnlineChange={(next) => {
              const nextSettings = {
                ...localSettings,
                onlineOrderSettings: {
                  ...localSettings.onlineOrderSettings,
                  autoAccept: next,
                },
              };
              setLocalSettings(nextSettings);
              savePosLocalSettings(nextSettings);
              // 同步到 server。本地 localStorage 係權威真源。
              // POST 失敗唔會覆蓋本地（device-settings mount fetch 已修為 local-only）。
              void fetch("/api/online-order-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // 帶 storeId：舊 code 冇帶 → server 一律寫落 "macau-store-a"，
                // 多間店共用同一行互相覆蓋（見 /api/online-order-settings route 註釋）。
                body: JSON.stringify({
                  ...nextSettings.onlineOrderSettings,
                  storeId: loadAuthSession()?.merchantId ?? null,
                }),
              }).catch(() => {
                if (process.env.NODE_ENV !== "production") {
                  console.warn("[pos-app] autoAccept POST failed — local value is authoritative");
                }
              });
            }}
            onMarkCompleted={(orderId, label) => markOrderCompleted(orderId, { label })}
            onMarkReady={(orderId) => updateQuickFulfillment(orderId)}
            onOnlineToast={(payload) =>
              setToast({ tone: payload.tone === "success" ? "success" : "info", message: payload.message })
            }
            onViewOrder={(orderId) => setViewingOrderId(orderId)}
            preparingOrders={quickPreparingOrders}
            waitingOrders={quickWaitingOrders}
          />
        ) : null}
        </div>
        )}
      </div>

      <ItemSpecModal
        key={`${specModalItem?.id ?? "none"}-${specEditingKey ?? "new"}-${JSON.stringify(selectedSpecValues)}`}
        isOptionDisabled={isSpecOptionSoldOut}
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

      {marketPriceItem ? (
        <ResponsiveModal
          onClose={() => {
            setMarketPriceItem(null);
            setMarketPriceValue("");
            setMarketPriceSpecs([]);
          }}
          widthClassName="max-w-3xl"
          zIndexClassName="z-[60]"
          bodyClassName="p-0"
        >
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] md:h-[520px]">
            <div className="p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-rose-500">時價菜</div>
              <h3 className="mt-1 text-xl font-bold text-slate-900">{marketPriceItem.name}</h3>
              {marketPriceSpecs.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm text-slate-500">
                  {marketPriceSpecs.map((spec) => (
                    <li key={`${spec.groupId}-${spec.optionId}`}>
                      • {spec.groupName}：{spec.optionLabel}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-4 text-sm text-slate-500">
                請輸入本次下單的時價金額（{bootstrap.currency}）。
              </p>
              <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-3xl font-bold text-slate-900">
                {bootstrap.currency} {marketPriceValue || "0.00"}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                金額每次落單都不同，請向廚房確認後填入。
              </p>
            </div>
            <FixedNumberPad
              title="時價金額"
              value={marketPriceValue}
              onChange={setMarketPriceValue}
              onConfirm={confirmMarketPrice}
              confirmLabel="加入單"
              showDisplay
            />
          </div>
        </ResponsiveModal>
      ) : null}

      {noteModal ? (
        <ResponsiveModal
          actions={
            <>
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
                    // 資料層防線：全單備註喺訂單送出後即鎖定（就算彈窗被其他途徑打開都擋得住）。
                    if (orderNoteLocked) {
                      setToast({ tone: "info", message: ORDER_NOTE_LOCKED_MESSAGE });
                      setNoteModal(null);
                      return;
                    }
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
            </>
          }
          description="可多選常用備註，也可自由輸入。"
          onClose={() => setNoteModal(null)}
          title={noteModal.type === "order" ? "全單備註" : "單品備註"}
          widthClassName="max-w-2xl"
        >
            <div>
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
        </ResponsiveModal>
      ) : null}

      {roModalOpen && activeOrderId
        ? (() => {
            const target = orders.find((o) => o.id === activeOrderId) ?? null;
            if (!target) return null;
            return (
              <ResponsiveModal
                description={`${target.tableName} · 退回可編輯後重新結帳`}
                onClose={() => {
                  setRoModalOpen(false);
                  setRoReason("");
                }}
                title="返結帳（反結賬）"
                widthClassName="max-w-md"
              >
                <div className="grid gap-3">
                  <p className="text-[11px] text-amber-700">
                    必須揀返結原因。確認後此單退回可編輯，可改價／加餐後重新結帳。
                  </p>
                  <select
                    className="w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
                    value={roReason}
                    onChange={(e) => setRoReason(e.target.value)}
                  >
                    <option value="" disabled>
                      揀返結原因…
                    </option>
                    {(loadPosLocalSettings()?.reopenReasons ?? []).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="w-full rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    disabled={!roReason || roSubmitting}
                    onClick={() => void handlePosReopen()}
                  >
                    {roSubmitting ? "處理中…" : "返結帳"}
                  </button>
                </div>
              </ResponsiveModal>
            );
          })()
        : null}

      {viewingOrder ? (
        <ResponsiveModal
          onClose={() => setViewingOrderId(null)}
          actions={
            <>
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
                  }}
                  type="button"
                >
                  去結帳
                </button>
              ) : null}
              <button
                className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 shadow-sm ring-1 ring-red-200"
                onClick={() => {
                  if (window.confirm(`確定刪除訂單 ${viewingOrder.localOrderNo}？此操作不可復原，會同時刪除本機與伺服器紀錄。`)) {
                    deleteOrderPermanently(viewingOrder.id);
                  }
                }}
                type="button"
              >
                刪除訂單
              </button>
            </>
          }
          description={`${viewingOrder.localOrderNo} · ${viewingOrder.tableName}`}
          header={
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-900">訂單詳情</div>
                <div className="mt-1 text-sm text-slate-500">
                  {viewingOrder.localOrderNo} · {viewingOrder.tableName}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  // 訂單狀態標籤（統一看板：草稿/製作中/已付款/待取餐/已完成/已取消/已退款/部分退款/已返結）
                  // 顏色 token 見 getOrderStatusBadge（pos-order-filters.ts）
                  const badge = getOrderStatusBadge(viewingOrder);
                  const prepaidFull =
                    viewingOrder.status === "paid" || (viewingOrder.prepaidAmount ?? 0) >= viewingOrder.total;
                  return (
                    <>
                      <div
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${badge.bgClass} ${badge.textClass}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${badge.dotClass}`} />
                        {badge.label}
                      </div>
                      {prepaidFull && viewingOrder.status !== "settled" && viewingOrder.status !== "refunded" && viewingOrder.status !== "partially_refunded" ? (
                        <div className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                          待完成
                        </div>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </div>
          }
          showCloseButton={false}
          widthClassName="max-w-2xl"
        >
            <div className="grid gap-2">
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
                      {/* docs/84 §7：break-words 預防窄容器下長備註向右撐破版面 */}
                      {item.note ? (
                        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-500">備註：{item.note}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-slate-900">x{item.quantity}</div>
                  </div>
                </div>
              ))}
              {(viewingOrder.voidedItems ?? []).map((item, index) => (
                <div
                  key={`voided-${item.menuItemId}-${index}`}
                  className="rounded-2xl border border-red-200 bg-red-50/60 p-3 opacity-80"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900 line-through">
                        {item.name}
                        <span className="ml-2 inline-flex rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                          已退菜
                        </span>
                      </div>
                      {item.selectedSpecs?.length ? (
                        <div className="mt-1 text-xs text-slate-500">
                          {item.selectedSpecs.map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ")}
                        </div>
                      ) : null}
                      {item.voidedReason ? (
                        <div className="mt-1 text-[11px] text-red-600">退菜原因：{item.voidedReason}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 rounded-full bg-red-200 px-3 py-1 text-xs font-semibold text-red-700">
                      已退 x{item.quantity}
                    </div>
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
                            <span className="font-semibold text-slate-900">{formatMacauDateTime(record.createdAt)}</span>
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
        </ResponsiveModal>
      ) : null}

      {payingOrderId ? (
        <ResponsiveModal
          onClose={() => setPayingOrderId(null)}
          header={
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xl font-semibold text-slate-900">結帳</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <span>
                    {payingOrderId === CART_PAYING_ID
                      ? "本次結帳"
                      : currentSettlementOrder
                        ? `訂單 ${currentSettlementOrder.localOrderNo}`
                        : "待結帳訂單"}
                  </span>
                  {/* 顯示位 ③：結帳畫面（規格 7）*/}
                  {currentSettlementOrder ? <OrderSourceBadge order={currentSettlementOrder} /> : null}
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
                  onClick={() => {
                    setPayingOrderId(null);
                    resetMemberCheckoutState();
                  }}
                  type="button"
                >
                  關閉
                </button>
              </div>
            </div>
          }
          showCloseButton={false}
          widthClassName="max-w-5xl"
        >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
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
                  {selectedMoneyVoucherAvos > 0 ? (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">已選現金券（兌換入餘額）</span>
                      <span className="font-semibold text-slate-900">
                        {formatMoney(avosToMop(selectedMoneyVoucherAvos), bootstrap.currency)}
                      </span>
                    </div>
                  ) : null}
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
                    <div className="text-xs font-semibold text-slate-500">會員優惠 / 餘額</div>
                    <div className="mt-2 text-xs text-slate-500">
                      輸入會員手機號碼後，可在右側「支付方式」選「會員餘額」扣款，並核銷獎賞券（須連線）。
                    </div>
                    {offlineMode && memberPhone.length === 8 ? (
                      <div className="mt-2 text-xs text-amber-700">離線狀態無法查詢會員或扣款。</div>
                    ) : null}
                    {ledgerMember ? (
                      <div className="mt-3 rounded-2xl bg-slate-50 p-3 text-sm">
                        <div className="font-semibold text-slate-900">
                          {ledgerMember.displayName ?? "會員"} · {ledgerMember.customerPhone}
                        </div>
                        <div className="mt-1 text-slate-500">
                          餘額 {formatMoney(avosToMop(ledgerMember.balanceAvos), bootstrap.currency)} · 可用券{" "}
                          {ledgerMember.redeemableGrants.length} 張
                        </div>
                        <label className="mt-3 grid gap-1">
                          <span className="text-xs font-semibold text-slate-600">核銷獎賞券</span>
                          <div className="grid gap-2">
                            {ledgerMember.redeemableGrants.length === 0 ? (
                              <div className="text-xs text-slate-500">目前沒有可核銷獎賞券</div>
                            ) : (
                              ledgerMember.redeemableGrants.map((grant) => {
                                const selected = selectedGrantIds.includes(grant.grantId);
                                const disabled = memberCheckoutRedeemDone;
                                return (
                                  <label
                                    key={grant.grantId}
                                    className={`flex items-start justify-between gap-3 rounded-2xl border px-3 py-2 ${
                                      selected ? "border-orange-300 bg-orange-50" : "border-slate-200 bg-white"
                                    } ${disabled ? "opacity-60" : ""}`}
                                  >
                                    <div>
                                      <div className="text-sm font-semibold text-slate-900">{grant.title}</div>
                                      <div className="mt-1 text-xs text-slate-500">
                                        {grantTypeLabel(grant.prizeType)}
                                        {grant.prizeType === "money_voucher"
                                          ? ` · ${formatMoney(avosToMop(grant.rewardAmountAvos), bootstrap.currency)} 入餘額`
                                          : " · 結帳時核銷"}
                                      </div>
                                    </div>
                                    <input
                                      checked={selected}
                                      disabled={disabled}
                                      onChange={(event) => {
                                        const checked = event.target.checked;
                                        setSelectedGrantIds((current) =>
                                          checked
                                            ? [...current, grant.grantId]
                                            : current.filter((id) => id !== grant.grantId),
                                        );
                                      }}
                                      type="checkbox"
                                    />
                                  </label>
                                );
                              })
                            )}
                          </div>
                        </label>
                      </div>
                    ) : null}
                  </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">支付方式</div>
                  <div className="mt-1 text-xs text-slate-500">
                    可選「會員餘額」搭配一種其他支付方式；餘額不足時剩餘金額以所選方式收取。
                  </div>
                  <div className="mt-3 grid gap-2">
                    <button
                      className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold transition ${
                        !ledgerMember || memberCheckoutRedeemDone
                          ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                          : useMemberBalance
                            ? "border-orange-300 bg-orange-50 text-orange-700"
                            : "border-slate-200 bg-slate-50 text-slate-900 hover:border-orange-300"
                      }`}
                      disabled={!ledgerMember || memberCheckoutRedeemDone}
                      onClick={() => {
                        if (!ledgerMember || memberCheckoutRedeemDone) return;
                        setUseMemberBalance((current) => !current);
                      }}
                      type="button"
                    >
                      <div>會員餘額</div>
                      {ledgerMember ? (
                        <div className="mt-1 text-xs font-normal opacity-80">
                          可用 {formatMoney(avosToMop(memberAvailableAvos), bootstrap.currency)}
                          {useMemberBalance && memberDeduction > 0
                            ? ` · 本次扣 ${formatMoney(memberDeduction, bootstrap.currency)}`
                            : ""}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs font-normal">請先在右側輸入會員手機號碼</div>
                      )}
                    </button>
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
                    className="mt-4 w-full rounded-2xl bg-orange-500 px-4 py-3 text-base font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={
                      memberCheckoutSubmitting ||
                      (useMemberBalance && memberDeduction > 0 && paymentSummary.total > 0 && !selectedPaymentMethod)
                    }
                    onClick={() => {
                      if (paymentSummary.total <= 0 && paymentSummary.prepaidAmount > 0) {
                        completeOnlinePaidOrder();
                        return;
                      }
                      if (
                        useMemberBalance &&
                        memberDeduction > 0 &&
                        paymentSummary.total > 0 &&
                        !selectedPaymentMethod
                      ) {
                        setToast({ tone: "info", message: "會員餘額不足，請再選一種支付方式。" });
                        return;
                      }
                      const method =
                        useMemberBalance && memberDeduction > 0 && paymentSummary.total <= 0
                          ? "會員餘額"
                          : selectedPaymentMethod || paymentMethods[0] || "現金";
                      void confirmPayment(method);
                    }}
                    type="button"
                  >
                    {memberCheckoutSubmitting
                      ? "處理會員扣款中…"
                      : paymentSummary.total <= 0 && paymentSummary.prepaidAmount > 0
                        ? "客人已支付，完成訂單"
                        : memberCheckoutRedeemDone
                          ? "重試扣款"
                          : "去結帳"}
                  </button>
                </div>
              </div>

              <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-100 px-4 py-4">
                  <div className="text-sm font-semibold text-slate-900">會員</div>
                  <div className="mt-1 text-xs text-slate-500">輸入 8 位手機號碼後會自動查詢</div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
                  <label className="grid gap-1 text-xs font-semibold text-slate-500">
                    會員號碼（8 位）
                    <input
                      className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-base font-semibold text-slate-900 tracking-widest"
                      inputMode="numeric"
                      maxLength={8}
                      onChange={(event) => handleMemberPhoneChange(event.target.value)}
                      placeholder="例如：63936542"
                      value={memberPhone}
                    />
                  </label>
                  {memberSearching ? <div className="mt-2 text-xs text-slate-500">搜尋中…</div> : null}
                  {memberSearchHint ? <div className="mt-2 text-xs text-red-600">{memberSearchHint}</div> : null}
                  {ledgerMember ? (
                    <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                      <div className="font-semibold text-slate-900">
                        {ledgerMember.displayName ?? "會員"}
                      </div>
                      <div className="mt-1 text-xs text-slate-600">{ledgerMember.customerPhone}</div>
                      <div className="mt-2 text-xs text-slate-500">
                        餘額 {formatMoney(avosToMop(ledgerMember.balanceAvos), bootstrap.currency)} · 可用券{" "}
                        {ledgerMember.redeemableGrants.length}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 border-t border-slate-200 px-4 py-4">
                  <NumericKeypad value={memberPhone} onChange={handleMemberPhoneChange} maxLength={8} />
                </div>
              </aside>
            </div>
        </ResponsiveModal>
      ) : null}

      {orderActionRequest ? (
        <ResponsiveModal
          onClose={() => { setOrderActionRequest(null); setOrderActionReason(""); }}
          actions={
            <>
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
            </>
          }
          description={orders.find((order) => order.id === orderActionRequest.orderId)?.localOrderNo ?? "--"}
          title={orderActionRequest.type === "refund_order" ? "退款原因" : "取消結帳原因"}
          widthClassName="max-w-md"
          zIndexClassName="z-[60]"
        >
              <input
                autoFocus
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm"
                onChange={(event) => setOrderActionReason(event.target.value)}
                placeholder={orderActionRequest.type === "refund_order" ? "例如：客人退款 / 支付失敗" : "例如：客人不要了 / 重開一單"}
                value={orderActionReason}
              />
        </ResponsiveModal>
      ) : null}

      {refundSummaryExportOpen ? (
        <ResponsiveModal
          onClose={() => setRefundSummaryExportOpen(false)}
          actions={
            <>
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
            </>
          }
          description="可按日期或按員工，把目前訂單中的退款記錄匯總導出成 CSV。"
          title="退款匯總導出"
          widthClassName="max-w-lg"
          zIndexClassName="z-[60]"
        >
            <div className="grid gap-3 md:grid-cols-2">
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
        </ResponsiveModal>
      ) : null}

      {partialRefundOrderId ? (
        <ResponsiveModal onClose={() => { setPartialRefundOrderId(null); setPartialRefundReason(""); setPartialRefundQuantities({}); }} widthClassName="max-w-2xl" zIndexClassName="z-[60]">
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
                  <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
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
                  <div className="mt-4 grid gap-3">
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
                  </div>
                  <div className="mt-4 sticky bottom-0 z-[1] flex justify-end gap-2 border-t border-slate-200 bg-white/95 pt-3 backdrop-blur">
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
        </ResponsiveModal>
      ) : null}

      {voidRequest ? (
        <ResponsiveModal
          onClose={() => { setVoidRequest(null); setVoidReason(""); }}
          actions={
            <>
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
                  if (voidRequest.isFullOrder) {
                    voidEntireOrder(voidReason.trim());
                  } else {
                    voidOrderedItem(voidRequest.item, voidRequest.mode, voidReason.trim());
                  }
                  setVoidRequest(null);
                  setVoidReason("");
                }}
                type="button"
              >
                確認退菜
              </button>
            </>
          }
          description={voidRequest.isFullOrder ? "全部退菜" : `${voidRequest.item.name} · 只退 1 份`}
          title="退菜原因"
          widthClassName="max-w-md"
          zIndexClassName="z-[60]"
        >
            <div>
              <div className="text-xs font-semibold text-slate-500">取消備註</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {localSettings.cancelNotePresets.map((preset) => (
                  <button
                    key={preset}
                    className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                    onClick={() => {
                      const base = voidReason.trim();
                      const next = base ? (base.includes(preset) ? base : `${base}，${preset}`) : preset;
                      setVoidReason(next);
                    }}
                    type="button"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
            <input
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm"
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="例如：客人取消 / 廚房售罄"
              value={voidReason}
            />
        </ResponsiveModal>
      ) : null}

      {voidTableRequest ? (
        <ResponsiveModal
          onClose={() => { setVoidTableRequest(null); setVoidTableReason(""); }}
          actions={
            <>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => {
                  setVoidTableRequest(null);
                  setVoidTableReason("");
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  voidTable(voidTableRequest, voidTableReason.trim());
                  setVoidTableRequest(null);
                  setVoidTableReason("");
                }}
                type="button"
              >
                確認退桌
              </button>
            </>
          }
          description="退桌會將枱上所有菜作廢並釋放枱位，此操作不可還原"
          title="退桌原因"
          widthClassName="max-w-md"
          zIndexClassName="z-[60]"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500">取消備註</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {localSettings.cancelNotePresets.map((preset) => (
                <button
                  key={preset}
                  className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                  onClick={() => {
                    const base = voidTableReason.trim();
                    const next = base ? (base.includes(preset) ? base : `${base}，${preset}`) : preset;
                    setVoidTableReason(next);
                  }}
                  type="button"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <input
            autoFocus
            className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm"
            onChange={(event) => setVoidTableReason(event.target.value)}
            placeholder="例如：客人取消 / 臨時要走"
            value={voidTableReason}
          />
        </ResponsiveModal>
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
        <ResponsiveModal
          bodyClassName="text-center"
          panelClassName="p-6 sm:p-8 md:ml-[72px]"
          widthClassName="max-w-md"
          zIndexClassName="z-[52]"
        >
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
        </ResponsiveModal>
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
