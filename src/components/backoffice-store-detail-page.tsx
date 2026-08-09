"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { loadLocalBackofficeOverview, updateLocalStoreActive } from "@/lib/backoffice-client";
import { AccountStore, AccountUser, BackofficeSyncJob } from "@/lib/types";

type StoreDetailPayload = {
  ok: boolean;
  dbConfigured: boolean;
  store: AccountStore;
  accounts: AccountUser[];
  bootstrapSummary: {
    sourceVersion: number;
    categories: number;
    menuItems: number;
    tables: number;
    paymentMethods: number;
    updatedAt: string;
  };
  devices: Array<{
    deviceId: string;
    terminalName: string;
    printerCount: number;
    updatedAt: string;
  }>;
  syncJobs: BackofficeSyncJob[];
  localSettingsUpdatedAt?: string;
};

function formatTime(value?: string) {
  if (!value) return "未記錄";
  return value.replace("T", " ").slice(0, 16);
}

function roleLabel(role: AccountUser["role"]) {
  if (role === "admin") return "管理員";
  if (role === "manager") return "店長";
  return "收銀";
}

export function BackofficeStoreDetailPage({ storeId }: { storeId: string }) {
  const [detail, setDetail] = useState<StoreDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("載入店舖明細中…");
  const [toggling, setToggling] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/backoffice/stores/${storeId}`, { cache: "no-store" });
      const payload = (await response.json()) as Partial<StoreDetailPayload> & { error?: string };
      if (!response.ok || !payload.ok || !payload.store) {
        throw new Error(payload.error ?? "載入店舖明細失敗");
      }
      if (!payload.dbConfigured) {
        const local = loadLocalBackofficeOverview();
        const localStore = local.stores.find((store) => store.id === storeId) ?? payload.store;
        setDetail({
          ok: true,
          dbConfigured: false,
          store: localStore,
          accounts: local.accounts.filter((account) => account.storeIds.includes(storeId)),
          bootstrapSummary: payload.bootstrapSummary!,
          devices: payload.devices ?? [],
          syncJobs: local.syncJobs,
          localSettingsUpdatedAt: payload.localSettingsUpdatedAt,
        });
        setStatus("目前未配置 DB，顯示本地 fallback 的店舖明細。");
      } else {
        setDetail(payload as StoreDetailPayload);
        setStatus("目前顯示資料庫同步後的店舖明細。");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "載入店舖明細失敗。");
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDetail();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail]);

  async function toggleStore() {
    if (!detail) return;
    const nextActive = !(detail.store.effectiveActive ?? detail.store.active);
    setToggling(true);
    try {
      if (detail.dbConfigured) {
        const response = await fetch(`/api/backoffice/stores/${storeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: nextActive }),
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "更新店舖狀態失敗");
        }
      } else {
        updateLocalStoreActive(storeId, nextActive);
      }
      setStatus(`${detail.store.name} 已${nextActive ? "啟用" : "停用"}。`);
      await loadDetail();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "更新店舖狀態失敗。");
    } finally {
      setToggling(false);
    }
  }

  if (loading || !detail) {
    return <div className="p-6 text-sm text-slate-500">載入中…</div>;
  }

  const active = detail.store.effectiveActive ?? detail.store.active;

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <Link className="text-sm font-semibold text-violet-600" href="/backoffice/stores">
          ← 返回店舖總覽
        </Link>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-semibold text-slate-900">{detail.store.name}</div>
            <div className="mt-1 text-sm text-slate-500">
              {(detail.store.code ?? detail.store.id).toUpperCase()} · {detail.store.city ?? "澳門"} · 來源 {detail.store.sourceStoreId ?? detail.store.id}
            </div>
          </div>
          <div className="flex gap-2">
            <span
              className={`rounded-full px-3 py-2 text-sm font-semibold ${
                active ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
              }`}
            >
              {active ? "active" : "deactivate"}
            </span>
            <button
              aria-busy={toggling}
              className={`rounded-2xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
                active ? "bg-red-600" : "bg-emerald-600"
              }`}
              disabled={toggling}
              onClick={() => void toggleStore()}
              type="button"
            >
              {toggling ? "提交中…" : active ? "停用店舖" : "啟用店舖"}
            </button>
          </div>
        </div>
        <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{status}</div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-base font-semibold text-slate-900">門店營運快照</div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <article className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs text-slate-500">最後同步</div>
              <div className="mt-2 text-lg font-semibold text-slate-900">{formatTime(detail.store.lastSyncedAt)}</div>
            </article>
            <article className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs text-slate-500">同步狀態</div>
              <div className="mt-2 text-lg font-semibold text-slate-900">{detail.store.syncStatus === "pending" ? "同步中" : detail.store.syncStatus === "error" ? "異常" : "正常"}</div>
            </article>
            <article className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs text-slate-500">帳戶數</div>
              <div className="mt-2 text-lg font-semibold text-slate-900">{detail.accounts.length}</div>
            </article>
            <article className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs text-slate-500">設備數</div>
              <div className="mt-2 text-lg font-semibold text-slate-900">{detail.devices.length}</div>
            </article>
          </div>

          <div className="mt-6 text-base font-semibold text-slate-900">POS 設定快照</div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">分類</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{detail.bootstrapSummary.categories}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">菜品</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{detail.bootstrapSummary.menuItems}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">桌台</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{detail.bootstrapSummary.tables}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">支付方式</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{detail.bootstrapSummary.paymentMethods}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">設定版本</div>
              <div className="mt-2 text-2xl font-semibold text-slate-900">{detail.bootstrapSummary.sourceVersion}</div>
            </article>
            <article className="rounded-2xl border border-slate-200 p-4">
              <div className="text-xs text-slate-500">最後更新</div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{formatTime(detail.bootstrapSummary.updatedAt)}</div>
            </article>
          </div>
        </section>

        <section className="grid gap-4">
          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-base font-semibold text-slate-900">綁定帳戶</div>
            <div className="mt-4 grid gap-3">
              {detail.accounts.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">目前沒有綁定帳戶</div>
              ) : (
                detail.accounts.map((account) => (
                  <div key={account.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-900">{account.name}</div>
                        <div className="mt-1 text-xs text-slate-500">{account.account} · {roleLabel(account.role)}</div>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${(account.effectiveActive ?? account.active) ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                        {(account.effectiveActive ?? account.active) ? "active" : "deactivate"}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">最後登入 {formatTime(account.lastLoginAt)}</div>
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-base font-semibold text-slate-900">設備</div>
            <div className="mt-4 grid gap-3">
              {detail.devices.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">目前未見設備回報</div>
              ) : (
                detail.devices.map((device) => (
                  <div key={device.deviceId} className="rounded-2xl border border-slate-200 p-4">
                    <div className="font-semibold text-slate-900">{device.terminalName}</div>
                    <div className="mt-1 text-xs text-slate-500">{device.deviceId}</div>
                    <div className="mt-2 text-sm text-slate-600">啟用打印機 {device.printerCount} 台</div>
                    <div className="mt-1 text-xs text-slate-500">最後回報 {formatTime(device.updatedAt)}</div>
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      </div>

      <section className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-base font-semibold text-slate-900">同步紀錄</div>
        <div className="mt-4 grid gap-3">
          {detail.syncJobs.map((job) => (
            <article key={job.id} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-900">{job.summary}</div>
                  <div className="mt-1 text-xs text-slate-500">{job.scope} · {job.jobType}</div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "failed" ? "bg-red-50 text-red-700" : job.status === "running" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                  {job.status === "failed" ? "失敗" : job.status === "running" ? "進行中" : "成功"}
                </span>
              </div>
              <div className="mt-2 text-sm text-slate-600">
                開始 {formatTime(job.startedAt)} · 完成 {formatTime(job.finishedAt)} · 拉取 {job.pulledCount} · 更新 {job.upsertedCount}
              </div>
              {job.error ? <div className="mt-2 text-sm text-red-600">{job.error}</div> : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
