"use client";

/**
 * 訂位設置面板。
 *
 * ## 為什麼「服務時段」不給模板而給 7 行
 *
 * 澳門餐廳的營業時間極不規則（平日只做晚市、週末做全日、夜宵到凌晨）。
 * 給「平日 / 週末」兩個模板反而要店員遷就模板。7 行 × 起止時間，最多 14 個輸入，
 * 一次設定好就不再動。
 *
 * ## 跨日怎麼填
 *
 * 打烊時間早過開門時間（例如 17:30 → 02:00）就係跨日，系統自動按營業日計算。
 * 不需要另外勾選。
 */

import { useMemo, useState } from "react";

import type { ReservationSettings, ServiceHours } from "@/lib/pos/reservation/types";

const WEEKDAYS: Array<{ key: string; label: string }> = [
  { key: "1", label: "週一" },
  { key: "2", label: "週二" },
  { key: "3", label: "週三" },
  { key: "4", label: "週四" },
  { key: "5", label: "週五" },
  { key: "6", label: "週六" },
  { key: "7", label: "週日" },
];

export function ReservationSettingsModal({
  settings,
  onClose,
  onSave,
}: {
  settings: ReservationSettings;
  onClose: () => void;
  onSave: (next: Partial<ReservationSettings>) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [draft, setDraft] = useState<ReservationSettings>({ ...settings });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const hours = useMemo<ServiceHours>(() => draft.serviceHours ?? {}, [draft.serviceHours]);

  const setHour = (key: string, field: "open" | "close", value: string) => {
    setDraft((prev) => {
      const next = { ...(prev.serviceHours ?? {}) };
      const current = next[key] ?? { open: "17:30", close: "22:30" };
      next[key] = { ...current, [field]: value };
      return { ...prev, serviceHours: next };
    });
  };

  const toggleDay = (key: string) => {
    setDraft((prev) => {
      const next = { ...(prev.serviceHours ?? {}) };
      if (next[key]) delete next[key];
      else next[key] = { open: "17:30", close: "22:30" };
      return { ...prev, serviceHours: next };
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await onSave(draft);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "儲存失敗");
      return;
    }
    setSaved(true);
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-900/45 p-3">
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="flex-1">
            <div className="text-[16px] font-bold text-slate-900">訂位設置</div>
            <div className="mt-0.5 text-[11.5px] text-slate-500">
              設定只影響客人端（會員通）可否訂位；店員代訂不受「接受訂位」開關限制。
            </div>
          </div>
          <button className="text-lg text-slate-400" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {error ? (
            <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
              {error}
            </div>
          ) : null}
          {saved ? (
            <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-700">
              已儲存。
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {/* 開關 */}
            <Card title="開關" desc="關閉後客人不可提交新訂位；已存在的照舊處理。">
              <Toggle
                checked={draft.enabled}
                label="接受訂位"
                onChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
              />
              <Toggle
                checked={draft.autoConfirm}
                label="自動確認"
                hint="8 位以上一律轉人工"
                onChange={(v) => setDraft((p) => ({ ...p, autoConfirm: v }))}
              />
              <Toggle
                checked={draft.prepayEnabled}
                label="預點菜可用餘額預付"
                hint="客人餘額足夠時可即時付款"
                onChange={(v) => setDraft((p) => ({ ...p, prepayEnabled: v }))}
              />
            </Card>

            {/* 可訂範圍 */}
            <Card title="可訂範圍" desc="控制客人最早可以訂幾遠、最遲要提前幾耐。">
              <Num
                label="最多提前（天）"
                max={60}
                min={1}
                onChange={(v) => setDraft((p) => ({ ...p, leadDaysMax: v }))}
                value={draft.leadDaysMax}
              />
              <Num
                label="最遲提前（分鐘）"
                max={1440}
                min={0}
                onChange={(v) => setDraft((p) => ({ ...p, leadMinutesMin: v }))}
                value={draft.leadMinutesMin}
              />
            </Card>

            {/* 時段容量 */}
            <Card title="時段與容量" desc="每格獨立配額，不做翻枱推演。">
              <div className="flex items-center justify-between border-b border-dashed border-slate-100 py-2">
                <span className="text-[12.5px] font-semibold text-slate-700">時段間隔</span>
                <div className="flex gap-1.5">
                  {[15, 30, 60].map((v) => (
                    <button
                      key={v}
                      className={`h-8 rounded-lg px-2.5 text-[12px] font-bold ${
                        draft.slotIntervalMinutes === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                      }`}
                      onClick={() => setDraft((p) => ({ ...p, slotIntervalMinutes: v }))}
                      type="button"
                    >
                      {v} 分
                    </button>
                  ))}
                </div>
              </div>
              <Num
                label="每格上限（組）"
                max={50}
                min={1}
                onChange={(v) => setDraft((p) => ({ ...p, slotQuota: v }))}
                value={draft.slotQuota}
              />
              <Num
                label="用餐時長（分鐘）"
                max={300}
                min={30}
                onChange={(v) => setDraft((p) => ({ ...p, turnMinutes: v }))}
                value={draft.turnMinutes}
              />
            </Card>

            {/* 人數 */}
            <Card title="人數與到店" desc="大枱一律轉人工，避免自動確認後才發現坐唔落。">
              <div className="flex items-center justify-between border-b border-dashed border-slate-100 py-2">
                <span className="text-[12.5px] font-semibold text-slate-700">人數範圍</span>
                <div className="flex items-center gap-1.5">
                  <input
                    className="h-8 w-12 rounded-lg border border-slate-200 text-center text-[12px] font-bold"
                    min={1}
                    onChange={(e) => setDraft((p) => ({ ...p, minPartySize: Number(e.target.value) || 1 }))}
                    type="number"
                    value={draft.minPartySize}
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    className="h-8 w-12 rounded-lg border border-slate-200 text-center text-[12px] font-bold"
                    min={1}
                    onChange={(e) => setDraft((p) => ({ ...p, maxPartySize: Number(e.target.value) || 20 }))}
                    type="number"
                    value={draft.maxPartySize}
                  />
                </div>
              </div>
              <Num
                label="大枱門檻（位）"
                max={99}
                min={1}
                onChange={(v) => setDraft((p) => ({ ...p, largePartyThreshold: v }))}
                value={draft.largePartyThreshold}
              />
              <Num
                label="到店寬限（分鐘）"
                max={120}
                min={0}
                onChange={(v) => setDraft((p) => ({ ...p, graceMinutes: v }))}
                value={draft.graceMinutes}
              />
            </Card>

            {/* 退款 */}
            <Card title="取消與退款" desc="用於客人自行取消與預付退款。">
              <Num
                label="可自行取消（開始前幾分鐘）"
                max={2880}
                min={0}
                onChange={(v) => setDraft((p) => ({ ...p, cancelCutoffMinutes: v }))}
                value={draft.cancelCutoffMinutes}
              />
              <Num
                label="預付全額退款截止（分鐘）"
                max={2880}
                min={0}
                onChange={(v) => setDraft((p) => ({ ...p, refundCutoffMinutes: v }))}
                value={draft.refundCutoffMinutes}
              />
            </Card>

            {/* 服務時段 */}
            <div className="md:col-span-2">
              <Card
                title="營業時段"
                desc="每天可不同。打烊時間早過開門時間＝跨日（例如 17:30 → 02:00），系統自動按營業日計算。"
              >
                <div className="flex flex-col gap-1.5">
                  {WEEKDAYS.map((day) => {
                    const slot = hours[day.key];
                    const on = !!slot;
                    return (
                      <div key={day.key} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5">
                        <button
                          className={`h-6 w-6 shrink-0 rounded-md text-[12px] font-bold ${
                            on ? "bg-emerald-600 text-white" : "bg-slate-300 text-white"
                          }`}
                          onClick={() => toggleDay(day.key)}
                          type="button"
                        >
                          {on ? "✓" : ""}
                        </button>
                        <span className="w-9 shrink-0 text-[12.5px] font-semibold text-slate-700">{day.label}</span>
                        {on ? (
                          <>
                            <input
                              className="h-8 rounded-lg border border-slate-200 px-2 text-[12px] font-semibold tabular-nums"
                              onChange={(e) => setHour(day.key, "open", e.target.value)}
                              type="time"
                              value={slot?.open ?? "17:30"}
                            />
                            <span className="text-slate-400">→</span>
                            <input
                              className="h-8 rounded-lg border border-slate-200 px-2 text-[12px] font-semibold tabular-nums"
                              onChange={(e) => setHour(day.key, "close", e.target.value)}
                              type="time"
                              value={slot?.close ?? "22:30"}
                            />
                            {slot && slot.close <= slot.open ? (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                                跨日
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-[11.5px] text-slate-400">休息</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            {/* 須知 */}
            <div className="md:col-span-2">
              <Card title="訂位須知（客人會看到）" desc="原樣顯示在客人端訂位頁與確認頁。">
                <textarea
                  className="h-24 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-indigo-400"
                  onChange={(e) => setDraft((p) => ({ ...p, notice: e.target.value }))}
                  placeholder="1. 訂位保留 15 分鐘，逾時將安排給其他客人。&#10;2. 如需取消請致電 2855 1234。"
                  value={draft.notice}
                />
              </Card>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            className="min-h-[40px] rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            關閉
          </button>
          <div className="flex-1" />
          <button
            className="min-h-[40px] rounded-xl bg-indigo-600 px-5 text-[13.5px] font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? "儲存中…" : "儲存設定"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 p-3.5">
      <div className="text-[13px] font-bold text-slate-800">{title}</div>
      <div className="mt-0.5 mb-2 text-[11px] leading-relaxed text-slate-500">{desc}</div>
      {children}
    </section>
  );
}

function Toggle({
  checked,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed border-slate-100 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-slate-700">{label}</div>
        {hint ? <div className="text-[10.5px] text-slate-400">{hint}</div> : null}
      </div>
      <button
        aria-pressed={checked}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-emerald-600" : "bg-slate-300"}`}
        onClick={() => onChange(!checked)}
        type="button"
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function Num({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed border-slate-100 py-2 last:border-b-0">
      <span className="text-[12.5px] font-semibold text-slate-700">{label}</span>
      <input
        className="h-8 w-20 rounded-lg border border-slate-200 px-2 text-right text-[12px] font-bold tabular-nums"
        max={max}
        min={min}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
        type="number"
        value={value}
      />
    </div>
  );
}
