/**
 * 外送派單功能開關 —— **預設關**。
 *
 * ## 為什麼要有開關
 *
 * 「派送」需要 Ledger v3.6 開放 4 支 endpoint（派送／取消／催單／加價）＋
 * 2 支聊天 RPC 白名單。Ledger 未上線之前，POS 唔應該顯示一個撳落去冇反應嘅掣。
 *
 * 所以：**代碼可以 merge、UI 可以上線，但掣唔會出現**，
 * 對現有功能零影響；Ledger 一好，改 env + redeploy 就開。
 *
 * ## 用法
 *
 * - 預設（冇設／任何其他值）→ `false`
 * - `NEXT_PUBLIC_DELIVERY_DISPATCH=1` → `true`
 *
 * ⚠️ 用 `NEXT_PUBLIC_` 係因為同一個值要喺 client（決定顯示掣）同 server（API 守門）
 *    兩邊都讀得到；呢個唔係秘密，只係功能旗標。
 * 🔴 env var 只對「儲存後新建嘅部署」生效 —— 改完要重新部署，唔會回溯。
 */

export const DELIVERY_DISPATCH_FLAG = "NEXT_PUBLIC_DELIVERY_DISPATCH";

/** 未計入 build-time inline 嘅環境（例如 node --test）會走呢個 fallback。 */
export function isDeliveryDispatchEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return String(env[DELIVERY_DISPATCH_FLAG] ?? "").trim() === "1";
}

/**
 * 「車手平台已經接通」—— 第二道旗標，**預設關**。
 *
 * ## 為什麼要同 `DELIVERY_DISPATCH` 分開
 *
 * 兩個階段嘅**後果完全唔同**：
 *
 * | 旗標 | 打開之後 |
 * |---|---|
 * | `DELIVERY_DISPATCH=1` | UI 出現「派送」掣；確認後只寫一筆 `draft`（本地） |
 * | `DELIVERY_LIVE=1` | 真正呼叫 Ledger A1／B1 → SiteB → 車手 App |
 *
 * 如果只有一個旗標，就會出現「掣出現咗、商家撳咗、以為叫咗車手，但其實冇人嚟」
 * —— 呢個係最危險嘅失敗模式（比冇掣更差）。所以：
 *
 * - `LIVE` 未開 → 彈窗底部**明寫**「現時只儲存派單資料，唔會真的叫車」；
 * - `LIVE` 一開 → 同一句消失，改為正常流程。
 *
 * Ledger v3.6 未部署之前，**兩個都要保持關**（默認就係關）。
 */
export const DELIVERY_LIVE_FLAG = "NEXT_PUBLIC_DELIVERY_LIVE";

export function isDeliveryLiveEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return String(env[DELIVERY_LIVE_FLAG] ?? "").trim() === "1";
}

/**
 * 「線上單（Ledger）派送」—— 第三道旗標，**預設關**。
 *
 * ## 為什麼要同店內／平台分開
 *
 * 兩條線喺 Ledger 係**唔同 endpoint、可以分開交付**：
 *
 * | 線 | 來源 | Ledger 要做 | 幾時開 |
 * |---|---|---|---|
 * | B 線（外部派單） | 店內單、快餐 counter、澳覓／MFOOD 自送自取 | `merchant_external_dispatches` 建單 endpoint | 先 |
 * | A 線（原生派送） | 線上 `merchant_delivery` 單 | `order_delivery_dispatch` 4 支 endpoint ＋ 聊天 RPC 白名單 | 後 |
 *
 * 用戶 2026-10-31 拍板：**線下／平台先上，Ledger 確認好之後才開線上部分**。
 * 所以線上單嘅「派送」掣要獨立一道閘 —— 唔開就完全唔出現，
 * 線上單維持現有流程（客人取消重落／商家線下處理），零影響。
 *
 * ⚠️ 呢個 flag 只影響 **`kind === "online"`** 嘅資格判斷；店內／平台單唔受影響。
 */
export const DELIVERY_ONLINE_FLAG = "NEXT_PUBLIC_DELIVERY_ONLINE";

export function isDeliveryOnlineEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return String(env[DELIVERY_ONLINE_FLAG] ?? "").trim() === "1";
}
