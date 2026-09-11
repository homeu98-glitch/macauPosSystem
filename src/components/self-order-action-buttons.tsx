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
 *   - **視覺尺寸全局一種，唔再按場景分級**（2026-09-11 用戶要求「統一」）：
 *     舊版有 `size="sm" | "md" | "lg"` 三個值（11px / 12px / 14px），令同一粒「接受」
 *     喺卡片、訂單列表、POS 詳情彈窗三個地方大細都唔同。而家寫死
 *     `rounded-xl px-3 py-2 text-xs`，四個 call site 完全一樣。
 *     揀呢個尺寸唔係隨意：`local-orders-panel` 嘅「操作」欄係最窄嘅容器（~163px），
 *     三粒掣（查看／接受／拒絕）每粒 min-content 48px → 48×3 + gap 12 = 156px，
 *     係唯一唔會逼成兩行嘅尺寸；其餘三處容器都比佢闊，跟住佢一定放得落。
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
  fill = true,
}: {
  orderLabel: string;
  onConfirm: () => { ok: boolean; error?: string };
  onReject: () => { ok: boolean; error?: string };
  /**
   * 是否用 `flex-1` 填滿同層剩餘闊度。預設 `true`（卡片 / 表格操作欄都係平分）。
   * ⚠️ 彈窗 action 列係 `flex justify-end`，傳 `false` 先唔會被拉長成整行。
   */
  fill?: boolean;
}) {
  const [pending, setPending] = useState<Action | null>(null);

  // 只有一種尺寸（2026-09-11 統一）：`rounded-xl px-3 py-2 text-xs`。
  // 想改就改呢一行 —— 唔好再引入 per-call-site 嘅 size prop，就係佢令啲掣走樣。
  const sizeClass = "rounded-xl px-3 py-2 text-xs";
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
