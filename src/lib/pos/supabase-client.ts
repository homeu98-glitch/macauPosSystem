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
    /**
     * 🆕 2026-09-23（per-store token 第 2 階段）：由
     * `{ persistSession: false, autoRefreshToken: false }` 改為**開**。
     *
     * 為何要開：Realtime 嘅 RLS 需要一個帶 `app_metadata.store_id` 嘅 JWT
     * （Supabase 已用非對稱簽名金鑰，私鑰取唔出 ⇒ 唔可以自簽，只能用
     * `signInAnonymously()` 由 Supabase Auth 簽）。而匿名 session：
     *   · `persistSession: false` ⇒ **每次重新載入都建立一個新匿名用戶**
     *     （用戶表爆炸 + 每次都要重新綁店）；
     *   · `autoRefreshToken: false` ⇒ **1 小時後 token 過期，冇人續**
     *     ⇒ Realtime 嘅 RLS 開始全拒，但 channel 照樣 `SUBSCRIBED`、**零 error**
     *     ——即 docs/113「靜默失效」同一型（列印失去即時喚醒、訂單唔再自動彈出）。
     *
     * 🔴 對「未登入嘅匿名端」（掃碼 `/menu`、Kiosk `/order`）**行為完全不變**：
     *    佢哋冇 POS 終端憑證 ⇒ `ensureRealtimeAuth()` 唔會登入
     *    ⇒ client 冇 session ⇒ PostgREST 照用 anon key ⇒ 同今日一樣。
     *    （`pos_soldout` 亦因此仍然行 anon 政策；登入後嘅終端則由 0053 政策覆蓋。）
     *
     * `storageKey` 明寫，避免同其他 Supabase client（Ledger 專案）爭同一個 key。
     */
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "macaupos-realtime-auth",
    },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return cached;
}
