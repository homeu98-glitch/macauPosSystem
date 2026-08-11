"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let ledgerClient: SupabaseClient | null = null;

function resolveLedgerUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
}

function resolveLedgerAnonKey(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null;
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
  }

  return ledgerClient;
}

export async function ensureLedgerRealtimeAuth(accessToken: string | undefined): Promise<boolean> {
  const client = getLedgerSupabaseClient();
  if (!client || !accessToken) return false;
  await client.realtime.setAuth(accessToken);
  return true;
}
