/**
 * iOS / iPadOS：撳落輸入欄位時，強制一次「焦點改變」（2026-09-14 商家實紙）。
 *
 * ## 為何要咁做
 *
 * iOS **只會喺焦點由「無 → 有」改變**（而且喺 user gesture 嘅同步執行期內）才彈系統鍵盤。
 * 兩種情況會令商家覺得「撳極都冇反應」：
 *
 *  1. 欄位**已經有焦點**（例如彈窗用咗 `autoFocus`，或上一次撳過），
 *     用戶再撳同一欄位 → 焦點冇改變 → iOS **唔會**再彈鍵盤。
 *  2. 之前一次程式化 `focus()` 被 iOS 拒絕／靜默失敗，但視覺上 focus ring 已經出咗。
 *
 * ⇒ 對策：pointerup 時若「已經聚焦」且「鍵盤明顯未開」，先 `blur()` 再 `focus()`，
 *    造出一次新鮮嘅焦點改變（同業界「dummy input」hack 同一個原理，但唔使真係插一個假 input）。
 *
 * ## 為何唔可以無條件 blur+focus
 *
 * 若鍵盤已經開住（用戶只係想移動游標），blur+focus 會令鍵盤「熄一下再彈」→ 閃。
 * 所以用 `visualViewport.height` 做守門：iOS 鍵盤一開，visual viewport 高度會明顯縮細
 * （用 layout viewport 高嘅 75% 做門檻，穩妥又唔會誤判）。
 *
 * ⚠️ 呢個 function 必須喺 **pointerup / click 呢類 user gesture handler** 內同步呼叫，
 *    放入 `setTimeout` / `await` 之後會失效（iOS 判定為非手勢上下文）。
 */
export function refocusForIosKeyboard(el: HTMLElement | null | undefined): void {
  if (!el || typeof window === "undefined") return;

  const viewport = window.visualViewport;
  /** 鍵盤開住時 visual viewport 高度會大跌；用 75% 做門檻避免誤判。 */
  const keyboardLikelyOpen = !!viewport && viewport.height < window.innerHeight * 0.75;

  if (document.activeElement === el && !keyboardLikelyOpen) {
    el.blur();
  }
  if (document.activeElement !== el) {
    el.focus();
  }
}
