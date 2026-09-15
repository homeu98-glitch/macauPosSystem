"use client";

/**
 * 「開啟接單」主開關 pill —— 全站**共用同一個樣式**（同 `AutoAcceptPill` 同一套視覺語言）。
 *
 * ## 2026-09-15：命名統一（J 拍板）
 *
 * | 掣 | 元件 | 真源 | label | 掣面（開 / 關） |
 * |---|---|---|---|---|
 * | 線上接單 | `OnlineOpenPill`（本元件嘅 wrapper） | Ledger `merchant_enabled` | 線上接單 | **接單中** / 已暫停（白底琥珀） |
 * | 線下接單 | `StoreOpenPill`（本元件嘅 wrapper） | POS DB `pos_store_status`（0039） | 線下接單 | **營業中** / 已暫停（**紅底**） |
 *
 * 🔴 兩粒會**並排**出現（桌台總覽標題列、快餐訂單列），所以措辭／顏色一定要分得開：
 * 兩個都寫「營業中」＋ 同一個綠 ⇒ 收銀撳錯 = 停業。
 * 所以掣面文字由 `enabledLabel` / `offLabel` 提供，唔再寫死。
 *
 * call site：
 * 1. 訂單頁 · 線上訂單標題列（`online-orders.tsx`）→ 線上接單 / 接單中
 * 2. 快餐點餐介面 · 線上訂單標題列（`quick-mode-orders-bar.tsx`，經 `OnlineOpenPill`）→ 同上
 * 3. 桌台總覽標題列（`pos-app.tsx`，經 `OnlineOpenPill` / `StoreOpenPill`）
 * 4. 設備設定 · 支付方式分區（`merchant-order-config-section.tsx`）→ 線上接單
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
  /**
   * 掣面左邊嘅細字標籤。預設「線上接單」（2026-09-15 統一命名；舊預設係「接單」，
   * 同「線下接單」放埋一齊會分唔清）。
   */
  label?: string;
  /** 讀取中 / 儲存中：掣停用，並喺 label 後面加細字提示。 */
  busy?: boolean;
  busyHint?: string;
  /** 外部停用（例如 Ledger 通道用唔到、或者商家已被平台暫停）。 */
  disabled?: boolean;
  error?: string | null;
  /** `null` 狀態下嘅提示文字。 */
  unknownHint?: string;
  /**
   * `contained`：外層有一粒 `bg-slate-100` 藥丸底（標題列用，同 AutoAcceptPill 對稱）
   * - `plain`：無底，直接 label + 掣
   */
  variant?: "plain" | "contained";
  /**
   * - `xs`（11px label / 12px 掣面，高約 40px、闊約 104px）：**精簡版**，
   *   桌台總覽標題列／快餐訂單列用（2026-09-15 J 要求「尺寸縮細」＋「所有按鈕同一行」）
   * - `sm`（11px）/ `md`（12px，標題列）
   */
  size?: "xs" | "sm" | "md";
  /**
   * 關閉前嘅二次確認文案。
   *
   * ⚠️ 預設嗰句講「**只**影響會員通（店內堂食、快餐、自助點餐不受影響）」，只適用於
   * **線上接單**。其他開關（例如「店內營業」＝線下接單）一關就真係停掃碼／kiosk 落單 ——
   * 一定要自己傳正確文案，否則會向收銀講大話（見 `use-store-open-toggle.ts`
   * 嘅 `CONFIRM_CLOSE_STORE_MESSAGE`）。
   */
  confirmMessage?: string;
  /** 掣面「營業中」嗰個狀態嘅文字。預設「營業中」；線上接單會傳「接單中」（2026-09-15 避撞字）。 */
  enabledLabel?: string;
  /** 掣面「已暫停」嗰個狀態嘅文字。預設「已暫停」。 */
  offLabel?: string;
  /**
   * 「已暫停」嘅顏色。
   * - `amber`（預設）：白底琥珀字 —— 線上接單用，講「客人落唔到單」但唔算停業
   * - `red`：紅底白字 —— **線下接單（店內營業）**用，一關就係停業，要一眼睇到
   */
  offTone?: "amber" | "red";
};

/** 關店確認文案 —— 一定要講清楚「只影響會員通」，否則收銀會以為連堂食都停。 */
const CONFIRM_CLOSE_MESSAGE =
  "確認暫停「線上接單」？\n\n客人將無法透過會員通落新單（店內堂食、快餐、自助點餐不受影響）。\n需要恢復時，喺同一個掣撳返「接單中」即可。";

export function MerchantOpenPill({
  merchantEnabled,
  onChange,
  label = "線上接單",
  busy = false,
  busyHint,
  disabled = false,
  error = null,
  unknownHint = "未讀到接單狀態",
  variant = "plain",
  size = "md",
  confirmMessage = CONFIRM_CLOSE_MESSAGE,
  enabledLabel = "營業中",
  offLabel = "已暫停",
  offTone = "amber",
}: MerchantOpenPillProps) {
  const contained = variant === "contained";
  const sm = size === "sm";
  const xs = size === "xs";

  const labelClass = xs
    ? "text-[11px] font-semibold text-slate-600"
    : sm
      ? "text-[11px] font-medium text-slate-500"
      : "text-xs font-semibold text-slate-600";
  // 觸控：`py-2` + 外層 padding → 實際可撳高度 ≥ 40px（同 AutoAcceptPill 對齊）。
  // `xs` 亦刻意保持 ~40px 高（只縮橫向），見 docs/mockups/accept-toggle-placement-2026-09-15-v2.html。
  const buttonSizeClass = xs
    ? "rounded-full px-1.5 py-[9px]"
    : sm
      ? "rounded-full px-3 py-1.5 text-[11px] font-semibold"
      : "rounded-full px-4 py-2 text-xs font-semibold";

  const unknown = merchantEnabled === null;
  const enabled = merchantEnabled === true;
  const interactive = !unknown && !disabled;

  const stateClass = unknown
    ? "bg-slate-200 text-slate-500"
    : enabled
      ? "bg-emerald-600 text-white"
      : offTone === "red"
        ? "bg-red-600 text-white"
        : contained
          ? "bg-white text-amber-700 shadow-sm ring-1 ring-amber-300"
          : "bg-amber-100 text-amber-800";

  /*
   * 🔴 `xs` 嘅掣面文字**一定要包一層 `<span>`**：
   * `globals.css` 有一條**無 `@layer`** 嘅 `button, input, select, textarea { font: inherit; }`，
   * 佢優先於 Tailwind 嘅 `@layer utilities` ⇒ 寫喺 `<button>` 身上嘅 `text-[12px]` 完全冇效，
   * 掣面會變 16px（＝body 字級）→ 精簡 pill 即刻爆位。
   * `span` 唔受嗰條規則影響，所以字級寫落 `span` 就穩。
   * （`sm` / `md` 維持原本做法，避免改到既有外觀。）
   */
  const stateText = unknown ? "未接通" : enabled ? enabledLabel : offLabel;
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
        aria-label={unknown ? "接單狀態未接通" : `開啟或暫停${label}`}
        aria-pressed={unknown ? undefined : enabled}
        className={`${buttonSizeClass} ${stateClass} disabled:opacity-60`}
        disabled={!interactive || busy}
        onClick={() => {
          if (!interactive) return;
          if (enabled) {
            // 關店：誤觸等於停業 → 一定要問清楚
            if (typeof window !== "undefined" && !window.confirm(confirmMessage)) return;
            onChange(false);
            return;
          }
          onChange(true);
        }}
        title={unknown ? unknownHint : undefined}
        type="button"
      >
        {stateNode}
      </button>
      {error ? <span className="text-[11px] font-semibold text-red-600">· {error}</span> : null}
    </>
  );

  if (contained) {
    // 🔴 `xs` 一定要**整組 padding 換走**，唔可以「保留 `px-3 py-1.5` 再加 `p-[3px]`」：
    //    兩者同屬 Tailwind utilities layer、specificity 一樣 → 邊個贏純粹睇產生順序
    //    （實測 `px-3 py-1.5` 贏 → pill 變 122 × 46，唔係設計嘅 104 × 40）。
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
