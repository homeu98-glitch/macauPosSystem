/**
 * 訂位請求的合法性校驗 —— 純函數，server 與 client 共用同一套規則。
 *
 * ## 為什麼 server 一定要再驗一次
 *
 * 前端已經擋過一次，但那只係**方便**，唔係安全邊界。
 * 任何人都可以直接 POST。而訂位錯咗嘅代價係：超賣、客人白行一趟、店家找唔到位。
 */

import { bizDateWindow, reservationBizDate } from "./biz-date.ts";
import type { ReservationSettings } from "./types.ts";

export type ValidationFailure = {
  ok: false;
  code:
    | "party_size"
    | "name"
    | "phone"
    | "slot_format"
    | "slot_out_of_window"
    | "slot_outside_hours"
    | "note_too_long";
  message: string;
};

export type ValidationSuccess = { ok: true; bizDate: string; slotAt: Date };

const PHONE_DIGITS = /^\+?[0-9\s-]{6,20}$/;

/** 只留數字（給電話比對 / 顯示）。 */
export function normalizePhone(raw: string): string {
  return String(raw ?? "").replace(/[^\d]/g, "");
}

/**
 * 校驗一筆訂位請求。
 *
 * @param now 傳入固定值可令測試穩定。
 */
export function validateReservationInput(params: {
  settings: Pick<
    ReservationSettings,
    "serviceHours" | "minPartySize" | "maxPartySize" | "leadDaysMax" | "leadMinutesMin"
  >;
  slotAt: string;
  partySize: number;
  guestName: string;
  guestPhone: string;
  guestNote?: string;
  now?: Date;
}): ValidationSuccess | ValidationFailure {
  const now = params.now ?? new Date();

  const party = Math.trunc(Number(params.partySize) || 0);
  if (party < params.settings.minPartySize || party > params.settings.maxPartySize) {
    return {
      ok: false,
      code: "party_size",
      message: `人數需介乎 ${params.settings.minPartySize} – ${params.settings.maxPartySize} 位。`,
    };
  }

  const name = String(params.guestName ?? "").trim();
  if (name.length === 0 || name.length > 40) {
    return { ok: false, code: "name", message: "請填寫姓名（40 字以內）。" };
  }

  const phone = String(params.guestPhone ?? "").trim();
  if (!PHONE_DIGITS.test(phone) || normalizePhone(phone).length < 6) {
    return { ok: false, code: "phone", message: "請填寫有效的聯絡電話。" };
  }

  const note = String(params.guestNote ?? "");
  if (note.length > 500) {
    return { ok: false, code: "note_too_long", message: "備註最多 500 字。" };
  }

  const at = new Date(params.slotAt);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, code: "slot_format", message: "訂位時間格式不正確。" };
  }

  const earliest = now.getTime() + Math.max(0, params.settings.leadMinutesMin) * 60_000;
  const latest = now.getTime() + Math.max(1, params.settings.leadDaysMax) * 86_400_000;

  if (at.getTime() < earliest) {
    return {
      ok: false,
      code: "slot_out_of_window",
      message: `最早要提前 ${params.settings.leadMinutesMin} 分鐘訂位。`,
    };
  }
  if (at.getTime() > latest) {
    return {
      ok: false,
      code: "slot_out_of_window",
      message: `最多只可以提前 ${params.settings.leadDaysMax} 天訂位。`,
    };
  }

  const bizDate = reservationBizDate(at, params.settings.serviceHours);
  const window = bizDateWindow(bizDate, params.settings.serviceHours);
  if (!window) {
    return { ok: false, code: "slot_outside_hours", message: "本店當日沒有營業時段。" };
  }
  if (at.getTime() < window.start.getTime() || at.getTime() >= window.end.getTime()) {
    return { ok: false, code: "slot_outside_hours", message: "所選時間不在營業時段內。" };
  }

  return { ok: true, bizDate, slotAt: at };
}
