/**
 * 收據時間戳格式化（**零 import 純函式**，故 `node --test` 可以直接跑）。
 *
 * 🔴 背景（2026-10-07 J 拍板）：
 *    `receipts.receipt_date` 係 **date 型別**，本身**只有年月日、冇時分秒**。
 *    要顯示到秒，唯一可用嘅來源係 `receipts.created_at` ＝ **錄入時間**。
 *
 * 🔴 語意警告：錄入時間 ≠ 單據時間。商家補登一張三日前的單，
 *    `receipt_date` 係三日前、`created_at` 係今日 ⇒ 兩者可以差好遠。
 *    所以 UI 必須標明「時間為錄入時間」，唔可以令商家誤會。
 */

/** 澳門時區（POS 全部日期歸屬都用呢個，唔可以用 UTC）。 */
const MACAU_TZ = "Asia/Macau";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 把 `YYYY-MM-DD` 轉做 `YYYY/MM/DD`。
 * 只做斜線替換，**唔經 Date 物件** —— 避免時區把日期推前／推後一日。
 */
export function slashDate(isoDate: string): string {
  const s = (isoDate ?? "").trim();
  if (!s) return "";
  // 只認 `YYYY-MM-DD`（或者已帶時間嘅 ISO 前 10 位）
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s; // 唔似 ISO 就原樣回，唔好亂改
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/**
 * 由 ISO 時間戳抽出澳門時區嘅 `HH:mm:ss`。
 *
 * 🔴 一定要用 `toLocaleString(..., { timeZone })` 再砌返。
 *    唔可以用 `getHours()`（會被執行環境時區影響 —— Vercel 係 UTC，
 *    會令澳門凌晨 0–8 點嘅收據顯示成前一日 16–23 點）。
 *    亦唔可以用 `toISOString()`（永遠係 UTC，必然差 8 小時）。
 *
 * @returns `HH:mm:ss`；解析失敗回 `null`（呼叫方 fallback）
 */
export function macauTimeOfDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  try {
    // `hour12: false` 避免英文環境出 AM/PM；en-GB 保證 `dd/mm/yyyy, hh:mm:ss`
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: MACAU_TZ,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(t);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const hh = get("hour");
    const mm = get("minute");
    const ss = get("second");
    if (!hh || !mm || !ss) return null;
    // ⚠️ `hour12: false` 喺部分環境會回 "24" 代表午夜 0 點 ⇒ 正規化做 "00"
    return `${hh === "24" ? "00" : hh}:${mm}:${ss}`;
  } catch {
    return null;
  }
}

/**
 * 收據時間戳：`YYYY/MM/DD HH:mm:ss`（年月日時分秒）。
 *
 * 降級（**唔可以出 `Invalid Date` 或亂砌**）：
 *   · `receiptDate` 空              → `""`
 *   · `createdAt` 空／解析失敗      → 只出 `YYYY/MM/DD`
 *   · `receiptDate` 同 `createdAt` 都空 → `"—"`
 *
 * @example formatReceiptStamp("2026-10-07", "2026-10-07T06:32:05Z") // "2026/10/07 14:32:05"
 */
export function formatReceiptStamp(
  receiptDate: string | null | undefined,
  createdAt: string | null | undefined,
): string {
  const label = slashDate(receiptDate ?? "");
  const time = macauTimeOfDay(createdAt);
  if (label && time) return `${label} ${time}`;
  if (label) return label;      // 冇錄入時間 ⇒ 只出日期（舊資料）
  if (time) return time;        // 冇單據日期 ⇒ 至少出時間
  return "—";                   // 兩者皆無 ⇒ 明確嘅空值佔位，唔可以出空白
}

/**
 * 單據日期同錄入日期**唔係同一日**？
 *
 * 用於 UI 加註（例如「補登」標記）：商家補登舊單時，
 * 單據日期同錄入日期會唔同 —— 呢個係**正常**但值得提示嘅情況。
 *
 * @returns `true` = 唔同日（或無法比較）
 */
export function isBackdatedReceipt(
  receiptDate: string | null | undefined,
  createdAt: string | null | undefined,
): boolean {
  const dateKey = slashDate(receiptDate ?? "");
  if (!dateKey || !createdAt) return false;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return false;
  try {
    const enCa = new Intl.DateTimeFormat("en-CA", {
      timeZone: MACAU_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t); // en-CA 出 YYYY-MM-DD
    return slashDate(enCa) !== dateKey;
  } catch {
    return false;
  }
}

/** 供 UI 顯示：把「錄入時間到秒」砌成一句完整描述。 */
export function receiptStampLabel(
  receiptDate: string | null | undefined,
  createdAt: string | null | undefined,
): { primary: string; note: string | null } {
  const primary = formatReceiptStamp(receiptDate, createdAt);
  const time = macauTimeOfDay(createdAt);
  if (!time) return { primary, note: null };
  return {
    primary,
    note: isBackdatedReceipt(receiptDate, createdAt)
      ? `時間為錄入時間・單據日期 ${slashDate(receiptDate ?? "")}`
      : "時間為錄入時間",
  };
}

// 令測試可以確認 `pad2` 嘅行為（避免被 tree-shake 或 lint 當未使用）
export const __testPad2 = pad2;
