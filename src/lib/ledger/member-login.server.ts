import "server-only";

import { createClient } from "@supabase/supabase-js";

import { deriveLedgerAuthPassword } from "@/lib/ledger/pin.server";
import { isValidMacauPhone, ledgerAuthEmail, normalizePhone } from "@/lib/ledger/phone";

/**
 * 顧客會員登入（POS 側，server-only）—— Ledger 契約 §4.5。
 *
 * ⚠️ 呢個檔同 `/api/ledger/login`（店員登入）係**兩套完全唔同嘅流程**，唔可以合併：
 *   - 店員（§4.3）：登入後**必須**查到 `merchant_staff`，否則拒絕；簽 `posDeviceToken`。
 *   - 顧客（§4.5）：登入後**必須跳過** `merchant_staff` 檢查（一般會員冇 staff 列），
 *     成功即係「證明你係錢包主人」。契約 §4.5.2 步驟 2 明文要求「另開顧客 route，
 *     勿改壞店員登入」。
 *
 * 演算法同 §4.1 完全一樣（同一顆 `AUTH_PIN_PEPPER`、同一 HMAC、同一 `signInWithPassword`）：
 *   email    = normalizePhone(phone) + "@phone.macau-ledger.app"
 *   password = HMAC-SHA256(key=AUTH_PIN_PEPPER, msg=normalizePhone(phone) + ":" + pin).hex
 *
 * 🔴 個資紅線（契約 §7.2 / §5.11）：
 *   - 回傳嘅 `displayName` / 餘額只准「當次 UI 渲染」，**禁**寫入 POS Supabase、
 *     `localStorage`、analytics、console。
 *   - 落 POS 訂單只准落 `customerId`（uuid）—— **唔准落電話**。
 *   - **唔回傳任何 token 俾瀏覽器**：線 A（Kiosk 店員代扣）用唔到顧客 JWT，
 *     而 Kiosk 係共用平板，留低顧客 session 只會增加風險。契約 §4.5.2 步驟 4
 *     講嘅「回 access_token」係為咗「顧客自助讀 §5.11」—— 我哋改為**喺 server 側
 *     一次過讀完**（步驟 6「按需讀 §5.11」），效果一樣而唔使將憑證放落共用裝置。
 */

export type CustomerWalletSnapshot = {
  /** Ledger `wallets.id`（該會員喺本店嘅錢包列）；未開過錢包 = null。 */
  walletId: string | null;
  /** paid + gift 合計（avos 整數）。 */
  balanceAvos: number;
  /** 實際充值池。 */
  paidBalanceAvos: number;
  /** 贈送池。 */
  giftBalanceAvos: number;
};

export type CustomerLoginResult = {
  /** Ledger 顧客 uuid —— 唯一准落 POS 訂單嘅會員欄位。 */
  customerId: string;
  /** 會員顯示名。**只准即時渲染**。 */
  displayName: string | null;
  wallet: CustomerWalletSnapshot;
  /**
   * 顧客 Ledger access token（JWT）。
   *
   * ⚠️ **只用於 v3.5 掃碼自助扣款**（`scan-debit/quote|commit` 嘅 `Authorization: Bearer`）。
   * 契約 §4.5.2 步驟 4 明文要求「將 `access_token` 回前端」——所以呢個係預期行為，
   * **唔係**洩漏。
   *
   * 🔴 但係**唔可以**無條件回：
   *    - **Kiosk（店內共用平板）** → route 層**唔可以**把 token 交出去。
   *      共用裝置留低顧客憑證 = 下一位客人可以扣上一位嘅錢（零收益、純風險）。
   *    - **掃碼（客人自己手機）** → 回，但前端只准存**記憶體**（唔准 localStorage）。
   *
   * `refresh_token` 一律**唔回** —— 扣款流程只需要短短幾分鐘內有效嘅 access token。
   */
  customerAccessToken: string;
};

export type CustomerLoginFailureReason = "bad_credential" | "not_configured" | "upstream";

/** 帶機器可讀原因嘅錯誤，等 route 層可以映射成 HTTP 碼而唔使 parse message。 */
export class CustomerLoginError extends Error {
  readonly reason: CustomerLoginFailureReason;

  constructor(reason: CustomerLoginFailureReason, message?: string) {
    super(message ?? reason);
    this.name = "CustomerLoginError";
    this.reason = reason;
  }
}

function resolveLedgerConfig() {
  return {
    // ⚠️ `NEXT_PUBLIC_SUPABASE_URL` = **Ledger** 專案（同 `getLedgerSupabaseClient()` 一致）。
    //    POS 自己嘅專案係 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（見 supabase-server.ts）。
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
    pepper: process.env.AUTH_PIN_PEPPER ?? null,
  };
}

/**
 * 顧客登入 + 讀本店錢包（契約 §4.5 + §5.11.1）。
 *
 * @param phone  顧客輸入嘅登入電話號（8 位數字；`normalizePhone` 會去非數字取後 8 位）。
 * @param pin    4 位數字 PIN。**只到 POS 後端**，唔會回傳。
 * @param merchantId 本店 `merchants.id`（= Kiosk 綁機嘅 storeId / 掃碼 URL 嘅 `store`）。
 *
 * @throws CustomerLoginError
 *   - `not_configured`：缺 `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` / `AUTH_PIN_PEPPER`
 *   - `bad_credential`：帳號唔存在 / 未設 PIN / PIN 錯 —— **三者刻意唔可分**（防枚舉，§4.5.2）
 *   - `upstream`：連線 / 讀錢包失敗
 */
export async function loginCustomer(params: {
  phone: string;
  pin: string;
  merchantId: string;
}): Promise<CustomerLoginResult> {
  const { url, anonKey, pepper } = resolveLedgerConfig();
  if (!url || !anonKey || !pepper) {
    throw new CustomerLoginError("not_configured", "Ledger Supabase 或 AUTH_PIN_PEPPER 未設定。");
  }

  const phone = normalizePhone(params.phone);
  if (!isValidMacauPhone(phone)) {
    // 格式錯同憑證錯一律當 bad_credential 處理，唔向 client 洩露「帳號存在性」資訊。
    throw new CustomerLoginError("bad_credential");
  }

  // 每次請求開新 client（唔共用、唔持久化）：
  // server 係長駐 process，共用一個 client 會令唔同請求嘅顧客 session 互相覆蓋
  //（同 `getLedgerSupabaseClient()` 嘅店員單例同一個坑，但方向相反）。
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const password = deriveLedgerAuthPassword(phone, params.pin, pepper);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: ledgerAuthEmail(phone),
    password,
  });

  if (authError || !authData.user || !authData.session) {
    throw new CustomerLoginError("bad_credential");
  }
  // 🔴 喺呢一刻攞走 token（後面**唔會**再 signOut —— 見檔尾長註解）。
  const customerAccessToken = authData.session.access_token;

  // ── 契約 §4.5.2 步驟 5：**跳過** `merchant_staff` 檢查 ──
  // 一般會員冇 staff 列；喺呢度查 merchant_staff 會令所有正常會員登入失敗。
  // （店員用顧客頁登入係合法嘅，但嗰個 JWT **唔可以**當成收銀台/Kiosk 店員 session。）

  // ── §5.11.1 本店儲值餘額（PostgREST `wallets`）──
  // 🔴 一定要用**顧客** session 讀，並且**必須**過濾 `customer_id`：
  //    店員 JWT 讀得到全店錢包，唔過濾就會攞到其他客人嘅餘額。
  //    亦**唔可以**改用 §5.6.1 `merchant_lookup_customer_wallet`（嗰個要店員，顧客會被拒）。
  //    `balance_avos` 已經係 paid + gift 合計。
  const { data: walletRow, error: walletError } = await supabase
    .from("wallets")
    .select("id, balance_avos, paid_balance_avos, gift_balance_avos")
    .eq("customer_id", authData.user.id)
    .eq("merchant_id", params.merchantId)
    .maybeSingle();

  if (walletError) {
    // 讀唔到餘額 ≠ 冇餘額。唔可以當 0 處理（否則客人會見到「餘額 0」而明明有錢）。
    throw new CustomerLoginError("upstream", `讀取會員錢包失敗：${walletError.message}`);
  }

  // 顯示名：Auth user metadata 為準（`wallets` 冇 display_name）。
  const meta = (authData.user.user_metadata ?? {}) as Record<string, unknown>;
  const displayNameRaw =
    typeof meta.display_name === "string"
      ? meta.display_name
      : typeof meta.name === "string"
        ? meta.name
        : null;
  const displayName = displayNameRaw?.trim() ? displayNameRaw.trim().slice(0, 60) : null;

  // 🔴🔴 **唔可以 `signOut`！**（2026-09-13 J 實案）
  //
  // 原本喺度叫 `signOut({ scope: "local" })`，以為「只清本地、唔 revoke」。但係實測落嚟：
  // 客人登入成功、攞到 token，但係之後拎去 `scan-debit/quote` 打 Ledger 時被判
  // 「**登入已過期**」（401）—— 即係 Ledger 側認為嗰個 session 已經唔有效。
  //
  // 原因：Supabase 嘅 `signOut` 會令該 session 失效；Ledger 驗 token 時若果會查
  // session 狀態（唔係純 JWT 簽名驗證），就會即時 401。`scope` 嘅細節唔應該賭。
  //
  // 呢個 client 係**函式內嘅區域變數**，request 完結就會被 GC —— 本來就唔需要登出。
  // 所以「唔登出」既安全（唔會殘留）又唔會誤殺 token。

  const row = (walletRow ?? null) as Record<string, unknown> | null;
  const paidBalanceAvos = Number(row?.paid_balance_avos ?? 0);
  const giftBalanceAvos = Number(row?.gift_balance_avos ?? 0);
  // `balance_avos` 缺失時（未開錢包 = 冇列）一律 0，**唔可以**用 paid+gift 自行相加 ——
  // 上游口徑可能包含未計入 balance 嘅鎖定金額，自行相加會同顯示對唔上。
  const balanceAvos = row ? Number(row.balance_avos ?? 0) : 0;

  return {
    customerId: String(authData.user.id),
    displayName,
    customerAccessToken,
    wallet: {
      walletId: row?.id ? String(row.id) : null,
      balanceAvos: Number.isFinite(balanceAvos) ? balanceAvos : 0,
      paidBalanceAvos: Number.isFinite(paidBalanceAvos) ? paidBalanceAvos : 0,
      giftBalanceAvos: Number.isFinite(giftBalanceAvos) ? giftBalanceAvos : 0,
    },
  };
}
