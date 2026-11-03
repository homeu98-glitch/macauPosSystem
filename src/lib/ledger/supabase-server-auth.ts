import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function resolveLedgerPublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, anonKey };
}

/** 伺服器端以使用者 JWT 查詢 Ledger（RLS 需要 Authorization）。 */
export function createLedgerServerClient(accessToken: string): SupabaseClient | null {
  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) return null;

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

/**
 * 建立一個「已用 refresh token 換過票」嘅 server client。
 *
 * ## 🔴🔴 為何一定要**重建** client（2026-11-03 實案）
 *
 * 舊寫法：`createLedgerServerClient(accessToken)` 之後 `client.auth.setSession(...)`，
 * 然後**照用原本嗰個 client**。
 *
 * 問題係 `createLedgerServerClient()` 把 `Authorization: Bearer <過期票>` 寫死喺
 * `global.headers` —— 呢個 header 係**建立嗰一刻**定死嘅，`setSession()` 只係更新
 * `client.auth` 內部 session，**唔會改寫 `global.headers`**。
 *
 * 實測症狀（Vercel log 每 30 秒一次、幾部機一齊）：
 *
 * ```
 * [pos/device-token] 讀取 merchant_staff 失敗: JWT expired
 * ```
 *
 * `auth.getUser()` 過到（auth 用新票），但 `merchant_staff` 查詢仍然帶住過期票
 * ⇒ 全店 POS 憑證永遠續唔到 ⇒ 12 小時後跌返匿名通道 ⇒ 收銀員靜靜咁壞機。
 *
 * ⇒ 換票成功就**用新 access token 重新 createClient**，令 PostgREST 一定用新票。
 */
export async function prepareLedgerServerClient(
  accessToken: string,
  refreshToken?: string | null,
): Promise<SupabaseClient | null> {
  const initial = createLedgerServerClient(accessToken);
  if (!initial) return null;
  if (!refreshToken) return initial;

  const { data, error } = await initial.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  // 換唔到票就照回原本 client：由 caller 嘅 `getUser()` 決定係咪 401（fail-closed）。
  if (error) return initial;

  const fresh = data.session?.access_token;
  if (!fresh || fresh === accessToken) return initial;
  // 🔴 一定要重建：舊 client 嘅 Authorization header 已經釘死喺過期票上面。
  return createLedgerServerClient(fresh) ?? initial;
}
