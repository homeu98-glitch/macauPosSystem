"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let ledgerClient: SupabaseClient | null = null;

function resolveLedgerUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
}

function resolveLedgerAnonKey(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null;
}

/**
 * 🔴 TOKEN_REFRESHED／SIGNED_IN → `realtime.setAuth(新票)`（2026-10-16，Ledger PR#40 第 4 點）。
 *
 * ## 為咩要顯式掛一條（library 內置都做埋）
 *
 * supabase-js 2.112 bundle 內部 `_handleTokenChanged` 已經會喺 TOKEN_REFRESHED／SIGNED_IN
 * 自動 `realtime.setAuth(token)`（實測核實）。但呢個係**私有行為**——將來升級
 * supabase-js 一旦改咗，就會出現提案講嘅事故：「開著超過 1 小時，畫面還顯示已連線，
 * 新單不進來」，而且 **zero error**（channel 照樣 SUBSCRIBED）。
 * 顯式 listener 係保險：realtime-js 對相同 token 嘅 setAuth 係 no-op
 * （`_performAuth` 有 `accessTokenValue != tokenToSend` 檢查），重複呼叫安全。
 *
 * 注意：autoRefresh **只更新 REST**，WebSocket 唔會自己換票 ⇒ 呢一步唔可以省略。
 */
function registerLedgerAuthTokenSync(client: SupabaseClient): void {
  client.auth.onAuthStateChange((event, session) => {
    if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN") return;
    const token = session?.access_token;
    if (!token) return;
    // 永遠唔可以 throw／unhandled rejection（見 lib/pos/realtime-auth.ts 同註解）。
    try {
      void ensureLedgerRealtimeAuth(token).catch(() => {});
    } catch {
      // ignore
    }
  });
}

export function getLedgerSupabaseClient(): SupabaseClient | null {
  const url = resolveLedgerUrl();
  const anonKey = resolveLedgerAnonKey();
  if (!url || !anonKey) return null;

  if (!ledgerClient) {
    ledgerClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    registerLedgerAuthTokenSync(ledgerClient);
  }

  return ledgerClient;
}

export async function ensureLedgerRealtimeAuth(accessToken: string | undefined): Promise<boolean> {
  const client = getLedgerSupabaseClient();
  if (!client || !accessToken) return false;
  await client.realtime.setAuth(accessToken);
  return true;
}
