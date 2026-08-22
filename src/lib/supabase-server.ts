import "server-only";
import { createClient } from "@supabase/supabase-js";

function resolveSupabaseUrl() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  return url ?? null;
}

function resolveAnonKey() {
  // 只可以用 POS 專案自己嘅 anon key；唔可以 fallback 去 Ledger 嘅 NEXT_PUBLIC key，
  // 否則會靜默連去錯項目（Ledger）用 anon key 寫 pos_*/salon_* 表而無聲失敗。
  // 伺服器端落單必須用 SUPABASE_SERVICE_ROLE_KEY（或 SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY，
  // 三者都係 POS 專案嘅 key，唔係 Ledger 嘅 NEXT_PUBLIC 公開 key）。
  return process.env.SUPABASE_ANON_KEY ?? null;
}

function resolveServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? null;
}

function createSupabaseClient(url: string, key: string) {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * 伺服器端 Supabase client。
 * - 若存在 `SUPABASE_SERVICE_ROLE_KEY`，優先使用（可 bypass RLS）。
 * - 否則退回使用 anon key（會受 RLS 影響）。
 *
 * 注意：此檔案只能在 server 使用（已加 server-only）。
 */
export function getSupabaseServerClient() {
  const url = resolveSupabaseUrl();
  const serviceKey = resolveServiceRoleKey();
  const anonKey = resolveAnonKey();

  const key = serviceKey ?? anonKey;

  if (!url || !key) {
    return null;
  }

  return createSupabaseClient(url, key);
}

/**
 * 只使用 service role key 的管理 client（若你想顯式區分讀/寫可用）。
 */
export function getSupabaseAdminClient() {
  const url = resolveSupabaseUrl();
  const key = resolveServiceRoleKey();
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}
