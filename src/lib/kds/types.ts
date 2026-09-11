/**
 * 後廚屏 / 出餐台屏（KDS）型別（docs/116）。
 *
 * ⚠️ 呢個檔**只有 `import type`**（類型會被擦走）→ 可以安全喺 `node --test` 下載入。
 * 任何**執行期** import 都唔可以加落呢度，否則純函式測試會 `ERR_MODULE_NOT_FOUND`
 * （`@/` alias 只有 Next 認得，Node 唔認）。
 */

import type { PosOrder } from "@/lib/types";

/**
 * 設備角色。
 * - `kitchen`：後廚屏，**必須**綁一個 `station`（廚房 / 水吧），屏內鎖死唔可以切換。
 * - `expo`：出餐台屏，唔需要 `station`（佢要睇整張單核對，見 docs/116 §4.4 邊界情況）。
 */
export type KdsRole = "kitchen" | "expo";

/**
 * 崗位（工位）= **設備屬性**，唔係訂單屬性。
 * 所以存喺設備綁定度，唔放 `pos_orders`（docs/116 §4.4）。
 */
export interface KdsDeviceBinding {
  storeId: string;
  storeName: string;
  role: KdsRole;
  /** 後廚屏專屬：呢部機服務邊個工位（值 = `OrderItem.printerGroup`）。 */
  station?: string;
  boundAt: string;
}

/** 「揀崗位」畫面用嘅候選項。 */
export interface KdsStationOption {
  /** 分區 id（= `OrderItem.printerGroup`）。⚠️ 唔應該直接顯示畀用戶睇 —— 自訂分區嘅 id 帶時間戳。 */
  id: string;
  /** 商家設定嘅分區名。 */
  name: string;
  /** 顯示用（同 `name` 一樣；保留 `label` 係為咗同舊 call site 相容）。 */
  label: string;
  /** 而家未完成嘅**份數**（跨全店、唔扣站，畀同事一眼睇邊個分區忙）。 */
  pending: number;
}

/** 屏上一個菜品行（已經按 `itemKey` 合併過，見 `buildKdsBoard()`）。 */
export interface KdsBoardItem {
  /** 必須同 `orderItemKey()`（`lib/pos/order-item-diff.ts`）同口徑。 */
  itemKey: string;
  name: string;
  /** 合併後嘅總件數（同一 key 可能來自多過一行）。 */
  quantity: number;
  station: string;
  note?: string;
  /** 已格式化嘅規格標籤（例如 `["大","少冰"]`），畀屏直接 render。 */
  specs: string[];
  /** **已出份數**，唔係 boolean。加單時 `doneQty < quantity` → 自動重新亮起。 */
  doneQty: number;
}

export interface KdsBoardOrder {
  id: string;
  localOrderNo: string;
  tableId: string;
  tableName: string;
  source: PosOrder["source"];
  status: PosOrder["status"];
  fulfillmentStatus?: "preparing" | "ready";
  /** 計時器起算點。冇呢個值嘅單唔應該上屏（未真正落廚房）。 */
  sentToKitchenAt?: string;
  createdAt: string;
  updatedAt: string;
  /** 只包含**本崗位**嘅行（`station` 過濾喺 server 做）。 */
  items: KdsBoardItem[];
}

/** `GET /api/pos/kds/board` 嘅回傳主體。 */
export interface KdsBoardPayload {
  /**
   * ⚠️ 必須由 server 回。iPad 時鐘會飄，計時器用本機時間會出現「-3 分鐘」
   * 或者整批誤報超時（docs/116 §6.2）。
   */
  serverTime: string;
  orders: KdsBoardOrder[];
  /** 全店工位清單（同 `station` 過濾無關），畀「揀崗位」畫面用。 */
  stations: KdsStationOption[];
}

/** 畀 `buildKdsBoard()` 用嘅「已算好 key」嘅訂單輸入。 */
export interface KdsBoardOrderInput {
  order: PosOrder;
  /**
   * 每個 item 對應嘅 `orderItemKey()`。**必須**由 caller 用
   * `orderItemKey()`（`lib/pos/order-item-diff.ts`）算，唔可以自己砌。
   * 長度同 `order.items` 一致（index 對應）。
   */
  itemKeys: string[];
}

/** `pos_kds_item_state` 一行（只需要呢三欄）。 */
export interface KdsItemStateRow {
  order_id: string;
  item_key: string;
  done_qty: number;
}
