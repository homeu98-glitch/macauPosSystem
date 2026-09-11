"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

import { resolvePosRealtimeConfig, type PosRealtimeConfig } from "@/lib/pos/realtime-target";

let cached: SupabaseClient | null = null;
let resolved = false;

/**
 * 收銀 / Kiosk 共用嘅 POS 項目瀏覽器端 Supabase client。
 *
 * ⚠️ 更正（2026-08-22）：`pos_*` 資料表（pos_orders / pos_print_jobs / pos_soldout /
 * pos_queue_events / pos_bootstrap_config / pos_device_configs）全部屬 **macau-pos 自己嘅
 * Supabase 項目**，由本 repo 嘅 `supabase/migrations` 建立（0010 建 pos_soldout、0011 建其餘），
 * **唔係** Ledger 嗰邊。
 *
 * ---------------------------------------------------------------------------
 * 🔴 2026-09-10 P0 修正（docs/reviews/qr-self-order-audit-2026-09-10.md 附錄 B.6）
 * ---------------------------------------------------------------------------
 * 【病症】快餐／堂食掃碼落單後，收銀台**冇即時通知、訂單唔自動彈出**；
 *         F5 refresh（行 `/api/pos/state` backfill）就即刻見到。
 *
 * 【根因】env 兩邊指唔同專案：
 *   - server 寫單：`SUPABASE_URL`（= POS 自有專案，見 `src/lib/supabase-server.ts:5`）；
 *   - 瀏覽器 Realtime：`NEXT_PUBLIC_SUPABASE_URL`（= **Ledger** 專案，見 `.env.example` A 段）。
 *   Ledger 專案**冇 pos_orders** → `postgres_changes` 訂咗一張唔存在嘅表 → 永遠唔會有事件，
 *   但 Supabase **唔會報錯**（channel 照樣 SUBSCRIBED）→ 靜默失效，只有 reload 先見到單。
 *
 * 【修法】新增 POS 專用嘅公開變數，優先讀：
 *   - `NEXT_PUBLIC_POS_SUPABASE_URL`
 *   - `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY`
 *   未設時**向後兼容**退回舊嘅 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
 *   （即係未加 env 前行為不變，唔會更差）。
 *   解析／探測邏輯放喺零依賴模組 `@/lib/pos/realtime-target`（可單元測試）。
 *
 * 【安全】POS 專案嘅 anon key 只應該開 `select` + RLS（0016 §3a：pos_orders anon 近 14 日、
 *   0021：pos_print_jobs anon 近 24 小時），**唔可以** grant insert/update/delete。
 *   落單一律行 `/api/pos/sync`（server service_role）。
 * ---------------------------------------------------------------------------
 *
 * 只用作 Realtime 訂閱（postgres_changes），絕不經此寫入訂單。
 */
export function getPosRealtimeConfig(): PosRealtimeConfig | null {
  return resolvePosRealtimeConfig({
    NEXT_PUBLIC_POS_SUPABASE_URL: process.env.NEXT_PUBLIC_POS_SUPABASE_URL,
    NEXT_PUBLIC_POS_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_POS_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export function getPosSupabaseClient(): SupabaseClient | null {
  if (resolved) return cached;
  resolved = true;

  const config = getPosRealtimeConfig();
  if (!config) {
    cached = null;
    return null;
  }

  cached = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return cached;
}
