/**
 * 線上單「接單」結果同提示文案嘅**唯一口徑**（2026-09-14 · J 實案：取餐碼 005）。
 *
 * ── 為咩要獨立一個模組 ────────────────────────────────────────────────
 * 接單有**兩個入口**，各自實作同一件事：
 *   - `online-orders.tsx`（訂單 → 線上訂單 頁）
 *   - `quick-online-orders-panel.tsx`（POS 主介面：快餐條 / 堂食快捷操作）
 *
 * 兩邊以前各自砌提示文案，而且**自動接單（`silent`）一律唔報出紙結果**：
 * 0 張廚房 job 都照講「已自動接單」＝假成功（商家實案：005 冇紙又冇 job、零提示）。
 * 所以：
 *   1. 結果型別收喺度（唔再各寫一份）；
 *   2. 「有冇真係送咗廚」嘅文案收喺 `kitchenHintText()`；
 *   3. 自動接單嘅提示收喺 `autoAcceptToast()` —— **0 job 一定唔會返 null**。
 *
 * ⚠️ 呢個模組**刻意零 runtime 依賴**（單號由 caller 傳字串入嚟，唔 import
 * `order-mapper`）→ `node --test` 可以直接載入，測試鎖死「0 job 唔准靜默」呢條鐵律。
 * 亦唔可以寫 UI（冇 React）：兩個入口嘅 toast 容器唔同（一個自己 render，
 * 一個收 `onToast` prop），但**文案同 tone 分類必須一致**。
 */

export type ToastTone = "success" | "info" | "warning" | "error";

export type ToastPayload = { tone: ToastTone; message: string };

/**
 * 接單結果。⚠️ **唔可以**簡化成 boolean：
 * 「接單成功」同「廚房收到紙」係兩件事，分唔清就會出現假成功。
 */
export type AcceptOutcome = {
  ok: boolean;
  /** 今次真係建立咗幾張廚房／標籤 job（0 = 冇出紙）。 */
  kitchenJobCount: number;
  /** true = 同一張單之前已出過紙，刻意唔重複（同「設定冇出」係兩件事）。 */
  printAlreadyDone: boolean;
  /** `ok:false` 時嘅失敗分類（`kitchen` ＝ 已接單但出紙步驟失敗）。 */
  failure?: "insufficient_balance" | "accept" | "kitchen";
  /** 失敗訊息（底層例外／RPC 文案）。 */
  message?: string;
};

export function acceptOk(kitchenJobCount: number, printAlreadyDone = false): AcceptOutcome {
  return { ok: true, kitchenJobCount, printAlreadyDone };
}

export function acceptFailed(
  failure: NonNullable<AcceptOutcome["failure"]>,
  message?: string,
): AcceptOutcome {
  return { ok: false, kitchenJobCount: 0, printAlreadyDone: false, failure, message };
}

/**
 * 人手接單嘅出紙後綴（兩個入口共用，唔准各自寫）。
 *
 * 三種情況必須分得清 —— 混埋一齊就會「假成功」或「假失敗」：
 *   1. 真係出咗紙 → 「並已送廚」
 *   2. 之前已出過（排位／採納重複跑）→ 「（此單已出過廚房單，唔會重複印）」
 *   3. 一張都冇 → 「（按打印設定未出廚房單）」
 */
export function kitchenHintText(outcome: AcceptOutcome): string {
  if (outcome.kitchenJobCount > 0) return "並已送廚";
  if (outcome.printAlreadyDone) return "（此單已出過廚房單，唔會重複印）";
  return "（按打印設定未出廚房單）";
}

/**
 * **自動接單**（`silent`）嘅提示 —— `null` ＝ 唔應該彈（只有一種情況）。
 *
 * 🔴 鐵律（商家 2026-09-14 明確要求）：自動接單**唔准靜默**。
 * 0 張廚房 job 一定要有可見信號（warning），出紙失敗一定要 error。
 * 唯一唔出提示嘅係「餘額不足」：嗰個路徑本身會開「改為到店付款」彈窗，
 * 再彈 toast 只會搶走注意力。
 *
 * @param code 訂單顯示碼（`orderCodeLabel(order)`，例如「取餐碼 005」）
 */
export function autoAcceptToast(code: string, outcome: AcceptOutcome): ToastPayload | null {
  const suffix = outcome.message ? `（${outcome.message}）` : "";

  if (outcome.failure === "insufficient_balance") return null;
  if (!outcome.ok) {
    return outcome.failure === "kitchen"
      ? { tone: "error", message: `已自動接單，但廚房單建立失敗：${code}${suffix}` }
      : { tone: "error", message: `自動接單失敗：${code}${suffix}` };
  }
  if (outcome.kitchenJobCount > 0) {
    return { tone: "success", message: `已自動接單並已送廚：${code}` };
  }
  if (outcome.printAlreadyDone) {
    return { tone: "info", message: `已自動接單：${code}（此單已出過廚房單，唔會重複印）` };
  }
  // 可能原因：打印開關熄咗 / 冇啟用廚房機 / 明細對唔到餐牌。
  // 唔可以照講「已自動接單」就算 —— 廚房收唔到單，收銀必須見到。
  return { tone: "warning", message: `已自動接單，但未出廚房單：${code}（請檢查打印開關／補印）` };
}
