"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";

import { AppSidebar } from "@/components/app-sidebar";
import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { DateRangeFilterChips } from "@/components/date-range-filter-chips";
import { MerchantOpenPill } from "@/components/merchant-open-pill";
import { ResponsiveModal } from "@/components/responsive-modal";
import { ReceiptTicketPreview } from "@/components/receipt-ticket-preview";
import {
  adoptLedgerOrderAsQuickCounter,
  assignLedgerOrderToTable,
  bridgeLedgerOrderToPos,
  printKitchenForLedgerOrder,
  resolveLedgerPosOrderForReceipt,
} from "@/lib/ledger/ledger-pos-bridge";
import { TableAssignModal } from "@/components/table-assign-modal";
import {
  isOnlineDineIn,
  onlinePaymentBadge,
  onlineTableAssignLabel,
  onlineTableBadge,
} from "@/lib/pos/online-dinein-labels";
// ⚠️ 一定要 alias：呢個檔自己有一個 `loadOrders`（拉 Ledger 線上單嘅 async loader），
// 撞名會令本機訂單讀取變成 Promise。
import { loadOperatingMode, loadOrders as loadLocalOrders } from "@/lib/storage";
import { transferredLedgerOrderIds } from "@/lib/pos-order-filters";
import {
  describeNoReceiptPrinterError,
  printReceiptForLedgerOrderOnce,
  printVoidForLedgerOrderOnce,
  reprintReceiptForLedgerOrder,
} from "@/lib/print-jobs";
import {
  acceptLedgerOrder,
  acceptLedgerOrderInStore,
  resolveOrderChange,
  setOrderPaidInStore,
  markPaidIfInStoreUnpaid,
  updateOrderStatus as updateLedgerOrderStatus,
} from "@/lib/ledger/order-actions";
import {
  changeRequestLabel,
  computeSyncCursor,
  hasPendingChangeRequest,
  ledgerStatusLabel,
  LedgerOnlineOrder,
  LedgerOrderTab,
  mergeLedgerOrders,
  normalizeLedgerStatus,
  orderCodeLabel,
  paymentModeLabel,
  rawLedgerStatus,
  tabLabel,
} from "@/lib/ledger/order-mapper";
import {
  dateFilterLabel,
  LEDGER_ORDER_DATE_FILTERS,
  limitForDateFilter,
  orderMatchesDateFilter,
  type DateFilterArg,
  type LedgerOrderDateFilterKey,
} from "@/lib/ledger/order-date-filter";
import type { CustomDateRange } from "@/lib/ledger/date-range";
import { getOrderDetail, listMerchantOrders } from "@/lib/ledger/orders";
import { getLedgerMerchantId, restoreLedgerSession } from "@/lib/ledger/session";
import { useLedgerOrdersRealtime } from "@/lib/ledger/use-ledger-orders-realtime";
import { useOnlineOrderSettings } from "@/lib/pos/use-online-order-settings";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { AuthSession, loadAuthSession, loadPosLocalSettings, loadPrintJobs } from "@/lib/storage";
import { isReopenTempTable } from "@/lib/pos/table-scope";
import { formatMoney } from "@/lib/format";
import { PosOrder } from "@/lib/types";

const TABS: Array<{ key: LedgerOrderTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "dine_in", label: "堂食" },
  { key: "pickup", label: "外賣自取" },
  { key: "self_delivery", label: "外送" },
];

/**
 * 線上單狀態藥丸視覺 token —— 與「店內線下訂單」卡片嘅 getOrderStatusBadge
 * （pos-order-filters.ts）同一套配色／結構（label + bg + dot），令左右兩欄卡片
 * 喺訂單介面視覺完全 align。label 仍用 ledgerStatusLabel 原有文案。
 */
function getLedgerStatusBadge(order: LedgerOnlineOrder): {
  label: string;
  bgClass: string;
  textClass: string;
  dotClass: string;
} {
  const label = ledgerStatusLabel(order.status, order.fulfillmentType);
  const raw = rawLedgerStatus(order.status);
  if (raw === "completed") {
    return { label, bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" };
  }
  if (raw === "cancelled") {
    return { label, bgClass: "bg-slate-200", textClass: "text-slate-600", dotClass: "bg-slate-400" };
  }
  if (raw === "ready") {
    return { label, bgClass: "bg-sky-50", textClass: "text-sky-700", dotClass: "bg-sky-500" };
  }
  if (raw === "delivering") {
    return { label, bgClass: "bg-violet-50", textClass: "text-violet-700", dotClass: "bg-violet-500" };
  }
  if (raw === "accepted") {
    return { label, bgClass: "bg-blue-50", textClass: "text-blue-700", dotClass: "bg-blue-500" };
  }
  if (raw === "preparing") {
    return { label, bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-500" };
  }
  // pending 新單
  return { label, bgClass: "bg-orange-50", textClass: "text-orange-700", dotClass: "bg-orange-500" };
}

// 訂單列表（2026-09-10）：表頭 / 儲存格共用樣式。表頭 sticky，窄屏由外層 overflow 橫向滾動。
const TH_CELL = "sticky top-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500";
const TD_CELL = "px-3 py-2 align-middle";

/**
 * 剔除「已排位轉成本地堂食單」嘅線上單（商家 2026-09-12：「唔應該兩邊同時存在」）。
 *
 * `tick` 係 cache-buster：本機單存喺 localStorage，本機單一變（`pos-orders-changed`）
 * 就要重算呢個 filter，否則撳完「排位」張單仍然留喺線上列表。
 */
/**
 * 時間篩選嘅「簽名」字串，用嚟比較兩個 selection 係唔係等價。
 *
 * ⚠️ 唔可以比較物件 identity：`orders-hub` 每次 render 都砌一個新 `{key, custom}`，
 * identity 比對會令 embedded 同步 effect 每次都判定「有變」→ 無限重載。
 */
function dateFilterSignature(filter: DateFilterArg): string {
  if (typeof filter === "string") return filter;
  const { key, custom } = filter;
  return custom ? `${key}:${custom.start}:${custom.end}` : key;
}

function withoutTransferredOrders(orders: LedgerOnlineOrder[], tick: number): LedgerOnlineOrder[] {
  void tick;
  const transferred = transferredLedgerOrderIds(loadLocalOrders());
  return orders.filter((order) => !transferred.has(order.id));
}

/**
 * 自動分頁抓齊線上單（2026-09-13 新增）。
 *
 * ## 為什麼需要
 *
 * Ledger RPC `list_merchant_orders` **冇 start / end 參數**，只有：
 * - `p_limit`（**上限 100**）
 * - `p_since` + `p_since_id`（增量游標，語義係「updated_at >= since」排序後嘅位置）
 *
 * 所以商家揀「自訂 2026-08-01 ~ 08-31」（一個月）時，單次 100 張會**靜靜截斷**，
 * 匯出唔齊而用戶唔知。
 *
 * ## 做法
 *
 * 以「最後一行」嘅 `(updatedAt, id)` 做下一頁游標，逐頁往後抓，直到：
 * - 回傳行數 < 每頁上限（＝已到尾），或
 * - 達到 `maxPages`（安全上限），此時 `truncated = true`。
 *
 * ⚠️ 游標用 `computeSyncCursor`（同增量同步同一個口徑），唔可以自己砌 ——
 * 排序鍵係 `updated_at DESC, id`，兩者要一致否則會跳行／重複。
 *
 * ⚠️ 分頁係**逐頁順序**（唔可以 Promise.all 並行）—— 下一頁嘅游標依賴上一頁結果。
 */
async function listMerchantOrdersPaged({
  merchantId,
  limit,
  maxPages,
}: {
  merchantId: string;
  limit: number;
  maxPages: number;
}): Promise<{ rows: LedgerOnlineOrder[]; truncated: boolean }> {
  const pageSize = Math.min(Math.max(1, limit), 100); // RPC 硬上限 100
  const all: LedgerOnlineOrder[] = [];
  const seen = new Set<string>();
  let since: string | null = null;
  let sinceId: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const batch = await listMerchantOrders({
      merchantId,
      limit: pageSize,
      since,
      sinceId,
    });

    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
    }

    // 未滿一頁 ＝ 已經冇下一頁
    if (batch.length < pageSize) {
      return { rows: all, truncated: false };
    }

    const next = computeSyncCursor(batch);
    // 游標冇推進（理論上唔會）→ 停，避免無限迴圈
    if (!next.since || (next.since === since && next.sinceId === sinceId)) {
      return { rows: all, truncated: false };
    }
    since = next.since;
    sinceId = next.sinceId;
  }

  return { rows: all, truncated: true };
}

export function OnlineOrders({
  embedded = false,
  dateFilter: dateFilterProp,
  onDateFilterChange,
  onFilteredOrdersChange,
}: {
  embedded?: boolean;
  /** 時間篩選：key 字串或 `{ key, custom }`（2026-09-13 加「自訂」）。 */
  dateFilter?: DateFilterArg;
  onDateFilterChange?: (key: LedgerOrderDateFilterKey, custom: CustomDateRange | null) => void;
  /** 當前 tab + 時間範圍篩選後嘅線上單（供 `/orders` 頁匯出 CSV）。 */
  onFilteredOrdersChange?: (orders: LedgerOnlineOrder[]) => void;
}) {
  const merchantId = getLedgerMerchantId();
  const [localSettings, setLocalSettings] = useState(() => loadPosLocalSettings());
  // 自動接單：**Ledger RPC 係真源、全店共用**，POS DB 只做跨機 Realtime 鏡像（docs/92 + 0036）。
  // 唔好再讀 `localSettings.onlineOrderSettings.autoAccept` —— 嗰個已經降級做快取。
  const { autoAccept, setAutoAccept } = useOnlineOrderSettings(merchantId, Boolean(merchantId));
  // 開關店（`merchant_enabled`）：同一個 config、同一次讀取，所以喺同一個 store 度攞。
  const merchantOrderConfig = useMerchantOrderConfig(merchantId, Boolean(merchantId));

  const [activeTab, setActiveTab] = useState<LedgerOrderTab>("all");
  const [internalDateFilter, setInternalDateFilter] = useState<DateFilterArg>("today");
  const dateFilter = dateFilterProp ?? internalDateFilter;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<LedgerOnlineOrder[]>([]);
  /** 分頁抓齊時達到 10 頁安全上限 → 列表可能唔齊，UI 要明確提示（唔可以靜默）。 */
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<Array<{ name: string; qty: number; discountRate?: number; discountAvos?: number }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 2026-09-09：線上單「查看」→ 收據預覽（同線下 settled 單「查看」一致）。
  // 由 resolveLedgerPosOrderForReceipt 將 Ledger 單投影成 PosOrder，餵畀 ReceiptTicketPreview。
  const [receiptPreviewOrder, setReceiptPreviewOrder] = useState<PosOrder | null>(null);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [assigningTableId, setAssigningTableId] = useState<string | null>(null);
  const [balanceFallbackOrderId, setBalanceFallbackOrderId] = useState<string | null>(null);
  const [reprintingOrderId, setReprintingOrderId] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  // 權限：必須有已登入員工 session（client-only，mount 後先讀，保 SSR/CSR 一致）。
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);

  const ordersRef = useRef<LedgerOnlineOrder[]>([]);
  const syncCursorRef = useRef<{ since: string | null; sinceId: string | null }>({ since: null, sinceId: null });
  const hasInitializedSnapshotRef = useRef(false);
  const autoAcceptProcessingRef = useRef<Set<string>>(new Set());
  const autoBridgeRef = useRef<Set<string>>(new Set());
  const embeddedDateFilterRef = useRef(dateFilterSignature(dateFilterProp ?? "today"));

  const tables = useMemo(
    // ⚠️ 必須剝走返結 temp 枱（`isReopenTemp`）：temp 枱只喺「返結單編輯期間」存在，
    // 若職員將線上單派去一張 temp 枱，張枱會喺結帳後消失 → 線上單無處可放、
    // 收銀枱面搵唔到。見 pos/table-scope.ts。
    () =>
      localSettings.floors.flatMap((floor) =>
        floor.tables
          .filter((table) => !isReopenTempTable(table))
          .map((table) => ({ ...table, floorName: floor.name })),
      ),
    [localSettings.floors],
  );

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  /**
   * 「排位」之後張線上單已變成本地堂食單 → 線上訂單列表要**即刻唔再顯示**佢
   * （商家 2026-09-12：「轉成了堂食單…不應該兩邊同時存在」）。
   * 本機單變更由 `pos-orders-changed` 廣播（`saveOrders()` 出），訂閱 tick 重算即時生效。
   */
  const [localOrdersTick, setLocalOrdersTick] = useState(0);
  useEffect(() => {
    function onLocalOrdersChanged() {
      setLocalOrdersTick((count) => count + 1);
    }
    window.addEventListener("pos-orders-changed", onLocalOrdersChanged);
    return () => window.removeEventListener("pos-orders-changed", onLocalOrdersChanged);
  }, []);

  const ledgerOrders = useMemo(
    () => withoutTransferredOrders(orders, localOrdersTick),
    [orders, localOrdersTick],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setAuthSession(loadAuthSession());
  }, []);

  useEffect(() => {
    function onLocalSettingsChanged(event: Event) {
      const detail = (event as CustomEvent<{ localSettings?: ReturnType<typeof loadPosLocalSettings> }>).detail;
      setLocalSettings(detail?.localSettings ?? loadPosLocalSettings());
    }
    window.addEventListener("pos-local-settings-changed", onLocalSettingsChanged as EventListener);
    return () => window.removeEventListener("pos-local-settings-changed", onLocalSettingsChanged as EventListener);
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

  /**
   * 自動補跑廚房單打印（根治「外部接單 → POS 零打印」問題）。
   *
   * 當一張線上單狀態為 accepted 或 preparing（即已被某方接單），
   * 但本機 printJobs 從未有此 orderId 嘅 job（bridge 從未跑過），
   * 就自動補跑 printKitchenForLedgerOrder 產生廚房 PrintJob。
   *
   * idempotent：autoBridgeRef 防同單重複觸發；mergePrintJobs 內部做去重 + tombstone 過濾。
   */
  const ensureKitchenPrintForAccepted = useCallback(
    async (order: LedgerOnlineOrder) => {
      const raw = rawLedgerStatus(order.status);
      if (raw !== "accepted" && raw !== "preparing") return;
      const ledgerId = order.id;
      if (autoBridgeRef.current.has(ledgerId)) return;
      // 檢查本地 printJobs 已有此單嘅 job（bridge 之前跑過）
      const existing = loadPrintJobs();
      const hasJob = existing.some((job) => job.orderId === `ledger-${ledgerId}`);
      if (hasJob) return;
      autoBridgeRef.current.add(ledgerId);
      try {
        const jobs = await printKitchenForLedgerOrder(order);
        // ⚠️ 只喺**真係**產生咗 PrintJob 先提示。以下情況 `jobs.length === 0`：
        //   - 「線上訂單」開關熄咗（2026-09-11 新增，店主刻意唔想廚房重複出紙）；
        //   - 「廚房單」+「飲品標籤單」兩個都熄咗；
        //   - 菜品全部對唔到本地餐牌 / 訂單冇項目。
        // 若照彈「已補印廚房單」，店主會以為印咗，但廚房其實收唔到單 = **假成功**
        // （同 `runAcceptAndBridge` 唔可以假裝成功係同一個原則）。
        if (jobs.length > 0) {
          setToast({ tone: "success", message: `已補印廚房單：${orderCodeLabel(order)}` });
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[online-orders] 補印廚房單失敗 ${ledgerId}:`, err instanceof Error ? err.message : err);
        }
        setToast({ tone: "error", message: `廚房單補印失敗：${orderCodeLabel(order)}` });
      } finally {
        autoBridgeRef.current.delete(ledgerId);
      }
    },
    [],
  );

  const loadOrders = useCallback(
    async (mode: "full" | "incremental" = "full", filter: DateFilterArg) => {
      if (!merchantId) {
        setError("尚未取得商戶資料，請重新登入。");
        setLoading(false);
        return;
      }

      const cursor = syncCursorRef.current;

      // 增量：只拉游標之後嘅變更（單次，唔需要分頁）
      if (mode === "incremental" && cursor.since) {
        const rows = await listMerchantOrders({
          merchantId,
          limit: 50,
          since: cursor.since,
          sinceId: cursor.sinceId,
        });
        applyOrders(mergeLedgerOrders(ordersRef.current, rows));
        return;
      }

      // 全量：自動分頁抓齊（2026-09-13 加「自訂」後必需 —— RPC 冇 start/end，
      // 只有 `p_limit ≤ 100` + `p_since` 游標，長區間會靜靜截斷）。
      // 安全上限 10 頁（1000 張），達上限時出提示，唔會無限循環。
      const { rows, truncated } = await listMerchantOrdersPaged({
        merchantId,
        limit: limitForDateFilter(filter),
        maxPages: 10,
      });
      setTruncated(truncated);
      applyOrders(rows);
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
        await loadOrders("full", dateFilter);
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
    // ⚠️ 刻意**唔**加 `dateFilter` 落依賴：呢個 effect 只負責「入頁首次載入」。
    // 之後嘅 filter 變更由 `changeDateFilter()`（非 embedded）或下面嘅 embedded
    // 同步 effect 處理 —— 若加咗 `dateFilter`，撳一次 chip 會載入兩次（重複打 RPC）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOrders]);

  function changeDateFilter(next: LedgerOrderDateFilterKey, custom: CustomDateRange | null = null) {
    const currentKey = typeof dateFilter === "string" ? dateFilter : dateFilter.key;
    const currentCustom = typeof dateFilter === "string" ? null : dateFilter.custom ?? null;
    const sameCustom =
      (custom?.start ?? null) === (currentCustom?.start ?? null) &&
      (custom?.end ?? null) === (currentCustom?.end ?? null);
    if (next === currentKey && sameCustom) return;

    const selection: DateFilterArg = custom ? { key: next, custom } : next;
    if (onDateFilterChange) {
      onDateFilterChange(next, custom);
    } else {
      setInternalDateFilter(selection);
    }
    setRefreshing(true);
    setError(null);
    void loadOrders("full", selection)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "讀取訂單失敗");
      })
      .finally(() => {
        setRefreshing(false);
      });
  }

  useEffect(() => {
    if (!onDateFilterChange) return;
    // ⚠️ 比較「selection 簽名」而唔係物件 identity：`dateSelection` 喺 orders-hub
    // 每次 render 都係新物件，用 identity 比會無限重載。
    if (embeddedDateFilterRef.current === dateFilterSignature(dateFilter)) return;
    embeddedDateFilterRef.current = dateFilterSignature(dateFilter);
    setRefreshing(true);
    setError(null);
    void loadOrders("full", dateFilter)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "讀取訂單失敗");
      })
      .finally(() => {
        setRefreshing(false);
      });
  }, [dateFilter, loadOrders, onDateFilterChange]);

  const handleInsert = useCallback(
    (order: LedgerOnlineOrder) => {
      const prev = ordersRef.current;
      const existed = prev.some((row) => row.id === order.id);
      applyOrders(mergeLedgerOrders(prev, [order]));

      if (hasInitializedSnapshotRef.current && !existed) {
        const isDelivery = order.fulfillmentType === "merchant_delivery";
        playSound(isDelivery ? "new_delivery" : "new_order");
      }
      hasInitializedSnapshotRef.current = true;

      // 新單 insert 時若已 accepted/preparing（被外部接單）→ 自動補印廚房單
      void ensureKitchenPrintForAccepted(order);
    },
    [applyOrders, playSound, ensureKitchenPrintForAccepted],
  );

  const handleUpdate = useCallback(
    (order: LedgerOnlineOrder) => {
      const prev = ordersRef.current;
      const previous = prev.find((row) => row.id === order.id);
      applyOrders(mergeLedgerOrders(prev, [order]));

      // 客人取消／改單申請：status 唔會變，只係 `change_request_type` 由 null 變成
      // 'cancel' / 'modify'（含 auto_accept 自動接單後嘅申請，全部行呢條路）。
      const prevRequestType = String(previous?.changeRequestType ?? "").toLowerCase();
      const nextRequestType = String(order.changeRequestType ?? "").toLowerCase();

      if (hasInitializedSnapshotRef.current) {
        if (prevRequestType !== "cancel" && nextRequestType === "cancel") {
          playSound("cancel_request");
          setToast({ tone: "error", message: `客人申請取消：${orderCodeLabel(order)}` });
        }
        if (prevRequestType !== "modify" && nextRequestType === "modify") {
          playSound("modify_request");
          setToast({ tone: "error", message: `客人申請修改：${orderCodeLabel(order)}` });
        }
        // 拒絕／同意／客人撤回 → 申請欄位清空；若唔係因為取消成功，收起橫幅繼續做餐
        if (prevRequestType && !nextRequestType && normalizeLedgerStatus(order.status) !== "cancelled") {
          setToast({ tone: "success", message: "客人申請已處理，訂單繼續。" });
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

      // 狀態更新至 accepted/preparing（被外部接單）→ 自動補印廚房單
      void ensureKitchenPrintForAccepted(order);
    },
    [applyOrders, playSound, ensureKitchenPrintForAccepted],
  );

  useLedgerOrdersRealtime(merchantId, Boolean(merchantId), {
    onInsert: handleInsert,
    onUpdate: handleUpdate,
    onResubscribed: () => {
      void loadOrders("incremental", dateFilter).catch((err) => {
        setError(err instanceof Error ? err.message : "增量同步失敗");
      });
    },
  });

  useEffect(() => {
    if (!loading) hasInitializedSnapshotRef.current = true;
  }, [loading]);

  // 初次載入 / resubscribe 後 batch 同步嘅已接單單也補印廚房單
  // （loadOrders 唔經 handleInsert/handleUpdate，要喺度掃一次）
  useEffect(() => {
    if (loading) return;
    for (const order of ledgerOrders) {
      const raw = rawLedgerStatus(order.status);
      if (raw === "accepted" || raw === "preparing") {
        void ensureKitchenPrintForAccepted(order);
      }
    }
  }, [ledgerOrders, loading, ensureKitchenPrintForAccepted]);

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
            setToast({ tone: "error", message: result.message });
            return false;
          }
          setToast({ tone: "error", message: result.message });
          return false;
        }

        let kitchenJobCount = 0;
        try {
          const detail = await getOrderDetail(order.id);
          // 快餐模式（`operatingMode = quick`）：呢批線上單一律當**本地快餐 counter 單**
          // 採納（出餐口自取、唔排位），令快餐 strip 嘅「可取餐 → 完成」管得到
          // —— 同 POS 主介面（quick-online-orders-panel）同一口徑，唔會因為收銀
          // 喺「訂單頁」接單而漏咗採納。
          const bridged =
            loadOperatingMode() === "quick"
              ? await adoptLedgerOrderAsQuickCounter({ ledgerOrder: order, detail })
              : await bridgeLedgerOrderToPos({
                  ledgerOrder: order,
                  tableId: options?.tableId,
                  tableName: options?.tableName,
                  detail,
                });
          kitchenJobCount = bridged.printJobs.length;
        } catch (bridgeErr) {
          // 唔再假裝成功：舊寫法 return true → auto-accept effect 彈「已自動接單」success toast，
          // 但廚房單其實已丟。改為 return false + error toast，令問題可見且唔誤導。
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[online-orders] 接單 ${order.id} 成功，但廚房單建立失敗：`,
              bridgeErr instanceof Error ? bridgeErr.message : bridgeErr,
            );
          }
          const errMsg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
          setToast({
            tone: "error",
            message: `已接單，但廚房單建立失敗：${errMsg}`,
          });
          // 仍標 accepted（DB 已接），但 return false 令上層唔彈 success toast
          applyOrders(
            mergeLedgerOrders(ordersRef.current, [{ ...order, status: "accepted", updatedAt: new Date().toISOString() }]),
          );
          return false;
        }

        applyOrders(
          mergeLedgerOrders(ordersRef.current, [{ ...order, status: "accepted", updatedAt: new Date().toISOString() }]),
        );
        if (!options?.silent) {
          setToast({
            tone: "success",
            message: options?.tableId
              ? `已接單並安排到 ${options.tableName}。`
              : kitchenJobCount > 0
                ? "已接單並已送廚。"
                : // 冇出廚房單係店主設定（「線上訂單」/「廚房單」開關熄咗）或菜品對唔到餐牌。
                  // 唔可以照講「已送廚」——廚房收唔到單，講咗就係假成功。
                  "已接單（按打印設定未出廚房單）。",
          });
        }
        return true;
      } finally {
        setActionLoadingKey(null);
      }
    },
    [applyOrders],
  );

  useEffect(() => {
    if (!autoAccept || loading) return;

    const pending = ledgerOrders.filter(
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
            setToast({ tone: "success", message: `已自動接單：${orderCodeLabel(order)}` });
          }
        })
        .finally(() => {
          autoAcceptProcessingRef.current.delete(order.id);
        });
    }
  }, [autoAccept, ledgerOrders, loading, runAcceptAndBridge]);

  const filteredOrders = useMemo(() => {
    // ⚠️ 用 `ledgerOrders`：已「排位」轉成本地堂食單嘅唔應該再喺呢邊出現。
    const byDate = ledgerOrders.filter((order) => orderMatchesDateFilter(order, dateFilter));
    if (activeTab === "all") return byDate;
    return byDate.filter((order) => order.tabType === activeTab);
  }, [activeTab, dateFilter, ledgerOrders]);

  // 匯出 CSV（2026-09-13）：把「當前 tab + 時間範圍」篩選後嘅線上單上報畀 `/orders` 頁，
  // 由頁面統一決定要唔要落檔（避免兩張表各自砌一份匯出邏輯）。
  // ⚠️ 用 ref 存 callback，避免因為 inline 函式 identity 每次 render 都變而無限 loop。
  const onFilteredOrdersChangeRef = useRef(onFilteredOrdersChange);
  useEffect(() => {
    onFilteredOrdersChangeRef.current = onFilteredOrdersChange;
  }, [onFilteredOrdersChange]);
  useEffect(() => {
    onFilteredOrdersChangeRef.current?.(filteredOrders);
  }, [filteredOrders]);
  const stats = useMemo(() => {
    const pending = filteredOrders.filter((order) => rawLedgerStatus(order.status) === "pending").length;
    return { total: filteredOrders.length, pending };
  }, [filteredOrders]);

  async function manualRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await loadOrders(syncCursorRef.current.since ? "incremental" : "full", dateFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失敗");
    } finally {
      setRefreshing(false);
    }
  }

  async function openOrderDetail(orderId: string) {
    setViewingOrderId(orderId);
    setDetailItems(null);
    setDetailLoading(true);
    setReceiptPreviewOrder(null);
    try {
      const detail = await getOrderDetail(orderId);
      setDetailItems(
        detail.items.map((item) => ({
          name: item.name,
          qty: item.qty,
          discountRate: item.discountRate,
          discountAvos: item.discountAvos,
        })),
      );
      // 投影成 PosOrder 供收據預覽（同線下 settled 單「查看」用同一個 ReceiptTicketPreview）
      const viewing = orders.find((o) => o.id === orderId);
      if (viewing) {
        try {
          const posOrder = await resolveLedgerPosOrderForReceipt(viewing, detail);
          setReceiptPreviewOrder(posOrder);
        } catch {
          // 投影失敗唔影響明細顯示；收據預覽區塊留空
          setReceiptPreviewOrder(null);
        }
      }
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "讀取明細失敗" });
    } finally {
      setDetailLoading(false);
    }
  }

  /**
   * 呢啲先有收據可補打（對齊線下「已結帳／已付款」口徑）：
   * 線上單必須已經收款；未付款（到店付款）／已取消未收款都冇原始單據。
   */
  function hasReceivableReceipt(order: LedgerOnlineOrder | null): boolean {
    if (!order) return false;
    if (order.paymentStatus !== "paid") return false;
    return normalizeLedgerStatus(order.status) !== "cancelled";
  }

  /** 補打帳單（收據）權限：已登入員工 + 未被後台撤銷權位（缺省 = 有）。 */
  function canReprintReceipt(): boolean {
    if (!authSession) return false;
    return authSession.permissions.reprintReceipt !== false;
  }

  /**
   * 補打帳單（收據）：同線下訂單嗰粒掣完全一致 —— 行 `buildReceiptPrintJobs`
   * （同一個收據模板槽位 / 同一批收據打印機 / 同一套內容），資料由 Ledger 重建。
   * 手動語義：唔受「自動打印」開關影響，亦唔做 once 去重（撳幾次印幾次）。
   */
  async function reprintBillForOnlineOrder(order: LedgerOnlineOrder) {
    if (!canReprintReceipt()) {
      setToast({ tone: "error", message: "目前帳號沒有補打帳單權限，請使用店長帳號操作。" });
      return;
    }
    if (reprintingOrderId) return;
    setReprintingOrderId(order.id);
    try {
      const count = await reprintReceiptForLedgerOrder(order);
      if (count > 0) {
        setToast({ tone: "success", message: `已加入補打帳單打印隊列：${orderCodeLabel(order)}` });
        return;
      }
      setToast({ tone: "error", message: describeNoReceiptPrinterError() });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "補打帳單失敗" });
    } finally {
      setReprintingOrderId(null);
    }
  }

  function startAccept(order: LedgerOnlineOrder) {
    // 🔴 2026-09-12 商家定案：接單**唔再**被「安排桌台」攔住。
    // 堂食線上單接完之後只係「待安排座位」，收銀可以隨時按「排位」補上
    // （自動接單情境亦一樣 → 滿足「自動接單仍會接單並打印，狀態顯示待安排座位」）。
    void runAcceptAndBridge(order);
  }

  /**
   * 「排位」：將線上單 assign 到桌台（獨立於接單）。
   *
   * 舊寫法 `assignDineInTable = runAcceptAndBridge(order, {tableId})` 有兩個問題：
   *   ① 綁死接單 —— 已接單／自動接單之後就冇得排位；
   *   ② 枱號只寫入 in-memory 投影，reload 即失、桌台總覽永遠唔會見到。
   * 新做法走 `assignLedgerOrderToTable()`：**upsert 本地單**（`ledger-<id>`，
   * 帶 `prepaidAmount`）→ 桌台佔用 / 店內線下訂單 / 報表全部即刻生效。
   */
  async function assignDineInTable(order: LedgerOnlineOrder, tableId: string, tableName: string) {
    setAssigningTableId(tableId);
    setActionLoadingKey(`${order.id}:assign`);
    try {
      const detail = await getOrderDetail(order.id);
      const result = await assignLedgerOrderToTable({ ledgerOrder: order, tableId, tableName, detail });
      setToast({
        tone: "success",
        message: result.created
          ? `已排位 ${tableName}：${orderCodeLabel(order)}`
          : `已改枱到 ${tableName}：${orderCodeLabel(order)}`,
      });
      setAssigningOrderId(null);
      setViewingOrderId(null);
      applyOrders(mergeLedgerOrders(ordersRef.current, [{ ...order }]));
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "排位失敗" });
    } finally {
      setAssigningTableId(null);
      setActionLoadingKey(null);
    }
  }

  async function acceptInStoreFallback(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:in-store-fallback`);
    try {
      const result = await acceptLedgerOrderInStore(order);
      if (!result.ok) {
        setToast({ tone: "error", message: result.message });
        return;
      }
      setBalanceFallbackOrderId(null);
      const detail = await getOrderDetail(order.id);
      await bridgeLedgerOrderToPos({ ledgerOrder: order, detail });
      setToast({ tone: "success", message: "已改為到店付款並接單。" });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "接單失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function markPaidInStore(order: LedgerOnlineOrder) {
    setActionLoadingKey(`${order.id}:paid`);
    try {
      await setOrderPaidInStore(order.id);
      await printReceiptForLedgerOrderOnce(order.id, { paymentMethod: "到店付款" });
      setToast({ tone: "success", message: "已標記到店付款。" });
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "標記失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function pushStatus(order: LedgerOnlineOrder, nextStatus: string, successMessage: string) {
    setActionLoadingKey(`${order.id}:${nextStatus}`);
    try {
      // 到店付款單：完成前先收錢，避免「已完成但未付、唔入帳」
      const justPaid =
        nextStatus === "completed"
          ? await markPaidIfInStoreUnpaid(order.id, order.paymentMode, order.paymentStatus)
          : false;
      await updateLedgerOrderStatus(order.id, nextStatus);
      if (nextStatus === "cancelled") {
        printVoidForLedgerOrderOnce(order.id);
      }
      if (nextStatus === "completed" && (justPaid || order.paymentStatus === "paid")) {
        await printReceiptForLedgerOrderOnce(order.id, {
          paymentMethod: justPaid ? "到店付款" : paymentModeLabel(order.paymentMode) || "線上已支付",
        });
      }
      setToast({ tone: "success", message: successMessage });
      if (nextStatus === "completed") setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "更新狀態失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  async function cancelOrder(order: LedgerOnlineOrder) {
    const ok = window.confirm("確定要取消這張訂單？");
    if (!ok) return;
    await pushStatus(order, "cancelled", "已取消訂單。");
    setViewingOrderId(null);
  }

  async function resolveChangeRequest(order: LedgerOnlineOrder, action: "approve" | "reject") {
    const isCancel = String(order.changeRequestType ?? "").toLowerCase() === "cancel";
    const confirmOk = window.confirm(
      action === "approve"
        ? isCancel
          ? "確定同意客人取消這張訂單？取消後不可復原。"
          : "確定同意客人的修改申請？套用後以新明細／新金額為準。"
        : "確定拒絕客人的申請？訂單會繼續處理。",
    );
    if (!confirmOk) return;
    setActionLoadingKey(`${order.id}:${action === "approve" ? "approve_change" : "reject_change"}`);
    try {
      // ⚠️ 必須打 merchant_resolve_order_change（審核客人申請）。
      // 取消唔可以用 update_order_status(..., 'cancelled') —— 嗰個係商戶自己取消，唔會沖正。
      const result = await resolveOrderChange(order.id, action);
      const nextStatus = result?.status ?? order.status;
      if (action === "approve" && isCancel) {
        // POS 直連 RPC 唔會觸發 Ledger 作廢單 MQTT → 同意取消後自行 LAN 印作廢單
        //（realtime echo 嗰邊 printVoidForLedgerOrderOnce 有冪等保護，唔會重印）。
        printVoidForLedgerOrderOnce(order.id);
      }
      if (action === "approve" && !isCancel) {
        // 改單：套用新明細後補印廚房單（舊廚房單唔會自動更正）
        try {
          const detail = await getOrderDetail(order.id);
          await printKitchenForLedgerOrder(order, detail);
        } catch (printErr) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[online-orders] 改單後補印廚房單失敗:", printErr);
          }
        }
      }
      applyOrders(
        mergeLedgerOrders(ordersRef.current, [
          {
            ...order,
            changeRequestType: undefined,
            status: nextStatus,
            updatedAt: new Date().toISOString(),
          },
        ]),
      );
      setToast({
        tone: "success",
        message:
          action === "approve"
            ? isCancel
              ? "已同意客人取消，訂單已取消。"
              : "已同意客人修改，已套用新明細。"
            : "已拒絕申請，訂單繼續處理。",
      });
      setViewingOrderId(null);
    } catch (err) {
      setToast({ tone: "error", message: err instanceof Error ? err.message : "處理客人申請失敗" });
    } finally {
      setActionLoadingKey(null);
    }
  }

  function renderOrderActions(order: LedgerOnlineOrder) {
    const raw = rawLedgerStatus(order.status);
    const orderLoading = actionLoadingKey?.startsWith(`${order.id}:`) ?? false;
    // 有待確認申請（取消／改單）時，先隱藏一般接單／推進狀態按鈕，避免同審核搶操作。
    const hasRequest = hasPendingChangeRequest(order);
    // 按鈕規格與「店內線下訂單」卡片一致：rounded-xl px-3 py-2 text-xs（卡片同彈窗共用）
    const btn = "rounded-xl px-3 py-2 text-xs font-semibold";

    return (
      <>
        {/* 「排位」（2026-09-12 商家需求）：線上堂食單 assign 到桌台。
            獨立於接單 —— 未接單、已接單、自動接單之後都可以按。 */}
        {!hasRequest && isOnlineDineIn(order) ? (
          <button
            className={`${btn} bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => setAssigningOrderId(order.id)}
            type="button"
          >
            {onlineTableAssignLabel(order)}
          </button>
        ) : null}
        {!hasRequest && raw === "pending" ? (
          <>
            <button
              className={`${btn} bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-60`}
              disabled={orderLoading}
              onClick={() => startAccept(order)}
              type="button"
            >
              {orderLoading ? "提交中…" : "接單"}
            </button>
            <button
              className={`${btn} bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60`}
              disabled={orderLoading}
              onClick={() => void cancelOrder(order)}
              type="button"
            >
              拒單
            </button>
          </>
        ) : null}
        {hasRequest ? (
          <>
            <span className={`${btn} bg-rose-50 text-rose-700 ring-1 ring-rose-200`}>
              {changeRequestLabel(order)}
            </span>
            <button
              className={`${btn} bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60`}
              disabled={orderLoading}
              onClick={() => void resolveChangeRequest(order, "approve")}
              type="button"
            >
              {orderLoading ? "處理中…" : String(order.changeRequestType).toLowerCase() === "modify" ? "同意修改" : "同意取消"}
            </button>
            <button
              className={`${btn} bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60`}
              disabled={orderLoading}
              onClick={() => void resolveChangeRequest(order, "reject")}
              type="button"
            >
              拒絕
            </button>
          </>
        ) : null}
        {!hasRequest && raw === "accepted" ? (
          <button
            className={`${btn} bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => void pushStatus(order, "preparing", "已開始製作。")}
            type="button"
          >
            開始製作
          </button>
        ) : null}
        {!hasRequest && raw === "preparing" ? (
          <button
            className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => void pushStatus(order, "ready", order.tabType === "pickup" ? "已標記待取餐。" : "已標記待交付。")}
            type="button"
          >
            {order.tabType === "pickup" ? "待取餐" : "待交付"}
          </button>
        ) : null}
        {!hasRequest && raw === "ready" && order.fulfillmentType === "merchant_delivery" ? (
          <button
            className={`${btn} bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => void pushStatus(order, "delivering", "已標記配送中。")}
            type="button"
          >
            配送中
          </button>
        ) : null}
        {!hasRequest && (raw === "ready" || raw === "delivering") && (
          <button
            className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => void pushStatus(order, "completed", "訂單已完成。")}
            type="button"
          >
            完成
          </button>
        )}
        {!hasRequest && order.paymentMode === "in_store" && order.paymentStatus === "unpaid" && raw !== "pending" && raw !== "cancelled" && raw !== "completed" ? (
          <button
            className={`${btn} bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-60`}
            disabled={orderLoading}
            onClick={() => void markPaidInStore(order)}
            type="button"
          >
            標記已收款
          </button>
        ) : null}
      </>
    );
  }

  const viewingOrder = viewingOrderId ? orders.find((item) => item.id === viewingOrderId) ?? null : null;
  const balanceFallbackOrder = balanceFallbackOrderId
    ? orders.find((item) => item.id === balanceFallbackOrderId) ?? null
    : null;
  const assigningOrder = assigningOrderId ? orders.find((item) => item.id === assigningOrderId) ?? null : null;

  /**
   * 排位彈窗「唔可以揀」嘅枱：本機進行中（draft / 製作中 / 已收款未完成 / 返結）而有真枱號嘅單。
   * 剔除目標單自己，令「改枱」時原本張枱仍然可揀。
   */
  const occupiedTableIds = useMemo(() => {
    if (!assigningOrder) return [] as string[];
    const openStatuses = new Set(["draft", "sent_to_kitchen", "paid", "reopened"]);
    return loadLocalOrders()
      .filter(
        (row) =>
          row.id !== assigningOrder.id &&
          !!row.tableId &&
          row.tableId !== "counter" &&
          openStatuses.has(row.status),
      )
      .map((row) => row.tableId as string);
  }, [assigningOrder]);

  const panel = (
    <>
      <div className={`shrink-0 border-b border-slate-200 bg-white px-4 ${embedded ? "py-3" : "py-4"}`}>
        {/*
          2026-09-12 商家需求（純 UI）：filter chips 併入標題同一排，慳返一行高度畀下面嘅訂單列表。
          靠左排；唔夠位時 chips 自己 flex-wrap 掉第二行（唔會爆版）。
          三欄：標題塊（shrink-0）／chips（flex-1 min-w-0）／右側控件（ml-auto shrink-0）。
          ⚠️ chips 欄一定要 `min-w-0`，否則 flex 子項最小闊度＝內容闊度 → 窄屏撐爆外層。
          ⚠️ 外層唔可以加 `justify-between`：chips 欄靠 `flex-1` 吃滿中間，右欄自然貼右。
        */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 shrink-0">
            <div className={`font-semibold text-slate-900 ${embedded ? "text-sm" : "text-lg"}`}>
              {embedded ? "線上訂單" : "會員通線上訂單"}
            </div>
            <div className="mt-1 text-xs text-slate-500 sm:text-sm">
              {dateFilterLabel(dateFilter)} · {tabLabel(activeTab)} · 共 {stats.total} 張 · 新單 {stats.pending} 張
            </div>
            {truncated ? (
              <div className="mt-1 text-xs font-medium text-amber-700">
                ⚠️ 訂單較多，只載入最近 1000 張；如需完整資料請縮窄日期範圍。
              </div>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  tab.key === activeTab ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                }`}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
            {!embedded ? (
              <DateRangeFilterChips
                options={LEDGER_ORDER_DATE_FILTERS}
                value={typeof dateFilter === "string" ? dateFilter : dateFilter.key}
                custom={typeof dateFilter === "string" ? null : dateFilter.custom ?? null}
                onChange={changeDateFilter}
              />
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {/*
              開關店（`merchant_enabled`）：全店線上單總掣。關咗之後**唔會**順手寫
              `auto_accept=false`，只係把下面嗰粒掣灰掉（開返店保留原設定）。
            */}
            <MerchantOpenPill
              busy={merchantOrderConfig.loading || merchantOrderConfig.saving !== "none"}
              busyHint={
                merchantOrderConfig.loading
                  ? "（讀取中…）"
                  : merchantOrderConfig.saving === "merchant"
                    ? "（切換中…）"
                    : undefined
              }
              disabled={!merchantOrderConfig.available || !merchantId}
              error={merchantOrderConfig.saving === "none" ? merchantOrderConfig.error : null}
              merchantEnabled={merchantOrderConfig.merchantEnabled}
              onChange={(next) => void merchantOrderConfig.setMerchantEnabled(next)}
              unknownHint="未讀到 Ledger 接單狀態，請去「設置 › 線上接單」重新整理。"
              variant="contained"
            />
            <AutoAcceptPill
              busy={merchantOrderConfig.loading || merchantOrderConfig.saving !== "none"}
              disabled={merchantOrderConfig.merchantEnabled !== true}
              enabled={autoAccept}
              onChange={(next) => void setAutoAccept(next)}
              variant="contained"
            />
            <button
              className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              disabled={refreshing || loading}
              onClick={() => void manualRefresh()}
              type="button"
            >
              {refreshing ? "刷新中…" : "手動刷新"}
            </button>
          </div>
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto ${embedded ? "p-3" : "p-4"}`}>
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        ) : null}

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">正在載入…</div>
        ) : null}

        {!loading && filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            {dateFilter === "today" ? "今天暫無訂單" : `${dateFilterLabel(dateFilter)}暫無訂單`}
          </div>
        ) : null}

        {/*
          列表（2026-09-10）：每張單一行。欄位同原本卡片完全一致（單號／類型·客戶／時間／
          菜品／金額／狀態／支付／操作），操作統一釘最右。
          響應式（2026-09-10 修）：欄寬百分比化 + `table-fixed`，表格永遠等於容器闊度；
          原本 `overflow-hidden` + `min-w-[1080px]` 會剪走最右「操作」欄（iPad 只見半個掣）。
        */}
        {filteredOrders.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
            <thead>
              <tr>
                <th className={`${TH_CELL} w-[11%]`}>訂單號</th>
                <th className={`${TH_CELL} w-[11%]`}>類型 · 客戶</th>
                <th className={`${TH_CELL} w-[11%]`}>時間</th>
                <th className={TH_CELL}>菜品</th>
                <th className={`${TH_CELL} w-[12%] text-right`}>金額</th>
                <th className={`${TH_CELL} w-[10%]`}>狀態</th>
                <th className={`${TH_CELL} w-[15%]`}>支付</th>
                <th className={`${TH_CELL} w-[18%] text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order) => {
                const statusBadge = getLedgerStatusBadge(order);
                const externalAccepted = rawLedgerStatus(order.status) === "accepted";
                return (
                  <tr key={order.id} className="border-t border-slate-100 even:bg-slate-50/60">
                    <td className={TD_CELL}>
                      <div className="truncate text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>
                    </td>
                    <td className={TD_CELL}>
                      <div className="truncate text-xs text-slate-500">
                        {tabLabel(order.tabType)} · 客戶：{order.customerName ?? "--"}
                      </div>
                    </td>
                    <td className={TD_CELL}>
                      <div className="text-xs tabular-nums text-slate-400">
                        {order.createdAt ? formatMacauDateTime(order.createdAt) : "--"}
                      </div>
                    </td>
                    <td className={TD_CELL}>
                      <div className="truncate text-xs text-slate-500">
                        {order.itemSummary ?? "--"}
                        {order.itemCount && order.itemCount > 1 ? ` 等 ${order.itemCount} 項` : ""}
                      </div>
                    </td>
                    <td className={`${TD_CELL} text-right`}>
                      <div className="text-sm font-semibold tabular-nums text-slate-900">
                        {formatMoney(order.total)}
                      </div>
                      {order.discountAmount && order.discountAmount > 0 ? (
                        <div className="mt-0.5 text-[11px] tabular-nums text-amber-700">
                          已優惠 -{formatMoney(order.discountAmount)}
                          {order.subtotalBeforeDiscount != null ? (
                            <span className="ml-1 text-slate-400 line-through">
                              原 {formatMoney(order.subtotalBeforeDiscount)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className={TD_CELL}>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadge.bgClass} ${statusBadge.textClass}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${statusBadge.dotClass}`} />
                        {statusBadge.label}
                      </span>
                      {externalAccepted ? (
                        <div className="mt-1 text-[11px] text-amber-600">已由外部接單</div>
                      ) : null}
                    </td>
                    <td className={TD_CELL}>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          order.paymentStatus === "paid"
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                            : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                        }`}
                      >
                        {order.paymentStatus === "paid" ? "已支付" : "未支付"}
                        {order.paymentMode ? `（${paymentModeLabel(order.paymentMode)}）` : ""}
                      </span>
                    </td>
                    <td className={`${TD_CELL} text-right`}>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          className="whitespace-nowrap rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                          onClick={() => void openOrderDetail(order.id)}
                          type="button"
                        >
                          查看
                        </button>
                        {renderOrderActions(order)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ) : null}
      </div>
    </>
  );

  const modals = (
    <>
      {assigningOrder ? (
        <TableAssignModal
          busyTableId={assigningTableId}
          description={
            onlineTableBadge(assigningOrder, { quickMode: false }).label === "待安排座位"
              ? "選擇桌台後會將線上單轉到該枱（建立本地堂食單）並補印一張帶枱名嘅廚房單。"
              : `現時：${onlineTableBadge(assigningOrder, { quickMode: false }).label}。選擇新桌台即改枱。`
          }
          occupiedTableIds={occupiedTableIds}
          onClose={() => setAssigningOrderId(null)}
          onSelect={(table) => void assignDineInTable(assigningOrder, table.id, table.name)}
          tables={tables}
          title={`${onlineTableAssignLabel(assigningOrder)} · ${orderCodeLabel(assigningOrder)}`}
        />
      ) : null}

      {balanceFallbackOrder ? (
        <ResponsiveModal
          actions={
            <>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setBalanceFallbackOrderId(null)}
                type="button"
              >
                稍後
              </button>
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
                disabled={Boolean(actionLoadingKey?.startsWith(`${balanceFallbackOrder.id}:`))}
                onClick={() => void acceptInStoreFallback(balanceFallbackOrder)}
                type="button"
              >
                改到店付款接單
              </button>
            </>
          }
          description="此單為餘額扣點，會員餘額不足。可改為到店付款後接單。"
          onClose={() => setBalanceFallbackOrderId(null)}
          title="餘額不足"
          widthClassName="max-w-md"
        >
          <div className="text-sm text-slate-700">{orderCodeLabel(balanceFallbackOrder)} · {formatMoney(balanceFallbackOrder.total)}</div>
        </ResponsiveModal>
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
        <ResponsiveModal
          actions={renderOrderActions(viewingOrder)}
          description={`${orderCodeLabel(viewingOrder)} · ${tabLabel(viewingOrder.tabType)}`}
          onClose={() => {
            setViewingOrderId(null);
            setDetailItems(null);
            setReceiptPreviewOrder(null);
          }}
          title="訂單詳情"
          widthClassName="max-w-2xl"
        >
          {/* 收據預覽：同線下 settled 單「查看」一致，用同一個 ReceiptTicketPreview。
              render 出嘅欄位/格式/排版 == 收銀機實際打印出嚟嘅收據。 */}
          {receiptPreviewOrder ? (
            <div className="mb-4">
              <ReceiptTicketPreview order={receiptPreviewOrder} />
            </div>
          ) : detailLoading ? (
            <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              正在載入收據…
            </div>
          ) : null}

          <div className="grid gap-2 text-sm text-slate-700">
            <div>客戶：{viewingOrder.customerName ?? "--"}</div>
            <div>電話：{viewingOrder.phone ?? "--"}</div>
            {viewingOrder.deliveryAddress ? <div>地址：{viewingOrder.deliveryAddress}</div> : null}
            {viewingOrder.note ? <div>備註：{viewingOrder.note}</div> : null}
            <div>
              支付：{paymentModeLabel(viewingOrder.paymentMode)} ·{" "}
              {viewingOrder.paymentStatus === "paid" ? "已支付" : "未支付"}
            </div>
            {/* 派生標籤（唔新增 status 值）：付款維度「已結帳」＋枱位維度「待安排座位」。 */}
            {isOnlineDineIn(viewingOrder) ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {(() => {
                  const badges = [
                    onlinePaymentBadge(viewingOrder),
                    onlineTableBadge(viewingOrder, { quickMode: false }),
                  ];
                  return badges.map((badge) => (
                    <span
                      key={badge.label}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.bgClass} ${badge.textClass}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${badge.dotClass}`} />
                      {badge.label}
                    </span>
                  ));
                })()}
              </div>
            ) : null}
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">菜品明細</div>
            <div className="mt-3 grid gap-2">
              {detailLoading ? <div className="text-sm text-slate-500">正在載入明細…</div> : null}
              {!detailLoading && detailItems?.length
                ? detailItems.map((item) => {
                    const itemHasDiscount =
                      item.discountRate != null ||
                      (item.discountAvos != null && item.discountAvos > 0);
                    return (
                      <div
                        key={`${item.name}-${item.qty}`}
                        className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-slate-700"
                      >
                        <span>
                          {item.name}
                          {itemHasDiscount ? (
                            <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              {item.discountRate != null ? `${item.discountRate}% off` : "已優惠"}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-semibold tabular-nums">x{item.qty}</span>
                      </div>
                    );
                  })
                : null}
              {!detailLoading && !detailItems?.length ? (
                <div className="text-sm text-slate-500">{viewingOrder.itemSummary ?? "--"}</div>
              ) : null}
            </div>
            {/* 折扣分項（用戶要求所有訂單明細位都要見到「折扣多少、優惠多少」） */}
            {viewingOrder.discountAmount && viewingOrder.discountAmount > 0 ? (
              <div className="mt-3 flex items-center justify-between text-sm text-emerald-700">
                <span className="font-semibold">折扣</span>
                <span className="font-semibold tabular-nums">-{formatMoney(viewingOrder.discountAmount)}</span>
              </div>
            ) : null}
            <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
              <span>總計</span>
              <span className="text-base font-semibold text-slate-900">{formatMoney(viewingOrder.total)}</span>
            </div>
          </div>

          {/* 補打帳單（收據）：位置／樣式／互動對齊線下訂單「查看」彈窗嗰粒掣
              （明細右下角、slate-900 實心、入隊後出 toast）。
              只喺「已收款」+「有權限」時先顯示。 */}
          {hasReceivableReceipt(viewingOrder) && canReprintReceipt() ? (
            <div className="mt-1 flex justify-end">
              <button
                className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                disabled={reprintingOrderId === viewingOrder.id}
                onClick={() => void reprintBillForOnlineOrder(viewingOrder)}
                type="button"
              >
                {reprintingOrderId === viewingOrder.id ? "補打中…" : "補打帳單（收據）"}
              </button>
            </div>
          ) : null}
        </ResponsiveModal>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {panel}
        {modals}
      </div>
    );
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          {panel}
        </main>
      </div>
      {modals}
    </div>
  );
}
