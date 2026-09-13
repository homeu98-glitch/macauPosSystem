// Phase B（模塊 5 人流）：本機按澳門日儲存「入店人次」手動記錄。
// 無門口計數硬件，最務實嘅精確化係由店員/老闆喺收銀端記低每日人流，
// 報表按選取範圍累加並計「堂食轉化率 = 覆蓋人數 / 入店人次」。
// 真門口計數器到位後，只要將 loadFootfallAll 換做讀取硬件 / Ledger RPC 即可。

import type { PosOrder } from "@/lib/types";
import { orderMatchesReportRange, splitReportRangeArg, type ReportRangeArg } from "@/lib/ledger/report-period";
import { macauDateKeyOf } from "@/lib/ledger/date-range";

// 🛡️ 加固（db review §4.2 #5）：人流記錄改為 per-store。
// 舊 key `macau-pos-footfall` 係全局共用，多店環境會互相覆蓋。新寫入按
// `macau-pos/stores/{merchantId}/footfall` 隔離；storeId 缺省時退回舊全局 key，
// 保留歷史手動記錄唔會遺失。
const FOOT_KEY_GLOBAL = "macau-pos-footfall";

function footKey(storeId?: string | null): string {
  return storeId ? `macau-pos/stores/${storeId}/footfall` : FOOT_KEY_GLOBAL;
}

function macauDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
}

export function loadFootfallAll(storeId?: string | null): Record<string, number> {
  try {
    const raw = localStorage.getItem(footKey(storeId));
    if (!raw && storeId) {
      // 新店首次：退回舊全局 key 嘅資料（若曾經全局記過），唔強制隔離令舊數消失
      const legacy = localStorage.getItem(FOOT_KEY_GLOBAL);
      if (legacy) {
        const v = JSON.parse(legacy);
        return v && typeof v === "object" ? (v as Record<string, number>) : {};
      }
    }
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveFootfallDay(dateKey: string, n: number, storeId?: string | null): Record<string, number> {
  const all = loadFootfallAll(storeId);
  all[dateKey] = Math.max(0, Math.round(n || 0));
  localStorage.setItem(footKey(storeId), JSON.stringify(all));
  return all;
}

/** 選取範圍涵蓋嘅澳門日 key；"all" 或未套用嘅 "custom" 返回 null（＝所有已記錄日子）。
 *
 * ⚠️ 2026-09-13：加「自訂」支援。自訂區間會展開成逐日 key（含頭含尾），
 * 安全上限 366 日，避免用戶揀咗 10 年區間時產生巨大陣列。
 */
export function macauDateKeysInRange(range: ReportRangeArg): string[] | null {
  const { key, custom } = splitReportRangeArg(range);
  if (key === "all") return null;

  if (key === "custom") {
    if (!custom) return null;
    const keys: string[] = [];
    const start = new Date(`${custom.start}T00:00:00+08:00`);
    const end = new Date(`${custom.end}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    for (let d = start, i = 0; d.getTime() <= end.getTime() && i < 366; i++) {
      const k = macauDateKeyOf(d);
      if (k) keys.push(k);
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
    return keys;
  }

  const now = new Date();
  if (key === "today") return [macauDateKey(now)];
  if (key === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return [macauDateKey(y)];
  }
  const days = key === "7d" ? 7 : 30;
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(macauDateKey(d));
  }
  return keys;
}

/** 選取範圍內累計入店人次。 */
export function footfallTotalInRange(map: Record<string, number>, range: ReportRangeArg): number {
  const keys = macauDateKeysInRange(range);
  if (keys === null) return Object.values(map).reduce((s, v) => s + v, 0);
  return keys.reduce((s, k) => s + (map[k] || 0), 0);
}

/** 可編輯嘅焦點日：昨天範圍記昨天、自訂記結束日，否則記今天。 */
export function footfallFocusKey(range: ReportRangeArg): string {
  const { key, custom } = splitReportRangeArg(range);
  if (key === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return macauDateKey(y);
  }
  if (key === "custom" && custom) return custom.end;
  return macauDateKey(new Date());
}

/**
 * docs/任務：由訂單自動計算「入店人次」：
 * - 堂食（`tableId !== "counter"`）→ 依 `partySize` 加總。
 * - 快餐 / 外賣 / 自取（`tableId === "counter"`）→ 一張單算 1 個人。
 *
 * 口徑同報表 `isSaleCountable()` 一致：settled / paid 都計（paid = Ledger 線上單同步入嚟嘅狀態），
 * refunded / partially_refunded 一律唔計，cancelled / 進行中單（open / sent_to_kitchen）唔計。
 * 純參考數字，唔再由使用者手動輸入；如要重啟手動人流可保留舊 localStorage key 但不再依賴。
 */
export function computeFootfallFromOrders(orders: PosOrder[], range: ReportRangeArg): number {
  const countable = orders.filter((o) => o.status === "settled" || o.status === "paid");
  const inRange = countable.filter((o) => orderMatchesReportRange(o, range));
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
