/**
 * 時段生成與餘量 —— 純函數，零 UI 依賴。
 *
 * ## 為什麼用「每格配額」而不是翻枱推演
 *
 * 翻枱推演要每張枱都有可靠的入座／離座時間，現實中店員唔會按時按；
 * 算錯就超賣，而且店家睇唔明「明明仲有枱點解訂唔到」。
 * 配額制（每 30 分鐘最多 5 組）直觀、可解釋、錯咗容易調。
 *
 * 配額真正扣減喺 DB（`create_reservation` 用 advisory lock 原子做），
 * 呢度只負責**顯示**。前端永遠唔可以自己判斷「仲有位」就寫入。
 */

import { bizDateWindow, serviceSlotFor } from "./biz-date.ts";
import type { ReservationSettings, ServiceHours, SlotUsage } from "./types.ts";

export type DaySlot = {
  /** ISO 時刻。 */
  slotAt: string;
  /** `18:30` 顯示用（澳門本地）。 */
  label: string;
  /** 已訂組數。 */
  used: number;
  /** 剩餘組數（不會小於 0）。 */
  remaining: number;
  /** 是否已滿。 */
  full: boolean;
  /** 是否已過可訂時間（已過去，或少於「最遲提前」）。 */
  past: boolean;
};

/** Date → 澳門本地 `HH:MM`。 */
export function formatMacauHm(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 由營業日 + 營業時段生成所有時段（依 interval 遞增，最後一格不超過打烊時間）。
 *
 * 跨日店（17:30–02:00）會自然產生 25:00 之後的時刻 → 轉成翌日 01:00 的 ISO。
 */
export function generateSlotTimes(
  bizDate: string,
  hours: ServiceHours,
  intervalMinutes: number,
): Date[] {
  const window = bizDateWindow(bizDate, hours);
  if (!window) return [];
  if (!serviceSlotFor(bizDate, hours)) return [];

  const step =
    Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.trunc(intervalMinutes) : 30;

  const totalMinutes = Math.floor((window.end.getTime() - window.start.getTime()) / 60_000);
  const out: Date[] = [];
  for (let offset = 0; offset < totalMinutes; offset += step) {
    out.push(new Date(window.start.getTime() + offset * 60_000));
  }
  return out;
}

function usageFor(slotAt: string, usage: readonly SlotUsage[]): SlotUsage | undefined {
  const target = new Date(slotAt).getTime();
  return usage.find((row) => new Date(row.slotAt).getTime() === target);
}

/**
 * 組裝某一營業日的時段視圖（訂位台與客人端共用）。
 *
 * @param now 判斷「已過」的基準；測試傳固定值可令結果穩定。
 */
export function buildDaySlots(params: {
  bizDate: string;
  settings: Pick<
    ReservationSettings,
    "serviceHours" | "slotIntervalMinutes" | "slotQuota" | "leadMinutesMin"
  >;
  usage: readonly SlotUsage[];
  now?: Date;
}): DaySlot[] {
  const { bizDate, settings, usage } = params;
  const now = params.now ?? new Date();
  const times = generateSlotTimes(bizDate, settings.serviceHours, settings.slotIntervalMinutes);
  const cutoff = now.getTime() + Math.max(0, settings.leadMinutesMin) * 60_000;

  return times.map((at) => {
    const iso = at.toISOString();
    const used = usageFor(iso, usage)?.used ?? 0;
    const remaining = Math.max(0, settings.slotQuota - used);
    return {
      slotAt: iso,
      label: formatMacauHm(at),
      used,
      remaining,
      full: remaining <= 0,
      past: at.getTime() < cutoff,
    };
  });
}

/** 該時段是否仍可接受新訂位。 */
export function isSlotBookable(slot: Pick<DaySlot, "past" | "full">): boolean {
  return !slot.past && !slot.full;
}

/** `YYYY-MM-DD` 加減日數。 */
export function shiftYmdDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * 把「今天 / 明天 / 7 天 / 30 天 / 全部」換成日期範圍。
 *
 * `all` 回 `from = null`，由呼叫方決定上限（避免一次拉全店歷史）。
 */
export function rangeToDates(
  range: "today" | "tomorrow" | "7d" | "30d" | "all",
  todayYmd: string,
): { from: string | null; to: string | null } {
  switch (range) {
    case "today":
      return { from: todayYmd, to: todayYmd };
    case "tomorrow": {
      const t = shiftYmdDays(todayYmd, 1);
      return { from: t, to: t };
    }
    case "7d":
      return { from: todayYmd, to: shiftYmdDays(todayYmd, 6) };
    case "30d":
      return { from: todayYmd, to: shiftYmdDays(todayYmd, 29) };
    default:
      return { from: null, to: null };
  }
}
