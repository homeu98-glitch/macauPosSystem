"use client";

/**
 * 「開啟接單」主開關 pill —— 全站**共用同一個樣式**（同 `AutoAcceptPill` 同一套視覺語言）。
 *
 * 三個 call site：
 * 1. 訂單頁 · 線上訂單標題列（`online-orders.tsx`）
 * 2. 快餐點餐介面 · 線上訂單標題列（`quick-mode-orders-bar.tsx`）
 * 3. 設備設定 · 支付方式分區（`device-settings.tsx` 嘅 `MerchantOrderConfigSection`）
 *
 * ── 點解唔直接借 `AutoAcceptPill` ──────────────────────────────────────
 * `AutoAcceptPill` 嘅掣面寫死「開 / 關」，但呢粒掣講嘅係**鋪頭開門定落閘**，
 * 收銀要一眼睇得出「而家接唔接到單」。所以掣面直接寫狀態（營業中 / 已暫停）。
 *
 * ── 關店一定要二次確認 ─────────────────────────────────────────────────
 * 關咗之後**會員通即刻落唔到新單**（`create_order` 會擋），誤觸等於停業。
 * 開店唔阻手（即時生效）。
 *
 * ⚠️ `merchantEnabled === null` 係「未讀到」（未登入 / Ledger 未提供該欄 /
 * 前端接錯 Supabase 專案）—— 一定要顯示「未接通」並停用，**唔可以**當「已暫停」
 * 或者「營業中」：兩個方向都會講大話。
 */

type MerchantOpenPillProps = {
  /** `null` = 未讀到，唔可以亂猜。 */
  merchantEnabled: boolean | null;
  onChange: (next: boolean) => void;
  /** 讀取中 / 儲存中：掣停用，並喺 label 後面加細字提示。 */
  busy?: boolean;
  busyHint?: string;
  /** 外部停用（例如 Ledger 通道用唔到、或者商家已被平台暫停）。 */
  disabled?: boolean;
  error?: string | null;
  /** `null` 狀態下嘅提示文字。 */
  unknownHint?: string;
  /**
   * - `contained`：外層有一粒 `bg-slate-100` 藥丸底（標題列用，同 AutoAcceptPill 對稱）
   * - `plain`：無底，直接 label + 掣
   */
  variant?: "plain" | "contained";
  /** `sm`（11px）/ `md`（12px，標題列）。 */
  size?: "sm" | "md";
};

/** 關店確認文案 —— 一定要講清楚「只影響會員通」，否則收銀會以為連堂食都停。 */
const CONFIRM_CLOSE_MESSAGE =
  "確認暫停接單？\n\n客人將無法透過會員通落新單（店內堂食、快餐、自助點餐不受影響）。\n需要恢復營業時，喺同一個掣撳返「營業中」即可。";

export function MerchantOpenPill({
  merchantEnabled,
  onChange,
  busy = false,
  busyHint,
  disabled = false,
  error = null,
  unknownHint = "未讀到接單狀態",
  variant = "plain",
  size = "md",
}: MerchantOpenPillProps) {
  const contained = variant === "contained";
  const sm = size === "sm";

  const labelClass = sm
    ? "text-[11px] font-medium text-slate-500"
    : "text-xs font-semibold text-slate-600";
  // 觸控：`py-2` + 外層 padding → 實際可撳高度 ≥ 40px（同 AutoAcceptPill 對齊）
  const buttonSizeClass = sm
    ? "rounded-full px-3 py-1.5 text-[11px] font-semibold"
    : "rounded-full px-4 py-2 text-xs font-semibold";

  const unknown = merchantEnabled === null;
  const enabled = merchantEnabled === true;
  const interactive = !unknown && !disabled;

  const stateClass = unknown
    ? "bg-slate-200 text-slate-500"
    : enabled
      ? "bg-emerald-600 text-white"
      : contained
        ? "bg-white text-amber-700 shadow-sm ring-1 ring-amber-300"
        : "bg-amber-100 text-amber-800";

  const inner = (
    <>
      <span className={labelClass}>
        接單
        {busy && busyHint ? (
          <span className="ml-1 font-normal text-slate-400">{busyHint}</span>
        ) : null}
      </span>
      <button
        aria-label={unknown ? "接單狀態未接通" : "開啟或暫停接單"}
        aria-pressed={unknown ? undefined : enabled}
        className={`${buttonSizeClass} ${stateClass} disabled:opacity-60`}
        disabled={!interactive || busy}
        onClick={() => {
          if (!interactive) return;
          if (enabled) {
            // 關店：誤觸等於停業 → 一定要問清楚
            if (typeof window !== "undefined" && !window.confirm(CONFIRM_CLOSE_MESSAGE)) return;
            onChange(false);
            return;
          }
          onChange(true);
        }}
        title={unknown ? unknownHint : undefined}
        type="button"
      >
        {unknown ? "未接通" : enabled ? "營業中" : "已暫停"}
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
