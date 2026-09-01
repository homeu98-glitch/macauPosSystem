"use client";

import { loadAuthSession } from "@/lib/storage";

/**
 * 收據「電話：」一欄嘅單一解析真源（docs/90 §2）。
 *
 * 解析順序：
 *   1. `bootstrap.storeTel` —— 商家日後喺後台自己填嘅門店電話（最準，優先）。
 *      而家 `pos_stores` 未加 `tel` 欄，正常情況係 undefined。
 *   2. **商家登入號碼** `AuthSession.account` —— 即收銀／店主登入 POS 用嘅號碼
 *      （例如 `60000000` / `63936541`）。收銀機「邊個號碼開嘅舖」就印邊個，
 *      唔使額外維護一欄設定，亦唔會出現萬用假號碼。
 *   3. 都冇 → undefined，`buildReceiptContent` 會自動收起 `store_tel` 區段。
 *
 * ⚠️ 唔好喺 `mock-data.ts` 度俾 `storeTel` 一個假值（例如 `(853) 2888-0000`）：
 *    mock bootstrap 係 fallback，一旦有值就會永遠壓住上面第 2 項，
 *    結果所有舖都印同一個假電話。
 */
export function resolveStoreTel(bootstrapTel?: string | null): string | undefined {
  const configured = typeof bootstrapTel === "string" ? bootstrapTel.trim() : "";
  if (configured) return configured;

  const loginAccount = loadAuthSession()?.account?.trim();
  return loginAccount || undefined;
}
