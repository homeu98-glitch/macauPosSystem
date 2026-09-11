"use client";

/**
 * 自助單 draft「接受 / 拒絕」動作按鈕組。
 *
 * 全 app 唯一出處（避免多個 call site 各寫各樣走樣）：快餐卡片、訂單列表、查看彈窗、
 * 訂單頁彈窗都係用呢個元件，所以文字 / 顏色 / 圓角 / 間距語意一定一致。
 *
 * 統一規則：
 *   - 接受 = emerald-600 實心（廚房單過單嘅主操作）
 *   - 拒絕 = rose-600 實心（取消訂單係破壞性，要紅色警示）
 *   - **純文字、冇 icon、`whitespace-nowrap`**（2026-09-11 修）：
 *     舊版標籤係「確認出單」（4 字）＋ Check/X icon ＋ `gap-1.5`，令每粒掣嘅 min-content
 *     闊到 ~58px；訂單列表「操作」欄喺窄容器下只有 ~163px，三粒掣（查看／確認出單／拒絕）
 *     合計 ~176px 放唔落 → 逼成兩行（「確認／出單」、「拒／絕」）。
 *     改成 2 字純文字後 min-content 得 48px，一行放得落。
 *   - **pending 期間刻意唔換文字**（只 `disabled` + `opacity-60`）：換成「接受中…」會令掣
 *     闊多 24px，喺「剛剛好放得落」嘅欄位會即時逼出換行 —— 正正就係要修嘅症狀。
 *   - 同時只准操作一邊（pending 時兩邊都 `disabled`，避免 race）。
 *
 * 注意：操作要靠 onConfirm / onReject 回呼（自行調 confirmSelfOrder / rejectSelfOrder），
 * 咁先唔會同 toast 廣播、pos-orders-changed 廣播耦合。
 */

import { useState } from "react";

type Action = "confirm" | "reject";

export function SelfOrderActionButtons({
  orderLabel,
  onConfirm,
  onReject,
  size = "md",
  fill = true,
}: {
  orderLabel: string;
  onConfirm: () => { ok: boolean; error?: string };
  onReject: () => { ok: boolean; error?: string };
  /**
   * "sm" = 快餐卡片 / 收銀端 strip（px-2 py-1.5 text-[11px]）；
   * "md" = 訂單列表 / 訂單頁彈窗（px-3 py-2 text-xs）；
   * "lg" = POS「訂單詳情」彈窗（px-4 py-2 text-sm，同隔離嘅關閉 / 重打單同一尺寸）。
   */
  size?: "sm" | "md" | "lg";
  /**
   * 是否用 `flex-1` 填滿同層剩餘闊度。預設 `true`（卡片 / 表格操作欄都係平分）。
   * ⚠️ 彈窗 action 列係 `flex justify-end`，傳 `false` 先唔會被拉長成整行。
   */
  fill?: boolean;
}) {
  const [pending, setPending] = useState<Action | null>(null);

  // 三種 size 都必須「一行過」→ 一齊加 whitespace-nowrap；size 只影響字級 / 內距 / 圓角。
  const sizeClass =
    size === "sm"
      ? "rounded-xl px-2 py-1.5 text-[11px]"
      : size === "lg"
        ? "rounded-2xl px-4 py-2 text-sm"
        : "rounded-xl px-3 py-2 text-xs";
  const growClass = fill ? "flex-1" : "";
  const buttonClass = `flex items-center justify-center font-semibold text-white whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60 ${growClass} ${sizeClass}`;

  const handle = (action: Action, run: () => { ok: boolean; error?: string }) => () => {
    if (pending) return;
    setPending(action);
    // queueMicrotask 確保 pending 已 setState 之後先執行業務邏輯，等 React 排到下一輪 render
    // 咁快速雙擊先會見到 disabled 狀態、唔會兩邊都 fire。
    queueMicrotask(() => {
      try {
        const result = run();
        if (!result.ok) {
          console.warn(`[SelfOrderActionButtons] ${action} 失敗：${result.error ?? "unknown"}`);
        }
      } finally {
        setPending(null);
      }
    });
  };

  return (
    <>
      <button
        aria-busy={pending === "confirm"}
        aria-label={`接受自助單 ${orderLabel}`}
        className={`${buttonClass} bg-emerald-600 hover:bg-emerald-700`}
        disabled={pending !== null}
        onClick={handle("confirm", onConfirm)}
        type="button"
      >
        接受
      </button>
      <button
        aria-busy={pending === "reject"}
        aria-label={`拒絕自助單 ${orderLabel}`}
        className={`${buttonClass} bg-rose-600 hover:bg-rose-700`}
        disabled={pending !== null}
        onClick={handle("reject", onReject)}
        type="button"
      >
        拒絕
      </button>
    </>
  );
}
