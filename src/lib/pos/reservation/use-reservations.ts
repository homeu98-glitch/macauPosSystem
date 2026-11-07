"use client";

/**
 * 訂位資料 hooks —— POS 前端唯一的資料入口。
 *
 * ## 為什麼係手動拉而唔係 Realtime
 *
 * 訂位變更頻率低（一間店一日十幾張），開一條常駐 channel 的成本遠高於收益。
 * 所以：**進頁拉一次 + 操作後局部更新 + 手動刷新**，同「外送」tab 同一口徑。
 *
 * ## 為什麼錯誤要分 `code`
 *
 * `tableReady:false`（未跑 migration）同「網絡失敗」對店員嘅意義完全唔同：
 * 前者要叫技術人員跑 SQL，後者叫佢檢查網絡。UI 必須分開顯示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  PosReservation,
  ReservationRange,
  ReservationSettings,
  SlotUsage,
} from "@/lib/pos/reservation/types";
import type { DaySlot } from "@/lib/pos/reservation/slots";

export type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * 寬鬆 JSON 讀取。
 *
 * ⚠️ 唔可以用 `Promise<T & Partial<ApiError>>` —— `T` 帶 `ok: true` 同 `ok: false`
 * 交叉會收斂成 `never`，之後所有 `json.xxx` 都報錯。所以回一個寬鬆 record，
 * 由呼叫方按需斷言。
 */
type JsonAny = Record<string, unknown> & { ok?: boolean; error?: string; tableReady?: boolean };

async function readJson(res: Response): Promise<JsonAny> {
  const json = (await res.json().catch(() => null)) as JsonAny | null;
  return json ?? { ok: false, error: `HTTP ${res.status}` };
}

/** 訂位設置。 */
export function useReservationSettings(storeId: string | null) {
  const [settings, setSettings] = useState<ReservationSettings | null>(null);
  const [tableReady, setTableReady] = useState(true);
  const [exists, setExists] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!storeId) return;
    setState("loading");
    setError(null);
    try {
      const res = await fetch(`/api/pos/reservation-settings?storeId=${encodeURIComponent(storeId)}`, {
        cache: "no-store",
      });
      const json = await readJson(res);
      if (!alive.current) return;
      if (!json.ok) {
        setError(json.error ?? "讀取設定失敗");
        setState("error");
        return;
      }
      setSettings(json.settings as ReservationSettings);
      setTableReady(json.tableReady !== false);
      setExists(json.exists === true);
      setState("ready");
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "讀取設定失敗");
      setState("error");
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: Partial<ReservationSettings>): Promise<{ ok: boolean; error?: string }> => {
      if (!storeId) return { ok: false, error: "缺少 storeId" };
      try {
        const res = await fetch("/api/pos/reservation-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeId, settings: next }),
        });
        const json = await readJson(res);
        if (!json.ok) return { ok: false, error: json.error ?? "儲存失敗" };
        setSettings(json.settings as ReservationSettings);
        setExists(true);
        setTableReady(true);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "儲存失敗" };
      }
    },
    [storeId],
  );

  return { settings, tableReady, exists, state, error, reload: load, save };
}

/** 訂位列表（按範圍）。 */
export function useReservations(storeId: string | null, range: ReservationRange) {
  const [reservations, setReservations] = useState<PosReservation[]>([]);
  const [tableReady, setTableReady] = useState(true);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!storeId) return;
    setState("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/pos/reservations?storeId=${encodeURIComponent(storeId)}&range=${range}`,
        { cache: "no-store" },
      );
      const json = await readJson(res);
      if (!alive.current) return;
      if (!json.ok) {
        setError(json.error ?? "讀取訂位失敗");
        setState("error");
        return;
      }
      setReservations((json.reservations ?? []) as PosReservation[]);
      setTableReady(json.tableReady !== false);
      setState("ready");
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : "讀取訂位失敗");
      setState("error");
    }
  }, [storeId, range]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  return {
    reservations,
    tableReady,
    state,
    error,
    reload: load,
    refresh: () => setTick((v) => v + 1),
    /** 局部更新（操作成功後即刻反映，不用等下一次拉取）。 */
    patchLocal: useCallback((id: string, patch: Partial<PosReservation>) => {
      setReservations((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    }, []),
    removeLocal: useCallback((id: string) => {
      setReservations((prev) => prev.filter((row) => row.id !== id));
    }, []),
  };
}

/** 某營業日的時段餘量。 */
export function useReservationSlots(storeId: string | null, date: string | null) {
  const [slots, setSlots] = useState<DaySlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{
    bizDate: string;
    quota: number;
    turnMinutes: number;
    enabled: boolean;
    emptyReason?: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ storeId });
      if (date) qs.set("date", date);
      const res = await fetch(`/api/pos/reservations/slots?${qs.toString()}`, { cache: "no-store" });
      const json = await readJson(res);
      if (!json.ok) {
        setSlots([]);
        return;
      }
      setSlots((json.slots ?? []) as DaySlot[]);
      setMeta({
        bizDate: String(json.bizDate ?? date ?? ""),
        quota: Number(json.quota ?? 0),
        turnMinutes: Number(json.turnMinutes ?? 90),
        enabled: json.enabled !== false,
        emptyReason: typeof json.emptyReason === "string" ? json.emptyReason : undefined,
      });
    } catch {
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [storeId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  return { slots, meta, loading, reload: load };
}

/** 把列表按營業日分組（7 天內 / 30 天內 用）。 */
export function groupByBizDate(reservations: readonly PosReservation[]): Array<{
  bizDate: string;
  rows: PosReservation[];
  groups: number;
  guests: number;
  pending: number;
}> {
  const map = new Map<string, PosReservation[]>();
  for (const row of reservations) {
    const list = map.get(row.bizDate) ?? [];
    list.push(row);
    map.set(row.bizDate, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bizDate, rows]) => ({
      bizDate,
      rows: rows.sort((a, b) => a.slotAt.localeCompare(b.slotAt)),
      groups: rows.filter((r) => r.status !== "canceled" && r.status !== "no_show").length,
      guests: rows
        .filter((r) => r.status !== "canceled" && r.status !== "no_show")
        .reduce((sum, r) => sum + r.partySize, 0),
      pending: rows.filter((r) => r.status === "pending").length,
    }));
}

/** 今日統計（訂位台頂部）。 */
export function summarize(reservations: readonly PosReservation[]) {
  const active = reservations.filter((r) => r.status !== "canceled");
  return {
    groups: active.length,
    guests: active.reduce((sum, r) => sum + r.partySize, 0),
    pending: reservations.filter((r) => r.status === "pending").length,
    arrived: reservations.filter((r) => r.status === "arrived").length,
    prepaid: reservations.filter((r) => r.paidAmount > 0).length,
    noShow: reservations.filter((r) => r.status === "no_show").length,
  };
}

/** 給呼叫方用的空 usage（避免每次 render 新陣列）。 */
export const EMPTY_USAGE: readonly SlotUsage[] = [];
