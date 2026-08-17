"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";

import type {
  SalonBootstrap,
  SalonServiceCategory,
  SalonServiceItem,
  SalonStaff,
  SalonStation,
} from "@/lib/salon/types";
import {
  loadSalonBootstrap,
  saveSalonBootstrap,
  resetSalonStorage,
  reseedSalonConfig,
  loadSalonSyncQueue,
} from "@/lib/salon/storage";
import { PackageTemplatesTab } from "@/components/salon/package-templates";
import { loadDeviceConfig, saveDeviceConfig } from "@/lib/storage";
import type { DeviceConfig, DevicePrinterConfig } from "@/lib/types";

// ────────────────────────────────────────────────────────────────────
// 通用：ID 產生
// ────────────────────────────────────────────────────────────────────
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ────────────────────────────────────────────────────────────────────
// 通用表單欄位定義
// ────────────────────────────────────────────────────────────────────
interface Option {
  value: string;
  label: string;
}
type FieldType = "text" | "number" | "textarea" | "select" | "multiselect" | "toggle" | "color";
interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: Option[];
  placeholder?: string;
  help?: string;
}

function labelOf(options: Option[] | undefined, value: string): string {
  return options?.find((o) => o.value === value)?.label ?? value;
}

// ────────────────────────────────────────────────────────────────────
// 通用 Modal（新增 / 編輯表單）
// ────────────────────────────────────────────────────────────────────
function FormModal({
  title,
  fields,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: FieldDef[];
  initial: Record<string, unknown>;
  onSubmit: (draft: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...initial }));

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  const toggleMulti = (k: string, v: string) => {
    const cur = Array.isArray(draft[k]) ? (draft[k] as string[]) : [];
    set(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  const submit = () => {
    const out: Record<string, unknown> = { ...draft };
    for (const f of fields) {
      if (f.type === "number") out[f.key] = Number(draft[f.key]) || 0;
      else if (f.type === "multiselect") out[f.key] = Array.isArray(draft[f.key]) ? draft[f.key] : [];
      else if (f.type === "toggle") out[f.key] = Boolean(draft[f.key]);
      else out[f.key] = draft[f.key];
    }
    onSubmit(out);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/40 md:place-items-center" onClick={onClose}>
      <div
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-bold text-slate-900">{title}</h3>
        <div className="grid gap-3">
          {fields.map((f) => (
            <div key={f.key}>
              <div className="mb-1 text-xs font-medium text-slate-500">{f.label}</div>
              {f.type === "text" || f.type === "number" || f.type === "color" ? (
                <input
                  type={f.type === "number" ? "number" : f.type === "color" ? "color" : "text"}
                  value={String(draft[f.key] ?? "")}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              ) : f.type === "textarea" ? (
                <textarea
                  value={String(draft[f.key] ?? "")}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                  rows={2}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
              ) : f.type === "select" ? (
                <select
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "multiselect" ? (
                <div className="flex flex-wrap gap-1.5">
                  {(f.options ?? []).map((o) => {
                    const on = Array.isArray(draft[f.key]) && (draft[f.key] as string[]).includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => toggleMulti(f.key, o.value)}
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          on ? "bg-rose-500 text-white" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              ) : f.type === "toggle" ? (
                <button
                  type="button"
                  onClick={() => set(f.key, !Boolean(draft[f.key]))}
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    draft[f.key] ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {draft[f.key] ? "啟用" : "停用"}
                </button>
              ) : null}
              {f.help ? <div className="mt-1 text-[11px] text-slate-400">{f.help}</div> : null}
            </div>
          ))}
        </div>
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
            onClick={submit}
            className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-600"
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 通用確認 Modal（in-app，替代 window.confirm，PWA 可用）
// ────────────────────────────────────────────────────────────────────
function ConfirmModal({
  title,
  message,
  danger,
  confirmLabel,
  onConfirm,
  onClose,
  error,
}: {
  title: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  error?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-base font-bold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600">{message}</p>
        {error ? <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{error}</p> : null}
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

// ────────────────────────────────────────────────────────────────────
// 通用 CRUD 區塊
// ────────────────────────────────────────────────────────────────────
interface CrudSectionProps<T extends { id: string }> {
  items: T[];
  fields: FieldDef[];
  emptyFactory: () => T;
  activeKey?: string;
  activeLabels?: [string, string];
  renderSummary: (t: T) => { title: string; subtitle?: string };
  onUpsert: (t: T) => void;
  onDelete: (t: T) => void;
  onToggle?: (t: T) => void;
  canDelete?: (t: T) => { ok: boolean; reason?: string };
  addLabel?: string;
}

function CrudSection<T extends { id: string }>({
  items,
  fields,
  emptyFactory,
  activeKey = "active",
  activeLabels = ["啟用", "停用"],
  renderSummary,
  onUpsert,
  onDelete,
  onToggle,
  canDelete,
  addLabel = "＋ 新增",
}: CrudSectionProps<T>) {
  const [editing, setEditing] = useState<{ mode: "add" | "edit"; data: T } | null>(null);
  const [delTarget, setDelTarget] = useState<T | null>(null);
  const [delError, setDelError] = useState("");

  const openAdd = () => setEditing({ mode: "add", data: emptyFactory() });
  const openEdit = (it: T) => setEditing({ mode: "edit", data: it });

  const submit = (draft: Record<string, unknown>) => {
    const base = editing?.data ?? emptyFactory();
    onUpsert({ ...base, ...draft } as T);
    setEditing(null);
  };

  const requestDelete = (it: T) => {
    const chk = canDelete?.(it);
    setDelTarget(it);
    setDelError(chk && !chk.ok ? chk.reason ?? "" : "");
  };

  const confirmDelete = () => {
    if (delTarget) onDelete(delTarget);
    setDelTarget(null);
    setDelError("");
  };

  const handleToggle = (it: T) => {
    if (onToggle) return onToggle(it);
    onUpsert({ ...it, [activeKey]: !Boolean((it as Record<string, unknown>)[activeKey]) } as T);
  };

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={openAdd}
          className="rounded-xl bg-rose-100 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-200"
        >
          {addLabel}
        </button>
      </div>
      <div className="grid gap-1.5">
        {items.length === 0 ? (
          <div className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">尚未有資料，點右上角新增。</div>
        ) : (
          items.map((it) => {
            const on = Boolean((it as Record<string, unknown>)[activeKey]);
            return (
              <div key={it.id} className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">{renderSummary(it).title}</div>
                  {renderSummary(it).subtitle ? (
                    <div className="truncate text-xs text-slate-500">{renderSummary(it).subtitle}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleToggle(it)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      on ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {on ? activeLabels[0] : activeLabels[1]}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(it)}
                    className="rounded-lg bg-white px-2 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-100"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDelete(it)}
                    className="rounded-lg bg-white px-2 py-1 text-xs text-rose-600 shadow-sm hover:bg-rose-50"
                  >
                    🗑
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {editing ? (
        <FormModal
          title={editing.mode === "add" ? `新增${addLabel.replace(/^＋\s*/, "")}` : "編輯"}
          fields={fields}
          initial={editing.data as unknown as Record<string, unknown>}
          onSubmit={submit}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {delTarget ? (
        <ConfirmModal
          title="確定刪除？"
          message="刪除後不可復原。"
          danger
          confirmLabel="刪除"
          error={delError}
          onConfirm={confirmDelete}
          onClose={() => {
            setDelTarget(null);
            setDelError("");
          }}
        />
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 選項清單
// ────────────────────────────────────────────────────────────────────
const PRINTER_GROUP_OPTS: Option[] = [
  { value: "station_face", label: "面部" },
  { value: "station_body", label: "身體" },
  { value: "station_nails", label: "美甲" },
  { value: "station_wash", label: "洗護" },
  { value: "station_lashes", label: "美睫" },
  { value: "receipt", label: "收據" },
  { value: "label", label: "標籤" },
];

const STAFF_ROLE_OPTS: Option[] = [
  { value: "stylist", label: "髮型師" },
  { value: "colorist", label: "染燙師" },
  { value: "therapist", label: "療師" },
  { value: "assistant", label: "助理" },
  { value: "receptionist", label: "接待" },
];

const STATION_TYPE_OPTS: Option[] = [
  { value: "chair", label: "椅" },
  { value: "bed", label: "床" },
  { value: "room", label: "房" },
  { value: "wash", label: "洗護台" },
  { value: "nail_table", label: "美甲台" },
];

const PRINTER_ROLE_OPTS: Option[] = [
  { value: "zone", label: "分區" },
  { value: "receipt", label: "收據" },
  { value: "label", label: "標籤" },
];

const PRINTER_CONN_OPTS: Option[] = [
  { value: "lan", label: "LAN" },
  { value: "usb", label: "USB" },
  { value: "bluetooth", label: "藍牙" },
];

const TABS = [
  { id: "store", label: "店家資料" },
  { id: "category", label: "服務類目" },
  { id: "services", label: "服務管理" },
  { id: "staff", label: "員工" },
  { id: "packages", label: "套票模板" },
  { id: "dev", label: "開發工具" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// ────────────────────────────────────────────────────────────────────
// Settings 主元件
// ────────────────────────────────────────────────────────────────────
export function Settings() {
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);
  const [printers, setPrinters] = useState<DevicePrinterConfig[]>([]);
  const [storeNameDraft, setStoreNameDraft] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("store");
  const [saved, setSaved] = useState("");
  const [resetModal, setResetModal] = useState(false);
  const [reseedModal, setReseedModal] = useState(false);

  useEffect(() => {
    const b = loadSalonBootstrap();
    setBootstrap(b);
    setStoreNameDraft(b?.storeName ?? "");
    const cfg = loadDeviceConfig();
    setPrinters(cfg?.printers ?? []);
  }, []);

  const flash = useCallback((msg: string) => {
    setSaved(msg);
    if (typeof window !== "undefined") window.setTimeout(() => setSaved(""), 2000);
  }, []);

  const patchBootstrap = useCallback(
    (patch: Partial<SalonBootstrap>) => {
      if (!bootstrap) return;
      const next = { ...bootstrap, ...patch, lastUpdatedAt: new Date().toISOString() };
      setBootstrap(next);
      saveSalonBootstrap(next);
      flash("已儲存");
    },
    [bootstrap, flash],
  );

  const doReset = useCallback(() => {
    resetSalonStorage();
    window.location.reload();
  }, []);

  const doReseed = useCallback(() => {
    reseedSalonConfig();
    const b = loadSalonBootstrap();
    setBootstrap(b);
    setStoreNameDraft(b?.storeName ?? "");
    setReseedModal(false);
    flash("已重種預設服務資料");
  }, [flash]);

  // 列印分區（裝置 config）
  const savePrinters = useCallback(
    (next: DevicePrinterConfig[]) => {
      const cfg = loadDeviceConfig();
      const base: DeviceConfig = cfg ?? {
        deviceId: "salon-device",
        terminalName: "salon-terminal",
        storeId: bootstrap?.storeId ?? "salon",
        printers: [],
        updatedAt: "",
      };
      saveDeviceConfig({ ...base, printers: next, updatedAt: new Date().toISOString() });
      setPrinters(next);
      flash("已儲存");
    },
    [bootstrap?.storeId, flash],
  );

  if (!bootstrap) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-6">
        <div className="text-base font-semibold text-slate-900">載入中…</div>
      </div>
    );
  }

  const categoryMap = new Map(bootstrap.serviceCategories.map((c) => [c.id, c.name]));
  const queue = loadSalonSyncQueue();

  // ── upsert / delete / toggle helpers ──
  const upsertCategory = (c: SalonServiceCategory) =>
    patchBootstrap({
      serviceCategories: (() => {
        const arr = bootstrap.serviceCategories;
        const i = arr.findIndex((x) => x.id === c.id);
        return i >= 0 ? arr.map((x) => (x.id === c.id ? c : x)) : [...arr, c];
      })(),
    });
  const deleteCategory = (c: SalonServiceCategory) =>
    patchBootstrap({ serviceCategories: bootstrap.serviceCategories.filter((x) => x.id !== c.id) });
  const toggleCategory = (c: SalonServiceCategory) => upsertCategory({ ...c, active: !c.active });

  const upsertItem = (it: SalonServiceItem) =>
    patchBootstrap({
      serviceItems: (() => {
        const arr = bootstrap.serviceItems;
        const i = arr.findIndex((x) => x.id === it.id);
        return i >= 0 ? arr.map((x) => (x.id === it.id ? it : x)) : [...arr, it];
      })(),
    });
  const deleteItem = (it: SalonServiceItem) =>
    patchBootstrap({ serviceItems: bootstrap.serviceItems.filter((x) => x.id !== it.id) });
  const toggleItem = (it: SalonServiceItem) => upsertItem({ ...it, active: !it.active });

  const upsertStation = (st: SalonStation) =>
    patchBootstrap({
      stations: (() => {
        const arr = bootstrap.stations;
        const i = arr.findIndex((x) => x.id === st.id);
        return i >= 0 ? arr.map((x) => (x.id === st.id ? st : x)) : [...arr, st];
      })(),
    });
  const deleteStation = (st: SalonStation) =>
    patchBootstrap({ stations: bootstrap.stations.filter((x) => x.id !== st.id) });
  const toggleStation = (st: SalonStation) => upsertStation({ ...st, active: !st.active });

  const upsertStaff = (s: SalonStaff) => {
    const now = new Date().toISOString();
    const finalStaff: SalonStaff = {
      ...s,
      updatedAt: now,
      createdAt: s.createdAt || now,
    };
    patchBootstrap({
      staff: (() => {
        const arr = bootstrap.staff;
        const i = arr.findIndex((x) => x.id === s.id);
        return i >= 0 ? arr.map((x) => (x.id === s.id ? finalStaff : x)) : [...arr, finalStaff];
      })(),
    });
  };
  const deleteStaff = (s: SalonStaff) => patchBootstrap({ staff: bootstrap.staff.filter((x) => x.id !== s.id) });
  const toggleStaff = (s: SalonStaff) => upsertStaff({ ...s, active: !s.active });

  const upsertPrinter = (p: DevicePrinterConfig) => {
    const arr = printers;
    const i = arr.findIndex((x) => x.id === p.id);
    savePrinters(i >= 0 ? arr.map((x) => (x.id === p.id ? p : x)) : [...arr, p]);
  };
  const deletePrinter = (p: DevicePrinterConfig) => savePrinters(printers.filter((x) => x.id !== p.id));
  const togglePrinter = (p: DevicePrinterConfig) => upsertPrinter({ ...p, enabled: !p.enabled });

  // ── empty factories ──
  const emptyCategory = (): SalonServiceCategory => ({
    id: genId("cat"),
    name: "",
    printerGroup: "station_face",
    sortOrder: bootstrap.serviceCategories.length + 1,
    active: true,
  });
  const emptyItem = (): SalonServiceItem => ({
    id: genId("item"),
    categoryId: bootstrap.serviceCategories[0]?.id ?? "",
    name: "",
    price: 0,
    durationMinutes: bootstrap.defaultServiceDurationMinutes || 60,
    stationTypes: [],
    active: true,
    sortOrder: bootstrap.serviceItems.length + 1,
  });
  const emptyStation = (): SalonStation => ({
    id: genId("stn"),
    name: "",
    type: "chair",
    capacity: 1,
    active: true,
    sortOrder: bootstrap.stations.length + 1,
  });
  const emptyStaff = (): SalonStaff => ({
    id: genId("staff"),
    name: "",
    nickname: "",
    role: "therapist",
    serviceCategoryIds: [],
    phone: "",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const emptyPrinter = (): DevicePrinterConfig => ({
    id: genId("printer"),
    role: "zone",
    connectionType: "lan",
    name: "",
    enabled: true,
    lanPort: 9100,
  });

  // ── field defs（category 依賴 categoryMap，故在此計算）──
  const categoryFields: FieldDef[] = [
    { key: "name", label: "類目名稱", type: "text", placeholder: "例如 面部護理" },
    { key: "printerGroup", label: "列印分區", type: "select", options: PRINTER_GROUP_OPTS },
    { key: "sortOrder", label: "排序", type: "number" },
    { key: "color", label: "色標", type: "color" },
    { key: "active", label: "啟用", type: "toggle" },
  ];
  const itemFields: FieldDef[] = [
    { key: "name", label: "服務名稱", type: "text", placeholder: "例如 深層清潔 Facial" },
    {
      key: "categoryId",
      label: "所屬類目",
      type: "select",
      options: bootstrap.serviceCategories.map((c) => ({ value: c.id, label: c.name })),
    },
    { key: "price", label: "價格 (MOP)", type: "number" },
    { key: "durationMinutes", label: "時長 (分鐘)", type: "number" },
    { key: "stationTypes", label: "適用工位", type: "multiselect", options: STATION_TYPE_OPTS },
    { key: "description", label: "描述", type: "textarea" },
    { key: "consumableNotes", label: "用品備註", type: "textarea" },
    { key: "active", label: "啟用", type: "toggle" },
  ];
  const stationFields: FieldDef[] = [
    { key: "name", label: "名稱", type: "text", placeholder: "例如 1 號床" },
    { key: "type", label: "類型", type: "select", options: STATION_TYPE_OPTS },
    { key: "capacity", label: "容量", type: "number" },
    { key: "location", label: "位置", type: "text", placeholder: "例如 2 樓" },
    { key: "sortOrder", label: "排序", type: "number" },
    { key: "active", label: "啟用", type: "toggle" },
  ];
  const staffFields: FieldDef[] = [
    { key: "name", label: "姓名", type: "text" },
    { key: "nickname", label: "暱稱", type: "text", placeholder: "顯示用" },
    { key: "role", label: "角色", type: "select", options: STAFF_ROLE_OPTS },
    {
      key: "serviceCategoryIds",
      label: "可服務類目",
      type: "multiselect",
      options: bootstrap.serviceCategories.map((c) => ({ value: c.id, label: c.name })),
    },
    { key: "phone", label: "電話", type: "text" },
    { key: "active", label: "在職", type: "toggle" },
  ];
  const printerFields: FieldDef[] = [
    { key: "name", label: "印表機名稱", type: "text", placeholder: "例如 收銀機" },
    { key: "role", label: "角色", type: "select", options: PRINTER_ROLE_OPTS },
    { key: "connectionType", label: "連線方式", type: "select", options: PRINTER_CONN_OPTS },
    { key: "ipAddress", label: "IP 位址", type: "text", placeholder: "LAN 模式填寫" },
    { key: "lanPort", label: "Port", type: "number" },
    { key: "enabled", label: "啟用", type: "toggle" },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-6">
      <div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center justify-between bg-slate-100/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <h1 className="text-xl font-bold text-slate-900">設置</h1>
        {saved && (
          <span className="rounded-lg bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{saved}</span>
        )}
      </div>

      {/* sub-tab 列 */}
      <div className="mb-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${
              activeTab === t.id ? "bg-rose-500 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 店家資料 */}
      {activeTab === "store" && (
        <Section title="店家資料">
          <Field label="店家名稱">
            <input
              value={storeNameDraft}
              onChange={(e) => setStoreNameDraft(e.target.value)}
              onBlur={() => patchBootstrap({ storeName: storeNameDraft.trim() || bootstrap.storeName })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </Field>
          <Field label="貨幣">
            <div className="px-1 py-2 text-sm text-slate-600">{bootstrap.currency}</div>
          </Field>
          <Field label="Store ID">
            <div className="px-1 py-2 text-sm text-slate-400">{bootstrap.storeId}</div>
          </Field>
          <Field label="日曆格距 (分鐘)">
            <input
              type="number"
              defaultValue={bootstrap.calendarSlotMinutes}
              onBlur={(e) => patchBootstrap({ calendarSlotMinutes: Number(e.target.value) || bootstrap.calendarSlotMinutes })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </Field>
          <Field label="預設服務時長 (分鐘)">
            <input
              type="number"
              defaultValue={bootstrap.defaultServiceDurationMinutes}
              onBlur={(e) =>
                patchBootstrap({ defaultServiceDurationMinutes: Number(e.target.value) || bootstrap.defaultServiceDurationMinutes })
              }
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
          </Field>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium text-slate-500">啟用定金機制</div>
            <button
              type="button"
              onClick={() => patchBootstrap({ depositEnabled: !bootstrap.depositEnabled })}
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                bootstrap.depositEnabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
              }`}
            >
              {bootstrap.depositEnabled ? "啟用" : "停用"}
            </button>
          </div>
        </Section>
      )}

      {/* 服務類目 */}
      {activeTab === "category" && (
        <Section title="服務類目">
          <CrudSection<SalonServiceCategory>
            items={bootstrap.serviceCategories}
            fields={categoryFields}
            emptyFactory={emptyCategory}
            renderSummary={(c) => ({ title: c.name || "(未命名)", subtitle: labelOf(PRINTER_GROUP_OPTS, c.printerGroup) })}
            onUpsert={upsertCategory}
            onDelete={deleteCategory}
            onToggle={toggleCategory}
            canDelete={(c) => {
              const used = bootstrap.serviceItems.some((it) => it.categoryId === c.id);
              return used ? { ok: false, reason: "已有服務項目使用此類目，請先移除相關服務項目。" } : { ok: true };
            }}
            addLabel="＋ 新增類目"
          />
        </Section>
      )}

      {/* 服務管理（服務項目 + 場地） */}
      {activeTab === "services" && (
        <div className="grid gap-4">
          <Section title="服務項目">
            <CrudSection<SalonServiceItem>
              items={bootstrap.serviceItems}
              fields={itemFields}
              emptyFactory={emptyItem}
              renderSummary={(it) => ({
                title: it.name || "(未命名)",
                subtitle: `${categoryMap.get(it.categoryId) ?? "?"} · ${it.durationMinutes}分`,
              })}
              onUpsert={upsertItem}
              onDelete={deleteItem}
              onToggle={toggleItem}
              addLabel="＋ 新增服務"
            />
          </Section>
          <Section title="場地 / 房型椅">
            <CrudSection<SalonStation>
              items={bootstrap.stations}
              fields={stationFields}
              emptyFactory={emptyStation}
              renderSummary={(st) => ({
                title: st.name || "(未命名)",
                subtitle: `${labelOf(STATION_TYPE_OPTS, st.type)} · 容量 ${st.capacity}`,
              })}
              onUpsert={upsertStation}
              onDelete={deleteStation}
              onToggle={toggleStation}
              addLabel="＋ 新增場地"
            />
          </Section>
        </div>
      )}

      {/* 員工 */}
      {activeTab === "staff" && (
        <Section title="員工">
          <CrudSection<SalonStaff>
            items={bootstrap.staff}
            fields={staffFields}
            emptyFactory={emptyStaff}
            activeLabels={["在職", "離職"]}
            renderSummary={(s) => ({ title: (s.nickname ?? s.name) || "(未命名)", subtitle: labelOf(STAFF_ROLE_OPTS, s.role) })}
            onUpsert={upsertStaff}
            onDelete={deleteStaff}
            onToggle={toggleStaff}
            addLabel="＋ 新增員工"
          />
        </Section>
      )}

      {/* 開發工具（列印分區 + 工具） */}
      {activeTab === "dev" && (
        <div className="grid gap-4">
          <Section title="列印分區（裝置設定，可新增 / 刪除 / 啟用停用）">
            <CrudSection<DevicePrinterConfig>
              items={printers}
              fields={printerFields}
              emptyFactory={emptyPrinter}
              activeLabels={["啟用", "停用"]}
              renderSummary={(p) => ({
                title: p.name || "(未命名)",
                subtitle: `${labelOf(PRINTER_ROLE_OPTS, p.role)}${p.ipAddress ? " · " + p.ipAddress : ""}`,
              })}
              onUpsert={upsertPrinter}
              onDelete={deletePrinter}
              onToggle={togglePrinter}
              addLabel="＋ 新增印表機"
            />
          </Section>

          <Section title="開發工具">
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setResetModal(true)}
                className="rounded-xl bg-rose-100 px-4 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-200"
              >
                重置 salon 本地資料
              </button>
              <button
                type="button"
                onClick={() => setReseedModal(true)}
                className="rounded-xl bg-amber-100 px-4 py-2.5 text-sm font-bold text-amber-700 hover:bg-amber-200"
              >
                重種預設服務資料
              </button>
              <p className="text-xs text-slate-400">
                「重置」清空預約 / 訂單 / 客戶 / 設置並重新種入預設，不可復原；「重種」只把類目 / 服務 / 員工 / 場地回復預設，保留營運資料。
              </p>
            </div>
          </Section>

          <Section title={`sync 佇列（${queue.length}）`}>
            {queue.length === 0 ? (
              <div className="text-xs text-slate-400">佇列空白，所有變更已同步或尚未有變更。</div>
            ) : (
              <div className="grid gap-1">
                {queue.slice(-20).reverse().map((e, i) => (
                  <div key={e.id ?? i} className="rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
                    <span className="font-semibold text-slate-800">{e.type}</span> · {e.status} ·{" "}
                    {new Date(e.createdAt).toLocaleString("zh-Hant")}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {/* 套票模板（P1） */}
      {activeTab === "packages" && (
        <Section title="套票模板">
          <PackageTemplatesTab />
        </Section>
      )}

      {resetModal ? (
        <ConfirmModal
          title="重置本地資料？"
          message="將清空預約 / 訂單 / 客戶 / 設置並重新種入預設。此動作不可復原。"
          danger
          confirmLabel="確定重置"
          onConfirm={doReset}
          onClose={() => setResetModal(false)}
        />
      ) : null}

      {reseedModal ? (
        <ConfirmModal
          title="重種預設服務資料？"
          message="類目 / 服務項目 / 員工 / 場地將回復為預設 mock；預約 / 訂單 / 客戶保留。"
          confirmLabel="確定重種"
          onConfirm={doReseed}
          onClose={() => setReseedModal(false)}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-bold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}
