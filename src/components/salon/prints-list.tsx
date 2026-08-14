"use client";

import { useEffect, useState, useCallback } from "react";

import type { PrintJob } from "@/lib/types";
import { loadSalonPrintJobs } from "@/lib/salon/storage";
import {
  reprintSalonJob,
  SALON_PRINT_JOBS_CHANGED_EVENT,
} from "@/lib/salon/print";

const TICKET_LABEL: Record<PrintJob["ticketType"], string> = {
  normal: "收據",
  addon: "加項",
  void: "作廢",
};

const STATUS_LABEL: Record<PrintJob["status"], string> = {
  pending: "待列印",
  sent: "已送出",
  failed: "失敗",
};

const STATUS_COLORS: Record<PrintJob["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  sent: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
};

export function PrintsList() {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const reload = useCallback(() => {
    setJobs(loadSalonPrintJobs());
  }, []);

  useEffect(() => {
    reload();
    if (typeof window !== "undefined") {
      const handler = () => reload();
      window.addEventListener(SALON_PRINT_JOBS_CHANGED_EVENT, handler);
      return () => window.removeEventListener(SALON_PRINT_JOBS_CHANGED_EVENT, handler);
    }
  }, [reload]);

  const handleReprint = useCallback(
    async (job: PrintJob) => {
      setBusyId(job.id);
      setMsg("");
      const res = await reprintSalonJob(job);
      setBusyId(null);
      if (!res.ok) {
        setMsg(res.error ?? "重印失敗");
      } else {
        setMsg(`已重印：${job.orderNo ?? job.tableName ?? job.id}`);
      }
    },
    [],
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">列印任務</h1>
        <button
          type="button"
          onClick={reload}
          className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
        >
          重新整理
        </button>
      </div>

      {msg && (
        <div className="mb-3 rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-600">{msg}</div>
      )}

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          暫無 salon 列印任務。完成結帳後收據會自動進入此佇列。
        </div>
      ) : (
        <div className="grid gap-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[job.status] ?? "bg-slate-100 text-slate-600"}`}
                  >
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                  <span className="text-sm font-semibold text-slate-800">
                    {job.orderNo ?? job.tableName ?? job.id}
                  </span>
                  <span className="text-xs text-slate-400">{TICKET_LABEL[job.ticketType] ?? job.ticketType}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {job.printerName} · {job.items?.length ?? 0} 項 ·{" "}
                  {new Date(job.createdAt).toLocaleString("zh-HK", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleReprint(job)}
                disabled={busyId === job.id}
                className="rounded-xl bg-rose-500 px-3 py-2 text-xs font-bold text-white hover:bg-rose-600 disabled:opacity-50"
              >
                {busyId === job.id ? "列印中…" : "重印"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
