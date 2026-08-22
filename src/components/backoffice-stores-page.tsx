"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { fetchBackofficeOverview, updateLocalStoreActive } from "@/lib/backoffice-client";
import { AccountStore, AccountUser, BackofficeSyncJob } from "@/lib/types";

import { formatMacauDateTime } from "@/lib/format";

function formatTime(value?: string) {
  if (!value) return "未記錄";
  return formatMacauDateTime(value);
}

function storeAccounts(accounts: AccountUser[], storeId: string) {
  return accounts.filter((account) => account.storeIds.includes(storeId));
}

export function BackofficeStoresPage() {
  const [stores, setStores] = useState<AccountStore[]>([]);
  const [accounts, setAccounts] = useState<AccountUser[]>([]);
  const [syncJobs, setSyncJobs] = useState<BackofficeSyncJob[]>([]);
  const [dbMode, setDbMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("載入總部店舖資料中…");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [industry, setIndustry] = useState<"all" | "restaurant" | "salon">("all");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    const payload = await fetchBackofficeOverview();
    setStores(payload.stores);
    setAccounts(payload.accounts);
    setSyncJobs(payload.syncJobs);
    setDbMode(payload.dbConfigured);
    setStatus(payload.dbConfigured ? "目前顯示資料庫同步後的店舖資料。" : "目前未配置 DB，先用本地 fallback 模式演示後台。");
    setLoading(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const filteredStores = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return stores.filter((store) => {
      const active = store.effectiveActive ?? store.active;
      const storeIndustry = store.industry ?? "restaurant";
      if (filter === "active" && !active) return false;
      if (filter === "inactive" && active) return false;
      if (industry !== "all" && storeIndustry !== industry) return false;
      if (!keyword) return true;
      return (
        store.name.toLowerCase().includes(keyword) ||
        (store.code ?? "").toLowerCase().includes(keyword) ||
        (store.city ?? "").toLowerCase().includes(keyword)
      );
    });
  }, [filter, industry, search, stores]);

  const summary = useMemo(
    () => ({
      total: stores.length,
      active: stores.filter((store) => store.effectiveActive ?? store.active).length,
      inactive: stores.filter((store) => !(store.effectiveActive ?? store.active)).length,
      syncErrors: syncJobs.filter((job) => job.status === "failed").length,
      restaurant: stores.filter((store) => (store.industry ?? "restaurant") === "restaurant").length,
      salon: stores.filter((store) => store.industry === "salon").length,
    }),
    [stores, syncJobs],
  );

  async function toggleStore(store: AccountStore) {
    const nextActive = !(store.effectiveActive ?? store.active);
    setTogglingId(store.id);
    try {
      if (dbMode) {
        const response = await fetch(`/api/backoffice/stores/${store.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: nextActive }),
        });
        const payload = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "更新店舖狀態失敗");
        }
      } else {
        setStores(updateLocalStoreActive(store.id, nextActive));
      }
      setStatus(`${store.name} 已${nextActive ? "啟用" : "停用"}。`);
      await loadData();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "更新店舖狀態失敗。");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="grid gap-3 md:grid-cols-3">
        <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm text-slate-500">全部店舖</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">{summary.total}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-emerald-50 p-5 shadow-sm">
          <div className="text-sm text-emerald-700">營運中</div>
          <div className="mt-2 text-3xl font-semibold text-emerald-800">{summary.active}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-red-50 p-5 shadow-sm">
          <div className="text-sm text-red-700">已停用</div>
          <div className="mt-2 text-3xl font-semibold text-red-800">{summary.inactive}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-sky-50 p-5 shadow-sm">
          <div className="text-sm text-sky-700">餐飲店</div>
          <div className="mt-2 text-3xl font-semibold text-sky-800">{summary.restaurant}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-fuchsia-50 p-5 shadow-sm">
          <div className="text-sm text-fuchsia-700">美容院</div>
          <div className="mt-2 text-3xl font-semibold text-fuchsia-800">{summary.salon}</div>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-amber-50 p-5 shadow-sm">
          <div className="text-sm text-amber-700">同步異常</div>
          <div className="mt-2 text-3xl font-semibold text-amber-800">{summary.syncErrors}</div>
        </article>
      </div>

      <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <input
            className="min-w-[220px] flex-1 rounded-2xl border border-slate-200 px-4 py-2 text-sm"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜尋店名 / code / 城市"
            value={search}
          />
          {[
            ["all", "全部"],
            ["active", "營運中"],
            ["inactive", "已停用"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                filter === key ? "bg-violet-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setFilter(key as typeof filter)}
              type="button"
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-6 w-px bg-slate-200" />
          {[
            ["all", "全部行業"],
            ["restaurant", "餐飲"],
            ["salon", "美容"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                industry === key ? "bg-sky-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setIndustry(key as typeof industry)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{status}</div>
      </div>

      <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">店舖</th>
                <th className="px-4 py-3 font-semibold">行業</th>
                <th className="px-4 py-3 font-semibold">狀態</th>
                <th className="px-4 py-3 font-semibold">綁定帳戶</th>
                <th className="px-4 py-3 font-semibold">最後同步</th>
                <th className="px-4 py-3 font-semibold">同步狀態</th>
                <th className="px-4 py-3 font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={7}>
                    載入中…
                  </td>
                </tr>
              ) : filteredStores.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={7}>
                    找不到符合條件的店舖
                  </td>
                </tr>
              ) : (
                filteredStores.map((store) => {
                  const active = store.effectiveActive ?? store.active;
                  const boundAccounts = storeAccounts(accounts, store.id);
                  return (
                    <tr key={store.id} className="border-t border-slate-100">
                      <td className="px-4 py-4">
                        <Link className="font-semibold text-slate-900 hover:text-violet-600" href={`/backoffice/stores/${store.id}`}>
                          {store.name}
                        </Link>
                        <div className="mt-1 text-xs text-slate-500">
                          {(store.code ?? store.id).toUpperCase()} · {store.city ?? "澳門"}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            (store.industry ?? "restaurant") === "salon"
                              ? "bg-fuchsia-50 text-fuchsia-700"
                              : "bg-sky-50 text-sky-700"
                          }`}
                        >
                          {(store.industry ?? "restaurant") === "salon" ? "美容" : "餐飲"}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            active ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                          }`}
                        >
                          {active ? "active" : "deactivate"}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-slate-600">{boundAccounts.length} 個帳戶</td>
                      <td className="px-4 py-4 text-slate-600">{formatTime(store.lastSyncedAt ?? store.updatedAt)}</td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            store.syncStatus === "error"
                              ? "bg-red-50 text-red-700"
                              : store.syncStatus === "pending"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {store.syncStatus === "error" ? "異常" : store.syncStatus === "pending" ? "同步中" : "正常"}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          <Link
                            className="rounded-2xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                            href={`/backoffice/stores/${store.id}`}
                          >
                            查看明細
                          </Link>
                          <button
                            aria-busy={togglingId === store.id}
                            className={`rounded-2xl px-3 py-2 text-xs font-semibold text-white disabled:opacity-60 ${
                              active ? "bg-red-600" : "bg-emerald-600"
                            }`}
                            disabled={togglingId === store.id}
                            onClick={() => void toggleStore(store)}
                            type="button"
                          >
                            {togglingId === store.id ? "提交中…" : active ? "停用店舖" : "啟用店舖"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
