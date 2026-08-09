"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchBackofficeOverview } from "@/lib/backoffice-client";
import { BackofficeSyncJob } from "@/lib/types";

function formatTime(value?: string) {
  if (!value) return "未記錄";
  return value.replace("T", " ").slice(0, 16);
}

export function BackofficeSyncPage() {
  const [jobs, setJobs] = useState<BackofficeSyncJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("載入同步紀錄中…");

  async function loadData() {
    setLoading(true);
    const payload = await fetchBackofficeOverview();
    setJobs(payload.syncJobs);
    setStatus(payload.dbConfigured ? "目前顯示資料庫同步任務紀錄。" : "目前顯示 mock / fallback 同步紀錄。");
    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const summary = useMemo(
    () => ({
      success: jobs.filter((job) => job.status === "success").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      running: jobs.filter((job) => job.status === "running").length,
    }),
    [jobs],
  );

  return (
    <div className="p-4 lg:p-6">
      <div className="grid gap-3 md:grid-cols-3">
        <article className="rounded-3xl border border-slate-200 bg-emerald-50 p-5 shadow-sm">
          <div className="text-sm text-emerald-700">成功</div>
          <div className="mt-2 text-3xl font-semibold text-emerald-800">{summary.success}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-amber-50 p-5 shadow-sm">
          <div className="text-sm text-amber-700">進行中</div>
          <div className="mt-2 text-3xl font-semibold text-amber-800">{summary.running}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-red-50 p-5 shadow-sm">
          <div className="text-sm text-red-700">失敗</div>
          <div className="mt-2 text-3xl font-semibold text-red-800">{summary.failed}</div>
        </article>
      </div>

      <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">{status}</div>
          <button className="rounded-2xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white" onClick={() => void loadData()} type="button">
            重新整理
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">載入中…</div>
        ) : jobs.map((job) => (
          <article key={job.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900">{job.summary}</div>
                <div className="mt-1 text-sm text-slate-500">
                  {job.scope} · {job.jobType}
                </div>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  job.status === "failed"
                    ? "bg-red-50 text-red-700"
                    : job.status === "running"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {job.status === "failed" ? "失敗" : job.status === "running" ? "進行中" : "成功"}
              </span>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">開始</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{formatTime(job.startedAt)}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">完成</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{formatTime(job.finishedAt)}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">拉取 / 更新</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {job.pulledCount} / {job.upsertedCount}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">失敗筆數</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">{job.failedCount}</div>
              </div>
            </div>
            {job.error ? <div className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{job.error}</div> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
