"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";
import { useRouter } from "next/navigation";

import { ResponsiveModal } from "@/components/responsive-modal";
import { ReceiptTicketPreview } from "@/components/receipt-ticket-preview";
import { SelfOrderActionButtons } from "@/components/self-order-action-buttons";
import { SelfOrderAutoAcceptToggle } from "@/components/self-order-auto-accept-toggle";
import { OrderSourceBadge } from "@/components/order-source-badge";
import { OrderDiscountRow } from "@/components/order-discount-display";
import { buildOrderDetailNotes } from "@/lib/pos/order-notes";
import {
  dateFilterLabel,
  orderMatchesDateFilter,
  type DateFilterArg,
} from "@/lib/ledger/order-date-filter";
import {
  isLocalOrTransferredDineIn,
  isQuickCounterOrder,
  isQuickOrderReady,
  getPaymentBadge,
  LocalOrderPanelTab,
  matchesLocalOrderPanelTab,
  getOrderStatusBadge,
  mergeOrderLists,
  filterResurrectedOrders,
} from "@/lib/pos-order-filters";
import {
  markQuickOrderCompletedInStore,
  quickCompleteLabel,
  updateQuickFulfillmentInStore,
} from "@/lib/quick-order-fulfillment";
import { isSelfOrder } from "@/lib/pos/order-source";
import { confirmSelfOrder, isReopenable, cancelLocalOrder, rejectSelfOrder, reopenPosOrder } from "@/lib/pos-orders";
import { describeNoReceiptPrinterError, reprintReceiptForOrder } from "@/lib/print-jobs";
import {
  addDeletedOrderIds,
  loadAuthSession,
  loadBootstrapCache,
  loadDeletedOrderIds,
  loadOrders,
  loadPosLocalSettings,
  loadQueue,
  saveOrders,
  saveQueue,
} from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { orderItemDiscountTotal } from "@/lib/pos/discount";
import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import { POS_SYNC_QUEUE_CHANGED_EVENT } from "@/lib/pos/sync-flush";
import { posDeviceAuthHeaders, refreshPosDeviceTokenIfNeeded } from "@/lib/pos/pos-sync-auth";

const STATUS_TABS: Array<{ key: LocalOrderPanelTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "preparing", label: "製作中" },
  { key: "ready", label: "待取餐" },
  { key: "settled", label: "已完成" },
  { key: "reopened", label: "已返結" },
  { key: "cancelled", label: "已取消" },
];

function orderMatchesLocalDateFilter(order: PosOrder, filter: DateFilterArg): boolean {
  const pseudo = { createdAt: order.createdAt, updatedAt: order.updatedAt };
  return orderMatchesDateFilter(pseudo, filter);
}

// 訂單列表（2026-09-10）：表頭 / 儲存格共用樣式。表頭 sticky，窄屏由外層 overflow 橫向滾動。
const TH_CELL = "sticky top-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500";
const TD_CELL = "px-3 py-2 align-middle";

/**
 * 快餐 counter 單嘅出餐動作（可取餐 → 完成），列表一行同「查看」彈窗共用同一個邏輯，
 * 保證兩個介面永遠同步（用戶 2026-09-12 要求）。
 *
 * 🔴 出餐階段一律讀 `isQuickOrderReady()`（fulfillmentStatus === "ready"），
 * **唔可以**再夾 `status === "paid"` —— 收銀台快餐單／自助單都可以「未收款先出餐」，
 * 舊寫法會令呢類單撳完「可取餐」之後仍然冇變（ready 已寫入，但 UI 唔認）。
 */
function QuickOrderActions({
  order,
  onChanged,
  variant = "row",
}: {
  order: PosOrder;
  /** 動作成功後通知父層（刷列表 / 出 toast / 需要時關彈窗）。 */
  onChanged: (message: string, options?: { closeModal?: boolean }) => void;
  /** `row` = 列表一行嘅細掣；`modal` = 彈窗底部（尺寸同點餐頁彈窗一致）。 */
  variant?: "row" | "modal";
}) {
  if (!isQuickCounterOrder(order)) return null;
  // draft 自助單唔顯示「可取餐」——要等撳「接受」先變 sent_to_kitchen（docs/87 §6）
  if (order.status === "draft" && isSelfOrder(order)) return null;

  const ready = isQuickOrderReady(order);
  const isOpen = order.status === "sent_to_kitchen" || order.status === "paid";
  if (!isOpen) return null;

  const completeText = quickCompleteLabel(order);
  const className =
    variant === "modal"
      ? "rounded-2xl px-4 py-2 text-sm font-semibold text-white"
      : "whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold text-white";

  if (!ready) {
    return (
      <button
        className={`${className} bg-orange-500 hover:bg-orange-600`}
        onClick={() => {
          updateQuickFulfillmentInStore(order.id);
          onChanged(`${order.localOrderNo} 已標記可取餐。`);
        }}
        type="button"
      >
        可取餐
      </button>
    );
  }

  return (
    <button
      className={`${className} bg-emerald-600 hover:bg-emerald-700`}
      onClick={() => {
        markQuickOrderCompletedInStore(order.id, { label: completeText });
        onChanged(`${order.localOrderNo} ${completeText}。`, { closeModal: true });
      }}
      type="button"
    >
      {completeText}
    </button>
  );
}

export function LocalOrdersPanel({
  dateFilter = "today",
  focusOrderId = null,
  onFilteredOrdersChange,
}: {
  /** 時間篩選：key 字串或 `{ key, custom }`（2026-09-13 加「自訂」）。 */
  dateFilter?: DateFilterArg;
  /**
   * Deep link（`/orders?orderId=<id>`）：入頁即刻開該張單嘅「查看」彈窗。
   * 由收銀機右上角自助單提示撳入嚟（`pos-app.openSelfOrderNotice`，docs/115 G5）。
   */
  focusOrderId?: string | null;
  /** 當前 tab + 時間範圍篩選後嘅線下單（供 `/orders` 頁匯出 CSV）。 */
  onFilteredOrdersChange?: (orders: PosOrder[]) => void;
}) {
  const currency = loadBootstrapCache()?.currency ?? "MOP";
  const router = useRouter();
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders().filter(isLocalOrTransferredDineIn));
  const [statusTab, setStatusTab] = useState<LocalOrderPanelTab>("all");
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [reopenTargetOrderId, setReopenTargetOrderId] = useState<string | null>(null);
  const [receiptPreviewOrderId, setReceiptPreviewOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState<string>("");
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  /** 「取消結帳」（2026-09-12 補回）：客人落單後幾秒內反悔嘅逃生口，唔可以冇。 */
  const [cancelTargetOrderId, setCancelTargetOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string>("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  function refresh() {
    setOrders(loadOrders().filter(isLocalOrTransferredDineIn));
  }

  useEffect(() => {
    window.addEventListener("pos-orders-changed", refresh);
    return () => window.removeEventListener("pos-orders-changed", refresh);
  }, []);

  /**
   * Deep link 開單（`/orders?orderId=<id>`）—— 收銀機右上角自助單提示撳入嚟（docs/115 G5）。
   *
   * 兩個細節：
   *   ① 一定要切去「全部」tab 先開彈窗：否則客人/收銀可能停在「已完成」，而張新單係
   *      「製作中」，彈窗後面嘅列表睇唔到張單，令人以為跳錯頁。
   *   ② 睇單本身唔靠 `filteredOrders`（彈窗讀 `orders` 全量），所以就算張單唔喺當前
   *      日期篩選範圍都開得到。
   */
  useEffect(() => {
    if (!focusOrderId) return;
    setStatusTab("all");
    setViewingOrderId(focusOrderId);
  }, [focusOrderId]);

  // ── 跨 iPad 線下單即時同步（2026-09-09 根治，見底部註解）────────────────
  // 本 panel 以前淨讀 localStorage：只有 pos-orders-changed 先刷新；realtime 訂閱同
  // /api/pos/state backfill 以前淨係 pos-app（工作台 "/"）有 → 新 iPad 直入訂單頁
  // 永遠睇唔到另一部機啱啱落/確認嘅單。呢度補返同 pos-app loadRuntimeState 一樣嘅
  // 兩條路：① usePosRealtime 訂閱 pos_orders（merge 落本機快取）；② mount /
  // realtime resubscribed / 本機 queue 清空時拉 /api/pos/state 一次過 backfill。
  // 兩條路都係 event-driven，**唔係 polling**（同 pos-app 設計一致）。
  const [merchantId] = useState<string | null>(() => loadAuthSession()?.merchantId ?? null);

  /** 將 server / realtime 單 merge 入本機快取（pos-app 同款：localStorage 為底 +
   * tombstone 防復活，保留本機 localOrderNo），再廣播 pos-orders-changed 令本 panel
   * 同 pos-app 刷新。函數只讀寫 localStorage，無 closure 狀態 → useCallback [] 穩定。 */
  const commitOrdersFromServer = useCallback((incoming: PosOrder[]) => {
    const base = loadOrders();
    const merged = mergeOrderLists(base, base, incoming);
    const cleaned = filterResurrectedOrders(merged, loadDeletedOrderIds(), base);
    saveOrders(cleaned);
    window.dispatchEvent(new CustomEvent("pos-orders-changed"));
  }, []);

  // 一次過 backfill（mount / realtime resubscribed / queue 清空時 call；event-driven）。
  // 同 pos-app loadRuntimeState 一致：冇 merchant 唔拉（admin / kiosk 無店身份）；
  // **方案 B**：本機 queue 有任一未同步（pending / 永久 failed / skipped）事件就唔拉，
  // 避免冚走本機未上雲嘅單（成因 P4）；fetch 失敗靜默（等下次觸發）。
  const pullServerOrders = useCallback(async () => {
    if (!merchantId) return;
    if (loadQueue().some((event) => event.status !== "synced")) return;
    try {
      // 先確保 POS 終端憑證有效（TTL 12h）
      await refreshPosDeviceTokenIfNeeded();
      const res = await fetch(`/api/pos/state?storeId=${encodeURIComponent(merchantId)}`, {
        // 2026-09-10 P0-4：需要 POS 終端憑證
        headers: { ...posDeviceAuthHeaders() },
      });
      if (!res.ok) return;
      const payload = (await res.json().catch(() => null)) as { orders?: PosOrder[] } | null;
      if (!payload || !Array.isArray(payload.orders)) return;
      commitOrdersFromServer(payload.orders);
    } catch {
      // 離線／server 問題：realtime resubscribed / 網絡恢復 / 下次 queue 清空再試。
    }
  }, [merchantId, commitOrdersFromServer]);

  // 觸發①：mount 一次過 backfill（realtime 唔 backfill 舊 row）。
  useEffect(() => {
    void pullServerOrders();
  }, [pullServerOrders]);

  // 觸發②：訂閱 pos_orders / pos_print_jobs / pos_soldout（store_id filter）。
  // 訂單查詢頁淨需要收單嚟刷新列表；printJobs/soldout 由工作台（pos-app）處理。
  usePosRealtime(merchantId, Boolean(merchantId), {
    onOrderUpsert: (order) => {
      if (loadDeletedOrderIds().includes(order.id)) return; // docs/52：已真刪唔可以經 realtime 復活
      commitOrdersFromServer([order]);
    },
    // realtime (re)subscribe 成功 → 一次過 backfill 舊 row（pos-app onResubscribed 同款）
    onResubscribed: () => {
      void pullServerOrders();
    },
  });

  // 觸發③：本機 queue 由「有未同步」變清空（flush 成功）或網絡恢復 → 再拉一次。
  // 解決成因 P4：一旦部機自己嘅 pending/failed 清走，訂單頁就自動補返雲端單。
  useEffect(() => {
    const onTrigger = () => {
      void pullServerOrders();
    };
    window.addEventListener(POS_SYNC_QUEUE_CHANGED_EVENT, onTrigger);
    window.addEventListener("online", onTrigger);
    return () => {
      window.removeEventListener(POS_SYNC_QUEUE_CHANGED_EVENT, onTrigger);
      window.removeEventListener("online", onTrigger);
    };
  }, [pullServerOrders]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeTabLabel = STATUS_TABS.find((t) => t.key === statusTab)?.label ?? "全部";

  const filteredOrders = useMemo(() => {
    return orders
      .filter((order) => orderMatchesLocalDateFilter(order, dateFilter))
      .filter((order) => matchesLocalOrderPanelTab(order, statusTab))
      // 監察頁用 newest-first：用戶要求「最新的放最上面，最舊的放下面」。
      // 用 createdAt（落單時間穩定），唔用 updatedAt（同收銀條 strip 一樣道理：改狀態就移位會撳錯單）。
      // tiebreak = id desc（同 createdAt 同秒罕見，純 id 保證全序）。
      .sort((a, b) => {
        const ca = Date.parse(a.createdAt || "") || 0;
        const cb = Date.parse(b.createdAt || "") || 0;
        if (ca !== cb) return cb - ca;
        return String(b.id).localeCompare(String(a.id));
      });
  }, [dateFilter, orders, statusTab]);

  // 匯出 CSV（2026-09-13）：把「當前 tab + 時間範圍」篩選後嘅線下單上報畀 `/orders` 頁。
  // ⚠️ ref 存 callback，避免 inline 函式每次 render identity 都變 → 無限 loop。
  //
  // 🔴 2026-09-13（實案：/orders 頁無限 re-render 鎖死整個 tab）：父層 `setLocalRows`
  // 係 state setter，收到新陣列 ref 就會令父層 re-render。父層傳落嚟嘅 `dateFilter`
  // selection 若 identity 唔穩定 → 上面 `useMemo` 重算 → `filteredOrders` 新 ref →
  // 本 effect 又 fire → 父層又 re-render → **死循環**（主執行緒鎖死、側欄都撳唔到）。
  // 父層已改用 `useMemo` 穩定 selection；呢度再加**內容簽名**保險：只有「張單嘅組成」
  // 真係變咗（id 序列／長度）才上報，單靠新 ref 唔會觸發。
  const lastReportedSignatureRef = useRef<string | null>(null);
  const onFilteredOrdersChangeRef = useRef(onFilteredOrdersChange);
  useEffect(() => {
    onFilteredOrdersChangeRef.current = onFilteredOrdersChange;
  }, [onFilteredOrdersChange]);
  useEffect(() => {
    const signature = `${filteredOrders.length}|${filteredOrders.map((order) => order.id).join(",")}`;
    if (signature === lastReportedSignatureRef.current) return;
    lastReportedSignatureRef.current = signature;
    onFilteredOrdersChangeRef.current?.(filteredOrders);
  }, [filteredOrders]);
  // 與線上訂單頁「stats.pending」對齊：當前 tab + dateFilter 範圍內，狀態仲係 draft（未送廚房）嘅訂單。
  const draftCount = useMemo(
    () => filteredOrders.filter((order) => order.status === "draft").length,
    [filteredOrders],
  );

  const viewingOrder = viewingOrderId ? orders.find((row) => row.id === viewingOrderId) ?? null : null;
  // 訂單紀錄（查看）嘅折扣備註（2026-09-11 需求 #2）：免單另有「免單備註」區塊，唔重複顯示；
  // 其餘（全單折扣 / 單品折扣 / 系統抹零）一律列出。推導邏輯同報表 / 交班明細共用。
  const viewingOrderDiscountNotes = viewingOrder
    ? buildOrderDetailNotes(viewingOrder).filter((note) => note.kind !== "comp")
    : [];
  const reopenTarget = reopenTargetOrderId ? orders.find((row) => row.id === reopenTargetOrderId) ?? null : null;
  const receiptPreviewOrder = receiptPreviewOrderId ? orders.find((row) => row.id === receiptPreviewOrderId) ?? null : null;
  const cancelTarget = cancelTargetOrderId ? orders.find((row) => row.id === cancelTargetOrderId) ?? null : null;

  /**
   * 「取消結帳」可唔可以撳（2026-09-12 補回）。
   *
   * 只限**未收款**狀態（`draft` / `sent_to_kitchen`）—— 正正係「客人落單後幾秒內反悔」
   * 嘅窗口。`paid` / `settled` 已經收咗錢，作廢要走返結／退款，唔可以當「取消」靜靜抹走
   * （口徑同收銀台結帳彈窗一致：`status !== "paid"` 先顯示取消結帳）。
   * `draft` 自助單唔出 —— 佢已經有「拒絕」掣，同一件事唔重複。
   */
  function canCancelSettle(order: PosOrder | null): boolean {
    if (!order) return false;
    if (order.status !== "draft" && order.status !== "sent_to_kitchen") return false;
    if (order.status === "draft" && isSelfOrder(order)) return false;
    return true;
  }

  /** 開「取消結帳原因」彈窗（列表同「查看」彈窗共用）。 */
  function openCancelSettle(order: PosOrder) {
    setCancelReason("");
    setCancelTargetOrderId(order.id);
  }

  async function handleCancelSettle() {
    if (!cancelTarget) return;
    setCancelSubmitting(true);
    try {
      const result = cancelLocalOrder(cancelTarget.id, cancelReason.trim() || undefined);
      if (!result.ok) {
        setToast(result.error ?? "取消失敗");
        return;
      }
      setToast(`已取消 ${cancelTarget.localOrderNo}`);
      setCancelTargetOrderId(null);
      setCancelReason("");
      setViewingOrderId(null);
      refresh();
    } finally {
      setCancelSubmitting(false);
    }
  }

  /**
   * 快餐出餐動作嘅統一入口（列表 / 彈窗共用）：刷列表 + 出 toast；
   * `closeModal` 為 true 時順手關「查看」彈窗（「完成」＝張單離開活躍列表，要收窗）。
   */
  function handleQuickAction(message?: string, options?: { closeModal?: boolean }) {
    refresh();
    if (message) setToast(message);
    if (options?.closeModal) setViewingOrderId(null);
  }

  /** 呢啲狀態先有收據可補打（未收款 / 已取消單冇原始單據）。 */
  function hasReceivableReceipt(order: PosOrder | null): boolean {
    if (!order) return false;
    return (
      order.status === "settled" ||
      order.status === "paid" ||
      order.status === "partially_refunded" ||
      order.status === "refunded"
    );
  }

  /** 補打帳單（收據）：手動語義，唔受「自動打印」開關影響。 */
  function reprintBillForOrder(order: PosOrder) {
    const count = reprintReceiptForOrder(order);
    if (count > 0) {
      setToast(`已加入補打帳單打印隊列：${order.localOrderNo}`);
      return;
    }
    // 診斷文案共用（線上單補打行同一個 helper，保證兩邊提示一致）。
    setToast(describeNoReceiptPrinterError());
  }

  async function handleDeleteAllOrders() {
    const session = loadAuthSession();
    const storeId = session?.merchantId;
    if (!storeId) {
      setToast("無法取得店舖編號，請重新登入");
      return;
    }
    setDeletingAll(true);
    try {
      // 1) DB 先清（store 隔離 + exclude Ledger 線上單），免 backfill 重拉返晒出嚟
      const res = await fetch(`/api/pos/orders?storeId=${encodeURIComponent(storeId)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; deleted?: number };
      if (!res.ok || data.ok === false) {
        setToast(`刪除失敗：${data.error ?? res.status}`);
        return;
      }
      // 1.5) 本地線下單 id 記 tombstone（防 DB 刪除失效 / RLS 擋 / mock 模式時，backfill 又撈返嚟復活）
      // 只記線下單（onlineOrderId 為空＝DB 真刪嗰批）；Ledger 線上單（onlineOrderId 唔空）唔記，
      // 因為佢哋 DB 冇刪、用家亦無異議保留，下一次 backfill 應照常顯示。
      const localOfflineIds = loadOrders()
        .filter((o) => !o.onlineOrderId)
        .map((o) => o.id);
      if (localOfflineIds.length > 0) addDeletedOrderIds(localOfflineIds);
      // 2) 清本地線下單（saveOrders([]) 只掂本店 localStorage）
      saveOrders([]);
      // 3) 清 order 相關 sync queue events，免重推落 DB（ORDER_CREATED/UPDATED/ITEM_VOIDED/SETTLED）
      saveQueue(loadQueue().filter((e) => !(e.type && e.type.startsWith("ORDER_"))));
      // 4) 廣播畀收銀 / 其他面板（pos-app 監聽 pos-orders-changed）
      window.dispatchEvent(new CustomEvent("pos-orders-changed"));
      refresh();
      setConfirmDeleteAllOpen(false);
      // 5) 回報 DB 實際刪除筆數；0 筆要警告（可能離線 / mock 模式 DB 冇真刪）
      const deleted = typeof data.deleted === "number" ? data.deleted : localOfflineIds.length;
      if (deleted === 0) {
        setToast("已清除本機訂單，但 DB 未刪除任何單（可能離線 / mock 模式，請檢查連線）");
      } else {
        setToast(`已刪除 ${deleted} 筆線下訂單（本地 + DB）`);
      }
    } catch {
      setToast("刪除失敗，請檢查網絡");
    } finally {
      setDeletingAll(false);
    }
  }

  async function handleReopen(order: PosOrder) {
    if (!reopenReason.trim()) {
      setToast("請先揀返結原因");
      return;
    }
    setReopenSubmitting(true);
    try {
      const session = loadAuthSession();
      const operator = session?.name ?? session?.account ?? "收銀";
      const result = await reopenPosOrder({ orderId: order.id, reason: reopenReason, operator });
      if (!result.ok) {
        setToast(result.error ?? "返結失敗");
        return;
      }
      if (result.memberReverseError) {
        setToast("已返結並印單；會員餘額退回待 Ledger 對接");
      } else {
        setToast(result.memberReversed ? "已返結、會員餘額已退回並印單" : "已返結並印返結單");
      }
      setReopenReason("");
      setViewingOrderId(null);
      setReopenTargetOrderId(null);
      // 跳去點餐枱面：進入 temp 枱可編輯「返結帳」狀態，可加餐 / 改價 / 重結（原枱唔會被取代）
      const tableId = result.tempTable?.id ?? (order.tableId && order.tableId !== "counter" ? order.tableId : "");
      router.push(`/?tableId=${encodeURIComponent(tableId)}&orderId=${encodeURIComponent(order.id)}`);
    } finally {
      setReopenSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        {/*
          2026-09-12 商家需求（純 UI）：filter chips 併入標題同一排（同左卡「線上訂單」一致），
          慳返一行高度畀下面嘅訂單列表。靠左排；唔夠位時 chips 自己 flex-wrap 掉第二行。
          三欄：標題塊（shrink-0）／chips（flex-1 min-w-0）／右側控件（ml-auto shrink-0）。
          ⚠️ chips 欄一定要 `min-w-0`，否則 flex 子項最小闊度＝內容闊度 → 窄屏撐爆外層。
          ⚠️ 外層唔可以加 `justify-between`：chips 欄靠 `flex-1` 吃滿中間，右欄自然貼右。
        */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 shrink-0">
            <div className="text-sm font-semibold text-slate-900">店內線下訂單</div>
            {/* 與左卡「線上訂單」header 同格式：dateFilter · tab · 共 X 張 · 新單 X 張。 */}
            <div className="mt-1 text-xs text-slate-500 sm:text-sm">
              {dateFilterLabel(dateFilter)} · {activeTabLabel} · 共 {filteredOrders.length} 張 · 新單 {draftCount} 張
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  tab.key === statusTab ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                }`}
                onClick={() => setStatusTab(tab.key)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {/*
              規格 6：「自動接自助單」開關直接取代原「刪除全部訂單」掣位。
              ⚠️ 「刪除全部訂單」嘅**邏輯保留**（handleDeleteAllOrders + 下方確認彈窗），只係
              介面上唔再需要入口（用戶明確指示：logic 唔好刪、UI 唔再需要）。
              要還原只要喺度加返一粒 onClick={() => setConfirmDeleteAllOpen(true)} 嘅掣就得。
            */}
            <SelfOrderAutoAcceptToggle />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
            {dateFilter === "today" ? "今天暫無線下訂單" : `${dateFilterLabel(dateFilter)}暫無線下訂單`}
          </div>
        ) : (
          /*
            列表（2026-09-10）：每張單一行。欄位同原本卡片完全一致（單號／餐台／時間／菜品／
            金額／狀態／來源／操作），操作統一釘最右。
            響應式（2026-09-10 修）：欄寬由固定 px 改為百分比 + `table-fixed`，令表格闊度
            **永遠等於容器闊度**（iPad 橫向／直向都唔會再撐爆）；只有容器窄過 `min-w-[860px]`
            嗰陣，先由 `overflow-x-auto` 提供橫向滾動。原本 `overflow-hidden` + `min-w-[1080px]`
            會令「操作」欄直接被剪走（見 docs/113）。
            「操作」欄 19% → **22%**（2026-09-11 修）：draft 自助單一行要放
            「查看／接受／拒絕」三粒掣（純文字各約 48px，連 gap 合計 ~156px）；
            19% 喺 `min-w-[860px]` 下只有 ~163px（扣內距剩 ~139px）→ 逼出兩行。
            22% 喺最窄情況下有 ~189px（扣內距 ~165px）→ 穩定一行。多出嘅 3% 由
            「菜品」欄吸收（該欄冇固定闊度，內容本身已 `truncate`）。
          */
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
              <thead>
                <tr>
                  <th className={`${TH_CELL} w-[11%]`}>訂單號</th>
                  <th className={`${TH_CELL} w-[10%]`}>餐台</th>
                  <th className={`${TH_CELL} w-[11%]`}>時間</th>
                  <th className={TH_CELL}>菜品</th>
                  <th className={`${TH_CELL} w-[14%] text-right`}>金額</th>
                  <th className={`${TH_CELL} w-[10%]`}>狀態</th>
                  <th className={`${TH_CELL} w-[10%]`}>來源</th>
                  <th className={`${TH_CELL} w-[22%] text-right`}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => {
                  const badge = getOrderStatusBadge(order);
                  // 付款狀態（已結帳 / 未結帳）——快餐單先顯示（見 getPaymentBadge）。
                  const paymentBadge = getPaymentBadge(order);
                  // 折扣指示：原價（line-through）+ 折後價（amber），收埋喺金額欄第二行
                  const itemSaving = orderItemDiscountTotal(order.items);
                  const wholeSaving = Math.max(0, order.discountAmount ?? 0);
                  const original = Math.round((order.total + itemSaving + wholeSaving) * 100) / 100;
                  return (
                    <tr key={order.id} className="border-t border-slate-100 even:bg-slate-50/60">
                      <td className={TD_CELL}>
                        <div className="truncate text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                      </td>
                      <td className={TD_CELL}>
                        <div className="truncate text-xs text-slate-500">{order.tableName}</div>
                      </td>
                      <td className={TD_CELL}>
                        <div className="text-xs tabular-nums text-slate-400">
                          {formatMacauDateTime(order.updatedAt || order.createdAt || "")}
                        </div>
                      </td>
                      <td className={TD_CELL}>
                        <div className="truncate text-xs text-slate-500">
                          {order.items
                            .slice(0, 3)
                            .map((item) => `${item.name}×${item.quantity}`)
                            .join(" · ")}
                        </div>
                      </td>
                      <td className={`${TD_CELL} text-right`}>
                        <div className="text-sm font-semibold tabular-nums text-slate-900">
                          {formatMoney(order.total, currency)}
                        </div>
                        {itemSaving + wholeSaving > 0 ? (
                          <div className="mt-0.5 text-[11px] tabular-nums text-amber-700">
                            已優惠 -{formatMoney(itemSaving + wholeSaving, currency)}
                            <span className="ml-1 text-slate-400 line-through">
                              原 {formatMoney(original, currency)}
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td className={TD_CELL}>
                        {/* 快餐單雙標籤（2026-09-12 用戶要求）：出餐狀態 ＋ 付款狀態
                            （已結帳 / 未結帳）兩個獨立維度同時顯示。
                            欄位窄（10%），所以上下堆疊 + 縮到 11px，避免撐爆表格。 */}
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.bgClass} ${badge.textClass}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${badge.dotClass}`} />
                            {badge.label}
                          </span>
                          {isQuickCounterOrder(order) ? (
                            <span
                              className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${paymentBadge.bgClass} ${paymentBadge.textClass}`}
                            >
                              {paymentBadge.label}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className={TD_CELL}>
                        <OrderSourceBadge order={order} />
                      </td>
                      <td className={`${TD_CELL} text-right`}>
                        {/* 一行過（2026-09-11）：每粒掣都要 `whitespace-nowrap`，
                            否則 2 字掣（查看／接受／拒絕）喺窄欄會被逐字拆成兩行
                            （「拒／絕」），正正係用戶反映嘅症狀。 */}
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            className="whitespace-nowrap rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                            onClick={() => {
                              if (order.status === "settled") {
                                // 完成狀態：堂食 + 外賣都彈收據預覽（按打印模板樣式），唔跳點餐介面
                                setReceiptPreviewOrderId(order.id);
                                return;
                              }
                              if (!order.tableId || order.tableId === "counter") {
                                // 快餐/外賣/無枱（未結）→ 保留小窗唯讀
                                setReopenReason("");
                                setViewingOrderId(order.id);
                              } else {
                                // 未結堂食單（本地枱單 + 已轉枱線上堂食單）→ 直接跳枱面編輯
                                router.push(
                                  `/?tableId=${encodeURIComponent(order.tableId)}&orderId=${encodeURIComponent(order.id)}`,
                                );
                              }
                            }}
                            type="button"
                          >
                            查看
                          </button>
                          {/* 🔴 2026-09-13：守門由 `status === "settled"` 放寬成 `isReopenable(order)`。
                              `isReopenable()` 本身就**已經接受 `paid`**（見 pos-orders.ts），
                              但呢度舊寫法多夾一個 `settled` 條件 → 排位後已付款嘅線上堂食單
                              （本地寫 `paid`）撳唔到返結，同被放寬嘅結帳入口唔一致。
                              口徑：`paid`（已結帳待收尾）同 `settled` 都要出返結掣。 */}
                          {isReopenable(order) ? (
                            <button
                              className="whitespace-nowrap rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white"
                              onClick={() => {
                                setReopenReason("");
                                setReopenTargetOrderId(order.id);
                              }}
                              type="button"
                            >
                              返結帳
                            </button>
                          ) : null}
                          <QuickOrderActions onChanged={handleQuickAction} order={order} />
                          {/* 「取消結帳」（2026-09-12）：客人落單後幾秒內反悔嘅逃生口。
                              只喺未收款單（draft / sent_to_kitchen）出現，收費單唔會混淆。 */}
                          {canCancelSettle(order) ? (
                            <button
                              className="whitespace-nowrap rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200"
                              onClick={() => openCancelSettle(order)}
                              type="button"
                            >
                              取消
                            </button>
                          ) : null}
                          {/* 自助單 draft → 顯示「接受 / 拒絕」掣（規格 6：開關熄咗時需人手接受，統一用 SelfOrderActionButtons 避免走樣） */}
                          {order.status === "draft" && isSelfOrder(order) ? (
                            <SelfOrderActionButtons
                              orderLabel={order.localOrderNo}
                              onConfirm={() => {
                                const result = confirmSelfOrder(order.id);
                                if (result.ok) {
                                  setToast(`已接受自助單 ${order.localOrderNo}`);
                                  refresh();
                                } else {
                                  setToast(result.error ?? "接受失敗");
                                }
                                return result;
                              }}
                              onReject={() => {
                                const result = rejectSelfOrder(order.id);
                                if (result.ok) {
                                  setToast(`已拒絕自助單 ${order.localOrderNo}`);
                                  refresh();
                                } else {
                                  setToast(result.error ?? "拒絕失敗");
                                }
                                return result;
                              }}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewingOrder ? (
        /**
         * 「查看」彈窗（2026-09-12 用戶要求 #3）：**同點餐介面嘅「訂單詳情」彈窗完全對齊** ——
         * 同一個 header（標題 + 單號·枱別 + 狀態標籤）、同一個品項卡（名稱／規格／備註／折扣 +
         * 右邊數量／金額）、同一個總計框、同一行底部動作掣（關閉／補打帳單／可取餐→完成）。
         * 以前呢度係「標題＝單號、內容逐行文字、冇底部動作」，同點餐頁兩個樣。
         */
        <ResponsiveModal
          actions={
            <>
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setViewingOrderId(null)}
                type="button"
              >
                關閉
              </button>
              {hasReceivableReceipt(viewingOrder) ? (
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={() => reprintBillForOrder(viewingOrder)}
                  type="button"
                >
                  補打帳單
                </button>
              ) : null}
              {/* 自助單 draft：接受 / 拒絕（同點餐頁彈窗同一個元件，唔會走樣） */}
              {viewingOrder.status === "draft" && isSelfOrder(viewingOrder) ? (
                <SelfOrderActionButtons
                  fill={false}
                  orderLabel={viewingOrder.localOrderNo}
                  onConfirm={() => {
                    const result = confirmSelfOrder(viewingOrder.id);
                    if (result.ok) {
                      setToast(`已接受自助單 ${viewingOrder.localOrderNo}`);
                      refresh();
                      setViewingOrderId(null);
                    } else {
                      setToast(result.error ?? "接受失敗");
                    }
                    return result;
                  }}
                  onReject={() => {
                    const result = rejectSelfOrder(viewingOrder.id);
                    if (result.ok) {
                      setToast(`已拒絕自助單 ${viewingOrder.localOrderNo}`);
                      refresh();
                      setViewingOrderId(null);
                    } else {
                      setToast(result.error ?? "拒絕失敗");
                    }
                    return result;
                  }}
                />
              ) : null}
              {/* 快餐出餐：可取餐 → 完成（同列表一行嘅掣共用 QuickOrderActions，行為一定同步） */}
              <QuickOrderActions onChanged={handleQuickAction} order={viewingOrder} variant="modal" />
              {/* 「取消結帳」（2026-09-12 補回，同點餐頁「訂單詳情」彈窗一致）：
                  客人落單後約 2 秒內仍可能反悔，必須保留逃生口，否則訂單會卡死冇得取消。 */}
              {canCancelSettle(viewingOrder) ? (
                <button
                  className="rounded-2xl bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"
                  onClick={() => openCancelSettle(viewingOrder)}
                  type="button"
                >
                  取消結帳
                </button>
              ) : null}
            </>
          }
          header={
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xl font-semibold text-slate-900">訂單詳情</div>
                <div className="mt-1 text-sm text-slate-500">
                  {viewingOrder.localOrderNo} · {viewingOrder.tableName}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                    (() => { const b = getOrderStatusBadge(viewingOrder); return `${b.bgClass} ${b.textClass}`; })()
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      (() => { const b = getOrderStatusBadge(viewingOrder); return b.dotClass; })()
                    }`}
                  />
                  {(() => { const b = getOrderStatusBadge(viewingOrder); return b.label; })()}
                </div>
                {/* 快餐單：付款狀態（已結帳 / 未結帳）同出餐狀態係兩個獨立維度 */}
                {isQuickCounterOrder(viewingOrder) ? (
                  <div
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                      (() => { const p = getPaymentBadge(viewingOrder); return `${p.bgClass} ${p.textClass}`; })()
                    }`}
                  >
                    {(() => { const p = getPaymentBadge(viewingOrder); return p.label; })()}
                  </div>
                ) : null}
              </div>
            </div>
          }
          onClose={() => setViewingOrderId(null)}
          showCloseButton={false}
          widthClassName="max-w-2xl"
        >
          <div className="grid gap-2">
            {viewingOrder.items.map((item) => {
              const itemHasDiscount = item.discountRate != null && Number.isFinite(item.discountRate) && item.discountRate < 100;
              return (
                <div key={`${item.menuItemId}-${item.name}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-900">{item.name}</div>
                      {item.selectedSpecs?.length ? (
                        <div className="mt-1 text-xs text-slate-500">
                          {item.selectedSpecs.map((spec) => `${spec.groupName}:${spec.optionLabel}`).join(" / ")}
                        </div>
                      ) : null}
                      {item.note ? (
                        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-500">
                          備註：{item.note}
                        </div>
                      ) : null}
                      {itemHasDiscount ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                            {item.discountRate}% off
                          </span>
                          {/* 單品折扣原因（2026-09-11 需求 #2）：逐件顯示 */}
                          {item.discountNote ? (
                            <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
                              {item.discountNote}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-900">x{item.quantity}</div>
                      <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                        {formatMoney(item.price * item.quantity, currency)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {(viewingOrder.voidedItems ?? []).map((item, idx) => (
              <div
                key={`voided-${item.menuItemId}-${idx}`}
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

          {/* 總計框（同點餐頁「訂單詳情」彈窗同一個結構）：折扣分項 + 折扣備註 + 總計 + 備註 */}
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            {/* 折扣分項（用戶要求所有訂單明細位都要見到） */}
            <OrderDiscountRow
              currency={currency}
              items={viewingOrder.items}
              wholeOrderDiscountAmount={viewingOrder.discountAmount}
            />
            {/* 折扣備註（2026-09-11 需求 #2）：凡影響實收嘅調整都要見到原因 */}
            {viewingOrderDiscountNotes.length > 0 ? (
              <div className="mt-2 rounded-2xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-slate-500">
                折扣備註：
                <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                  {viewingOrderDiscountNotes.map((note, index) => (
                    <span
                      key={`${note.kind}-${note.text}-${index}`}
                      className="inline-flex whitespace-nowrap rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800"
                    >
                      {note.text}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            <div className="mt-2 flex items-center justify-between text-sm text-slate-500">
              <span>總計</span>
              <span className="text-base font-semibold text-slate-900">{formatMoney(viewingOrder.total, currency)}</span>
            </div>
            {viewingOrder.orderNote ? (
              <div className="mt-2 text-sm text-slate-500">
                全單備註：<span className="font-semibold text-slate-900">{viewingOrder.orderNote}</span>
              </div>
            ) : null}
            {/* 免單審計：獨立欄位（唔係 orderNote，後者受 docs/84 鎖定） */}
            {viewingOrder.compNote ? (
              <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                免單備註：
                <span className="whitespace-pre-wrap break-words font-semibold text-slate-900">{viewingOrder.compNote}</span>
              </div>
            ) : null}
          </div>
        </ResponsiveModal>
      ) : null}

      {reopenTarget ? (
        <ResponsiveModal
          description="把此單退回可編輯，改正後重新結帳"
          onClose={() => {
            setReopenTargetOrderId(null);
            setReopenReason("");
          }}
          title="返結帳（反結賬）"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-[11px] text-amber-700">
              必須揀返結原因，確認後跳去點餐枱面操作（可改價／加餐／重結）。
            </p>
            <select
              className="w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
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
              disabled={!reopenReason || reopenSubmitting}
              onClick={() => handleReopen(reopenTarget)}
            >
              {reopenSubmitting ? "處理中…" : "返結帳"}
            </button>
          </div>
        </ResponsiveModal>
      ) : null}

      {cancelTarget ? (
        <ResponsiveModal
          description="作廢此單（未收款），原因會記錄在訂單紀錄"
          onClose={() => {
            setCancelTargetOrderId(null);
            setCancelReason("");
          }}
          title="取消結帳"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-xs text-slate-500">
              訂單 <span className="font-semibold text-slate-900">{cancelTarget.localOrderNo}</span>
              （{cancelTarget.tableName}）會被標記為「已取消」，唔會計入營業額。
            </p>
            {/* 原因可選（同收銀台「取消結帳」一致：唔填 → 記「收銀取消結帳」）。
                用 datalist 令收銀可以一撳揀常用原因，亦可以自由輸入。 */}
            <input
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
              list="local-order-cancel-reasons"
              placeholder="（可選）取消原因"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <datalist id="local-order-cancel-reasons">
              {(loadPosLocalSettings()?.cancelNotePresets ?? []).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                onClick={() => {
                  setCancelTargetOrderId(null);
                  setCancelReason("");
                }}
                disabled={cancelSubmitting}
              >
                返回
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                onClick={handleCancelSettle}
                disabled={cancelSubmitting}
              >
                {cancelSubmitting ? "處理中…" : "確認取消"}
              </button>
            </div>
          </div>
        </ResponsiveModal>
      ) : null}

      {confirmDeleteAllOpen ? (
        <ResponsiveModal
          description="此操作不可復原，會刪除本店全部「店內線下訂單」。"
          onClose={() => setConfirmDeleteAllOpen(false)}
          title="刪除全部訂單"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-xs text-red-700">
              警告：一經確認即永久刪除本店所有線下訂單（含結帳紀錄），無法復原。
              其他已開啟嘅收銀 / 點餐終端唔會自動清除，佢哋下次同步時會重新拉取空列表刷新畫面。
              Ledger 線上訂單（會員餘額相關）唔會受影響。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                onClick={() => setConfirmDeleteAllOpen(false)}
                disabled={deletingAll}
              >
                取消
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                onClick={handleDeleteAllOrders}
                disabled={deletingAll}
              >
                {deletingAll ? "刪除中…" : "確認刪除全部"}
              </button>
            </div>
          </div>
        </ResponsiveModal>
      ) : null}

      {receiptPreviewOrder ? (
        <ResponsiveModal
          description="按現有收據打印模板樣式生成嘅預覽"
          onClose={() => setReceiptPreviewOrderId(null)}
          title={`收據預覽 · ${receiptPreviewOrder.localOrderNo}`}
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <ReceiptTicketPreview order={receiptPreviewOrder} />
            {hasReceivableReceipt(receiptPreviewOrder) ? (
              <button
                type="button"
                className="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={() => reprintBillForOrder(receiptPreviewOrder)}
              >
                補打帳單（收據）
              </button>
            ) : null}
          </div>
        </ResponsiveModal>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
