"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { loadAuthSession } from "@/lib/storage";

/**
 * Admin · 帳號管理（2026-10-21 · 多店控制台 P2）。
 *
 * 平台管理員喺呢度：
 *   · 建立後台帳號（平台級 / 店舖級），店舖級要揀 1–20 間店
 *   · 重設 PIN（重設後本人首登要再改）
 *   · 停用／啟用
 *   · 改綁店
 *
 * ## 兩個設計取捨
 *
 * 1. **角色只有兩種**（平台 / 店主），由權限組決定（`admin-full` / `pos-owner`）。
 *    唔做 per-account 權限覆寫 —— 否則「某個帳號同其他人有咩唔同」永遠查唔清。
 * 2. **店舖清單直接嚟自 Ledger `merchants`**（`/api/admin/merchants`）。建號時
 *    server 會自動 upsert `admin_stores`（id = merchant UUID），所以管理員唔需要
 *    事先「建店」。
 */

type AccountRow = {
  id: string;
  account: string;
  name: string;
  role: string;
  active: boolean;
  kind: "platform" | "owner";
  permissionGroupCode: string | null;
  storeIds: string[];
  storeNames: Record<string, string>;
  mustChangePin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  note: string;
};

type Merchant = { id: string; name: string };

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Macau",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export default function AdminAccountsPage() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);

  // 建號表單
  const [createOpen, setCreateOpen] = useState(false);
  const [fAccount, setFAccount] = useState("");
  const [fName, setFName] = useState("");
  const [fPin, setFPin] = useState("");
  const [fKind, setFKind] = useState<"owner" | "platform">("owner");
  const [fStores, setFStores] = useState<string[]>([]);
  const [storeFilter, setStoreFilter] = useState("");

  // 改綁店（每行）
  const [editingStores, setEditingStores] = useState<string | null>(null);
  const [editStores, setEditStores] = useState<string[]>([]);

  // 重設 PIN
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPin, setResetPin] = useState("");

  const token = typeof window === "undefined" ? "" : loadAuthSession()?.adminSessionToken ?? "";
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accRes, mchRes] = await Promise.all([
        fetch("/api/admin/accounts", { headers: authHeaders }),
        fetch("/api/admin/merchants", { headers: authHeaders }),
      ]);
      const accJson = (await accRes.json()) as { ok?: boolean; accounts?: AccountRow[]; error?: string };
      const mchJson = (await mchRes.json()) as { ok?: boolean; merchants?: Merchant[]; error?: string };

      if (!accRes.ok || !accJson.ok) {
        setError(accJson.error ?? `載入帳號失敗（HTTP ${accRes.status}）`);
        return;
      }
      setRows(accJson.accounts ?? []);
      // 店舖清單失敗唔應該令整頁用唔到（有機會係 Ledger 未配置）
      if (mchRes.ok && mchJson.ok) setMerchants(mchJson.merchants ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredMerchants = useMemo(() => {
    const q = storeFilter.trim().toLowerCase();
    const list = q ? merchants.filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q)) : merchants;
    return list.slice(0, 200);
  }, [merchants, storeFilter]);

  function toggleStore(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submitCreate() {
    setError(null);
    setNotice(null);

    if (!/^\d{8}$/.test(fAccount)) {
      setError("帳號必須係 8 位數字。");
      return;
    }
    if (!/^\d{4}$/.test(fPin)) {
      setError("PIN 必須係 4 位數字。");
      return;
    }
    if (!fName.trim()) {
      setError("請輸入名稱。");
      return;
    }
    if (fKind === "owner" && fStores.length === 0) {
      setError("店舖級帳號至少要揀 1 間店。");
      return;
    }

    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          account: fAccount,
          name: fName,
          pin: fPin,
          kind: fKind,
          storeIds: fKind === "owner" ? fStores : [],
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; account?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `建立失敗（HTTP ${res.status}）`);
        return;
      }
      setNotice(`已建立帳號 ${json.account}（初始 PIN ${fPin}，首次登入會強制改）。`);
      setCreateOpen(false);
      setFAccount("");
      setFName("");
      setFPin("");
      setFKind("owner");
      setFStores([]);
      await load();
    } catch {
      setError("網絡錯誤，請重試。");
    }
  }

  async function patch(account: string, body: Record<string, unknown>, okMessage: string) {
    setBusyAccount(account);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/accounts/${encodeURIComponent(account)}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `更新失敗（HTTP ${res.status}）`);
        return false;
      }
      setNotice(okMessage);
      await load();
      return true;
    } catch {
      setError("網絡錯誤，請重試。");
      return false;
    } finally {
      setBusyAccount(null);
    }
  }

  return (
    <AdminShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h2 className="mr-auto text-sm font-semibold text-slate-900">後台帳號</h2>
          <button
            type="button"
            onClick={() => {
              setCreateOpen((v) => !v);
              setError(null);
              setNotice(null);
            }}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            {createOpen ? "取消新增" : "新增帳號"}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "載入中…" : "重新載入"}
          </button>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        ) : null}
        {notice ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </p>
        ) : null}

        {createOpen ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">新增帳號</h3>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">帳號（8 位數字）</span>
                <input
                  inputMode="numeric"
                  maxLength={8}
                  value={fAccount}
                  onChange={(e) => setFAccount(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                  placeholder="例：60000099"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">名稱</span>
                <input
                  value={fName}
                  onChange={(e) => setFName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                  placeholder="例：表嫂美食（老闆）"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">初始 PIN（4 位）</span>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={fPin}
                  onChange={(e) => setFPin(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                  placeholder="首次登入會強制改"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4">
              <span className="text-xs font-medium text-slate-600">類型</span>
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="radio"
                  checked={fKind === "owner"}
                  onChange={() => setFKind("owner")}
                  className="h-4 w-4"
                />
                店舖級（只睇選中嘅店）
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="radio"
                  checked={fKind === "platform"}
                  onChange={() => setFKind("platform")}
                  className="h-4 w-4"
                />
                平台級（全部店＋可管帳號）
              </label>
            </div>

            {fKind === "owner" ? (
              <div className="mt-3 rounded-lg border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    揀店（已選 {fStores.length}／上限 20）
                  </span>
                  <input
                    value={storeFilter}
                    onChange={(e) => setStoreFilter(e.target.value)}
                    placeholder="搜尋店名"
                    className="ml-auto w-40 rounded-lg border border-slate-300 px-2 py-1 text-xs outline-none focus:border-blue-500"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {filteredMerchants.length === 0 ? (
                    <p className="py-2 text-xs text-slate-400">
                      {merchants.length === 0 ? "讀唔到店舖清單（Ledger 未配置？）" : "冇匹配店舖。"}
                    </p>
                  ) : (
                    filteredMerchants.map((m) => {
                      const checked = fStores.includes(m.id);
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setFStores((prev) => toggleStore(prev, m.id))}
                            className="h-4 w-4"
                          />
                          <span className="truncate">{m.name}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-slate-400">{m.id.slice(0, 8)}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => void submitCreate()}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-700"
              >
                建立帳號
              </button>
            </div>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">帳號</th>
                <th className="px-3 py-2 text-left font-medium">名稱</th>
                <th className="px-3 py-2 text-left font-medium">類型</th>
                <th className="px-3 py-2 text-left font-medium">綁定店舖</th>
                <th className="px-3 py-2 text-left font-medium">狀態</th>
                <th className="px-3 py-2 text-left font-medium">最後登入</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyAccount === row.account;
                const editing = editingStores === row.account;
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">{row.account}</td>
                    <td className="px-3 py-2 text-slate-800">{row.name}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          row.kind === "platform"
                            ? "bg-orange-100 text-orange-800"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {row.kind === "platform" ? "平台級" : "店舖級"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <div className="max-h-40 w-64 overflow-y-auto rounded border border-slate-200 p-2">
                          {merchants.length === 0 ? (
                            <p className="text-xs text-slate-400">讀唔到店舖清單。</p>
                          ) : (
                            merchants.map((m) => (
                              <label key={m.id} className="flex items-center gap-2 py-0.5 text-xs text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={editStores.includes(m.id)}
                                  onChange={() => setEditStores((prev) => toggleStore(prev, m.id))}
                                  className="h-3.5 w-3.5"
                                />
                                <span className="truncate">{m.name}</span>
                              </label>
                            ))
                          )}
                          <div className="mt-1 flex gap-1">
                            <button
                              type="button"
                              disabled={busy || editStores.length === 0}
                              onClick={async () => {
                                const ok = await patch(
                                  row.account,
                                  { storeIds: editStores },
                                  `已更新 ${row.account} 嘅店舖綁定。`,
                                );
                                if (ok) setEditingStores(null);
                              }}
                              className="rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white disabled:bg-slate-300"
                            >
                              儲存
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingStores(null)}
                              className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600">
                          {row.kind === "platform"
                            ? "全部（唔靠綁定）"
                            : row.storeIds.length === 0
                              ? "（未綁店）"
                              : row.storeIds
                                  .slice(0, 3)
                                  .map((id) => row.storeNames[id] ?? id)
                                  .join("、") + (row.storeIds.length > 3 ? ` 等 ${row.storeIds.length} 間` : "")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`w-fit rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            row.active ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {row.active ? "啟用" : "已停用"}
                        </span>
                        {row.mustChangePin ? (
                          <span className="w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                            待改 PIN
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(row.lastLoginAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setResetFor(row.account);
                            setResetPin("");
                          }}
                          className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          重設 PIN
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditingStores(row.account);
                            setEditStores(row.storeIds);
                          }}
                          className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          改綁店
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void patch(
                              row.account,
                              { active: !row.active },
                              `${row.account} 已${row.active ? "停用" : "啟用"}。`,
                            )
                          }
                          className={`rounded px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${
                            row.active
                              ? "border border-rose-300 text-rose-700 hover:bg-rose-50"
                              : "border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          }`}
                        >
                          {row.active ? "停用" : "啟用"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-400">
                    未有帳號。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <p className="px-1 text-[11px] leading-relaxed text-slate-400">
          帳號／PIN 規則：8 位數字 + 4 位 PIN；店舖級最多綁 20 間店。新建或重設 PIN 之後，
          該帳號首次登入會被強制改 PIN。平台級帳號唔靠綁店（範圍＝全部）。
        </p>
      </div>

      {resetFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-bold text-slate-900">重設 PIN · {resetFor}</h3>
            <p className="mt-1 mb-3 text-xs text-slate-500">
              設定臨時 PIN，該帳號下次登入會被強制改成自己嘅 PIN。
            </p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={resetPin}
              onChange={(e) => setResetPin(e.target.value.replace(/\D/g, ""))}
              placeholder="4 位數字"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetFor(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                disabled={resetPin.length !== 4 || busyAccount === resetFor}
                onClick={async () => {
                  const ok = await patch(resetFor, { pin: resetPin }, `已重設 ${resetFor} 嘅 PIN。`);
                  if (ok) setResetFor(null);
                }}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                確認重設
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}
