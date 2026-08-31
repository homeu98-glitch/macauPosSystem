import { PosOrder } from "@/lib/types";
import { orderSourceLabel, orderSourceOf } from "@/lib/pos/order-source";

/**
 * 訂單來源標記（docs/87 §5.2 · 規格 7）。
 *
 * 三個顯示位：① 訂單頁、② 收銀台快餐單卡片、③ 結帳畫面。
 * 收銀台落單（`source === "pos"`）**唔顯示**任何嘢——標記只係用嚟區分自助單，
 * 全部單都標只會令畫面嘈。
 */
export function OrderSourceBadge({
  order,
  className = "",
}: {
  order: Pick<PosOrder, "source">;
  className?: string;
}) {
  const source = orderSourceOf(order);
  if (source === "pos") return null;
  const label = orderSourceLabel(source);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        source === "kiosk"
          ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200"
          : "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200"
      } ${className}`}
    >
      {source === "kiosk" ? "🖥️" : "📱"}
      {label}
    </span>
  );
}
