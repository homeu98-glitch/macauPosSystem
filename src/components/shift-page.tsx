"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { isPrintContentEnabled } from "@/lib/print-toggles";
import { getMerchantReportSummary, LedgerReportSummary } from "@/lib/ledger/reports";
import { orderMatchesReportRange, macauTodayRange } from "@/lib/ledger/report-period";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { fetchPurchaseSummary, type PurchaseApiResponse } from "@/lib/inventory-stats";
import { isLocalPosOrder } from "@/lib/pos-order-filters";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeviceConfig,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  loadShiftHistory,
  loadShiftState,
  savePrintJobs,
  saveQueue,
  saveShiftHistory,
  saveShiftState,
} from "@/lib/storage";
import { readNetworkOnline } from "@/lib/use-network-online";
import {
  resolveStoreId,
  withStoreScope,
  filterEventsForCurrentStore,
  notifyQueueChanged,
} from "@/lib/pos/sync-flush";
import { enqueueEvents, isOutboxV2Enabled, summarizeQueueEvents } from "@/lib/pos/queue-outbox";
import {
  reconcileLocalShift,
  serverActiveToLocal,
  serverCloseShift,
  serverOpenShift,
} from "@/lib/shift-sync";
import { DeviceConfig, DevicePrinterConfig, PrintJob, PosOrder, QueueEvent } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { OrderDetailList, type OrderDetailRow } from "@/components/order-detail-list";

function summarizeClosedOrders(orders: PosOrder[]) {
  const closedOrders = orders.filter(
    (order) =>
      order.status === "settled" || order.status === "partially_refunded" || order.status === "refunded",
  );
  const refunded = closedOrders.filter(
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
  return {
    count: closedOrders.length,
    revenue: closedOrders.reduce((sum, order) => sum + order.total, 0),
    prepaid: closedOrders.reduce((sum, order) => sum + (order.prepaidAmount ?? 0), 0),
    refundCount: refunded.length,
    refundAmount: refunded.reduce((sum, order) => sum + (order.refundedAmount ?? order.total), 0),
    paymentBreakdown,
    receivableTotal,
    paidTotal,
  };
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
type ShiftDetailSnapshot = {
  /** 交班時間（進入預覽一刻固化，交班記錄同紙本都用呢個）。 */
  closedAt: string;
  /** 單號序號：`YYYY-MM-DD-NN`（NN = 當日第幾班）。 */
  shiftNo: string;
  storeName: string;
  employee: string;
  openedAt?: string;
  store: {
    count: number;
    revenue: number;
    receivableTotal: number;
    paidTotal: number;
    prepaid: number;
    refundCount: number;
    refundAmount: number;
  };
  /** 會員通線上（Ledger）——未登入 / 冇資料時 null（紙本成組唔印）。 */
  online: {
    orderCount: number;
    paidMop: number;
    balancePaidMop: number;
    inStorePaidMop: number;
  } | null;
  payments: { method: string; receivable: number; paid: number; count: number }[];
  /** 今日買貨成本——冇做成本記錄時 null。 */
  purchase: { paid: number; unpaid: number } | null;
  cash: { expected: number; actual?: number; diff?: number };
  // 冇 G 區（待同步/技術狀態唔上紙本），但歷史記錄仍要記，跟住快照走。
  pendingEvents: number;
  failedEvents: number;
  skippedEvents: number;
  pendingPrints: number;
  note: string;
};

/** 快照 → ESC/POS 文本行（打印 job items）。預覽（結構化渲染）同呢度同源。 */
function shiftDetailToLines(data: ShiftDetailSnapshot): string[] {
  return [
    `單號：交班單 ${data.shiftNo}`,
    data.storeName ? `店舖：${data.storeName}` : "",
    `班次員工：${data.employee}`,
    `交班時間：${formatMacauDateTime(data.closedAt)}`,
    data.openedAt ? `開工時間：${formatMacauDateTime(data.openedAt)}` : "",
    "— 店內（今日）—",
    `已結帳訂單：${data.store.count} 張`,
    `營業額：${formatMoney(data.store.revenue)}`,
    `應收金額合計（線下 POS）：${formatMoney(data.store.receivableTotal)}`,
    `實收金額合計（線下 POS）：${formatMoney(data.store.paidTotal)}`,
    `線上已支付（店內單）：${formatMoney(data.store.prepaid)}`,
    `退款：${data.store.refundCount} 張 / ${formatMoney(data.store.refundAmount)}`,
    ...(data.online
      ? [
          "— 會員通線上（今日）—",
          `線上訂單：${data.online.orderCount} 張`,
          `已付線上營業額：${formatMoney(data.online.paidMop)}`,
          `餘額扣點：${formatMoney(data.online.balancePaidMop)}`,
          `到店／貨到付款：${formatMoney(data.online.inStorePaidMop)}`,
          `線上線下合計（實收金額合計）：${formatMoney(data.store.paidTotal + data.online.paidMop)}`,
        ]
      : []),
    "— 支付方式分項（線下 POS）—",
    ...(data.payments.length === 0
      ? ["（今日暫無已結帳線下訂單）"]
      : data.payments.map(
          (bucket) =>
            `${bucket.method}：應收 ${formatMoney(bucket.receivable)} / 實收 ${formatMoney(bucket.paid)} · ${bucket.count} 張`,
        )),
    ...(data.purchase
      ? [
          `今日買貨成本（已付）：${formatMoney(data.purchase.paid)}`,
          ...(data.purchase.unpaid > 0 ? [`（未付 ${formatMoney(data.purchase.unpaid)} 不計入）`] : []),
        ]
      : []),
    "— 現金箱核對 —",
    `應收現金：${formatMoney(data.cash.expected)}`,
    typeof data.cash.actual === "number" ? `實收現金：${formatMoney(data.cash.actual)}` : "",
    typeof data.cash.diff === "number" ? `現金差額：${formatMoney(data.cash.diff)}` : "",
    data.note ? `備註：${data.note}` : "",
  ].filter(Boolean);
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
  const [shiftHistory, setShiftHistory] = useState(() => loadShiftHistory());
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [historyEmployeeFilter, setHistoryEmployeeFilter] = useState("");
  const [historyNoteDrafts, setHistoryNoteDrafts] = useState<Record<string, string>>({});
  const [reprintingShiftId, setReprintingShiftId] = useState<string | null>(null);
  const [exportingType, setExportingType] = useState<"csv" | "excel" | null>(null);
  const [ledgerToday, setLedgerToday] = useState<LedgerReportSummary | null>(null);
  const [ledgerTodayLoading, setLedgerTodayLoading] = useState(false);
  const [ledgerTodayError, setLedgerTodayError] = useState<string | null>(null);
  const [purchaseToday, setPurchaseToday] = useState<PurchaseApiResponse | null>(null);
  const authSession = useMemo(() => loadAuthSession(), []);

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
      setOrders(loadOrders());
      const storeId = resolveStoreId();
      if (!storeId || !readNetworkOnline()) return;

      try {
        const range = macauTodayRange();
        const url = `/api/pos/state?storeId=${encodeURIComponent(storeId)}&ordersOnly=1&limit=5000&start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
        const res = await fetch(url);
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

  // 訂單明細（逐筆）：同 summary（支付方式分項）同一批今日已結帳訂單，按結賬時間倒序。
  const orderDetailRows = useMemo<OrderDetailRow[]>(
    () =>
      todayLocalOrders
        .map((o) => ({
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
        }))
        .sort((a, b) => {
          const ta = a.settledAt ? Date.parse(a.settledAt) : 0;
          const tb = b.settledAt ? Date.parse(b.settledAt) : 0;
          return tb - ta;
        }),
    [todayLocalOrders],
  );

  useEffect(() => {
    async function loadLedgerToday() {
      setLedgerTodayLoading(true);
      setLedgerTodayError(null);
      try {
        const restored = await restoreLedgerSession();
        if (!restored) {
          setLedgerToday(null);
          setLedgerTodayError("尚未登入 Ledger，無法讀取今日線上訂單。");
          return;
        }
        const data = await getMerchantReportSummary("today");
        setLedgerToday(data);
      } catch (error) {
        setLedgerToday(null);
        setLedgerTodayError(error instanceof Error ? error.message : "讀取今日線上報表失敗");
      } finally {
        setLedgerTodayLoading(false);
      }
    }

    void loadLedgerToday();
  }, []);

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
    return shiftHistory.filter((row) => {
      const day = row.closedAt.slice(0, 10);
      if (historyDateFrom && day < historyDateFrom) return false;
      if (historyDateTo && day > historyDateTo) return false;
      if (historyEmployeeFilter && (row.employeeAccount ?? "") !== historyEmployeeFilter) return false;
      return true;
    });
  }, [historyDateFrom, historyDateTo, historyEmployeeFilter, shiftHistory]);
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
   * 重打交班單（2026-09-08 改新「交班明細」格式）：
   * 表頭（單號/店舖/員工/時間）+ 店內 + 線上 + 支付分項 + 買貨 + 現金箱核對 + 備註。
   * 冇 G 區（待同步/技術狀態唔上紙本）。舊記錄缺 shiftNo/storeName/purchasePaid 時相關行自動唔印。
   */
  function buildShiftPrintLines(row: (typeof shiftHistory)[number]) {
    const lines = [
      row.shiftNo ? `單號：交班單 ${row.shiftNo}` : "",
      row.storeName ? `店舖：${row.storeName}` : "",
      `班次員工：${row.employeeName ?? row.employeeAccount ?? "未記錄"}`,
      `交班時間：${formatMacauDateTime(row.closedAt)}`,
      row.openedAt ? `開工時間：${formatMacauDateTime(row.openedAt)}` : "",
      "— 店內（今日）—",
      `已結帳訂單：${row.settledCount} 張`,
      `營業額：${formatMoney(row.revenue)}`,
      `應收金額合計（線下 POS）：${formatMoney(row.receivableTotal ?? 0)}`,
      `實收金額合計（線下 POS）：${formatMoney(row.paidTotal ?? 0)}`,
      `線上已支付：${formatMoney(row.prepaid)}`,
      `退款：${row.refundCount} 張 / ${formatMoney(row.refundAmount)}`,
      ...((row.onlinePaidMop ?? 0) > 0
        ? [
            "— 會員通線上（今日）—",
            `已付線上營業額：${formatMoney(row.onlinePaidMop ?? 0)}`,
            `線上線下合計：${formatMoney((row.paidTotal ?? 0) + (row.onlinePaidMop ?? 0))}`,
          ]
        : []),
      "— 支付方式分項 —",
      ...(row.paymentBreakdown && Object.keys(row.paymentBreakdown).length > 0
        ? Object.entries(row.paymentBreakdown)
            .map(([method, value]) => ({
              method,
              receivable: typeof value === "number" ? value : value.receivable,
              paid: typeof value === "number" ? value : value.paid,
              count: typeof value === "number" ? 1 : value.count,
            }))
            .sort((a, b) => b.paid - a.paid)
            .map(
              (bucket) =>
                `${bucket.method}：應收 ${formatMoney(bucket.receivable)} / 實收 ${formatMoney(bucket.paid)} · ${bucket.count} 張`,
            )
        : ["（今日暫無已結帳線下訂單）"]),
      ...(typeof row.purchasePaid === "number"
        ? [`今日買貨成本（已付）：${formatMoney(row.purchasePaid)}`]
        : []),
      "— 現金箱核對 —",
      `應收現金：${formatMoney(row.expectedCash)}`,
      typeof row.actualCash === "number" ? `實收現金：${formatMoney(row.actualCash)}` : "",
      typeof row.cashDifference === "number" ? `現金差額：${formatMoney(row.cashDifference)}` : "",
      row.closingNote ? `備註：${row.closingNote}` : "",
    ];
    return lines.filter(Boolean);
  }

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
      },
      online: ledgerToday
        ? {
            orderCount: ledgerToday.orderCount,
            paidMop: ledgerToday.orderPaidMop,
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

  function reprintShiftRecord(row: (typeof shiftHistory)[number]) {
    if (reprintingShiftId) return;
    setReprintingShiftId(row.id);
    // 2026-09-08：重打都用「交班單打印機」指定；冇指定 fallback 收據打印機。
    const shiftPrinter = pickShiftPrinter(deviceConfig);
    const printerName = shiftPrinter?.name ?? "收據打印機";
    const now = new Date().toISOString();
    const printJob: PrintJob = {
      id: uid("print"),
      orderId: row.id,
      orderNo: row.shiftNo ? `交班單重打 ${row.shiftNo}` : `交班單重打 ${row.closedAt.slice(0, 10)}`,
      tableName: "",
      ticketType: "normal",
      printerGroup: "receipt",
      printerId: shiftPrinter?.id,
      printerName,
      items: buildShiftPrintLines(row).map((line) => ({ name: line, quantity: 1 })),
      status: "pending",
      createdAt: now,
    };
    const nextPrintJobs = [printJob, ...loadPrintJobs()];
    savePrintJobs(nextPrintJobs);
    window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
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
        headers: { "Content-Type": "application/json" },
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
    const closingStoreId = resolveStoreId();
    if (!closingStoreId) {
      serverCloseFailed = true; // 冇店舖識別都當同步失敗處理（唔好誤報「雲端已同步」）
    } else if (readNetworkOnline()) {
      try {
        serverCloseFailed = !(await serverCloseShift({
          storeId: closingStoreId,
          closingNote: closingNoteText || undefined,
          actualCash: actualValue,
          cashDifference: diffValue,
          summary: historyRecord as unknown as Record<string, unknown>,
        }));
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
    const nextHistory = [historyRecord, ...shiftHistory].slice(0, 60);
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: finalNext } }));

    // ── 打印（2026-09-08）──
    // 打印機：DeviceConfig.shiftPrinterId 指定優先（設備設定 → 打印機 → 交班單打印機），
    // 指定機不可用 → fallback 收據打印機。「跳過」時整段唔入隊列，直接完成交班。
    const shiftPrinter = pickShiftPrinter(deviceConfig);
    const printerName = shiftPrinter?.name ?? "收據打印機";

    // 紙本內容 = step3 預覽同一份快照（shiftDetailToLines）；冇 G 區（待同步/技術狀態唔上紙本）。
    const lines = shiftDetailToLines(snapshot);

    if (print) {
      // 交班單總開關（2026-09-08）：商家可關閉「交班單」自動打印。
      // ⚠️ 重打交班單（reprintShiftRecord）係**手動**掣，唔受呢個影響，
      // 即使熄咗都可以喺交班歷史撳「重打」補印。
      if (!isPrintContentEnabled("shift")) {
        setStatus("已交班（交班單打印已關閉，如需紙本請到交班歷史「重打」）。");
        setClosingShift(false);
        return;
      }
      const printJob: PrintJob = {
        id: uid("print"),
        orderId: `shift-${now}`,
        orderNo: `交班單 ${snapshot.shiftNo}`,
        tableName: "",
        ticketType: "normal",
        printerGroup: "receipt",
        printerId: shiftPrinter?.id,
        printerName,
        items: lines.map((line) => ({ name: line, quantity: 1 })),
        status: "pending",
        createdAt: now,
      };

      const nextPrintJobs = [printJob, ...loadPrintJobs()];
      savePrintJobs(nextPrintJobs);

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
              headers: { "Content-Type": "application/json" },
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
        (serverCloseFailed ? "（⚠️ 收工狀態未能同步雲端，將自動重試，其他裝置可能仍顯示已開工。）" : "（雲端已同步，其他裝置會顯示已收工。）"),
    );
    setConfirmOpen(false);
    setPreviewData(null);
    setClosingShift(false);
  }

  function saveHistoryNote(recordId: string) {
    const note = (historyNoteDrafts[recordId] ?? "").trim();
    const nextHistory = shiftHistory.map((row) => (row.id === recordId ? { ...row, closingNote: note } : row));
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    setStatus("已更新交班歷史備註。");
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

  function exportShiftHistoryExcel() {
    if (exportingType) return;
    setExportingType("excel");
    if (filteredShiftHistory.length === 0 || typeof window === "undefined") {
      setStatus("目前沒有符合條件的交班歷史可導出。");
      setExportingType(null);
      return;
    }
    const html = `
      <table>
        <thead>
          <tr>
            <th>交班時間</th>
            <th>員工</th>
            <th>營業額</th>
            <th>應收金額合計</th>
            <th>實收金額合計</th>
            <th>線上已付</th>
            <th>線上線下合計</th>
            <th>退款金額</th>
            <th>應收現金</th>
            <th>實收現金</th>
            <th>現金差額</th>
            <th>待同步事件</th>
            <th>待補傳打印</th>
            <th>備註</th>
          </tr>
        </thead>
        <tbody>
          ${filteredShiftHistory
            .map(
              (row) => `
                <tr>
                  <td>${formatMacauDateTime(row.closedAt)}</td>
                  <td>${row.employeeName ?? row.employeeAccount ?? "未記錄"}</td>
                  <td>${row.revenue}</td>
                  <td>${row.receivableTotal ?? ""}</td>
                  <td>${row.paidTotal ?? ""}</td>
                  <td>${row.onlinePaidMop ?? ""}</td>
                  <td>${(row.paidTotal ?? 0) + (row.onlinePaidMop ?? 0)}</td>
                  <td>${row.refundAmount}</td>
                  <td>${row.expectedCash}</td>
                  <td>${row.actualCash ?? ""}</td>
                  <td>${row.cashDifference ?? ""}</td>
                  <td>${row.pendingEvents}</td>
                  <td>${row.pendingPrints}</td>
                  <td>${row.closingNote ?? ""}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `;
    const blob = new Blob([`\uFEFF${html}`], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "交班歷史.xls";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("交班歷史 Excel 已導出。");
    setExportingType(null);
  }

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

        <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-base font-semibold text-slate-900">今日摘要</div>
            <div className="mt-1 text-xs text-slate-500">店內堂食／快餐以本機 POS 為準；會員通線上以 Ledger 報表為準。</div>

            {/* 金額合計（線上 + 線下）第一行：對數先睇呢度，確認條數啱唔啱 */}
            <div className="mt-4">
              <div className="text-sm font-semibold text-slate-700">金額合計（線上 + 線下）</div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <article className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
                  <div className="text-sm text-indigo-700">應收金額合計</div>
                  <div className="mt-2 text-2xl font-semibold text-indigo-700">
                    {formatMoney(summary.receivableTotal)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    線下 POS 原價合計 + 服務費 + 稅（線上 Ledger 應收暫以 paid 計）
                  </div>
                </article>
                <article className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <div className="text-sm text-emerald-700">實收金額合計</div>
                  <div className="mt-2 text-2xl font-semibold text-emerald-700">
                    {formatMoney(summary.paidTotal)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">線下 POS：菜品優惠後商家實際收到 = order.total</div>
                </article>
                <article className="rounded-2xl border border-orange-200 bg-orange-50/40 p-4">
                  <div className="text-sm text-orange-700">線上線下合計（實收）</div>
                  <div className="mt-2 text-2xl font-semibold text-orange-700">
                    {formatMoney(summary.paidTotal + (ledgerToday?.orderPaidMop ?? 0))}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    線下 {formatMoney(summary.paidTotal)} + 線上 {formatMoney(ledgerToday?.orderPaidMop ?? 0)}
                  </div>
                </article>
              </div>
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
              <div className="mt-1 text-xs text-slate-500">同支付方式分項同一批訂單，按結賬時間倒序。</div>
              <div className="mt-3 max-h-[420px] overflow-auto rounded-xl border border-slate-200 bg-white">
                <OrderDetailList rows={orderDetailRows} emptyText="今天暫無已結帳訂單。" />
              </div>
            </div>

            <div className="mt-6 text-sm font-semibold text-slate-700">會員通線上（Ledger）</div>
            {ledgerTodayLoading ? <div className="mt-2 text-sm text-slate-500">載入今日線上報表…</div> : null}
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
                    {formatMoney(ledgerToday.orderPaidMop)}
                  </div>
                </article>
                <article className="rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="text-sm text-slate-500">餘額扣點 / 到店付款</div>
                  <div className="mt-2 text-base font-semibold text-slate-900">
                    {formatMoney(ledgerToday.orderBalancePaidMop)} / {formatMoney(ledgerToday.orderInStorePaidMop)}
                  </div>
                </article>
              </div>
            ) : null}
          </section>

          <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">交班歷史</div>
                <div className="mt-1 text-sm text-slate-500">保留最近 60 次交班記錄，方便追數與核對。</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setHistoryDateFrom(event.target.value)}
                  type="date"
                  value={historyDateFrom}
                />
                <span className="text-sm text-slate-400">至</span>
                <input
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setHistoryDateTo(event.target.value)}
                  type="date"
                  value={historyDateTo}
                />
                <select
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
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
                <button
                  aria-busy={exportingType === "csv"}
                  className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
                  disabled={Boolean(exportingType)}
                  onClick={exportShiftHistoryCsv}
                  type="button"
                >
                  {exportingType === "csv" ? "同步中…" : "導出 CSV"}
                </button>
                <button
                  aria-busy={exportingType === "excel"}
                  className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={Boolean(exportingType)}
                  onClick={exportShiftHistoryExcel}
                  type="button"
                >
                  {exportingType === "excel" ? "同步中…" : "導出 Excel"}
                </button>
              </div>
            </div>
            <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">交班時間</th>
                    <th className="border-b border-slate-200 px-3 py-2">員工</th>
                    <th className="border-b border-slate-200 px-3 py-2">營業額</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收金額合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">實收金額合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">線上線下合計</th>
                    <th className="border-b border-slate-200 px-3 py-2">退款</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收/實收現金</th>
                    <th className="border-b border-slate-200 px-3 py-2">差額</th>
                    <th className="border-b border-slate-200 px-3 py-2">待同步</th>
                    <th className="border-b border-slate-200 px-3 py-2">備註</th>
                    <th className="border-b border-slate-200 px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredShiftHistory.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-slate-500" colSpan={12}>
                        目前沒有符合條件的交班歷史。
                      </td>
                    </tr>
                  ) : (
                    filteredShiftHistory.map((row) => (
                      <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-3 text-slate-700">{formatMacauDateTime(row.closedAt)}</td>
                        <td className="px-3 py-3 text-slate-700">{row.employeeName ?? row.employeeAccount ?? "未記錄"}</td>
                        <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(row.revenue)}</td>
                        <td className="px-3 py-3 text-slate-700">
                          {typeof row.receivableTotal === "number" ? formatMoney(row.receivableTotal) : "--"}
                        </td>
                        <td className="px-3 py-3 font-semibold text-emerald-700">
                          {typeof row.paidTotal === "number" ? formatMoney(row.paidTotal) : "--"}
                        </td>
                        <td className="px-3 py-3 font-semibold text-orange-700">
                          {typeof row.paidTotal === "number"
                            ? formatMoney(row.paidTotal + (row.onlinePaidMop ?? 0))
                            : typeof row.onlinePaidMop === "number"
                              ? formatMoney(row.onlinePaidMop)
                              : "--"}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.refundCount} / {formatMoney(row.refundAmount)}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {formatMoney(row.expectedCash)}
                          {typeof row.actualCash === "number" ? ` / ${formatMoney(row.actualCash)}` : ""}
                        </td>
                        <td className={`px-3 py-3 font-semibold ${row.cashDifference === 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {typeof row.cashDifference === "number" ? formatMoney(row.cashDifference) : "--"}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {row.pendingEvents} 事件 / {row.pendingPrints} 打印{row.failedEvents ? ` · ${row.failedEvents} 失敗` : ""}
                          {row.skippedEvents ? (
                            <div className="mt-1 text-xs text-slate-500">無歸屬 {row.skippedEvents}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex min-w-[220px] items-center gap-2">
                            <input
                              className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
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
                              className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
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
                              className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
                              disabled={Boolean(reprintingShiftId)}
                              onClick={() => reprintShiftRecord(row)}
                              type="button"
                            >
                              {reprintingShiftId === row.id ? "打印中…" : "重打交班單"}
                            </button>
                            <button
                              className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 shadow-sm ring-1 ring-red-200"
                              onClick={() => deleteHistoryRecord(row.id)}
                              type="button"
                            >
                              刪除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

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
                          <span>線上線下合計</span>
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
