/**
 * 打印任務狀態詞彙表 —— **雲端 ↔ 本機** 唯一對照真源。
 *
 * ## 為咩要獨立一支（2026-09-24 商家實案）
 *
 * 雲端 `pos_print_jobs.status` 由 claim RPC 寫成 `'printing'`（migration 0020 / 0035 / 0042），
 * 而本機 `PrintJob["status"]`（`types.ts`）以前只有 `pending | sent | failed | printed`。
 * 兩邊詞彙唔一致 + mapper 只做型別 cast（冇 runtime 檢查）⇒ 雲端一行狀態係 `printing`
 * 嘅 job 落到本機就係**非法值**，`normalizePrintJobStatus()`（`print-jobs.ts`）
 * 一律將佢標成 **失敗 ＋「狀態欄位異常，已自動標記為失敗」**。
 *
 * 商家 2026-09-24 截圖：打印中心一排「空白單號 + kitchen + 狀態欄位異常 + 失敗」——
 * 當中**冇一張真係印唔到**（雲端同一行係 `printed`）。呢個假紅標既誤導店員，
 * 亦蓋住真正需要跟進嘅失敗單。
 *
 * ## 詞彙定義
 *
 * | 值 | 意思 | 誰寫 |
 * |---|---|---|
 * | `pending`  | 未派發（本機）／未認領（雲端） | POS / sync |
 * | `printing` | **過渡態**：中繼 APK 已認領、未回報 | `pos_claim_print_jobs()` |
 * | `sent`     | 本機已交畀打印通道（**樂觀值**，未確認出紙） | `dispatch.ts` |
 * | `printed`  | 雲端確認真實出紙成功（終態） | `print-agent/result` |
 * | `failed`   | 印唔到（終態）／本機派發失敗 | agent / dispatch |
 *
 * ⚠️ `printing` 係**過渡態**：唔可以派發（`dispatch.ts` 只揀 `pending`）、
 *    唔算失敗（唔應該出紅標）、亦唔可以覆寫本機已有嘅 `sent`。
 *
 * ⚠️ 呢支模組必須**零 import、純函式** —— 前後端共用，亦要行得到 `node --test`
 *    （本機冇 npm / vitest；見 `print-job-status.test.ts`）。
 */

/** 打印任務狀態（雲端 + 本機聯集）。 */
export type PrintJobStatus = "pending" | "printing" | "sent" | "failed" | "printed";

/** 法定值（順序＝生命週期：pending → printing → printed／failed；sent 係本機側）。 */
export const PRINT_JOB_STATUSES: readonly PrintJobStatus[] = [
  "pending",
  "printing",
  "sent",
  "failed",
  "printed",
];

/** 終態：唔會再變（`printed` 出紙成功、`failed` 印唔到）。 */
export const TERMINAL_PRINT_JOB_STATUSES: readonly PrintJobStatus[] = ["printed", "failed"];

/** 雲端 DB 可能出現嘅狀態（`printing` 係 RPC 寫嘅過渡態）。 */
export const CLOUD_PRINT_JOB_STATUSES: readonly PrintJobStatus[] = [
  "pending",
  "printing",
  "printed",
  "failed",
];

export function isPrintJobStatus(value: unknown): value is PrintJobStatus {
  return typeof value === "string" && (PRINT_JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * 任何來源（雲端 row / 舊 localStorage / 未來新增狀態）→ 合法狀態。
 *
 * ⚠️ 未知值**一律當 `pending`**（＝「仲要跟」），唔可以原樣透傳：
 * 透傳會令 `normalizePrintJobStatus()` 將一張其實正常嘅單標成失敗（見檔頭實案）。
 * 亦唔可以當 `failed` —— 假紅標會蓋住真正嘅失敗單。
 */
export function toPrintJobStatus(value: unknown): PrintJobStatus {
  return isPrintJobStatus(value) ? value : "pending";
}

/**
 * 雲端 row → 本機狀態（語義上多一層：雲端唔會出 `sent`）。
 *
 * 同 `toPrintJobStatus()` 一樣用白名單；獨立一個名只為咗呼叫端**講清楚來源**，
 * 令「呢個值嚟自 DB row」一眼睇得出（`/api/pos/state` 同 `mapPosPrintJobRow` 都用佢）。
 */
export function cloudRowToPrintJobStatus(value: unknown): PrintJobStatus {
  return isPrintJobStatus(value) && (CLOUD_PRINT_JOB_STATUSES as readonly string[]).includes(value)
    ? value
    : "pending";
}

/** 係咪終態（唔會再變）。 */
export function isTerminalPrintJobStatus(value: unknown): boolean {
  return isPrintJobStatus(value) && (TERMINAL_PRINT_JOB_STATUSES as readonly string[]).includes(value);
}

/** 狀態 → 繁體中文短標籤（UI 藥丸／明細用的同一套文案）。 */
export const PRINT_JOB_STATUS_LABELS: Record<PrintJobStatus, string> = {
  pending: "待補傳",
  printing: "出紙中",
  sent: "已發送",
  printed: "打印成功",
  failed: "失敗",
};

/** 狀態 → UI 顏色 key（`print-center.tsx` 藥丸用；語義同原本一致）。 */
export const PRINT_JOB_STATUS_TONES: Record<PrintJobStatus, "sky" | "emerald" | "amber" | "red"> = {
  printed: "sky",
  sent: "emerald",
  pending: "amber",
  // 過渡態：同 「待補傳」同色系但唔算失敗（唔用紅色）。
  printing: "amber",
  failed: "red",
};
