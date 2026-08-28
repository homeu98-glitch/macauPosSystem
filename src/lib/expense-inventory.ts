import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/** 收據寫入 API 共用輸入型別。 */
export type InventoryReceiptInput = {
  account?: string;
  merchant_name?: string;
  merchant_id?: string;
  receipt_number?: string;
  category?: string;
  payment_method?: string;
  payment_status?: string;
  date?: string;
  total_amount?: number;
  items?: Array<{ name?: string; unit_price?: number; quantity?: number }>;
};

export type ResolvedUser = { userId: string } | { error: string; status: number };

/**
 * account(8位) → shop_users.login_id → shop_users.id（與唯讀 route 相同關聯）。
 * 所有寫入都須先解析出 user_id 做店別 scope。
 */
export async function resolveExpenseUserId(client: SupabaseClient, account: string | null): Promise<ResolvedUser> {
  if (!account) return { error: "缺少 account", status: 400 };
  const { data, error } = await client
    .from("shop_users")
    .select("id")
    .eq("login_id", account)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!data) return { error: "expenseRecorder 找不到相同帳號的店戶", status: 404 };
  return { userId: data.id };
}

/**
 * 取得或建立供應商（mirror expenseRecorder save-receipt）：upsert merchants(name, user_id) onConflict user_id,name。
 * 提供 merchant_id 時直接回傳（不查名）。
 */
export async function resolveMerchantId(
  client: SupabaseClient,
  userId: string,
  opts: { merchant_id?: string; merchant_name?: string },
): Promise<{ merchantId: string } | { error: string; status: number }> {
  if (opts.merchant_id) return { merchantId: opts.merchant_id };
  if (!opts.merchant_name) return { error: "缺少 merchant_name 或 merchant_id", status: 400 };
  const { data, error } = await client
    .from("merchants")
    .upsert({ name: opts.merchant_name, user_id: userId }, { onConflict: "user_id, name" })
    .select("id")
    .single();
  if (error) return { error: error.message, status: 500 };
  return { merchantId: data.id };
}

/** 由收據輸入組出 receipt_items 批次（mirror save-receipt 的欄位）。 */
export function buildReceiptItems(receiptId: string, userId: string, items: InventoryReceiptInput["items"]) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      receipt_id: receiptId,
      user_id: userId,
      name: String(it.name ?? ""),
      unit_price: Number(it.unit_price) || 0,
      quantity: Number(it.quantity) || 1,
    }))
    .filter((it) => it.name.trim().length > 0);
}
