/**
 * 由雲端訂單 + 單品完成狀態，砌出後廚屏要嘅模型（docs/116 §5/§6.2）。
 *
 * 呢個係**純函式**：冇 network、冇 localStorage、冇 `@/` 執行期 import
 * → 可以直接 `node --test`（見 `kds-board.test.ts`）。
 *
 * ## 幾個唔可以改嘅口徑
 *
 * 1. **`itemKey` 一定要用 `orderItemKey()`**（`lib/pos/order-item-diff.ts`）。
 *    為咗令呢個檔保持零執行期依賴，caller 要自己算好再傳入 `itemKeys`
 *    （index 對應 `order.items`）。**唔可以**喺呢度自己砌 key ——
 *    兩邊口徑一唔同，屏上撳完就對唔返訂單嘅行 = 靜默失效。
 *
 * 2. **同一個 `itemKey` 可能出現多過一次**，一定要合併。
 *    時價菜每次落單都係獨立一行（`pos-app.tsx` `commitMenuItem()` 刻意唔合併），
 *    兩碟同價同時價菜就會撞同一個 key。而 `pos_kds_item_state` 嘅 PK 係
 *    `(store_id, order_id, item_key)` —— 唔合併就會有一行嘅完成狀態**永遠寫唔到**。
 *    合併係正確行為：兩碟一樣嘅菜，屏上就應該係一行 ×2。
 *
 * 3. **`doneQty` 唔可以超過 `quantity`**（clamp）。
 *    減件（客人改單）之後，舊嘅 `done_qty` 可能大過新嘅 `quantity`。
 *
 * 4. **`doneQty` 用份數，唔用 boolean**。加單時 `doneQty(1) < quantity(3)`
 *    → 自動重新亮起「仲欠 2」，唔會靜默漏單（docs/116 §3.2）。
 */

import type { OrderItem } from "@/lib/types";
import { deriveKdsStations, isKdsStation } from "./stations.ts";
import type {
  KdsBoardItem,
  KdsBoardOrder,
  KdsBoardOrderInput,
  KdsBoardPayload,
  KdsItemStateRow,
} from "./types.ts";

/** 呢個狀態嘅訂單先會上屏（`settled` / 已退一律唔上）。 */
const BOARD_ORDER_STATUSES: ReadonlySet<string> = new Set(["draft", "sent_to_kitchen", "paid"]);

/** 12 小時：同 docs/116 §6.2 一致。舊過咁耐嘅單唔應該仲霸住個屏。 */
export const KDS_BOARD_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** `Map` key：order_id + item_key。中間用 NUL 分隔，避免任何拼接歧義。
 *
 *  **匯出**係為咗客戶端（樂觀 UI / Realtime 增量）同呢度用**同一個** key 口徑 ——
 *  兩邊各寫一份係經典嘅靜默 bug 來源。 */
export function kdsStateKey(orderId: string, itemKey: string): string {
  return `${orderId}\u0000${itemKey}`;
}

function specsOf(item: OrderItem): string[] {
  return (item.selectedSpecs ?? [])
    .map((spec) => spec.optionLabel)
    .filter((label): label is string => typeof label === "string" && label.length > 0);
}

/**
 * 訂單係唔係應該上屏。
 *
 * - `sentToKitchenAt` **一定要有** —— 冇 = 仲未真正落廚房（draft）。
 *   單睇 `status` 唔夠：draft 單會提早喺屏上出現，師傅會做咗未確認嘅菜。
 * - 結帳狀態機唔郁：`settled` / `cancelled` / 已退一律唔上。
 * - 12 小時窗口用 **`updated_at`**（最後有人動過），唔係 `sentToKitchenAt`。
 *   用落單時間嘅話，一張 13 小時前落、但啱啱加咗菜嘅單會成張消失 —— 加單嗰兩碟永遠冇人做。
 */
function isBoardEligible(order: KdsBoardOrderInput["order"], nowMs: number): boolean {
  if (!BOARD_ORDER_STATUSES.has(order.status)) return false;
  if (!order.sentToKitchenAt) return false;
  const sentMs = Date.parse(order.sentToKitchenAt);
  if (!Number.isFinite(sentMs)) return false;
  const activityIso = order.updatedAt || order.sentToKitchenAt;
  const activityMs = Date.parse(activityIso);
  if (!Number.isFinite(activityMs)) return false;
  return nowMs - activityMs <= KDS_BOARD_MAX_AGE_MS;
}

/** 合併同一 `itemKey` 嘅行（見檔頭第 2 點）。 */
function aggregateItems(
  items: OrderItem[],
  itemKeys: string[],
): Map<string, { item: OrderItem; quantity: number }> {
  const out = new Map<string, { item: OrderItem; quantity: number }>();
  items.forEach((item, index) => {
    // 退菜唔上屏（docs/116 §3.2 最後一句）
    if (item.voided) return;
    const quantity = Math.trunc(Number(item.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const key = itemKeys[index];
    if (!key) return;

    const existing = out.get(key);
    if (existing) {
      existing.quantity += quantity;
      return;
    }
    out.set(key, { item, quantity });
  });
  return out;
}

export interface BuildKdsBoardInput {
  orders: KdsBoardOrderInput[];
  states: KdsItemStateRow[];
  /**
   * 本機鎖定嘅工位。`null` / `""` = **唔指定**。
   * ⚠️ 唔指定時 `orders` 一律回空 —— 見 `allowAllStations`。
   */
  station?: string | null;
  /**
   * 允唔允許「唔指定工位」都回全部訂單。
   * **預設 `false`**，因為產品上唔存在「全部」模式（docs/116 §4.4）；
   * 一旦漏咗傳 `station`，屏會變成「全部」—— 正好係用戶想消滅嘅嘢。
   * 寧願回空屏（明顯睇得出有問題）都唔好靜靜顯示全部。
   */
  allowAllStations?: boolean;
  /** 已全數完成嘅單要唔要都回（出餐台屏核對用；後廚屏唔要）。 */
  includeCompleted?: boolean;
  /** 由 server 傳入；冇提供就用第二個參數 `nowMs`。 */
  serverTime?: string;
  serverNowMs?: number;
  /** 店嘅 printerGroups（jsonb），用嚟砌工位清單。 */
  printerGroups?: Array<string | null | undefined> | null;
  /** 菜單用過嘅 printerGroup，用嚟砌工位清單。 */
  menuItemGroups?: Array<string | null | undefined> | null;
}

export type BuildKdsBoardResult = KdsBoardPayload;

/**
 * 由訂單同狀態砌出屏上模型。
 *
 * ⚠️ 呢個函式**唔會**過濾「今日 / 本店」—— 交畀 caller（端點已用
 * `store_id` filter 同 12 小時窗口）。呢度只做「合資格 + 工位 + 完成度」。
 */
export function buildKdsBoard(input: BuildKdsBoardInput): BuildKdsBoardResult {
  const serverNowMs = input.serverNowMs ?? Date.now();
  const serverTime = input.serverTime ?? new Date(serverNowMs).toISOString();

  const doneMap = new Map<string, number>();
  for (const row of input.states) {
    if (!row) continue;
    doneMap.set(kdsStateKey(row.order_id, row.item_key), Math.trunc(Number(row.done_qty ?? 0)));
  }

  const stationFilter = typeof input.station === "string" && input.station.trim()
    ? input.station.trim()
    : null;

  /** 全店各工位未完成**份數**（唔扣 station，畀「揀崗位」畫面用）。 */
  const pendingByStation: Record<string, number> = {};
  /** 板上訂單真正出現過嘅工位（**包括已完成嘅**，見下面 stations 註解）。 */
  const observedStations = new Set<string>();

  const allOrders: KdsBoardOrder[] = [];

  for (const entry of input.orders) {
    const order = entry.order;
    if (!isBoardEligible(order, serverNowMs)) continue;

    const aggregated = aggregateItems(order.items ?? [], entry.itemKeys ?? []);
    if (aggregated.size === 0) continue;

    const allRows: KdsBoardItem[] = [];

    for (const [itemKey, { item, quantity }] of aggregated) {
      const station = (item.printerGroup ?? "").trim();
      // 非工位（receipt / label）唔上後廚屏 —— 佢哋唔係「要做嘅菜」。
      if (!isKdsStation(station)) continue;

      const rawDone = doneMap.get(kdsStateKey(order.id, itemKey)) ?? 0;
      // clamp：減件之後舊嘅 done_qty 可能大過新 quantity
      const doneQty = Math.max(0, Math.min(rawDone, quantity));
      const remaining = quantity - doneQty;
      // ⚠️ 收集工位時**唔可以**只收「仲有未完成」嘅：
      // 一個工位做完晒所有嘢之後若就咁喺清單消失，
      // 客戶端 `isStationAvailable()` 會判「綁定失效」→ 無啦啦彈返去重新揀崗位。
      observedStations.add(station);
      // 統計用：跨**全部**工位（唔扣 station 過濾），因為「揀崗位」畫面要睇晒。
      if (remaining > 0) {
        pendingByStation[station] = (pendingByStation[station] ?? 0) + remaining;
      }

      allRows.push({
        itemKey,
        name: item.name ?? "",
        quantity,
        station,
        note: item.note,
        specs: specsOf(item),
        doneQty,
      });
    }

    const rows = stationFilter ? allRows.filter((row) => row.station === stationFilter) : allRows;
    if (rows.length === 0) continue;

    // 🔴 「做完未」一定要**按本工位**計，唔可以跨工位。
    // 反例：一張單同時有「炒飯（廚房）」同「凍檸茶（水吧）」。
    // 廚房做完自己嗰碟、水吧未做 → 若用「全單完成」判定，廚房屏會永遠留住一張
    // 已經冇嘢做嘅卡（reload 之後都仲喺度）。
    const remainingForStation = rows.reduce((sum, row) => sum + (row.quantity - row.doneQty), 0);
    if (remainingForStation === 0 && !input.includeCompleted) continue;

    allOrders.push({
      id: order.id,
      localOrderNo: order.localOrderNo ?? order.id,
      tableId: order.tableId ?? "counter",
      tableName: order.tableName ?? "",
      source: order.source ?? "pos",
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus,
      sentToKitchenAt: order.sentToKitchenAt,
      createdAt: order.createdAt ?? order.sentToKitchenAt ?? "",
      updatedAt: order.updatedAt ?? "",
      items: rows,
    });
  }

  // 舊單行先（廚房由最耐等到嘅開始做）
  allOrders.sort((a, b) => {
    const ta = Date.parse(a.sentToKitchenAt ?? a.createdAt);
    const tb = Date.parse(b.sentToKitchenAt ?? b.createdAt);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });

  const stations = deriveKdsStations({
    printerGroups: input.printerGroups,
    menuItemGroups: input.menuItemGroups,
    observedStationIds: [...observedStations],
    pending: pendingByStation,
  });

  // ⚠️ 唔指定工位 → 一律回空 orders（除非 caller 明確允許）。
  // 呢個係「唔可以有『全部』模式」嘅最後一道閘：漏傳 station 只會出空屏，
  // 唔會靜靜變返「全部」—— 空屏一眼睇得出有問題，錯誤模式唔會。
  if (!stationFilter && !input.allowAllStations) {
    return { serverTime, orders: [], stations };
  }

  return { serverTime, orders: allOrders, stations };
}

/**
 * 一張單仲欠幾多（份）。
 * 出餐台屏做「ready」前置檢查時要對照（docs/116 §6.4）。
 */
export function remainingQtyOf(items: KdsBoardItem[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.quantity - item.doneQty), 0);
}
