"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;
let resolved = false;

/**
 * 收銀 / Kiosk 共用嘅 POS 項目瀏覽器端 Supabase client。
 * 與 Ledger 共用同一個 Supabase 項目（`pos_*` 資料表同位於此項目），
 * 故直接 reuse `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`。
 *
 * 只用作 Realtime 訂閱（postgres_changes），絕不經此寫入訂單——
 * 落單一律行 `/api/pos/sync`（server 用 service role 寫入）。
 */
export function getPosSupabaseClient(): SupabaseClient | null {
  if (resolved) return cached;
  resolved = true;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    cached = null;
    return null;
  }

  cached = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return cached;
}
