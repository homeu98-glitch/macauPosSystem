"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";

import type { SalonBootstrap, SalonStaff } from "@/lib/salon/types";
import { loadSalonBootstrap, saveSalonBootstrap, resetSalonStorage } from "@/lib/salon/storage";
import { loadDeviceConfig } from "@/lib/storage";

interface PrinterZone {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
}

export function Settings() {
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);
  const [printers, setPrinters] = useState<PrinterZone[]>([]);
  const [storeNameDraft, setStoreNameDraft] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const b = loadSalonBootstrap();
    setBootstrap(b);
    setStoreNameDraft(b?.storeName ?? "");
    const cfg = loadDeviceConfig();
    setPrinters(
      (cfg?.printers ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        enabled: p.enabled,
      })),
    );
  }, []);

  const flash = useCallback((msg: string) => {
    setSaved(msg);
    if (typeof window !== "undefined") {
      window.setTimeout(() => setSaved(""), 2000);
    }
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

  const toggleCategory = useCallback(
    (categoryId: string) => {
      if (!bootstrap) return;
      const next = bootstrap.serviceCategories.map((c) =>
        c.id === categoryId ? { ...c, active: !c.active } : c,
      );
      patchBootstrap({ serviceCategories: next });
    },
    [bootstrap, patchBootstrap],
  );

  const toggleStaff = useCallback(
    (staffId: string) => {
      if (!bootstrap) return;
      const next = bootstrap.staff.map((s: SalonStaff) =>
        s.id === staffId ? { ...s, active: !s.active } : s,
      );
      patchBootstrap({ staff: next });
    },
    [bootstrap, patchBootstrap],
  );

  const handleReset = useCallback(() => {
    if (typeof window === "undefined") return;
    const ok = window.confirm("確定重置 salon 本地資料？將清空預約 / 訂單 / 客戶 / 設置並重新種入預設。此動作不可復原。");
    if (!ok) return;
    resetSalonStorage();
    window.location.reload();
  }, []);

  if (!bootstrap) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-6">
        <div className="text-base font-semibold text-slate-900">載入中…</div>
      </div>
    );
  }

  const categoryMap = new Map(bootstrap.serviceCategories.map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-6">
      <div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center justify-between bg-slate-100/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <h1 className="text-xl font-bold text-slate-900">設置</h1>
        {saved && <span className="rounded-lg bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{saved}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 items-start">
      {/* 店家資料 */}
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
      </Section>

      {/* 服務類目 */}
      <Section title="服務類目（點擊切換啟用）">
        <div className="grid gap-1.5">
          {bootstrap.serviceCategories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggleCategory(c.id)}
              className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-left"
            >
              <span className="text-sm text-slate-800">{c.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${c.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}
              >
                {c.active ? "啟用" : "停用"}
              </span>
            </button>
          ))}
        </div>
      </Section>

      {/* 服務項目 */}
      <Section title="服務項目">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {bootstrap.serviceItems.map((it) => (
            <div key={it.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <div>
                <div className="text-sm font-medium text-slate-800">{it.name}</div>
                <div className="text-xs text-slate-500">{categoryMap.get(it.categoryId) ?? "?"} · {it.durationMinutes}分</div>
              </div>
              <div className="text-sm font-semibold text-slate-700">${it.price}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* 員工 */}
      <Section title="員工（點擊切換在職）">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {bootstrap.staff.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleStaff(s.id)}
              className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-left"
            >
              <div>
                <div className="text-sm font-medium text-slate-800">{s.nickname ?? s.name}</div>
                <div className="text-xs text-slate-500">{s.role}</div>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${s.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}
              >
                {s.active ? "在職" : "離職"}
              </span>
            </button>
          ))}
        </div>
      </Section>

      {/* 房型 / 椅 */}
      <Section title="房型 / 椅">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {bootstrap.stations.map((st) => (
            <div key={st.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <span className="text-sm text-slate-800">{st.name}</span>
              <span className="text-xs text-slate-500">{st.type}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 列印分區 */}
      <Section title="列印分區（裝置設定）">
        {printers.length === 0 ? (
          <div className="text-xs text-slate-400">尚未設定 print-bridge 印表機（NEXT_PUBLIC_PRINT_BRIDGE_URL）。</div>
        ) : (
          <div className="grid gap-1.5">
            {printers.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-sm text-slate-800">{p.name}</div>
                  <div className="text-xs text-slate-500">{p.role}</div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${p.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}
                >
                  {p.enabled ? "啟用" : "停用"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* 開發工具 */}
      <Section title="開發工具">
        <button
          type="button"
          onClick={handleReset}
          className="rounded-xl bg-rose-100 px-4 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-200"
        >
          重置 salon 本地資料
        </button>
        <p className="mt-2 text-xs text-slate-400">清空預約 / 訂單 / 客戶 / 設置並重新種入預設。僅供開發測試。</p>
      </Section>
      </div>
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
