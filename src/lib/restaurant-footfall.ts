// Phase B（模塊 5 人流）：本機按澳門日儲存「入店人次」手動記錄。
// 無門口計數硬件，最務實嘅精確化係由店員/老闆喺收銀端記低每日人流，
// 報表按選取範圍累加並計「堂食轉化率 = 覆蓋人數 / 入店人次」。
// 真門口計數器到位後，只要將 loadFootfallAll 換做讀取硬件 / Ledger RPC 即可。

import type { PosOrder } from "@/lib/types";
import { orderMatchesReportRange, type ReportRangeKey } from "@/lib/ledger/report-period";

const FOOT_KEY = "macau-pos-footfall";

function macauDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
}

export function loadFootfallAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FOOT_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveFootfallDay(dateKey: string, n: number): Record<string, number> {
  const all = loadFootfallAll();
  all[dateKey] = Math.max(0, Math.round(n || 0));
  localStorage.setItem(FOOT_KEY, JSON.stringify(all));
  return all;
}

/** 選取範圍涵蓋嘅澳門日 key；"all" 返回 null（＝所有已記錄日子）。 */
export function macauDateKeysInRange(range: ReportRangeKey): string[] | null {
  if (range === "all") return null;
  const now = new Date();
  if (range === "today") return [macauDateKey(now)];
  if (range === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return [macauDateKey(y)];
  }
  const days = range === "7d" ? 7 : 30;
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(macauDateKey(d));
  }
  return keys;
}

/** 選取範圍內累計入店人次。 */
export function footfallTotalInRange(map: Record<string, number>, range: ReportRangeKey): number {
  const keys = macauDateKeysInRange(range);
  if (keys === null) return Object.values(map).reduce((s, v) => s + v, 0);
  return keys.reduce((s, k) => s + (map[k] || 0), 0);
}

/** 可編輯嘅焦點日：昨天範圍記昨天，否則記今天。 */
export function footfallFocusKey(range: ReportRangeKey): string {
  if (range === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return macauDateKey(y);
  }
  return macauDateKey(new Date());
}

/**
 * docs/任務：由訂單自動計算「入店人次」：
 * - 堂食（`tableId !== "counter"`）→ 依 `partySize` 加總。
 * - 快餐 / 外賣 / 自取（`tableId === "counter"`）→ 一張單算 1 個人。
 *
 * 只計已結帳 / 已退款嘅終態單（同 `aggregate()` 嘅營業額口徑一致），排除 cancelled 單。
 * 純參考數字，唔再由使用者手動輸入；如要重啟手動人流可保留舊 localStorage key 但不再依賴。
 */
export function computeFootfallFromOrders(orders: PosOrder[], range: ReportRangeKey): number {
  const terminal = orders.filter(
    (o) => o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded",
  );
  const inRange = terminal.filter((o) => orderMatchesReportRange(o, range));
  let total = 0;
  for (const o of inRange) {
    if (o.tableId === "counter") {
      // 快餐 / 自取 / 外賣：一張單 = 1 個人
      total += 1;
    } else {
      // 堂食：依 partySize，缺省 1 個人（避免 partySize 未填時漏算）
      total += Math.max(1, o.partySize ?? 1);
    }
  }
  return total;
}
