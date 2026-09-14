"use client";

import { useEffect } from "react";

/**
 * iOS / iPadOS「focus 之後虛擬鍵盤唔彈」兜底（docs/109 §3.4 修正 A）。
 *
 * ## 背景（2026-09-14 商家實紙，詳見 docs/113）
 *
 * 症狀：iPad 上撳「全單備註」／「單品備註」嘅自由輸入 textarea，
 * **焦點有到**（有 focus ring、游標、iOS 系統文字工具列「貼上／自動填寫」）
 * 但**虛擬鍵盤完全唔彈**；同一部 iPad 開 Ledger 網頁**正常**。
 *
 * 成因（兩條，都係我哋自己嘅佈局造成）：
 *  1. 文檔本身**唔可以滾動**：`body { overflow: hidden }` + `h-full`（`src/app/layout.tsx`），
 *     而輸入框又嵌喺 `fixed inset-0` 彈窗（`responsive-modal.tsx`）嘅 `overflow-y-auto` 面板內
 *     → iOS 嘅 focus reveal 容易失敗（input 喺 fixed + overflow:hidden 祖先內會被截斷）；
 *  2. `viewport` 曾經寫死 `user-scalable=no`（2026-09-14 已刪）→ 鎖死視口重繪，
 *     令鍵盤彈出時嘅 visual-viewport 重算失敗。
 *
 * ## 做法
 *
 * `focusin` 時（**同步**，唔可以等 setTimeout —— iOS 只認手勢上下文內嘅 scroll）
 * 把欄位捲入最近可滾動祖先（＝彈窗面板）；鍵盤動畫後（260/420ms）再補，
 * 並監聽 `visualViewport` resize/scroll。用 `block: "nearest"`（`center`／`end` 會走位）。
 *
 * ⚠️ 元素本來就完整可見 → **唔動**，所以唔會同 POS 本身嘅 scroll 行為打架
 *    （docs/109 特別提醒呢點：全局 scroll 兜底最容易撞到列表頁自己嘅滾動）。
 */
export function IosFocusHelper() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    function isEditable(target: EventTarget | null): target is HTMLElement {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
      );
    }

    /** 留白：唔想欄位貼住鍵盤邊／狀態欄邊緣。 */
    const MARGIN_PX = 24;

    function ensureVisible(el: HTMLElement) {
      const vv = window.visualViewport;
      const rect = el.getBoundingClientRect();
      const viewTop = vv ? vv.offsetTop : 0;
      const viewBottom = viewTop + (vv ? vv.height : window.innerHeight);
      // 已經完整可見 → 唔動（否則鍵盤每次 resize 都會重新捲動，畫面會閃）
      if (rect.top >= viewTop + MARGIN_PX && rect.bottom <= viewBottom - MARGIN_PX) return;
      /*
       * ⚠️ 一定要用 `block: "nearest"`：
       *  - `"center"` 會令欄位被推得太上（鍵盤未出之前唔知真實可用高度）；
       *  - `"end"` 喺部分機型會觸發異常捲動。
       * 呢個係 iOS 上 focus reveal 最穩嘅參數（見 docs/113）。
       */
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    }

    let active: HTMLElement | null = null;

    function onFocusIn(event: FocusEvent) {
      if (!isEditable(event.target)) return;
      active = event.target;
      // ① **同步**即刻做一次：iOS 只喺 focus 事件嘅同步執行期內認「呢個 scroll 係為咗聚焦」，
      //    放到 setTimeout / Promise.then 之後就會被當成非手勢上下文而失效。
      if (active) ensureVisible(active);
      // ② 鍵盤動畫約 250ms 完成、視口先穩定 → 補兩次（有「已可見就唔動」守門，唔會閃）。
      for (const delay of [260, 420]) {
        window.setTimeout(() => {
          if (active) ensureVisible(active);
        }, delay);
      }
    }

    function onFocusOut() {
      active = null;
    }

    function onViewportChange() {
      if (active) ensureVisible(active);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }, []);

  return null;
}
