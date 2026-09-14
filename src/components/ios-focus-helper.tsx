"use client";

import { useEffect } from "react";

/**
 * iOS / iPadOS 全屏 PWA「focus 之後虛擬鍵盤唔彈」兜底（docs/109 §3.4 修正 A）。
 *
 * ## 背景（2026-09-14 商家實紙）
 *
 * 症狀：iPad 上撳「全單備註」／「單品備註」嘅自由輸入 textarea，
 * **焦點有到**（iOS 系統編輯選單「貼上／自動填寫」彈得出）、但**虛擬鍵盤完全唔彈**。
 *
 * 成因（iOS 已知行為，三個條件同時成立就會中）：
 *  1. `body` 係 `overflow-hidden`（`src/app/layout.tsx`）→ 文檔本身**唔可以滾動**；
 *  2. 彈窗係 `fixed inset-0` + 面板內部 `overflow-y-auto`（`responsive-modal.tsx`）；
 *  3. `viewport` 係 `maximumScale: 1 / userScalable: false`（`layout.tsx`）
 *     → iOS 唔可以放大去遷就焦點。
 *
 * iOS 喺 focus 一個「唔易 scroll 得到」嘅欄位時，要先確保佢入到可見區才會叫起鍵盤；
 * 上述組合會令部分 iOS 版本直接放棄 → 鍵盤唔彈。
 *
 * ## 做法
 *
 * `focusin` 時把欄位捲入**最近可滾動祖先**（＝彈窗面板）嘅中央；鍵盤令
 * `visualViewport` 改變之後再補一次（iOS 要等鍵盤動畫完才知道實際可用高度）。
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
      el.scrollIntoView({ block: "center", behavior: "auto" });
    }

    let active: HTMLElement | null = null;

    function onFocusIn(event: FocusEvent) {
      if (!isEditable(event.target)) return;
      active = event.target;
      // ① 即刻一次（純 DOM 層，未等到鍵盤）
      window.requestAnimationFrame(() => {
        if (active) ensureVisible(active);
      });
      // ② 鍵盤動畫之後再補一次（iOS 通常要 250–350ms 才穩定）
      window.setTimeout(() => {
        if (active) ensureVisible(active);
      }, 320);
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
