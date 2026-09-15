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
  /**
   * - `xs`（11px label / 12px 掣面，約 80 × 40px）：**精簡版**，
   *   快餐訂單列用（2026-09-15 J 要求「所有按鈕同一行」＋ 同隔籬嘅接單總掣對齊）
   * - `sm`（11px，快餐介面舊版）/ `md`（12px，訂單頁）
   */
  size?: "xs" | "sm" | "md";
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
  const xs = size === "xs";

  const labelClass = xs
    ? "text-[11px] font-semibold text-slate-600"
    : sm
      ? "text-[11px] font-medium text-slate-500"
      : "text-xs font-semibold text-slate-600";
  const buttonSizeClass = xs
    ? "rounded-full px-1.5 py-[9px]"
    : sm
      ? "rounded-full px-3 py-1 text-[11px] font-semibold"
      : "rounded-full px-3 py-1 text-xs font-semibold";
  const stateClass = enabled
    ? "bg-emerald-600 text-white"
    : contained
      ? "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
      : "bg-slate-100 text-slate-700";

  /*
   * 🔴 `xs` 嘅掣面文字**一定要包一層 `<span>`**：
   * `globals.css` 一條無 `@layer` 嘅 `button, input, select, textarea { font: inherit; }`
   * 優先於 Tailwind utilities ⇒ 寫喺 `<button>` 身上嘅 `text-[12px]` 完全冇效（會變 16px）。
   * 同 `MerchantOpenPill` 嘅 `xs` 完全同一個做法。
   */
  const stateText = enabled ? "開" : "關";
  const stateNode = xs ? (
    <span className="block text-[12px] font-semibold leading-[1.35]">{stateText}</span>
  ) : (
    stateText
  );

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
        {stateNode}
      </button>
      {error ? <span className="text-[11px] font-semibold text-red-600">· {error}</span> : null}
    </>
  );

  if (contained) {
    // 🔴 `xs` 要**整組 padding 換走**（唔可以留 `px-3 py-1.5` 再加 `p-[3px]`）——
    //    兩者 specificity 一樣，邊個贏睇產生順序；實測舊寫法會被 `px-3 py-1.5` 蓋過。
    return (
      <div
        className={`flex shrink-0 items-center rounded-full bg-slate-100 ${
          xs ? "gap-1.5 p-[3px]" : "gap-2 px-3 py-1.5"
        }`}
      >
        {inner}
      </div>
    );
  }

  return <div className={`flex shrink-0 items-center ${xs ? "gap-1.5" : "gap-2"}`}>{inner}</div>;
}
