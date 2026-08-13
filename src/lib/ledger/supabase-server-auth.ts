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

export async function prepareLedgerServerClient(
  accessToken: string,
  refreshToken?: string | null,
): Promise<SupabaseClient | null> {
  const client = createLedgerServerClient(accessToken);
  if (!client) return null;

  if (refreshToken) {
    const { error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) return client;
  }

  return client;
}
