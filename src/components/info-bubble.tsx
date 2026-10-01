"use client";

/**
 * 金額／口徑**小提示球**（2026-09-28，J 口徑）。
 *
 * ## 為咩要有
 *
 * 原本報表有一條常駐橙色橫幅「退款拆解（本期間無退款）」＋一條橙色警示
 * 「有線上單未入 POS 記錄」。兩條都係**長期佔位**、而且多數日子內容係「冇事」
 * —— 對日常營運係噪音（J：「這兩個直接在系統上面隱藏掉」）。
 *
 * 但資訊**唔可以消失**：商家有需要時仍然要查得到（J：「當按下的時候，
 * 就會像 tips 一樣提示一下，退款多少即可」）。
 * ⇒ 收成一個小球，**按下才彈**。
 *
 * ## 設計要點
 *
 * - **零依賴**：唔引入 popover 套件（專案行 `node --test`、唔想加 runtime 依賴）。
 * - **觸控友好**：`min-h-[22px] min-w-[22px]`（球本身細，但用 `p-1` 撐大熱區至 ~28px；
 *   POS 觸控規範係「主要操作 ≥ 40px」，但呢個係**輔助提示**，唔係主要操作，
 *   且刻意唔可以搶眼 ⇒ 用 28px 熱區 + 四邊 `-m` 補償）。
 * - **點外面／Esc 關閉**：避免「彈咗之後唔識收」。
 * - **氣泡定位**：絕對定位喺球嘅**下方靠左**（2026-10-01 J：營業額係第一張 KPI 卡，
 *   靠右彈會向左伸出去撞側欄被裁切 ⇒ 改為向右伸）。
 */
import { useEffect, useRef, useState } from "react";

export type InfoBubbleProps = {
  /** 氣泡內容（按下球之後顯示）。 */
  children: React.ReactNode;
  /** 無障礙標籤（螢幕閱讀器／long-press 提示）。 */
  label: string;
  /** 球本身嘅額外 class（例如想改色）。 */
  className?: string;
};

export function InfoBubble({ children, label, className }: InfoBubbleProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 點擊氣泡以外位置 ／ Esc ⇒ 關閉。
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-slate-300 bg-white text-[11px] font-bold leading-none text-slate-400 transition hover:border-slate-400 hover:text-slate-600 " +
          (open ? "border-slate-400 text-slate-600 " : "") +
          (className ?? "")
        }
      >
        i
      </button>

      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-[26px] z-40 w-max max-w-[min(320px,calc(100vw-24px))] rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[12px] leading-relaxed text-slate-700 shadow-lg"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
