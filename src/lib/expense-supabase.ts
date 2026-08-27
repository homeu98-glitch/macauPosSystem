import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * 直連 expenseRecorder 專案（fjvfvpedklhdenavbcjg）的 server-only client。
 *
 * 用途：POS 後端直接讀寫 expenseRecorder 的 receipts / receipt_items / shop_users / inv_* 表，
 *       不經 expenseRecorder 介面。對應整合計劃書 §5（方案 A）。
 *
 * 安全：
 * - 使用 service_role key → bypass RLS。key 只存伺服器環境變數（EXPENSE_SUPABASE_*），
 *   絕不加 NEXT_PUBLIC_ 前綴、絕不下發前端、絕不進 repo。
 * - 所有 inventory 查詢仍須以 merchantId 為 scope（defense in depth）。
 * - 此檔案加 server-only，若被 client component import 會在建置期報錯。
 */
function resolveExpenseUrl() {
  return process.env.EXPENSE_SUPABASE_URL ?? null;
}

function resolveExpenseServiceRoleKey() {
  return process.env.EXPENSE_SUPABASE_SERVICE_ROLE_KEY ?? null;
}

function createExpenseClient(url: string, key: string) {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * 直連 expenseRecorder 專案的 Supabase client（service_role，bypass RLS）。
 * 未設定環境變數時回傳 null（呼叫方應降級處理，例如 inventory 顯示「未連線」）。
 */
export function getExpenseSupabaseClient() {
  const url = resolveExpenseUrl();
  const serviceKey = resolveExpenseServiceRoleKey();
  if (!url || !serviceKey) {
    return null;
  }
  return createExpenseClient(url, serviceKey);
}
