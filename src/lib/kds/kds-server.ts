import "server-only";

import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { mapPosOrderRow, type PosOrderRow } from "@/lib/pos/pos-order-mapper";
import { orderItemKey } from "@/lib/pos/order-item-diff";
import { KDS_BOARD_MAX_AGE_MS } from "@/lib/kds/kds-board";
import type { KdsBoardOrderInput, KdsItemStateRow } from "@/lib/kds/types";
import type { PosOrder } from "@/lib/types";

/**
 * KDS 三條端點嘅共用伺服器工具（docs/116 §6）。
 *
 * ⚠️ 呢個檔**只可以**喺 server 用（`server-only`）。
 * 純函式邏輯一律放 `kds-board.ts` / `stations.ts`，等佢哋可以 `node --test`。
 */

type SupabaseLike = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

interface PgError {
  code?: string;
  message?: string;
}

/**
 * `pos_kds_item_state` 唔存在（migration 0033 未跑）。
 *
 * 兩種可能：
 *   - `PGRST205`：PostgREST schema cache 搵唔到表
 *   - `42P01`：Postgres undefined_table
 *
 * 呢個要**降級**而唔係 500：code 先上、migration 後跑係正常部署順序，
 * 期間後廚屏應該照出（只係所有 done_qty 當 0），唔可以成個屏白畫面。
 */
export function isMissingKdsTable(error: PgError | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "42P01") return true;
  // PostgREST 有時只係訊息講「Could not find the table」
  return /could not find the table|does not exist/i.test(String(error.message ?? ""));
}

export interface KdsAuthResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * 終端授權（同 `/api/pos/kiosk-settings` POST 完全一致）。
 *
 * ⚠️ 「未經授權：需要 POS 終端憑證。」**唔係**權限問題，係 token 冇帶 / 冇續期。
 * 客戶端要用 `posDeviceAuthHeadersFresh()`（會自動續期），唔好自己讀 localStorage。
 */
export function authorizeKdsRequest(request: Request, storeId: string): KdsAuthResult {
  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized =
    !authEnforced ||
    Boolean(adminClaims) ||
    Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    return { ok: false, status: 401, error: "未經授權：需要 POS 終端憑證。" };
  }
  return { ok: true, status: 200 };
}

/** 讀屏要嘅訂單（已 map 成前端型別 + 算好 itemKeys）。 */
export interface KdsOrderBundle {
  order: PosOrder;
  itemKeys: string[];
}

export async function loadKdsOrders(
  supabase: SupabaseLike,
  storeId: string,
): Promise<{ bundles: KdsOrderBundle[]; error: PgError | null }> {
  const sinceIso = new Date(Date.now() - KDS_BOARD_MAX_AGE_MS).toISOString();

  const { data, error } = await supabase
    .from("pos_orders")
    .select("*")
    .eq("store_id", storeId)
    // ⚠️ 唔用 `/api/pos/orders`：佢冇回 fulfillment_status / sent_to_kitchen_at / source，
    //    而且係為收銀台而設（見 docs/116 §6.2）。
    .in("status", ["draft", "sent_to_kitchen", "paid"])
    // 未真正落廚房嘅單（draft 但冇 sent_to_kitchen_at）唔應該上屏
    .not("sent_to_kitchen_at", "is", null)
    // 12 小時窗口用 updated_at：長時間嘅單加咗菜都要重返屏（見 kds-board.ts）
    .gte("updated_at", sinceIso)
    .order("sent_to_kitchen_at", { ascending: true })
    .limit(300);

  if (error) return { bundles: [], error: error as PgError };

  const bundles = (data ?? []).map((row) => {
    const order = mapPosOrderRow(row as PosOrderRow);
    // 🔴 一定要用 orderItemKey()，唔可以自己砌（見 docs/116 §6.3）
    return { order, itemKeys: (order.items ?? []).map(orderItemKey) };
  });

  return { bundles, error: null };
}

export function toBoardInputs(bundles: KdsOrderBundle[]): KdsBoardOrderInput[] {
  return bundles.map((b) => ({ order: b.order, itemKeys: b.itemKeys }));
}

/** 讀 `pos_kds_item_state`（只讀三個要嘅欄）。 */
export async function loadKdsItemStates(
  supabase: SupabaseLike,
  storeId: string,
  orderIds: string[],
): Promise<{ states: KdsItemStateRow[]; error: PgError | null; tableMissing: boolean }> {
  if (orderIds.length === 0) return { states: [], error: null, tableMissing: false };

  const states: KdsItemStateRow[] = [];
  // PostgREST `.in()` 太長會爆 URL → 分批
  const CHUNK = 100;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("pos_kds_item_state")
      .select("order_id, item_key, done_qty")
      .eq("store_id", storeId)
      .in("order_id", chunk);

    if (error) {
      if (isMissingKdsTable(error as PgError)) {
        // 降級：當全部未做（done_qty = 0），但唔可以扮成功 —— 由 caller 回 degraded 標記
        return { states: [], error: null, tableMissing: true };
      }
      return { states, error: error as PgError, tableMissing: false };
    }

    for (const row of data ?? []) {
      states.push({
        order_id: String((row as { order_id?: unknown }).order_id ?? ""),
        item_key: String((row as { item_key?: unknown }).item_key ?? ""),
        done_qty: Number((row as { done_qty?: unknown }).done_qty ?? 0),
      });
    }
  }

  return { states, error: null, tableMissing: false };
}

/**
 * 讀工位來源：`pos_bootstrap_config` 嘅 `printer_groups` 同 `menu_items[].printerGroup`。
 *
 * 讀唔到（未同步餐牌）唔算錯 —— `deriveKdsStations()` 會退到 fallback。
 */
export async function loadKdsStationSources(
  supabase: SupabaseLike,
  storeId: string,
): Promise<{ printerGroups: string[]; menuItemGroups: string[] }> {
  const { data, error } = await supabase
    .from("pos_bootstrap_config")
    .select("printer_groups, menu_items")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error || !data) return { printerGroups: [], menuItemGroups: [] };

  const printerGroups = Array.isArray((data as { printer_groups?: unknown }).printer_groups)
    ? ((data as { printer_groups: unknown[] }).printer_groups.filter(
        (g): g is string => typeof g === "string",
      ))
    : [];

  const menu = (data as { menu_items?: unknown }).menu_items;
  const menuItemGroups: string[] = [];
  if (Array.isArray(menu)) {
    for (const entry of menu) {
      const group = (entry as { printerGroup?: unknown })?.printerGroup;
      if (typeof group === "string" && group.trim()) menuItemGroups.push(group.trim());
    }
  }

  return { printerGroups, menuItemGroups };
}

/**
 * 由 `pos_orders` 讀單張單，並驗證 `itemKey` 真係存在（docs/116 §6.3）。
 *
 * ⚠️ 一定要做呢個驗證：唔驗就會有人亂掉 itemKey 落去，`pos_kds_item_state`
 * 會慢慢積累一堆永遠對唔返訂單嘅垃圾行。
 */
export async function loadKdsOrderForWrite(
  supabase: SupabaseLike,
  storeId: string,
  orderId: string,
): Promise<{ order: PosOrder | null; itemKeys: string[]; error: PgError | null }> {
  const { data, error } = await supabase
    .from("pos_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) return { order: null, itemKeys: [], error: error as PgError };
  if (!data) return { order: null, itemKeys: [], error: null };

  const order = mapPosOrderRow(data as PosOrderRow);
  return { order, itemKeys: (order.items ?? []).map(orderItemKey), error: null };
}
