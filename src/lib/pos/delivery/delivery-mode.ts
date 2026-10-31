/**
 * 平台單「配送方式」正規化 —— **唯一真源**。
 *
 * ## 為什麼要呢個檔
 *
 * 澳覓／MFOOD 嘅訂單本身**有**配送方式，但一直收喺插件原始 payload 內層，
 * POS 從來冇讀過（`GrabberOrder.fulfillmentType` 有 type 宣告但
 * `projectGrabberOrder()` 冇用；一律寫 `table_id="counter"`、`table_name="外賣"`）。
 *
 * 2026-10-31 需求：**只有「商家自送／自取」先可以喺 POS 派車手**；
 * 平台專送（平台自己派）唔應該出現「派送」掣，否則兩邊同時派會重複送餐。
 *
 * ## 實測（2026-10-31，唯讀查生產 `pos_orders.raw_json`）
 *
 * | 平台 | 路徑 | 實測值 |
 * |---|---|---|
 * | 澳覓 | `raw_json.raw.sendType` | `"專送"`（sendFeeAmt 1200） |
 * | MFOOD | `raw_json.raw.deliveryType` | `"1"`（deliveryFee 12.5–12.6）、`"3"`（deliveryFee 0） |
 *
 * ⚠️ `"2"` 未見過；`2`／`3` 邊個係自送、邊個係自取**未 100% 確認**。
 *    但兩者都係「平台唔派」→ 一樣要有派送掣，所以判斷唔受影響，只影響標籤文字。
 *
 * ## fail-closed
 *
 * 未知值、缺失欄位、舊單（插件未送呢個欄位）→ 一律 `unknown`，
 * UI **唔會**顯示派送掣。寧願少一個掣，都唔好重複派車手。
 *
 * 零 runtime 依賴 → 可以被 `node --test` 直接載入。
 */

export type DeliveryMode = "platform" | "merchant" | "pickup" | "unknown";

export type PlatformSource = "aomi" | "mfood";

/** 澳覓 `sendType` 對照。只列見過／合理嘅值，其餘一律 unknown。 */
const AOMI_SEND_TYPE: Record<string, DeliveryMode> = {
  "專送": "platform",
  "平台專送": "platform",
  "平台配送": "platform",
  "自送": "merchant",
  "商家自送": "merchant",
  "自取": "pickup",
  "到店自取": "pickup",
};

/** MFOOD `deliveryType` 對照（字串數字）。 */
const MFOOD_DELIVERY_TYPE: Record<string, DeliveryMode> = {
  "1": "platform",
  "2": "merchant",
  "3": "pickup",
};

/** 平台單來源；唔係 aomi／mfood 回 `null`。 */
export function platformSourceOf(source: unknown): PlatformSource | null {
  const value = String(source ?? "").toLowerCase();
  if (value === "aomi") return "aomi";
  if (value === "mfood") return "mfood";
  return null;
}

/**
 * 由 `pos_orders.raw_json` 取出平台原始物件。
 *
 * 插件包裝係 `{ ...GrabberOrder, raw: { 平台原物件 } }`；
 * 但假單／舊版可能冇 `raw` 呢層，所以 fallback 返頂層。
 */
export function readPlatformRaw(rawJson: unknown): Record<string, unknown> | null {
  if (!rawJson || typeof rawJson !== "object") return null;
  const outer = rawJson as Record<string, unknown>;
  const inner = outer.raw;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return outer;
}

/**
 * 正規化平台配送方式。
 *
 * @param source  `pos_orders.source`（`aomi` / `mfood`）
 * @param rawJson `pos_orders.raw_json`（可以係整個 row 嘅 raw_json，亦可以係 `raw` 內層）
 */
export function normalizeDeliveryMode(source: unknown, rawJson: unknown): DeliveryMode {
  const platform = platformSourceOf(source);
  if (!platform) return "unknown";
  const raw = readPlatformRaw(rawJson);
  if (!raw) return "unknown";

  if (platform === "aomi") {
    const key = String(raw.sendType ?? "").trim();
    return AOMI_SEND_TYPE[key] ?? "unknown";
  }

  // MFOOD：deliveryType 可能係 number 或者 string
  const key = String(raw.deliveryType ?? "").trim();
  return MFOOD_DELIVERY_TYPE[key] ?? "unknown";
}

/** 顯示標籤（未翻譯原文；UI 用 `t()` 包）。 */
export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  platform: "平台配送",
  merchant: "商家自送",
  pickup: "自取",
  unknown: "配送方式未知",
};

/** 係咪「平台唔派、商戶要自己安排」嘅模式。 */
export function isMerchantArrangedMode(mode: DeliveryMode): boolean {
  return mode === "merchant" || mode === "pickup";
}

/** `pos_orders` 投影出嚟嘅最小欄位（唔好成個 row 傳入嚟，避免帶埋個資）。 */
export type PlatformOrderModeRow = {
  id: string;
  source?: string | null;
  raw_json?: unknown;
};

/**
 * 一批平台單 → `{ [pos_orders.id]: mode }`。
 *
 * 只回 enum（每張單幾十 bytes），**唔會**將 `raw_json` 送去前端 ——
 * 呢個就係「省數據」嘅關鍵：raw payload 成 KB，enum 只係幾個字。
 *
 * 未知值照樣收錄（`unknown`），等前端知道「呢張係平台單，但唔知邊種配送」，
 * 而唔係當成「冇呢個資料」——兩者對 UI 嘅意思唔同（前者要顯示提示，後者唔使）。
 */
export function buildDeliveryModeMap(
  rows: readonly PlatformOrderModeRow[],
): Record<string, DeliveryMode> {
  const out: Record<string, DeliveryMode> = {};
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    out[row.id] = normalizeDeliveryMode(row.source, row.raw_json);
  }
  return out;
}
