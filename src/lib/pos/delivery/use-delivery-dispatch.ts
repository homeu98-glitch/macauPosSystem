"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DeliveryMode } from "./delivery-mode.ts";
import { resolveDispatchAction, type DispatchActionReason } from "./dispatch-action.ts";
import type { DispatchInput } from "./eligibility.ts";
import { isDeliveryDispatchEnabled } from "./flag.ts";
import { isActiveJobStatus, type PosDeliveryJob } from "./types.ts";

/**
 * 外送派單（前端）—— 三個入口（訂單頁／快餐 strip／外送 tab）共用。
 *
 * ## 🔴 為什麼唔用 Realtime、唔用 polling
 *
 * 用戶 2026-10-31 明確要求：**零 polling、唔可以增加數據用量**。
 * `pos_delivery_jobs` 係 service_role only（前端讀唔到），而且派單狀態本身
 * 唔需要秒級同步（同訂單／枱況唔同）。所以：
 *
 *   ① 只有**第一次**掛載時拉一次（module cache 60 秒內跨 panel 共用）；
 *   ② 之後只有「手動刷新」或者「啱啱存完一張」才會再拉；
 *   ③ 冇 `setInterval`、冇 `subscribe`、冇長連線。
 *
 * 訂單頁同時掛「線上訂單」同「店內訂單」兩個 panel —— 如果各自 fetch 就一頁兩個
 * request。所以 `loadDeliveryJobs()` 做**inflight 去重**：同一間店嘅並行請求
 * 會等同一條 promise。
 *
 * ## fail-closed
 *
 * 未開旗標／未載入／載入失敗 → 冇 job 資料 → `visible()` 只會回 `false` 或者
 * 少一個 `already_dispatched` 判斷。**唔會**因為讀唔到 job 就當成「未派過」
 * 而顯示掣 —— 因為資格本身仲有 `evaluateDispatchEligibility()` 把關，
 * 最壞情況係多一個掣（server 仍然會擋），唔會派錯單。
 */

const CACHE_TTL_MS = 60_000;

type CacheEntry = { at: number; jobs: PosDeliveryJob[] };

const CACHE = new Map<string, CacheEntry>();
const INFLIGHT = new Map<string, Promise<PosDeliveryJob[] | null>>();

export function deliveryJobKey(orderSource: string, orderRef: string): string {
  return `${orderSource}:${orderRef}`;
}

/**
 * 拉一次派單列表（`GET /api/pos/delivery/jobs`）。
 *
 * @param force `true` = 忽略 cache（手動刷新／存完之後）
 * @returns 失敗回 `null`（呼叫端保留舊資料，唔好清空畫面）
 */
export function loadDeliveryJobs(
  storeId: string,
  options?: { force?: boolean },
): Promise<PosDeliveryJob[] | null> {
  const cached = CACHE.get(storeId);
  if (!options?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.jobs);
  }

  const running = INFLIGHT.get(storeId);
  if (running && !options?.force) return running;

  const task = (async (): Promise<PosDeliveryJob[] | null> => {
    try {
      // ⚠️ 唔加 `active=1`：外送 tab 要顯示歷史（已送達／已取消），
      //    而訂單卡只會用 `isActiveJobStatus()` 判斷，兩個用途共用同一份 cache。
      const params = new URLSearchParams({ storeId, limit: "100" });
      const res = await fetch(`/api/pos/delivery/jobs?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { ok?: boolean; jobs?: PosDeliveryJob[] };
      if (!json?.ok || !Array.isArray(json.jobs)) return null;
      CACHE.set(storeId, { at: Date.now(), jobs: json.jobs });
      return json.jobs;
    } catch {
      return null;
    } finally {
      INFLIGHT.delete(storeId);
    }
  })();

  INFLIGHT.set(storeId, task);
  return task;
}

/** 存完一張之後把最新 job 寫入 cache（慳一次 GET）。 */
export function upsertCachedDeliveryJob(storeId: string, job: PosDeliveryJob): void {
  const cached = CACHE.get(storeId);
  if (!cached) return;
  const key = deliveryJobKey(job.orderSource, job.orderRef);
  const jobs = cached.jobs.filter((item) => deliveryJobKey(item.orderSource, item.orderRef) !== key);
  CACHE.set(storeId, { at: cached.at, jobs: [job, ...jobs] });
}

/** 登出／切店時清 cache（避免跨店殘留）。 */
export function clearDeliveryJobCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}

/** 開彈窗需要嘅資料（由各 panel 砌）。 */
export type DeliveryDispatchTarget = {
  orderSource: "ledger" | "pos";
  orderRef: string;
  orderNoSnapshot: string;
  platform?: "aomi" | "mfood" | null;
  deliveryMode: DeliveryMode;
  /** 客付合計（MOP），只係顯示用 */
  totalMop?: number;
  /** 已知嘅客人資料（例如線上單帶入）；平台單多數冇 */
  defaultCustomerName?: string;
  defaultCustomerPhone?: string;
  defaultCustomerAddress?: string;
};

export type DeliveryDispatchVisibility = {
  visible: boolean;
  reason: DispatchActionReason;
};

/**
 * @param options.canDispatch 目前操作員／帳號有冇 `dispatchDelivery` 權限。
 *   `undefined` = 未計算（當有）—— 呼叫端一律應該傳真值入嚟，
 *   咁旗標／權限／資格三層閘就只有一個出口（`resolveDispatchAction`）。
 */
export function useDeliveryDispatch(
  storeId: string | null,
  options?: { canDispatch?: boolean },
) {
  const enabled = isDeliveryDispatchEnabled();
  const [jobs, setJobs] = useState<Record<string, PosDeliveryJob>>({});
  const [target, setTarget] = useState<DeliveryDispatchTarget | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !storeId) return;
    let cancelled = false;
    setLoading(true);
    void loadDeliveryJobs(storeId).then((list) => {
      if (cancelled || !list) {
        if (!cancelled) setLoading(false);
        return;
      }
      const next: Record<string, PosDeliveryJob> = {};
      for (const job of list) next[deliveryJobKey(job.orderSource, job.orderRef)] = job;
      setJobs(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, storeId]);

  const visible = useCallback(
    (input: DispatchInput & { orderSource: "ledger" | "pos"; orderRef: string }): DeliveryDispatchVisibility => {
      const job = jobs[deliveryJobKey(input.orderSource, input.orderRef)];
      const { orderSource: _source, orderRef: _ref, ...eligibility } = input;
      return resolveDispatchAction(
        { ...eligibility, hasActiveDispatch: isActiveJobStatus(job?.status) } as DispatchInput,
        { enabled, canDispatch: options?.canDispatch },
      );
    },
    [enabled, jobs, options?.canDispatch],
  );

  const open = useCallback((next: DeliveryDispatchTarget) => {
    setTarget(next);
  }, []);

  const close = useCallback(() => setTarget(null), []);

  const onSaved = useCallback(
    (job: PosDeliveryJob) => {
      if (storeId) upsertCachedDeliveryJob(storeId, job);
      setJobs((prev) => ({ ...prev, [deliveryJobKey(job.orderSource, job.orderRef)]: job }));
    },
    [storeId],
  );

  const refresh = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const list = await loadDeliveryJobs(storeId, { force: true });
    if (list) {
      const next: Record<string, PosDeliveryJob> = {};
      for (const job of list) next[deliveryJobKey(job.orderSource, job.orderRef)] = job;
      setJobs(next);
    }
    setLoading(false);
  }, [storeId]);

  const jobsList = useMemo(() => Object.values(jobs), [jobs]);

  return { enabled, jobs, jobsList, loading, target, visible, open, close, onSaved, refresh };
}
