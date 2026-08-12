"use client";

import { loadAuthSession, saveAuthSession, clearAuthSession as clearStoredAuthSession } from "@/lib/storage";

import { getLedgerSupabaseClient } from "@/lib/ledger/supabase-client";

/** Restore Supabase Auth session from POS auth cache after page load. */
export async function restoreLedgerSession(): Promise<boolean> {
  return (await ensureLedgerSession()) !== null;
}

/** Ensure Supabase RPC/Realtime auth is ready; sync refreshed tokens back to storage. */
export async function ensureLedgerSession(): Promise<string | null> {
  const session = loadAuthSession();
  const client = getLedgerSupabaseClient();
  if (!client || !session?.ledgerAccessToken || !session?.ledgerRefreshToken) {
    return null;
  }

  const { error } = await client.auth.setSession({
    access_token: session.ledgerAccessToken,
    refresh_token: session.ledgerRefreshToken,
  });
  if (error) return null;

  const { data } = await client.auth.getSession();
  const active = data.session;
  if (!active?.access_token) return session.ledgerAccessToken;

  if (
    active.access_token !== session.ledgerAccessToken ||
    (active.refresh_token && active.refresh_token !== session.ledgerRefreshToken)
  ) {
    saveAuthSession({
      ...session,
      ledgerAccessToken: active.access_token,
      ledgerRefreshToken: active.refresh_token ?? session.ledgerRefreshToken,
    });
  }

  return active.access_token;
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
      const channels = client.getChannels();
      await Promise.all(channels.map((channel) => client.removeChannel(channel)));
      await client.auth.signOut({ scope: "local" });
    } catch {
      // ignore
    }
  }
  clearStoredAuthSession();
}
