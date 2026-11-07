/**
 * 訂位狀態的顯示文案與配色 —— **UI 唯一真源**。
 *
 * ⚠️ 其他位置（POS 訂位台、會員通後台、詳情彈窗）唔好再各寫一份，
 *    否則同一個狀態會出現三種叫法。
 *
 * 本模組刻意唔用 `t()`：訂位模組嘅字典 key 未齊，
 * 硬加會令 `i18n-layer-guard` 報「孤兒 key」。待字典補齊再統一替換。
 */

import type { ReservationSource, ReservationStatus } from "./types.ts";

export type StatusMeta = { label: string; className: string; dot: string };

export const RESERVATION_STATUS_META: Record<ReservationStatus, StatusMeta> = {
  pending: { label: "待確認", className: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  confirmed: { label: "已確認", className: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  arrived: { label: "已到店", className: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  seated: { label: "已入座", className: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  completed: { label: "已完成", className: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  canceled: { label: "已取消", className: "bg-slate-100 text-slate-500", dot: "bg-slate-400" },
  no_show: { label: "未到", className: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  waitlist: { label: "候補", className: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
};

export const RESERVATION_SOURCE_LABEL: Record<ReservationSource, string> = {
  pos: "店員代訂",
  ledger: "會員通",
  phone: "電話訂位",
  walkin: "現場",
};

/** 卡片左邊框顏色（跟狀態一致）。 */
export const RESERVATION_STATUS_BORDER: Record<ReservationStatus, string> = {
  pending: "border-l-amber-400",
  confirmed: "border-l-indigo-400",
  arrived: "border-l-emerald-500",
  seated: "border-l-blue-400",
  completed: "border-l-slate-300",
  canceled: "border-l-slate-300",
  no_show: "border-l-rose-500",
  waitlist: "border-l-violet-400",
};

/** `$1,234` / `$1,234.5`。 */
export function formatMoney(value: number): string {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  const [int, dec] = text.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec ? `$${withCommas}.${dec}` : `$${withCommas}`;
}

/** `11月6日 週五`（澳門時區）。 */
export function formatBizDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const names = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  return `${m}月${d}日 ${names[weekday] ?? ""}`;
}

/** ISO → `18:30`（澳門）。 */
export function formatSlotTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--";
  const shifted = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/** 相對「今天」的標籤（今天 / 明天 / 空）。 */
export function relativeDayLabel(ymd: string, todayYmd: string, tomorrowYmd: string): string {
  if (ymd === todayYmd) return "今天";
  if (ymd === tomorrowYmd) return "明天";
  return "";
}
