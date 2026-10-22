/**
 * 庫存帳戶自動開通（2026-10-22 · J 要求）。
 *
 * ## 目的
 * macau-pos 登入成功、而 expenseRecorder 冇該 account 對應嘅 `shop_users` 時，
 * 以**完全相同**嘅 account（8 位電話）＋ PIN，喺 expenseRecorder 開一間 `shop_users`
 * （帳號與 PIN 兩邊互用）。觸發點：`/api/ledger/login` 驗證成功後。
 *
 * ## 🔴 鐵律（J 明確要求，唔可以違反）
 * 1. **只 resolve-or-create，絕不 UPDATE／DELETE**：搵到就 return，唔可以改動／刪除
 *    expenseRecorder 現有戶口（嗰邊入口有人在用，唔可以影響其他功能）。
 * 2. 失敗全部靜默：expenseRecorder 未設定／網絡錯／schema 未就緒 ⇒ 唔可以令 POS 登入失敗。
 * 3. **PIN 直接採用 macau-ledger 嗰個**（loginPin 參數），唔係隨機生成。
 * 4. `external_shop_id = POS merchantId`（啟用 Ledger 買貨報表綁定）；撞 unique
 *    （同一間店多個員工）⇒ 降級唔寫 external_shop_id 再試，唔可以令開戶失敗。
 *
 * ## 測試性
 * 純邏輯 `provisionExpenseShopUser(store, opts)` 經 `ShopUserStore` port 隔離 supabase，
 * `node --test` 用假 store 即可覆蓋（唔使連真實 expenseRecorder）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ShopUserRow = { id: string; external_shop_id: string | null };

/** 假 store 可實作呢個 interface 做單測；真實實作見 `createExpenseShopUserStore`。 */
export type ShopUserStore = {
  /** 依 login_id 搵現有戶口；冇就 null。 */
  selectByLoginId(loginId: string): Promise<ShopUserRow | null>;
  /** 新建一列；撞 unique 拋 `{ code: "23505" }`，缺欄拋 `{ code: "42703" }`。 */
  insert(row: NewShopUser): Promise<{ id: string }>;
};

export type NewShopUser = {
  loginId: string;
  loginPin: string;
  shopName: string;
  externalShopId: string | null;
  authSource: "macau-pos";
};

export type ProvisionResult =
  | { ok: true; userId: string; created: boolean; account: string }
  | { ok: false; status: 400 | 409 | 500; error: string; code?: string };

/** expenseRecorder 註冊頁保留號（見 `app/signup/page.tsx`）。 */
export const RESERVED_LOGIN_ID = "60000000";

export function validateAccountForProvision(
  account: string,
): { ok: true } | { ok: false; error: string } {
  if (!/^\d{8}$/.test(account)) return { ok: false, error: "account 必須為 8 位數字" };
  if (account === RESERVED_LOGIN_ID) return { ok: false, error: "帳號為系統保留，不可開通" };
  return { ok: true };
}

export function validateLoginPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

/**
 * resolve-or-create expenseRecorder `shop_users`。
 *
 * 流程：
 *   ① SELECT by login_id → 搵到 return（created:false，**唔 UPDATE**）
 *   ② INSERT（帶 external_shop_id + auth_source）
 *      · 23505 → 再 SELECT（並發建咗）→ 再試唔寫 external_shop_id
 *      · 42703 → 降級只寫基礎三欄（見 `createExpenseShopUserStore`）
 *   ③ 全部降級都失敗 → 500（caller 靜默放過，唔影響登入）
 */
export async function provisionExpenseShopUser(
  store: ShopUserStore,
  opts: {
    loginId: string;
    loginPin: string;
    shopName: string;
    externalShopId: string | null;
    authSource: "macau-pos";
  },
): Promise<ProvisionResult> {
  const acc = validateAccountForProvision(opts.loginId);
  if (!acc.ok) return { ok: false, status: 400, error: acc.error };
  if (!validateLoginPin(opts.loginPin)) return { ok: false, status: 400, error: "PIN 必須為 4 位數字" };

  const account = opts.loginId;

  // ① 先查：搵到就 return（鐵律 1：絕不 UPDATE 現有 row）
  //
  // 🔴 2026-10-22 修：呢個 select 原本喺 try/catch 外面。若 live 環境缺
  // `external_shop_id` 欄（PostgREST `42703` / `PGRST204`），select 會 throw
  // ⇒ 整個開通靜默失敗（連「已存在」都查唔到）。now：查詢失敗當「未搵到」，
  // 交畀下面 INSERT + 23505 兜底，確保缺欄環境一樣開得到戶。
  let existing: ShopUserRow | null = null;
  try {
    existing = await store.selectByLoginId(account);
  } catch {
    existing = null;
  }
  if (existing) return { ok: true, userId: existing.id, created: false, account };

  const row: NewShopUser = {
    loginId: account,
    loginPin: opts.loginPin,
    shopName: opts.shopName?.trim() || `店號 ${account}`,
    externalShopId: opts.externalShopId,
    authSource: "macau-pos",
  };

  try {
    const created = await store.insert(row);
    return { ok: true, userId: created.id, created: true, account };
  } catch (err) {
    const db = toDbError(err);
    if (db?.code === "23505") {
      // 撞 unique：可能並發建咗，或 external_shop_id 同店撞（多店員）。
      const retry = await store.selectByLoginId(account);
      if (retry) return { ok: true, userId: retry.id, created: false, account };
      // 降級：唔寫 external_shop_id 再試（login_id 仍唯一 → 可以建）
      if (opts.externalShopId) {
        return await insertWithoutExternalShopId(store, account, row);
      }
      return { ok: false, status: 409, error: "庫存帳號建立失敗：帳號衝突", code: "LOGIN_ID_TAKEN" };
    }
    // 其他 DB 錯（例如 adapter 已經處理過 42703）：直接 500，caller 靜默放過
    return { ok: false, status: 500, error: db?.message ?? "庫存帳號建立失敗" };
  }
}

async function insertWithoutExternalShopId(
  store: ShopUserStore,
  account: string,
  row: NewShopUser,
): Promise<ProvisionResult> {
  try {
    const created = await store.insert({ ...row, externalShopId: null });
    return { ok: true, userId: created.id, created: true, account };
  } catch (err) {
    const db = toDbError(err);
    if (db?.code === "23505") {
      const retry = await store.selectByLoginId(account);
      if (retry) return { ok: true, userId: retry.id, created: false, account };
      return { ok: false, status: 409, error: "庫存帳號建立失敗：帳號衝突", code: "LOGIN_ID_TAKEN" };
    }
    return { ok: false, status: 500, error: db?.message ?? "庫存帳號建立失敗" };
  }
}

function toDbError(err: unknown): { code?: string; message?: string } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
}

/**
 * 「欄位不存在」判斷（schema 漂移專用）。
 *
 * 🔴 2026-10-22 修：原本只認 `42703`，但 PostgREST 對 `.insert()` 嘅未知欄多數回
 * **`PGRST204`**（"Could not find the 'x' column of '…' in the schema cache"），
 * 對 `.select()` 有時回 `42703`、有時回 `PGRST204`。只認一種就會令降級分支永不觸發，
 * 開通靜默失敗。呢個 helper 同 `api/inventory/receipts` 嘅 `isMissingColumn()` 同一思路。
 * ⚠️ 唔可以擴大到「任何錯誤」——網絡／權限錯要照 throw，唔可以當缺欄降級。
 */
function isMissingColumnError(err: unknown): boolean {
  const db = toDbError(err);
  if (!db) return false;
  if (db.code === "42703" || db.code === "PGRST204") return true;
  const m = db.message ?? "";
  return /column .* does not exist/i.test(m) || /Could not find the '.*' column|schema cache/i.test(m);
}

/**
 * 真實 supabase 實作（server 端用）。
 *
 * 🔴 schema 漂移降級：live 環境 `external_shop_id` / `auth_source` 係後加欄
 * （`supabase_schema_v2.sql`）。舊環境可能冇呢兩欄 ⇒ 撞 `42703` 時降級只寫
 * 基礎三欄（`login_id` / `login_pin` / `shop_name`），唔可以因為一個可選欄令開戶失敗。
 * `profile_json` / `last_login_at` / `external_owner_id` 一律唔寫（有 default / nullable，
 * 減少 42703 受擊面）。
 */
export function createExpenseShopUserStore(client: SupabaseClient): ShopUserStore {
  return {
    async selectByLoginId(loginId: string) {
      const primary = await client
        .from("shop_users")
        .select("id, external_shop_id")
        .eq("login_id", loginId)
        .maybeSingle();
      if (!primary.error) {
        return primary.data
          ? { id: String(primary.data.id), external_shop_id: (primary.data.external_shop_id as string | null) ?? null }
          : null;
      }
      // 🔴 缺 external_shop_id 欄（舊環境）⇒ 降級只查 id，唔可以令整個開通失敗
      if (!isMissingColumnError(primary.error)) throw primary.error;
      const fallback = await client
        .from("shop_users")
        .select("id")
        .eq("login_id", loginId)
        .maybeSingle();
      if (fallback.error) throw fallback.error;
      return fallback.data ? { id: String(fallback.data.id), external_shop_id: null } : null;
    },

    async insert(row: NewShopUser) {
      const base = { login_id: row.loginId, login_pin: row.loginPin, shop_name: row.shopName };
      const extended = { ...base, external_shop_id: row.externalShopId, auth_source: row.authSource };
      try {
        const { data, error } = await client.from("shop_users").insert(extended).select("id").single();
        if (error) throw error;
        return { id: String(data.id) };
      } catch (err) {
        // 🔴 舊環境缺 external_shop_id / auth_source ⇒ 降級只寫基礎三欄。
        //    用 isMissingColumnError（含 PGRST204），唔可以只認 42703。
        if (isMissingColumnError(err)) {
          const { data: d2, error: e2 } = await client.from("shop_users").insert(base).select("id").single();
          if (e2) throw e2;
          return { id: String(d2.id) };
        }
        throw err;
      }
    },
  };
}
