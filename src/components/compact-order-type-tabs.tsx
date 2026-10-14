"use client";

import { useState } from "react";

import { useT } from "@/components/lang-provider";

/**
 * 快餐點餐 · 訂單類型（堂食／外賣／自取）—— **小平板專用 icon 收合列**。
 *
 * ## 為咩要有呢個（2026-10-14 HUAWEI MatePad SE 10.4" 實測）
 *
 * 舊版三粒 pill 橫排喺 166px 闊嘅訂單明細欄入面：
 * · 中文「堂食／外賣／自取」11.5px 粗體各 **23px** —— 放得落，但**成個欄只用到 61% 寬度**，
 *   下面嘅「訂單明細 N 項」清單空間長期被浪費。
 * · 英文 `Dine-in 38px / Takeaway 50px / Pickup 35px` —— 每粒格得 45px，
 *   `Takeaway` 會**逐字斷行**變 `Tak-ea-wa-y`（2026-10-13 實測 sw 84 / cw 44）。
 *
 * 新設計（`min-[900px]` 生效，`lg` 以上走原本三粒 pill）：
 * 1. **預設全部收合**成 3 粒 30px icon（闊 98px），
 * 2. **同一時間只展開一粒** —— 撳邊粒嗰粒先展開成「icon + 完整文字」，
 *    再撳同一粒就收合。展開闊度用 `max-width` 動畫（180ms）。
 *
 * ### 英文最長情況會唔會爆（2026-10-14 真 Chrome 量度）
 * 展開粒 = icon 14 + gap 4 + `Takeaway` 50 + padding 12 = **80px**；
 * 兩粒收合 = 60px；間距 8px ⇒ 合計 **148px**，欄闊 166px ⇒ **仲有 18px 餘裕**。
 * 萬一將來譯文再長：`max-width: 120px` 會截尾 + `title` tooltip 出全名（唔會撐爆欄）。
 *
 * ⚠️ **iPad／桌面零改動**：本元件只喺 `min-[900px] … lg` 之間顯示；
 *    `lg` 以上由 `pos-app.tsx` 原本嗰個 `grid-cols-3` 三粒中文 pill 負責。
 */

const ORDER_TYPES = [
  {
    id: "dine_in",
    label: "堂食",
    icon: (
      <svg
        aria-hidden
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        height="14"
        stroke="currentColor"
        strokeLinecap="round"
        viewBox="0 0 24 24"
        width="14"
      >
        <path d="M7 3v8a3 3 0 0 0 6 0V3M10 11v10" />
        <path d="M17 3c-1.5 2-2 4-2 6s.5 3 2 3 2-1 2-3-.5-4-2-6zM17 12v9" />
      </svg>
    ),
  },
  {
    id: "delivery",
    label: "外賣",
    icon: (
      <svg
        aria-hidden
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        height="14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        width="14"
      >
        <path d="M6 7h12l1 14H5L6 7z" />
        <path d="M9 7V5a3 3 0 0 1 6 0v2" />
      </svg>
    ),
  },
  {
    id: "pickup",
    label: "自取",
    icon: (
      <svg
        aria-hidden
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        height="14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        width="14"
      >
        <path d="M3 7h13v11H3zM16 10h3l2 3v5h-5z" />
        <circle cx="7" cy="20" r="1.5" />
        <circle cx="17" cy="20" r="1.5" />
      </svg>
    ),
  },
] as const;

export type CompactOrderTypeId = (typeof ORDER_TYPES)[number]["id"];

/** 展開粒文字嘅最大闊度（px）。超過就截尾 + tooltip。 */
const LABEL_MAX_WIDTH = 120;

export function CompactOrderTypeTabs({
  value,
  onChange,
}: {
  value: CompactOrderTypeId;
  onChange: (next: CompactOrderTypeId) => void;
}) {
  const t = useT();
  /**
   * 展開邊一粒；`null` = 全部收合（預設）。
   * 🔴 呢個係**純顯示狀態**，刻意唔跟 `value` 自動展開：咁樣撳完一粒之後就再收唔返
   *    （用戶想自己控制欄位幾時闊、幾時窄）。
   */
  const [expandedId, setExpandedId] = useState<CompactOrderTypeId | null>(null);

  return (
    <div
      aria-label={t("訂單類型")}
      className="mt-2 flex items-center gap-1"
      role="group"
    >
      {ORDER_TYPES.map((type) => {
        const active = type.id === value;
        const expanded = type.id === expandedId;
        const label = t(type.label);
        return (
          <button
            aria-expanded={expanded}
            aria-label={label}
            className={`flex h-[30px] shrink-0 items-center gap-1 overflow-hidden rounded-full border px-[7px] text-[11.5px] font-semibold transition-colors duration-200 ${
              active
                ? "border-orange-500 bg-orange-500 text-white"
                : "border-slate-200 bg-white text-slate-700"
            }`}
            key={type.id}
            onClick={() => {
              onChange(type.id);
              setExpandedId((prev) => (prev === type.id ? null : type.id));
            }}
            style={{ maxWidth: expanded ? LABEL_MAX_WIDTH + 16 : 30 }}
            title={label}
            type="button"
          >
            {type.icon}
            <span
              className="block whitespace-nowrap transition-[max-width,opacity] duration-200"
              style={{
                maxWidth: expanded ? LABEL_MAX_WIDTH : 0,
                opacity: expanded ? 1 : 0,
              }}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}