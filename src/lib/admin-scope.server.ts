import "server-only";

import {
  dedupeStoreIds,
  isMissingColumnError,
  isPlatformPermissions,
  isUuidLike,
  resolveBindingMerchantIds,
  scopedScope,
  type AdminScope,
  type StoreBindingLike,
} from "@/lib/admin-scope-core";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * Admin scope 解析（2026-10-21 · 多店控制台 P1）。
 *
 * ## 設計：scope **唔寫入 token**
 *
 * token 維持 `{account, role, exp}`（stateless）。若把 `storeIds` 塞入 token，
 * 改權限就要等 12 小時 token 過期才生效；對「對外派帳號」嚟講唔可以接受
 * （撤權 = 要即刻生效）。所以每次 request 由 DB 解析，加一個**短 TTL cache**。
 *
 * ## 為何 TTL 係 10 秒而唔係 30 秒
 *
 * admin 頁一開就同時打幾支 API（報表分頁可能十幾次），逐次查 3 條 SQL 會浪費 egress；
 * 但 cache 太長會令「停用帳號」延遲生效。10 秒係折衷：頁面內大量請求共享，
 * 撤權最多遲 10 秒。**寫入路徑（P2 改 binding／停用帳號）要主動 `clearAdminScopeCache()`**。
 *
 * ## 為何要先查 `active`
 *
 * 停用帳號唔止 login 要拒，**已經簽發嘅 token 亦要即刻失效**（token 冇狀態、冇得撤銷）。
 * 所以 scope 解析順便驗 active：`!row.active` → `not_found`（401）。
 *
 * ## bindings 的兩種 id
 *
 * `admin_account_store_bindings.store_id` 係 `admin_stores.id`（舊文本 id，例如
 * `macau-store-a`），`merchant_id` 才係 Ledger merchant UUID（＝`pos_orders.store_id`）。
 * migration 0024 之後兩者都有，但**歷史資料可能只有 store_id** ⇒ 用 `admin_stores`
 * 的 `merchant_id` 補。補唔到嘅（未做 mapping）**一律唔加入 scope**（fail closed），
 * 並 warn 一次 —— 寧願睇唔到，都唔可以攞錯 id 去查而回空數。
 */

const CACHE_TTL_MS = 10_000;

type CachedScope = { scope: AdminScope; exp: number };
const cache = new Map<string, CachedScope>();

export type ScopeResult =
  | { ok: true; scope: AdminScope }
  | { ok: false; reason: "unavailable" | "not_found" | "inactive" };

/** 主動清 cache（P2 改 binding／停用帳號後要叫）。 */
export function clearAdminScopeCache(account?: string): void {
  if (!account) {
    cache.clear();
    return;
  }
  cache.delete(account.trim());
}

let warnedUnmappedStore = false;
/** migration 0024 未跑只 warn 一次（每個 process）。 */
let warnedSchemaDegraded = false;

/**
 * 解析某個 admin 帳號嘅可見店舖範圍。
 * @returns `not_found` / `inactive` 都應該回 401；`unavailable`（DB 未配置）回 503。
 */
export async function resolveAdminScope(account: string): Promise<ScopeResult> {
  const key = String(account ?? "").trim();
  if (!key) return { ok: false, reason: "not_found" };

  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return { ok: true, scope: hit.scope };

  const supabase = getSupabaseAdminClient();
  if (!supabase) return { ok: false, reason: "unavailable" };

  const { data: row, error } = await supabase
    .from("admin_account_users")
    .select("id, active, permission_group_id")
    .eq("account", key)
    .maybeSingle();

  if (error) {
    // DB 打嗝 ≠ 冇權限：唔好 cache 錯誤結果，亦唔好當「冇店」。
    console.error("[admin-scope] 讀取 admin_account_users 失敗", error.message);
    return { ok: false, reason: "unavailable" };
  }
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.active) return { ok: false, reason: "inactive" };

  // 權限組（platform 判斷）
  let permissions: unknown = null;
  if (row.permission_group_id) {
    const { data: group } = await supabase
      .from("admin_permission_groups")
      .select("permissions")
      .eq("id", row.permission_group_id)
      .maybeSingle();
    permissions = (group as { permissions?: unknown } | null)?.permissions ?? null;
  }

  if (isPlatformPermissions(permissions)) {
    const scope = { all: true, storeIds: null } as const;
    cache.set(key, { scope, exp: Date.now() + CACHE_TTL_MS });
    return { ok: true, scope };
  }

  // 店舖綁定 → merchant UUID
  //
  // 🔴 兩種 schema 都要行得通（實測 2026-10-21：生產 DB **從未跑 0024**）：
  //   ① 跑咗 0024：bindings / admin_stores 有 `merchant_id`（最準）
  //   ② 未跑：只有 `store_id`。若 `store_id` 本身係 merchant UUID
  //      （= 0025 §5 建議做法：`admin_stores.id` 直接用 Ledger merchant UUID）都解析得到；
  //      舊文本 id（`macau-store-a`）則照樣剔除（fail closed）。
  //    呢個時候**唔可以**報 503 —— 0024 只係「多一個 anchor」，唔係功能前提。
  const bindingsFirst = await supabase
    .from("admin_account_store_bindings")
    .select("store_id, merchant_id")
    .eq("account_id", row.id);

  let bindings: StoreBindingLike[];
  let schemaDegraded = false;

  if (isMissingColumnError(bindingsFirst.error)) {
    schemaDegraded = true;
    const legacy = await supabase
      .from("admin_account_store_bindings")
      .select("store_id")
      .eq("account_id", row.id);
    if (legacy.error) {
      console.error("[admin-scope] 讀取 bindings 失敗", legacy.error.message);
      return { ok: false, reason: "unavailable" };
    }
    bindings = (legacy.data ?? []) as StoreBindingLike[];
  } else if (bindingsFirst.error) {
    console.error("[admin-scope] 讀取 bindings 失敗", bindingsFirst.error.message);
    return { ok: false, reason: "unavailable" };
  } else {
    bindings = (bindingsFirst.data ?? []) as StoreBindingLike[];
  }

  // `admin_stores.merchant_id` 只係「舊 binding 的 store_id → merchant」對照；
  // 缺欄唔影響（①②③ 任何一條成功就夠）。
  const merchantByStoreId = new Map<string, string>();
  const storesFirst = await supabase.from("admin_stores").select("id, merchant_id");
  if (isMissingColumnError(storesFirst.error)) {
    schemaDegraded = true;
    const legacyStores = await supabase.from("admin_stores").select("id");
    for (const s of (legacyStores.data ?? []) as Array<{ id?: string }>) {
      // 冇 merchant_id 欄 ⇒ 只有當 id 本身係 UUID 才有意義（②→③ 同一套判斷）
      if (s.id && isUuidLike(s.id)) merchantByStoreId.set(String(s.id), String(s.id));
    }
  } else if (storesFirst.error) {
    console.warn("[admin-scope] 讀取 admin_stores 失敗（只影響 store_id→merchant 對照）：", storesFirst.error.message);
  } else {
    for (const s of (storesFirst.data ?? []) as Array<{ id?: string; merchant_id?: string | null }>) {
      if (s.id && s.merchant_id) merchantByStoreId.set(String(s.id), String(s.merchant_id));
    }
  }

  if (schemaDegraded && !warnedSchemaDegraded) {
    warnedSchemaDegraded = true;
    console.warn(
      "[admin-scope] migration 0024 未跑（冇 merchant_id 欄）→ 改用 store_id 解析。" +
        "只接受本身係 UUID 嘅 store_id（0025 §5 建議做法）；文本 id 一律剔除。",
    );
  }

  const { ids: resolved, unmapped } = resolveBindingMerchantIds(bindings, merchantByStoreId);

  if (unmapped.length > 0 && !warnedUnmappedStore) {
    warnedUnmappedStore = true;
    console.warn(
      "[admin-scope] ⚠️ 有 bindings 未對應到 Ledger merchant UUID，已從 scope 剔除（fail closed）：",
      unmapped,
      "→ 請喺 admin_stores.merchant_id 補返 mapping（見 migration 0024）。",
    );
  }

  const scope = scopedScope(dedupeStoreIds(resolved));
  cache.set(key, { scope, exp: Date.now() + CACHE_TTL_MS });
  return { ok: true, scope };
}
