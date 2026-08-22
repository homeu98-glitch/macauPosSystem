"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;
let resolved = false;

/**
 * 收銀 / Kiosk 共用嘅 POS 項目瀏覽器端 Supabase client。
 *
 * ⚠️ 更正（2026-08-22）：`pos_*` 資料表（pos_orders / pos_print_jobs / pos_soldout /
 * pos_queue_events / pos_bootstrap_config / pos_device_configs）全部屬 **macau-pos 自己嘅
 * Supabase 項目**，由本 repo 嘅 `supabase/migrations` 建立（0010 建 pos_soldout、0011 建其餘），
 * **唔係** Ledger 嗰邊。frontend 直接 reuse `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
 * 連接呢個 macau-pos 項目做 Realtime 訂閱。
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
