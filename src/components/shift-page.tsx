"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { isPrintContentEnabled } from "@/lib/print-toggles";
import { getMerchantReportSummary, LedgerReportSummary } from "@/lib/ledger/reports";
// 線上「實收」＝已付款單逐張加總（唔用 RPC `order_paid_avos`：Ledger 只認「已完成」，會滯後
// —— 客人已付款但訂單未推 completed 嘅話，交班就會少算。見 lib/ledger/paid-orders.ts）。
import { sumPaidLedgerOrders, type PaidLedgerOrdersTotal } from "@/lib/ledger/paid-orders";
// 補推：把「已付款但 Ledger 未 completed」嘅線上單推上梯頂（同一條堂食爬梯，零依賴可測）。
import { syncOnlineDineInCompletionById } from "@/lib/pos/online-dinein-fulfillment";
import { orderMatchesReportRange, macauTodayRange, macauDateKey } from "@/lib/ledger/report-period";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { fetchPurchaseSummary, type PurchaseApiResponse } from "@/lib/inventory-stats";
import { isLocalPosOrder } from "@/lib/pos-order-filters";
// 退款淨額口徑（毛 / 淨兩個數並存）—— 必須同報表共用同一套算法，否則兩頁夾唔到數。
import { refundAmountOf, refundTotalOf } from "@/lib/refund-net";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  loadShiftHistory,
  loadShiftState,
  saveQueue,
  saveShiftHistory,
  saveShiftState,
  type ShiftHistoryRecord,
} from "@/lib/storage";
import { readNetworkOnline } from "@/lib/use-network-online";
import {
  resolveStoreId,
  withStoreScope,
  filterEventsForCurrentStore,
  notifyQueueChanged,
} from "@/lib/pos/sync-flush";
import { enqueueEvents, isOutboxV2Enabled, summarizeQueueEvents } from "@/lib/pos/queue-outbox";
import { posDeviceAuthHeaders, refreshPosDeviceTokenIfNeeded } from "@/lib/pos/pos-sync-auth";
import {
  reconcileLocalShift,
  serverActiveToLocal,
  serverCloseShift,
  serverOpenShift,
  fetchServerShiftHistory,
  updateServerShiftClosingNote,
} from "@/lib/shift-sync";
import { DeviceConfig, DevicePrinterConfig, PosOrder, QueueEvent, ShiftSettlementSnapshot } from "@/lib/types";
import { buildShiftPrintJobs } from "@/lib/print-jobs";
// 🔴 落本機一律行 `persistMergedPrintJobs()`（統一入口：merge 去重 + tombstone 過濾 +
// dispatch `pos-print-jobs-changed` 令打印中心即時刷新）。
//
// 以前呢個檔自己 `[printJob, ...loadPrintJobs()]` + `savePrintJobs()` 直寫，
// **繞過咗去重同 tombstone 過濾** —— 將來統一入口再加嘢（PII 過濾、欄位白名單等）
// 都會靜靜漏咗呢兩處，變成「改咗一處、另一處唔跟」嘅經典死角。
//
// ⚠️ 點解唔用 `appendPrintJobsWithSync()`：交班單要保留「**只推呢一條** PRINT_JOB_CREATED」
// 嘅自訂 flush（docs/111 —— 整條 queue 照推會撞 server 200 條上限 → 413 → 交班單反而上唔到雲）。
// 所以呢度只換「落本機」嗰半步，入隊 / flush 照舊由下面自己控制。
import { persistMergedPrintJobs } from "@/lib/pos/print-job-enqueue";
// 「關店總掣」（2026-09-18）：交班時一次過關閉線下 + 線上接單通路。
// 決策／文案喺純模組 `close-gate.ts`；真正 call 兩個 hook 模組嘅執行層喺 `close-gate-run.ts`。
import { describeCloseGate, isCloseGateClean, type CloseGateResult } from "@/lib/pos/close-gate";
import { runCloseGate } from "@/lib/pos/close-gate-run";
// 交班關店總掣要讀兩條接單通道嘅現值（module singleton，同側欄 pill 共用）
import { useStoreStatus } from "@/lib/pos/use-store-status";
import { useMerchantOrderConfig } from "@/lib/pos/use-merchant-order-config";
import { formatMoney, formatMoneyValue } from "@/lib/format";
import { buildOrderDetailNotes, buildOnlineOrderDetailNotes } from "@/lib/pos/order-notes";
import { paymentModeLabel } from "@/lib/ledger/order-mapper";
import { OrderDetailList, type OrderDetailRow } from "@/components/order-detail-list";

/**
 * Ledger 純線上單嘅「餐台」欄標籤（同報表明細同一套文案）。
 * ⚠️ 報表頁有自己一份 private 版本；呢度只為交班明細顯示，唔涉及金額口徑。
 */
function ledgerFulfillmentLabel(fulfillmentType?: string | null): string {
  const t = String(fulfillmentType ?? "").toLowerCase();
  if (t === "pickup" || t === "self_pickup") return "線上·自取";
  if (t === "delivery" || t === "merchant_delivery") return "線上·外送";
  return "線上";
}

/**
 * 交班歷史分頁（商家 2026-09-15 拍板）。
 *
 * - 口徑：「一頁 10 天」＝**10 個澳門日曆日**，一日可以有 2–3 個班次 → 實際行數可以多過 10。
 * - 「查看更多」＝**累加**（保留已載入嘅，再加 10 天），唔係換頁。
 * - 框架尺寸固定：載入更多日只會令表格**內部滾動**，個框唔會撐高（`max-h`）。
 * - 「導出 CSV」＝**篩選後全部**，唔受 10 天限制。
 */
const SHIFT_HISTORY_PAGE_DAYS = 10;
/** 交班歷史表格最大高度（px）—— 框架尺寸固定嘅關鍵。 */
const SHIFT_HISTORY_MAX_HEIGHT_PX = 620;
const MACAU_WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 表頭貨幣單位（黏喺表頭標籤下面一行）。
 *
 * 🔴 為何貨幣要搬上表頭：交班歷史有 12 欄，iPad 橫向（viewport 1180 → 內容約 1040px）
 * 根本塞唔落。每格重複「MOP ⋯」＝每欄多 24–28px，7 個金額欄就多 ~170px；
 * 搬上表頭之後 1130px → **1018px**，iPad 完全唔洗橫向滾動。
 */
const MONEY_UNIT = <div className="font-normal text-slate-400">MOP</div>;

/**
 * 交班記錄 → 澳門日曆日 key（`YYYY-MM-DD`）。
 *
 * 🔴 唔可以用 `closedAt.slice(0, 10)`：`closedAt` 係 `toISOString()`（UTC），
 * 澳門 00:00–08:00 收工嘅班次會被切到**前一日** —— 同格內顯示嘅澳門日期（`formatMacauDateTime`）
 * 唔一致，令「日分隔列」講嘅日子同同一行嘅日期對唔上。一律用澳門邊界（`macauDateKey`）。
 */
function shiftHistoryDayKey(closedAt: string): string {
  const d = new Date(closedAt);
  if (Number.isNaN(d.getTime())) return "";
  return macauDateKey(d);
}

/** 日分隔列標籤：`DD/MM/YYYY（週X）`，同格內顯示格式一致。 */
function shiftHistoryDayLabel(day: string): string {
  const parts = day.split("-");
  if (parts.length !== 3) return day;
  const wd = MACAU_WEEKDAY_LABELS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";
  return `${parts[2]}/${parts[1]}/${parts[0]}（週${wd}）`;
}
/**
 * 交班摘要（線下 POS）。
 *
 * 🔴 2026-09-14（商家口徑）：**退款單唔再計入任何金額**。
 * 舊寫法將 `refunded` / `partially_refunded` 單嘅 `order.total` **全額**計入實收
 * （＝退款咗都照計全額）→ 有退款嘅日子實收偏高，商家明確指「呢個絕對係錯」。
 * 而家：
 * - **收入認列**（count / revenue / prepaid / receivableTotal / paidTotal / paymentBreakdown
 *   /「應收現金」）**只計 `settled` 單**；
 * - **退款單只入「退款」統計**（張數 + 累計 `refundedAmount`），唔入金額、唔入支付方式拆分。
 * - 部分退嘅單連「實收部分」都唔計 —— 同報表 `isSaleCountable()`（退款一律排除）口徑一致，
 *   保證交班同報表兩頁見到嘅係同一套數。
 *
 * 🔴🔴 2026-09-17 修正（商家實案）：上面嗰條口徑**會令實收偏低**，唔可以就咁當終點。
 *
 * 【問題】「賣 100、退 30」正確實收 = 70，但兩頁都當 0 ⇒ 實收**偏低 30**。
 * 部分退嘅單，未退嘅部分係真金白銀收過嘅錢，唔應該連佢一齊消失。
 *
 * 【正確口徑】**淨額 = 已結帳單實收 − 退款總額**：
 *   - `settled` 單照計全額（冇退過）；
 *   - `partially_refunded` / `refunded` 單計 `total − refundedAmount`（未退部分）；
 *   - 退款總額另行單獨列出（供對帳），所以「毛 / 淨」兩個數都睇得到。
 *
 * ⚠️ 為何唔索性「只加退款單嘅未退部分」就算：咁樣會令「毛收入」呢個概念消失，
 *    商家對數時想睇「今日做咗幾多生意、當中退咗幾多」——兩個數都要有。
 *    `netRevenue` / `netPaidTotal` 係新增欄位，原有 `revenue` / `paidTotal` 語義**不變**
 *    （仍然只計 `settled`），避免改動既有報表口徑。
 */
function summarizeClosedOrders(orders: PosOrder[]) {
  const closedOrders = orders.filter((order) => order.status === "settled");
  const refunded = orders.filter(
    (order) => order.status === "partially_refunded" || order.status === "refunded",
  );
  // 計算每筆訂單的「應收」(菜品原價合計 + 服務費 + 稅) 與「實收」(order.total)。
  // - 應收 = Σ item.price × item.quantity + order.serviceChargeAmount + order.taxAmount
  //   （item.price = 落單時嘅 base price，未套單品 discountRate）
  // - 實收 = order.total（已扣全單 discount + 抹零 後商家實際收嘅）
  let receivableTotal = 0;
  let paidTotal = 0;
  const paymentBreakdown = closedOrders.reduce<Record<string, { receivable: number; paid: number; count: number }>>(
    (acc, order) => {
      const itemsGross = order.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
      const orderReceivable =
        itemsGross + (order.serviceChargeAmount ?? 0) + (order.taxAmount ?? 0);
      receivableTotal += orderReceivable;
      paidTotal += order.total;
      const key = order.paymentMethod ?? "未記錄";
      const bucket = acc[key] ?? { receivable: 0, paid: 0, count: 0 };
      bucket.receivable += orderReceivable;
      bucket.paid += order.total;
      bucket.count += 1;
      acc[key] = bucket;
      return acc;
    },
    {},
  );

  // ── 2026-09-17 淨額口徑（退款唔再令整張單消失）────────────────────────
  // ⚠️ 算法住喺 `@/lib/refund-net` —— 同一套口徑畀報表（`restaurant-daily-report`）共用。
  //    唔可以在本檔各自實現一份：兩頁夾唔到數就係商家最初投訴嘅症狀。
  const refundAmount = refundTotalOf(refunded);
  /** 退款單「未退部分」＝ 原單實收 − 已退金額（下限 0，防止退多過收造成負數）。 */
  const refundedRemainder = refunded.reduce(
    (sum, order) => sum + Math.max(0, (order.total || 0) - refundAmountOf(order)),
    0,
  );
  const netPaidTotal = roundMoney(paidTotal + refundedRemainder);

  return {
    count: closedOrders.length,
    revenue: closedOrders.reduce((sum, order) => sum + order.total, 0),
    prepaid: closedOrders.reduce((sum, order) => sum + (order.prepaidAmount ?? 0), 0),
    refundCount: refunded.length,
    refundAmount: roundMoney(refundAmount),
    /** 退款單未退部分（仍然係真金白銀收過嘅錢） */
    refundedRemainder: roundMoney(refundedRemainder),
    /**
     * 🔴 淨實收 = 已結帳單實收 + 退款單未退部分 = 實際落袋嘅錢。
     * 對帳口徑：`netPaidTotal = 毛實收 + 退款單未退部分`；
     * 或者寫成 `settled 實收總額 − 退款總額`（兩者等價，因為退款只會喺已結帳單上發生）。
     */
    netPaidTotal,
    paymentBreakdown,
    receivableTotal,
    paidTotal,
  };
}

/** 金額四捨五入到分（避免浮點誤差令對帳差 0.01）。 */
function roundMoney(v: number): number {
  return Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function csvCell(value: string | number | undefined) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/** 差額輸入消毒：只容許數字、小數點同開頭負號（最多一個負號、一個小數點）。 */
function sanitizeCashInput(raw: string) {
  let value = raw.replace(/[^0-9.\-]/g, "");
  const minusAt = value.indexOf("-");
  if (minusAt === -1) {
    value = value.replace(/(\..*)\./g, "$1");
  } else {
    const head = value.slice(0, minusAt);
    const tail = value.slice(minusAt).replace(/-/g, "").replace(/(\..*)\./g, "$1");
    value = head + (minusAt === 0 ? "-" : "") + tail;
  }
  return value;
}

/**
 * 解讀「現金差額」輸入：
 * - 留空 → { ok, filled:false, diff:0 }（即無落差，唔寫入實收現金）
 * - 數值 → { filled:true, diff }（負 = 少收、正 = 多收）
 * - 非數字（如淨係「-」「.」）→ { ok:false }
 * ⚠️ 唔好用 Number("")（=0）直接判斷「有冇填」，會令未盤點被誤當成「實收 = 0」。
 */
function interpretCashDiff(raw: string) {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true as const, filled: false, diff: 0 };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false as const };
  return { ok: true as const, filled: true, diff: n };
}

// ── 交班明細快照（2026-09-08）──
// 結數交班 step3「打印預覽」與實際打印共用同一份快照：進入 step3 時固化，
// 之後「打印／跳過 → 完成交班」都用地呢份數，保證 預覽 == 紙本 == 交班記錄。
//
// 2026-09-10：類型搬去 `types.ts`（正名 `ShiftSettlementSnapshot`）——
// `escpos-template.ts` 嘅 `buildShiftContent()` 要讀同一份形狀，而 lib 唔應該
// 反向 import component（會成 circular dependency）。呢度保留舊名做 alias，
// 令本檔既有引用（`previewData` / `ShiftHistoryRecord.detail` …）零改動。
type ShiftDetailSnapshot = ShiftSettlementSnapshot;

/** 交班歷史記錄 → 結算快照（重打用）。 */
function shiftRowToSettlement(row: ShiftHistoryRecord): ShiftSettlementSnapshot {
  // 2026-09-10 之後交班嘅記錄直接存咗完整快照 → 原封還原（連線上區塊都準）。
  if (row.detail) return row.detail;
  // 舊記錄（冇 detail）：由扁平欄位盡量還原。
  // ⚠️ 舊記錄只存咗 `onlinePaidMop`，冇「線上訂單張數 / 餘額扣點 / 到店貨到付款」。
  // 唯一誠實嘅做法：`onlinePaidMop <= 0` 當冇線上資料（成組唔印）；
  // > 0 就只印「已付線上營業額」（其餘細項補 0 會誤導對數），見 buildShiftContent 註釋。
  const onlinePaid = row.onlinePaidMop ?? 0;
  return {
    closedAt: row.closedAt,
    shiftNo: row.shiftNo ?? "",
    storeName: row.storeName ?? "",
    employee: row.employeeName ?? row.employeeAccount ?? "未記錄",
    openedAt: row.openedAt,
    store: {
      count: row.settledCount,
      revenue: row.revenue,
      receivableTotal: row.receivableTotal ?? 0,
      paidTotal: row.paidTotal ?? 0,
      prepaid: row.prepaid,
      refundCount: row.refundCount,
      refundAmount: row.refundAmount,
    },
    online:
      onlinePaid > 0
        ? { orderCount: 0, paidMop: onlinePaid, balancePaidMop: 0, inStorePaidMop: 0 }
        : null,
    payments: Object.entries(row.paymentBreakdown).map(([method, value]) => ({
      method,
      receivable: typeof value === "number" ? value : value.receivable,
      paid: typeof value === "number" ? value : value.paid,
      count: typeof value === "number" ? 1 : value.count,
    })),
    purchase: typeof row.purchasePaid === "number" ? { paid: row.purchasePaid, unpaid: 0 } : null,
    cash: { expected: row.expectedCash, actual: row.actualCash, diff: row.cashDifference },
    pendingEvents: row.pendingEvents,
    failedEvents: row.failedEvents ?? 0,
    skippedEvents: row.skippedEvents ?? 0,
    pendingPrints: row.pendingPrints,
    note: row.closingNote ?? "",
  };
}

/**
 * 交班單打印機：DeviceConfig.shiftPrinterId 指定優先；
 * 指定機被停用／刪除 → fallback 第一台啟用收據打印機 → 任何一台啟用打印機。
 */
function pickShiftPrinter(config: DeviceConfig): DevicePrinterConfig | null {
  const enabled = config.printers.filter((printer) => printer.enabled);
  const specified = config.shiftPrinterId ? enabled.find((printer) => printer.id === config.shiftPrinterId) : undefined;
  return specified ?? enabled.find((printer) => printer.role === "receipt") ?? enabled[0] ?? null;
}

export function ShiftPage() {
  const [shift, setShift] = useState(() => loadShiftState());
  // 「開工備註」draft：只喺未開工時顯示，開工時寫入 openingNote 後清空；
  // 交班備註（closingNote）改喺結數交班彈窗入面填，唔再同開工共用同一欄（2026-09-07 修正）。
  const [shiftNote, setShiftNote] = useState("");
  const [status, setStatus] = useState("開工後可於下班時做結數交班並打印交班單。");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 結數交班彈窗三步（2026-09-08）：1 = 核對金額（填差額）→ 2 = 二次確認 → 3 = 交班明細打印預覽（打印／跳過）。
  // step3 先實際交班：打印 = 出紙並完成；跳過 = 唔打印直接完成。
  const [confirmStep, setConfirmStep] = useState<1 | 2 | 3>(1);
  const [previewData, setPreviewData] = useState<ShiftDetailSnapshot | null>(null);
  const [closingDiff, setClosingDiff] = useState("");
  const [closingNote, setClosingNote] = useState("");
  const [closingShift, setClosingShift] = useState(false);
  /**
   * 「關店總掣」勾選（2026-09-18，J 拍板**預設勾**）。
   *
   * 勾住 = 交班完成後，一次過關閉本店全部接單通路：
   *   ① 線下（掃碼 `/menu` `/quick` + kiosk `/order`）＝ `pos_store_status.is_open`
   *   ② 線上（會員通）＝ Ledger `merchant_enabled`
   *
   * ⚠️ 點解預設勾：交班本身就係「今日唔再做」嘅動作，唔勾反而係例外情況
   *    （例如提早交班但想繼續收線上單）。預設唔勾 = 每次都要人手記得撳，
   *    漏撳就係 J 2026-09-18 回報嗰個「收咗班但客人仲落得到單」。
   */
  const [closeStoreGate, setCloseStoreGate] = useState(true);
  /**
   * 交班完成後嘅關店結果（`null` = 未執行過）。
   * 交班完成後**唔會**即刻消失，要留住畀收銀睇到邊條通道未關到。
   */
  const [lastCloseGate, setLastCloseGate] = useState<CloseGateResult | null>(null);
  const [shiftHistory, setShiftHistory] = useState(() => loadShiftHistory());
  /** 雲端回填到幾多筆（>0 = 有跨機記錄，顯示喺標題旁令用戶知來源）。 */
  const [historyCloudCount, setHistoryCloudCount] = useState(0);
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [historyEmployeeFilter, setHistoryEmployeeFilter] = useState("");
  const [historyNoteDrafts, setHistoryNoteDrafts] = useState<Record<string, string>>({});
  const [reprintingShiftId, setReprintingShiftId] = useState<string | null>(null);
  const [exportingType, setExportingType] = useState<"csv" | null>(null);
  const [ledgerToday, setLedgerToday] = useState<LedgerReportSummary | null>(null);
  const [ledgerTodayError, setLedgerTodayError] = useState<string | null>(null);
  /**
   * 🔴 2026-09-15（商家要求）：交班頁改為「**全有或全無**」渲染。
   *
   * 兩個獨立數據源（本機/雲端訂單 merge、Ledger 今日彙總）各自完成後才 set true；
   * `pageReady = ordersLoaded && ledgerLoaded`。任何一項未齊 → 整頁 loading，
   * **唔渲染任何部分內容**，避免「線下數先出、線上數後補」嘅跳動。
   *
   * ⚠️ 呢兩個旗標**初始值係 false**（唔可以偷雞用「orders 已有本機值」當完成）：
   * `orders` 嘅初始值係 `loadOrders()`（同步讀本機 localStorage），
   * 佢只係舊資料，雲端 merge 未跑完就渲染 = 數字會由「本機版」跳到「雲端版」。
   */
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  /**
   * 線上（Ledger）「已付款單」加總（＝今日實際收到嘅線上錢，含未推 completed 嘅單）。
   * `null` = 攞唔到（未登入／網絡問題）→ 退回 RPC 已完成口徑，UI 會標示。
   */
  const [ledgerPaidOrders, setLedgerPaidOrders] = useState<PaidLedgerOrdersTotal | null>(null);
  const [purchaseToday, setPurchaseToday] = useState<PurchaseApiResponse | null>(null);
  const authSession = useMemo(() => loadAuthSession(), []);

  /**
   * 「關店總掣」（2026-09-18）——交班彈窗需要知道兩條接單通道**而家**開唔開，
   * 先可以決定要唔要關、同埋畀收銀睇到「交班後會關咩」。
   *
   * ⚠️ 呢兩個 hook 只係**讀**。真正嘅寫入由 `close-gate-run.ts` 嘅
   *    `runCloseGate()` 經 module-level 函式做（非 React 呼叫端唔可以 call hook）。
   *
   * ⚠️ 兩個都係 module singleton（見各自檔案），同側欄嘅 pill 共用同一份 state
   *    同一條 Realtime channel —— 所以呢度掛 hook **唔會**多開連線。
   */
  const storeOpenStatus = useStoreStatus(authSession?.merchantId ?? null, Boolean(authSession?.merchantId));
  const onlineOrderConfig = useMerchantOrderConfig(
    authSession?.merchantId ?? null,
    Boolean(authSession?.merchantId),
  );

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());

  // 2026-09-09：交班摘要數據源由「純本機 localStorage」改為「本機 + 雲端 merge」。
  // 根因：多機協作時，另一部機結帳嘅單只上咗雲端（pos_orders），唔會落呢部機嘅 localStorage，
  // 令交班少計（案例：本機 13 張=762 vs 雲端 17 張=903，漏咗 4 張今日正常結帳單）。
  // 做法：入頁 + focus + 網絡恢復時，拉 `/api/pos/state?ordersOnly=1&start&end` 今日單，
  //       按 id 同本機 merge（雲端較新 wins），令交班數 = 報表數。離線 / 失敗 → 維持本機 fallback。
  useEffect(() => {
    let cancelled = false;

    function mergeByUpdatedAt(local: PosOrder[], cloud: PosOrder[]): PosOrder[] {
      const map = new Map<string, PosOrder>();
      for (const o of local) map.set(o.id, o);
      for (const o of cloud) {
        const existing = map.get(o.id);
        if (!existing) {
          map.set(o.id, o);
          continue;
        }
        const localTs = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
        const cloudTs = o.updatedAt ? Date.parse(o.updatedAt) : 0;
        if (cloudTs >= localTs) map.set(o.id, o); // 雲端較新（或同刻）→ 採雲端
      }
      return [...map.values()];
    }

    async function refreshOrders() {
      // 每次（重）跑都先落返「未完成」—— 呢個 effect 亦係 focus / online 事件嘅處理器，
      // 即係「自動刷新」。refresh 期間顯示 loading 正正係商家要求（見 `pageReady` 註釋）。
      setOrdersLoaded(false);
      setOrders(loadOrders());
      const storeId = resolveStoreId();
      // 🔴 兩條 early return 都**必須**放行 `ordersLoaded`，否則全頁 loading 一世都唔完：
      // ① 未登入／未綁店：冇雲端單可拉，本機 orders 就係全部 → 直接完成。
      // ② 離線：同上，離線交班係合法場景（本機 fallback），唔應該被 loading 擋住。
      if (!storeId || !readNetworkOnline()) {
        setOrdersLoaded(true);
        return;
      }

      try {
        const range = macauTodayRange();
        const url = `/api/pos/state?storeId=${encodeURIComponent(storeId)}&ordersOnly=1&limit=5000&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
        // 2026-09-10 P0-4：/api/pos/state 需要 POS 終端憑證（先續期，否則 401）。
        await refreshPosDeviceTokenIfNeeded();
        const res = await fetch(url, { headers: { ...posDeviceAuthHeaders() } });
        if (cancelled) return;
        if (!res.ok) return;
        const payload = (await res.json()) as { ok?: boolean; orders?: PosOrder[] };
        if (!payload.ok || !Array.isArray(payload.orders)) return;
        // 只採今日、本店、可計數（settled/refunded 等）嘅單，避免將 open 單嘅金額計入交班。
        const cloudSettled = payload.orders.filter(
          (o) =>
            o.storeId === storeId &&
            (o.status === "settled" ||
              o.status === "partially_refunded" ||
              o.status === "refunded"),
        );
        if (cloudSettled.length === 0) return;
        setOrders((prev) => mergeByUpdatedAt(prev, cloudSettled));
      } catch {
        // 拉雲端失敗 → 維持本機（fallback），唔影響離線交班。
      } finally {
        // 🔴 `finally` 而唔係喺 try 尾：上面任何一條 `return`（未 ok / payload 唔啱 /
        // 冇雲端單）都係「訂單側已完成（用本機）」，必須放行，否則 loading 卡死。
        if (!cancelled) setOrdersLoaded(true);
      }
    }

    refreshOrders();
    window.addEventListener("focus", refreshOrders);
    window.addEventListener("online", refreshOrders);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshOrders);
      window.removeEventListener("online", refreshOrders);
    };
  }, []);

  // 2026-09-07（問題一）：入頁即同 server active 班次 reconcile ——
  // 若另一部機／另一個 browser 已開工而本地未開 → adopt server 開工狀態（時間以 server 為準），
  // 唔再「每次都要重新開工」；若本地離線開工未上雲 → 自動補上雲。
  useEffect(() => {
    const storeId = resolveStoreId();
    if (!storeId || !readNetworkOnline()) return;
    let cancelled = false;
    void reconcileLocalShift(storeId)
      .then((result) => {
        if (cancelled || !result.ok) return;
        setShift(result.shift);
        if (result.adoptedServer) {
          setStatus(
            result.shift.openedAt
              ? `已同步雲端班次狀態（另一部裝置已開工：${formatMacauDateTime(result.shift.openedAt)}），可以直接交班。`
              : "已同步雲端班次狀態。",
          );
        } else if (result.shift.serverSynced) {
          setStatus("班次狀態已與雲端同步。");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const todayLocalOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          isLocalPosOrder(order) &&
          orderMatchesReportRange(order, "today") &&
          (order.status === "settled" ||
            order.status === "partially_refunded" ||
            order.status === "refunded"),
      ),
    [orders],
  );

  const summary = useMemo(() => summarizeClosedOrders(todayLocalOrders), [todayLocalOrders]);

  /**
   * 線上（Ledger）「實收」金額 —— 🔴 2026-09-14 商家口徑：「實收 = 今日實際收到嘅錢」。
   *
   * 優先「**已付款單逐張加總**」（`sumPaidLedgerOrders()`，含已付款但未推 completed 嘅單）；
   * 攞唔到（未登入／網絡問題）→ 退回 RPC `orderPaidMop`（Ledger「已完成」口徑，
   * 會靜默少計未完成單）→ 所以 UI 必須標示係「已完成口徑」，唔可以靜默。
   */
  /**
   * 本地／POS 側「**今日**帶 `onlineOrderId` 且已結帳」嘅單（＝線上交單嘅本地投影：掃碼／排位／快餐採納）。
   * 呢啲單**本地有真實收款記錄**，金額一定要計入線上實收。
   *
   * 🔴 2026-09-15 修（商家實案：報表今日「線上」MOP 0、交班卻顯示 602）：
   * 呢個 filter 以前**冇日期條件**，會把**往日**（甚至幾個星期前）嘅線上投影單一齊加落「今日」線上實收，
   * 令交班「線上線下合計（實收）」長期大過報表。
   * 同一個檔案裏面其餘三個口徑（`todayLocalOrders` 線下／`ledgerOnlyRows` Ledger 純線上／
   * `detailOrders` 明細）**全部**係 `orderMatchesReportRange(o, "today")`，唯獨呢個冇 →
   * 交班自己「卡片線上數」同「明細線上小計」都夾唔到，更加同報表夾唔到。
   */
  const onlineLocalOrders = useMemo(
    () =>
      orders.filter(
        (o) => !!o.onlineOrderId && o.status === "settled" && orderMatchesReportRange(o, "today"),
      ),
    [orders],
  );
  const onlineLocalMop = useMemo(
    () => Math.round(onlineLocalOrders.reduce((s, o) => s + (o.total || 0), 0) * 100) / 100,
    [onlineLocalOrders],
  );

  /** 本地線上投影單嘅 Ledger id 集合（去重／核對用）。 */
  const localOnlineIds = useMemo(
    () => new Set(onlineLocalOrders.map((o) => o.onlineOrderId as string)),
    [onlineLocalOrders],
  );

  /** Ledger 已付款單之中，本地冇對應投影單嘅嗰批（＝從未入 POS DB 嘅線上單，例如 001／005 預約單）。 */
  const ledgerOnlyRows = useMemo(
    () => (ledgerPaidOrders?.orders ?? []).filter((o) => !localOnlineIds.has(o.id)),
    [ledgerPaidOrders, localOnlineIds],
  );

  const ledgerOnlyOnline = useMemo(() => {
    const amount = ledgerOnlyRows.reduce(
      (s, o) => s + (Number(o.total ?? o.paidAmount ?? 0) || 0),
      0,
    );
    return { count: ledgerOnlyRows.length, amountMop: Math.round(amount * 100) / 100 };
  }, [ledgerOnlyRows]);

  /**
   * 線上「實收」＝ **本地線上投影單 ∪ Ledger 已付款單**（按 Ledger order id 去重，本地為準）。
   *
   * 🔴 2026-09-14（商家口徑「實收＝實際收到嘅錢」）：
   * - 只數 Ledger → 會漏「本地已收錢但 Ledger 未同步（未 `completed`／未付款）」嗰筆
   *   （實案：訂單 002 = MOP 38，本地顯示已完成、Ledger 側冇 ⇒ 交班少 38）；
   * - 只數本地 → 會漏從未入 POS DB 嘅線上單（kiosk／線上點餐）；
   * ⇒ 兩邊聯集、按 id 去重，同報表「逐張單加總」同一口徑。
   */
  const ledgerOnlineMop = Math.round((onlineLocalMop + ledgerOnlyOnline.amountMop) * 100) / 100;
  const ledgerOnlineCount = onlineLocalOrders.length + ledgerOnlyOnline.count;
  /** `false` = Ledger 清單讀唔到（只計到本地線上單），UI 要標示。 */
  const ledgerOnlineIsPaidSum = ledgerPaidOrders !== null;

  /**
   * 可安全補推嘅目標：Ledger 未 `completed`，**但本地 POS 已經 `settled`** 嘅線上單。
   *
   * 🔴 安全閘：本地未完成嘅（例如快餐仲製作中、或堂食未結帳）**唔可以**補推 ——
   * 推上去等於向 Ledger 謊報「已完成」，客人端／對帳都會錯。
   * 只有「本地已結帳（＝真係完成）」先補，咁樣補推係還原真相，唔係造數。
   */
  const backfillTargets = useMemo(() => {
    const settledOnlineIds = new Set(
      orders
        .filter((o) => !!o.onlineOrderId && o.status === "settled")
        .map((o) => o.onlineOrderId as string),
    );
    return (ledgerPaidOrders?.incompleteIds ?? []).filter((id) => settledOnlineIds.has(id));
  }, [ledgerPaidOrders, orders]);

  /**
   * 明細用：今日**所有**已結帳本地單 —— **包括帶 `onlineOrderId` 嘅線上投影單**
   * （掃碼／排位／快餐採納：本地有真實收款記錄），並標「線上」chip 分辨。
   *
   * 🔴 2026-09-14 商家要求：舊版明細只列 `!onlineOrderId`（`isLocalPosOrder`），
   * 令 002 呢類線上交單喺交班明細**完全消失**（金額卻計入帳）→ 對數對唔到張單。
   * 退款單照樣唔列（口徑同上面「退款」統計一致）。
   */
  const detailOrders = useMemo(
    () =>
      orders.filter((o) => orderMatchesReportRange(o, "today") && o.status === "settled"),
    [orders],
  );

  /** 明細兩個小計（令明細 ↔ 支付方式分項／線上實收 一眼對得上）。 */
  const detailSplit = useMemo(() => {
    let offlineCount = 0;
    let offlineMop = 0;
    let onlineCount = 0;
    let onlineMop = 0;
    for (const o of detailOrders) {
      if (o.onlineOrderId) {
        onlineCount += 1;
        onlineMop += o.total || 0;
      } else {
        offlineCount += 1;
        offlineMop += o.total || 0;
      }
    }
    // Ledger 純線上單（從未入 POS DB）：同樣計入「線上」小計，令明細合計 = 卡片合計。
    onlineCount += ledgerOnlyRows.length;
    onlineMop += ledgerOnlyRows.reduce((s, o) => s + (Number(o.total ?? o.paidAmount ?? 0) || 0), 0);
    return {
      offlineCount,
      offlineMop: Math.round(offlineMop * 100) / 100,
      onlineCount,
      onlineMop: Math.round(onlineMop * 100) / 100,
    };
  }, [detailOrders, ledgerOnlyRows]);

  // 訂單明細（逐筆）＝ ① 本地已結帳單（含線上投影，標「線上」）
  //                    ＋ ② **Ledger 純線上單**（從未入 POS DB，例如取餐碼 001／005 預約單；標「線上」+ 取餐碼）。
  // 🔴 2026-09-14：退款單唔列出（商家口徑「退款了就不應該顯示」）；但**線上單一定要列出** ——
  // 舊版只列本地單，令線上單金額計入帳但明細見唔到，商家一定問「點解明細冇線上訂單／點解唔見 001、005」。
  const orderDetailRows = useMemo<OrderDetailRow[]>(() => {
    const localRows: OrderDetailRow[] = detailOrders.map((o) => ({
      id: o.id,
      orderNo: o.localOrderNo,
      table: o.tableName || o.tableId,
      receivable:
        o.items.reduce((sum, it) => sum + it.price * it.quantity, 0) +
        (o.serviceChargeAmount ?? 0) +
        (o.taxAmount ?? 0),
      paid: o.total,
      method: o.paymentMethod ?? "未記錄",
      cashier: o.settledByName ?? o.settledBy ?? "未記錄",
      settledAt: o.originalSettledAt ?? o.updatedAt,
      // 折扣 / 免單 / 抹零備註（2026-09-11 需求 #2）：推導邏輯集中喺 order-notes，
      // 同報表明細、訂單紀錄用同一套，確保三處完全一致。
      notes: buildOrderDetailNotes(o),
      // 線上投影單（帶 onlineOrderId）顯示「線上」chip，同線下單一眼分得開。
      online: !!o.onlineOrderId,
    }));

    const remoteRows: OrderDetailRow[] = ledgerOnlyRows.map((o) => {
      const paid = Number(o.total ?? o.paidAmount ?? 0) || 0;
      const subtotal = Number(o.subtotalBeforeDiscount ?? o.total + (o.discountAmount ?? 0));
      return {
        id: o.id,
        pickupCode: o.pickupCode,
        table: ledgerFulfillmentLabel(o.fulfillmentType),
        receivable: Number.isFinite(subtotal) && subtotal > 0 ? subtotal : paid,
        paid,
        method: paymentModeLabel(o.paymentMode) || "線上單",
        cashier: "客人",
        settledAt: o.updatedAt ?? o.createdAt ?? "",
        notes: buildOnlineOrderDetailNotes(o.discountAmount),
        online: true,
      };
    });

    return [...localRows, ...remoteRows].sort((a, b) => {
      const ta = a.settledAt ? Date.parse(a.settledAt) : 0;
      const tb = b.settledAt ? Date.parse(b.settledAt) : 0;
      return tb - ta;
    });
  }, [detailOrders, ledgerOnlyRows]);

  /**
   * 拉今日 Ledger 數據（RPC 摘要 + 已付款單加總）。
   * 抽成 callback 係因為「補推線上單狀態」之後要即刻重新拉一次（見 `handleBackfillOnlineCompleted`）。
   */
  const refreshLedgerToday = useCallback(async () => {
    setLedgerTodayError(null);
    // 每次重跑都落返「未完成」→ 全頁 loading（商家要求 refresh 期間顯示 loading）。
    setLedgerLoaded(false);
    try {
      const restored = await restoreLedgerSession();
      if (!restored) {
        setLedgerToday(null);
        setLedgerPaidOrders(null);
        setLedgerTodayError("尚未登入 Ledger，無法讀取今日線上訂單。");
        return;
      }
      const data = await getMerchantReportSummary("today");
      setLedgerToday(data);
      // 線上「實收」＝已付款單逐張加總（含未完成單）。RPC `order_paid_avos` 只認「已完成」，
      // 客人已付款但未推 completed 嘅單會漏 ⇒ 唔可以單靠 RPC 做「實收」。
      const merchantId = loadAuthSession()?.merchantId ?? null;
      if (merchantId) {
        try {
          setLedgerPaidOrders(await sumPaidLedgerOrders({ merchantId, range: "today" }));
        } catch {
          setLedgerPaidOrders(null);
        }
      } else {
        setLedgerPaidOrders(null);
      }
    } catch (error) {
      setLedgerToday(null);
      setLedgerPaidOrders(null);
      setLedgerTodayError(error instanceof Error ? error.message : "讀取今日線上報表失敗");
    } finally {
      // 🔴 放 `finally`：上面「未登入 Ledger」嗰條 `return` 同 catch 都係「未拿到線上數」
      // 兩種合法結局（UI 各自有明確錯誤橫幅）。若唔放行，錯咗之後全頁會**永久 loading**，
      // 用戶連「尚未登入 Ledger」嗰句提示都睇唔到 —— 比半截畫面更差。
      setLedgerLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshLedgerToday();
  }, [refreshLedgerToday]);

  /**
   * 🔴 2026-09-15 交班歷史雲端回填（商家明確要求：「我在別的電腦登入這個帳號，需要上雲！」）。
   *
   * 交班記錄本身**一直有上雲**（每次 close 會將成個 record 寫入 `pos_shifts.summary`），
   * 但舊版「交班歷史」表只讀本機 localStorage（`macau-pos/stores/<storeId>/shift-history`）
   * ⇒ 換機／清 cache／另一部機交班 → 表格空白，令人誤以為「冇上 DB」。
   *
   * 呢度由 `/api/pos/shift?history=1` 拉返已收工班次：
   * - **本機為先**（同 id 保留本機版本 → 唔會覆蓋本地嘅備註編輯），雲端只補本機冇嘅；
   * - 合併後按 closedAt 新→舊排序、上限 60 筆，並**寫返本機**（下次離線都見到）；
   * - 失敗（離線／未配置）靜默保留本機記錄，絕不令歷史變空。
   */
  const refreshShiftHistoryFromCloud = useCallback(async () => {
    const storeId = resolveStoreId();
    if (!storeId || !readNetworkOnline()) return;
    try {
      const cloud = await fetchServerShiftHistory(storeId, 60);
      setHistoryCloudCount(cloud.length);
      if (cloud.length === 0) return;
      setShiftHistory((prev) => {
        const byId = new Map<string, ShiftHistoryRecord>();
        for (const row of prev) byId.set(row.id, row);
        // 雲端為先（已收工班次嘅權威；備註改動亦已 PATCH 上雲），但：
        // ① 本機獨有嘅記錄（雲端未同步）保留 → 唔會消失；
        // ② 若本機備註比雲端新（例如啱啱改完、sync 未成功）→ 保留本機嗰個備註。
        for (const row of cloud) {
          const local = byId.get(row.id);
          if (!local) {
            byId.set(row.id, row);
            continue;
          }
          const merged: ShiftHistoryRecord = {
            ...row,
            serverShiftId: local.serverShiftId ?? row.serverShiftId,
          };
          const localNoteTs = Date.parse(local.noteUpdatedAt ?? "");
          const cloudNoteTs = Date.parse(row.noteUpdatedAt ?? "");
          if (Number.isFinite(localNoteTs) && (!Number.isFinite(cloudNoteTs) || localNoteTs > cloudNoteTs)) {
            merged.closingNote = local.closingNote;
          }
          byId.set(row.id, merged);
        }
        const merged = [...byId.values()]
          .sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0))
          .slice(0, 60);
        saveShiftHistory(merged);
        return merged;
      });
    } catch {
      // 離線 / 未配置：保留本機記錄（唔彈錯、唔清空）。
    }
  }, []);

  useEffect(() => {
    void refreshShiftHistoryFromCloud();
  }, [refreshShiftHistoryFromCloud]);

  /**
   * 補推：把「已付款但 Ledger 未 `completed`」嘅今日線上單逐張推上梯頂。
   *
   * 為何需要：`completeOnlinePaidOrder()`（客人已支付，完成訂單）同 `confirmPayment()` 舊寫法
   * **完全冇推 Ledger**（2026-09-14 已修），所以之前嗰啲單會停留喺 `accepted`/`preparing`
   * ⇒ Ledger 報表唔認嗰筆錢 ⇒ 交班「線上線下合計」少算。新單唔會再出現，舊單用呢個補推。
   */
  const [backfillingLedger, setBackfillingLedger] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  async function handleBackfillOnlineCompleted() {
    const ids = backfillTargets;
    if (backfillingLedger || ids.length === 0) return;
    setBackfillingLedger(true);
    setBackfillStatus(null);
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      const result = await syncOnlineDineInCompletionById(id);
      if (result.ok) ok += 1;
      else failures.push(result.error ?? "未知錯誤");
    }
    setBackfillingLedger(false);
    setBackfillStatus(
      failures.length === 0
        ? `已補推 ${ok} 張線上單至「已完成」。`
        : `補推完成：成功 ${ok} 張、失敗 ${failures.length} 張（${failures[0]}）`,
    );
    await refreshLedgerToday();
  }

  useEffect(() => {
    const acc = loadAuthSession()?.account;
    if (!acc) return;
    void fetchPurchaseSummary(acc, "today").then(setPurchaseToday);
  }, []);

  const queueSummary = (() => {
    const queue = loadQueue();
    const printJobs = loadPrintJobs();
    const events = summarizeQueueEvents(queue, resolveStoreId());
    return {
      // docs/111：「待同步」只計**真正會被推送**嘅事件 —— 剔走
      //   ① 外店 / 無 storeId（跨店閘口永遠skip，一世推唔到）
      //   ② 去重輸家（同 entityId 有更新事件喺度，v1 模式下永遠選唔中）
      // 冇剔之前，呢個數會無限期累積，交班畫面彈「仲有 100 筆未同步」但其實
      // 數據一早喺雲端。failed 係永久失敗（server 連續拒收 5 次），
      // 唔係「待同步」。如果當佢係待同步，交班記錄會講大話（話有 N 筆「待同步」
      // 但其實永遠上唔到 DB），同落單畫面嘅 amber 提示卡對唔住。
      pendingEvents: events.pendingEvents,
      failedEvents: events.failedEvents,
      // 推唔到但已有明確原因（外店 / 無歸屬），唔會阻住交班，但要畀用家知
      skippedEvents: events.skippedEvents,
      pendingPrints: printJobs.filter((item) => item.status === "pending").length,
    };
  })();
  const expectedCash = useMemo(() => {
    const cashKeys = ["現金", "會員餘額 + 現金", "優惠券 + 現金"];
    return Object.entries(summary.paymentBreakdown)
      .filter(([key]) => cashKeys.some((cashKey) => key.includes(cashKey)))
      .reduce((sum, [, value]) => sum + (value?.paid ?? 0), 0);
  }, [summary.paymentBreakdown]);
  const filteredShiftHistory = useMemo(() => {
    const rows = shiftHistory.filter((row) => {
      // 🔴 日期比較一律用**澳門日曆日**（同格內顯示、同日分隔列同一把尺）：
      // 舊寫法用 `closedAt.slice(0, 10)`（UTC）→ 澳門 00:00–08:00 收工嘅班次會被算落前一日。
      const day = shiftHistoryDayKey(row.closedAt);
      if (historyDateFrom && day < historyDateFrom) return false;
      if (historyDateTo && day > historyDateTo) return false;
      if (historyEmployeeFilter && (row.employeeAccount ?? "") !== historyEmployeeFilter) return false;
      return true;
    });
    // 新 → 舊（同日按 closedAt 新→舊）；分頁按日切片一定要有穩定次序。
    return rows.sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0));
  }, [historyDateFrom, historyDateTo, historyEmployeeFilter, shiftHistory]);

  /** 交班歷史按「澳門日曆日」分組（一日可以有多個班次）→ 分頁最小單位。 */
  const shiftHistoryDayGroups = useMemo(() => {
    const groups: Array<{ day: string; label: string; rows: typeof filteredShiftHistory }> = [];
    const byDay = new Map<string, (typeof groups)[number]>();
    for (const row of filteredShiftHistory) {
      const day = shiftHistoryDayKey(row.closedAt);
      if (!day) continue;
      let group = byDay.get(day);
      if (!group) {
        group = { day, label: shiftHistoryDayLabel(day), rows: [] };
        byDay.set(day, group);
        groups.push(group);
      }
      group.rows.push(row);
    }
    return groups;
  }, [filteredShiftHistory]);

  /** 已載入幾多日（「查看更多」累加 10 天；框架尺寸固定，多咗只會內部滾動）。 */
  const [historyLoadedDays, setHistoryLoadedDays] = useState(SHIFT_HISTORY_PAGE_DAYS);
  // 篩選條件一改就回到第一頁，避免「篩完之後停喺第 30 天」嘅空框。
  useEffect(() => {
    setHistoryLoadedDays(SHIFT_HISTORY_PAGE_DAYS);
  }, [historyDateFrom, historyDateTo, historyEmployeeFilter]);

  const shiftHistoryVisibleGroups = useMemo(
    () => shiftHistoryDayGroups.slice(0, historyLoadedDays),
    [shiftHistoryDayGroups, historyLoadedDays],
  );
  const shiftHistoryVisibleRows = useMemo(
    () => shiftHistoryVisibleGroups.reduce((sum, group) => sum + group.rows.length, 0),
    [shiftHistoryVisibleGroups],
  );
  const shiftHistoryHasMore = shiftHistoryDayGroups.length > shiftHistoryVisibleGroups.length;

  const historyEmployeeOptions = useMemo(
    () =>
      Array.from(
        new Map(
          shiftHistory
            .filter((row) => row.employeeAccount)
            .map((row) => [row.employeeAccount as string, row.employeeName ?? row.employeeAccount ?? "未記錄"]),
        ).entries(),
      ),
    [shiftHistory],
  );

  /**
   * 進入 step3 打印預覽時固化快照：closedAt 用當下時間、單號按當日班次序號生成。
   * 之後「打印／跳過 → closeShift」都用同一份，保證 預覽 == 紙本 == 交班記錄。
   */
  function buildShiftDetailSnapshot(closedAt: string, diffInput: string, noteInput: string): ShiftDetailSnapshot {
    const parsed = interpretCashDiff(diffInput);
    const diffValue = parsed.ok && parsed.filled && parsed.diff !== 0 ? parsed.diff : undefined;
    const actualValue =
      typeof diffValue === "number" ? Math.round((expectedCash + diffValue) * 100) / 100 : undefined;
    const day = closedAt.slice(0, 10);
    const seq = shiftHistory.filter((row) => row.closedAt.slice(0, 10) === day).length + 1;
    return {
      closedAt,
      shiftNo: `${day}-${String(seq).padStart(2, "0")}`,
      storeName: loadBootstrapCache()?.storeName ?? "",
      employee:
        authSession?.name ?? authSession?.account ?? shift.employeeName ?? shift.employeeAccount ?? "未記錄",
      openedAt: shift.openedAt,
      store: {
        count: summary.count,
        revenue: summary.revenue,
        receivableTotal: summary.receivableTotal,
        paidTotal: summary.paidTotal,
        prepaid: summary.prepaid,
        refundCount: summary.refundCount,
        refundAmount: summary.refundAmount,
        // 2026-09-17 淨額口徑：退款單未退部分 + 淨實收（見 summarizeClosedOrders 註解）。
        refundedRemainder: summary.refundedRemainder,
        netPaidTotal: summary.netPaidTotal,
      },
      online: ledgerToday
        ? {
            orderCount: ledgerToday.orderCount,
            // 🔴 「已付線上營業額」＝**已付款單加總**（＝實際收到嘅錢，含未推 completed 嘅單）。
            // 交班單「線上線下合計（實收金額合計）」= store.paidTotal + 呢個數 ⇒ 紙本同報表一致。
            paidMop: ledgerOnlineMop,
            // 以下兩個係 Ledger「已完成」口徑嘅組成細項（加起來可能少過 paidMop ＝未完成單未計）。
            balancePaidMop: ledgerToday.orderBalancePaidMop,
            inStorePaidMop: ledgerToday.orderInStorePaidMop,
          }
        : null,
      payments: Object.entries(summary.paymentBreakdown)
        .map(([method, bucket]) => ({ method, receivable: bucket.receivable, paid: bucket.paid, count: bucket.count }))
        .sort((a, b) => b.paid - a.paid),
      purchase: purchaseToday?.summary
        ? { paid: purchaseToday.summary.paid, unpaid: purchaseToday.summary.unpaid }
        : null,
      cash: { expected: expectedCash, actual: actualValue, diff: diffValue },
      pendingEvents: queueSummary.pendingEvents,
      failedEvents: queueSummary.failedEvents,
      skippedEvents: queueSummary.skippedEvents,
      pendingPrints: queueSummary.pendingPrints,
      note: noteInput.trim(),
    };
  }

  /**
   * 🔴 2026-09-15（商家要求）：交班頁「全有或全無」渲染閘。
   *
   * ## 為何
   *
   * 交班頁有兩個**互相依賴**嘅數據源：
   * ① 訂單側：本機 `loadOrders()` + 雲端 `/api/pos/state` merge（`refreshOrders`）；
   * ② Ledger 側：`getMerchantReportSummary("today")` + `sumPaidLedgerOrders()`（`refreshLedgerToday`）。
   *
   * 「線上線下合計（實收）」= `summary.paidTotal + ledgerOnlineMop`，
   * 即係**兩邊都要有數**先算得出。舊寫法淨係喺 Ledger 區塊顯示一句
   * 「載入今日線上報表…」，其餘區塊（金額合計、支付拆分、訂單明細）照樣先渲染 ——
   * 用戶會見到「線上線下合計」先出一個**未含線上**嘅數，Ledger 返嚟之後再跳一次。
   * 商家原話：「只要任何一項數據尚未取得，整頁就應維持 loading」。
   *
   * ## 口徑
   *
   * - 初次 mount：兩個旗標都係 `false` → 整頁 loading，直到兩邊都完成；
   * - 自動刷新（focus / online 事件重跑 `refreshOrders`、補推後重跑 `refreshLedgerToday`）：
   *   兩者開頭都會落返 `false` → 整頁 loading，齊返先一次過換畫面。
   */
  const pageReady = ordersLoaded && ledgerLoaded;

  /**
   * 重打交班單（2026-09-10 改走「交班模板」管線）。
   *
   * 以前呢度有第二份硬編行文（`buildShiftPrintLines`），同交班即印嗰份
   * （`shiftDetailToLines`）**內容唔一致**：重打冇「線上訂單張數 / 餘額扣點 /
   * 到店貨到付款」，分節標題亦少咗「（線下 POS）」→ 同一張單「即印」同「重打」對唔上。
   *
   * 而家兩條路徑都收斂成 `buildShiftPrintJobs()`（同一個 builder、同一份
   * `buildShiftContent()`、同一個商家設計嘅 `printTemplates.shift` 模板）：
   * 舊記錄冇完整快照時，`shiftRowToSettlement()` 會由扁平欄位盡量還原。
   */
  function reprintShiftRecord(row: (typeof shiftHistory)[number]) {
    if (reprintingShiftId) return;
    setReprintingShiftId(row.id);
    // 2026-09-08：重打都用「交班單打印機」指定；冇指定 fallback 收據打印機。
    const shiftPrinter = pickShiftPrinter(deviceConfig);
    const printerName = shiftPrinter?.name ?? "收據打印機";
    const now = new Date().toISOString();
    const [printJob] = buildShiftPrintJobs({
      data: shiftRowToSettlement(row),
      orderId: row.id,
      orderNo: row.shiftNo ? `交班單重打 ${row.shiftNo}` : `交班單重打 ${row.closedAt.slice(0, 10)}`,
      printerId: shiftPrinter?.id,
      printerName,
    });
    persistMergedPrintJobs([printJob]);
    const event: QueueEvent = {
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: printJob.id,
      payload: printJob,
      status: "pending",
      createdAt: now,
    };
    saveQueue(enqueueEvents(loadQueue(), withStoreScope([event])));
    // 入隊即觸發 flush worker（以前要等 30s interval）
    notifyQueueChanged();
    setStatus(`已把 ${row.closedAt.slice(0, 10)} 的交班單加入重打隊列。`);
    setReprintingShiftId(null);
  }

  async function forceSyncBeforeClose() {
    if (!readNetworkOnline()) {
      setStatus("目前離線，無法強制同步。請恢復網絡後再交班。");
      return false;
    }
    // 只 retry 真正「會 retry」嘅 pending event。
    // ⚠️ 千祈唔好夾埋 failed event：failed 係 server 連續拒收 5 次嘅永久失敗，
    // 再 POST 落 /api/pos/sync 一樣會被拒（例如 storeId 唔啱），而呢度一 check
    // result.ok 就會 return false —— 交班就咁**永久閂唔到**（2026-09-03 發現嘅
    // regression：之前改呢度加 result.ok check 時，冇諗到 failed 都會被揀入 batch）。
    // failed 由落單畫面嘅「重試同步」掣處理（retryFailedSyncEvents），交班只專注 pending。
    //
    // 🛡️ 跨店隔離 L4（2026-09-06 修）：呢條係**獨立於 doFlush 嘅第二條 flush 路徑**，
    // 以前只 filter pending、冇 store 過濾 → 交班嗰刻會將 queue 入面嘅外店 / legacy
    // 事件用當前登入 merchantId 蓋章推上雲（跨店串號入口之一）。家陣必須過
    // filterEventsForCurrentStore —— 只同步屬於當前店嘅事件。
    const retryable = filterEventsForCurrentStore(loadQueue().filter((item) => item.status === "pending"));
    const failedCount = loadQueue().filter((item) => item.status === "failed").length;
    if (retryable.length === 0) {
      if (failedCount > 0) {
        setStatus(
          `有 ${failedCount} 筆資料永久同步失敗（伺服器連續拒收），已跳過，` +
            `唔會阻住交班。請稍後喺落單畫面撳「重試同步」，或聯絡技術支援。`,
        );
      }
      return true;
    }
    let res: Response;
    try {
      res = await fetch("/api/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...posDeviceAuthHeaders() },
        body: JSON.stringify({
          events: retryable,
          storeId: resolveStoreId(),
        }),
      });
    } catch {
      setStatus("強制同步失敗，請檢查網絡或稍後重試。");
      return false;
    }

    // ⚠️ 一定要 check result.ok：以前唔 check 就照 mark synced + 報「已同步 N 筆」。
    // 若 server 拒收（400/500，例如 storeId 唔啱），啲單其實上唔到 DB，
    // 但因為變咗 synced 就**永遠唔會再重試**，交班畫面仲要顯示成功 ——
    // 交班係最需要確保資料落 DB 嘅一刻，唔可以報假數。
    // （對照 sync-flush.ts 嘅 doFlush 係有 check result.ok 嘅，得呢度漏咗。）
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      setStatus(
        `同步失敗（HTTP ${res.status}）：${detail.slice(0, 200) || "伺服器拒收"}。` +
          `資料仲喺本機未上傳，請稍後再試或聯絡技術支援。`,
      );
      return false;
    }

    // ⚠️ 千祈唔好寫 `saveQueue(retryable.map(...))`：嗰個係**成條 queue 覆寫**，
    // 交班成功一刻會靜默剷走晒 failed 事件、外店事件、同其他冇入今次 batch 嘅事件
    // （2026-09-08 修）。一定要以「成條 queue」為底做 merge。
    const ackedIds = new Set(retryable.map((item) => item.id));
    if (isOutboxV2Enabled()) {
      // outbox：上咗雲就剷走，queue 淨留未上雲嘅工作
      saveQueue(loadQueue().filter((item) => !ackedIds.has(item.id)));
    } else {
      saveQueue(
        loadQueue().map((item) => (ackedIds.has(item.id) ? { ...item, status: "synced" as const } : item)),
      );
    }
    setStatus(
      `已同步 ${retryable.length} 筆待辦資料，準備交班。` +
        (failedCount > 0 ? `（另有 ${failedCount} 筆永久失敗已跳過）` : ""),
    );
    return true;
  }

  // 2026-09-07（問題一）：開工 = 本地即時生效 + 上雲。server 已有 active（另一部機開咗）→ 以 server 為準。
  async function openShiftNow() {
    const session = loadAuthSession();
    const next: typeof shift = {
      ...shift,
      openedAt: new Date().toISOString(),
      closedAt: undefined,
      openingNote: shiftNote,
      employeeAccount: session?.account ?? shift.employeeAccount,
      employeeName: session?.name ?? shift.employeeName,
      overtimeAckedAt: undefined,
      serverSynced: false,
      lastCloseSummary: undefined, // 新班次唔好帶上一班嘅兜底統計
    };
    setShift(next);
    saveShiftState(next);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: next } }));
    setStatus("已開工。");
    setShiftNote(""); // 開工備註已寫入 openingNote，唔好留低畀交班彈窗誤用

    const storeId = resolveStoreId();
    if (!storeId) return;
    if (!readNetworkOnline()) {
      setStatus("已離線開工：恢復網絡後會自動同步到雲端（其他裝置會見到已開工）。");
      return;
    }
    try {
      const result = await serverOpenShift({
        storeId,
        openedAt: next.openedAt,
        employeeAccount: next.employeeAccount,
        employeeName: next.employeeName,
        openingNote: next.openingNote,
      });
      if (result.conflict && result.active) {
        // 另一部機已經開咗工 → 唔開新班次，直接採納 server 開工時間（解決「開工時間唔更新」）。
        const merged = serverActiveToLocal(result.active, loadShiftState());
        delete merged.closedAt;
        delete merged.closingNote;
        setShift(merged);
        saveShiftState(merged);
        window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: merged } }));
        setStatus(
          `本店已有班次進行中（另一部裝置已於 ${formatMacauDateTime(merged.openedAt)} 開工），已同步該開工狀態。`,
        );
        return;
      }
      saveShiftState({ ...loadShiftState(), serverSynced: true });
      setStatus("已開工，並已同步到雲端（其他裝置會見到已開工）。");
    } catch {
      setStatus("已開工，但暫時未能同步伺服器；恢復網絡後會自動補同步。");
    }
  }

  /**
   * 結數交班（2026-09-08 改）：由 step3「打印預覽」嘅「打印／跳過」觸發。
   * @param detail  step3 固化嘅交班明細快照——預覽 == 紙本 == 交班記錄 同源；
   *                冇傳（防禦路徑）就用當下 state 現場建一份。
   * @param print   true = 交班並入打印隊列（由「交班單打印機」出紙）；false = 跳過打印直接完成交班。
   */
  async function closeShift(diffInput: string, noteInput: string, detail?: ShiftDetailSnapshot, print = true) {
    if (closingShift) return;
    setClosingShift(true);
    const snapshot = detail ?? buildShiftDetailSnapshot(new Date().toISOString(), diffInput, noteInput);
    const now = snapshot.closedAt;
    // 差額語義：留空／0 = 無落差（唔寫入實收現金）；非 0 = 有落差（負 = 少收、正 = 多收）。
    // 系統推算「實收現金 = 應收現金 + 差額」，但系統金額一概唔會因差額而改動——
    // 差額只作為記錄 + 打印用途（錯數不可經此「修正」系統數，只可備註說明）。
    const diffValue = snapshot.cash.diff;
    const actualValue = snapshot.cash.actual;
    const closingNoteText = snapshot.note;
    const ok = await forceSyncBeforeClose();
    if (!ok) {
      setClosingShift(false);
      return;
    }

    /**
     * ── 「關店總掣」（2026-09-18）────────────────────────────────────────
     * 喺呢個位執行，係因為：
     * ① 已經過咗 `forceSyncBeforeClose()`（網絡確認可用）；
     * ② 早過下面**兩個 early return**（打印總開關關咗 / server close 失敗）——
     *    呢兩個 return 都會完成交班，關店唔可以喺佢哋之後，否則就會漏。
     *
     * ⚠️ 讀值要喺 `runCloseGate()` **之前**捕捉：佢一 call 就會樂觀更新
     *    module state，再讀就係新值（同 `useStoreOpenToggle` 捕捉意圖同一個道理）。
     *
     * ⚠️ 唔勾 = 完全唔碰（連 `lastCloseGate` 都唔寫），交班行為同以前一模一樣。
     */
    let gateResult: CloseGateResult | null = null;
    if (closeStoreGate) {
      gateResult = await runCloseGate({
        storeOpen: storeOpenStatus.isOpen,
        merchantEnabled: onlineOrderConfig.merchantEnabled,
      });
      setLastCloseGate(gateResult);
    } else {
      setLastCloseGate(null);
    }

    const historyRecord = {
      id: `shift-${now}`,
      employeeAccount: authSession?.account,
      employeeName: authSession?.name,
      openedAt: shift.openedAt,
      closedAt: now,
      openingNote: shift.openingNote,
      closingNote: closingNoteText,
      actualCash: actualValue,
      cashDifference: diffValue,
      /** 交班單序號（重打認單用）。 */
      shiftNo: snapshot.shiftNo,
      /** 交班當刻店名快照（重打印表頭用）。 */
      storeName: snapshot.storeName || undefined,
      settledCount: snapshot.store.count,
      revenue: snapshot.store.revenue,
      /** 線下 POS 應收金額合計（菜品原價合計 + 服務費 + 稅）。 */
      receivableTotal: snapshot.store.receivableTotal,
      /** 線下 POS 實收金額合計（order.total 合計）。 */
      paidTotal: snapshot.store.paidTotal,
      /** 線上 Ledger 實收金額（orderPaidMop）。線上應收暫時未拉 listMerchantOrders，留 null。 */
      onlinePaidMop: snapshot.online?.paidMop ?? 0,
      prepaid: snapshot.store.prepaid,
      refundCount: snapshot.store.refundCount,
      refundAmount: snapshot.store.refundAmount,
      /** 今日買貨成本（已付）快照（重打交班明細用）。 */
      purchasePaid: snapshot.purchase?.paid,
      expectedCash: snapshot.cash.expected,
      paymentBreakdown: Object.fromEntries(
        snapshot.payments.map((bucket) => [
          bucket.method,
          { receivable: bucket.receivable, paid: bucket.paid, count: bucket.count },
        ]),
      ),
      pendingEvents: snapshot.pendingEvents,
      failedEvents: snapshot.failedEvents,
      skippedEvents: snapshot.skippedEvents,
      pendingPrints: snapshot.pendingPrints,
      /**
       * 完整結算快照（2026-09-10）：重打交班單時原封還原同一份內容。
       * 上面啲扁平欄位係畀列表 / CSV / server close 用；呢個係「紙本真源」。
       */
      detail: snapshot,
    };
    const closeSummary = historyRecord as unknown as Record<string, unknown>;
    const next = {
      ...shift,
      openedAt: undefined,
      closedAt: now,
      closingNote: closingNoteText,
      actualCash: actualValue,
      cashDifference: diffValue,
      // 2026-09-07：收工統計本地兜底 —— server close 成功後會清走；失敗就留低，
      // reconcile「補 close」時帶埋上 server，避免 server 班次永久缺統計。
      lastCloseSummary: closeSummary,
    };

    // 2026-09-07（問題一）：收工狀態上雲 —— forceSyncBeforeClose 已保證 online。
    // 失敗唔 block 收工/打印，但會喺狀態列提示；reconcile 會喺下次 online 自動補 close。
    let serverCloseFailed = false;
    /** 雲端 `pos_shifts` row id —— 之後改備註要 PATCH 返呢一行（見 syncHistoryNoteToCloud）。 */
    let serverShiftId: string | undefined;
    const closingStoreId = resolveStoreId();
    if (!closingStoreId) {
      serverCloseFailed = true; // 冇店舖識別都當同步失敗處理（唔好誤報「雲端已同步」）
    } else if (readNetworkOnline()) {
      try {
        const closed = await serverCloseShift({
          storeId: closingStoreId,
          closingNote: closingNoteText || undefined,
          actualCash: actualValue,
          cashDifference: diffValue,
          summary: historyRecord as unknown as Record<string, unknown>,
        });
        serverCloseFailed = !closed;
        serverShiftId = closed?.id;
      } catch {
        serverCloseFailed = true;
      }
    } else {
      serverCloseFailed = true; // 收工瞬間斷線（極端）：留兜底，reconcile 補
    }

    // server close 成功 → 本地唔再需要留兜底統計；失敗就留低畀 reconcile 補帶。
    const finalNext = serverCloseFailed ? next : { ...next, lastCloseSummary: undefined };
    setShift(finalNext);
    saveShiftState(finalNext);
    // 有 server row id 就寫入記錄：令「交班後改備註」可以直接 PATCH 雲端（跨機生效）。
    const savedRecord: ShiftHistoryRecord = serverShiftId ? { ...historyRecord, serverShiftId } : historyRecord;
    const nextHistory = [savedRecord, ...shiftHistory].slice(0, 60);
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: finalNext } }));

    // ── 打印（2026-09-08）──
    // 打印機：DeviceConfig.shiftPrinterId 指定優先（設備設定 → 打印機 → 交班單打印機），
    // 指定機不可用 → fallback 收據打印機。「跳過」時整段唔入隊列，直接完成交班。
    const shiftPrinter = pickShiftPrinter(deviceConfig);
    const printerName = shiftPrinter?.name ?? "收據打印機";

    // 紙本內容 = 商家設計嘅「交班模板」+ 呢份快照（`buildShiftContent`）。
    // 冇 G 區（待同步/技術狀態唔上紙本）；預覽（step3 結構化 UI）同紙本同源。
    if (print) {
      // 交班單總開關（2026-09-08）：商家可關閉「交班單」自動打印。
      // ⚠️ 重打交班單（reprintShiftRecord）係**手動**掣，唔受呢個影響，
      // 即使熄咗都可以喺交班歷史撳「重打」補印。
      if (!isPrintContentEnabled("shift")) {
        // ⚠️ 呢個係 early return —— 關店總掣已經喺上面行咗（一定要保持咁樣），
        //    但結果要帶埋出狀態列，否則「收咗班但仲接單」會靜靜地冇人知。
        setStatus(
          "已交班（交班單打印已關閉，如需紙本請到交班歷史「重打」）。" +
            (gateResult ? describeCloseGate(gateResult) : ""),
        );
        setClosingShift(false);
        return;
      }
      const [printJob] = buildShiftPrintJobs({
        data: snapshot,
        orderId: `shift-${now}`,
        orderNo: `交班單 ${snapshot.shiftNo}`,
        printerId: shiftPrinter?.id,
        printerName,
      });

      persistMergedPrintJobs([printJob]);

      const event: QueueEvent = {
        id: uid("evt"),
        type: "PRINT_JOB_CREATED",
        entityId: printJob.id,
        payload: printJob,
        status: "pending",
        createdAt: now,
      };

      // 🛡️ 跨店隔離 L1：交班單打印事件 stamp 當前店。
      const [stampedEvent] = withStoreScope([event]);

      const nextQueue = enqueueEvents(loadQueue(), [stampedEvent]);
      saveQueue(nextQueue);

      if (readNetworkOnline()) {
        // 🛡️ 跨店隔離 L4：呢條係第三條直接 flush 路徑（獨立於 doFlush / forceSyncBeforeClose），
        // 以前成條 nextQueue 照推 → 外店 / legacy 事件被當前 merchantId 蓋章上雲。必須過濾。
        // docs/111：淨推「呢一條」交班單事件 —— 以前成條 queue 照推，分分鐘超過 server
        // 200 條上限（413 → 成批失敗，交班單反而上唔到雲），亦唔應該順便推晒其他人嘅事件。
        const scoped = filterEventsForCurrentStore([stampedEvent]);
        if (scoped.length > 0) {
          try {
            const res = await fetch("/api/pos/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...posDeviceAuthHeaders() },
              body: JSON.stringify({
                events: scoped,
                storeId: resolveStoreId(),
              }),
            });
            // 一定要 check res.ok：以前唔 check 就照標 synced，server 拒收（400/500）嗰陣
            // 交班單其實上唔到雲，但因為變咗 synced 就永遠唔會再試。
            if (res.ok) {
              const scopedIds = new Set(scoped.map((item) => item.id));
              if (isOutboxV2Enabled()) {
                saveQueue(loadQueue().filter((item) => !scopedIds.has(item.id)));
              } else {
                saveQueue(
                  nextQueue.map((item) => (scopedIds.has(item.id) ? { ...item, status: "synced" } : item)),
                );
              }
            }
          } catch {
            // 保留待補傳
          }
        }
      }
    }

    setStatus(
      (print
        ? `已交班，交班明細（${snapshot.shiftNo}）已加入打印隊列，狀態已重置為待開工。`
        : `已交班（跳過打印，單號 ${snapshot.shiftNo}），狀態已重置為待開工。`) +
        (serverCloseFailed ? "（⚠️ 收工狀態未能同步雲端，將自動重試，其他裝置可能仍顯示已開工。）" : "（雲端已同步，其他裝置會顯示已收工。）") +
        // 關店總掣結果：全部成功／無需動作 → `describeCloseGate` 回 ""，唔會多餘加字。
        (gateResult ? describeCloseGate(gateResult) : ""),
    );
    setConfirmOpen(false);
    setPreviewData(null);
    setClosingShift(false);
  }

  /**
   * 🔴 2026-09-15：交班備註編輯要**跨機同步** —— 除了寫本機，亦 PATCH 返雲端 `pos_shifts.closing_note`。
   *
   * 目標行優先次序：① 記錄帶嘅 `serverShiftId`（交班時由 server close 回傳、或雲端回填時帶入）
   * → ② 用 `closedAt` 由 server 搵（±10 秒窗口，只限同一店）。
   * 失敗（離線／未配置／舊記錄搵唔到）→ 只更新本機並喺狀態列講清楚，**唔會靜默**。
   */
  async function syncHistoryNoteToCloud(record: ShiftHistoryRecord, note: string) {
    const storeId = resolveStoreId();
    if (!storeId || !readNetworkOnline()) {
      setStatus("已更新本機備註；離線中，未同步雲端。");
      return;
    }
    try {
      const ok = await updateServerShiftClosingNote({
        storeId,
        shiftId: record.serverShiftId,
        closedAt: record.closedAt,
        closingNote: note,
      });
      setStatus(
        ok ? "已更新備註並同步雲端（換機都見到）。" : "已更新本機備註；雲端搵唔到對應班次，未同步。",
      );
    } catch {
      setStatus("已更新本機備註；雲端同步失敗，請檢查網絡後再試。");
    }
  }

  function saveHistoryNote(recordId: string) {
    const note = (historyNoteDrafts[recordId] ?? "").trim();
    const target = shiftHistory.find((row) => row.id === recordId);
    const nextHistory = shiftHistory.map((row) =>
      row.id === recordId ? { ...row, closingNote: note, noteUpdatedAt: new Date().toISOString() } : row,
    );
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    setStatus("已更新交班歷史備註。");
    if (target) void syncHistoryNoteToCloud(target, note);
  }

  function deleteHistoryRecord(recordId: string) {
    const nextHistory = shiftHistory.filter((row) => row.id !== recordId);
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    setStatus("已刪除交班歷史。");
  }

  function exportShiftHistoryCsv() {
    if (exportingType) return;
    setExportingType("csv");
    if (filteredShiftHistory.length === 0 || typeof window === "undefined") {
      setStatus("目前沒有符合條件的交班歷史可導出。");
      setExportingType(null);
      return;
    }
    const rows = [
      ["交班時間", "員工", "營業額", "應收金額合計", "實收金額合計", "線上已付", "線上線下合計", "退款金額", "應收現金", "實收現金", "現金差額", "待同步事件", "永久失敗", "無歸屬事件", "待補傳打印", "備註"].join(","),
      ...filteredShiftHistory.map((row) =>
        [
          formatMacauDateTime(row.closedAt),
          row.employeeName ?? row.employeeAccount ?? "未記錄",
          row.revenue,
          row.receivableTotal ?? "",
          row.paidTotal ?? "",
          row.onlinePaidMop ?? "",
          (row.paidTotal ?? 0) + (row.onlinePaidMop ?? 0),
          row.refundAmount,
          row.expectedCash,
          row.actualCash ?? "",
          row.cashDifference ?? "",
          row.pendingEvents,
          row.failedEvents ?? "",
          row.skippedEvents ?? "",
          row.pendingPrints,
          row.closingNote ?? "",
        ]
          .map((cell) => csvCell(cell))
          .join(","),
      ),
    ];
    const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "交班歷史.csv";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("交班歷史 CSV 已導出。");
    setExportingType(null);
  }

  /**
   * 🔴 2026-09-15（商家要求）：**移除 Excel 導出，只保留 CSV**。
   *
   * 原本嘅「導出 Excel」只係一個副檔名 `.xls` 嘅 HTML `<table>`（Excel 開會出格式警告），
   * 而且同一批欄位要喺兩條導出函式各自維護 → 欄位口徑早晚漂移。
   * CSV（UTF-8 BOM，Excel 直接開得正常）已涵蓋全部欄位，導出範圍＝**篩選後全部**（唔受 10 天分頁限制）。
   */

  // —— 結數交班彈窗派生值（step 1 填寫時即時推算；step 2 二次確認顯示同一批數）——
  const parsedClosingDiff = interpretCashDiff(closingDiff);
  // 交班單打印機：設備設定 → 打印機 → 交班單打印機（shiftPrinterId）；冇指定 fallback 收據打印機。
  const shiftPrinter = pickShiftPrinter(deviceConfig);
  const closingDiffInvalid = !parsedClosingDiff.ok;
  const closingDiffValue =
    parsedClosingDiff.ok && parsedClosingDiff.filled && parsedClosingDiff.diff !== 0
      ? parsedClosingDiff.diff
      : undefined;
  const closingActualCash =
    typeof closingDiffValue === "number" ? Math.round((expectedCash + closingDiffValue) * 100) / 100 : null;

  /**
   * 關店總掣嘅**現況摘要**（畀 step2 勾選框下面嗰行細字用）。
   *
   * 誠實回報「未讀到」：`null` 顯示「未接通」，唔可以當「已開」或者「已關」。
   * 呢行字係收銀撳落去之前最後一次知道「而家開住咩」嘅機會。
   */
  const closeGateNow = (() => {
    const storeLabel =
      storeOpenStatus.isOpen === null
        ? "未接通"
        : storeOpenStatus.isOpen
          ? "營業中"
          : "已暫停";
    const onlineLabel =
      onlineOrderConfig.merchantEnabled === null
        ? "未接通"
        : onlineOrderConfig.merchantEnabled
          ? "接單中"
          : "已暫停";
    return { storeLabel, onlineLabel };
  })();
  /** 兩條通道都已經關咗（或者未讀到）→ 勾唔勾都冇分別，UI 可以講清楚。 */
  const closeGateNothingToDo =
    storeOpenStatus.isOpen !== true && onlineOrderConfig.merchantEnabled !== true;

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="mx-auto h-[100dvh] max-w-[1600px] overflow-auto px-4 py-4 md:pl-[88px]">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="min-w-[240px] flex-1">
            <div className="text-lg font-semibold text-slate-900">交班</div>
            <div className="mt-1 text-sm text-slate-500">
              開工 → 營業 → 結數交班。交班後會打印一張今日營業摘要。
            </div>
            {!shift.openedAt ? (
              <label className="mt-4 grid max-w-sm gap-1">
                <span className="text-xs font-semibold text-slate-500">開工備註（選填）</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setShiftNote(event.target.value)}
                  placeholder="例如：今日人手安排／開店檢查"
                  value={shiftNote}
                />
              </label>
            ) : null}
          </div>

          {/*
            關店總掣殘留警示（2026-09-18）：交班彈窗一閂就會消失，但「仲有通道開住」
            係一個**要跟進**嘅狀態。所以喺 header 常駐一格，只有真係有失敗才顯示 ——
            冇失敗 = 唔渲染（唔會變噪音）。
          */}
          {lastCloseGate && !isCloseGateClean(lastCloseGate) ? (
            <div className="w-full rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="font-semibold">⚠️ 交班已完成，但部分接單通道未能關閉</span>
              <span className="ml-1">
                {lastCloseGate.store === "failed" ? "店內接單（掃碼／自助機）" : ""}
                {lastCloseGate.store === "failed" && lastCloseGate.online === "failed" ? "、" : ""}
                {lastCloseGate.online === "failed" ? "線上接單" : ""}
                仍然開住 —— 客人落得到單。請到側欄商店名卡手動關閉。
              </span>
              <button
                className="ml-2 rounded-xl bg-white px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300"
                onClick={() => setLastCloseGate(null)}
                type="button"
              >
                知道了
              </button>
            </div>
          ) : null}

          <div className="flex flex-col items-end gap-3">
            <div className="text-right text-sm">
              {shift.openedAt ? (
                <div className="font-semibold text-slate-900">
                  {`已開工：${shift.employeeName ?? shift.employeeAccount ?? ""}${shift.employeeName || shift.employeeAccount ? " · " : ""}${formatMacauDateTime(shift.openedAt)}`}
                </div>
              ) : (
                <div className="font-semibold text-slate-500">未開工</div>
              )}
              {shift.openedAt && shift.closedAt ? (
                <div className="mt-0.5 text-slate-500">最近交班：{formatMacauDateTime(shift.closedAt)}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {!shift.openedAt ? (
                <button
                  className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => void openShiftNow()}
                  type="button"
                >
                  開工
                </button>
              ) : (
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => {
                    setClosingDiff("");
                    setClosingNote("");
                    setConfirmStep(1);
                    setConfirmOpen(true);
                  }}
                  type="button"
                >
                  結數交班並打印
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          {status}
        </div>

        {/*
          🔴 2026-09-15（商家要求）：**全有或全無** 渲染閘。

          數據未齊（訂單側 merge／Ledger 今日彙總任一未完成）→ 只出一個 loading 卡，
          **唔渲染任何部分內容**；兩邊都攞齊合併完成先一次性出完整內容。

          ⚠️ 為何連「今日摘要」標題都唔出：標題下第一格就係「應收金額合計」，
          出標題 = 半截畫面（用戶見到框但冇數）。整頁一張 loading 卡最清楚。

          ⚠️ 上面嘅「開工 / 結數交班並打印」按鈕**唔 gate**：佢哋係操作入口，
          唔係報表數據；gate 住會令用戶喺 loading 期間連開工都撳唔到
          （載入慢時尤其難受）。商家要求嘅「唔渲染部分內容」係指數據區塊。
        */}
        {!pageReady ? (
          <ShiftPageLoading />
        ) : (
          <>
        <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-base font-semibold text-slate-900">今日摘要</div>
            <div className="mt-1 text-xs text-slate-500">店內堂食／快餐以本機 POS 為準；會員通線上以 Ledger 報表為準。</div>

            {/* 金額合計（線上 + 線下）第一行：對數先睇呢度，確認條數啱唔啱 */}
            <div className="mt-4">
              <div className="text-sm font-semibold text-slate-700">金額合計（線上 + 線下）</div>
              {/* 口徑說明（2026-09-14）：線下 = 本機 POS「全部支付方式」（現金／Mpay／會員餘額…），
                  合計唔會剔走任何一種支付方式；線上 = Ledger **已付款單加總**（含未推 completed 嘅單，
                  ＝實際收到嘅錢）。寫清楚係因為商家曾誤以為「合計漏咗現金」——實際上現金一向喺線下總額之內。 */}
              <div className="mt-1 text-xs text-slate-500">
                線下 = 本機 POS 全部支付方式（現金／Mpay／會員餘額 等，唔會剔走任何一種）；線上 = 本地線上投影單 ∪ Ledger 已付款單（按單去重，＝實際收到嘅錢）。
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <article className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
                  <div className="text-sm text-indigo-700">應收金額合計</div>
                  <div className="mt-2 text-2xl font-semibold text-indigo-700">
                    {formatMoney(summary.receivableTotal)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    僅線下 POS：原價合計 + 服務費 + 稅（不含線上，線上見下方「會員通線上」）
                  </div>
                </article>
                <article className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <div className="text-sm text-emerald-700">實收金額合計</div>
                  <div className="mt-2 text-2xl font-semibold text-emerald-700">
                    {formatMoney(summary.paidTotal)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    僅線下 POS：優惠後實際收到 = order.total（已含現金／Mpay／會員餘額）
                  </div>
                  {/* 🔴 2026-09-17 淨額口徑：舊寫法退款單整張唔計 → 部分退嘅未退部分蒸發。
                      呢度明確列出「＋退款單未退部分 = 淨實收」，令商家對得上實際落袋金額。 */}
                  {summary.refundCount > 0 ? (
                    <div className="mt-2 rounded-xl border border-emerald-200 bg-white/70 px-3 py-2 text-xs text-emerald-900">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>退款單未退部分</span>
                        <span className="font-semibold">＋{formatMoney(summary.refundedRemainder)}</span>
                      </div>
                      <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-emerald-200 pt-1">
                        <span className="font-semibold">淨實收（落袋）</span>
                        <span className="text-base font-semibold">{formatMoney(summary.netPaidTotal)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-emerald-700">
                        ＝已結帳單實收 − 退款總額 {formatMoney(summary.refundAmount)}
                      </div>
                    </div>
                  ) : null}
                </article>
                <article className="rounded-2xl border border-orange-200 bg-orange-50/40 p-4">
                  <div className="text-sm text-orange-700">線上線下合計（實收）</div>
                  <div className="mt-2 text-2xl font-semibold text-orange-700">
                    {formatMoney(summary.paidTotal + ledgerOnlineMop)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    線下 {formatMoney(summary.paidTotal)}（已含現金）＋ 線上 {formatMoney(ledgerOnlineMop)}
                  </div>
                  {ledgerOnlineIsPaidSum && (ledgerPaidOrders?.incompleteCount ?? 0) > 0 ? (
                    <div className="mt-1 text-xs text-amber-700">
                      <div>
                        其中 {ledgerPaidOrders?.incompleteCount} 張線上單已付款但未標記完成（
                        {formatMoney(ledgerPaidOrders?.incompleteAmountMop ?? 0)}），已計入上數。
                      </div>
                      {/* 補推：把呢批單推上 Ledger `completed`（舊版結帳路徑冇推，2026-09-14 已修；
                          舊單要靠呢粒掣補）。只推「本地已 settled」嗰啲，觸控目標 ≥ 40px。 */}
                      {backfillTargets.length > 0 ? (
                        <>
                          <button
                            className="mt-2 min-h-[40px] rounded-xl border border-amber-300 bg-amber-100 px-4 text-sm font-semibold text-amber-900 disabled:opacity-50"
                            disabled={backfillingLedger}
                            onClick={() => void handleBackfillOnlineCompleted()}
                            type="button"
                          >
                            {backfillingLedger ? "補推中…" : `補推 ${backfillTargets.length} 張線上單狀態`}
                          </button>
                          {(ledgerPaidOrders?.incompleteCount ?? 0) > backfillTargets.length ? (
                            <div className="mt-1">
                              另 {(ledgerPaidOrders?.incompleteCount ?? 0) - backfillTargets.length} 張本地仲未完成，唔會補推。
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="mt-1">（本地仲未完成嘅單唔會補推）</div>
                      )}
                    </div>
                  ) : null}
                  {!ledgerOnlineIsPaidSum ? (
                    <div className="mt-1 text-xs text-amber-700">
                      Ledger 已付款單讀取失敗 → 暫時只計本地線上投影單（MOP {formatMoney(onlineLocalMop)}）。
                    </div>
                  ) : null}
                </article>
              </div>
              {backfillStatus ? (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  {backfillStatus}
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <div>
                <div className="font-semibold text-slate-900">應收現金（系統自動計算）</div>
                <div className="mt-1 text-xs text-slate-500">
                  現金箱核對改喺「結數交班並打印」彈窗進行：有落差先需要輸入差額。
                </div>
              </div>
              <div className="text-3xl font-semibold text-slate-900">{formatMoney(expectedCash)}</div>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">店內支付方式拆分（線下 POS）</div>
              <div className="mt-3 grid gap-2">
                {Object.keys(summary.paymentBreakdown).length === 0 ? (
                  <div className="text-sm text-slate-500">今天暫未有已結帳店內訂單。</div>
                ) : (
                  <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full border-collapse text-sm">
                      <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                        <tr>
                          <th className="border-b border-slate-200 px-3 py-1.5">支付方式</th>
                          <th className="border-b border-slate-200 px-3 py-1.5 text-right">張數</th>
                          <th className="border-b border-slate-200 px-3 py-1.5 text-right">應收</th>
                          <th className="border-b border-slate-200 px-3 py-1.5 text-right">實收</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(summary.paymentBreakdown)
                          .sort(([, a], [, b]) => b.paid - a.paid)
                          .map(([method, bucket]) => (
                            <tr key={method} className="border-b border-slate-100 last:border-b-0">
                              <td className="px-3 py-1.5 font-semibold text-slate-900">{method}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700">{bucket.count}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700">
                                {formatMoney(bucket.receivable)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-semibold text-emerald-700">
                                {formatMoney(bucket.paid)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">訂單明細（今日已結帳）</div>
              <div className="mt-1 text-xs text-slate-500">
                線下 {detailSplit.offlineCount} 張 {formatMoney(detailSplit.offlineMop)}（＝上方「店內支付方式拆分（線下 POS）」合計）
                ｜「線上」標記 {detailSplit.onlineCount} 張 {formatMoney(detailSplit.onlineMop)}（線上交單嘅本地投影，＝上方線上實收嘅本地部分）
                ｜按結賬時間倒序；退款單唔列出。
              </div>
              <div className="mt-3 max-h-[420px] overflow-auto rounded-xl border border-slate-200 bg-white">
                <OrderDetailList rows={orderDetailRows} emptyText="今天暫無已結帳訂單。" />
              </div>
            </div>

            <div className="mt-6 text-sm font-semibold text-slate-700">會員通線上（Ledger）</div>
            {/*
              ⚠️ 2026-09-15：原本呢度有一句 `{ledgerTodayLoading ? "載入今日線上報表…" : null}`。
              而家全頁 `pageReady` 閘已經覆蓋（`ledgerLoaded` 未 true → 成頁 loading），
              呢句永遠唔會出現，所以拆走 —— 留低只會令人以為「仲有第二層 loading」。
              錯誤橫幅**保留**：佢係「已經載入完但失敗」嘅結果（例如未登入 Ledger），
              屬於完成狀態，唔應該被 loading 蓋住。
            */}
            {ledgerTodayError ? (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {ledgerTodayError}
              </div>
            ) : null}
            {ledgerToday ? (
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <article className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="text-sm text-slate-500">線上訂單數</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">{ledgerToday.orderCount}</div>
                </article>
                <article className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="text-sm text-slate-500">已付線上營業額</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">
                    {formatMoney(ledgerOnlineMop)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    線上 {ledgerOnlineCount} 張（本地投影 {formatMoney(onlineLocalMop)} ＋ Ledger 純線上 {formatMoney(ledgerOnlyOnline.amountMop)}）＝ 實際收到
                    {ledgerOnlineIsPaidSum && (ledgerPaidOrders?.incompleteCount ?? 0) > 0
                      ? `｜其中 ${ledgerPaidOrders?.incompleteCount} 張未標記完成（${formatMoney(ledgerPaidOrders?.incompleteAmountMop ?? 0)}）`
                      : ""}
                  </div>
                </article>
                <article className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="text-sm text-slate-500">餘額扣點 / 到店付款</div>
                  <div className="mt-2 text-base font-semibold text-slate-900">
                    {formatMoney(ledgerToday.orderBalancePaidMop)} / {formatMoney(ledgerToday.orderInStorePaidMop)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">Ledger「已完成」單細項（供核對，未完成單未計）</div>
                </article>
              </div>
            ) : null}

            {ledgerPaidOrders ? (
              <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
                <summary className="cursor-pointer font-semibold text-slate-800">
                  線上拆數（點開逐張核對）：本地投影 {onlineLocalOrders.length} 張 {formatMoney(onlineLocalMop)} ＋
                  Ledger 已付款 {ledgerPaidOrders.count} 張 {formatMoney(ledgerPaidOrders.amountMop)}
                  （其中 {ledgerOnlyRows.length} 張本地冇 → 計 {formatMoney(ledgerOnlyOnline.amountMop)}）
                </summary>
                <div className="mt-2 grid gap-1">
                  {onlineLocalOrders.map((o) => (
                    <div key={o.id} className="flex items-baseline justify-between gap-2">
                      <span className="truncate">
                        本地投影 · {o.localOrderNo} · onlineId {String(o.onlineOrderId).slice(0, 8)} · {o.paymentMethod ?? "—"}
                      </span>
                      <span className="shrink-0 font-semibold">{formatMoney(o.total)}</span>
                    </div>
                  ))}
                  {ledgerPaidOrders.orders.map((o) => {
                    const dup = localOnlineIds.has(o.id);
                    const amount = Number(o.total ?? o.paidAmount ?? 0) || 0;
                    return (
                      <div
                        key={o.id}
                        className={`flex items-baseline justify-between gap-2 ${dup ? "text-slate-400" : ""}`}
                      >
                        <span className="truncate">
                          Ledger · 取餐碼 {o.pickupCode ?? "—"} · id {o.id.slice(0, 8)} · {o.status}
                          {dup ? "（本地已有 → 唔重複計）" : ""}
                        </span>
                        <span className="shrink-0 font-semibold">{formatMoney(amount)}</span>
                      </div>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </section>

          <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div>
              <div className="text-base font-semibold text-slate-900">交班歷史</div>
              <div className="mt-1 text-sm text-slate-500">
                保留最近 60 次交班記錄，方便追數與核對。
                {historyCloudCount > 0
                  ? `｜已由雲端同步 ${historyCloudCount} 筆（換機／多部機共用同一份）`
                  : "｜交班記錄要上雲後才會跨機顯示。"}
              </div>
            </div>
            {/*
              🔴 2026-09-15：篩選條件**一律排喺同一行**。
              舊寫法標題同篩選同一個 flex 容器，副標題太長會搶走寬度 →
              最後一粒掣被迫換行、壓落表頭。所以標題搬上去自己一行，
              篩選收成獨立一條「篩選列」，並用 nowrap 保證唔會斷行
              （容器太窄時改為橫向滾動，唔會拆行）。
            */}
            <div className="mt-4 flex items-center gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="shrink-0 text-xs text-slate-500">交班日期</span>
              <input
                aria-label="交班日期（由）"
                className="h-10 w-[150px] shrink-0 rounded-xl border border-slate-200 bg-white px-3"
                onChange={(event) => setHistoryDateFrom(event.target.value)}
                type="date"
                value={historyDateFrom}
              />
              <span className="shrink-0 text-xs text-slate-400">至</span>
              <input
                aria-label="交班日期（至）"
                className="h-10 w-[150px] shrink-0 rounded-xl border border-slate-200 bg-white px-3"
                onChange={(event) => setHistoryDateTo(event.target.value)}
                type="date"
                value={historyDateTo}
              />
              <span className="h-6 w-px shrink-0 bg-slate-200" />
              <span className="shrink-0 text-xs text-slate-500">員工</span>
              <select
                aria-label="員工"
                className="h-10 w-[150px] shrink-0 rounded-xl border border-slate-200 bg-white px-2"
                onChange={(event) => setHistoryEmployeeFilter(event.target.value)}
                value={historyEmployeeFilter}
              >
                <option value="">全部員工</option>
                {historyEmployeeOptions.map(([account, name]) => (
                  <option key={account} value={account}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1" />
              <button
                aria-busy={exportingType === "csv"}
                className="h-10 shrink-0 rounded-xl bg-white px-4 font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
                disabled={Boolean(exportingType)}
                onClick={exportShiftHistoryCsv}
                type="button"
              >
                {exportingType === "csv" ? "同步中…" : "導出 CSV"}
              </button>
            </div>
            {/*
              🔴 2026-09-15：① 框架尺寸固定（`max-h` + 內部滾動）—— 撳「查看更多」載入更多日
              只會令表格內部滾動，個框唔會撐高。② `table-layout:fixed` + `<colgroup>` 固定欄寬
              ⇒ 金額唔再被切斷（舊版「MOP 4,2…」）、操作欄兩粒掣唔再換行。
              ⚠️ 12 欄合計最少要 ~1102px；容器（iPad 橫向可用約 1100）唔夠闊時，
              wrapper 會橫向滾動（本來就有 `overflow-auto`），唔會壓爛欄寬。
            */}
            <div
              className="mt-4 overflow-auto rounded-2xl border border-slate-200"
              style={{ maxHeight: `${SHIFT_HISTORY_MAX_HEIGHT_PX}px` }}
            >
              <table className="w-full min-w-[1018px] table-fixed border-collapse text-xs">
                {/*
                  欄寬用百分比（同 repo 其他表一致：table-fixed + 百分比 + min-w）。
                  🔴 基準 = **1018px**，數字全部係**真瀏覽器實測**（`Range` 量文字闊度），唔係估：
                  · 貨幣已搬上表頭 ⇒ 金額格只需放數字（「3,945」≈ 34px、5 位「12,345」≈ 46px）
                  · 12px 字「14/09/2026」= 66px ⇒ 交班時間欄 90px
                  ⇒ 1018px 可以塞落 iPad 橫向（內容約 1040px），**完全唔洗橫向滾動**。
                */}
                <colgroup>
                  <col className="w-[8.83%]" />
                  <col className="w-[7.07%]" />
                  <col className="w-[7.27%]" />
                  <col className="w-[7.47%]" />
                  <col className="w-[7.47%]" />
                  <col className="w-[7.47%]" />
                  <col className="w-[5.89%]" />
                  <col className="w-[7.86%]" />
                  <col className="w-[6.09%]" />
                  <col className="w-[5.70%]" />
                  <col className="w-[13.16%]" />
                  <col className="w-[15.72%]" />
                </colgroup>
                {/* 表頭 11px：欄闊係按 12px 內容實測值定死（1018px 基準），
                    表頭用 11px 先可以全部單行顯示，唔會斷成「應收金額合 / 計」。 */}
                <thead className="bg-slate-50 text-left text-[11px] font-semibold text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">交班時間</th>
                    <th className="border-b border-slate-200 px-3 py-2">員工</th>
                    <th className="border-b border-slate-200 px-3 py-2">營業額{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收金額合計{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">實收金額合計{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">線上線下合計{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">退款{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收/實收現金{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">差額{MONEY_UNIT}</th>
                    <th className="border-b border-slate-200 px-3 py-2">待同步</th>
                    <th className="border-b border-slate-200 px-3 py-2">備註</th>
                    <th className="border-b border-slate-200 px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftHistoryDayGroups.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-slate-500" colSpan={12}>
                        目前沒有符合條件的交班歷史。
                        {historyCloudCount === 0
                          ? "（本機同雲端都未有已收工班次；完成一次「結數交班」後就會出現，換機登入都睇得返。）"
                          : ""}
                      </td>
                    </tr>
                  ) : (
                    shiftHistoryVisibleGroups.map((group) => (
                      <Fragment key={`day-${group.day}`}>
                        {/* 日分隔列：令「每頁 10 天」睇得見；同一日多個班次唔會撈亂。 */}
                        <tr className="bg-slate-50/80">
                          <td
                            className="border-b border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500"
                            colSpan={12}
                          >
                            {group.label} · {group.rows.length} 個班次
                          </td>
                        </tr>
                        {group.rows.map((row) => (
                      <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-3 text-slate-700">{formatMacauDateTime(row.closedAt)}</td>
                        <td className="px-3 py-3 text-slate-700">{row.employeeName ?? row.employeeAccount ?? "未記錄"}</td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 font-semibold text-slate-900">{formatMoneyValue(row.revenue)}</td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 text-slate-700">
                          {typeof row.receivableTotal === "number" ? formatMoneyValue(row.receivableTotal) : "--"}
                        </td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 font-semibold text-emerald-700">
                          {typeof row.paidTotal === "number" ? formatMoneyValue(row.paidTotal) : "--"}
                        </td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 font-semibold text-orange-700">
                          {typeof row.paidTotal === "number"
                            ? formatMoneyValue(row.paidTotal + (row.onlinePaidMop ?? 0))
                            : typeof row.onlinePaidMop === "number"
                              ? formatMoneyValue(row.onlinePaidMop)
                              : "--"}
                        </td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 text-slate-700">
                          {row.refundCount}
                          {/* 金額另起一行（貨幣見表頭）—— 欄窄時一行放唔落。 */}
                          <div className="text-[11px] text-slate-500">{formatMoneyValue(row.refundAmount)}</div>
                        </td>
                        <td className="overflow-hidden whitespace-nowrap px-3 py-3 text-slate-700">
                          {formatMoneyValue(row.expectedCash)}
                          {/* 實收現金另外一行 —— 一行寫成「a / b」會超出欄闊被裁。 */}
                          {typeof row.actualCash === "number" ? (
                            <div className="text-[11px] text-slate-500">/ {formatMoneyValue(row.actualCash)}</div>
                          ) : null}
                        </td>
                        <td className={`overflow-hidden whitespace-nowrap px-3 py-3 font-semibold ${row.cashDifference === 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {typeof row.cashDifference === "number" ? formatMoneyValue(row.cashDifference) : "--"}
                        </td>
                        {/* 逐行拆開顯示（唔用「N 事件 / M 打印」一行）—— 欄窄時會斷成「3 打 / 印」。 */}
                        <td className="px-3 py-3 text-slate-700">
                          {row.pendingEvents} 事件
                          <div className="text-[11px] text-slate-500">{row.pendingPrints} 打印</div>
                          {row.failedEvents ? (
                            <div className="text-[11px] text-red-600">{row.failedEvents} 失敗</div>
                          ) : null}
                          {row.skippedEvents ? (
                            <div className="text-[11px] text-slate-500">無歸屬 {row.skippedEvents}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3">
                          {/* 唔可以加 `min-w-[150px]`：table-layout:fixed 之下會撐爆個格。 */}
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-2 py-2 text-slate-700"
                              onChange={(event) =>
                                setHistoryNoteDrafts((current) => ({
                                  ...current,
                                  [row.id]: event.target.value,
                                }))
                              }
                              placeholder="補錄備註"
                              value={historyNoteDrafts[row.id] ?? row.closingNote ?? ""}
                            />
                            <button
                              className="shrink-0 rounded-xl bg-white px-2 py-2 font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                              onClick={() => saveHistoryNote(row.id)}
                              type="button"
                            >
                              保存
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              aria-busy={reprintingShiftId === row.id}
                              className="whitespace-nowrap rounded-xl bg-white px-2.5 py-2 font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
                              disabled={Boolean(reprintingShiftId)}
                              onClick={() => reprintShiftRecord(row)}
                              type="button"
                            >
                              {reprintingShiftId === row.id ? "打印中…" : "重打交班單"}
                            </button>
                            <button
                              className="whitespace-nowrap rounded-xl bg-red-50 px-2.5 py-2 font-semibold text-red-700 shadow-sm ring-1 ring-red-200"
                              onClick={() => deleteHistoryRecord(row.id)}
                              type="button"
                            >
                              刪除
                            </button>
                          </div>
                        </td>
                      </tr>
                        ))}
                      </Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* 分頁：每頁最多 10 個日曆日；「查看更多」累加（框尺寸固定）。 */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-500">
                已顯示最近 <span className="font-semibold text-slate-900">{shiftHistoryVisibleGroups.length} 天</span> ·{" "}
                <span className="font-semibold text-slate-900">{shiftHistoryVisibleRows} 筆</span>
                （合計 <span className="font-semibold text-slate-900">{shiftHistoryDayGroups.length} 天</span> ·{" "}
                <span className="font-semibold text-slate-900">{filteredShiftHistory.length} 筆</span>）　·　每頁最多{" "}
                {SHIFT_HISTORY_PAGE_DAYS} 天
              </div>
              <div className="flex items-center gap-2">
                {shiftHistoryVisibleGroups.length > SHIFT_HISTORY_PAGE_DAYS ? (
                  <button
                    className="h-11 rounded-2xl px-4 font-semibold text-slate-500"
                    onClick={() => setHistoryLoadedDays(SHIFT_HISTORY_PAGE_DAYS)}
                    type="button"
                  >
                    收起
                  </button>
                ) : null}
                <button
                  className="h-11 rounded-2xl bg-slate-900 px-5 font-semibold text-white disabled:opacity-40"
                  disabled={!shiftHistoryHasMore}
                  onClick={() => setHistoryLoadedDays((current) => current + SHIFT_HISTORY_PAGE_DAYS)}
                  type="button"
                >
                  {shiftHistoryHasMore
                    ? `查看更多（再載入 ${Math.min(
                        SHIFT_HISTORY_PAGE_DAYS,
                        shiftHistoryDayGroups.length - shiftHistoryVisibleGroups.length,
                      )} 天）`
                    : "已全部載入"}
                </button>
              </div>
            </div>
          </section>
          </>
        )}

      </div>

      {confirmOpen ? (
        <ResponsiveModal
          title={
            confirmStep === 1
              ? "結數交班 · 核對金額"
              : confirmStep === 2
                ? "二次確認 · 交班後無法更改"
                : "交班明細 · 打印預覽"
          }
          description={
            confirmStep === 1
              ? "系統已自動彙總今日所有金額。請先點算現金箱：若與應收現金有落差，喺下面輸入差額；冇落差可直接進行下一步。"
              : confirmStep === 2
                ? "交班後本班次會寫入歷史並切回「未開工」，金額與差額記錄即鎖定、不可再更改。請最後核對下列數字。"
                : "以下為固定格式交班明細（內容同版面不可編輯）。按「打印」由指定打印機出紙並完成交班；按「跳過」唔打印直接完成交班。"
          }
          actions={
            confirmStep === 1 ? (
              <>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  disabled={closingShift}
                  onClick={() => setConfirmOpen(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={closingDiffInvalid}
                  onClick={() => setConfirmStep(2)}
                  type="button"
                >
                  下一步：二次確認
                </button>
              </>
            ) : confirmStep === 2 ? (
              <>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  disabled={closingShift}
                  onClick={() => setConfirmStep(1)}
                  type="button"
                >
                  返回修改
                </button>
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={closingShift}
                  onClick={() => {
                    // 進入 step3 嗰刻固化快照：之後打印/跳過/交班記錄都用同一份。
                    setPreviewData(buildShiftDetailSnapshot(new Date().toISOString(), closingDiff, closingNote));
                    setConfirmStep(3);
                  }}
                  type="button"
                >
                  下一步：打印預覽
                </button>
              </>
            ) : (
              <>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                  disabled={closingShift}
                  onClick={() => setConfirmStep(2)}
                  type="button"
                >
                  返回修改
                </button>
                <button
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
                  disabled={closingShift}
                  onClick={() => void closeShift(closingDiff, closingNote, previewData ?? undefined, false)}
                  type="button"
                >
                  跳過
                </button>
                <button
                  aria-busy={closingShift}
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={closingShift || !shiftPrinter}
                  onClick={() => void closeShift(closingDiff, closingNote, previewData ?? undefined, true)}
                  type="button"
                >
                  {closingShift ? "處理中…" : "打印"}
                </button>
              </>
            )
          }
          bodyClassName="grid gap-4"
          onClose={() => {
            if (!closingShift) {
              setConfirmOpen(false);
              setPreviewData(null);
            }
          }}
          widthClassName="max-w-2xl"
        >
          {confirmStep === 1 ? (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">已結帳訂單</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">{summary.count}</div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">營業額</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">{formatMoney(summary.revenue)}</div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">線上已支付</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-900">{formatMoney(summary.prepaid)}</div>
                </article>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <div className="text-xs font-semibold text-slate-500">系統應收現金（唔可以改）</div>
                <div className="mt-1 text-3xl font-semibold text-slate-900">{formatMoney(expectedCash)}</div>
                <div className="mt-1 text-xs text-slate-500">
                  = 已結帳訂單中以現金／混合現金方式實收嘅總和（線下 POS，含退款調整）。
                </div>
              </div>

              <label className="grid gap-1.5">
                <span className="text-sm font-semibold text-slate-900">現金差額（有落差先填）</span>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    className="w-48 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-right font-mono text-base font-semibold text-slate-900 focus:border-slate-400 focus:outline-none"
                    inputMode="decimal"
                    onChange={(event) => setClosingDiff(sanitizeCashInput(event.target.value))}
                    placeholder="0"
                    value={closingDiff}
                  />
                  <span className="text-xs text-slate-500">少收填負數（如 -30）／多收填正數（如 15.5）</span>
                </div>
                <span className="text-xs text-slate-500">
                  實收現金（系統推算）：{closingActualCash !== null ? formatMoney(closingActualCash) : "--"}
                </span>
                {closingDiffInvalid ? (
                  <span className="text-xs font-semibold text-red-600">
                    差額格式不正確：只可輸入數字，如需少收請以負數表示。
                  </span>
                ) : null}
              </label>

              {closingDiffValue !== undefined ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  ⚠ 現金箱與應收有{" "}
                  {formatMoney(closingDiffValue < 0 ? -closingDiffValue : closingDiffValue)} 嘅差額
                  （{closingDiffValue < 0 ? "少收／短款" : "多收／長款"}）。請確認已正確點算；
                  如屬錯數，請喺下面「備註」填寫說明——差額只作記錄，唔會改動系統任何金額。
                </div>
              ) : null}

              <label className="grid gap-1.5">
                <span className="text-sm font-semibold text-slate-900">備註／錯數說明（選填）</span>
                <textarea
                  className="min-h-[64px] rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                  onChange={(event) => setClosingNote(event.target.value)}
                  placeholder="只作記錄用途，唔會修改任何金額。例如：找續出錯，短款 MOP 30"
                  value={closingNote}
                />
              </label>

              {queueSummary.pendingEvents > 0 ||
              queueSummary.failedEvents > 0 ||
              queueSummary.skippedEvents > 0 ||
              ledgerTodayError ? (
                <div className="grid gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {queueSummary.pendingEvents > 0
                    ? `⚠ 仲有 ${queueSummary.pendingEvents} 筆資料未同步上雲，交班前會先強制同步。`
                    : null}
                  {queueSummary.failedEvents > 0
                    ? `⚠ ${queueSummary.failedEvents} 筆資料永久同步失敗（已跳過，唔會阻住交班）。`
                    : null}
                  {queueSummary.skippedEvents > 0 ? (
                    <span className="text-amber-700">
                      {queueSummary.skippedEvents} 筆資料冇店舖歸屬（外店／未登入時產生），
                      <strong>唔會上雲</strong>，亦唔會阻住交班。如需處理請聯絡技術支援。
                    </span>
                  ) : null}
                  {ledgerTodayError ? `⚠ ${ledgerTodayError}` : null}
                </div>
              ) : null}
            </>
          ) : confirmStep === 2 ? (
            <>
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <div className="font-semibold">此操作無法復原</div>
                <div className="mt-1">
                  撳「確認，交班並打印」後，本班次即寫入交班歷史、狀態切回「未開工」，
                  並打印交班單。之後只能喺歷史補錄備註，<span className="font-semibold">唔可以再改任何金額或差額</span>
                  。請確認下面數字冇錯。
                </div>
                {closeStoreGate ? (
                  <div className="mt-2 border-t border-red-200 pt-2">
                    另外：<span className="font-semibold">本店線上／線下接單會一齊關閉</span>（打烊），
                    客人即刻落唔到單；重開要人手。
                  </div>
                ) : null}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="text-slate-500">已結帳訂單</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{summary.count} 張</div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="text-slate-500">營業額</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{formatMoney(summary.revenue)}</div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="text-slate-500">線上已支付</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{formatMoney(summary.prepaid)}</div>
                </article>
                <article className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="text-slate-500">退款</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">
                    {summary.refundCount} 張 / {formatMoney(summary.refundAmount)}
                  </div>
                </article>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <div className="flex items-center justify-between py-1">
                  <span>應收現金（系統）</span>
                  <span className="font-semibold text-slate-900">{formatMoney(expectedCash)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 py-1">
                  <span>輸入差額</span>
                  <span className={`font-semibold ${closingDiffValue === undefined ? "text-slate-500" : closingDiffValue < 0 ? "text-red-700" : "text-emerald-700"}`}>
                    {closingDiffValue === undefined ? "無（0）" : formatMoney(closingDiffValue)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-200 py-1">
                  <span>實收現金（推算）</span>
                  <span className="font-semibold text-slate-900">
                    {closingActualCash !== null ? formatMoney(closingActualCash) : "--（無盤點記錄）"}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3 border-t border-slate-200 py-1">
                  <span>備註</span>
                  <span className="max-w-[60%] text-right text-slate-700">
                    {closingNote.trim() || "（無）"}
                  </span>
                </div>
              </div>

              {closingDiffValue !== undefined ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
                  現金差額非零（{formatMoney(closingDiffValue < 0 ? -closingDiffValue : closingDiffValue)}）
                  —— 將記錄為「{closingDiffValue < 0 ? "少收／短款" : "多收／長款"}」，不會改動系統金額。
                </div>
              ) : null}

              {queueSummary.pendingEvents > 0 ||
              queueSummary.failedEvents > 0 ||
              queueSummary.skippedEvents > 0 ||
              ledgerTodayError ? (
                <div className="grid gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {queueSummary.pendingEvents > 0 ? `仲有 ${queueSummary.pendingEvents} 筆資料待同步（交班前會先強制同步）。` : null}
                  {queueSummary.failedEvents > 0 ? `${queueSummary.failedEvents} 筆永久失敗已跳過。` : null}
                  {queueSummary.skippedEvents > 0
                    ? `${queueSummary.skippedEvents} 筆無歸屬資料（外店／未登入時產生）唔會上雲，已跳過。`
                    : null}
                  {ledgerTodayError ? ledgerTodayError : null}
                </div>
              ) : null}

              {/*
                ── 關店總掣（2026-09-18）──────────────────────────────────────
                設計要點：
                • 呢一格係**新功能**，唔可以遮蓋上面啲金額核對資訊（所以放最底）。
                • 預設**已勾**（J 拍板）——交班本身就係「今日唔再做」。
                • 觸控：整行 label 可撳（唔止個 checkbox），高度 ≥ 48px。
                • 要老實講「而家開住咩」，收銀先知撳落去會改到啲乜。
              */}
              <div
                className={`rounded-2xl border p-3 ${
                  closeStoreGate ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-slate-50"
                }`}
              >
                <label className="flex min-h-[48px] cursor-pointer items-start gap-3">
                  <input
                    checked={closeStoreGate}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-amber-600"
                    disabled={closingShift}
                    onChange={(event) => setCloseStoreGate(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="flex-1 text-sm">
                    <span className="block font-semibold text-slate-900">
                      同時關閉本店「線上 + 線下」接單（打烊）
                    </span>
                    <span className="mt-1 block text-slate-600">
                      交班後客人將無法掃碼點餐、用自助點餐機落單，線上（會員通）亦會暫停接單。
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">
                      而家：店內接單 <strong className="text-slate-700">{closeGateNow.storeLabel}</strong>
                      {" · "}
                      線上接單 <strong className="text-slate-700">{closeGateNow.onlineLabel}</strong>
                    </span>
                  </span>
                </label>

                {closeStoreGate && closeGateNothingToDo ? (
                  <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 text-xs text-slate-600">
                    兩條通道本身都未開（或未接通），交班唔會再改動接單狀態。
                  </div>
                ) : null}

                {closeStoreGate ? (
                  <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 text-xs text-slate-600">
                    ⚠ 重開需要人手：交班後到側欄商店名卡撳「營業中」，或設定頁開返線上接單。
                    <strong className="text-slate-700">唔會</strong>自動開返。
                  </div>
                ) : (
                  <div className="mt-2 rounded-xl border border-amber-200 bg-white/70 px-3 py-2 text-xs text-amber-800">
                    ⚠ 已取消勾選：交班後接單狀態維持現狀，客人仍然落得到單。
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {!shiftPrinter ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  未偵測到可用打印機：可到「設備設定 → 打印機」添加／啟用並指定「交班單打印機」，或者按「跳過」不打印直接完成交班。
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  將由「{shiftPrinter.name}」出紙（更改：設備設定 → 打印機 → 交班單打印機）。
                </div>
              )}

              {queueSummary.pendingEvents > 0 || queueSummary.failedEvents > 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {queueSummary.pendingEvents > 0
                    ? `⚠ 仲有 ${queueSummary.pendingEvents} 筆資料未同步上雲，交班前會先強制同步。`
                    : null}
                  {queueSummary.failedEvents > 0
                    ? `⚠ ${queueSummary.failedEvents} 筆資料永久同步失敗（已跳過，唔會阻住交班）。`
                    : null}
                </div>
              ) : null}

              {/* step3 唯讀回顯：令收銀喺最後一刻仍然知道撳「打印」之後會發生咩事 */}
              <div
                className={`rounded-2xl border px-3 py-2 text-sm ${
                  closeStoreGate
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                {closeStoreGate
                  ? "交班後：將一併關閉本店「線上 + 線下」接單（客人掃碼／自助機／線上點餐一律停單）。"
                  : "交班後：接單狀態不變（客人仍可掃碼、自助機、線上落單）。"}
              </div>

              {previewData ? (
                <div className="mx-auto w-full max-w-[360px] rounded-2xl border-2 border-dashed border-slate-300 bg-white p-5 font-mono text-[13px] leading-relaxed text-slate-900">
                  <div className="text-center">
                    <div className="text-base font-semibold tracking-[0.3em]">交班明細</div>
                    {previewData.storeName ? (
                      <div className="mt-1 text-xs text-slate-500">{previewData.storeName}</div>
                    ) : null}
                    <div className="text-xs text-slate-500">單號：交班單 {previewData.shiftNo}</div>
                  </div>

                  <div className="mt-3 space-y-0.5 border-t border-dashed border-slate-300 pt-2">
                    <div>班次員工：{previewData.employee}</div>
                    {previewData.openedAt ? (
                      <div>開工時間：{formatMacauDateTime(previewData.openedAt)}</div>
                    ) : null}
                    <div>交班時間：{formatMacauDateTime(previewData.closedAt)}</div>
                  </div>

                  <div className="mt-3 border-t border-dashed border-slate-300 pt-2">
                    <div className="font-semibold text-slate-700">— 店內（今日）—</div>
                    <div className="mt-1 space-y-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>已結帳訂單</span>
                        <span>{previewData.store.count} 張</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span>營業額</span>
                        <span>{formatMoney(previewData.store.revenue)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span>應收金額合計</span>
                        <span>{formatMoney(previewData.store.receivableTotal)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span>實收金額合計</span>
                        <span>{formatMoney(previewData.store.paidTotal)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span>線上已支付（店內單）</span>
                        <span>{formatMoney(previewData.store.prepaid)}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <span>退款</span>
                        <span>
                          {previewData.store.refundCount} 張 / {formatMoney(previewData.store.refundAmount)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {previewData.online ? (
                    <div className="mt-3 border-t border-dashed border-slate-300 pt-2">
                      <div className="font-semibold text-slate-700">— 會員通線上（今日）—</div>
                      <div className="mt-1 space-y-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span>線上訂單</span>
                          <span>{previewData.online.orderCount} 張</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <span>已付線上營業額</span>
                          <span>{formatMoney(previewData.online.paidMop)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <span>餘額扣點</span>
                          <span>{formatMoney(previewData.online.balancePaidMop)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <span>到店／貨到付款</span>
                          <span>{formatMoney(previewData.online.inStorePaidMop)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 font-semibold">
                          <span>線上線下合計（線下已含現金）</span>
                          <span>{formatMoney(previewData.store.paidTotal + previewData.online.paidMop)}</span>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 border-t border-dashed border-slate-300 pt-2">
                    <div className="font-semibold text-slate-700">— 支付方式分項 —</div>
                    {previewData.payments.length === 0 ? (
                      <div className="mt-1 text-slate-500">（今日暫無已結帳線下訂單）</div>
                    ) : (
                      <div className="mt-1 space-y-0.5">
                        {previewData.payments.map((bucket) => (
                          <div key={bucket.method} className="flex items-baseline justify-between gap-2">
                            <span>{bucket.method}</span>
                            <span className="text-right">
                              {formatMoney(bucket.receivable)} / {formatMoney(bucket.paid)}
                              <span className="text-slate-400"> · {bucket.count} 張</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {previewData.purchase ? (
                    <div className="mt-3 border-t border-dashed border-slate-300 pt-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>今日買貨成本（已付）</span>
                        <span>{formatMoney(previewData.purchase.paid)}</span>
                      </div>
                      {previewData.purchase.unpaid > 0 ? (
                        <div className="text-xs text-slate-500">
                          （未付 {formatMoney(previewData.purchase.unpaid)} 不計入）
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-3 border-t-2 border-slate-400 pt-2">
                    <div className="font-semibold text-slate-700">— 現金箱核對 —</div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span>應收現金</span>
                      <span className="text-base font-semibold">{formatMoney(previewData.cash.expected)}</span>
                    </div>
                    {typeof previewData.cash.actual === "number" ? (
                      <div className="flex items-baseline justify-between gap-2">
                        <span>實收現金（盤點）</span>
                        <span>{formatMoney(previewData.cash.actual)}</span>
                      </div>
                    ) : null}
                    {typeof previewData.cash.diff === "number" ? (
                      <div
                        className={`flex items-baseline justify-between gap-2 font-semibold ${
                          previewData.cash.diff < 0 ? "text-red-700" : "text-emerald-700"
                        }`}
                      >
                        <span>現金差額（{previewData.cash.diff < 0 ? "少收" : "多收"}）</span>
                        <span>{formatMoney(previewData.cash.diff)}</span>
                      </div>
                    ) : null}
                  </div>

                  {previewData.note ? (
                    <div className="mt-3 border-t border-dashed border-slate-300 pt-2">
                      <div className="font-semibold text-slate-700">備註</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-slate-700">{previewData.note}</div>
                    </div>
                  ) : null}

                  <div className="mt-4 grid grid-cols-2 gap-3 border-t border-dashed border-slate-300 pt-3 text-xs text-slate-500">
                    <div>交班人簽名：＿＿＿＿＿＿</div>
                    <div>接更人簽名：＿＿＿＿＿＿</div>
                  </div>

                  <div className="mt-3 text-center text-[11px] text-slate-400">固定格式 · 不可編輯</div>
                </div>
              ) : null}
            </>
          )}
        </ResponsiveModal>
      ) : null}
    </div>
  );
}

/**
 * 交班頁整頁載入中（2026-09-15「全有或全無」渲染閘）。
 *
 * 同報表頁 `ReportFullPageLoading` 同一套視覺（同一個 spinner + 文案節奏），
 * 令兩頁在載入期間嘅觀感一致；`min-h` 撐住高度，避免載入完成時
 * 「內容區由 0 高變成幾千 px」造成頁面彈跳。
 */
function ShiftPageLoading() {
  return (
    <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
          role="status"
          aria-label="載入中"
        />
        <div className="text-sm text-slate-500">正在載入交班數據…</div>
        <div className="text-xs text-slate-400">
          整合本機訂單與 Ledger 線上數據，完成後一次顯示。
        </div>
      </div>
    </section>
  );
}
