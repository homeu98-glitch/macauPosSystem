"use client";

import { useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { defaultDeviceConfig } from "@/lib/mock-data";
import {
  loadDeviceConfig,
  loadOfflineMode,
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
import { PrintJob, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function formatMoney(amount: number) {
  return `MOP ${amount.toFixed(0)}`;
}

export function ShiftPage() {
  const [shift, setShift] = useState(() => loadShiftState());
  const [shiftNote, setShiftNote] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [status, setStatus] = useState("開工後可於下班時做結數交班並打印交班單。");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shiftHistory, setShiftHistory] = useState(() => loadShiftHistory());

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const orders = useMemo(() => loadOrders(), []);

  const summary = useMemo(() => {
    const closedOrders = orders.filter((order) =>
      order.status === "settled" || order.status === "partially_refunded" || order.status === "refunded",
    );
    const refunded = orders.filter((order) => order.status === "partially_refunded" || order.status === "refunded");
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
  }, [orders]);
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

  async function closeShift() {
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
      `已結帳訂單：${summary.count} 張`,
      `營業額：${formatMoney(summary.revenue)}`,
      `線上已支付：${formatMoney(summary.prepaid)}`,
      `退款：${summary.refundCount} 張 / ${formatMoney(summary.refundAmount)}`,
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

    if (!loadOfflineMode()) {
      try {
        await fetch("/api/pos/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: nextQueue }),
        });
        saveQueue(nextQueue.map((item) => (item.id === event.id ? { ...item, status: "synced" } : item)));
      } catch {
        // 保留待補傳
      }
    }

    setStatus("已交班，交班單已加入打印隊列，狀態已重置為待開工。");
    setConfirmOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <AppSidebar />
      <div className="mx-auto max-w-[1600px] px-4 py-4 lg:pl-[88px]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="text-lg font-semibold text-slate-900">交班</div>
          <div className="mt-1 text-sm text-slate-500">
            開工 → 營業 → 結數交班。交班後會打印一張今日營業摘要。
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          {status}
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
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
            <div className="text-base font-semibold text-slate-900">今日摘要</div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
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
              <div className="text-sm font-semibold text-slate-900">支付方式拆分</div>
              <div className="mt-3 grid gap-2">
                {Object.keys(summary.paymentBreakdown).length === 0 ? (
                  <div className="text-sm text-slate-500">今天暫未有已結帳訂單。</div>
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
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">交班歷史</div>
                <div className="mt-1 text-sm text-slate-500">保留最近 60 次交班記錄，方便追數與核對。</div>
              </div>
            </div>
            <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">交班時間</th>
                    <th className="border-b border-slate-200 px-3 py-2">營業額</th>
                    <th className="border-b border-slate-200 px-3 py-2">退款</th>
                    <th className="border-b border-slate-200 px-3 py-2">應收/實收現金</th>
                    <th className="border-b border-slate-200 px-3 py-2">差額</th>
                    <th className="border-b border-slate-200 px-3 py-2">待同步</th>
                    <th className="border-b border-slate-200 px-3 py-2">備註</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftHistory.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-slate-500" colSpan={7}>
                        目前尚未有交班歷史。
                      </td>
                    </tr>
                  ) : (
                    shiftHistory.map((row) => (
                      <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-3 text-slate-700">{row.closedAt.replace("T", " ").slice(0, 16)}</td>
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
                        <td className="px-3 py-3 text-slate-500">{row.closingNote || "--"}</td>
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="text-lg font-semibold text-slate-900">確認交班</div>
            <div className="mt-1 text-sm text-slate-500">
              請先核對今日總數，確認後會打印交班單，並把系統狀態切回待開工。
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
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

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
              <div>{shift.openedAt ? `開工時間：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "未記錄開工時間"}</div>
              <div className="mt-1">應收現金：{formatMoney(expectedCash)}</div>
              <div className="mt-1">待同步事件：{queueSummary.pendingEvents} · 待補傳打印：{queueSummary.pendingPrints}</div>
              {Number.isFinite(actualCashValue) ? <div className="mt-1">實收現金：{formatMoney(actualCashValue)} · 差額：{formatMoney(cashDifference)}</div> : null}
              {shiftNote ? <div className="mt-1">備註：{shiftNote}</div> : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
                onClick={() => setConfirmOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => void closeShift()}
                type="button"
              >
                確定並打印
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
