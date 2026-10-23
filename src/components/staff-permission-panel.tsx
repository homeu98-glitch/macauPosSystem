"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  POS_STAFF_ACTION_IDS,
  POS_STAFF_ACTION_LABELS,
  POS_STAFF_PAGE_IDS,
  POS_STAFF_PAGE_LABELS,
  POS_STAFF_ROLE_HINTS,
  POS_STAFF_ROLE_IDS,
  POS_STAFF_ROLE_LABELS,
  defaultPosStaffPermissions,
  type PosStaffDto,
  type PosStaffPermissions,
  type PosStaffRole,
} from "@/lib/pos/staff-core";
import {
  bindThisDevice as bindDeviceApi,
  clearDeviceBinding,
  defaultDeviceLabel,
  loadDeviceBinding,
  loadOrCreateDeviceId,
} from "@/lib/pos/device-binding";
import type { BoundDeviceDto } from "@/lib/pos/device-binding-types";

/**
 * 「權限控制」面板 —— 店主設定員工角色／可見頁面／操作權限。
 *
 * ## 同一個元件、兩個入口（2026-10-23 J 要求）
 *
 * | 入口 | 傳入 | 鑑權 |
 * |---|---|---|
 * | POS 設定頁 › 權限控制 | `ledgerAccessToken` | `/api/pos/staff` 用 `x-pos-ledger-token` 驗「係唔係本店 owner」 |
 * | 後台 `/admin/staff` | `adminToken` | 驗 `adminSessionToken` + `resolveAdminScope()` |
 *
 * ## 為何唔用 `useT()`
 *
 * `useT()` 冇 provider 會**直接 throw**（見 `lang-provider.tsx`），而 `/admin/*`
 * 冇掛 LangProvider。呢個元件兩邊共用，所以文案直接寫繁中 ——
 * 寧願少一層翻譯，都唔可以令後台一開就白屏。
 *
 * ⚠️ 觸控規範（J 要求）：所有可撳嘅嘢高度 ≥44px、輸入框 16px 字（防 iOS 自動放大）、
 *    窄屏唔會橫向溢出、文字唔截斷。
 */

type AuthProps = {
  storeId: string;
  /** 後台入口用 */
  adminToken?: string | null;
  /** POS 設定頁用（Ledger 店主 access token） */
  ledgerAccessToken?: string | null;
  ledgerRefreshToken?: string | null;
  /** 後台顯示店名（可選） */
  storeName?: string;
  /**
   * 顯示「授權呢部機」（2026-10-23，docs/160 §10）。
   * 只有 POS 設定頁傳 true —— 後台 `/admin/staff` 授權嘅係管理員自己部電腦，冇意義。
   */
  enableDeviceBinding?: boolean;
};

type DraftState = {
  mode: "create" | "edit";
  id?: string;
  staffNo: string;
  name: string;
  role: PosStaffRole;
  pin: string;
  active: boolean;
  note: string;
  permissions: PosStaffPermissions;
};

function formatTs(iso: string | null): string {
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

function newDraft(): DraftState {
  return {
    mode: "create",
    staffNo: "",
    name: "",
    role: "cashier",
    pin: "",
    active: true,
    note: "",
    permissions: defaultPosStaffPermissions("cashier"),
  };
}

export function StaffPermissionPanel(props: AuthProps) {
  const { storeId, adminToken, ledgerAccessToken, ledgerRefreshToken, storeName, enableDeviceBinding } = props;

  const [staff, setStaff] = useState<PosStaffDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tableReady, setTableReady] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken) h.Authorization = `Bearer ${adminToken}`;
    if (ledgerAccessToken) h["x-pos-ledger-token"] = ledgerAccessToken;
    if (ledgerRefreshToken) h["x-pos-ledger-refresh"] = ledgerRefreshToken;
    return h;
  }, [adminToken, ledgerAccessToken, ledgerRefreshToken]);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/pos/staff?storeId=${encodeURIComponent(storeId)}`, {
        headers,
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        staff?: PosStaffDto[];
        tableReady?: boolean;
      };
      if (payload.tableReady === false) {
        setTableReady(false);
        setStaff([]);
        return;
      }
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "讀取店員資料失敗。");
        return;
      }
      setTableReady(true);
      setStaff(payload.staff ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "網絡錯誤，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, [headers, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!draft) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDraft(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

  function openCreate() {
    setFormError("");
    setDraft(newDraft());
  }

  function openEdit(item: PosStaffDto) {
    setFormError("");
    setDraft({
      mode: "edit",
      id: item.id,
      staffNo: item.staffNo,
      name: item.name,
      role: item.role,
      pin: "",
      active: item.active,
      note: item.note,
      permissions: item.permissions,
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setFormError("");
    try {
      const body: Record<string, unknown> = {
        storeId,
        staffNo: draft.staffNo,
        name: draft.name,
        role: draft.role,
        permissions: draft.permissions,
        active: draft.active,
        note: draft.note,
      };
      // ⚠️ 編輯時留空 = 不改 PIN；唔可以送 `pin: ""`（會被當成「設一個空 PIN」）
      if (draft.pin) body.pin = draft.pin;

      const url = draft.mode === "create" ? "/api/pos/staff" : `/api/pos/staff/${draft.id}`;
      const response = await fetch(url, {
        method: draft.mode === "create" ? "POST" : "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        staff?: PosStaffDto;
        tableReady?: boolean;
      };

      if (payload.tableReady === false) {
        setTableReady(false);
        setDraft(null);
        return;
      }
      if (!response.ok || !payload.ok || !payload.staff) {
        setFormError(payload.error ?? "儲存失敗，請稍後再試。");
        return;
      }

      const saved = payload.staff;
      setStaff((prev) => {
        const next = prev.filter((item) => item.id !== saved.id);
        next.push(saved);
        return next.sort((a, b) => a.staffNo.localeCompare(b.staffNo, "zh-Hant"));
      });
      setDraft(null);
      setNotice(`已${draft.mode === "create" ? "新增" : "更新"}「${saved.name}」。`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "網絡錯誤，請稍後再試。");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item: PosStaffDto) {
    if (item.active) {
      const ok = window.confirm(
        `確定停用「${item.name}」？停用後佢即刻簽到唔到，但歷史訂單／交班紀錄會保留。`,
      );
      if (!ok) return;
    }
    setError("");
    try {
      const response = await fetch(`/api/pos/staff/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          storeId,
          staffNo: item.staffNo,
          name: item.name,
          role: item.role,
          permissions: item.permissions,
          active: !item.active,
          note: item.note,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; staff?: PosStaffDto };
      if (!response.ok || !payload.ok || !payload.staff) {
        setError(payload.error ?? "更新狀態失敗。");
        return;
      }
      const saved = payload.staff;
      setStaff((prev) => prev.map((row) => (row.id === saved.id ? saved : row)));
      setNotice(`已${saved.active ? "啟用" : "停用"}「${saved.name}」。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "網絡錯誤，請稍後再試。");
    }
  }

  const activeCount = staff.filter((item) => item.active).length;

  return (
    <div className="grid gap-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold text-slate-900">員工權限</div>
            <div className="mt-1 text-sm text-slate-500">
              {storeName ? `${storeName} · ` : ""}
              設定邊個員工可以登入收銀台、做咩角色、睇得到邊幾頁。
            </div>
          </div>
          <button
            className="min-h-[44px] rounded-full bg-orange-500 px-5 text-white disabled:opacity-60"
            disabled={!tableReady || loading}
            onClick={openCreate}
            type="button"
          >
            <span className="text-sm font-semibold">＋ 新增員工</span>
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full bg-slate-100 px-3 py-1">
            啟用中 {activeCount} 人 / 共 {staff.length} 人
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1">
            店主唔受呢度限制（Ledger owner 永遠全開）
          </span>
        </div>

        {notice ? (
          <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        {!tableReady ? (
          <div className="mt-3 rounded-xl bg-amber-50 px-3 py-3 text-sm leading-relaxed text-amber-900">
            <div className="font-semibold">店員權限表未建立</div>
            <div className="mt-1">
              請喺 POS Supabase 專案嘅 SQL Editor 執行
              <code className="mx-1 rounded bg-white px-1 py-0.5 text-xs">
                supabase/migrations/0072_pos_staff_permissions.sql
              </code>
              ，執行完重新整理呢一頁就可用。
            </div>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">載入中…</div>
        ) : staff.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="text-sm font-semibold text-slate-700">仲未有任何員工</div>
            <div className="mt-1 text-sm text-slate-500">
              新增之後，員工就可以喺收銀台用「工號 + PIN」簽到（唔需要 Ledger 戶口）。
            </div>
          </div>
        ) : (
          staff.map((item) => {
            const pageCount = POS_STAFF_PAGE_IDS.filter((id) => item.permissions.pages[id]).length;
            const actionCount = POS_STAFF_ACTION_IDS.filter((id) => item.permissions.actions[id]).length;
            const locked =
              item.lockedUntil !== null && new Date(item.lockedUntil).getTime() > Date.now();
            return (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-4 py-3 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{item.name}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      工號 {item.staffNo}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        item.role === "manager"
                          ? "bg-violet-50 text-violet-700"
                          : "bg-sky-50 text-sky-700"
                      }`}
                    >
                      {POS_STAFF_ROLE_LABELS[item.role]}
                    </span>
                    {!item.active ? (
                      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                        已停用
                      </span>
                    ) : null}
                    {locked ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        PIN 鎖定至 {formatTs(item.lockedUntil)}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    可見 {pageCount}/{POS_STAFF_PAGE_IDS.length} 頁 · 權限 {actionCount}/
                    {POS_STAFF_ACTION_IDS.length} 項 · 最後簽到 {formatTs(item.lastLoginAt)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    className="min-h-[44px] rounded-full bg-slate-100 px-4 text-slate-700"
                    onClick={() => openEdit(item)}
                    type="button"
                  >
                    <span className="text-sm font-semibold">編輯</span>
                  </button>
                  <button
                    className={`min-h-[44px] rounded-full px-4 ${
                      item.active ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
                    }`}
                    onClick={() => void toggleActive(item)}
                    type="button"
                  >
                    <span className="text-sm font-semibold">{item.active ? "停用" : "啟用"}</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <DeviceBindingSection
        adminToken={adminToken}
        enableBind={Boolean(enableDeviceBinding)}
        ledgerAccessToken={ledgerAccessToken}
        ledgerRefreshToken={ledgerRefreshToken}
        storeId={storeId}
      />

      {draft ? (
        <StaffEditorSheet
          draft={draft}
          error={formError}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void save()}
          saving={saving}
        />
      ) : null}
    </div>
  );
}

function StaffEditorSheet(props: {
  draft: DraftState;
  saving: boolean;
  error: string;
  onChange: (next: DraftState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft, saving, error, onChange, onClose, onSave } = props;
  const isCreate = draft.mode === "create";

  function patch(partial: Partial<DraftState>) {
    onChange({ ...draft, ...partial });
  }

  function setRole(role: PosStaffRole) {
    // 換角色 = 重新套用該角色預設（避免「店長但只有收銀權限」嘅怪狀態）
    onChange({ ...draft, role, permissions: defaultPosStaffPermissions(role) });
  }

  function togglePage(id: (typeof POS_STAFF_PAGE_IDS)[number]) {
    onChange({
      ...draft,
      permissions: {
        ...draft.permissions,
        pages: { ...draft.permissions.pages, [id]: !draft.permissions.pages[id] },
      },
    });
  }

  function toggleAction(id: (typeof POS_STAFF_ACTION_IDS)[number]) {
    onChange({
      ...draft,
      permissions: {
        ...draft.permissions,
        actions: { ...draft.permissions.actions, [id]: !draft.permissions.actions[id] },
      },
    });
  }

  return (
    <div
      aria-label={isCreate ? "新增員工" : "編輯員工"}
      aria-modal="true"
      className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-900/40 p-3 sm:items-center"
      role="dialog"
    >
      <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-slate-900">
              {isCreate ? "新增員工" : `編輯「${draft.name || draft.staffNo}」`}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              員工用「工號 + PIN」喺收銀台簽到，唔需要 Ledger 戶口。
            </div>
          </div>
          <button
            aria-label="關閉"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-600"
            onClick={onClose}
            type="button"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-slate-700">工號</span>
            <input
              className="min-h-[44px] rounded-xl border border-slate-200 px-3 text-base text-slate-900 outline-none focus:border-orange-400"
              inputMode="text"
              maxLength={12}
              onChange={(e) => patch({ staffNo: e.target.value })}
              placeholder="例如 01"
              value={draft.staffNo}
            />
            <span className="text-xs text-slate-500">店內唯一，英數／-／_，最長 12 位。</span>
          </label>
          <label className="grid gap-1">
            <span className="text-sm font-medium text-slate-700">姓名</span>
            <input
              className="min-h-[44px] rounded-xl border border-slate-200 px-3 text-base text-slate-900 outline-none focus:border-orange-400"
              maxLength={40}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="例如 陳小明"
              value={draft.name}
            />
          </label>
        </div>

        <div className="mt-4">
          <div className="text-sm font-medium text-slate-700">角色</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {POS_STAFF_ROLE_IDS.map((role) => {
              const active = draft.role === role;
              return (
                <button
                  key={role}
                  className={`min-h-[60px] rounded-2xl border px-3 py-2 text-left ${
                    active
                      ? "border-orange-400 bg-orange-50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                  onClick={() => setRole(role)}
                  type="button"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    {POS_STAFF_ROLE_LABELS[role]}
                  </div>
                  <div className="mt-0.5 text-xs leading-snug text-slate-500">
                    {POS_STAFF_ROLE_HINTS[role]}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <label className="mt-4 grid gap-1">
          <span className="text-sm font-medium text-slate-700">
            {isCreate ? "PIN（4 位數字）" : "重設 PIN（留空 = 不改）"}
          </span>
          <input
            className="min-h-[44px] w-full max-w-[220px] rounded-xl border border-slate-200 px-3 text-base tracking-[0.4em] text-slate-900 outline-none focus:border-orange-400"
            inputMode="numeric"
            maxLength={4}
            onChange={(e) => patch({ pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            placeholder="••••"
            type="password"
            value={draft.pin}
          />
          <span className="text-xs text-slate-500">
            唔可以用 0000／1234／連續數字。忘記 PIN 就喺度直接重設。
          </span>
        </label>

        <div className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-medium text-slate-700">可以睇邊幾頁</div>
            <div className="text-xs text-slate-500">冇勾 = 側欄唔會出現（唔係灰住）</div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {POS_STAFF_PAGE_IDS.map((id) => {
              const checked = draft.permissions.pages[id];
              return (
                <button
                  key={id}
                  aria-pressed={checked}
                  className={`min-h-[44px] rounded-xl border px-3 ${
                    checked
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-white text-slate-500"
                  }`}
                  onClick={() => togglePage(id)}
                  type="button"
                >
                  <span className="text-sm font-semibold">
                    {checked ? "✓ " : ""}
                    {POS_STAFF_PAGE_LABELS[id]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-medium text-slate-700">可以做咩操作</div>
            <div className="text-xs text-slate-500">高風險項目建議只開畀店長</div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {POS_STAFF_ACTION_IDS.map((id) => {
              const checked = draft.permissions.actions[id];
              return (
                <button
                  key={id}
                  aria-pressed={checked}
                  className={`min-h-[56px] rounded-xl border px-3 py-2 text-left ${
                    checked
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-slate-200 bg-white"
                  }`}
                  onClick={() => toggleAction(id)}
                  type="button"
                >
                  <div
                    className={`text-sm font-semibold ${
                      checked ? "text-emerald-800" : "text-slate-600"
                    }`}
                  >
                    {checked ? "✓ " : ""}
                    {POS_STAFF_ACTION_LABELS[id].label}
                  </div>
                  <div className="mt-0.5 text-xs leading-snug text-slate-500">
                    {POS_STAFF_ACTION_LABELS[id].hint}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <label className="mt-4 grid gap-1">
          <span className="text-sm font-medium text-slate-700">備註（可選）</span>
          <input
            className="min-h-[44px] rounded-xl border border-slate-200 px-3 text-base text-slate-900 outline-none focus:border-orange-400"
            maxLength={120}
            onChange={(e) => patch({ note: e.target.value })}
            placeholder="例如：夜更兼職，只做五六日"
            value={draft.note}
          />
        </label>

        <button
          aria-pressed={draft.active}
          className={`mt-4 flex min-h-[48px] w-full items-center justify-between rounded-xl border px-3 ${
            draft.active ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"
          }`}
          onClick={() => patch({ active: !draft.active })}
          type="button"
        >
          <span className="text-sm font-semibold text-slate-800">
            {draft.active ? "啟用（可以簽到）" : "停用（簽到唔到）"}
          </span>
          <span
            className={`relative h-6 w-11 rounded-full transition ${
              draft.active ? "bg-emerald-500" : "bg-slate-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                draft.active ? "left-5" : "left-0.5"
              }`}
            />
          </span>
        </button>

        {error ? (
          <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            className="min-h-[44px] rounded-full bg-slate-100 px-5 text-slate-700"
            onClick={onClose}
            type="button"
          >
            <span className="text-sm font-semibold">取消</span>
          </button>
          <button
            className="min-h-[44px] rounded-full bg-orange-500 px-6 text-white disabled:opacity-60"
            disabled={saving}
            onClick={onSave}
            type="button"
          >
            <span className="text-sm font-semibold">{saving ? "儲存中…" : "儲存"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 裝置授權（2026-10-23，docs/160 §10）。
 *
 * 解決嘅問題：L2（工號 + PIN）依附 L1（店舖登入），而 L1 只有店主 Ledger 帳密
 * ⇒ 新機／清 cache／登出之後，店員開機一定要店主到場。
 *
 * 店主喺呢部機登入一次並撳「授權呢部機」→ 之後開機自動恢復 session → 直接跳
 * `/operator` 簽到。撤銷即刻生效（已開咗嘅 session 最長 12h）。
 */
function DeviceBindingSection(props: {
  storeId: string;
  adminToken?: string | null;
  ledgerAccessToken?: string | null;
  ledgerRefreshToken?: string | null;
  enableBind: boolean;
}) {
  const { storeId, adminToken, ledgerAccessToken, ledgerRefreshToken, enableBind } = props;

  const [devices, setDevices] = useState<BoundDeviceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableReady, setTableReady] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [thisDeviceId, setThisDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [boundHere, setBoundHere] = useState(false);

  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken) h.Authorization = `Bearer ${adminToken}`;
    if (ledgerAccessToken) h["x-pos-ledger-token"] = ledgerAccessToken;
    if (ledgerRefreshToken) h["x-pos-ledger-refresh"] = ledgerRefreshToken;
    return h;
  }, [adminToken, ledgerAccessToken, ledgerRefreshToken]);

  useEffect(() => {
    const id = loadOrCreateDeviceId();
    setThisDeviceId(id);
    setLabel(defaultDeviceLabel());
    const binding = loadDeviceBinding();
    setBoundHere(Boolean(binding && binding.storeId === storeId));
  }, [storeId]);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/pos/device/bind?storeId=${encodeURIComponent(storeId)}`, {
        headers,
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        devices?: BoundDeviceDto[];
        tableReady?: boolean;
      };
      if (payload.tableReady === false) {
        setTableReady(false);
        setDevices([]);
        return;
      }
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "讀取裝置授權失敗。");
        return;
      }
      setTableReady(true);
      setDevices(payload.devices ?? []);
    } catch {
      setError("網絡錯誤，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, [headers, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleBind() {
    setBusy("bind");
    setError("");
    setNotice("");
    const result = await bindDeviceApi({
      storeId,
      label,
      adminToken,
      ledgerAccessToken,
      ledgerRefreshToken,
    });
    setBusy("");
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBoundHere(true);
    setNotice("已授權呢部機。之後店員用工號 + PIN 就可以開機，唔需要店主帳號密碼。");
    void load();
  }

  async function handleRevoke(deviceId: string, isThisDevice: boolean) {
    if (!window.confirm(isThisDevice ? "撤銷呢部機之後，店員開機就要店主重新登入授權。確定？" : "確定撤銷呢部裝置？")) {
      return;
    }
    setBusy(deviceId);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/pos/device/bind", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ storeId, deviceId }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string; tableReady?: boolean };
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "撤銷失敗。");
        return;
      }
      if (isThisDevice) {
        clearDeviceBinding();
        setBoundHere(false);
      }
      setNotice("已撤銷。");
      void load();
    } catch {
      setError("網絡錯誤，請稍後再試。");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-base font-semibold text-slate-900">裝置授權</div>
      <div className="mt-1 text-sm leading-relaxed text-slate-500">
        店主喺呢部機登入一次並授權之後，店員只需要「工號 + PIN」就可以開機，
        唔需要知道店主帳號密碼。撤銷即刻生效（已開咗嘅機最長 12 小時後失效）。
      </div>

      {notice ? (
        <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      {!tableReady ? (
        <div className="mt-3 rounded-xl bg-amber-50 px-3 py-3 text-sm leading-relaxed text-amber-900">
          <div className="font-semibold">裝置授權表未建立</div>
          <div className="mt-1">
            請喺 POS Supabase 專案嘅 SQL Editor 執行
            <code className="mx-1 rounded bg-white px-1 py-0.5 text-xs">
              supabase/migrations/0073_pos_bound_devices.sql
            </code>
            ，執行完重新整理呢一頁就可用。
          </div>
        </div>
      ) : null}

      {enableBind ? (
        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <div className="text-sm font-semibold text-slate-800">呢部機</div>
          {boundHere ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-emerald-700">已授權 —— 店員可以直接簽到開機。</div>
              <button
                className="min-h-[44px] rounded-full bg-red-50 px-4 text-red-700 disabled:opacity-60"
                disabled={busy === thisDeviceId}
                onClick={() => void handleRevoke(thisDeviceId, true)}
                type="button"
              >
                <span className="text-sm font-semibold">撤銷呢部機</span>
              </button>
            </div>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
              <input
                className="min-h-[44px] rounded-xl border border-slate-200 px-3 text-base text-slate-800 outline-none focus:border-orange-400"
                maxLength={60}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="裝置名稱（例如：收銀台 iPad）"
                value={label}
              />
              <button
                className="min-h-[44px] rounded-full bg-orange-500 px-5 text-white disabled:opacity-60"
                disabled={busy === "bind"}
                onClick={() => void handleBind()}
                type="button"
              >
                <span className="text-sm font-semibold">{busy === "bind" ? "授權中…" : "授權呢部機"}</span>
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
        {loading ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">載入中…</div>
        ) : devices.filter((item) => !item.revokedAt).length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">仲未有已授權裝置。</div>
        ) : (
          devices
            .filter((item) => !item.revokedAt)
            .map((item) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0"
                key={`${item.storeId}:${item.deviceId}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">
                    {item.label || "未命名裝置"}
                    {item.deviceId === thisDeviceId ? (
                      <span className="ml-2 rounded-full bg-orange-50 px-2 py-0.5 text-xs text-orange-700">呢部機</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    授權 {formatTs(item.boundAt)} · 最後使用 {formatTs(item.lastSeenAt)}
                  </div>
                </div>
                <button
                  className="min-h-[44px] rounded-full bg-slate-100 px-4 text-slate-700 disabled:opacity-60"
                  disabled={busy === item.deviceId}
                  onClick={() => void handleRevoke(item.deviceId, item.deviceId === thisDeviceId)}
                  type="button"
                >
                  <span className="text-sm font-semibold">撤銷</span>
                </button>
              </div>
            ))
        )}
      </div>
    </section>
  );
}
