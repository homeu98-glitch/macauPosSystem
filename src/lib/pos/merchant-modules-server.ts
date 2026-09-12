import "server-only";

import {
  defaultMerchantGrants,
  normalizeMerchantGrants,
  type MerchantModuleGrants,
} from "@/lib/pos/module-catalog";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

/**
 * 商戶模組授權嘅 server 端讀寫（表：`pos_merchant_modules`，見 migration 0037）。
 *
 * ## 🔴 核心不變量：讀取失敗 = **全部開通**，唔係「全部閂」
 *
 * 呢個係整個功能最危險嘅一個位。直覺會覺得「讀唔到 = 冇授權 = 唔畀入」比較安全，
 * 但實際後果係：
 *
 *   未跑 migration / service key 未配 / DB 打嗝 → 全部門店登入完之後
 *   「選擇工作台」一頁空白 → 冇人入得返 POS → **全線停業**。
 *
 * 而另一邊（當成全開）嘅最壞後果只係「暫時見到多咗幾個模組」，
 * 而且 POS 本身每個模組都仲有自己嘅權限檢查把關。兩害相權，取「全開」。
 *
 * 呢個決定同時令 rollout 變得安全：migration 上線一刻所有商戶都未有行，
 * 全部自動維持現狀；Admin 喺後台逐个店收緊，收到邊間就邊間生效。
 */
export type SaveGrantsResult = { ok: true } | { ok: false; error: string };

/** 讀單店授權。冇記錄 / 讀取失敗 → 全部開通（見上方不變量）。 */
export async function loadMerchantGrants(storeId: string): Promise<MerchantModuleGrants> {
  if (!storeId) return defaultMerchantGrants();

  const supabase = getSupabaseAdminClient();
  if (!supabase) return defaultMerchantGrants();

  const { data, error } = await supabase
    .from("pos_merchant_modules")
    .select("workbenches, sidebar_modules")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(
        `[merchant-modules] 讀取 store=${storeId} 授權失敗，暫時當「全部開通」：${error.message}`,
      );
    }
    return defaultMerchantGrants();
  }

  return normalizeMerchantGrants({
    workbenches: data.workbenches,
    sidebarModules: data.sidebar_modules,
  });
}

/**
 * 批次讀多店授權（Admin 商家列表用，避免 N+1）。
 *
 * 回傳嘅 Map **只包含 DB 有行嘅店**；呼叫方見到某店唔喺 Map 入面，
 * 就代表「未有記錄 = 全部開通」，唔好自己補一個空陣列。
 */
export async function loadMerchantGrantsMap(
  storeIds: string[],
): Promise<Map<string, MerchantModuleGrants>> {
  const map = new Map<string, MerchantModuleGrants>();
  const ids = [...new Set(storeIds.filter(Boolean))];
  if (ids.length === 0) return map;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return map;

  const { data, error } = await supabase
    .from("pos_merchant_modules")
    .select("store_id, workbenches, sidebar_modules")
    .in("store_id", ids);

  if (error || !data) {
    if (error) {
      console.error(`[merchant-modules] 批次讀取授權失敗，全部當「已開通」：${error.message}`);
    }
    return map;
  }

  for (const row of data as Array<{
    store_id: string;
    workbenches: unknown;
    sidebar_modules: unknown;
  }>) {
    map.set(
      row.store_id,
      normalizeMerchantGrants({
        workbenches: row.workbenches,
        sidebarModules: row.sidebar_modules,
      }),
    );
  }

  return map;
}

/**
 * 儲存單店授權（Admin 後台）。
 *
 * ⚠️ 一次性寫入**兩組**欄位：就算今次只改咗工作台，側欄模組都會用前端傳嚟嘅值覆寫。
 * 呼叫方（Admin UI）一定要送完整授權物件，唔可以只送改咗嗰組 ——
 * 否則會靜靜把另一組清空。
 */
export async function saveMerchantGrants(
  storeId: string,
  grants: unknown,
): Promise<SaveGrantsResult> {
  if (!storeId) return { ok: false, error: "缺少 storeId。" };

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { ok: false, error: "未配置資料庫（缺少 service-role key），無法儲存模組授權。" };
  }

  const normalized = normalizeMerchantGrants(grants);

  const { error } = await supabase.from("pos_merchant_modules").upsert(
    {
      store_id: storeId,
      workbenches: normalized.workbenches,
      sidebar_modules: normalized.sidebarModules,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
