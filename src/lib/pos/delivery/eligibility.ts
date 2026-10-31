/**
 * 「呢張單派唔派得」—— **唯一判斷真源**（零 UI 依賴，可單測）。
 *
 * ## 三種來源、三套規則
 *
 * | 來源 | 規則 |
 * |---|---|
 * | 線上（Ledger） | **只有 `fulfillment_type = merchant_delivery`**；狀態要 accepted／preparing／ready |
 * | 店內（POS 本地） | 任何未取消、已送出嘅單都可以派（堂食「外賣自送」枱、快餐 counter、自取） |
 * | 平台（澳覓／MFOOD） | 只限 `merchant`／`pickup`；`platform`（專送）同 `unknown` **一律唔准** |
 *
 * ## 為什麼線上唔准「堂食／自取」派
 *
 * 2026-10-31 用戶拍板：客人要改外送，只有兩條路 ——
 *   ① 自己取消再落一張；② 商家線下自己處理。
 * 喺 POS 直接將堂食／自取單轉外送會令狀態同錢都對唔上，所以**唔提供**。
 *
 * ## 為什麼平台「unknown」要 fail-closed
 *
 * 舊單／插件未送 `sendType`／`deliveryType` → 我哋唔知平台有冇派車手。
 * 估錯 = 兩個車手同時上門。寧願唔顯示掣（商家可以照舊用平台後台處理）。
 *
 * 呢個檔**唔會**讀 DB、唔會讀時間、唔會 throw —— 全部係純函式。
 */

import { isMerchantArrangedMode, normalizeDeliveryMode, type DeliveryMode } from "./delivery-mode.ts";

/** 唔准派嘅原因（UI 負責翻譯，唔好喺呢度寫中文）。 */
export type DispatchBlockReason =
  | "ok"
  | "already_dispatched"
  | "online_not_delivery"
  | "not_accepted"
  | "not_sent"
  | "order_closed"
  | "platform_delivery"
  | "delivery_mode_unknown";

export type DispatchEligibility = {
  can: boolean;
  reason: DispatchBlockReason;
  /** 平台單先有：正規化後嘅配送方式（方便 UI 出標籤）。 */
  mode?: DeliveryMode;
};

export type OnlineDispatchInput = {
  kind: "online";
  /** Ledger `fulfillment_type` */
  fulfillmentType: string;
  /** Ledger `status`（pending / accepted / preparing / ready / delivering / completed / cancelled） */
  status: string;
  /** 已經有進行中嘅派單（由 job 表話事，唔喺呢個純函式入面查） */
  hasActiveDispatch?: boolean;
};

export type LocalDispatchInput = {
  kind: "local";
  /** `PosOrder.status` */
  status: string;
  hasActiveDispatch?: boolean;
};

export type PlatformDispatchInput = {
  kind: "platform";
  /** `pos_orders.source`（aomi / mfood）—— 前端冇 raw_json 時可以唔傳 */
  source?: string;
  /** `pos_orders.raw_json`（server 端用） */
  rawJson?: unknown;
  /**
   * 已由 `/api/pos/delivery/modes` 解析好嘅配送方式。
   * 前端有呢個值就唔需要（亦唔應該）帶 `rawJson` 過嚟 —— raw payload 成 KB。
   * ⚠️ 明確傳 `unknown` 係有效值（代表「平台單但唔知邊種配送」），
   *    唔會 fallback 去 `source`（因為前端根本冇 raw_json，fallback 只會永遠 unknown）。
   */
  mode?: DeliveryMode;
  status: string;
  hasActiveDispatch?: boolean;
};

export type DispatchInput = OnlineDispatchInput | LocalDispatchInput | PlatformDispatchInput;

/** 已取消／退款類 —— 任何來源都唔准派。 */
const CLOSED_STATUSES = new Set(["cancelled", "canceled", "refunded", "partially_refunded"]);

/** 線上單可以派嘅 Ledger 狀態（對齊 `merchantRequestDeliveryDispatch` 嘅守衛）。 */
const ONLINE_DISPATCHABLE = new Set(["accepted", "preparing", "ready"]);

/** 店內單可以派嘅 POS 狀態（draft 未送出 → 唔准）。 */
const LOCAL_DISPATCHABLE = new Set(["sent_to_kitchen", "paid", "settled", "reopened"]);

export function evaluateDispatchEligibility(input: DispatchInput): DispatchEligibility {
  if (input.hasActiveDispatch) {
    return { can: false, reason: "already_dispatched" };
  }

  const status = String(input.status ?? "").toLowerCase();

  if (input.kind === "online") {
    if (CLOSED_STATUSES.has(status) || status === "completed") {
      return { can: false, reason: "order_closed" };
    }
    if (String(input.fulfillmentType ?? "").toLowerCase() !== "merchant_delivery") {
      return { can: false, reason: "online_not_delivery" };
    }
    if (status === "delivering") {
      return { can: false, reason: "already_dispatched" };
    }
    if (!ONLINE_DISPATCHABLE.has(status)) {
      return { can: false, reason: "not_accepted" };
    }
    return { can: true, reason: "ok" };
  }

  if (CLOSED_STATUSES.has(status)) {
    return { can: false, reason: "order_closed" };
  }

  if (input.kind === "local") {
    if (!LOCAL_DISPATCHABLE.has(status)) {
      return { can: false, reason: "not_sent" };
    }
    return { can: true, reason: "ok" };
  }

  // 平台單：配送方式話事
  // 前端已解析好（mode）就直接用；server／測試可以傳 rawJson 由 source 解析。
  const mode =
    input.mode !== undefined ? input.mode : normalizeDeliveryMode(input.source, input.rawJson);
  if (mode === "unknown") {
    return { can: false, reason: "delivery_mode_unknown", mode };
  }
  if (!isMerchantArrangedMode(mode)) {
    return { can: false, reason: "platform_delivery", mode };
  }
  if (!LOCAL_DISPATCHABLE.has(status)) {
    // 平台單同店內單一樣：draft 未送出唔准
    return { can: false, reason: "not_sent", mode };
  }
  return { can: true, reason: "ok", mode };
}
