/**
 * 零售掛單 / 取單 —— **純函式，零 runtime 依賴**。
 *
 * 【為何零售需要掛單】
 * 客人行到一半去攞多件貨、或者要返車攞錢 → 收銀員要**暫存當前購物車**、
 * 先招呼下一位。冇掛單就只能口頭記住或者取消重掃（極易漏單）。
 *
 * 【為何獨立於餐飲嘅掛單】
 * 餐飲 `PosOrder` 掛單要入 orders + 上雲 + 佔桌台；零售掛單**淨係本機暫存**，
 * 唔算營業額、唔上雲、唔出票。夾硬用同一套會令報表多出一堆「幽靈單」。
 *
 * 🔴 **唔可以污染營業額**：掛單一律**唔入 `orders`**，只落獨立 store key。
 * 呢個模組出嘅 `RetailHoldOrder` 冇任何欄位會被 `isSaleCountable()` 見到。
 */

import type { RetailCartLine } from "./retail-cart.ts";
import { retailOrderTotals, type RetailDiscountRule } from "./retail-cart.ts";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

/**
 * 一張掛單。
 *
 * ⚠️ `lines` 直接存整個購物車（含 `lineId`）—— 取單時要**原樣還原**，
 * 否則店員之前改嘅折扣 / 改價會消失（客人會即時發現價錢唔同）。
 */
export interface RetailHoldOrder {
  id: string;
  /** 顯示用短號（例如「掛-01」） */
  label: string;
  lines: RetailCartLine[];
  /** 整單折扣（如果有） */
  orderDiscount?: RetailDiscountRule;
  /** 掛單時嘅應收（快照，供列表顯示；取單時會用 lines 重算） */
  total: number;
  itemCount: number;
  note?: string;
  /** 掛單時間（ISO） */
  createdAt: string;
}

/** 上限：太多掛單會令收銀員搵唔到，亦會令 localStorage 膨脹 */
export const MAX_HOLD_ORDERS = 20;

export interface CreateHoldInput {
  lines: readonly RetailCartLine[];
  orderDiscount?: RetailDiscountRule;
  note?: string;
  /** 注入時間（測試用；缺省 = now） */
  now?: Date;
  /** 注入 id 產生器（測試用） */
  makeId?: (seq: number) => string;
}

export type CreateHoldResult =
  | { ok: true; hold: RetailHoldOrder; holds: RetailHoldOrder[] }
  | { ok: false; reason: string; holds: RetailHoldOrder[] };

/**
 * 新增一張掛單。
 *
 * 🔴 空購物車唔可以掛 —— 否則列表會出現一堆「$0.00」嘅空掛單，店員要逐個刪。
 * 🔴 到上限要**明確拒絕**並講原因，唔可以靜默丟棄最舊嘅（會漏單）。
 */
export function createHoldOrder(
  holds: readonly RetailHoldOrder[],
  input: CreateHoldInput,
): CreateHoldResult {
  const list = [...(holds ?? [])];
  const lines = (input.lines ?? []).filter((l) => l && l.quantity > 0);

  if (lines.length === 0) {
    return { ok: false, reason: "購物車係空 → 冇嘢可以掛", holds: list };
  }
  if (list.length >= MAX_HOLD_ORDERS) {
    return {
      ok: false,
      reason: `掛單已達上限（${MAX_HOLD_ORDERS} 張）→ 請先取單或者刪除舊掛單`,
      holds: list,
    };
  }

  const seq = nextHoldSeq(list);
  const totals = retailOrderTotals(lines, input.orderDiscount);
  const at = input.now ?? new Date();
  const hold: RetailHoldOrder = {
    id: input.makeId ? input.makeId(seq) : `hold-${at.getTime().toString(36)}-${seq}`,
    label: `掛-${String(seq).padStart(2, "0")}`,
    lines: lines.map((l) => ({ ...l })),
    ...(input.orderDiscount ? { orderDiscount: input.orderDiscount } : {}),
    total: round2(totals.total),
    itemCount: lines.reduce(
      (s, l) => s + (l.isWeighed ? 1 : Math.max(0, l.quantity)),
      0,
    ),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    createdAt: at.toISOString(),
  };

  return { ok: true, hold, holds: [...list, hold] };
}

/**
 * 下一個掛單序號。
 *
 * ⚠️ 由現有 label 反推 `max+1`，唔用 `list.length + 1` ——
 * 刪咗中間一張之後，`length+1` 會**重複派號**（掛-02 出現兩次，店員分唔清）。
 */
export function nextHoldSeq(holds: readonly RetailHoldOrder[]): number {
  let max = 0;
  for (const h of holds ?? []) {
    const m = /^掛-(\d+)$/.exec(h.label ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** 取單（移除掛單，回傳剩低嘅；呼叫端負責將 lines 載入購物車） */
export function takeHoldOrder(
  holds: readonly RetailHoldOrder[],
  id: string,
): { hold: RetailHoldOrder | null; holds: RetailHoldOrder[] } {
  const list = holds ?? [];
  const hold = list.find((h) => h.id === id) ?? null;
  if (!hold) return { hold: null, holds: [...list] };
  return { hold, holds: list.filter((h) => h.id !== id) };
}

export function removeHoldOrder(
  holds: readonly RetailHoldOrder[],
  id: string,
): RetailHoldOrder[] {
  return (holds ?? []).filter((h) => h.id !== id);
}

export function renameHoldOrder(
  holds: readonly RetailHoldOrder[],
  id: string,
  note: string,
): RetailHoldOrder[] {
  const t = (note ?? "").trim();
  return (holds ?? []).map((h) =>
    h.id === id ? { ...h, note: t || undefined } : h,
  );
}

/**
 * 掛單排序：**最新掛嘅排最前**（收銀員最常取返啱啱掛嗰張）。
 * 同時間（ISO 字串相同）→ 按 label 降序，保證穩定。
 */
export function sortHolds(holds: readonly RetailHoldOrder[]): RetailHoldOrder[] {
  return [...(holds ?? [])].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.label < b.label ? 1 : -1;
  });
}

/** 掛單摘要（列表用；唔顯示 `id`，商家唔應該見到內部 id） */
export function describeHold(hold: RetailHoldOrder): string {
  const bits = [`${hold.itemCount} 件`, `$${round2(hold.total).toFixed(2)}`];
  return bits.join(" · ");
}

/**
 * 清理殘留掛單 —— 掛單係本機暫存，跨日唔應該留住
 * （隔日店員見到一堆舊掛單會混亂，亦可能誤取到昨日嘅車）。
 */
export function pruneStaleHolds(
  holds: readonly RetailHoldOrder[],
  opts: { maxAgeHours?: number; now?: Date } = {},
): { holds: RetailHoldOrder[]; removed: string[] } {
  const hours = Number.isFinite(opts.maxAgeHours) && (opts.maxAgeHours ?? 0) > 0 ? opts.maxAgeHours! : 24;
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - hours * 3600 * 1000;
  const kept: RetailHoldOrder[] = [];
  const removed: string[] = [];
  for (const h of holds ?? []) {
    const t = Date.parse(h.createdAt);
    if (!Number.isFinite(t) || t < cutoff) removed.push(h.label || h.id);
    else kept.push(h);
  }
  return { holds: kept, removed };
}
