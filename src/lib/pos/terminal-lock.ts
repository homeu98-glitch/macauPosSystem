"use client";

/**
 * 「呢個分頁已經認過人」標記（2026-10-23，docs/162）。
 *
 * ## 解決咩問題
 *
 * 症狀（J 實測）：關掉瀏覽器 → 再開 → **直接入到工作台，而且係店主權限**。
 *
 * 成因：`authSession` 存喺 **localStorage**（刻意嘅：離線優先／PWA 重開要保資料），
 * 關 tab 唔會清。`AuthGuard` 見到有 session 就放行 ⇒ 上一個用機嘅人（店主）
 * 嘅身份被靜靜沿用。店員接手 = 直接有店主權限。
 *
 * ## 解法：分頁層面嘅「解鎖」標記
 *
 * | 儲存 | 壽命 | 用途 |
 * |---|---|---|
 * | `localStorage` authSession | 永久（直到登出） | 離線資料、PWA 重開 |
 * | **`sessionStorage` 解鎖標記** | **分頁／App 關閉即消失** | 分「冷啟」同「分頁內重整」 |
 *
 * 規則：
 *   · **冷啟**（新分頁／重開瀏覽器／重開 PWA）→ 冇標記 ⇒ 一律去 `/login` 揀身份 + PIN
 *   · **分頁內重新整理／跳頁** → 標記仍在 ⇒ 照用當前 session（唔會不停問 PIN）
 *
 * ⇒ 關掉再開 = 一定重新認人；但行緊嘅時候 F5 唔會被打斷。
 *
 * ## 為何唔用 localStorage 存標記
 *
 * 咁樣同 authSession 一樣永久，等於冇做過。一定要用 sessionStorage 嘅
 * 「關 tab 即清」語義。
 */

const UNLOCK_KEY = "macau-pos/terminal-unlocked";

/** 登入成功（或裝置還原成功）之後呼叫。 */
export function markTerminalUnlocked(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(UNLOCK_KEY, new Date().toISOString());
  } catch {
    // 私隱模式／quota：冇標記最多下次再問 PIN，唔可以令登入失敗
  }
}

export function isTerminalUnlocked(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.sessionStorage.getItem(UNLOCK_KEY));
  } catch {
    return false;
  }
}

export function clearTerminalUnlocked(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    // ignore
  }
}
