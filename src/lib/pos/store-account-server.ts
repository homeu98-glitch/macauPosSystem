import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * `pos_store_accounts`（migration 0074）—— 「8 位店舖帳號 → store_id」對照。
 *
 * ## 為何要自己維護（docs/160 §11）
 *
 * 新登入流程第 2 步要用「帳號」列出可用身份（店主＋店員）。但未登入時：
 *   · Ledger 契約明文冇 `check_phone` 類 RPC，亦禁止打 Ledger Web 登入頁；
 *   · POS 全部表都以 `store_id` 為主鍵，冇反查。
 * ⇒ 店主第一次成功登入時寫一筆，之後任何人用同一個帳號都查得到。
 *
 * ## 鐵律
 *
 * ① **寫入永遠唔可以令登入失敗**（同 `registerPosSession` / 存在上報同一手法）。
 * ② **讀取只經 server route**：呢張表間接暴露店員姓名，唔可以俾 anon 直讀
 *    （RLS service_role only + route 層 IP 限流）。
 * ③ 表未建 = 可預期狀態，回 `null`，client 落返傳統登入。
 */

const TABLE = "pos_store_accounts";

/** 8 位純數字；唔合格回空字串。 */
export function normalizeStoreAccount(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return /^\d{8}$/.test(digits) ? digits : "";
}

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return /42P01|PGRST205|does not exist|schema cache/i.test(
    `${error.code ?? ""} ${error.message ?? ""}`,
  );
}

/** 店主登入成功時呼叫。**永遠唔會 throw**（唔可以拖死登入）。 */
export async function rememberStoreAccount(input: {
  account: string;
  storeId: string;
  storeName?: string | null;
}): Promise<void> {
  const account = normalizeStoreAccount(input.account);
  const storeId = String(input.storeId ?? "").trim();
  if (!account || !storeId) return;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return;

  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE).upsert(
    {
      account,
      store_id: storeId,
      store_name: input.storeName ? String(input.storeName).slice(0, 120) : null,
      updated_at: now,
    },
    { onConflict: "account" },
  );

  if (error) {
    // 未跑 0074 係最常見原因 —— 只 log，唔影響登入
    console.warn("[store-account] 寫入帳號對照失敗（可忽略）:", error.message);
  }
}

export type ResolvedStoreAccount = { storeId: string; storeName: string };

export async function resolveStoreAccount(account: string): Promise<ResolvedStoreAccount | null> {
  const normalized = normalizeStoreAccount(account);
  if (!normalized) return null;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE)
    .select("store_id, store_name")
    .eq("account", normalized)
    .limit(1);

  if (error) {
    if (!isMissingTable(error)) {
      console.warn("[store-account] 讀取帳號對照失敗:", error.message);
    }
    return null;
  }

  const row = data?.[0] as { store_id?: string; store_name?: string } | undefined;
  if (!row?.store_id) return null;
  return { storeId: String(row.store_id), storeName: String(row.store_name ?? "") };
}
