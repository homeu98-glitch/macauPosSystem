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
 * - **觸控友好**：`h-[22px] w-[22px]`（球本身細，但用 `p-1` 撐大熱區至 ~28px；
 *   POS 觸控規範係「主要操作 ≥ 40px」，但呢個係**輔助提示**，唔係主要操作，
 *   且刻意唔可以搶眼 ⇒ 用 28px 熱區 + 四邊 `-m` 補償）。
 * - **點外面／Esc 關閉**：避免「彈咗之後唔識收」。
 *
 * ## 🔴 自動定位（2026-10-07）
 *
 * 原本氣泡寫死 `absolute left-0 top-[26px]`（永遠喺球下面靠左）。
 * 實拍證實：KPI 卡**右上角**嘅球（營業額／客單價／毛利）本身就貼住卡片右緣，
 * 氣泡向右伸展 ⇒ **超出螢幕右邊界被切走**，商家見唔到內容。
 *
 * 而家改成：量度實際錨點座標 ＋ 可視範圍（含 safe area／visual viewport），
 * 交畀純函式 `computeTooltipPlacement()`（`src/lib/pos/tooltip-placement.ts`，
 * 有獨立守衛測試）決定：
 *
 *   預設（下方靠左）→ 唔啱就**改為向左伸展**（右側錨點）→ 再唔啱就**翻到上面**
 *   → 仲唔啱就**夾入**可視區（先水平、後垂直）。
 *
 * ⚠️ 氣泡用 `position: fixed` + 由 JS 計好嘅 `left/top`（唔再靠 Tailwind 定位 class），
 *    因為夾位係按**實際量到嘅闊高**計，class 表達唔到。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  computeTooltipPlacement,
  readTooltipViewport,
  type TooltipPlacement,
} from "@/lib/pos/tooltip-placement";

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
  /**
   * 氣泡落位。`null` ＝ 未量到（闔埋 render，避免用錯位閃一格）。
   * 用 `useLayoutEffect` 量度 ⇒ 計算喺**繪製之前**完成，使用者見唔到跳位。
   */
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

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

  // 闔埋時清走落位（下次彈出要由零重算 —— 錨點可能已經換位／換頁）。
  useEffect(() => {
    if (!open) setPlacement(null);
  }, [open]);

  /** 量錨點 ＋ 氣泡自身尺寸 ⇒ 重算落位。 */
  const reposition = useCallback(() => {
    const root = rootRef.current;
    const bubble = bubbleRef.current;
    if (!root || !bubble) return;
    // 氣泡闔住（display:none / 未有寬高）就唔好計 —— 會用 0 高度計出錯位。
    const bubbleWidth = bubble.offsetWidth;
    const bubbleHeight = bubble.offsetHeight;
    if (bubbleWidth <= 0 || bubbleHeight <= 0) return;
    setPlacement(
      computeTooltipPlacement({
        anchor: root.getBoundingClientRect(),
        bubble: { width: bubbleWidth, height: bubbleHeight },
        viewport: readTooltipViewport(),
      }),
    );
  }, []);

  // 彈出嘅瞬間（繪製前）就定位好。
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition, children]);

  // 彈住期間：捲動／旋轉／鍵盤彈起（visual viewport 變化）都要跟住重算。
  useEffect(() => {
    if (!open) return;
    const onViewportChange = () => reposition();
    // `true` = capture，咁樣內部任何可捲動容器捲動都收得到（氣泡唔會「甩低」）。
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
    return () => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }, [open, reposition]);

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
          ref={bubbleRef}
          role="tooltip"
          /* 落位由 JS 按實測尺寸計；未量到之前唔好畫（`invisible` 唔佔位）。 */
          style={{
            position: "fixed",
            left: placement ? `${placement.left}px` : undefined,
            top: placement ? `${placement.top}px` : undefined,
            maxWidth: placement ? `${placement.maxWidth}px` : undefined,
            maxHeight: placement ? `${placement.maxHeight}px` : undefined,
            visibility: placement ? "visible" : "hidden",
          }}
          className="z-50 w-max overflow-y-auto rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[12px] leading-relaxed text-slate-700 shadow-lg"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
