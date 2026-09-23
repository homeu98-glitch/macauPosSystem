import "server-only";

import {
  RELEASE_STORAGE_BUCKET,
  type ReleasePlatform,
} from "@/lib/release/release-core";
import { mapReleaseVersionRows, pickActiveReleases, type ActiveReleaseMap } from "@/lib/release/release-row";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * 《版本控制》伺服器端共用邏輯（2026-09-23）。
 *
 * 公開 route（`/api/release/versions/active`）同管理 route
 * （`/api/admin/release-versions`）都要：同一份 select 欄位、同一種
 * 「表未建」判斷、同一種 base URL 解析。收喺呢度一份，避免兩邊走樣。
 *
 * ⚠️ `server-only`：呢個檔讀 `process.env`，**唔可以**被 client component import。
 *    想要型別／純邏輯請用 `@/lib/release/release-core` 同 `@/lib/release/release-row`
 *    （兩者都零依賴、可喺 `node --test` 直接跑）。
 */

/** 表名（migration 0050）。集中一處，方便核對。 */
export const RELEASE_VERSIONS_TABLE = "pos_release_versions";

/** 原子切換 active 嘅 RPC（先落閘、後上位，一個 transaction）。 */
export const ACTIVATE_RELEASE_RPC = "pos_activate_release_version";

/** 查詢欄位。**一定要列出嚟**而唔用 `*`：少一個欄位就係靜默漏資料。 */
export const RELEASE_VERSION_COLUMNS =
  "id, platform, version, file_path, download_url, file_size, notes, is_active, created_at, updated_at";

/**
 * 解析 Storage 公開下載連結嘅 base URL。
 *
 * ## 🔴 唔可以 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`
 *
 * 本專案有兩個 Supabase 專案（見 `.env.example`）：
 *
 * | 變數 | 實際指向 |
 * |---|---|
 * | `SUPABASE_URL` | **POS 專案**（`iyrywzormzisyppkokbi`）—— `pos_*` 表、`macauposapk` bucket 都喺呢度 |
 * | `NEXT_PUBLIC_SUPABASE_URL` | **Ledger 專案** —— 冇任何 `pos_*` 表、亦冇 `macauposapk` |
 *
 * 2026-09-10 已因「兩邊指唔同專案」出過一次 P0（Realtime 靜默失效，見
 * `src/lib/pos/supabase-client.ts` 檔頭）。呢度係同一類陷阱：若 fallback 去
 * `NEXT_PUBLIC_SUPABASE_URL`，登入頁派嘅連結會指向 **Ledger 專案嘅 Storage**
 * ⇒ 一定 404，而 `<a href>` 404 只係一個瀏覽器錯誤頁，任何 log 都唔會見到。
 * ⇒ 寧願返 `null`（登入頁索性唔顯示按鈕），都唔好派一條錯專案嘅連結。
 *
 * ## 優先次序
 *
 * 1. `RELEASE_DOWNLOAD_BASE_URL` —— 明確覆蓋（將來上 CDN／自訂網域）
 * 2. `SUPABASE_URL` —— POS 專案（正常情況）
 * 3. `NEXT_PUBLIC_POS_SUPABASE_URL` —— 同一個 POS 專案嘅公開變體
 */
export function resolveReleaseStorageBaseUrl(): string | null {
  const candidates = [
    process.env.RELEASE_DOWNLOAD_BASE_URL,
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_POS_SUPABASE_URL,
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return null;
}

/** 由 base URL 砌 Storage 公開前綴（登入頁／admin 頁顯示用）。 */
export function releaseStoragePrefix(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  return `${baseUrl}/storage/v1/object/public/${RELEASE_STORAGE_BUCKET}/`;
}

/** Postgres／PostgREST 錯誤嘅最小形狀。 */
type SupabaseErrorLike = { code?: string | null; message?: string | null } | null | undefined;

/**
 * 判定「表未建」（migration 0050 未跑）。
 *
 * 42P01 = undefined_table（Postgres 直連）
 * PGRST205 = PostgREST 搵唔到表
 * 42P13 / PGRST202 = function 唔存在（RPC 未建）
 */
export function isReleaseTableMissing(error: SupabaseErrorLike): boolean {
  if (!error) return false;
  const haystack = `${error.code ?? ""} ${error.message ?? ""}`;
  return /42P01|PGRST205|does not exist|schema cache/i.test(haystack);
}

/** 判定「RPC 未建」（migration 0050 只跑咗一半：表有、function 冇）。 */
export function isReleaseRpcMissing(error: SupabaseErrorLike): boolean {
  if (!error) return false;
  const haystack = `${error.code ?? ""} ${error.message ?? ""}`;
  return /42883|PGRST202|42P13|function .* does not exist|could not find the function/i.test(haystack);
}

/** migration 未跑時對外嘅統一講法（前端直接顯示）。 */
export const RELEASE_MIGRATION_HINT =
  "未跑 migration 0050（pos_release_versions 未建立）→ 版本控制尚未啟用。請喺 POS 專案 SQL Editor 貼 supabase/migrations/0050_pos_release_versions.sql。";

/** 「讀 active 版本」結果。 */
export type ActiveReleasesResult = {
  /** `false` ＝ 未配置 / 未跑 migration ⇒ 前端當「功能未啟用」，唔好當錯。 */
  available: boolean;
  reason?: string;
  releases: ActiveReleaseMap;
  /**
   * Storage 公開前綴（`…/object/public/macauposapk/`），admin 頁提示用。
   * `null` ＝ 砌唔到（環境未配置）。
   */
  storagePrefix: string | null;
};

const EMPTY_RELEASES: ActiveReleaseMap = { android: null, desktop: null };

/**
 * 讀目前兩個平台嘅 active 版本（**只讀 active**，一次過濾，唔會拉全部版本）。
 *
 * ⚠️ 用 `getSupabaseAdminClient()`（**只認 service role**）而唔係
 *    `getSupabaseServerClient()`（冇 service key 就退 anon）：
 *    `pos_release_versions` 已經 revoke 咗 anon 權限 ⇒ 用 anon key 查係**靜默回空陣列**，
 *    前端會永遠見唔到按鈕，而 log 一條都冇。用 admin client 缺 key 時至少返得明明白白。
 */
export async function loadActiveReleases(): Promise<ActiveReleasesResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return {
      available: false,
      reason: "未配置 SUPABASE_SERVICE_ROLE_KEY（Supabase 管理憑證）→ 讀唔到版本資料。",
      releases: EMPTY_RELEASES,
      storagePrefix: null,
    };
  }

  const baseUrl = resolveReleaseStorageBaseUrl();
  const { data, error } = await supabase
    .from(RELEASE_VERSIONS_TABLE)
    .select(RELEASE_VERSION_COLUMNS)
    .eq("is_active", true);

  if (error) {
    if (isReleaseTableMissing(error)) {
      return {
        available: false,
        reason: RELEASE_MIGRATION_HINT,
        releases: EMPTY_RELEASES,
        storagePrefix: releaseStoragePrefix(baseUrl),
      };
    }
    console.error("[release] 讀 active 版本失敗:", error.message);
    return {
      available: false,
      reason: "讀取版本資料失敗。",
      releases: EMPTY_RELEASES,
      storagePrefix: releaseStoragePrefix(baseUrl),
    };
  }

  const dtos = mapReleaseVersionRows(data, { supabaseBaseUrl: baseUrl });
  return {
    available: true,
    releases: pickActiveReleases(dtos),
    storagePrefix: releaseStoragePrefix(baseUrl),
  };
}

/** 平台 → 對外 DTO（`downloadUrl` 為 `null` 時呼叫方唔應該顯示按鈕）。 */
export type { ActiveReleaseMap, ReleasePlatform };
