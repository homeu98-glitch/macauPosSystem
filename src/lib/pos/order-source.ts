import { PosOrder } from "@/lib/types";

/**
 * 訂單來源（docs/87 §5.2 · 規格 7）：區分「自助點餐機 / 客人掃碼」定係「員工喺 POS 落單」。
 *
 * DB 欄位：`pos_orders.source text NOT NULL DEFAULT 'pos'`（migration 0015）。
 * 三個值：
 * - `"pos"`   — 員工喺收銀台落單（預設，存量單全部係呢個）
 * - `"kiosk"` — 自助點餐機落單
 * - `"scan"`  — 客人掃碼落單（手機 `/menu`）
 */
export type OrderSource = NonNullable<PosOrder["source"]>;

/** 來源標籤。收銀台落單（`pos`）回傳空字串——唔使顯示標記，避免畫面嘈。 */
export function orderSourceLabel(source: OrderSource | undefined | null): string {
  if (source === "kiosk") return "自助點餐機";
  if (source === "scan") return "掃碼落單";
  return "";
}

/** 係咪「自助單」（自助點餐機 / 掃碼）。用嚟決定出單流程同顯示。 */
export function isSelfOrder(order: Pick<PosOrder, "source">): boolean {
  return order.source === "kiosk" || order.source === "scan";
}

/** 正常化讀取：DB 可能冇值（舊資料 / migration 未跑），一律當 `"pos"`。 */
export function orderSourceOf(order: Pick<PosOrder, "source">): OrderSource {
  return order.source === "kiosk" || order.source === "scan" ? order.source : "pos";
}
