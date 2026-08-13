"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { getMerchantReportSummary, LedgerReportSummary } from "@/lib/ledger/reports";
import { orderMatchesReportRange } from "@/lib/ledger/report-period";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { isLocalPosOrder } from "@/lib/pos-order-filters";
import {
  loadAuthSession,
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
import { PrintJob, PosOrder, QueueEvent } from "@/lib/types";

function summarizeClosedOrders(orders: PosOrder[]) {
  const closedOrders = orders.filter(
    (order) =>
      order.status === "settled" || order.status === "partially_refunded" || order.status === "refunded",
  );
  const refunded = closedOrders.filter(
    (order) => order.status === "partially_refunded" || order.status === "refunded",
  );
  const paymentBreakdown = closedOrders.reduce<Record<string, number>>((acc, order) => {
    const key = order.paymentMethod ?? "未記錄";
    acc[key] = (acc[key] ?? 0) + order.total;
    return acc;
  }, {});
  return {
    count: closedOrders.length,
    revenue: closedOrders.reduce((sum, order) => sum + order.total, 0),
    prepaid: closedOrders.reduce((sum, order) => sum + (order.prepaidAmount ?? 0), 0),
    refundCount: refunded.length,
    refundAmount: refunded.reduce((sum, order) => sum + (order.refundedAmount ?? order.total), 0),
    paymentBreakdown,
  };
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

function csvCell(value: string | number | undefined) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function ShiftPage() {
  const [shift, setShift] = useState(() => loadShiftState());
  const [shiftNote, setShiftNote] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [status, setStatus] = useState("開工後可於下班時做結數交班並打印交班單。");
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  const authSession = useMemo(() => loadAuthSession(), []);

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());

  useEffect(() => {
    function refreshOrders() {
      setOrders(loadOrders());
    }
    refreshOrders();
    window.addEventListener("focus", refreshOrders);
    return () => window.removeEventListener("focus", refreshOrders);
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
  const queueSummary = (() => {
    const queue = loadQueue();
    const printJobs = loadPrintJobs();
    return {
      pendingEvents: queue.filter((item) => item.status !== "synced").length,
      pendingPrints: printJobs.filter((item) => item.status === "pending").length,
    };
  })();
  const expectedCash = useMemo(() => {
    const cashKeys = ["現金", "會員餘額 + 現金", "優惠券 + 現金"];
    return Object.entries(summary.paymentBreakdown)
      .filter(([key]) => cashKeys.some((cashKey) => key.includes(cashKey)))
      .reduce((sum, [, value]) => sum + value, 0);
  }, [summary.paymentBreakdown]);
  const actualCashValue = Number(actualCash);
  const cashDifference = Number.isFinite(actualCashValue) ? actualCashValue - expectedCash : 0;
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

  function buildShiftPrintLines(row: (typeof shiftHistory)[number]) {
    return [
      `交班時間：${row.closedAt.replace("T", " ").slice(0, 16)}`,
      row.openedAt ? `開工時間：${row.openedAt.replace("T", " ").slice(0, 16)}` : "",
      `已結帳訂單：${row.settledCount} 張`,
      `營業額：${formatMoney(row.revenue)}`,
      `線上已支付：${formatMoney(row.prepaid)}`,
      `退款：${row.refundCount} 張 / ${formatMoney(row.refundAmount)}`,
      `應收現金：${formatMoney(row.expectedCash)}`,
      typeof row.actualCash === "number" ? `實收現金：${formatMoney(row.actualCash)}` : "",
      typeof row.cashDifference === "number" ? `現金差額：${formatMoney(row.cashDifference)}` : "",
      `待同步事件：${row.pendingEvents}`,
      `待補傳打印：${row.pendingPrints}`,
      row.closingNote ? `備註：${row.closingNote}` : "",
    ].filter(Boolean);
  }

  function reprintShiftRecord(row: (typeof shiftHistory)[number]) {
    if (reprintingShiftId) return;
    setReprintingShiftId(row.id);
    const receiptPrinter = deviceConfig.printers.find((printer) => printer.enabled && printer.role === "receipt");
    const printerName = receiptPrinter?.name ?? "收據打印機";
    const now = new Date().toISOString();
    const printJob: PrintJob = {
      id: uid("print"),
      orderId: row.id,
      orderNo: `交班單重打 ${row.closedAt.slice(0, 10)}`,
      tableName: "",
      ticketType: "normal",
      printerGroup: "receipt",
      printerId: receiptPrinter?.id,
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
    const nextQueue = [...loadQueue(), event];
    saveQueue(nextQueue);
    setStatus(`已把 ${row.closedAt.slice(0, 10)} 的交班單加入重打隊列。`);
    setReprintingShiftId(null);
  }

  async function forceSyncBeforeClose() {
    if (!readNetworkOnline()) {
      setStatus("目前離線，無法強制同步。請恢復網絡後再交班。");
      return false;
    }
    const pending = loadQueue().filter((item) => item.status !== "synced");
    if (pending.length === 0) return true;
    try {
      await fetch("/api/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: pending,
          storeId: loadAuthSession()?.merchantId ?? undefined,
        }),
      });
      saveQueue(pending.map((item) => ({ ...item, status: "synced" as const })));
      setStatus(`已同步 ${pending.length} 筆待辦資料，準備交班。`);
      return true;
    } catch {
      setStatus("強制同步失敗，請檢查網絡或稍後重試。");
      return false;
    }
  }

  async function closeShift() {
    if (closingShift) return;
    setClosingShift(true);
    const ok = await forceSyncBeforeClose();
    if (!ok) {
      setClosingShift(false);
      return;
    }
    const now = new Date().toISOString();
    const next = {
      ...shift,
      openedAt: undefined,
      closedAt: now,
      closingNote: shiftNote,
      actualCash: Number.isFinite(actualCashValue) ? actualCashValue : undefined,
      cashDifference: Number.isFinite(actualCashValue) ? cashDifference : undefined,
    };
    const historyRecord = {
      id: `shift-${now}`,
      employeeAccount: authSession?.account,
      employeeName: authSession?.name,
      openedAt: shift.openedAt,
      closedAt: now,
      openingNote: shift.openingNote,
      closingNote: shiftNote,
      actualCash: Number.isFinite(actualCashValue) ? actualCashValue : undefined,
      cashDifference: Number.isFinite(actualCashValue) ? cashDifference : undefined,
      settledCount: summary.count,
      revenue: summary.revenue,
      prepaid: summary.prepaid,
      refundCount: summary.refundCount,
      refundAmount: summary.refundAmount,
      expectedCash,
      paymentBreakdown: summary.paymentBreakdown,
      pendingEvents: queueSummary.pendingEvents,
      pendingPrints: queueSummary.pendingPrints,
    };
    setShift(next);
    saveShiftState(next);
    const nextHistory = [historyRecord, ...shiftHistory].slice(0, 60);
    setShiftHistory(nextHistory);
    saveShiftHistory(nextHistory);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: next } }));

    const receiptPrinter = deviceConfig.printers.find((printer) => printer.enabled && printer.role === "receipt");
    const printerName = receiptPrinter?.name ?? "收據打印機";

    const lines = [
      `交班時間：${now.replace("T", " ").slice(0, 16)}`,
      shift.openedAt ? `開工時間：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "",
      "— 店內（今日）—",
      `已結帳訂單：${summary.count} 張`,
      `營業額：${formatMoney(summary.revenue)}`,
      `線上已支付（店內單）：${formatMoney(summary.prepaid)}`,
      `退款：${summary.refundCount} 張 / ${formatMoney(summary.refundAmount)}`,
      ...(ledgerToday
        ? [
            "— 會員通線上（今日）—",
            `線上訂單：${ledgerToday.orderCount} 張`,
            `已付線上營業額：${formatMoney(ledgerToday.orderPaidMop)}`,
            `餘額扣點：${formatMoney(ledgerToday.orderBalancePaidMop)}`,
            `到店／貨到付款：${formatMoney(ledgerToday.orderInStorePaidMop)}`,
          ]
        : []),
      `應收現金：${formatMoney(expectedCash)}`,
      Number.isFinite(actualCashValue) ? `實收現金：${formatMoney(actualCashValue)}` : "",
      Number.isFinite(actualCashValue) ? `現金差額：${formatMoney(cashDifference)}` : "",
      `待同步事件：${queueSummary.pendingEvents}`,
      `待補傳打印：${queueSummary.pendingPrints}`,
      shiftNote ? `備註：${shiftNote}` : "",
    ].filter(Boolean);

    const printJob: PrintJob = {
      id: uid("print"),
      orderId: `shift-${now}`,
      orderNo: "交班單",
      tableName: "",
      ticketType: "normal",
      printerGroup: "receipt",
      printerId: receiptPrinter?.id,
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

    const nextQueue = [...loadQueue(), event];
    saveQueue(nextQueue);

    if (readNetworkOnline()) {
      try {
        await fetch("/api/pos/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events: nextQueue,
            storeId: loadAuthSession()?.merchantId ?? undefined,
          }),
        });
        saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      } catch {
        // 保留待補傳
      }
    }

    setStatus("已交班，交班單已加入打印隊列，狀態已重置為待開工。");
    setConfirmOpen(false);
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
      ["交班時間", "員工", "營業額", "退款金額", "應收現金", "實收現金", "現金差額", "待同步事件", "待補傳打印", "備註"].join(","),
      ...filteredShiftHistory.map((row) =>
        [
          row.closedAt.replace("T", " ").slice(0, 16),
          row.employeeName ?? row.employeeAccount ?? "未記錄",
          row.revenue,
          row.refundAmount,
          row.expectedCash,
          row.actualCash ?? "",
          row.cashDifference ?? "",
          row.pendingEvents,
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
                  <td>${row.closedAt.replace("T", " ").slice(0, 16)}</td>
                  <td>${row.employeeName ?? row.employeeAccount ?? "未記錄"}</td>
                  <td>${row.revenue}</td>
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

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="mx-auto h-[100dvh] max-w-[1600px] overflow-auto px-4 py-4 md:pl-[88px]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-lg font-semibold text-slate-900">交班</div>
          <div className="mt-1 text-sm text-slate-500">
            開工 → 營業 → 結數交班。交班後會打印一張今日營業摘要。
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          {status}
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-base font-semibold text-slate-900">班次狀態</div>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              <div>{shift.openedAt ? `已開工：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "未開工"}</div>
              {shift.closedAt ? (
                <div className="text-slate-500">最近交班：{shift.closedAt.replace("T", " ").slice(0, 16)}</div>
              ) : null}
            </div>

            <label className="mt-4 grid gap-1">
              <span className="text-xs font-semibold text-slate-500">備註</span>
              <input
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                onChange={(event) => setShiftNote(event.target.value)}
                placeholder="例如：現金箱已點清"
                value={shiftNote}
              />
            </label>
            <label className="mt-3 grid gap-1">
              <span className="text-xs font-semibold text-slate-500">實收現金</span>
              <input
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                inputMode="decimal"
                onChange={(event) => setActualCash(event.target.value)}
                placeholder={`應收 ${formatMoney(expectedCash)}`}
                value={actualCash}
              />
            </label>
            <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <div className="flex items-center justify-between">
                <span>應收現金</span>
                <span className="font-semibold text-slate-900">{formatMoney(expectedCash)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span>差額</span>
                <span className={`font-semibold ${cashDifference === 0 ? "text-emerald-700" : "text-red-700"}`}>
                  {formatMoney(cashDifference)}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {!shift.openedAt ? (
                <button
                  className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => {
                    const next = {
                      ...shift,
                      openedAt: new Date().toISOString(),
                      closedAt: undefined,
                      openingNote: shiftNote,
                    };
                    setShift(next);
                    saveShiftState(next);
                    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: next } }));
                    setStatus("已開工。");
                  }}
                  type="button"
                >
                  開工
                </button>
              ) : (
                <button
                  className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => setConfirmOpen(true)}
                  type="button"
                >
                  結數交班並打印
                </button>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-base font-semibold text-slate-900">今日摘要（澳門時間）</div>
            <div className="mt-1 text-xs text-slate-500">店內堂食／快餐以本機 POS 為準；會員通線上以 Ledger 報表為準。</div>

            <div className="mt-4 text-sm font-semibold text-slate-700">店內（線下 POS）</div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">已結帳訂單</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{summary.count}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">營業額</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{formatMoney(summary.revenue)}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">店內預付／線上已付</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{formatMoney(summary.prepaid)}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">退款</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{summary.refundCount}</div>
                <div className="mt-1 text-xs text-slate-500">{formatMoney(summary.refundAmount)}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">待同步事件</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{queueSummary.pendingEvents}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">待補傳打印</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{queueSummary.pendingPrints}</div>
              </article>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">店內支付方式拆分</div>
              <div className="mt-3 grid gap-2">
                {Object.keys(summary.paymentBreakdown).length === 0 ? (
                  <div className="text-sm text-slate-500">今天暫未有已結帳店內訂單。</div>
                ) : (
                  Object.entries(summary.paymentBreakdown).map(([method, amount]) => (
                    <div key={method} className="flex items-center justify-between text-sm text-slate-700">
                      <span>{method}</span>
                      <span className="font-semibold text-slate-900">{formatMoney(amount)}</span>
                    </div>
                  ))
                )}
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

          <section className="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-2">
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
                      <td className="px-3 py-4 text-slate-500" colSpan={9}>
                        目前沒有符合條件的交班歷史。
                      </td>
                    </tr>
                  ) : (
                    filteredShiftHistory.map((row) => (
                      <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-3 text-slate-700">{row.closedAt.replace("T", " ").slice(0, 16)}</td>
                        <td className="px-3 py-3 text-slate-700">{row.employeeName ?? row.employeeAccount ?? "未記錄"}</td>
                        <td className="px-3 py-3 font-semibold text-slate-900">{formatMoney(row.revenue)}</td>
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
                          {row.pendingEvents} 事件 / {row.pendingPrints} 打印
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
      </div>

      {confirmOpen ? (
        <ResponsiveModal
          actions={
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
                aria-busy={closingShift}
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={closingShift}
                onClick={() => void closeShift()}
                type="button"
              >
                {closingShift ? "提交中…" : "確定並打印"}
              </button>
            </>
          }
          bodyClassName="grid gap-4"
          description="請先核對今日總數，確認後會打印交班單，並把系統狀態切回待開工。"
          title="確認交班"
          widthClassName="max-w-2xl"
        >
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
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">退款</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{formatMoney(summary.refundAmount)}</div>
              </article>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <div>{shift.openedAt ? `開工時間：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "未記錄開工時間"}</div>
              <div className="mt-1">應收現金：{formatMoney(expectedCash)}</div>
              <div className="mt-1">待同步事件：{queueSummary.pendingEvents} · 待補傳打印：{queueSummary.pendingPrints}</div>
              {Number.isFinite(actualCashValue) ? <div className="mt-1">實收現金：{formatMoney(actualCashValue)} · 差額：{formatMoney(cashDifference)}</div> : null}
              {shiftNote ? <div className="mt-1">備註：{shiftNote}</div> : null}
            </div>
            </div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
