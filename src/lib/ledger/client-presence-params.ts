/**
 * 《商戶端活躍上報》參數（2026-09-24）—— Ledger 契約 §4.6。
 *
 * ## 呢個功能係咩（同唔係咩）
 *
 * 店員用 Ledger 電話 + PIN **登入 POS 成功**（或者分頁重開**恢復 session**）之後，
 * 用**店員 JWT** 直連 Ledger Supabase 打一支 RPC，Ledger Admin `/admin` 卡片
 * 「商戶端活躍與接入」嘅 **POS 欄** 先會有時間。
 *
 * · **唔係**即時在線監控 —— 係「近 30 日最後活躍」，粒度只到「店 × 端別」（`web`／`sunmi`／`pos`）。
 * · **唔係**顧客登入（§4.5）—— 顧客 JWT 冇 `merchant_staff`，打咗會被拒（契約禁止項）。
 * · **唔會**新增任何 polling／heartbeat route —— Ledger **唔** poll POS，亦**唔**讀 POS 自己嘅 DB。
 *
 * ## 為何本檔零 import
 *
 * 專案 `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名）⇒
 * **可測模組唔准 import**（同 `build-info.ts`／`session-record.ts` 同一慣例）。
 * 有 I/O 嘅部分另開 `client-presence.ts`。
 */

/** Ledger 側用嚟分辨端別嘅固定字串。POS 一律 `pos`（商米 App 係 `sunmi`、商戶 Web 係 `web`）。 */
export const POS_CLIENT_ID = "pos";

/** Ledger Supabase 嘅 RPC 名（契約 §4.6）。Ledger 未跑 migration 時會回 `function does not exist`。 */
export const CLIENT_PRESENCE_RPC = "record_merchant_client_login";

/** 版本字串上限（Ledger 側只作顯示；太長直接放棄，唔截斷 —— 截斷會出一個半截嘅假版本號）。 */
const APP_VERSION_MAX_LEN = 40;

/** 只准建置識別碼會用到嘅字元（commit sha／deployment id／`1.2.0`／`dev`）。 */
const APP_VERSION_ALLOWED = /^[A-Za-z0-9._+-]+$/;

/**
 * 🔴 8 位以上連續數字 ＝ 疑似電話號碼（澳門號碼 8 位）／PIN 拼接物。
 * 契約明文禁止把電話／PIN 放入 `p_app_version`（佢會顯示喺 Ledger Admin，亦會入 log）。
 * 寧願唔報版本，都唔可以漏個電話號碼出去。
 */
const PHONE_LIKE = /\d{8,}/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 清洗 `p_app_version`。
 *
 * @returns 乾淨字串；**任何可疑／過長／非字串 ⇒ `null`**（＝唔報版本，但照樣上報活躍）。
 */
export function sanitizePosAppVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > APP_VERSION_MAX_LEN) return null;
  if (!APP_VERSION_ALLOWED.test(trimmed)) return null;
  if (PHONE_LIKE.test(trimmed)) return null;
  return trimmed;
}

/** `merchant_staff.merchant_id` 係 UUID —— 唔似 UUID 就表示未攞到真嘅商戶 id，唔應該亂報。 */
export function isUuidLike(raw: unknown): boolean {
  return typeof raw === "string" && UUID_RE.test(raw.trim());
}

/** 送畀 `client.rpc()` 嘅具名參數（PostgREST 用 `p_xxx` 前綴）。 */
export type ClientPresenceParams = {
  p_merchant_id: string;
  p_client: string;
  p_app_version: string | null;
};

/**
 * 砌 RPC 參數。
 *
 * @returns 參數物件；`merchantId` 唔似 UUID ⇒ `null`（＝唔應該呼叫）。
 *
 * ⚠️ `p_app_version` 用 `null` 而唔係空字串：Ledger 側「版本字串變更仍會更新
 * `last_login_at`」，空字串會被當成一個「版本」而無意義地觸發更新。
 */
export function buildClientPresenceParams(
  merchantId: unknown,
  appVersion: unknown,
): ClientPresenceParams | null {
  const id = typeof merchantId === "string" ? merchantId.trim() : "";
  if (!isUuidLike(id)) return null;
  return {
    p_merchant_id: id,
    p_client: POS_CLIENT_ID,
    p_app_version: sanitizePosAppVersion(appVersion),
  };
}
