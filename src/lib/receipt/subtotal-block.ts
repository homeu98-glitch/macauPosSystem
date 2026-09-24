/**
 * 「原價合計」區塊 ＋ 收據殘差（附加費）——**純函式，零依賴**。
 *
 * ── 為什麼要獨立一個模組 ──────────────────────────────────────────────
 * 呢兩個函式原本住喺 `escpos-template.ts`，但嗰個檔有 `@/lib/...` runtime import
 * → `node --test` 載唔到 → **收據加總呢條核心不變式一直冇任何測試**。
 * 抽嚟呢度之後（同 `retail/receipt-retail-blocks.ts` 同一個做法）就可以直接驗。
 *
 * ── 2026-09-24：正因為冇測試，收據「費用被計兩次」一直冇被發現 ──────────
 * 詳見 `buildSubtotalBlock()` 內嘅兩個坑註釋。
 */

/** 金額四捨五入到 2 位小數；NaN / 負數一律當 0（收據唔會印負數金額）。 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

/** `buildSubtotalBlock()` / `resolveExtraFee()` 共用嘅輸入形狀。 */
export interface SubtotalParts {
  subtotalBefore: number;
  serviceCharge: number;
  tax: number;
  rounding: number;
  totalDiscount: number;
  orderTotal: number;
}

/** 外賣平台嘅一項非菜品費用。 */
export interface PlatformFeeLine {
  label: string;
  amount: number;
  /** `true` = 唔計入營業額（例如顧客自己付嘅配送費），只作對數資訊。 */
  excluded?: boolean;
}

export interface SplitPlatformFees {
  /** 計入營業額嘅行（含**負數**嘅商家承擔優惠：商家活動支出／滿減／代金券）。 */
  included: PlatformFeeLine[];
  /** 唔計入營業額嘅資訊行（例如顧客支付嘅配送費、商家配送費減免）。 */
  excluded: PlatformFeeLine[];
}

/**
 * 把 `platformFees` 分成「計入營業額」同「唔計入」兩組，並套用**同一個**過濾規則：
 * 金額唔係有限數 / 等於 0 / 標籤空白 → 一律略過（唔會印出空行）。
 *
 * 🔴 收據（`buildSubtotalBlock`）同 POS 訂單詳情（`PlatformFeeBreakdown` 元件）
 *    一定要用**同一支**函式。2026-09-24 嘅實案就係「收據有費用行、訂單詳情完全冇」
 *    → 使用者以為功能冇生效，白查一輪。共用一支就唔會走樣。
 */
export function splitPlatformFees(platformFees?: PlatformFeeLine[] | null): SplitPlatformFees {
  const included: PlatformFeeLine[] = [];
  const excluded: PlatformFeeLine[] = [];
  for (const fee of platformFees ?? []) {
    if (!fee) continue;
    const amount = Number(fee.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const label = String(fee.label ?? "").trim();
    if (!label) continue;
    if (fee.excluded) excluded.push({ label, amount, excluded: true });
    else included.push({ label, amount });
  }
  return { included, excluded };
}

/**
 * 收據嘅「附加費」＝ 唔屬任何菜品、但計入總金額嘅費用（外送費／餐盒費）。
 *
 * 🔴 為什麼需要佢：外賣平台單嘅「營業額」包含外送費／餐盒費，但**冇對應菜品**
 *    → 總金額會大過原價合計。收據嘅不變式係
 *      `原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額`，
 *    而 `resolveTotalDiscount` 會正確地拒絕「負優惠」
 *    （反向推出來嘅差額係負數 → 唔可信 → 忽略）。
 *    結果就係「原價合計 67 / 總金額 126」而**冇任何說明**，睇落似算錯。
 *
 * 所以呢度把嗰個差額當成**正數附加費**補一行，令加總對得返。
 *
 * ⚠️ 店內單嘅差額係 0（或負數，例如系統抹零）→ `roundMoney` 回 0
 *    → **唔會多咗行**，輸出同以前一模一樣。
 *
 * ⚠️ 呢個函式**唔知有費用行**（由 `buildSubtotalBlock()` 逐項印）。
 *    所以要判斷「平台有冇多收未識別嘅費用」時，**唔可以**直接用佢，
 *    要用未夾號嘅 `rawResidual()` 再減 `printedFeeSum`（見下）。
 */
export function resolveExtraFee(parts: SubtotalParts): number {
  return roundMoney(rawResidual(parts));
}

/**
 * 「除咗已列出嘅嘢之外仲差幾多」——**未夾正負**嘅原始差額。
 *
 * ⚠️ 同 `resolveExtraFee()` 嘅分別：呢個**保留負號**。
 *    平台單要扣返「已經逐項印咗嘅費用」，而嗰啲費用行可以係負數
 *    （商家活動支出／滿減／代金券）→ 夾咗 0 就會計錯。
 */
export function rawResidual(parts: SubtotalParts): number {
  return (
    parts.orderTotal -
    parts.subtotalBefore -
    parts.serviceCharge -
    parts.tax +
    parts.rounding +
    parts.totalDiscount
  );
}

/**
 * 「原價合計」區塊嘅完整內容。
 *
 * 正常情況只有一行；有附加費（外送費／餐盒費）時多一行。
 * ⚠️ 刻意**唔另開一個 template field id**：收據模板係 per-store 儲喺 DB，
 *    新 field 唔會自動出現喺現有店舖嘅模板 → 要逐店改模板才印得出。
 *    而 `subtotal_before_discount` 係每個模板都有嘅欄位，且內容支援 `\n`。
 */
export function buildSubtotalBlock(
  parts: SubtotalParts,
  format: (amount: number) => string,
  /** 外賣平台嘅非菜品費用（餐盒費／膠袋費／服務費），逐項印。店內單唔會有。 */
  platformFees?: PlatformFeeLine[],
): string {
  const lines = [`原價合計: ${format(parts.subtotalBefore)}`];

  // 過濾規則同分組都交畀 `splitPlatformFees()`（收據同一詳情共用，唔可以各寫一套）。
  const { included, excluded } = splitPlatformFees(platformFees);

  // 計入營業額嘅行。順便累加，後面算殘差要用（見下面 🔴）。
  // 🔴 容許負數：商家承擔嘅優惠（商家活動支出／滿減／代金券）
  //    以負數行表示，同平台後台嘅費用清單一模一樣 —— 商家對數時逐項睇得到。
  let printedFeeSum = 0;
  for (const fee of included) {
    lines.push(`${fee.label}: ${format(fee.amount)}`);
    printedFeeSum += fee.amount;
  }

  // 唔計入營業額嘅行（例如顧客支付嘅配送費）：分開一組，並加一句說明，
  // 免得商家以為加總少咗一筆。
  // ⚠️ 呢組**唔可以**計入下面嘅殘差扣減 —— 佢哋本身唔屬總金額嘅一部分。
  if (excluded.length > 0) {
    lines.push("（以下不計入營業額）");
    for (const fee of excluded) lines.push(`${fee.label}: ${format(fee.amount)}`);
  }

  // 殘差：列出費用之後仍然對唔上（例如平台新增咗某種費用）→ 補一行，
  // 保證「原價合計 + 費用 … − 優惠合計 === 總金額」永遠成立。
  //
  // 🔴 兩個坑（2026-09-24 由隨機假單發現；之前兩張真實樣本啱啱好避開兩者）：
  //
  //   ① 唔扣返已印費用 → 費用**被計兩次**。
  //      實例：原價合計 100 + 餐盒費 3，總計 103
  //        → 差額 = 103 − 100 + 0 = 3 > 0 → 舊碼多印一行「外送費／餐盒費: 3」
  //        → 收據加總變 106 ≠ 總計 103 ✗
  //
  //   ② 唔可以用 `resolveExtraFee()`（或任何夾咗負數嘅中間值）去減。
  //      佢內部嘅 `roundMoney()` 會**將負數夾成 0**，而費用行可以係負數
  //      （商家活動支出／滿減／代金券）→ 減一個負數會反過來變正數、又亂印。
  //      實例：原價合計 100 + 餐盒 4 − 商家活動 6 = 98，總計 98
  //        → 夾 0 後：0 − 0 = 0 ✓（但同一招遇到「有優惠 + 平台多咗費用」就會少報）
  //      實例：原價合計 100 + 餐盒 4 − 商家活動 6 = 98，總計 103（平台多收 5）
  //        → 夾 0 版：max(0, 3) − max(0, −2) = 3 → 補 3 → 加總 101 ≠ 103 ✗
  //        → 本版：3 − (−2) = 5 → 補 5 → 加總 103 ✓
  //
  //   ⇒ 一律用**未夾號**嘅 `rawResidual()` 減 `printedFeeSum`，最後才夾一次：
  //      對得上 = 0（唔印）；平台真係多咗未識別嘅費用 = 正數（照印）。
  const extra = roundMoney(rawResidual(parts) - printedFeeSum);
  if (extra > 0) lines.push(`外送費／餐盒費: ${format(extra)}`);

  return lines.join("\n");
}
