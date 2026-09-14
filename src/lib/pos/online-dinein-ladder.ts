/**
 * 線上堂食單「排位 → 直接推到已完成」嘅**爬梯口徑** —— 零依賴純模組。
 *
 * ## 為咩要獨立成一個檔
 *
 * 爬梯本體（`online-dinein-fulfillment.ts`）要真打 Ledger RPC，帶 `"use client"` ＋
 * `@/` alias，`node --test` 載入唔到。所以**判定口徑**（梯級順序、邊啲錯誤算「已過此級」、
 * 咩叫已完成）收喺呢度，令 `online-dinein-ladder.test.ts` 可以直接鎖死行為。
 *
 * ## 為咩唔可以「一次過跳去 completed」
 *
 * Ledger `update_order_status` **只接受逐級轉換**（`pending → accepted → preparing →
 * ready → completed`），跳級一律回 `invalid transition`。而且 POS 手上**冇**可信嘅
 * Ledger 當前狀態（可能係 `pending`：商家設定咗排位前要先接單但實際未撳；亦可能已
 * `preparing`：有人手動推過）。
 *
 * ⇒ 做法係**由 `accepted` 起逐級試**，某一級失敗若係「目前狀態唔啱」（＝已經過咗
 * 呢級／已經完成）就繼續；其餘錯誤（登入過期、網絡）即刻停手。呢個做法**冪等**：
 * 重複排位、已經 `completed` 嘅單，全部呼叫都只會 invalid transition，唔會拋錯。
 *
 * @see docs/113-agent-gotchas.md（排位自動完成）
 */

/** 排位後要一次過推到頂嘅整條梯（Ledger 只接受逐級，順序唔可以亂）。 */
export const DINEIN_LADDER = ["accepted", "preparing", "ready", "completed"] as const;

/** 梯頂：商家口徑「排位完成＝已出單」。 */
export const DINEIN_FINAL_STATUS = "completed";

/**
 * Ledger 嘅「目前狀態唔可以行呢一步」。
 *
 * 🔴 三條口徑缺一不可，因為錯誤訊息會經**兩層**傳遞：
 *   1. RPC 原始英文（`invalid transition` / `order already completed`…）；
 *   2. `mapRpcErrorMessage()`（`order-actions.ts`）會把 `invalid transition`
 *      譯成 **「目前狀態不可執行此操作。」**，所以淨係認英文字串會**永遠認唔到**
 *      （2026-09-14 查證：現行能運作全靠第三條中文判定）。
 *
 * 其餘訊息（例如「Ledger 登入已過期」「Ledger Supabase 尚未設定」）一律**唔算**，
 * 要即刻停手 —— 呢類係真失敗，唔可以靜默當成功。
 */
export function isInvalidTransition(message: string): boolean {
  const text = String(message ?? "");
  const lower = text.toLowerCase();
  return (
    lower.includes("invalid transition") ||
    lower.includes("already") ||
    text.includes("目前狀態不可執行")
  );
}

/** Ledger 當前狀態係唔係已經到達梯頂（＝已完成）。 */
export function isLedgerStatusComplete(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === DINEIN_FINAL_STATUS;
}
