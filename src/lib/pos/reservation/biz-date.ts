/**
 * 營業日（biz_date）計算 —— 純函數，零依賴。
 *
 * ## 為什麼不能用自然日
 *
 * 夜宵店 20:00–02:00，凌晨 01:30 的訂位屬於**前一天**的營業日。
 * 若用 `date(slot_at)`，凌晨那幾張會被算到第二天的報表，訂位台「今日」也會漏掉。
 *
 * ## 時區
 *
 * 澳門固定 UTC+8，**沒有夏令時**（1979 年後已取消），
 * 所以可以直接用固定偏移換算，不需要 Intl / tzdata。
 *
 * ## serviceHours 的 key
 *
 * key 係**營業日**的星期幾（1 = 週一 … 7 = 週日），唔係自然日。
 * 所以「週五 17:30–02:00」凌晨 01:00 的訂位 → 營業日 = 週五，用 key "5" 判斷。
 */

import type { ServiceHours } from "./types.ts";

/** 澳門時區相對 UTC 的固定偏移（+8 小時）。 */
export const MACAU_OFFSET_MS = 8 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type MacauParts = {
  year: number;
  month: number;
  day: number;
  /** ISO 星期：1 = 週一 … 7 = 週日。 */
  weekday: number;
  /** 當日已過分鐘數（0–1439）。 */
  minutes: number;
};

/** 把任何 Date 換算成澳門本地的年月日、星期、分鐘。 */
export function macauParts(at: Date): MacauParts {
  const shifted = new Date(at.getTime() + MACAU_OFFSET_MS);
  const rawWeekday = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: rawWeekday === 0 ? 7 : rawWeekday,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** `07:30` / `7:30` → 450；格式不對回 null。 */
export function parseHm(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 47 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** 450 → `07:30`（超過 24 小時會回 `25:00` 這種，供跨日運算）。 */
export function formatHm(minutes: number): string {
  const safe = Math.max(0, Math.trunc(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 三個整數 → `YYYY-MM-DD`。 */
export function toYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 在 `YYYY-MM-DD` 上加減日數（純日期，不涉時區）。 */
export function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map((v) => Number(v));
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1) + deltaDays * DAY_MS;
  const dt = new Date(base);
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** `YYYY-MM-DD` → ISO 星期（1 = 週一 … 7 = 週日）。 */
export function ymdWeekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map((v) => Number(v));
  const day = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 某營業日對應的服務時段；沒有設定回 null。 */
export function serviceSlotFor(ymd: string, hours: ServiceHours): { open: string; close: string } | null {
  const key = String(ymdWeekday(ymd));
  const slot = hours?.[key];
  if (!slot || typeof slot.open !== "string" || typeof slot.close !== "string") return null;
  return slot;
}

/**
 * 這個到店時刻屬於哪一個**營業日**（`YYYY-MM-DD`）。
 *
 * 判斷順序：
 *  1. 當天的時段是跨日（close ≤ open）且落在凌晨（minutes < close）→ 前一天
 *  2. 當天時段存在且 minutes 在 [open, close) → 當天
 *  3. 前一天的時段是跨日且 minutes < 前一天.close → 前一天
 *  4. 都對不上 → 當天（fallback，寧可算錯一天也不要 throw）
 */
export function reservationBizDate(slotAt: Date | string, hours: ServiceHours): string {
  const at = typeof slotAt === "string" ? new Date(slotAt) : slotAt;
  const parts = macauParts(at);
  const today = toYmd(parts.year, parts.month, parts.day);
  const yesterday = shiftYmd(today, -1);

  const todaySlot = serviceSlotFor(today, hours);
  if (todaySlot) {
    const open = parseHm(todaySlot.open);
    const close = parseHm(todaySlot.close);
    if (open !== null && close !== null) {
      const crossDay = close <= open;
      if (crossDay && parts.minutes < close) {
        // 凌晨時段，屬於前一天營業日
        return yesterday;
      }
      if (!crossDay && parts.minutes >= open && parts.minutes < close) {
        return today;
      }
      if (crossDay && parts.minutes >= open) {
        return today;
      }
    }
  }

  const yesterdaySlot = serviceSlotFor(yesterday, hours);
  if (yesterdaySlot) {
    const open = parseHm(yesterdaySlot.open);
    const close = parseHm(yesterdaySlot.close);
    if (open !== null && close !== null && close <= open && parts.minutes < close) {
      return yesterday;
    }
  }

  return today;
}

/**
 * 某營業日的服務窗口（UTC 時刻）。
 *
 * 跨日時 `end` 會落在下一個自然日，例如週五 17:30–02:00
 * → start = 週五 17:30（澳門），end = 週六 02:00（澳門）。
 */
export function bizDateWindow(
  bizDate: string,
  hours: ServiceHours,
): { start: Date; end: Date; crossDay: boolean } | null {
  const slot = serviceSlotFor(bizDate, hours);
  if (!slot) return null;
  const open = parseHm(slot.open);
  const close = parseHm(slot.close);
  if (open === null || close === null) return null;

  const [y, m, d] = bizDate.split("-").map((v) => Number(v));
  const midnightUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1) - MACAU_OFFSET_MS;

  const crossDay = close <= open;
  const start = new Date(midnightUtc + open * 60_000);
  const endMinutes = crossDay ? close + 24 * 60 : close;
  const end = new Date(midnightUtc + endMinutes * 60_000);

  return { start, end, crossDay };
}
