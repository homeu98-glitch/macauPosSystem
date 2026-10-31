/**
 * 平台單「客人送貨資料」抽取 —— 純函式，零 import，可單測。
 *
 * ## 為什麼要呢個檔
 *
 * 2026-10-31 一度以為平台單冇地址（只睇 `GrabberOrder` 型別），
 * 但實際讀插件原始碼（`C:\dev\grabber`）之後確認**有**：
 *
 * | 平台 | 位置 | 備註 |
 * |---|---|---|
 * | 澳覓 `aomi-bridge.js:212` | `customer.address` ← `d.userAddress` | 電話只有**遮罩**版 `853-****9190` |
 * | MFOOD `mfood-bridge.js:322` | `customer.address` ← `d.address` | 電話係**完整** `receiverMobile` |
 *
 * `projectGrabberOrder()` 只投影 `remark` / `phone`，所以地址一直只留喺 `raw_json`。
 * 呢個檔案負責喺**派單彈窗打開嗰一刻**（server route）抽返出嚟預填，
 * 唔會成批送去前端（raw payload 成 KB，而且含個資）。
 *
 * ## 兩層 fallback
 *
 * 插件包裝係 `{ ...正規化欄位, raw: { 平台原物件 } }`——
 * 正規化層有 `customer.address`，原物件層有 `userAddress`（澳覓）／`address`（MFOOD）。
 * 兩層都試，因為舊版插件／假單可能只有其中一層。
 *
 * ## 電話要驗「可用」
 *
 * 澳覓嘅電話係**遮罩**（`853-****9190`）—— 車手打唔到。呢種要當「冇電話」，
 * 由商家自己填，而唔係預填一個打唔通嘅號碼（比空白更差：店員會以為有電話）。
 */

import { platformSourceOf, readPlatformRaw } from "./delivery-mode.ts";

export type PlatformCustomerPrefill = {
  name?: string;
  /** 只有「可用」電話才會回（遮罩版會被丟棄）。 */
  phone?: string;
  address?: string;
  remark?: string;
  /** 平台有提供但係遮罩／無效 —— UI 可以提示「平台只給遮罩電話」。 */
  phoneMasked?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 電話可用嗎：至少 6 位數字，而且冇 `*`（遮罩）。
 *
 * 澳門 8 位、內地 11 位；`853-****9190` 只有 7 位數字但有 `*` → 判無效。
 */
export function isUsablePhone(value: unknown): boolean {
  const raw = text(value);
  if (!raw) return false;
  if (raw.includes("*")) return false;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 15;
}

/**
 * 由 `pos_orders.raw_json` 抽客人送貨資料。
 *
 * @param source  `pos_orders.source`（`aomi` / `mfood`）；其他一律回空物件
 * @param rawJson `pos_orders.raw_json`
 */
export function extractPlatformCustomer(
  source: unknown,
  rawJson: unknown,
): PlatformCustomerPrefill {
  const platform = platformSourceOf(source);
  if (!platform) return {};
  if (!rawJson || typeof rawJson !== "object") return {};

  const outer = rawJson as Record<string, unknown>;
  const inner = readPlatformRaw(rawJson);
  const customer =
    outer.customer && typeof outer.customer === "object" && !Array.isArray(outer.customer)
      ? (outer.customer as Record<string, unknown>)
      : null;

  const rawPhone = text(customer?.phone) || text(inner?.receiverMobile) || text(inner?.mobile);
  const masked = text(customer?.phoneMasked) || text(inner?.userRegistPhone) || text(inner?.userReveivePhone);

  const name =
    text(customer?.name) ||
    text(customer?.nickname) ||
    text(inner?.userNickName) ||
    text(inner?.userName) ||
    text(inner?.receiverName) ||
    text(inner?.buyerNick);

  // 澳覓原物件叫 `userAddress`；MFOOD 叫 `address`
  const address =
    text(customer?.address) || text(inner?.userAddress) || text(inner?.address);

  const remark = text(customer?.remark) || text(inner?.remark);

  // ⚠️ 只放**有值**嘅 key —— 唔好回一堆 `{ name: undefined }`，
  //    否則 API 會多幾個 null，前端 `??` 判斷亦容易出錯。
  const result: PlatformCustomerPrefill = {};
  if (name) result.name = name;
  if (address) result.address = address;
  if (remark) result.remark = remark;

  if (isUsablePhone(rawPhone)) {
    result.phone = rawPhone;
  } else if (masked) {
    // 保留遮罩原文，等 UI 可以講「平台只給遮罩電話，要自己問客人」
    result.phoneMasked = masked;
  }

  return result;
}
