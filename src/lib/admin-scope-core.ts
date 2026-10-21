/**
 * Admin「店舖範圍（scope）」純邏輯（2026-10-21 · 多店控制台 P1）。
 *
 * ## 為何要有呢個模組
 *
 * 之前 admin panel 只有「有冇 token」二分法：任何一張 admin token 都等於全平台通行證
 * （可以停用其他商家、改其他店模組、讀全部店訂單）。P1 要補嘅係「呢個帳號管邊幾間店」。
 *
 * 呢個檔**刻意唔 import `server-only`**：入面全部係純函數，`node --test` 要直接載入
 * （有 `server-only` 嘅模組喺 node 環境 import 會拋錯，專案慣例係拆 core / server 兩層，
 * 同 `pos/orders-range-shared.ts` 一樣）。
 *
 * ## 三條不變量
 *
 * 1. **`storeIds: []` 唔等於「全部」** —— 空 scope = 乜都睇唔到（fail closed）。
 *    呢個係全個設計最容易寫錯嘅一點：一旦寫成 `ids.length ? filter : noFilter`，
 *    就會喺「帳號停用／未綁店」時變成「睇晒全平台」。
 * 2. **唔帶店參數唔等於「全部」** —— 只有 `all: true` 才可以用 null（無過濾）。
 * 3. **請求指定嘅店必須 ∈ scope**，否則 403（唔可以靜靜降級做「睇自己店」，
 *    因為前端會以為自己睇緊 B 店，實際數字係 A 店 —— 比報錯更危險）。
 */

export type AdminScope =
  | { all: true; storeIds: null }
  | { all: false; storeIds: string[] };

/** D5 拍板：一個 owner 最多綁 20 間店。 */
export const MAX_SCOPE_STORES = 20;

/**
 * 係咪平台級（可以跨全部店）。
 *
 * `scopeAllStores` 係 P1 新增嘅明確 flag；`manageAccounts` 係**過渡推導**
 * ——現時所有可以登入 `/admin` 嘅帳號都一定有 `manageAccounts`（見 `/api/admin/session`
 * 的閘），所以沿用佢做 fallback 唔會洩漏權限。P2 引入 owner 帳號時，
 * owner **唔會有** `manageAccounts`，亦唔會被誤判為平台級。
 */
export function isPlatformPermissions(permissions: unknown): boolean {
  if (!permissions || typeof permissions !== "object") return false;
  const p = permissions as Record<string, unknown>;
  return p.scopeAllStores === true || p.manageAccounts === true;
}

/** 去重 + 去空字串（bindings 可能同時有 merchant_id 同 store_id 兩條）。 */
export function dedupeStoreIds(ids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 建 platform scope（全部店）。 */
export function platformScope(): AdminScope {
  return { all: true, storeIds: null };
}

/** 建限定 scope（空陣列 = 乜都睇唔到）。 */
export function scopedScope(storeIds: string[]): AdminScope {
  return { all: false, storeIds: dedupeStoreIds(storeIds) };
}

export type StoreFilterResult =
  | { ok: true; storeIds: string[] | null }
  | { ok: false; reason: "out-of-scope" };

/**
 * 由「scope + 請求指定嘅店」算出實際 SQL 過濾條件。
 *
 * @param requested 請求帶嘅 `storeId` / `merchantId`（冇帶 = null）
 * @returns `storeIds: null` = 唔加 store 過濾（**只可能**出現喺 `all: true`）；
 *          `storeIds: []` = 一定冇結果（呼叫端應該直接回空，唔好打 DB）。
 */
export function storeFilterFor(scope: AdminScope, requested: string | null | undefined): StoreFilterResult {
  const want = String(requested ?? "").trim() || null;

  if (want) {
    if (scope.all) return { ok: true, storeIds: [want] };
    if (scope.storeIds.includes(want)) return { ok: true, storeIds: [want] };
    // 明確越權：唔可以降級，否則前端以為睇 B 店、實際係 A 店數字。
    return { ok: false, reason: "out-of-scope" };
  }

  if (scope.all) return { ok: true, storeIds: null };
  return { ok: true, storeIds: [...scope.storeIds] };
}

/** 某個 storeId 係咪喺 scope 內（單筆檢查，用於寫入前驗證）。 */
export function scopeAllows(scope: AdminScope, storeId: string): boolean {
  if (scope.all) return true;
  return scope.storeIds.includes(String(storeId ?? "").trim());
}

/** 顯示用摘要（`/api/admin/me` 回傳）。 */
export function scopeSummary(scope: AdminScope): { all: boolean; storeIds: string[] } {
  return { all: scope.all, storeIds: scope.all ? [] : [...scope.storeIds] };
}

/**
 * 係咪「欄位唔存在」（Postgres 42703）。
 *
 * 用途：`merchant_id` 係 migration 0024 先加嘅欄。生產 DB 未跑 0024 時，
 * 查詢會回 42703 —— 呢個要**明確分辨**出嚟（503 + 指明 migration），
 * 唔可以當成「冇資料」，否則用戶只會見到一片空白而無從排查。
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (String(e.code ?? "") === "42703") return true;
  return typeof e.message === "string" && /column .* does not exist/i.test(e.message);
}
