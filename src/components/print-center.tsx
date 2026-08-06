"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  loadDeviceConfig,
  loadOfflineMode,
  loadOrders,
  loadPrintJobs,
  loadQueue,
  savePrintJobs,
  saveQueue,
} from "@/lib/storage";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { PosOrder, PrintJob, QueueEvent } from "@/lib/types";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function ticketTypeLabel(type: PrintJob["ticketType"]) {
  if (type === "addon") return "加單";
  if (type === "void") return "退菜";
  return "正常";
}

export function PrintCenter() {
  const [printJobs, setPrintJobs] = useState<PrintJob[]>(() => loadPrintJobs());
  const [orders] = useState<PosOrder[]>(() => loadOrders());
  const [offlineMode, setOfflineMode] = useState(() => loadOfflineMode());
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "sent" | "failed">("all");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

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
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function onPrintJobsChanged() {
      setPrintJobs(loadPrintJobs());
    }
    window.addEventListener("pos-print-jobs-changed", onPrintJobsChanged);
    return () => window.removeEventListener("pos-print-jobs-changed", onPrintJobsChanged);
  }, []);

  const filteredJobs = useMemo(() => {
    const base = printJobs.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (filter === "all") return base;
    return base.filter((job) => job.status === filter);
  }, [printJobs, filter]);

  const activeJob = useMemo(
    () => (activeJobId ? filteredJobs.find((job) => job.id === activeJobId) ?? null : null),
    [activeJobId, filteredJobs],
  );

  const orderMap = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders]);

  function persistPrintJobs(next: PrintJob[]) {
    setPrintJobs(next);
    savePrintJobs(next);
    window.dispatchEvent(new CustomEvent("pos-print-jobs-changed"));
  }

  function pushEvents(events: QueueEvent[]) {
    const currentQueue = loadQueue();
    const nextQueue = [...currentQueue, ...events];
    saveQueue(nextQueue);
  }

  function reprintOrder(order: PosOrder) {
    const deviceConfig = loadDeviceConfig() ?? defaultDeviceConfig;
    const enabledPrinters = deviceConfig.printers.filter((printer) => printer.enabled);
    const timestamp = new Date().toISOString();

    const nextPrintJobs = enabledPrinters
      .filter(
        (printer) =>
          (printer.role === "zone" || printer.role === "label") &&
          order.items.some((item) => item.printerGroup === (printer.zoneId ?? "")),
      )
      .map<PrintJob>((printer) => ({
        id: uid("print"),
        orderId: order.id,
        orderNo: `${order.localOrderNo} (重打)`,
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
        status: offlineMode ? "pending" : "sent",
        createdAt: timestamp,
      }));

    if (nextPrintJobs.length === 0) {
      setToast({ tone: "error", message: "沒有可打印的內容。" });
      return;
    }

    persistPrintJobs([...nextPrintJobs, ...printJobs]);
    const events = nextPrintJobs.map<QueueEvent>((job) => ({
      id: uid("evt"),
      type: "PRINT_JOB_CREATED",
      entityId: job.id,
      payload: job,
      status: offlineMode ? "pending" : "synced",
      createdAt: timestamp,
    }));
    pushEvents(events);
    setToast({ tone: "success", message: "已加入重打單打印隊列。" });
  }

  return (
    <div className="h-screen overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-screen overflow-hidden lg:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">打印</div>
                <div className="mt-1 text-sm text-slate-500">查看打印狀態、預覽與重打。</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ["all", "全部"],
                  ["sent", "已發送"],
                  ["pending", "待補傳"],
                  ["failed", "失敗"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      filter === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => setFilter(key as typeof filter)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {filteredJobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                目前沒有打印記錄
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {filteredJobs.map((job) => (
                  <article key={job.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{job.orderNo ?? job.orderId}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {job.tableName ?? "--"} · {job.printerName} · {ticketTypeLabel(job.ticketType)}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          job.status === "sent"
                            ? "bg-emerald-50 text-emerald-700"
                            : job.status === "pending"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-red-50 text-red-700"
                        }`}
                      >
                        {job.status === "sent" ? "已發送" : job.status === "pending" ? "待補傳" : "失敗"}
                      </span>
                    </div>

                    <div className="mt-3 text-xs text-slate-500">{job.createdAt.replace("T", " ").slice(0, 16)}</div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        className="rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                        onClick={() => setActiveJobId(job.id)}
                        type="button"
                      >
                        查看
                      </button>
                      <button
                        className="rounded-2xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                        onClick={() => {
                          const order = orderMap.get(job.orderId);
                          if (!order) {
                            setToast({ tone: "error", message: "找不到原始訂單，無法重打。" });
                            return;
                          }
                          reprintOrder(order);
                        }}
                        type="button"
                      >
                        重打整單
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {activeJob ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">打印預覽</div>
                <div className="mt-1 text-sm text-slate-500">
                  {activeJob.orderNo ?? activeJob.orderId} · {activeJob.tableName ?? "--"}
                </div>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setActiveJobId(null)}
                type="button"
              >
                關閉
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3 border-b border-dashed border-slate-200 pb-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{activeJob.printerName}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {activeJob.printerGroup} · {ticketTypeLabel(activeJob.ticketType)} ·{" "}
                    {activeJob.status === "sent" ? "已發送" : activeJob.status === "pending" ? "待補傳" : "失敗"}
                  </div>
                </div>
                <div className="text-right text-xs text-slate-500">{activeJob.createdAt.replace("T", " ").slice(0, 16)}</div>
              </div>

              <div className="mt-3 grid gap-3">
                {(activeJob.items ?? []).map((item, index) => (
                  <div key={`${item.name}-${index}`} className="border-b border-dashed border-slate-100 pb-3 last:border-b-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-900">{item.name}</div>
                      <div className="text-sm font-semibold text-slate-900">x{item.quantity}</div>
                    </div>
                    {item.specs?.length ? <div className="mt-1 text-xs text-slate-500">{item.specs.join(" / ")}</div> : null}
                    {item.note ? <div className="mt-1 text-xs text-slate-500">備註：{item.note}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
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
    </div>
  );
}
