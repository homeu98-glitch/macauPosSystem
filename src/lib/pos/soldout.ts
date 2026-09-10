"use client";

import { getPosSupabaseClient } from "@/lib/pos/supabase-client";

/**
 * 售罄初始快照（2026-09-10 掃碼點餐審查 P1-2）。
 *
 * 舊實作只用 Realtime 監聽 `pos_soldout` 嘅**變更事件** —— Realtime 係增量，
 * 客人掃碼嗰一刻已經售罄嘅菜，只要之後冇人再 toggle，就永遠唔會推送 →
 * 客人照樣可以落單要一個冇貨嘅菜。
 *
 * `pos_soldout` 本身有 anon select policy（0010 / 0011 migration），
 * 所以客人手機可以直接用 anon client 拉初始集合，唔使新增 API route。
 *
 * ⚠️ 2026-09-10 實測（掃碼加單事故排查）：生產環境查唔到 `public.pos_soldout`
 * （PGRST205），而且全 repo **冇任何地方寫入呢張表** —— POS 嘅沽清係本機
 * localStorage（`pos-soldout-changed` 事件）+ `/api/inventory/soldout`（TODO stub）。
 * 即係客人端嘅「售罄」目前**架構上未接通**：呢個函式永遠回 `null`，UI 亦永遠
 * 唔會灰化售罄菜。函式本身（含下面嘅 warn log）保留，等店級售罄來源上雲後即時生效。
 *
 * @returns Set of sold-out menuItemId；查詢失敗回 `null`（呼叫端應該保留現狀，
 *          唔好當「全部有貨」，亦唔好當「全部售罄」）。
 */
export async function fetchStoreSoldoutIds(storeId: string): Promise<Set<string> | null> {
  if (!storeId) return null;
  const supabase = getPosSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("pos_soldout")
      .select("menu_item_id, sold_out")
      .eq("store_id", storeId);
    if (error || !Array.isArray(data)) {
      // 大聲記錄：以前靜默回 null，令人以為「呢間店冇嘢售罄」而唔知道表根本查唔到。
      console.warn("[soldout] 讀取店級售罄失敗（客人端將唔會灰化售罄菜）:", error?.message ?? "回應格式唔對");
      return null;
    }

    const ids = new Set<string>();
    for (const row of data as Array<{ menu_item_id?: string; sold_out?: boolean }>) {
      if (row?.menu_item_id && row.sold_out) ids.add(row.menu_item_id);
    }
    return ids;
  } catch {
    return null;
  }
}
