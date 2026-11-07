"use client";

/**
 * 「待開枱」暫存 —— 訂位頁與收銀台之間的一次性交接。
 *
 * ## 為什麼要經過 localStorage
 *
 * 入座要「生成訂單 + 填購物車」，而購物車嘅 state 住喺 `pos-app` 裡面（9336 行）。
 * 喺訂位頁直接改佢係冇可能嘅，所以：
 *
 * ```
 * 訂位頁：算好 OrderItem[] → 寫入 pending → 跳 /pos?tableId=…&reservationId=…
 * pos-app：見到 reservationId 就讀 pending → 開枱 + 填車 → 清 pending
 * ```
 *
 * ## 為什麼一定要清
 *
 * 唔清嘅話，店員之後自己開同一張枱，會突然彈返上一次嘅預點菜出嚟 ——
 * 呢種「幽靈菜」係最難查嘅一類 bug。所以 `consume` 係**讀完即刪**。
 */

import type { OrderItem } from "@/lib/types";

const KEY_PREFIX = "macau-pos/stores";
const KEY_SUFFIX = "pending-seat";

export type PendingSeat = {
  reservationId: string;
  reservationCode: string;
  guestName: string;
  tableId: string;
  tableName: string;
  partySize: number;
  items: OrderItem[];
  /** 建立時間（ISO），用於判斷係唔係過期。 */
  createdAt: string;
};

function keyOf(storeId: string): string {
  return `${KEY_PREFIX}/${storeId}/${KEY_SUFFIX}`;
}

export function savePendingSeat(storeId: string, data: PendingSeat): void {
  if (typeof window === "undefined" || !storeId) return;
  try {
    window.localStorage.setItem(keyOf(storeId), JSON.stringify(data));
  } catch {
    /* 配額滿 / 私隱模式：靜靜失敗，店員仍然可以手動點菜 */
  }
}

/** 讀取並**即時刪除**（一次性交接）。超過 10 分鐘視為過期。 */
export function consumePendingSeat(storeId: string): PendingSeat | null {
  if (typeof window === "undefined" || !storeId) return null;
  try {
    const raw = window.localStorage.getItem(keyOf(storeId));
    if (!raw) return null;
    window.localStorage.removeItem(keyOf(storeId));

    const parsed = JSON.parse(raw) as PendingSeat;
    if (!parsed || typeof parsed.reservationId !== "string" || !Array.isArray(parsed.items)) {
      return null;
    }
    const created = new Date(parsed.createdAt).getTime();
    if (!Number.isFinite(created) || Date.now() - created > 10 * 60_000) return null;

    return parsed;
  } catch {
    return null;
  }
}

/** 只讀不刪（除錯 / 判斷有冇待開枱用）。 */
export function peekPendingSeat(storeId: string): PendingSeat | null {
  if (typeof window === "undefined" || !storeId) return null;
  try {
    const raw = window.localStorage.getItem(keyOf(storeId));
    return raw ? (JSON.parse(raw) as PendingSeat) : null;
  } catch {
    return null;
  }
}

export function clearPendingSeat(storeId: string): void {
  if (typeof window === "undefined" || !storeId) return;
  try {
    window.localStorage.removeItem(keyOf(storeId));
  } catch {
    /* noop */
  }
}
