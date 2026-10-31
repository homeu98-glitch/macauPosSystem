"use client";

import { useEffect, useMemo, useState } from "react";

import {
  platformSourceOf,
  type DeliveryMode,
} from "./delivery-mode.ts";
import { isDeliveryDispatchEnabled } from "./flag.ts";

/**
 * 平台單配送方式（前端）。
 *
 * ## 為什麼係 hook 而唔係逐個 component fetch
 *
 * 訂單頁、快餐 strip、外送 tab 都會問同一個問題：「呢張平台單有冇派送掣？」
 * 如果各自 fetch，一頁會打三次 API。呢個 hook：
 *   ① 用 module-level cache（`Map`）跨 component 共用；
 *   ② 只會問「cache 未見過嘅 id」，已經問過嘅唔會再打；
 *   ③ **冇 interval、冇 polling** —— 每次 ids 組合改變只打一次（失敗重試一次）。
 *
 * ## 為什麼只傳 id、唔傳 raw_json
 *
 * raw payload 成 KB；呢支 API 只回 enum（幾十 bytes）。詳見
 * `src/app/api/pos/delivery/modes/route.ts`。
 *
 * ## fail-closed
 *
 * 未載入／載入失敗／未開功能旗標 → 回 `{}`。
 * 呼叫端當「冇 mode」= unknown = 唔顯示派送掣。寧願少一個掣，唔好重複派車手。
 */

const CACHE = new Map<string, DeliveryMode>();
/** 已經試過但失敗嘅 id（避免同一個 id 無限重試）。 */
const FAILED = new Set<string>();

function cacheKey(storeId: string, id: string): string {
  return `${storeId}:${id}`;
}

export type DeliveryModeOrderLike = {
  id: string;
  source?: string | null;
};

export function usePlatformDeliveryModes(
  storeId: string | null,
  orders: readonly DeliveryModeOrderLike[],
): Record<string, DeliveryMode> {
  const enabled = isDeliveryDispatchEnabled();
  const [version, setVersion] = useState(0);

  // 只挑「平台單 + cache 未見過 + 未失敗過」嘅 id
  const missingIds = useMemo(() => {
    if (!enabled || !storeId) return [] as string[];
    const ids: string[] = [];
    for (const order of orders) {
      if (!platformSourceOf(order?.source)) continue;
      const key = cacheKey(storeId, order.id);
      if (CACHE.has(key) || FAILED.has(key)) continue;
      ids.push(order.id);
      if (ids.length >= 100) break;
    }
    return ids;
  }, [enabled, storeId, orders]);

  // 用字串做 dependency：`orders` 每次都係新 array，直接用會不停 re-run
  const idsKey = missingIds.join(",");

  useEffect(() => {
    if (!enabled || !storeId || !idsKey) return;

    const ids = idsKey.split(",");
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function load(attempt: number) {
      try {
        const params = new URLSearchParams({
          storeId: storeId as string,
          ids: ids.join(","),
        });
        const res = await fetch(`/api/pos/delivery/modes?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          modes?: Record<string, DeliveryMode>;
        };
        if (cancelled) return;
        if (!json?.ok || !json.modes) throw new Error("bad response");

        for (const [id, mode] of Object.entries(json.modes)) {
          CACHE.set(cacheKey(storeId as string, id), mode);
        }
        setVersion((v) => v + 1);
      } catch {
        if (cancelled) return;
        if (attempt === 0) {
          // 只重試一次（3 秒後）；之後標記失敗，唔會再打
          retryTimer = setTimeout(() => void load(1), 3_000);
          return;
        }
        for (const id of ids) FAILED.add(cacheKey(storeId as string, id));
      }
    }

    void load(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, storeId, idsKey]);

  return useMemo(() => {
    const out: Record<string, DeliveryMode> = {};
    if (!storeId) return out;
    for (const order of orders) {
      const mode = CACHE.get(cacheKey(storeId, order.id));
      if (mode) out[order.id] = mode;
    }
    return out;
    // version 只係用嚟喺 fetch 完成後強制重算（cache 唔係 reactive）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, orders, version]);
}

/** 測試／登出時清 cache（避免跨店殘留）。 */
export function clearDeliveryModeCache(): void {
  CACHE.clear();
  FAILED.clear();
}
