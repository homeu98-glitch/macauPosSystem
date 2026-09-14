"use client";

/**
 * 預約單（Ledger `scheduled_pickup_at`）嘅**共用顯示元件**。
 *
 * 三處（線上訂單列表 / 訂單詳情 / 快餐面板卡片）一定要用同一支，
 * 否則就會出現「列表寫『預約單』、卡片寫『預訂』」呢類口徑分叉
 * （同 `orderCodeLabel` / `formatSpecLine` 一樣嘅教訓）。
 *
 * 判定與狀態一律來自 `@/lib/pos/scheduled-pickup`（純函式、有單測），
 * 呢度只負責排版。冇有效預約時間 → 回傳 `null`，caller 直接 render 個 null
 * 就等於「呢張單唔係預約單」，唔會留空白行／空 label。
 */

import { formatMacauDateTime, formatMacauMonthDayTime } from "@/lib/format";
import { normalizeLedgerStatus } from "@/lib/ledger/order-mapper";
import {
  isScheduledOrder,
  scheduledPickupChipBadge,
  scheduledPickupChipText,
  scheduledPickupKind,
  scheduledPickupMinutesUntil,
  scheduledPickupRelativeText,
  scheduledPickupTimeClass,
} from "@/lib/pos/scheduled-pickup";

type ScheduledLike =
  | { scheduledPickupAt?: string | null; status?: string | null }
  | null
  | undefined;

/**
 * 訂單係唔係**已完結**（唔應該再出「逾時」警示）。
 *
 * 🔴 2026-09-14 商家實案：14:54 睇一張 12:15 預約、狀態「已完成」嘅單，列表仍然紅色
 * 「已逾時 159 分鐘」—— 單都做完收咗錢，逾時資訊已經冇意義（仲要搶注意力）。
 *
 * 判斷口徑：
 * - Ledger 狀態一律經 `normalizeLedgerStatus()`（唯一真源）→ `completed` / `cancelled` 算完結。
 * - 本地終態（`settled` / `refunded` / `partially_refunded`）一併認，防日後有 caller
 *   餵 `PosOrder` 入嚟（Ledger 口徑唔包含呢幾個值）。
 */
export function isClosedScheduledOrder(order: ScheduledLike): boolean {
  const raw = String(order?.status ?? "").toLowerCase();
  if (raw === "settled" || raw === "refunded" || raw === "partially_refunded") return true;
  const normalized = normalizeLedgerStatus(raw);
  return normalized === "completed" || normalized === "cancelled";
}

/** 呢張單係唔係預約單（UI 入口統一由呢度問，唔好自己 `if (order.scheduledPickupAt)`）。 */
export function hasScheduledPickup(order: ScheduledLike): boolean {
  return isScheduledOrder(order);
}

/**
 * 「預約單」藥丸標籤。
 *
 * @param nowMs 由 caller 傳入（同一次 render 內所有卡片應該用同一個時鐘值，
 *              否則同一版會有卡片「快到了」、有卡片「已逾時」）。
 */
export function ScheduledPickupChip({
  order,
  nowMs,
  compact = false,
}: {
  order: ScheduledLike;
  nowMs: number;
  /** 快餐面板／列表窄欄用：細一級字。 */
  compact?: boolean;
}) {
  // 已完結單（已完成／已取消）→ `closed`，唔會再出「快到了／已逾時」。
  const kind = scheduledPickupKind(order?.scheduledPickupAt, nowMs, undefined, isClosedScheduledOrder(order));
  if (!kind) return null;
  const badge = scheduledPickupChipBadge(kind);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-semibold ${badge.bgClass} ${badge.textClass} ${
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-[11px]"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${badge.dotClass}`} />
      {scheduledPickupChipText(kind)}
    </span>
  );
}

/**
 * 預約時間一行文字：`預約 09/14 12:15`／`預約 12:15 · 18 分鐘後`／`預約 12:15 · 已逾時 8 分鐘`。
 *
 * 口徑同「會員通」收據一致（短格式 `MM/DD HH:MM`）；`full` 用喺訂單詳情（連年份）。
 */
export function ScheduledPickupTimeText({
  order,
  nowMs,
  full = false,
  className = "",
}: {
  order: ScheduledLike;
  nowMs: number;
  /** `true` = `2026-09-14 12:15`（詳情用）；`false` = `09/14 12:15`（列表／卡片用）。 */
  full?: boolean;
  className?: string;
}) {
  const iso = order?.scheduledPickupAt;
  const kind = scheduledPickupKind(iso, nowMs, undefined, isClosedScheduledOrder(order));
  if (!kind || !iso) return null;
  const timeText = full ? formatMacauDateTime(iso) : formatMacauMonthDayTime(iso);
  // ⚠️ `closed` 同 `full` 一樣唔出相對時間：單已完結，冇必要再講「已逾時 N 分鐘」。
  const relative =
    full || kind === "closed" ? "" : scheduledPickupRelativeText(scheduledPickupMinutesUntil(iso, nowMs));
  return (
    <span className={`tabular-nums ${scheduledPickupTimeClass(kind)} ${className}`.trim()}>
      {full ? `預約時間：${timeText}` : `預約 ${timeText}`}
      {relative ? ` · ${relative}` : ""}
    </span>
  );
}
