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
  loadShiftState,
  savePrintJobs,
  saveQueue,
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
  const [status, setStatus] = useState("開工後可於下班時做結數交班並打印交班單。");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deviceConfig = useMemo(() => loadDeviceConfig() ?? defaultDeviceConfig, []);
  const orders = useMemo(() => loadOrders(), []);

  const summary = useMemo(() => {
    const settled = orders.filter((order) => order.status === "settled");
    return {
      count: settled.length,
      revenue: settled.reduce((sum, order) => sum + order.total, 0),
      prepaid: settled.reduce((sum, order) => sum + (order.prepaidAmount ?? 0), 0),
    };
  }, [orders]);

  async function closeShift() {
    const now = new Date().toISOString();
    const next = {
      ...shift,
      openedAt: undefined,
      closedAt: now,
      closingNote: shiftNote,
    };
    setShift(next);
    saveShiftState(next);
    window.dispatchEvent(new CustomEvent("pos-shift-changed", { detail: { shift: next } }));

    const receiptPrinter = deviceConfig.printers.find((printer) => printer.enabled && printer.group === "receipt");
    const printerName = receiptPrinter?.name ?? "收據打印機";

    const lines = [
      `交班時間：${now.replace("T", " ").slice(0, 16)}`,
      shift.openedAt ? `開工時間：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "",
      `已結帳訂單：${summary.count} 張`,
      `營業額：${formatMoney(summary.revenue)}`,
      `線上已支付：${formatMoney(summary.prepaid)}`,
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
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
              <div>{shift.openedAt ? `開工時間：${shift.openedAt.replace("T", " ").slice(0, 16)}` : "未記錄開工時間"}</div>
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
