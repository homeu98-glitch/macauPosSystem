import { PosOrder } from "@/lib/types";
import { orderSourceLabel, orderSourceOf } from "@/lib/pos/order-source";

/**
 * 訂單來源標記（docs/87 §5.2 · 規格 7）。
 *
 * 三個顯示位：① 訂單頁、② 收銀台快餐單卡片、③ 結帳畫面。
 * 三種下單方式統一用「icon + 文字標籤」格式（圓角藥丸 + 固定字型），排版、間距、字型一致：
 * - pos   → 👤 商家下單（slate）
 * - kiosk → 🖥️ 自助點餐機（indigo）
 * - scan  → 📱 掃碼下單（cyan）
 */
const SOURCE_STYLE: Record<"pos" | "kiosk" | "scan", { icon: string; cls: string }> = {
  pos: { icon: "👤", cls: "bg-slate-100 text-slate-600 ring-1 ring-slate-200" },
  kiosk: { icon: "🖥️", cls: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" },
  scan: { icon: "📱", cls: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200" },
};

export function OrderSourceBadge({
  order,
  className = "",
}: {
  order: Pick<PosOrder, "source">;
  className?: string;
}) {
  const source = orderSourceOf(order);
  const label = orderSourceLabel(source);
  const style = SOURCE_STYLE[source];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls} ${className}`}
    >
      <span aria-hidden="true">{style.icon}</span>
      {label}
    </span>
  );
}
