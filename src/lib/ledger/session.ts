"use client";

import { loadAuthSession, clearAuthSession as clearStoredAuthSession } from "@/lib/storage";

import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

/** Restore Supabase Auth session from POS auth cache after page load. */
export async function restoreLedgerSession(): Promise<boolean> {
  const session = loadAuthSession();
  const client = getLedgerSupabaseClient();
  if (!client || !session?.ledgerAccessToken || !session?.ledgerRefreshToken) {
    return false;
  }

  const { error } = await client.auth.setSession({
    access_token: session.ledgerAccessToken,
    refresh_token: session.ledgerRefreshToken,
  });

  return !error;
}

export function getLedgerMerchantId(): string | null {
  return loadAuthSession()?.merchantId ?? null;
}

export function getLedgerAccessToken(): string | null {
  return loadAuthSession()?.ledgerAccessToken ?? null;
}

export async function signOutLedgerSession(): Promise<void> {
  const client = getLedgerSupabaseClient();
  if (client) {
    try {
      await client.auth.signOut();
    } catch {
      // ignore
    }
  }
  clearStoredAuthSession();
}
