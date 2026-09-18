"use client";

import { reopenBadgeLabel } from "@/lib/pos/reopen-badge";

/**
 * 「已返結 ×N」標籤 —— 三個載體共用（訂單列表 / 報表訂單明細 / 訂單詳情）。
 *
 * 【為何做元件而唔係各處自己砌】
 * 文案由 `@/lib/pos/reopen-badge`（純函式，有單測）提供，
 * 但**樣式**如果每個載體自己寫，色系同圓角一定飄。
 * 收埋一個元件，改一次全部跟。
 *
 * 【色系】indigo —— 沿用 `pos-order-filters.ts` 嘅「已返結」狀態色，
 * 唔新增色系（商家睇到嘅「返結」一律係同一隻紫）。
 *
 * 【為何一定要 `×N`】同狀態標籤「已返結」（`status === "reopened"`）區分：
 * 狀態標籤講「而家等重結」，本標籤講「曾經返結過幾多次」。
 * 帶次數就唔會撈亂 —— 尤其重結完之後兩者只剩本標籤。
 */
export function ReopenBadge({
  order,
  size = "sm",
  className = "",
}: {
  order: { reopenCount?: number } | null | undefined;
  /** `sm`（列表，11px）／`md`（詳情，12px）。列表窄，唔可以用 md。 */
  size?: "sm" | "md";
  className?: string;
}) {
  const label = reopenBadgeLabel(order);
  if (!label) return null;

  const sizeClass = size === "md" ? "px-2.5 py-0.5 text-xs" : "px-2 py-0.5 text-[11px]";

  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-indigo-50 font-semibold text-indigo-700 ${sizeClass} ${className}`}
      title="此訂單曾返結（反結賬），金額以最後一次結帳為準"
    >
      {label}
    </span>
  );
}
