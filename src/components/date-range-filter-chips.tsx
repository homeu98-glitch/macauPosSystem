"use client";

import { useEffect, useRef, useState } from "react";

import {
  customRangeLabel,
  normalizeCustomRange,
  type CustomDateRange,
} from "@/lib/ledger/date-range";

/**
 * 全站共用的「時間範圍 chips ＋ 自訂日期區間彈窗」（2026-09-13 新增）。
 *
 * ## 為什麼要抽共用
 *
 * 加「自訂」之前，同樣一組 chips 喺專案內**各自 hardcode 咗 5 次**
 * （`orders-hub`、`online-orders`、`restaurant-daily-report`、`print-center`、`inventory-view`），
 * 每次加範圍都要改 5 個地方，而且樣式已經有輕微漂移。抽成一個元件之後，
 * 「新增一個範圍」只改 `order-date-filter.ts` / `report-period.ts` 嘅 options 陣列。
 *
 * ## 用法
 *
 * ```tsx
 * <DateRangeFilterChips
 *   options={LEDGER_ORDER_DATE_FILTERS}
 *   value={dateFilter.key}
 *   custom={dateFilter.custom}
 *   onChange={(key, custom) => setDateFilter({ key, custom })}
 * />
 * ```
 *
 * ## 觸控規格（用戶硬性要求）
 *
 * - chip 最小高度 36px（`py-1.5` + `text-xs` ≈ 30px… 所以用 `min-h-[36px]` 撐住）。
 * - 彈窗內 `input type=date` 高度 ≥ 44px、按鈕 ≥ 44px。
 * - 彈窗寬度 `min(92vw, 420px)`，窄屏唔會爆。
 *
 * ## 「自訂」嘅兩段式語義
 *
 * 撳「自訂」chip → 開彈窗；**確認之後**才將 `custom` 寫上去。若用戶取消，
 * `key` 保持不變（唔會變成一個「custom 但冇區間」嘅殭屍狀態）。
 * 已套用過區間再撳「自訂」→ 彈窗預填上次區間。
 */
export function DateRangeFilterChips<K extends string>({
  options,
  value,
  custom,
  onChange,
  size = "md",
  className = "",
}: {
  /** 選項陣列，最後一項**必須**係 `key: "custom"`（會渲染成特殊 chip）。 */
  options: Array<{ key: K; label: string }>;
  value: K;
  custom?: CustomDateRange | null;
  /** 確認自訂區間時傳 `("custom", {start,end})`；選其他 chip 時 custom 傳 `null`。 */
  onChange: (key: K, custom: CustomDateRange | null) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const startRef = useRef<HTMLInputElement>(null);

  const customOption = options.find((o) => o.key === "custom") ?? null;
  const plainOptions = options.filter((o) => o.key !== "custom");
  const isCustomActive = value === "custom";

  // 開啟彈窗時預填：已套用過 → 用舊值；否則預設「今個月 1 號 → 今日」
  useEffect(() => {
    if (!dialogOpen) return;
    if (custom) {
      setDraftStart(custom.start);
      setDraftEnd(custom.end);
    } else {
      const today = macauTodayKey();
      setDraftStart(`${today.slice(0, 7)}-01`);
      setDraftEnd(today);
    }
    setDialogError(null);
    // 焦點移到起始日，方便鍵盤／觸控輸入
    const t = window.setTimeout(() => startRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [dialogOpen, custom]);

  // Esc 關閉
  useEffect(() => {
    if (!dialogOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDialogOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen]);

  function handleChipClick(key: K) {
    if (key === "custom") {
      setDialogOpen(true);
      return;
    }
    onChange(key, null);
  }

  function applyCustom() {
    const normalized = normalizeCustomRange({ start: draftStart, end: draftEnd });
    if (!normalized) {
      setDialogError(draftStart > draftEnd ? "起始日期唔可以遲過結束日期。" : "請揀有效嘅起始同結束日期。");
      return;
    }
    setDialogOpen(false);
    onChange("custom" as K, normalized);
  }

  const chipBase =
    size === "sm"
      ? "inline-flex min-h-[32px] items-center rounded-full px-3 py-1 text-[11px] font-semibold"
      : "inline-flex min-h-[36px] items-center rounded-full px-3 py-1.5 text-xs font-semibold";

  const activeCls = "bg-white text-slate-900 shadow-sm";
  const idleCls = "text-slate-600";

  return (
    <>
      <div className={`flex flex-wrap gap-1 rounded-full bg-slate-100 p-1 ${className}`}>
        {plainOptions.map((opt) => (
          <button
            key={opt.key}
            className={`${chipBase} ${opt.key === value ? activeCls : idleCls}`}
            onClick={() => handleChipClick(opt.key)}
            type="button"
          >
            {opt.label}
          </button>
        ))}
        {customOption ? (
          <button
            className={`${chipBase} ${
              isCustomActive ? "bg-slate-900 text-white shadow-sm" : idleCls
            }`}
            onClick={() => handleChipClick(customOption.key)}
            type="button"
          >
            {isCustomActive && custom ? customRangeLabel(custom) : customOption.label}
          </button>
        ) : null}
      </div>

      {dialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialogOpen(false);
          }}
        >
          <div className="w-full max-w-[420px] rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-base font-semibold text-slate-900">自訂日期範圍</div>
            <div className="mt-1 text-xs text-slate-500">只會顯示區間內嘅資料（含頭含尾・澳門時間）。</div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">起始日期</span>
                <input
                  ref={startRef}
                  className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-slate-900"
                  max={draftEnd || undefined}
                  onChange={(e) => {
                    setDraftStart(e.target.value);
                    setDialogError(null);
                  }}
                  type="date"
                  value={draftStart}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">結束日期</span>
                <input
                  className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-900 outline-none focus:border-slate-900"
                  min={draftStart || undefined}
                  onChange={(e) => {
                    setDraftEnd(e.target.value);
                    setDialogError(null);
                  }}
                  type="date"
                  value={draftEnd}
                />
              </label>
            </div>

            {dialogError ? (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {dialogError}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-1">
              {QUICK_PRESETS.map((preset) => (
                <button
                  className="inline-flex min-h-[32px] items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-200"
                  key={preset.label}
                  onClick={() => {
                    const r = preset.build();
                    setDraftStart(r.start);
                    setDraftEnd(r.end);
                    setDialogError(null);
                  }}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-300 px-5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setDialogOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="inline-flex min-h-[44px] items-center rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={applyCustom}
                type="button"
              >
                套用
              </button>
            </div>

            {value === "custom" && custom ? (
              <button
                className="mt-3 w-full text-center text-xs text-slate-500 underline hover:text-slate-700"
                onClick={() => {
                  setDialogOpen(false);
                  onChange("today" as K, null);
                }}
                type="button"
              >
                清除自訂範圍（返回「今天」）
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 今日嘅 Macau 日曆 key（`YYYY-MM-DD`）。 */
function macauTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date());
}

/** 由今日往回推 n 日嘅 Macau key。 */
function macauKeyDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
}

/** 彈窗內嘅快速預設（商家最常用嘅幾個區間）。 */
const QUICK_PRESETS: Array<{ label: string; build: () => CustomDateRange }> = [
  {
    label: "今個月",
    build: () => ({ start: `${macauTodayKey().slice(0, 7)}-01`, end: macauTodayKey() }),
  },
  {
    label: "上個月",
    build: () => {
      const today = macauTodayKey();
      const firstOfThisMonth = new Date(`${today.slice(0, 7)}-01T00:00:00+08:00`);
      const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
      const fmt = (d: Date) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
      return { start: fmt(lastMonthStart), end: fmt(lastMonthEnd) };
    },
  },
  { label: "近 14 日", build: () => ({ start: macauKeyDaysAgo(13), end: macauTodayKey() }) },
  { label: "今年", build: () => ({ start: `${macauTodayKey().slice(0, 4)}-01-01`, end: macauTodayKey() }) },
];
