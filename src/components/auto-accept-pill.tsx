"use client";

/**
 * 「自動接單」開關 pill —— 全站**共用同一個樣式**。
 *
 * 背景：用戶要求「自動接單的兩個 toggle 共用同一個樣子」（訂單頁線上／線下兩卡），
 * 之後再要求快餐點餐介面嘅線下訂單都要有同一粒掣。與其四處複製 JSX，
 * 統一喺呢度定義，改樣式只改一個位。
 *
 * 四個 call site（2026-09-01 用戶確認 4 粒全部對稱顯眼 `contained size="md"`）：
 * 1. 訂單頁 · 線上訂單（`online-orders.tsx`）            → variant="contained" size="md"
 * 2. 訂單頁 · 店內線下訂單（`local-orders-panel.tsx`）   → variant="contained" size="md"
 * 3. 快餐點餐介面 · 線上訂單（`quick-mode-orders-bar`）  → variant="contained" size="md"
 * 4. 快餐點餐介面 · 線下訂單（`quick-mode-orders-bar`）  → variant="contained" size="md"
 *
 * ⚠️ 呢個係**純展示元件**：狀態同讀寫一律由 caller 提供，
 * 因為兩粒掣嘅真源根本唔同，唔可以擺埋一齊：
 * - 線上單  = DB `pos_online_order_settings.auto_accept`（per-store，server 權威；
 *            同步去 Ledger，docs/92）
 * - 自助單  = DB `pos_kiosk_settings.selfOrderAutoAccept`（per-store，全店共用，
 *            **唔對接 Ledger**，docs/87 §11 明確標明範圍外）
 */

type AutoAcceptPillProps = {
  enabled: boolean;
  onChange: (next: boolean) => void;
  /** 預設「自動接單」；自助單 call site 傳「自動接自助單」。 */
  label?: string;
  disabled?: boolean;
  /** 讀取中 / 儲存中：掣停用，並喺 label 後面加細字提示。 */
  busy?: boolean;
  busyHint?: string;
  error?: string | null;
  ariaLabel?: string;
  /**
   * - `contained`：外層有一粒 `bg-slate-100` 藥丸底（訂單頁兩卡用）
   * - `plain`：無底，直接 label + 掣（快餐點餐介面用，慳位）
   */
  variant?: "plain" | "contained";
  /** `sm`（11px，快餐介面）/ `md`（12px，訂單頁）。 */
  size?: "sm" | "md";
};

export function AutoAcceptPill({
  enabled,
  onChange,
  label = "自動接單",
  disabled = false,
  busy = false,
  busyHint,
  error = null,
  ariaLabel,
  variant = "plain",
  size = "md",
}: AutoAcceptPillProps) {
  const contained = variant === "contained";
  const sm = size === "sm";

  const labelClass = sm
    ? "text-[11px] font-medium text-slate-500"
    : "text-xs font-semibold text-slate-600";
  const buttonSizeClass = sm
    ? "rounded-full px-3 py-1 text-[11px] font-semibold"
    : "rounded-full px-3 py-1 text-xs font-semibold";
  const stateClass = enabled
    ? "bg-emerald-600 text-white"
    : contained
      ? "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
      : "bg-slate-100 text-slate-700";

  const inner = (
    <>
      <span className={labelClass}>
        {label}
        {busy && busyHint ? (
          <span className="ml-1 font-normal text-slate-400">{busyHint}</span>
        ) : null}
      </span>
      <button
        aria-label={ariaLabel ?? label}
        aria-pressed={enabled}
        className={`${buttonSizeClass} ${stateClass} disabled:opacity-50`}
        disabled={disabled || busy}
        onClick={() => onChange(!enabled)}
        type="button"
      >
        {enabled ? "開" : "關"}
      </button>
      {error ? <span className="text-[11px] font-semibold text-red-600">· {error}</span> : null}
    </>
  );

  if (contained) {
    return (
      <div className="flex shrink-0 items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5">
        {inner}
      </div>
    );
  }

  return <div className="flex shrink-0 items-center gap-2">{inner}</div>;
}
