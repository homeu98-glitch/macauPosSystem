"use client";

import { useEffect, useState } from "react";

import type {
  SalonPackageTemplate,
  SalonPackageItemEntry,
  SalonServiceItem,
} from "@/lib/salon/types";
import {
  loadSalonPackageTemplates,
  saveSalonPackageTemplates,
  loadSalonBootstrap,
} from "@/lib/salon/storage";

// ────────────────────────────────────────────────────────────────────
// 套票模板管理（設置頁第 6 個 tab）
// 嵌套「服務明細」編輯器（service + 次數），其餘欄位走通用 FormModal。
// 次數額度留 salon 本地；改動經 saveSalonPackageTemplates → sync 佇列上雲。
// ────────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ConfirmModal({
  title,
  message,
  danger,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-base font-bold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600">{message}</p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white ${
              danger ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-500 hover:bg-emerald-600"
            }`}
          >
            {confirmLabel ?? "確定"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PackageTemplatesTab() {
  const [templates, setTemplates] = useState<SalonPackageTemplate[]>([]);
  const [serviceItems, setServiceItems] = useState<SalonServiceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // editor state
  const [editing, setEditing] = useState<SalonPackageTemplate | null>(null);
  const [delTarget, setDelTarget] = useState<SalonPackageTemplate | null>(null);

  useEffect(() => {
    setTemplates(loadSalonPackageTemplates());
    setServiceItems(loadSalonBootstrap()?.serviceItems ?? []);
    setLoaded(true);
  }, []);

  const flash = () => {
    setSaved(true);
    if (typeof window !== "undefined") window.setTimeout(() => setSaved(false), 1500);
  };

  const persist = (next: SalonPackageTemplate[]) => {
    saveSalonPackageTemplates(next);
    setTemplates(next);
    flash();
  };

  const upsert = (t: SalonPackageTemplate) => {
    const now = new Date().toISOString();
    const finalT: SalonPackageTemplate = { ...t, updatedAt: now, createdAt: t.createdAt || now };
    const i = templates.findIndex((x) => x.id === finalT.id);
    const next = i >= 0 ? templates.map((x) => (x.id === finalT.id ? finalT : x)) : [...templates, finalT];
    persist(next);
    setEditing(null);
  };

  const remove = (t: SalonPackageTemplate) => {
    persist(templates.filter((x) => x.id !== t.id));
    setDelTarget(null);
  };

  const toggle = (t: SalonPackageTemplate) => upsert({ ...t, active: !t.active });

  const openAdd = () => {
    setEditing({
      id: genId("pkg"),
      name: "",
      price: 0,
      validityDays: 0,
      items: [],
      bonusPoints: 0,
      bonusBalance: 0,
      note: "",
      active: true,
      createdAt: "",
      updatedAt: "",
    });
  };

  const serviceName = (id: string) => serviceItems.find((s) => s.id === id)?.name ?? id;

  if (!loaded) return null;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          套票次數額度留本地；贈送積分 / 儲值委託 Ledger（P2 接通）。
        </p>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs font-semibold text-emerald-600">已儲存</span>}
          <button
            type="button"
            onClick={openAdd}
            className="rounded-xl bg-rose-100 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-200"
          >
            ＋ 新增套票
          </button>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">
          尚未有套票模板，點右上角新增。
        </div>
      ) : (
        templates.map((t) => (
          <div key={t.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-bold text-slate-900">{t.name || "(未命名)"}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {t.active ? "販售中" : "停用"}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  MOP {t.price}
                  {t.validityDays > 0 ? ` · 效期 ${t.validityDays} 天` : " · 永久"}
                  {t.bonusPoints > 0 ? ` · 贈 ${t.bonusPoints} 積分` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggle(t)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    t.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {t.active ? "停用" : "啟用"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="rounded-lg bg-white px-2 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => setDelTarget(t)}
                  className="rounded-lg bg-white px-2 py-1 text-xs text-rose-600 shadow-sm hover:bg-rose-50"
                >
                  🗑
                </button>
              </div>
            </div>
            {t.items.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {t.items.map((it, i) => (
                  <span key={i} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {serviceName(it.serviceItemId)} × {it.sessions}
                  </span>
                ))}
              </div>
            ) : null}
            {t.note ? <div className="mt-2 text-[11px] text-slate-400">{t.note}</div> : null}
          </div>
        ))
      )}

      {editing ? (
        <PackageEditor
          template={editing}
          serviceItems={serviceItems}
          onCancel={() => setEditing(null)}
          onSave={upsert}
        />
      ) : null}

      {delTarget ? (
        <ConfirmModal
          title="確定刪除套票模板？"
          message="刪除後不可復原；已售出的客戶套票卡不受影響。"
          danger
          confirmLabel="刪除"
          onConfirm={() => remove(delTarget)}
          onClose={() => setDelTarget(null)}
        />
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 套票編輯 Modal（含嵌套服務明細編輯器）
// ────────────────────────────────────────────────────────────────────
function PackageEditor({
  template,
  serviceItems,
  onCancel,
  onSave,
}: {
  template: SalonPackageTemplate;
  serviceItems: SalonServiceItem[];
  onCancel: () => void;
  onSave: (t: SalonPackageTemplate) => void;
}) {
  const [draft, setDraft] = useState<SalonPackageTemplate>(template);
  const set = (patch: Partial<SalonPackageTemplate>) => setDraft((d) => ({ ...d, ...patch }));
  const setItem = (idx: number, patch: Partial<SalonPackageItemEntry>) =>
    set({ items: draft.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) });
  const addItem = () =>
    set({
      items: [
        ...draft.items,
        { serviceItemId: serviceItems[0]?.id ?? "", sessions: 1 },
      ],
    });
  const removeItem = (idx: number) => set({ items: draft.items.filter((_, i) => i !== idx) });

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 md:place-items-center" onClick={onCancel}>
      <div
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-bold text-slate-900">{template.createdAt ? "編輯套票" : "新增套票"}</h3>

        <div className="grid gap-3">
          <div>
            <div className="mb-1 text-xs font-medium text-slate-500">套票名稱</div>
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="例如 面部 10 次豪華套票"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">售價 (MOP)</div>
              <input
                type="number"
                value={draft.price}
                onChange={(e) => set({ price: Number(e.target.value) || 0 })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">效期 (天，0=永久)</div>
              <input
                type="number"
                value={draft.validityDays}
                onChange={(e) => set({ validityDays: Number(e.target.value) || 0 })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
              />
            </div>
          </div>

          {/* 服務明細編輯器 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">服務明細（次數額度）</span>
              <button
                type="button"
                onClick={addItem}
                className="rounded-lg bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700 hover:bg-rose-200"
              >
                ＋ 加一行
              </button>
            </div>
            {draft.items.length === 0 ? (
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-center text-[11px] text-slate-400">
                尚未加服務，點「＋ 加一行」。
              </div>
            ) : (
              <div className="grid gap-1.5">
                {draft.items.map((it, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={it.serviceItemId}
                      onChange={(e) => setItem(i, { serviceItemId: e.target.value })}
                      className="flex-1 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                    >
                      {serviceItems.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={it.sessions}
                      onChange={(e) => setItem(i, { sessions: Number(e.target.value) || 0 })}
                      className="w-20 rounded-xl border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                    />
                    <span className="text-xs text-slate-400">次</span>
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      className="rounded-lg bg-white px-2 py-1 text-xs text-rose-600 shadow-sm hover:bg-rose-50"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">贈送積分 (→ Ledger)</div>
              <input
                type="number"
                value={draft.bonusPoints}
                onChange={(e) => set({ bonusPoints: Number(e.target.value) || 0 })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
              />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-slate-500">贈送儲值 (→ Ledger)</div>
              <input
                type="number"
                value={draft.bonusBalance}
                onChange={(e) => set({ bonusBalance: Number(e.target.value) || 0 })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
              />
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-slate-500">備註</div>
            <input
              value={draft.note ?? ""}
              onChange={(e) => set({ note: e.target.value })}
              placeholder="例如 含 1 支精華"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-slate-500">販售中</div>
            <button
              type="button"
              onClick={() => set({ active: !draft.active })}
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                draft.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
              }`}
            >
              {draft.active ? "啟用" : "停用"}
            </button>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-200"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-600"
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}
