/**
 * 打印任務失敗原因分類（P4，2026-09-15）。
 *
 * ── 為咩要「分類」而唔係留返一句 `last_error` ────────────────────────
 * 現行做法係把中繼機報嘅 `error` 原文（APK 嘅 exception message）寫入
 * `pos_print_jobs.last_error`，前端 line-clamp 顯示。問題：
 *   · 同一種故障（例如打印機離線）在不同 APK 版本有唔同文字 → 冇得統計；
 *   · 「冇人認領」（pending 太久）同「認領咗但死咗」（printing 太久）
 *     根本冇 error 文字 → 前端只見到「已發送」，**零告警**（當日事故）；
 *   · 無法區分「等印」「印唔到」「作廢」。
 *
 * 所以加一層**穩定嘅原因碼**（`PrintJobFailureReason`），文字留返做補充。
 * 前端／告警只認原因碼，令同一種故障永遠歸一類。
 *
 * ⚠️ 呢個 module 必須係**純函式、零依賴** —— 前後端共用，亦要行得到
 *    `node --test`（本機冇 npm / vitest）。
 */

/** 打印任務失敗（或告警）原因碼。 */
export type PrintJobFailureReason =
  /** 建單之後一直冇 agent 認領（中繼機離線 / 未配對）→ 唔會出紙。 */
  | "TIMEOUT_CLAIM"
  /** 認領咗但超時冇回報（agent 中途死咗 / render 拋錯 / result POST 丟失）。 */
  | "TIMEOUT_STALE"
  /** 呢個 job 已逾有效期或跨營業日 → 系統主動作廢，避免隔夜補印。 */
  | "VOID_STALE"
  /** 中繼機明確回報失敗（打印機離線 / 缺紙 / ESC/POS 錯誤）。 */
  | "AGENT_FAILED"
  /** 重試次數用完（attempts >= 5）。 */
  | "ATTEMPTS_EXHAUSTED"
  /** 無法歸類（保留原文）。 */
  | "UNKNOWN";

/** 原因碼 → 繁體中文短標籤（前端紅標／告警用）。 */
export const PRINT_JOB_FAILURE_LABELS: Record<PrintJobFailureReason, string> = {
  TIMEOUT_CLAIM: "一直冇中繼機認領",
  TIMEOUT_STALE: "中繼機認領後中斷",
  VOID_STALE: "已逾時作廢",
  AGENT_FAILED: "打印機出紙失敗",
  ATTEMPTS_EXHAUSTED: "重試次數用完",
  UNKNOWN: "未知原因",
};

/** 原因碼 → 建議處理（給店家看嘅一句話）。 */
export const PRINT_JOB_FAILURE_HINTS: Record<PrintJobFailureReason, string> = {
  TIMEOUT_CLAIM: "請檢查店內中繼機（Print Hub）有冇開機並已配對。",
  TIMEOUT_STALE: "中繼機可能中途斷線或當機；請重啟中繼機後重試。",
  VOID_STALE: "此單已過期（避免隔夜補印）。如需補印請用「補打帳單」。",
  AGENT_FAILED: "請檢查打印機電源、紙張與網絡，然後重試。",
  ATTEMPTS_EXHAUSTED: "已自動重試 5 次仍失敗；請檢查打印機後重試。",
  UNKNOWN: "請重試；若持續失敗請聯絡技術支援。",
};

/**
 * 由 job 嘅雲端欄位推斷原因碼（**唔靠 error 原文**，只靠狀態 + 時間）。
 *
 * 判準順序（由最確定到最含糊）：
 *   1. `VOID_STALE`   —— 已被系統作廢（`last_error` 帶 `VOID_` 前綴）
 *   2. `ATTEMPTS_EXHAUSTED` —— `attempts >= 5` 且失敗
 *   3. `AGENT_FAILED` —— 有 error 原文（中繼機明確講咗原因）
 *   4. `TIMEOUT_STALE` —— `printing` 且 `claimed_at` 超過窗口
 *   5. `TIMEOUT_CLAIM` —— `pending` 且 `created_at` 超過窗口
 *   6. `UNKNOWN`
 *
 * @param status      雲端 `status`（pending / printing / failed / printed）
 * @param attempts    已嘗試次數
 * @param lastError   `last_error` 原文（可能 null）
 * @param claimedAt   `claimed_at`（ISO 或 null）
 * @param createdAt   `created_at`（ISO）
 * @param nowMs       「現在」epoch millis（可注入，方便測試）
 */
export function classifyPrintJobFailure(params: {
  status: string;
  attempts?: number | null;
  lastError?: string | null;
  claimedAt?: string | null;
  createdAt?: string | null;
  nowMs?: number;
  /** 認領超時窗（毫秒）。預設 6 分鐘，對齊 0042 嘅同機 reclaim 窗。 */
  claimTimeoutMs?: number;
  /** stale 認領窗（毫秒）。預設 90 秒，對齊 0042 嘅跨機 takeover 窗。 */
  staleTimeoutMs?: number;
}): PrintJobFailureReason | null {
  const {
    status,
    attempts,
    lastError,
    claimedAt,
    createdAt,
    nowMs = Date.now(),
    claimTimeoutMs = 6 * 60 * 1000,
    staleTimeoutMs = 90 * 1000,
  } = params;

  // 已成功出紙 → 唔算失敗。
  if (status === "printed") return null;

  const err = (lastError ?? "").trim();

  // 1) 系統主動作廢（P1 隔夜保護會寫 VOID_STALE 前綴，見 void-stale SQL / 未來 sweep）。
  if (err.startsWith("VOID_STALE")) return "VOID_STALE";

  // 2) 重試用完。
  if (status === "failed" && Number(attempts ?? 0) >= 5) return "ATTEMPTS_EXHAUSTED";

  // 3) 中繼機明確回報原因。
  if (err) return "AGENT_FAILED";

  // 4) 認領咗但冇回報。
  if (status === "printing") {
    const claimedMs = claimedAt ? Date.parse(claimedAt) : NaN;
    if (!Number.isFinite(claimedMs)) return "TIMEOUT_STALE";
    return nowMs - claimedMs >= staleTimeoutMs ? "TIMEOUT_STALE" : null;
  }

  // 5) 一直冇人認領。
  if (status === "pending") {
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(createdMs)) return null;
    return nowMs - createdMs >= claimTimeoutMs ? "TIMEOUT_CLAIM" : null;
  }

  return "UNKNOWN";
}
