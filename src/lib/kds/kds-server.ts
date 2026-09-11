import "server-only";

import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { mapPosOrderRow, type PosOrderRow } from "@/lib/pos/pos-order-mapper";
import { orderItemKey } from "@/lib/pos/order-item-diff";
import { KDS_BOARD_MAX_AGE_MS } from "@/lib/kds/kds-board";
import type { PrintZone } from "@/lib/kds/stations";
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

/** 店嘅工位來源。 */
export interface KdsStationSources {
  /** 🔴 **商家設定嘅打印分區** = 分區清單嘅唯一權威來源。 */
  printZones: PrintZone[];
  /** 舊欄位，只做 fallback。 */
  printerGroups: string[];
  /** 菜單用過嘅 printerGroup，只做 fallback。 */
  menuItemGroups: string[];
}

/** 逐個元素白名單化 `printZones`（唔可以信 DB 任意 JSON）。 */
function normalizePrintZones(raw: unknown): PrintZone[] {
  if (!Array.isArray(raw)) return [];
  const out: PrintZone[] = [];
  for (const entry of raw) {
    const id = typeof (entry as PrintZone)?.id === "string" ? (entry as PrintZone).id.trim() : "";
    if (!id) continue;
    const name =
      typeof (entry as PrintZone)?.name === "string" && (entry as PrintZone).name.trim()
        ? (entry as PrintZone).name.trim()
        : id;
    out.push({ id, name });
  }
  return out;
}

/**
 * 讀「分區來源」。
 *
 * ## 🔴 分區嘅真源係 `pos_device_configs.local_settings.printZones`
 *
 * 商家喺「設定 → 打印機綁定 → 打印分區」自由新增（後廚1/2/3、水吧1/2/3…）。
 * 呢個 value 由設定頁嘅「保存」經 `/api/pos/device-config` 推上雲，
 * 存在該店**最新一條** device config 嘅 `local_settings` 入面。
 *
 * ⚠️ `pos_device_configs` 以 `device_id` 做主鍵，呢度用
 * 「`store_id` + `updated_at desc limit 1`」讀 —— 同專案既有慣例一致
 * （`/api/pos/state` 都係咁讀 `local_settings`）。呢個寫法對「per-device」設定係錯嘅，
 * 但 `printZones` 本質係**店級**設定（唔同 terminal 應該一致），所以可以接受。
 * **唔可以**為咗呢個去讀 `pos_bootstrap_config.printer_groups` ——
 * 嗰個係 legacy demo 值（`["kitchen","drinks","receipt"]`），同商家分區完全無關。
 *
 * ## ⚠️ 唯一權威來源應該係「專用嘅店級欄位」
 *
 * `printZones` 目前屈喺 device config 度，係歷史原因。長遠應該搬去
 * `pos_bootstrap_config.print_zones jsonb`（店級、purpose-built）——
 * 咁就唔會出現「最後保存嗰部機嘅分區蓋走全店」。**屬 P1，未做。**
 */
export async function loadKdsStationSources(
  supabase: SupabaseLike,
  storeId: string,
): Promise<KdsStationSources> {
  const empty: KdsStationSources = { printZones: [], printerGroups: [], menuItemGroups: [] };

  // ① 商家分區（真源）
  const deviceRes = await supabase
    .from("pos_device_configs")
    .select("local_settings")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const deviceRow = (deviceRes.data ?? [])[0] as { local_settings?: unknown } | undefined;
  const printZones = normalizePrintZones(
    (deviceRow?.local_settings as { printZones?: unknown } | undefined)?.printZones,
  );

  // ② 舊來源（只做 fallback，唔可以當真源）
  const { data, error } = await supabase
    .from("pos_bootstrap_config")
    .select("printer_groups, menu_items")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error || !data) return { ...empty, printZones };

  const printerGroups = Array.isArray((data as { printer_groups?: unknown }).printer_groups)
    ? (data as { printer_groups: unknown[] }).printer_groups.filter(
        (g): g is string => typeof g === "string",
      )
    : [];

  const menu = (data as { menu_items?: unknown }).menu_items;
  const menuItemGroups: string[] = [];
  if (Array.isArray(menu)) {
    for (const entry of menu) {
      const group = (entry as { printerGroup?: unknown })?.printerGroup;
      if (typeof group === "string" && group.trim()) menuItemGroups.push(group.trim());
    }
  }

  return { printZones, printerGroups, menuItemGroups };
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
