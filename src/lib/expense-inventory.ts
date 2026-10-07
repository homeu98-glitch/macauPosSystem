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
  items?: Array<{ name?: string; unit_price?: number; quantity?: number; quantity_unit?: string }>;
  /**
   * 收據相片路徑（`raw_ocr_data.photo_paths`，存 expenseRecorder Storage）。
   *
   * 🔴 三態語意（同 PATCH 嘅 `!== undefined` 判斷配套）：
   *   - `undefined`  → 唔理相片，保留原有（例如只改金額）
   *   - `[]`         → **商家主動刪光相片**（有效指令，唔可以當「冇提供」）
   *   - `["a.jpg"]`  → 覆蓋成呢個新清單
   */
  photo_paths?: string[];
};

export type ResolvedUser = { userId: string } | { error: string; status: number };

/**
 * 判斷錯誤係唔係「表或欄唔存在」＝ schema 未就緒。
 *
 * - `42P01` = `undefined_table`（relation does not exist）
 * - `42703` = `undefined_column`（column does not exist）
 *
 * 🔴 兩者都要當「降級」而唔係「500」。expenseRecorder 係另一個專案、
 * 另一個部署節奏，POS 唔可以假設對方所有欄位都已經補齊
 * （實例：`receipt_items.user_id` 就唔喺任何一支現存 SQL 檔入面，
 * 係靠人手 ALTER 加嘅）。表未就緒應該顯示「暫無資料」而唔係整頁爆掉。
 */
export function isMissingColumnOrTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  return /relation .* does not exist|column .* does not exist/i.test(err.message ?? "");
}

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
  if (error) {
    // 🔴 2026-09-25：撞 unique（例如 merchants.name 跨店唯一）時，若**本店已經有**
    // 同名供應商，就直接复用（upsert 語義上本來就係「有就唔新建」），唔好成張收據
    // 存唔到。本店冇嗰個名先至算真失敗（唔可以掛起第二間店嘅 merchant）。
    const msg = error.message ?? "";
    const isConflict =
      error.code === "23505" || error.code === "42P10" ||
      /duplicate key/i.test(msg) || /no unique or exclusion constraint/i.test(msg);
    if (isConflict) {
      const { data: mine } = await client
        .from("merchants")
        .select("id")
        .eq("user_id", userId)
        .ilike("name", opts.merchant_name)
        .maybeSingle();
      if (mine?.id) return { merchantId: String(mine.id) };
      const constraint = /constraint "([^"]+)"/.exec(msg)?.[1] ?? "未知約束";
      return {
        error: `供應商「${opts.merchant_name}」與資料庫既有供應商衝突（${constraint}），請改用其他名稱。`,
        status: 409,
      };
    }
    return { error: error.message, status: 500 };
  }
  return { merchantId: data.id };
}

/**
 * 由收據輸入組出 receipt_items 批次（mirror save-receipt 的欄位）。
 *
 * 🔴 2026-10-06：加 `quantity_unit`（kg／包／罐…）。呢欄係 expenseRecorder 側新加嘅，
 *   舊環境可能未有 ⇒ **呼叫方必須自行降級**（偵測 `42703` 後移除該 key 重試），
 *   詳見 `src/app/api/inventory/receipts/route.ts` POST。
 *   ⚠️ 唔可以因為欄位未加就「靜默丟棄單位」——要由呼叫方明確決定降級，
 *      否則工程師會以為寫入成功但其實冇寫到單位。
 */
export function buildReceiptItems(receiptId: string, userId: string, items: InventoryReceiptInput["items"]) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      receipt_id: receiptId,
      user_id: userId,
      name: String(it.name ?? ""),
      unit_price: Number(it.unit_price) || 0,
      quantity: Number(it.quantity) || 1,
      quantity_unit: typeof it.quantity_unit === "string" ? it.quantity_unit.trim() : "",
    }))
    .filter((it) => it.name.trim().length > 0);
}

/**
 * 移除 payload 內嘅 `quantity_unit` 欄 —— 用於偵測到 expenseRecorder 未加該欄時降級重試。
 * 回新陣列，唔改原物件。
 */
export function stripQuantityUnit<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!("quantity_unit" in row)) return row;
    const copy = { ...row };
    delete (copy as Record<string, unknown>).quantity_unit;
    return copy;
  });
}

/**
 * 收據相片路徑清洗（`raw_ocr_data.photo_paths`）。
 *
 * 只保留「安全字串」：非空、去頭尾空白、唔可以係絕對路徑或含路徑穿越。
 * 去重（同一張相被加兩次冇意義，而且會令刪除時多一次無效呼叫）。
 *
 * 🔴 回傳**新陣列**，呼叫方要自己判斷「有冇提供」——
 *    空陣列（`[]`）係合法值，代表「商家主動刪光相片」，
 *    **唔可以**當成 falsy 而略過寫入（否則「刪光」會靜默失效）。
 */
export function sanitizePhotoPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || t.startsWith("/") || t.includes("..")) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
