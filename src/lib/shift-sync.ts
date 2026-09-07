/**
 * 開工/收工班次狀態 — 雲端同步層（shift-sync）。
 *
 * 2026-09-07 起，開工/收工狀態唔再淨係 localStorage：`pos_shifts` 表（migration 0023）
 * 係單一真源，透過 /api/pos/shift 讀寫。呢個 module 集中：
 *   1. server active 班次 → 本地 ShiftState 嘅 merge / heal 邏輯（reconcileLocalShift）；
 *   2. 「連續開工超過 10 小時」提醒嘅權威判斷（isShiftOvertimeDue，以 server 時鐘為準）；
 *   3. open / close / ackOvertime 嘅 client fetcher。
 *
 * 設計要點（對應 docs/109-shift-sync-overtime-plan.md）：
 * - 每店同一時間一個 active 班次（DB partial unique index 保證）。
 * - 離線開工照樣本地即時生效，網絡恢復後 reconcile 自動補上雲；
 * - server 有 active 而本地冇／時間唔同 → 以 server 為準（adopt），解決「換機永遠要重新開工」；
 * - 本地已收工但 server 仲 active（上次收工離線）→ 自動補 close（heal），避免另一機又見到已開工。
 */

import { loadShiftState, saveShiftState, type ShiftState } from "@/lib/storage";
import { readNetworkOnline } from "@/lib/use-network-online";

/** 連續開工提醒門檻（10 小時）。 */
export const SHIFT_OVERTIME_MS = 10 * 60 * 60 * 1000;

/** /api/pos/shift 回傳嘅 active 班次（camelCase，對應 route 內 mapRow）。 */
export type ShiftServerActive = {
  id: string;
  storeId: string;
  employeeAccount?: string;
  employeeName?: string;
  openedAt: string;
  openingNote?: string;
  overtimeAckedAt?: string;
  closedAt?: string;
  closingNote?: string;
  actualCash?: number;
  cashDifference?: number;
  summary?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
  return data as T;
}

/** GET /api/pos/shift?storeId= → active 班次 + serverNow（server 時鐘，避免 client clock 偏差）。 */
export async function fetchServerShiftState(storeId: string): Promise<{
  active: ShiftServerActive | null;
  serverNow: string;
}> {
  const res = await fetch(`/api/pos/shift?storeId=${encodeURIComponent(storeId)}`, {
    headers: { "Content-Type": "application/json" },
  });
  const json = await readJsonOrThrow<{ ok?: boolean; active?: ShiftServerActive | null; serverNow?: string }>(
    res,
  );
  return { active: json.active ?? null, serverNow: json.serverNow ?? new Date().toISOString() };
}

/** POST open：回傳 server 最終 active（conflict=true 代表已有另一班次進行中）。 */
export async function serverOpenShift(params: {
  storeId: string;
  openedAt?: string;
  employeeAccount?: string;
  employeeName?: string;
  openingNote?: string;
}): Promise<{ conflict: boolean; active?: ShiftServerActive }> {
  const res = await fetch("/api/pos/shift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", ...params }),
  });
  const json = await readJsonOrThrow<{ ok?: boolean; conflict?: boolean; active?: ShiftServerActive }>(res);
  return { conflict: json.conflict === true, active: json.active };
}

/** POST close：收工（server active 必須存在；冇就返回 false，等 reconcile 自行處理）。 */
export async function serverCloseShift(params: {
  storeId: string;
  closingNote?: string;
  actualCash?: number;
  cashDifference?: number;
  summary?: Record<string, unknown>;
}): Promise<boolean> {
  const res = await fetch("/api/pos/shift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "close", ...params }),
  });
  const json = await readJsonOrThrow<{ ok?: boolean }>(res).catch(() => null);
  return json?.ok === true;
}

/** POST ackOvertime：記錄「取消逾時提醒」。 */
export async function serverAckOvertime(storeId: string): Promise<ShiftServerActive | null> {
  const res = await fetch("/api/pos/shift", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ackOvertime", storeId }),
  });
  const json = await readJsonOrThrow<{ ok?: boolean; active?: ShiftServerActive }>(res).catch(() => null);
  return json?.active ?? null;
}

/** server active row → 本地 ShiftState 形態。代表「開工中」狀態，一律清走上一班殘留
 * （closedAt / closingNote / lastCloseSummary），唔可以由 base 意外帶入。 */
export function serverActiveToLocal(active: ShiftServerActive, base: ShiftState = {}): ShiftState {
  const merged: ShiftState = {
    ...base,
    openedAt: active.openedAt,
    closedAt: undefined,
    openingNote: active.openingNote ?? base.openingNote,
    employeeAccount: active.employeeAccount ?? base.employeeAccount,
    employeeName: active.employeeName ?? base.employeeName,
    overtimeAckedAt: active.overtimeAckedAt,
    serverSynced: true,
  };
  delete merged.closedAt;
  delete merged.closingNote;
  delete merged.lastCloseSummary;
  return merged;
}

/**
 * 「連續開工超過 10 小時」提醒條件（以 server 時間為權威）。
 *
 * 規則：
 *   - 由 openedAt 起計，連續 >= 10 小時；
 *   - 用戶撳「取消（繼續營業）」後（server overtime_acked_at = 嗰刻），
 *     要再累計滿 10 小時先再提醒（now − ackedAt >= 10h）。
 *   - 從未 ack → 當 ref = openedAt（即第一次提醒喺開工滿 10h 時）。
 */
export function isShiftOvertimeDue(
  openedAtIso: string,
  overtimeAckedAtIso: string | undefined,
  serverNowIso: string,
): boolean {
  const now = Date.parse(serverNowIso);
  const opened = Date.parse(openedAtIso);
  if (!Number.isFinite(now) || !Number.isFinite(opened)) return false;
  const ackMs = overtimeAckedAtIso ? Date.parse(overtimeAckedAtIso) : Number.NaN;
  const ref = Number.isFinite(ackMs) ? ackMs : opened;
  return now - opened >= SHIFT_OVERTIME_MS && now - ref >= SHIFT_OVERTIME_MS;
}

export type ReconcileResult =
  | { ok: true; shift: ShiftState; adoptedServer: boolean; serverNow?: string }
  | { ok: false };

/**
 * 本地 ShiftState ↔ server active 班次嘅單向調和（以 server 為權威，但識 heal）。
 *
 * 場景同處理：
 *  1. server 有 active、本地未開工／開工時間唔同 → adopt server（解決換機「又要重新開工」）。
 *  2. server 有 active、本地已收工（closedAt >= server.openedAt）→ 上次收工漏上雲 → 補 close。
 *  3. server 有 active、本地一致 → 只更新 ack / synced 旗標。
 *  4. server 冇 active、本地開工中但未上雲過（serverSynced=false，離線開工）→ 補 open。
 *  5. server 冇 active、本地開工中但曾被 server 承認（serverSynced=true）→ 另一部機已收工 →
 *     本地重置為已收工（防止 reconcile 誤「重新開工」）。
 *  6. 其他（大家都冇 / 本地已收工）→ 冇嘢做。
 *
 * 任何 server call 失敗（離線／500）都唔會郁本地 → 回 { ok:false }，由 caller 下次再試。
 */
export async function reconcileLocalShift(storeId: string): Promise<ReconcileResult> {
  if (!readNetworkOnline()) {
    return { ok: true, shift: loadShiftState(), adoptedServer: false };
  }

  let server: { active: ShiftServerActive | null; serverNow: string };
  try {
    server = await fetchServerShiftState(storeId);
  } catch {
    return { ok: false };
  }
  const serverNow = server.serverNow;
  const local = loadShiftState();

  if (server.active) {
    // 2) 本地已收工但 server 仲 active：先確認「係同一班」先好補 close —
    //    本地收工時間必須唔早於 server 開工時間（close 喺 open 之後先算同一班）。
    const localClosedMs = local.closedAt ? Date.parse(local.closedAt) : Number.NaN;
    const serverOpenedMs = Date.parse(server.active.openedAt);
    if (!local.openedAt && local.closedAt && Number.isFinite(localClosedMs) && Number.isFinite(serverOpenedMs) && localClosedMs >= serverOpenedMs) {
      // 帶埋本地兜底嘅收工統計（lastCloseSummary），server 班次唔會永久缺 summary。
      const healed = await serverCloseShift({
        storeId,
        closingNote: local.closingNote || undefined,
        actualCash: local.actualCash,
        cashDifference: local.cashDifference,
        summary: local.lastCloseSummary,
      }).catch(() => false);
      if (healed && local.lastCloseSummary) {
        const cleared: ShiftState = { ...local, lastCloseSummary: undefined };
        saveShiftState(cleared);
        return { ok: true, shift: cleared, adoptedServer: false, serverNow };
      }
      return { ok: true, shift: local, adoptedServer: false, serverNow };
    }

    // 1) adopt：本地未開工，或者開工時間同 server 唔一致（另一部機／另一個 browser 開咗工）。
    if (!local.openedAt || local.openedAt !== server.active.openedAt) {
      const merged = serverActiveToLocal(server.active, local);
      // adopt 時唔可以帶住舊班次嘅 closingNote（嗰啲屬已收工記錄）。
      delete merged.closingNote;
      delete merged.closedAt;
      saveShiftState(merged);
      return { ok: true, shift: merged, adoptedServer: true, serverNow };
    }

    // 3) 一致：只同步 ack / synced 旗標。
    if (local.overtimeAckedAt !== server.active.overtimeAckedAt || !local.serverSynced) {
      const merged: ShiftState = { ...local, overtimeAckedAt: server.active.overtimeAckedAt, serverSynced: true };
      saveShiftState(merged);
      return { ok: true, shift: merged, adoptedServer: false, serverNow };
    }
    return { ok: true, shift: local, adoptedServer: false, serverNow };
  }

  // server 冇 active：
  if (!local.openedAt || local.closedAt) {
    return { ok: true, shift: local, adoptedServer: false, serverNow }; // 5) 無嘢做
  }
  // ⚠️ 本地開工中 + server 冇 active，要分兩種：
  //   - serverSynced = true（開工曾被 server 承認）：好可能係另一部機收咗工 → 唔可以補 open
  //     （否則會「死灰復燃」重新開工）；應將本地重置為已收工。
  //   - serverSynced = false：真正離線開工未上雲 → 補 open。
  if (local.serverSynced) {
    const merged: ShiftState = {
      ...local,
      openedAt: undefined,
      closedAt: new Date().toISOString(),
      serverSynced: true,
    };
    saveShiftState(merged);
    return { ok: true, shift: merged, adoptedServer: false, serverNow };
  }
  // 4) 離線開工 → 補 open。
  try {
    const opened = await serverOpenShift({
      storeId,
      openedAt: local.openedAt,
      employeeAccount: local.employeeAccount,
      employeeName: local.employeeName,
      openingNote: local.openingNote,
    });
    const synced: ShiftState = { ...local, overtimeAckedAt: opened.active?.overtimeAckedAt ?? local.overtimeAckedAt, serverSynced: true };
    // server 已有另一 active（conflict，極少見：server 資料比本地新）→ 用 server 時間覆寫。
    if (opened.conflict && opened.active) {
      const merged = serverActiveToLocal(opened.active, local);
      delete merged.closedAt;
      delete merged.closingNote;
      saveShiftState(merged);
      return { ok: true, shift: merged, adoptedServer: true, serverNow };
    }
    saveShiftState(synced);
    return { ok: true, shift: synced, adoptedServer: false, serverNow };
  } catch {
    return { ok: false };
  }
}
