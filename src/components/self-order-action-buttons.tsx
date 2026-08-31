"use client";

/**
 * 自助單 draft 確認/拒絕動作按鈕組。
 *
 * 統一規則（避免 3 個 call site 各寫各樣走樣）：
 *   - 確認 = emerald-600 實心（保留向後綠色，廚房單過單嘅主操作）
 *   - 拒絕 = rose-600 實心（取消訂單係破壞性，要紅色警示）
 *   - 兩個掣高度 / 內距 / 圓角 / 字級完全對等（rounded-xl · px-3 · py-2 · text-xs · font-semibold）
 *   - 同時只准操作一邊（pending 時兩邊都 disabled，避免 race）
 *   - flex-1 平分闊度（卡片窄位 / 收銀端 strip 通用）
 *
 * 注意：操作要靠 onConfirm / onReject 回呼（自行調 confirmSelfOrder / rejectSelfOrder），
 * 咁先唔會同 toast 廣播、pos-orders-changed 廣播耦合。
 */

import { useState } from "react";

import { Check, X } from "@/components/icons";

type Action = "confirm" | "reject";

export function SelfOrderActionButtons({
  orderLabel,
  onConfirm,
  onReject,
  size = "md",
}: {
  orderLabel: string;
  onConfirm: () => { ok: boolean; error?: string };
  onReject: () => { ok: boolean; error?: string };
  /** "sm" = 收銀端 strip 用（px-2 py-1.5）；"md" = 訂單頁卡片/彈窗用（px-3 py-2）。 */
  size?: "sm" | "md";
}) {
  const [pending, setPending] = useState<Action | null>(null);

  const padding = size === "sm" ? "px-2 py-1.5" : "px-3 py-2";
  const iconSize = size === "sm" ? 14 : 16;

  const handle = (action: Action, run: () => { ok: boolean; error?: string }) => () => {
    if (pending) return;
    setPending(action);
    // queueMicrotask 確保 pending 已 setState 之後先執行業務邏輯，等 React 排到下一輪 render
    // 咁快速雙擊先會見到 disabled 狀態、唔會兩邊都 fire。
    queueMicrotask(() => {
      try {
        const result = run();
        if (!result.ok) {
          // eslint-disable-next-line no-console
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
        aria-label={`確認自助單 ${orderLabel}`}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 ${padding} text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60`}
        disabled={pending !== null}
        onClick={handle("confirm", onConfirm)}
        type="button"
      >
        <Check size={iconSize} strokeWidth={2.5} />
        <span>{pending === "confirm" ? "確認中…" : "確認出單"}</span>
      </button>
      <button
        aria-label={`拒絕自助單 ${orderLabel}`}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-600 ${padding} text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60`}
        disabled={pending !== null}
        onClick={handle("reject", onReject)}
        type="button"
      >
        <X size={iconSize} strokeWidth={2.5} />
        <span>{pending === "reject" ? "拒絕中…" : "拒絕"}</span>
      </button>
    </>
  );
}
