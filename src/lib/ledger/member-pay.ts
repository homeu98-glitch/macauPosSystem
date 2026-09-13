/**
 * 會員餘額付款嘅**純邏輯**（零 runtime 依賴 → 可以 `node --test`）。
 *
 * 呢度只放「計數 / 格式化 / 砌字串」呢類可以單獨驗證嘅嘢；
 * 真正嘅網絡同 Ledger 呼叫喺 `@/lib/ledger/members`（`applyPosDeduct`）。
 */

/**
 * 付款方式。
 * ⚠️ 刻意**唔包括**「先扣餘額、差額到前台補」—— 會產生兩筆對帳，契約唔支援（確認稿 S6b）。
 */
export type MemberPayMethod = "balance" | "counter";

/**
 * 付款 sheet 嘅四個階段（對應確認稿 S6 / S7 / S9a / S9b）。
 *
 * `unknown` 係最需要小心嘅一個：**唔可以當「未扣款」**（Ledger 冇 lookup API，Q6），
 * 唯一手段係用同一冪等鍵重試。
 */
export type MemberPayStage = "choose" | "deduct" | "insufficient" | "unknown";


/**
 * 免 PIN 窗口（毫秒）—— 確認稿 S7b / docs/129 Q5。
 *
 * 🔴 **呢個窗口係唯一防線**：Ledger 端完全唔驗 PIN（契約 Q5），
 *    所以「登入後 3 分鐘內唔使再入 PIN」呢條規則**只有 POS 實作**。
 *    判錯 = 等於冇二次確認。
 *
 * 起計點 = **登入成功嗰一刻**（`memberLoggedInAt`）。
 * ⚠️ refresh / 任何操作都**唔可以延長**（否則客人掛機就可以無限免 PIN）。
 */
export const PIN_FREE_WINDOW_MS = 180_000;

/** 登入後 3 分鐘嘅人類可讀講法（UI 用）。 */
export const PIN_FREE_WINDOW_LABEL = "3 分鐘";

/**
 * 冪等鍵前綴（docs/129 P1 / Q2）。
 *
 * 🔴 **一定要用呢個格式**：`merchant_apply_pos_txn` 嘅 `apply_transaction` 係按
 *    呢個 key 去擋重複扣款。用其他格式（例如單純 `orderId`）→ **真·雙扣**。
 *
 * Ledger 要求 `[A-Za-z0-9._:-]{8,128}`。
 */
export const DEDUCT_IDEMPOTENCY_PREFIX = "scan-debit";

const IDEMPOTENCY_ALLOWED = /[^A-Za-z0-9._:-]/g;
const IDEMPOTENCY_MAX_LEN = 128;

/** 清走唔准嘅字元（寧願改 key 都唔好 throw —— 落單唔應該因為 key 格式而死）。 */
function sanitizeKeyPart(part: string): string {
  return part.replace(IDEMPOTENCY_ALLOWED, "-");
}

/**
 * 砌扣款冪等鍵：`scan-debit:{merchantId}:{posOrderId}`。
 *
 * ⚠️ **取消後唔可以重用同一 `posOrderId`**（契約 Q10）：
 *    已 commit 嘅 id 必須換新；未 commit 嘅可以重試。
 *    所以呢條 key 嘅生命週期 = 嗰一張 `posOrderId` 嘅生命週期。
 */
export function buildDeductIdempotencyKey(merchantId: string, posOrderId: string): string {
  const key = `${DEDUCT_IDEMPOTENCY_PREFIX}:${sanitizeKeyPart(merchantId)}:${sanitizeKeyPart(posOrderId)}`;
  return key.slice(0, IDEMPOTENCY_MAX_LEN);
}

/**
 * 免 PIN 剩餘毫秒數。
 *
 * @param loggedInAtMs 登入成功時間戳；`null` = 冇登入 → 一定需要 PIN（回 0）。
 * @param nowMs 現在時間戳。
 * @returns `>0` = 仲免 PIN；`<=0` = 已逾時，要重新入 PIN。
 */
export function pinFreeRemainingMs(loggedInAtMs: number | null, nowMs: number): number {
  if (loggedInAtMs === null || !Number.isFinite(loggedInAtMs)) return 0;
  return PIN_FREE_WINDOW_MS - (nowMs - loggedInAtMs);
}

/** 是否仍然免 PIN。 */
export function isPinFree(loggedInAtMs: number | null, nowMs: number): boolean {
  return pinFreeRemainingMs(loggedInAtMs, nowMs) > 0;
}

/**
 * 由登入到現在過咗幾久嘅中文字串（確認稿 S7b 例句：「2 分 12 秒」）。
 * 負數 / 非有限值一律當 0 秒。
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

/**
 * MOP（可能係小數）→ avos 整數。契約：`1 MOP = 100 avos`，**禁止 float**。
 *
 * ⚠️ 用 `Math.round` 而唔係 `Math.floor`：`0.1 + 0.2` 類嘅浮點誤差會令
 *    `Math.floor(70.00 * 100)` 偶爾少 1 avos（`6999.999…`），
 *    客人就會見到「扣咗 MOP 69.99」。
 */
export function mopToAvos(mop: number): number {
  if (!Number.isFinite(mop)) return 0;
  return Math.round(mop * 100);
}

/** avos 整數 → MOP 數字（顯示用）。 */
export function avosToMop(avos: number): number {
  if (!Number.isFinite(avos)) return 0;
  return Math.round(avos) / 100;
}

/** 格式化解鎖時間（確認稿 S3b：「請於 14:37 後再試」）。 */
export function formatRetryClock(retryAfterSec: number, nowMs: number): string {
  const target = new Date(nowMs + Math.max(0, retryAfterSec) * 1000);
  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
