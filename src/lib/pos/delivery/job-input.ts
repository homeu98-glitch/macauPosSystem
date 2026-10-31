/**
 * 「派送彈窗 → `pos_delivery_jobs` 一行」—— **唯一轉換真源**（零 import，可單測）。
 *
 * ## 為什麼要喺 server 再驗一次
 *
 * 前端已經用 `evaluateDispatchEligibility()` 擋過一次，但呢個只係**方便**，
 * 唔係安全邊界：任何人都可以直接 POST。而派錯單嘅代價係**真金白銀**
 * （兩個車手同時上門、車手去到冇人、代收金額錯）。
 *
 * 所以 server 呢邊：
 *   - 唔信任任何前端傳嚟嘅金額（自己 parse + 上限）；
 *   - 唔信任 `deliveryMode`（只准 `merchant` / `pickup`；`platform` / `unknown` 一律拒）；
 *   - 唔信任單號（`order_no_snapshot` 只係顯示用，長度有上限）。
 *
 * ## 金額口徑
 *
 * DB 存 **avos**（1 MOP = 100 avos），同 Ledger／SiteB 一致。
 * 前端傳 MOP 小數（`30` 或 `30.5`），呢度 `Math.round(x * 100)`。
 * ⚠️ 唔可以用 `x * 100 | 0` —— 浮點誤差會令 30.005 變 3000 或 3001。
 *
 * ## 冇地圖 SDK
 *
 * 本 repo 冇接任何地圖服務（見 `package.json`），所以**座標係選填**：
 * 有就存（車手導航更準），冇就靠地址。要留意 Ledger B1 對 `latitude/longitude`
 * 係必填 —— 真正派單嗰一步（Phase 3）如果缺座標，會收到 `missing_coords`，
 * 到時 UI 會提示商家補。呢個檔唔會假造座標。
 */

import type { DeliveryJobStatus } from "./types.ts";

/** 前端可以傳嘅欄位（camelCase）。 */
export type DeliveryJobInput = {
  orderSource?: unknown;
  orderRef?: unknown;
  orderNoSnapshot?: unknown;
  platform?: unknown;
  deliveryMode?: unknown;
  customer?: {
    name?: unknown;
    phone?: unknown;
    address?: unknown;
    lat?: unknown;
    lng?: unknown;
    note?: unknown;
  } | null;
  feeAmountMop?: unknown;
  feePaidBy?: unknown;
  codAmountMop?: unknown;
  createdBy?: unknown;
};

/** 可以直接餵畀 PostgREST 嘅 row（snake_case）。 */
export type DeliveryJobDraftRow = {
  order_source: "ledger" | "pos";
  order_ref: string;
  order_no_snapshot: string;
  platform: string | null;
  delivery_mode: "merchant" | "pickup";
  status: DeliveryJobStatus;
  customer_name: string | null;
  customer_phone: string;
  customer_address: string;
  customer_lat: number | null;
  customer_lng: number | null;
  customer_note: string | null;
  fee_amount_avos: number;
  fee_paid_by: "shop" | "customer";
  cod_amount_avos: number;
  created_by: string | null;
};

export type DeliveryJobInputError =
  | "bad_source"
  | "bad_ref"
  | "bad_mode"
  | "platform_delivery"
  | "missing_phone"
  | "bad_phone"
  | "missing_address"
  | "bad_coords"
  | "bad_fee"
  | "bad_cod";

export type DeliveryJobInputResult =
  | { ok: true; row: DeliveryJobDraftRow }
  | { ok: false; error: DeliveryJobInputError };

/** 車手費上限（MOP）—— 防手誤打多幾個 0。 */
const MAX_FEE_MOP = 1_000;
/** 代收上限（MOP）—— 同上。 */
const MAX_COD_MOP = 100_000;
/** 地址 / 備註 / 姓名長度上限（避免整段貼上成頁字）。 */
const MAX_ADDRESS = 200;
const MAX_NOTE = 200;
const MAX_NAME = 60;
const MAX_ORDER_NO = 60;
const MAX_REF = 100;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 電話：只准數字、空格、`+ - ( )`；數字段 6–15 位（澳門 8 位、內地 11 位都夠）。 */
export function normalizePhone(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (!/^[0-9+\-() ]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return raw;
}

/** MOP → avos（整數）。非數字 / 超出範圍回 null（呼叫端決定當錯誤定當 0）。 */
export function mopToAvos(value: unknown, maxMop: number): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) return null;
  if (num < 0 || num > maxMop) return null;
  return Math.round(num * 100);
}

function coordinate(value: unknown, limit: number): number | null | "bad" {
  if (value === null || value === undefined || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || Math.abs(num) > limit) return "bad";
  return num;
}

/**
 * 驗證 + 轉換。
 *
 * @param input 前端 body（原始、未信任）
 */
export function buildDeliveryJobDraft(input: DeliveryJobInput): DeliveryJobInputResult {
  const source = text(input.orderSource);
  if (source !== "ledger" && source !== "pos") return { ok: false, error: "bad_source" };

  const orderRef = text(input.orderRef);
  if (!orderRef || orderRef.length > MAX_REF) return { ok: false, error: "bad_ref" };

  const platformRaw = text(input.platform);
  const platform = platformRaw === "aomi" || platformRaw === "mfood" ? platformRaw : null;

  // 配送方式：平台專送／未知一律拒（寧願唔派，唔好兩個車手同時上門）
  const mode = text(input.deliveryMode) || "merchant";
  if (mode === "platform") return { ok: false, error: "platform_delivery" };
  if (mode !== "merchant" && mode !== "pickup") return { ok: false, error: "bad_mode" };

  const customer = input.customer ?? {};
  const phone = normalizePhone(customer.phone);
  if (!text(customer.phone)) return { ok: false, error: "missing_phone" };
  if (!phone) return { ok: false, error: "bad_phone" };

  const address = text(customer.address).slice(0, MAX_ADDRESS);
  if (!address) return { ok: false, error: "missing_address" };

  const lat = coordinate(customer.lat, 90);
  const lng = coordinate(customer.lng, 180);
  if (lat === "bad" || lng === "bad") return { ok: false, error: "bad_coords" };

  const feeAvos = mopToAvos(input.feeAmountMop, MAX_FEE_MOP);
  if (feeAvos === null) return { ok: false, error: "bad_fee" };

  const codAvos = mopToAvos(input.codAmountMop, MAX_COD_MOP);
  if (codAvos === null) return { ok: false, error: "bad_cod" };

  return {
    ok: true,
    row: {
      order_source: source,
      order_ref: orderRef,
      order_no_snapshot: text(input.orderNoSnapshot).slice(0, MAX_ORDER_NO),
      platform,
      delivery_mode: mode,
      // 只會寫 draft：真正推送（queued → SiteB）係 Phase 3，Ledger v3.6 上線後才開
      status: "draft",
      customer_name: text(customer.name).slice(0, MAX_NAME) || null,
      customer_phone: phone,
      customer_address: address,
      customer_lat: lat,
      customer_lng: lng,
      customer_note: text(customer.note).slice(0, MAX_NOTE) || null,
      fee_amount_avos: feeAvos,
      fee_paid_by: text(input.feePaidBy) === "customer" ? "customer" : "shop",
      cod_amount_avos: codAvos,
      created_by: text(input.createdBy).slice(0, 60) || null,
    },
  };
}

/** 呢個狀態嘅 job 可以覆寫（重派）。進行中嘅一律唔准蓋。 */
export function canOverwriteJob(status: unknown): boolean {
  const value = String(status ?? "");
  return value === "draft" || value === "canceled" || value === "failed";
}
