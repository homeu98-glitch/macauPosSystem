"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { orderItemKey } from "@/lib/pos/order-item-diff";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import { getPosRealtimeConfig } from "@/lib/pos/supabase-client";
import {
  describePosRealtimeProbe,
  isPosRealtimeHealthy,
  probePosRealtimeTarget,
  type PosRealtimeProbe,
} from "@/lib/pos/realtime-target";
import type { PosOrder } from "@/lib/types";
import { buildKdsBoard, kdsStateKey } from "./kds-board.ts";
import type { PrintZone } from "./stations.ts";
import type { KdsBoardOrder, KdsBoardOrderInput, KdsItemStateRow, KdsStationOption } from "./types.ts";
import { useKdsRealtime, type KdsRealtimeItemStateRow } from "./use-kds-realtime.ts";

/**
 * 後廚屏嘅資料層（docs/116 §4.5）。
 *
 * ## 即時性三件套（缺一就會「永遠要 reload 先見到」）
 *
 * 1. **重連後補拉** —— `onResubscribed` → `refresh()`。
 *    iPad 休眠 / 轉 Wi-Fi 之後 Realtime 只會重新 `SUBSCRIBED`，
 *    **唔會補發睡眠期間嘅事件**。唔補拉就永遠少幾單。
 * 2. **樂觀 UI** —— 撳 ✓ 即刻本地 +1（`markItem`），POST 失敗才回滾 + 紅橫幅。
 *    唔樂觀嘅話每次撳都有 100~300ms 延遲感 → 同事以為撳唔到 → 重複撳。
 * 3. **看門狗** —— `visibilitychange → visible` 補拉；Realtime 靜咗 > 60 秒
 *    而屏上仲有未完成 → **單發**補拉（唔係 loop 輪詢）。
 *
 * ## 砌板用「同一份純函式」
 *
 * 本地用 `buildKdsBoard()`（同 server 端一模一樣嗰份）即時重算，
 * 所以撳 ✓／收 Realtime 都**唔使再打 REST**。呢個係唔可以「server 砌一次、
 * client 又砌一次」嘅原因 —— 兩套邏輯一定會分歧。
 */

/** 未上雲嘅行：本地已改，等 server 確認。 */
type PumpSlot = { running: boolean; dirty: boolean };

export interface KdsBoardApi {
  orders: KdsBoardOrder[];
  stations: KdsStationOption[];
  /** server 時鐘（計時器基準）→ 轉成 `clockOffsetMs` 用。 */
  clockOffsetMs: number;
  loading: boolean;
  loadError: string | null;
  /** `"kds_state_table_missing"` = migration 0033 未跑，撳 ✓ 唔會 persist。 */
  degraded: string | null;
  connected: boolean;
  realtimeProbe: PosRealtimeProbe | null;
  realtimeHint: string | null;
  realtimeHealthy: boolean | null;
  /** 有幾多行本地改咗但未確認（處理緊）。 */
  inFlightCount: number;
  /** 儲存失敗嘅次數（已經回滾，屏上顯示嘅係雲端實際狀態）。 */
  failedCount: number;
  lastError: string | null;
  lastEventAt: number | null;
  markItem: (orderId: string, itemKey: string, doneQty: number) => void;
  refresh: () => void;
}

const WATCHDOG_INTERVAL_MS = 15_000;
const WATCHDOG_STALE_MS = 60_000;

export function useKdsBoard(options: {
  storeId: string | null;
  station: string | null;
  enabled: boolean;
}): KdsBoardApi {
  const { storeId, station, enabled } = options;

  const [bundles, setBundles] = useState<KdsBoardOrderInput[]>([]);
  const [stateMap, setStateMap] = useState<Map<string, KdsItemStateRow>>(() => new Map());
  const [sources, setSources] = useState<{
    printZones: PrintZone[];
    printerGroups: string[];
    menuItemGroups: string[];
  }>({ printZones: [], printerGroups: [], menuItemGroups: [] });
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [realtimeProbe, setRealtimeProbe] = useState<PosRealtimeProbe | null>(null);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  // ── refs：非同步回調要讀「最新值」，唔可以靠 closure 捕獲嘅舊 state ──
  const storeIdRef = useRef(storeId);
  const stationRef = useRef(station);
  const bundlesRef = useRef(bundles);
  const stateMapRef = useRef(stateMap);
  const confirmedRef = useRef(new Map<string, number>());
  const optimisticRef = useRef(new Map<string, number>());
  const pumpRef = useRef(new Map<string, PumpSlot>());
  const inFlightRef = useRef(new Set<string>());
  const lastEventAtRef = useRef<number | null>(null);

  // ⚠️ 呢個 effect 一定要排喺所有「用到呢啲 ref」嘅 effect 之前（effect 依宣告次序執行）。
  //    唔可以喺 render 期間直接寫 ref（`react-hooks/refs` 會報錯，而且係真 bug：
  //    render 可能被丟棄／重跑，寫落去嘅值未必對應最後一次 commit）。
  useEffect(() => {
    storeIdRef.current = storeId;
    stationRef.current = station;
    bundlesRef.current = bundles;
    stateMapRef.current = stateMap;
  });

  const realtimeHint = realtimeProbe ? describePosRealtimeProbe(realtimeProbe) : null;
  const realtimeHealthy = realtimeProbe ? isPosRealtimeHealthy(realtimeProbe) : null;

  // ───────────────────────────── 拉板 ─────────────────────────────
  const refresh = useCallback(async () => {
    const sid = storeIdRef.current;
    if (!sid) {
      setLoading(false);
      return;
    }
    try {
      const headers = await posDeviceAuthHeadersFresh();
      const qs = new URLSearchParams({ storeId: sid });
      if (stationRef.current) qs.set("station", stationRef.current);
      const res = await fetch(`/api/pos/kds/board?${qs.toString()}`, { headers, cache: "no-store" });
      const payload = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            serverTime?: string;
            orders?: KdsBoardOrderInput[];
            states?: KdsItemStateRow[];
            /** 🔴 分區真源（商家自己設定嘅打印分區）。 */
            printZones?: PrintZone[];
            /** 舊來源，只做 fallback。 */
            printerGroups?: string[];
            menuItemGroups?: string[];
            degraded?: string;
          }
        | null;

      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `讀取後廚單失敗（${res.status}）`);
      }

      setBundles(Array.isArray(payload.orders) ? payload.orders : []);
      setSources({
        // 分區真源：商家自己設定嘅打印分區
        printZones: Array.isArray(payload.printZones) ? payload.printZones : [],
        printerGroups: Array.isArray(payload.printerGroups) ? payload.printerGroups : [],
        menuItemGroups: Array.isArray(payload.menuItemGroups) ? payload.menuItemGroups : [],
      });
      setDegraded(payload.degraded ?? null);

      // ⚠️ 計時器基準：iPad 時鐘會飄，一定要用 server 時間做基準。
      if (payload.serverTime) {
        const serverMs = Date.parse(payload.serverTime);
        if (Number.isFinite(serverMs)) setClockOffsetMs(serverMs - Date.now());
      }

      // 合併狀態：**未確認嘅本地改動唔可以被蓋走**，否則撳完 ✓ 會彈返轉頭
      const next = new Map<string, KdsItemStateRow>();
      for (const row of payload.states ?? []) {
        const key = kdsStateKey(row.order_id, row.item_key);
        next.set(key, row);
        if (!inFlightRef.current.has(key)) confirmedRef.current.set(key, row.done_qty);
      }
      for (const key of inFlightRef.current) {
        const local = stateMapRef.current.get(key);
        if (local) next.set(key, local);
      }
      stateMapRef.current = next;
      setStateMap(next);

      setLoadError(null);
      lastEventAtRef.current = Date.now();
      setLastEventAt(lastEventAtRef.current);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "讀取後廚單失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  // 第一次入場（或者換店 / 換工位）即刻拉
  useEffect(() => {
    if (!enabled || !storeId) return;
    setLoading(true);
    void refresh();
  }, [enabled, storeId, station, refresh]);

  // ── R1 健康檢查：一次性 REST 探測，證明 Realtime 指向正確專案 ──
  // 唔做呢步就會出現「channel SUBSCRIBED、但永遠冇事件」嘅靜默失效（docs/113）。
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void probePosRealtimeTarget(getPosRealtimeConfig()).then((probe) => {
      if (!cancelled) setRealtimeProbe(probe);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // ────────────────────── 樂觀 UI：撳 ✓ ──────────────────────
  const pump = useCallback(async (key: string, orderId: string, itemKey: string) => {
    const slot = pumpRef.current.get(key);
    if (slot?.running) {
      // 已經跑緊 → 只標記 dirty，等佢跑完再送最後嗰個值（合併連續快撳）
      slot.dirty = true;
      return;
    }
    const s: PumpSlot = { running: true, dirty: false };
    pumpRef.current.set(key, s);

    try {
      do {
        s.dirty = false;
        const target = optimisticRef.current.get(key) ?? 0;
        const sid = storeIdRef.current;
        if (!sid) throw new Error("未綁定店鋪");

        const res = await fetch("/api/pos/kds/items", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await posDeviceAuthHeadersFresh()) },
          body: JSON.stringify({ storeId: sid, orderId, itemKey, doneQty: target }),
        });
        const payload = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; item?: { doneQty?: number } }
          | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `儲存失敗（${res.status}）`);
        }

        // 用 server 回嘅權威值對齊（server 會 clamp 落 [0, quantity]）
        const serverDone = Number(payload.item?.doneQty ?? target);
        confirmedRef.current.set(key, serverDone);
        optimisticRef.current.set(key, serverDone);
        const m = new Map(stateMapRef.current);
        m.set(key, { order_id: orderId, item_key: itemKey, done_qty: serverDone });
        stateMapRef.current = m;
        setStateMap(m);
      } while (s.dirty);

      inFlightRef.current.delete(key);
      setInFlightCount(inFlightRef.current.size);
    } catch (error) {
      // 🔴 一定要回滾。屏上留住一個「做咗」而雲端唔知 = 最難 debug 嘅靜默不一致。
      const confirmed = confirmedRef.current.get(key) ?? 0;
      optimisticRef.current.set(key, confirmed);
      const m = new Map(stateMapRef.current);
      m.set(key, { order_id: orderId, item_key: itemKey, done_qty: confirmed });
      stateMapRef.current = m;
      setStateMap(m);
      inFlightRef.current.delete(key);
      setInFlightCount(inFlightRef.current.size);
      setFailedCount((n) => n + 1);
      setLastError(error instanceof Error ? error.message : "儲存失敗");
    } finally {
      s.running = false;
      pumpRef.current.delete(key);
    }
  }, []);

  const markItem = useCallback(
    (orderId: string, itemKey: string, doneQty: number) => {
      const key = kdsStateKey(orderId, itemKey);
      const target = Math.max(0, Math.trunc(doneQty));

      // ① 即刻本地套用（樂觀）
      optimisticRef.current.set(key, target);
      const m = new Map(stateMapRef.current);
      const prev = m.get(key) ?? { order_id: orderId, item_key: itemKey, done_qty: 0 };
      m.set(key, { ...prev, done_qty: target });
      stateMapRef.current = m;
      setStateMap(m);

      // ② 標記「未確認」→ refresh 合併時唔會被蓋走
      inFlightRef.current.add(key);
      setInFlightCount(inFlightRef.current.size);

      void pump(key, orderId, itemKey);
    },
    [pump],
  );

  // ─────────────────── Realtime（增量）───────────────────
  // 睇門狗②要用到「屏上仲有幾多張未完成」，用 ref 讀（唔想每次資料變都重建 interval）
  const ordersRef = useRef<KdsBoardOrder[]>([]);
  const upsertOrder = useCallback((order: PosOrder) => {
    lastEventAtRef.current = Date.now();
    setLastEventAt(lastEventAtRef.current);
    const next: KdsBoardOrderInput = {
      order,
      itemKeys: (order.items ?? []).map(orderItemKey),
    };
    setBundles((prev) => {
      const idx = prev.findIndex((b) => b.order.id === order.id);
      if (idx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const upsertItemState = useCallback((row: KdsRealtimeItemStateRow) => {
    const orderId = String(row.order_id ?? "");
    const itemKey = String(row.item_key ?? "");
    if (!orderId || !itemKey) return;
    const key = kdsStateKey(orderId, itemKey);
    // 本地有未確認改動 → 唔好被（可能係舊嘅）server 事件蓋走
    if (inFlightRef.current.has(key)) return;
    const doneQty = Number(row.done_qty ?? 0);
    if (!Number.isFinite(doneQty)) return;

    confirmedRef.current.set(key, doneQty);
    optimisticRef.current.set(key, doneQty);
    const m = new Map(stateMapRef.current);
    m.set(key, { order_id: orderId, item_key: itemKey, done_qty: doneQty });
    stateMapRef.current = m;
    setStateMap(m);
    lastEventAtRef.current = Date.now();
    setLastEventAt(lastEventAtRef.current);
  }, []);

  const deleteItemState = useCallback((row: KdsRealtimeItemStateRow) => {
    const orderId = String(row.order_id ?? "");
    const itemKey = String(row.item_key ?? "");
    if (!orderId || !itemKey) return;
    const key = kdsStateKey(orderId, itemKey);
    confirmedRef.current.delete(key);
    optimisticRef.current.delete(key);
    const m = new Map(stateMapRef.current);
    m.delete(key);
    stateMapRef.current = m;
    setStateMap(m);
    lastEventAtRef.current = Date.now();
    setLastEventAt(lastEventAtRef.current);
  }, []);

  useKdsRealtime(storeId, enabled, {
    onOrderUpsert: upsertOrder,
    onItemStateUpsert: upsertItemState,
    onItemStateDelete: deleteItemState,
    onStatusChange: (status) => setConnected(status === "SUBSCRIBED"),
    // 🔴 重連之後一定要補拉（Realtime 唔會補發睡眠期間嘅事件）
    onResubscribed: () => void refresh(),
  });

  // ── 看門狗①：回到前景補拉 ──
  useEffect(() => {
    if (!enabled || !storeId) return;
    const handler = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [enabled, storeId, refresh]);

  // ── 看門狗②：Realtime 靜咗 > 60 秒而仲有未完成 → 單發補拉（唔係 polling）──
  useEffect(() => {
    if (!enabled || !storeId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (ordersRef.current.length === 0) return;
      const last = lastEventAtRef.current;
      if (last !== null && Date.now() - last < WATCHDOG_STALE_MS) return;
      void refresh();
    }, WATCHDOG_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, storeId, refresh]);

  // ── 本地砌板（同 server 同一份純函式）──
  const statesArray = useMemo(() => [...stateMap.values()], [stateMap]);
  const board = useMemo(
    () =>
      buildKdsBoard({
        orders: bundles,
        states: statesArray,
        // ⚠️ 唔傳 allowAllStations：產品上唔存在「全部」模式。
        //    station 係 null 時 buildKdsBoard 會回空 orders（只回 stations 畀「揀崗位」用）。
        station,
        printZones: sources.printZones,
        printerGroups: sources.printerGroups,
        menuItemGroups: sources.menuItemGroups,
      }),
    [bundles, statesArray, station, sources],
  );

  useEffect(() => {
    ordersRef.current = board.orders;
  }, [board.orders]);

  return {
    orders: board.orders,
    stations: board.stations,
    clockOffsetMs,
    loading,
    loadError,
    degraded,
    connected,
    realtimeProbe,
    realtimeHint,
    realtimeHealthy,
    inFlightCount,
    failedCount,
    lastError,
    lastEventAt,
    markItem,
    refresh: () => void refresh(),
  };
}
