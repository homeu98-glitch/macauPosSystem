"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ResponsiveModal } from "@/components/responsive-modal";
import {
  loadAccountStores,
  loadAccountUsers,
  loadAuthSession,
  loadPermissionGroups,
  saveAccountStores,
  saveAccountUsers,
  savePermissionGroups,
} from "@/lib/storage";
import { AccountPermissionGroup, AccountStore, AccountUser, UserRole } from "@/lib/types";

type AccountFormState = {
  id?: string;
  name: string;
  account: string;
  pin: string;
  role: UserRole;
  permissionGroupId: string;
  storeIds: string[];
  note: string;
};

import { formatMacauDateTime } from "@/lib/format";

function formatTime(value?: string) {
  if (!value) return "未記錄";
  return formatMacauDateTime(value);
}

function roleLabel(role: UserRole) {
  if (role === "admin") return "管理員";
  if (role === "manager") return "店長";
  return "收銀";
}

function emptyForm(permissionGroups: AccountPermissionGroup[]): AccountFormState {
  const firstGroup = permissionGroups[0];
  return {
    name: "",
    account: "",
    pin: "",
    role: (firstGroup?.role ?? "cashier") as UserRole,
    permissionGroupId: firstGroup?.id ?? "",
    storeIds: [],
    note: "",
  };
}

export function AdminAccountsPage() {
  const session = useMemo(() => loadAuthSession(), []);
  const [accounts, setAccounts] = useState<AccountUser[]>([]);
  const [stores, setStores] = useState<AccountStore[]>([]);
  const [permissionGroups, setPermissionGroups] = useState<AccountPermissionGroup[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [status, setStatus] = useState("可查看所有帳戶資料，並控制帳戶為 active 或 deactivate。");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dbMode, setDbMode] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [form, setForm] = useState<AccountFormState>({ name: "", account: "", pin: "", role: "cashier", permissionGroupId: "", storeIds: [], note: "" });
  const [newPin, setNewPin] = useState("");

  function persistLocal(nextAccounts: AccountUser[], nextStores = stores, nextPermissionGroups = permissionGroups) {
    setAccounts(nextAccounts);
    setStores(nextStores);
    setPermissionGroups(nextPermissionGroups);
    saveAccountUsers(nextAccounts);
    saveAccountStores(nextStores);
    savePermissionGroups(nextPermissionGroups);
  }

  async function loadDataset() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/accounts", { cache: "no-store" });
      const payload = (await response.json()) as {
        ok?: boolean;
        dbConfigured?: boolean;
        accounts?: AccountUser[];
        stores?: AccountStore[];
        permissionGroups?: AccountPermissionGroup[];
        source?: "supabase" | "mock";
      };
      if (response.ok && payload.ok) {
        if (payload.dbConfigured) {
          setAccounts(payload.accounts ?? []);
          setStores(payload.stores ?? []);
          setPermissionGroups(payload.permissionGroups ?? []);
          setDbMode(true);
          setStatus("目前使用資料庫帳戶資料。");
        } else {
          const localAccounts = loadAccountUsers();
          const localStores = loadAccountStores();
          const localGroups = loadPermissionGroups();
          setAccounts(localAccounts);
          setStores(localStores);
          setPermissionGroups(localGroups);
          setDbMode(false);
          setStatus("目前未配置 DB，先使用本地 fallback 模式。");
        }
      } else {
        throw new Error("admin api unavailable");
      }
    } catch {
      const localAccounts = loadAccountUsers();
      const localStores = loadAccountStores();
      const localGroups = loadPermissionGroups();
      setAccounts(localAccounts);
      setStores(localStores);
      setPermissionGroups(localGroups);
      setDbMode(false);
      setStatus("目前使用本地 fallback 模式；若配置 Supabase，帳戶管理會自動切到資料庫。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDataset();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    function reload() {
      if (!dbMode) {
        setAccounts(loadAccountUsers());
        setStores(loadAccountStores());
        setPermissionGroups(loadPermissionGroups());
      }
    }
    window.addEventListener("pos-account-users-changed", reload);
    window.addEventListener("pos-account-stores-changed", reload);
    window.addEventListener("pos-permission-groups-changed", reload);
    return () => {
      window.removeEventListener("pos-account-users-changed", reload);
      window.removeEventListener("pos-account-stores-changed", reload);
      window.removeEventListener("pos-permission-groups-changed", reload);
    };
  }, [dbMode]);

  const filteredAccounts = useMemo(() => {
    const keyword = search.trim();
    return accounts.filter((account) => {
      if (filter === "active" && !account.active) return false;
      if (filter === "inactive" && account.active) return false;
      if (!keyword) return true;
      return (
        account.account.includes(keyword) ||
        account.name.toLowerCase().includes(keyword.toLowerCase()) ||
        roleLabel(account.role).includes(keyword)
      );
    });
  }, [accounts, filter, search]);

  const effectiveSelectedId = accounts.some((account) => account.id === selectedId) ? selectedId : accounts[0]?.id ?? "";
  const selectedAccount = accounts.find((account) => account.id === effectiveSelectedId) ?? null;
  const summary = useMemo(
    () => ({
      total: accounts.length,
      active: accounts.filter((account) => account.active).length,
      inactive: accounts.filter((account) => !account.active).length,
    }),
    [accounts],
  );

  function accountStoreNames(account: AccountUser) {
    return stores.filter((store) => account.storeIds.includes(store.id)).map((store) => store.name);
  }

  function permissionGroupName(account: AccountUser) {
    return permissionGroups.find((group) => group.id === account.permissionGroupId)?.name ?? "未綁定";
  }

  function openCreate() {
    setForm(emptyForm(permissionGroups));
    setCreateOpen(true);
  }

  function openEdit(account: AccountUser) {
    setForm({
      id: account.id,
      name: account.name,
      account: account.account,
      pin: "",
      role: account.role,
      permissionGroupId: account.permissionGroupId ?? "",
      storeIds: account.storeIds,
      note: account.note ?? "",
    });
    setEditOpen(true);
  }

  function openPin(account: AccountUser) {
    setForm((current) => ({ ...current, id: account.id, name: account.name, account: account.account }));
    setNewPin("");
    setPinOpen(true);
  }

  function toggleStore(storeId: string) {
    setForm((current) => ({
      ...current,
      storeIds: current.storeIds.includes(storeId)
        ? current.storeIds.filter((item) => item !== storeId)
        : [...current.storeIds, storeId],
    }));
  }

  function syncRoleByPermissionGroup(groupId: string) {
    const group = permissionGroups.find((item) => item.id === groupId);
    setForm((current) => ({
      ...current,
      permissionGroupId: groupId,
      role: (group?.role ?? current.role) as UserRole,
    }));
  }

  async function submitCreate() {
    const account = form.account.replace(/\D/g, "").slice(0, 8);
    const pin = form.pin.replace(/\D/g, "").slice(0, 4);
    if (!form.name.trim() || !/^\d{8}$/.test(account) || !/^\d{4}$/.test(pin)) {
      setStatus("請填寫姓名、8 位帳號與 4 位 PIN。");
      return;
    }
    setSaving(true);
    try {
      if (dbMode) {
        const response = await fetch("/api/admin/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            account,
            pin,
            role: form.role,
            permissionGroupId: form.permissionGroupId || null,
            storeIds: form.storeIds,
            note: form.note.trim(),
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "新增帳戶失敗");
        }
        setAccounts(payload.accounts ?? []);
        setStores(payload.stores ?? stores);
        setPermissionGroups(payload.permissionGroups ?? permissionGroups);
      } else {
        const now = new Date().toISOString();
        persistLocal([
          ...accounts,
          {
            id: `acct-${crypto.randomUUID().slice(0, 8)}`,
            name: form.name.trim(),
            account,
            pin,
            role: form.role,
            active: true,
            storeIds: form.storeIds,
            permissionGroupId: form.permissionGroupId || undefined,
            permissions: permissionGroups.find((group) => group.id === form.permissionGroupId)?.permissions ?? {
              refundOrder: false,
              voidItem: false,
              manageAccounts: false,
            },
            createdAt: now,
            updatedAt: now,
            note: form.note.trim(),
          },
        ]);
      }
      setCreateOpen(false);
      setStatus(`已新增帳戶 ${form.name.trim()}。`);
      await loadDataset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新增帳戶失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!form.id) return;
    setSaving(true);
    try {
      if (dbMode) {
        const response = await fetch("/api/admin/accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: form.id,
            name: form.name.trim(),
            role: form.role,
            permissionGroupId: form.permissionGroupId || null,
            storeIds: form.storeIds,
            note: form.note.trim(),
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "更新帳戶失敗");
        }
      } else {
        const group = permissionGroups.find((item) => item.id === form.permissionGroupId);
        persistLocal(
          accounts.map((account) =>
            account.id === form.id
              ? {
                  ...account,
                  name: form.name.trim(),
                  role: form.role,
                  permissionGroupId: form.permissionGroupId || undefined,
                  storeIds: form.storeIds,
                  permissions: group?.permissions ?? account.permissions,
                  note: form.note.trim(),
                  updatedAt: new Date().toISOString(),
                }
              : account,
          ),
        );
      }
      setEditOpen(false);
      setStatus(`已更新帳戶 ${form.name.trim()}。`);
      await loadDataset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "更新帳戶失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function submitPinChange() {
    if (!form.id) return;
    const pin = newPin.replace(/\D/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(pin)) {
      setStatus("請輸入 4 位 PIN。");
      return;
    }
    setSaving(true);
    try {
      if (dbMode) {
        const response = await fetch("/api/admin/accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: form.id, pin }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "修改 PIN 失敗");
        }
      } else {
        persistLocal(
          accounts.map((account) =>
            account.id === form.id ? { ...account, pin, updatedAt: new Date().toISOString() } : account,
          ),
        );
      }
      setPinOpen(false);
      setStatus(`已更新帳戶 ${form.account} 的 PIN。`);
      await loadDataset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "修改 PIN 失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!selectedAccount) return;
    if (session?.account === selectedAccount.account) {
      setStatus("當前登入中的管理員帳戶不可刪除。");
      return;
    }
    setSaving(true);
    try {
      if (dbMode) {
        const response = await fetch("/api/admin/accounts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selectedAccount.id }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "刪除帳戶失敗");
        }
      } else {
        persistLocal(accounts.filter((account) => account.id !== selectedAccount.id));
      }
      setDeleteOpen(false);
      setStatus(`已刪除帳戶 ${selectedAccount.name}。`);
      await loadDataset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "刪除帳戶失敗。");
    } finally {
      setSaving(false);
    }
  }

  async function setAccountActive(accountId: string, nextActive: boolean) {
    const target = accounts.find((item) => item.id === accountId);
    if (!target) return;
    if (session?.account === target.account && !nextActive) {
      setStatus("當前登入中的管理員帳戶不可停用。");
      return;
    }
    setTogglingId(accountId);
    try {
      if (dbMode) {
        const response = await fetch("/api/admin/accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId, active: nextActive }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "更新帳戶狀態失敗");
        }
      } else {
        persistLocal(
          accounts.map((item) =>
            item.id === accountId ? { ...item, active: nextActive, updatedAt: new Date().toISOString() } : item,
          ),
        );
      }
      setStatus(`${target.name} 已${nextActive ? "設為 active" : "設為 deactivate"}。`);
      await loadDataset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "更新帳戶狀態失敗。");
    } finally {
      setTogglingId(null);
    }
  }

  function renderAccountForm(title: string, submitLabel: string, onSubmit: () => void, showAccountAndPin: boolean) {
    return (
      <ResponsiveModal
        actions={
          <>
            <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" onClick={() => { setCreateOpen(false); setEditOpen(false); }} type="button">
              取消
            </button>
            <button aria-busy={saving} className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" disabled={saving} onClick={onSubmit} type="button">
              {saving ? "提交中…" : submitLabel}
            </button>
          </>
        }
        title={title}
        widthClassName="max-w-2xl"
      >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-slate-500">姓名</span>
              <input className="rounded-2xl border border-slate-200 px-3 py-2" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            {showAccountAndPin ? (
              <label className="grid gap-1 text-sm">
                <span className="text-xs text-slate-500">帳號（8 位）</span>
                <input
                  className="rounded-2xl border border-slate-200 px-3 py-2"
                  inputMode="numeric"
                  maxLength={8}
                  value={form.account}
                  onChange={(event) => setForm((current) => ({ ...current, account: event.target.value.replace(/\D/g, "").slice(0, 8) }))}
                />
              </label>
            ) : null}
            {showAccountAndPin ? (
              <label className="grid gap-1 text-sm">
                <span className="text-xs text-slate-500">PIN（4 位）</span>
                <input
                  className="rounded-2xl border border-slate-200 px-3 py-2"
                  inputMode="numeric"
                  maxLength={4}
                  value={form.pin}
                  onChange={(event) => setForm((current) => ({ ...current, pin: event.target.value.replace(/\D/g, "").slice(0, 4) }))}
                />
              </label>
            ) : null}
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-slate-500">角色</span>
              <select
                className="rounded-2xl border border-slate-200 px-3 py-2"
                value={form.role}
                onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as UserRole }))}
              >
                <option value="admin">管理員</option>
                <option value="manager">店長</option>
                <option value="cashier">收銀</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-slate-500">權限組</span>
              <select
                className="rounded-2xl border border-slate-200 px-3 py-2"
                value={form.permissionGroupId}
                onChange={(event) => syncRoleByPermissionGroup(event.target.value)}
              >
                {permissionGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2 md:col-span-2">
              <div className="text-xs text-slate-500">綁定門店</div>
              <div className="flex flex-wrap gap-2">
                {stores.map((store) => (
                  <button
                    key={store.id}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${
                      form.storeIds.includes(store.id) ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                    }`}
                    onClick={() => toggleStore(store.id)}
                    type="button"
                  >
                    {store.name}
                  </button>
                ))}
              </div>
            </div>
            <label className="grid gap-1 text-sm md:col-span-2">
              <span className="text-xs text-slate-500">備註</span>
              <textarea
                className="min-h-[96px] rounded-2xl border border-slate-200 px-3 py-2"
                value={form.note}
                onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              />
            </label>
          </div>
      </ResponsiveModal>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <AppSidebar />
      <div className="flex min-h-screen md:pl-[72px]">
        <main className="flex min-h-screen flex-1 flex-col">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">Admin 平台</div>
                <div className="mt-1 text-sm text-slate-500">帳戶、PIN、角色、門店綁定與權限組都在同一頁管理。</div>
              </div>
              <button className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white" onClick={openCreate} type="button">
                新增帳戶
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">全部帳戶</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{summary.total}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-emerald-50 p-4">
                <div className="text-sm text-emerald-700">Active</div>
                <div className="mt-2 text-2xl font-semibold text-emerald-800">{summary.active}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-red-50 p-4">
                <div className="text-sm text-red-700">Deactivate</div>
                <div className="mt-2 text-2xl font-semibold text-red-800">{summary.inactive}</div>
              </article>
              <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm text-slate-500">資料來源</div>
                <div className="mt-2 text-lg font-semibold text-slate-900">{dbMode ? "DB / Supabase" : "Local fallback"}</div>
              </article>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {status}
            </div>
          </div>

          <div className="grid flex-1 gap-4 p-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap gap-2">
                <input className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm" onChange={(event) => setSearch(event.target.value)} placeholder="搜尋帳號 / 名稱" value={search} />
                {[
                  ["all", "全部"],
                  ["active", "Active"],
                  ["inactive", "Deactivate"],
                ].map(([key, label]) => (
                  <button key={key} className={`rounded-full px-4 py-2 text-sm font-semibold ${filter === key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`} onClick={() => setFilter(key as typeof filter)} type="button">
                    {label}
                  </button>
                ))}
              </div>

              <div className="mt-4 grid max-h-[calc(100vh-320px)] gap-2 overflow-auto pr-1">
                {loading ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">載入中…</div> : null}
                {!loading &&
                  filteredAccounts.map((account) => (
                    <button key={account.id} className={`rounded-2xl border px-4 py-3 text-left ${effectiveSelectedId === account.id ? "border-orange-300 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300"}`} onClick={() => setSelectedId(account.id)} type="button">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">{account.name}</div>
                          <div className="mt-1 text-xs text-slate-500">{account.account}</div>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${account.active ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{account.active ? "active" : "deactivate"}</span>
                      </div>
                      <div className="mt-2 text-xs text-slate-500">{roleLabel(account.role)} · {permissionGroupName(account)}</div>
                    </button>
                  ))}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              {selectedAccount ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-slate-900">{selectedAccount.name}</div>
                      <div className="mt-1 text-sm text-slate-500">{selectedAccount.account} · {roleLabel(selectedAccount.role)}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" onClick={() => openEdit(selectedAccount)} type="button">編輯帳戶</button>
                      <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" onClick={() => openPin(selectedAccount)} type="button">修改 PIN</button>
                      <button className="rounded-2xl bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 shadow-sm ring-1 ring-red-200" onClick={() => setDeleteOpen(true)} type="button">刪除帳戶</button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">PIN</div>
                      <div className="mt-2 text-lg font-semibold text-slate-900">{selectedAccount.pin}</div>
                    </article>
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">帳戶狀態</div>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-lg font-semibold text-slate-900">{selectedAccount.active ? "active" : "deactivate"}</span>
                        <button aria-busy={togglingId === selectedAccount.id} className="rounded-2xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60" disabled={togglingId === selectedAccount.id} onClick={() => setAccountActive(selectedAccount.id, !selectedAccount.active)} type="button">
                          {togglingId === selectedAccount.id ? "提交中…" : selectedAccount.active ? "設為 deactivate" : "設為 active"}
                        </button>
                      </div>
                    </article>
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">權限組</div>
                      <div className="mt-2 text-sm font-semibold text-slate-900">{permissionGroupName(selectedAccount)}</div>
                    </article>
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">綁定門店</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {accountStoreNames(selectedAccount).map((name) => (
                          <span key={name} className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">{name}</span>
                        ))}
                        {accountStoreNames(selectedAccount).length === 0 ? <span className="text-sm text-slate-500">未綁定</span> : null}
                      </div>
                    </article>
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">建立時間</div>
                      <div className="mt-2 text-sm font-semibold text-slate-900">{formatTime(selectedAccount.createdAt)}</div>
                    </article>
                    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="text-xs text-slate-500">最後登入</div>
                      <div className="mt-2 text-sm font-semibold text-slate-900">{formatTime(selectedAccount.lastLoginAt)}</div>
                    </article>
                  </div>

                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="text-sm font-semibold text-slate-900">權限明細</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selectedAccount.permissions.refundOrder ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>退款 {selectedAccount.permissions.refundOrder ? "可用" : "停用"}</span>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selectedAccount.permissions.voidItem ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>退菜 {selectedAccount.permissions.voidItem ? "可用" : "停用"}</span>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selectedAccount.permissions.manageAccounts ? "bg-orange-50 text-orange-700" : "bg-slate-200 text-slate-600"}`}>帳戶管理 {selectedAccount.permissions.manageAccounts ? "可用" : "停用"}</span>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-semibold text-slate-900">備註</div>
                    <div className="mt-2 text-sm text-slate-600">{selectedAccount.note || "未填寫"}</div>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-sm text-slate-500">請先在左邊選一個帳戶</div>
              )}
            </section>
          </div>
        </main>
      </div>

      {createOpen ? renderAccountForm("新增帳戶", "確認新增", submitCreate, true) : null}
      {editOpen ? renderAccountForm("編輯帳戶", "保存修改", submitEdit, false) : null}

      {pinOpen ? (
        <ResponsiveModal
          actions={
            <>
              <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" onClick={() => setPinOpen(false)} type="button">取消</button>
              <button aria-busy={saving} className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" disabled={saving} onClick={submitPinChange} type="button">
                {saving ? "提交中…" : "保存 PIN"}
              </button>
            </>
          }
          description={`${form.name} · ${form.account}`}
          title="修改 PIN"
          widthClassName="max-w-md"
        >
            <label className="mt-4 grid gap-1 text-sm">
              <span className="text-xs text-slate-500">新 PIN（4 位）</span>
              <input className="rounded-2xl border border-slate-200 px-3 py-2" inputMode="numeric" maxLength={4} value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 4))} />
            </label>
        </ResponsiveModal>
      ) : null}

      {deleteOpen && selectedAccount ? (
        <ResponsiveModal
          actions={
            <>
              <button className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200" onClick={() => setDeleteOpen(false)} type="button">取消</button>
              <button aria-busy={saving} className="rounded-2xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" disabled={saving} onClick={submitDelete} type="button">
                {saving ? "提交中…" : "確認刪除"}
              </button>
            </>
          }
          title="刪除帳戶"
          widthClassName="max-w-md"
        >
          <div className="text-sm text-slate-600">確定要刪除 `{selectedAccount.name}`（{selectedAccount.account}）？</div>
        </ResponsiveModal>
      ) : null}
    </div>
  );
}
