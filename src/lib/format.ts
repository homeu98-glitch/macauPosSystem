// 共用格式化工具（🟢 抽共用）
//
// 原本散落喺多個 component / lib 嘅本地 formatMoney（10+ 處，兩種 signature）、
// salon/online 嘅 money()、各 component 嘅日期 toLocale* 格式化。
// 統一到呢度，確保貨幣（MOP 預設、逗號分位）同日期（Macau zh-HK 顯示）一致。

/** 貨幣格式化：預設 MOP，整數 + 逗號分位（跨環境一致，Macau 用逗號）。 */
export function formatMoney(amount: number, currency = "MOP"): string {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  const grouped = rounded.toLocaleString("en-US"); // 逗號分位，跨環境一致
  return `${currency} ${grouped}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

function toDate(iso: string | number | Date): Date {
  return iso instanceof Date ? iso : new Date(iso);
}

/** ISO 字串 → `YYYY-MM-DD（週X）HH:MM`（Macau 顯示用）。無效值原樣返回。 */
export function formatDateTime(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}（週${WEEKDAYS[d.getDay()]}）${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO 字串 → `YYYY-MM-DD（週X）`。 */
export function formatDate(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}（週${WEEKDAYS[d.getDay()]}）`;
}

/** ISO 字串 → `HH:MM`（24 小時）。 */
export function formatTime(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
