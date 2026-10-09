// 共用格式化工具（🟢 抽共用）
//
// 原本散落喺多個 component / lib 嘅本地 formatMoney（10+ 處，兩種 signature）、
// salon/online 嘅 money()、各 component 嘅日期 toLocale* 格式化。
// 統一到呢度，確保貨幣（MOP 預設、逗號分位）同日期（Macau zh-HK 顯示）一致。

/**
 * 貨幣**數值**格式化（唔帶貨幣前綴）：2 位小數 + 逗號分位，同 {@link formatMoney} 同一套捨入。
 *
 * ⚠️ 2026-10-08：由「整數」改為「2 位小數」，原因係澳門 MOP 支援毫（例如菜品價 19.8），
 * 舊嘅 `Math.round` 會令 19.8 顯示成 20，同菜單管理 list 嘅 raw string 顯示（19.8）對唔上。
 * 改咗之後所有 `formatMoney()` 出嚟都係 `1,234.00` / `19.80` 呢口徑。
 *
 * 用途：欄位窄嘅表（例如交班歷史 12 欄要喺 iPad 橫向塞得落）會把「MOP」寫喺**表頭**，
 * 每格只顯示數字。**唔可以**自己寫一套 `toLocaleString`，
 * 否則捨入／分位口徑會同其他頁漂移。（2 位小數令每格寬多約 3 字元，窄表要留意 overflow。）
 */
export function formatMoneyValue(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }); // 逗號分位 + 2 位小數，跨環境一致（Macau MOP 支援毫）
}

/** 貨幣格式化：預設 MOP，整數 + 逗號分位（跨環境一致，Macau 用逗號）。 */
export function formatMoney(amount: number, currency = "MOP"): string {
  return `${currency} ${formatMoneyValue(amount)}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

function toDate(iso: string | number | Date): Date {
  return iso instanceof Date ? iso : new Date(iso);
}

const MACAU_TZ = "Asia/Macau";

/** ISO 字串 → `YYYY-MM-DD HH:MM`（澳門時間，強制 Asia/Macau，唔受裝置時區影響）。 */
export function formatDateTime(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-HK", {
    timeZone: MACAU_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** ISO 字串 → `YYYY-MM-DD（週X）`。 */
export function formatDate(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}（週${WEEKDAYS[d.getDay()]}）`;
}

/** ISO 字串 → `HH:MM`（24 小時，澳門時間）。 */
export function formatTime(iso: string | number | Date): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-HK", { timeZone: MACAU_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** ISO 字串 → `YYYY-MM-DD HH:MM`（澳門時間）。專門取代原先直接剁 UTC ISO 嘅寫法（收銀/報表/後台）。 */
export function formatMacauDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-HK", {
    timeZone: MACAU_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * ISO 字串 → `MM/DD HH:MM`（澳門時間）。
 *
 * 專供**預約時間**顯示：同「會員通」出嘅收據同一口徑（`預約時間：09/14 12:15`），
 * 列表 / 卡片空間有限，用短格式先塞得落（`formatMacauDateTime` 會出埋年份）。
 * 需要完整年份（例如訂單詳情）就照用 `formatMacauDateTime`。
 */
export function formatMacauMonthDayTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("zh-HK", {
    timeZone: MACAU_TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.month}/${map.day} ${map.hour}:${map.minute}`;
}

/** ISO 字串 → `HH:MM`（澳門時間）。 */
export function formatMacauTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-HK", { timeZone: MACAU_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}
