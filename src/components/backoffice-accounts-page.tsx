"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchBackofficeOverview } from "@/lib/backoffice-client";
import { AccountStore, AccountUser } from "@/lib/types";

import { formatMacauDateTime } from "@/lib/format";

function formatTime(value?: string) {
  if (!value) return "未記錄";
  return formatMacauDateTime(value);
}

function roleLabel(role: AccountUser["role"]) {
  if (role === "admin") return "管理員";
  if (role === "manager") return "店長";
  return "收銀";
}

export function BackofficeAccountsPage() {
  const [accounts, setAccounts] = useState<AccountUser[]>([]);
  const [stores, setStores] = useState<AccountStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("載入帳戶資料中…");

  useEffect(() => {
    void (async () => {
      const payload = await fetchBackofficeOverview();
      setAccounts(payload.accounts);
      setStores(payload.stores);
      setStatus(payload.dbConfigured ? "目前顯示主系統同步後的帳戶資料。" : "目前顯示本地 fallback 的帳戶資料。");
      setLoading(false);
    })();
  }, []);

  const filteredAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return accounts.filter((account) => {
      if (!keyword) return true;
      return (
        account.account.includes(keyword) ||
        account.name.toLowerCase().includes(keyword) ||
        roleLabel(account.role).includes(keyword)
      );
    });
  }, [accounts, search]);

  function storeNames(storeIds: string[]) {
    return stores.filter((store) => storeIds.includes(store.id)).map((store) => store.name);
  }

  return (
    <div className="p-4 lg:p-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <input
            className="min-w-[220px] flex-1 rounded-2xl border border-slate-200 px-4 py-2 text-sm"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜尋帳號 / 姓名 / 角色"
            value={search}
          />
        </div>
        <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">{status}</div>
      </div>

      <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">帳戶</th>
                <th className="px-4 py-3 font-semibold">角色</th>
                <th className="px-4 py-3 font-semibold">綁定門店</th>
                <th className="px-4 py-3 font-semibold">狀態</th>
                <th className="px-4 py-3 font-semibold">最後登入</th>
                <th className="px-4 py-3 font-semibold">最後同步</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>
                    載入中…
                  </td>
                </tr>
              ) : filteredAccounts.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>
                    找不到符合條件的帳戶
                  </td>
                </tr>
              ) : (
                filteredAccounts.map((account) => (
                  <tr key={account.id} className="border-t border-slate-100">
                    <td className="px-4 py-4">
                      <div className="font-semibold text-slate-900">{account.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{account.account}</div>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{roleLabel(account.role)}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        {storeNames(account.storeIds).map((name) => (
                          <span key={name} className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                            {name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          (account.effectiveActive ?? account.active) ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                        }`}
                      >
                        {(account.effectiveActive ?? account.active) ? "active" : "deactivate"}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{formatTime(account.lastLoginAt)}</td>
                    <td className="px-4 py-4 text-slate-600">{formatTime(account.lastSyncedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
