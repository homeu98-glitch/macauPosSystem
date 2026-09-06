import "server-only";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Ledger DB 嘅 service-role client（admin panel 專用，server-only）。
 *
 * 【點解需要】
 * POS 同 Ledger 係兩個唔同嘅 Supabase project：
 * - POS DB（`SUPABASE_SERVICE_ROLE_KEY`）→ pos_orders / pos_queue_events 等
 * - Ledger DB（本檔案）→ merchants / merchant_staff 等
 *
 * 之前 codebase 只有 Ledger anon client（`getLedgerSupabaseClient`，受 RLS 限制，
 * 且所有商務 RPC 都要求 merchant JWT 上下文）。admin panel 要：
 * 1. 讀全體商家列表（`select id, name, status from merchants`）
 * 2. 寫 `merchants.status`（啟用 / 停用整個商家——`/api/ledger/login` 已內置
 *    suspended 檢查，停用後該店全部賬號都無法登入 POS）
 * 呢兩個操作都要 service-role。key 由環境變數 `LEDGER_SERVICE_ROLE_KEY` 提供
 * （Vercel 手動配置；URL 沿用 `NEXT_PUBLIC_SUPABASE_URL`，因為 Ledger 就係
 * POS 登入嗰個 project）。
 *
 * 【安全】key 只存 server 環境變數，絕不落 client bundle。所有用呢個 client
 * 嘅 route 都必須先過 `readAdminSessionFromRequest` admin token 把關。
 */

function resolveLedgerServiceKey(): string | null {
  const dedicated = process.env.LEDGER_SERVICE_ROLE_KEY?.trim();
  if (dedicated) return dedicated;
  // 別名容錯：万一用呢個名配置都認得。
  return process.env.LEDGER_SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

let ledgerServiceClient: SupabaseClient | null = null;

/** 冇配置 key 就返 null（呼叫方 fail-closed：唔好靜靜降級做 anon 讀）。 */
export function getLedgerServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = resolveLedgerServiceKey();
  if (!url || !key) return null;

  if (!ledgerServiceClient) {
    ledgerServiceClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return ledgerServiceClient;
}

/** admin API 回應用：Ledger service key 是否已配置（畀前端顯示配置提示）。 */
export function isLedgerServiceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && resolveLedgerServiceKey());
}
