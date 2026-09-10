"use client";

/**
 * 上傳回執帳本（docs/112 L3）——「呢張單係咪真係上咗雲」嘅**可驗證證據**。
 *
 * ## 點解唔可以再用「request 有冇回 200」
 *
 * 舊模型嘅「成功」定義 = `fetch` 冇 throw 且 HTTP 200。但 server 對以下兩種情況
 * 一樣會回 200（甚至明確 `ack(true)`）：
 *   1. incoming 比 row 舊（stale）→ 跳過唔寫；
 *   2. 雲端已終態、incoming 想降級 → 跳過唔寫。
 * 結果 client 會**親手剷走事件**，雲端停留舊狀態，而本地已經冇副本可以重試
 * —— 就係「iPad 顯示已完成、後台顯示未結帳」嘅其中一條主因。
 *
 * 所以本模組改為記「**訂單級狀態一致性**」：
 *   - `push` 回執：server 明確回 `applied:true` 嘅事件 → 記低嗰刻嘅 order.updatedAt + status；
 *   - `verify` 回執：對賬守護 pull 返雲端 row，確認同本地終態一致 → 同樣記低。
 *
 * ## 可驗證式（P0 版本）
 *
 * ```
 * ack != null && ack.orderUpdatedAt === order.updatedAt && ack.status === order.status
 * ```
 *
 * 即「回執係喺本地最後一次改動之後取得嘅，而且狀態一致」。
 * （P1 會加單調 `clientRev` 取代 `orderUpdatedAt` 比對，令本地改動唔會撞同一毫秒都判得準。）
 */

import { useEffect, useState } from "react";

import {
  loadOrders,
  loadQueue,
  loadSyncAcks,
  loadSyncBlocked,
  saveSyncAcks,
  saveSyncBlocked,
  type SyncAckRow,
  type SyncBlockedRow,
} from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { isTerminalOrderStatus } from "@/lib/pos-order-filters";
import { readNetworkOnline } from "@/lib/use-network-online";

/** 健康快照變更事件（單向通知 UI；flush / 守護唔會聽，避免迴圈）。 */
export const SYNC_HEALTH_EVENT = "pos-sync-health-changed";

/** 帳本保留上限（每店）。超出就由最舊 ackedAt 開始剷。 */
const MAX_ACK_ROWS = 800;

/**
 * 健康快照同對賬守護只考慮「近期」終態單。
 *
 * 點解要窗：帳本係新加嘅，上線前已經存在嘅歷史終態單一定冇 ack；
 * 若唔設窗，UI 一開就報「300 張待上傳」，反而冇人信。7 日足夠覆蓋
 * 「後台報表會見到」嘅範圍，亦令一次性自愈嘅工作量有上限。
 */
export const SYNC_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncHealthSnapshot {
  /** 真正會被推送嘅待辦事件。 */
  pending: number;
  /** 退避重試中嘅事件（會自動再試，唔再係永久放棄）。 */
  failed: number;
  /** 本地已終態、但雲端未取得一致確認嘅訂單數（**核心指標**）。 */
  waitingAck: number;
  /** 連續多輪對唔上、已停止自動重試嘅訂單數。 */
  blocked: number;
  /** 單一燈號。 */
  level: "ok" | "pending" | "blocked" | "offline";
  updatedAt: string;
}

export const EMPTY_SYNC_HEALTH: SyncHealthSnapshot = {
  pending: 0,
  failed: 0,
  waitingAck: 0,
  blocked: 0,
  level: "ok",
  updatedAt: "",
};

// ─────────────────────────────────────────────────────────────
// 帳本寫入
// ─────────────────────────────────────────────────────────────

function orderTimeMs(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

/**
 * 呢張單需唔需要追蹤回執？
 *
 * 只追終態單 —— 進行中嘅單（draft / sent_to_kitchen / paid / reopened）
 * 由正常 flush 通道處理，加帳本只會增加噪音。
 */
export function shouldTrackAck(order: PosOrder, nowMs = Date.now()): boolean {
  if (!isTerminalOrderStatus(order.status)) return false;
  const t = orderTimeMs(order);
  if (!t) return false;
  return nowMs - t <= SYNC_HEALTH_WINDOW_MS;
}

/** 由 push / verify 回執寫入一批 ack（同 orderId 覆寫為較新 ackedAt）。 */
export function putSyncAcks(rows: SyncAckRow[]): void {
  if (typeof window === "undefined" || rows.length === 0) return;
  const existing = loadSyncAcks();
  const byId = new Map(existing.map((r) => [r.orderId, r]));
  for (const row of rows) {
    const prev = byId.get(row.orderId);
    if (!prev || Date.parse(row.ackedAt) >= Date.parse(prev.ackedAt)) byId.set(row.orderId, row);
  }
  let next = Array.from(byId.values());
  if (next.length > MAX_ACK_ROWS) {
    next = next.sort((a, b) => Date.parse(b.ackedAt) - Date.parse(a.ackedAt)).slice(0, MAX_ACK_ROWS);
  }
  saveSyncAcks(next);
  broadcastSyncHealth();
}

/** orderId → ack 索引（一次讀取，多次比對）。 */
export function buildAckIndex(): Map<string, SyncAckRow> {
  return new Map(loadSyncAcks().map((r) => [r.orderId, r]));
}

/** 可驗證式：回執係喺本地最後一次改動之後取得，而且狀態一致。 */
export function isOrderAcked(order: PosOrder, index?: Map<string, SyncAckRow>): boolean {
  const ack = (index ?? buildAckIndex()).get(order.id);
  if (!ack) return false;
  return ack.status === order.status && ack.orderUpdatedAt === order.updatedAt;
}

/** 本地已終態但雲端未確認嘅單（＝要對賬嘅工作集）。 */
export function listUnackedTerminalOrders(nowMs = Date.now()): PosOrder[] {
  const index = buildAckIndex();
  return loadOrders().filter((o) => shouldTrackAck(o, nowMs) && !isOrderAcked(o, index));
}

// ─────────────────────────────────────────────────────────────
// 受阻（blocked）
// ─────────────────────────────────────────────────────────────

export function loadBlockedRows(): SyncBlockedRow[] {
  return loadSyncBlocked();
}

/** 標一張單「同步受阻」。同 orderId 覆寫。 */
export function markOrderBlocked(row: SyncBlockedRow): void {
  if (typeof window === "undefined") return;
  const rows = loadSyncBlocked().filter((r) => r.orderId !== row.orderId);
  rows.push(row);
  saveSyncBlocked(rows.slice(-200));
  broadcastSyncHealth();
}

/** 解除受阻（成功 / 用戶手動重試）。 */
export function clearOrderBlocked(orderId: string | string[]): void {
  if (typeof window === "undefined") return;
  const ids = new Set(Array.isArray(orderId) ? orderId : [orderId]);
  const rows = loadSyncBlocked();
  const next = rows.filter((r) => !ids.has(r.orderId));
  if (next.length === rows.length) return;
  saveSyncBlocked(next);
  broadcastSyncHealth();
}

export function clearAllBlocked(): void {
  if (typeof window === "undefined") return;
  if (loadSyncBlocked().length === 0) return;
  saveSyncBlocked([]);
  broadcastSyncHealth();
}

/** 一張單係咪已標受阻（守護用：受阻嘅唔再自動重試）。 */
export function isOrderBlocked(orderId: string): boolean {
  return loadSyncBlocked().some((r) => r.orderId === orderId);
}

// ─────────────────────────────────────────────────────────────
// 健康快照
// ─────────────────────────────────────────────────────────────

/**
 * 計算健康快照（純讀取，唔會寫任何嘢）。
 *
 * ⚠️ 刻意**唔 import `sync-flush`**（避免 cycle：sync-flush 要 import 本模組寫 ack），
 * 所以 pending / failed 直接由 queue 嘅 status 統計 —— 外店 / 無主事件喺 GC 之後
 * 已經係 `skipped`，唔會計入 pending，所以呢個簡化係準確嘅。
 *
 * @param networkOnline 網絡狀態（`readNetworkOnline()`）
 */
export function computeSyncHealth(networkOnline = true): SyncHealthSnapshot {
  if (typeof window === "undefined") return EMPTY_SYNC_HEALTH;
  const queue = loadQueue();
  const pending = queue.filter((e) => e.status === "pending").length;
  const failed = queue.filter((e) => e.status === "failed").length;
  const waitingAck = listUnackedTerminalOrders().length;
  const blocked = loadSyncBlocked().length;

  let level: SyncHealthSnapshot["level"] = "ok";
  // 「離線」只有喺**仲有嘢要傳**嘅時候才值得示警 —— 離線但冇待辦 = 完全正常。
  if (blocked > 0) level = "blocked";
  else if (failed > 0 || pending > 0 || waitingAck > 0) level = networkOnline ? "pending" : "offline";

  return {
    pending,
    failed,
    waitingAck,
    blocked,
    level,
    updatedAt: new Date().toISOString(),
  };
}

/** 廣播健康快照變更（唔會觸發 flush，純 UI 通知）。 */
export function broadcastSyncHealth(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SYNC_HEALTH_EVENT));
}

/**
 * 訂閱同步健康快照（UI 用）。
 *
 * 監聽：隊列變更 / 健康廣播 / 訂單變更 / 網絡狀態 / 15s 兜底。
 * 計算成本極低（純 localStorage 讀取），所以唔怕密。
 */
export function useSyncHealth(): SyncHealthSnapshot {
  const [snapshot, setSnapshot] = useState<SyncHealthSnapshot>(EMPTY_SYNC_HEALTH);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      setSnapshot(computeSyncHealth(readNetworkOnline()));
    };
    refresh();
    const events = [
      "pos-sync-queue-changed",
      SYNC_HEALTH_EVENT,
      "pos-orders-changed",
      "pos-network-status-changed",
      "pos-auth-changed",
    ];
    for (const name of events) window.addEventListener(name, refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      alive = false;
      for (const name of events) window.removeEventListener(name, refresh);
      window.clearInterval(timer);
    };
  }, []);

  return snapshot;
}
