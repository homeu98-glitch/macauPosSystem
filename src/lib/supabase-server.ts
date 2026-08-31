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

/**
 * 【寫入專用 client · 2026-08-31 資安加固，見 docs/89 §2】
 *
 * 與 `getSupabaseServerClient()` 嘅差別：**永遠唔會 fallback 去 anon key**。
 *
 * 點解要分開：
 *   `NEXT_PUBLIC_SUPABASE_ANON_KEY` 係編譯入瀏覽器 bundle 嘅公開值，任何人開 devtools
 *   就拎到。0016 migration 已經將所有業務表收做 service_role-only（RLS + revoke）。
 *   如果寫入路徑仲留住「冇 service key 就退回 anon」嘅 fallback，會出現兩種爛結果：
 *     1. 已加固嘅環境 → 寫入靜默失敗（RLS 擋），資料遺失但前端以為成功；
 *     2. 未加固嘅環境 → 用一把公開 key 寫入，等於任何人都可以偽造落單。
 *   所以寫入一律顯式要求 service key，缺就返 null，等 route 自己出清晰 503。
 *
 * 用法：所有做 upsert / update / delete / rpc(寫) 嘅 API route 都改用呢個。
 */
export function getSupabaseWriteClient() {
  return getSupabaseAdminClient();
}
