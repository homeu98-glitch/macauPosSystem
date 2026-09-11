"use client";

import { ReactNode, useEffect, useRef } from "react";

/**
 * 「掃碼新單」提示按落去之後，喺**當前點餐頁面**高亮 + 自動捲到該張訂單卡。
 *
 * 為何要（2026-09-11 用戶要求）：
 *   舊行為撳提示會跳去訂單頁 `/orders?orderId=` 再開「訂單詳情」彈窗 ——
 *   對快餐／自取單（`tableId === "counter"`）尤其擾民：收銀只是想知道「邊張單新到」，
 *   唔想離開點餐頁面、亦唔想開多一個 modal 遮住畫面。
 *   新行為：**留在點餐頁面**，把該張訂單卡圈住 2.4 秒（`noticeFocus`）+ 捲到可見位置。
 *
 * 用法：包住訂單卡（`children`），傳 `focusKey`：
 *   - `null` = 唔高亮；
 *   - 數字 = 高亮序號（每次撳都用新序號 → 同一張卡連撳兩次都會重新捲動／重新閃）。
 *
 * ⚠️ 用 `focusKey` 而唔係 boolean：`true` 連續傳兩次唔會令 `useEffect` 重跑
 * （React 依賴比較），同一張單連撳兩下就會「第二次冇反應」。
 */
export function NoticeFocusCard({
  focusKey,
  className,
  children,
}: {
  focusKey: number | null;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusKey === null) return;
    // `block: "nearest"` 令已經喺畫面內嘅卡唔會無謂跳動（只捲到「最少可見」為止），
    // `inline: "center"` 令快餐橫向 strip 入面嘅卡移入視線中央。
    ref.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [focusKey]);

  const focused = focusKey !== null;

  return (
    <div
      ref={ref}
      className={`${className ?? ""}${
        focused ? " ring-2 ring-orange-500 ring-offset-2 ring-offset-white" : ""
      }`}
    >
      {children}
    </div>
  );
}
