/**
 * 澳門外送分區（2026-10-31）。
 *
 * ## 為什麼要有呢個清單
 *
 * 商家喺電腦／平板上打完整地址好麻煩（而且好易打錯），但**區份一定知**。
 * 所以派單彈窗先要求揀區，詳細地址可以後補 —— 有區份 + 電話，
 * 車手至少知道去邊一帶、而且打得到客人。
 *
 * ## 為什麼唔係由平台／Ledger 拿
 *
 * 查過三邊都**冇**正式分區表：
 *   - `membershipDeliveryDriver`：`rider.zone` 只係自由文字（預設 `"澳門"`）；
 *   - `Macau-Ledger`：只有派送費選項，冇 zone；
 *   - POS：冇。
 * 所以呢個檔暫時係唯一真源。**平台日後出正式清單，只需改呢一個檔**
 * （UI 同 i18n 都係由呢個陣列生成，唔會四處散落）。
 *
 * ⚠️ 排序刻意由北到南（黑沙環 → 路環），同澳門人講嘢嘅習慣一致；
 *    唔好按筆劃排，店員搵唔到。
 */

export const MACAU_DELIVERY_ZONES = [
  "黑沙環",
  "筷子基",
  "青洲",
  "台山",
  "沙梨頭",
  "新橋",
  "三盞燈",
  "高士德",
  "新馬路",
  "南灣",
  "新口岸",
  "東望洋",
  "氹仔市區",
  "氹仔舊城區",
  "路氹城",
  "路環",
] as const;

export type MacauDeliveryZone = (typeof MACAU_DELIVERY_ZONES)[number];

/** 「其他」＝ 清單冇嘅地方（例如客人住喺橫琴／珠海）。揀咗就一定要自己打地址。 */
export const OTHER_ZONE = "其他";

/**
 * 組合最終寫入 DB 嘅地址字串。
 *
 * - 有區 + 有詳細 → `黑沙環 88 號 5 樓 A`
 * - 有區、詳細未填 → `黑沙環`（車手睇到區份，致電客人問）
 * - 揀「其他」→ 只用詳細地址（因為區份本身冇資訊量）
 */
export function composeDeliveryAddress(
  zone: string | null | undefined,
  detail: string | null | undefined,
): string {
  const z = String(zone ?? "").trim();
  const d = String(detail ?? "").trim();
  if (!z || z === OTHER_ZONE) return d;
  if (!d) return z;
  return `${z} ${d}`;
}

/**
 * 由一段完整地址倒推區份（平台單預填用）。
 *
 * 例如平台送嚟「黑沙環中街 88 號 5 樓 A」→ `黑沙環`，剩低嘅做詳細地址。
 * 認唔到就回 `null`（唔好亂猜 —— 猜錯區份比冇區份更差）。
 *
 * ⚠️ 一定要**由長到短**比對：`氹仔舊城區` 要先過 `氹仔市區` 之前，
 *    否則「氹仔舊城區…」永遠命唔中。所以按字串長度排序。
 */
export function matchZoneFromAddress(text: string | null | undefined): string | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const byLength = [...MACAU_DELIVERY_ZONES].sort((a, b) => b.length - a.length);
  for (const zone of byLength) {
    if (value.startsWith(zone)) return zone;
  }
  return null;
}

/**
 * 呢組輸入夠唔夠派單。
 *
 * 規則：**一定要有區份**（或者「其他」+ 詳細地址）。
 * 詳細地址可以留空 —— 商家之後補，或者車手打俾客人問。
 */
export function isAddressReady(
  zone: string | null | undefined,
  detail: string | null | undefined,
): boolean {
  return composeDeliveryAddress(zone, detail).trim().length > 0;
}
