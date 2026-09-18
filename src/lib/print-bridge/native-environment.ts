// 打印環境三分法 —— 純 website / desktop companion / Android native。
//
// ─────────────────────────────────────────────────────────────
// 點解要分三種？（2026-09-18）
// ─────────────────────────────────────────────────────────────
// 舊版只有「係唔係 Companion 環境」二分（`shouldUseCompanionChannel()`）：
//
//   const hasPosNative      = Boolean(window.PosNative?.printJob);   // Android
//   const hasCompanionShell = Boolean(window.companionShell);        // desktop
//   return hasPosNative || hasCompanionShell;                        // ← 兩者等價看待
//
// 問題：呢兩個殼**能力唔同**，唔應該等價。
//
// | 能力 | desktop（Electron） | Android（native app） |
// |---|---|---|
// | 出紙 | `http://127.0.0.1:9311/api/print`（HTTP） | `window.PosNative.printJob()`（in-process） |
// | 裝置查詢 | `:9311/api/usb`、`/api/discover`、`/api/bluetooth` | `window.PosNative.listUsbPrinters()` 等 |
// | 探測端點 | Electron companion 提供全部 7 個 | Android 只提供 3 個（health / config / probe-lan） |
//
// 舊版喺 Android 上，`shouldKeepCompanionAlive()` 回 true → `sendJobToCompanion()`
// 會 fetch `http://127.0.0.1:9311/api/print`（Android 上唔存在）→ 多餘失敗請求。
// （主路冇壞，因為 `dispatch.ts` 嘅 `isNativeBridgeAvailable()` 先 return；
//   但 companion.ts 嘅探測／輪詢路徑確實喺做無意義嘅 loopback 嘗試。）
//
// ─────────────────────────────────────────────────────────────
// 三分法之後嘅規則
// ─────────────────────────────────────────────────────────────
// | 環境 | Companion 通道 | native 通道 | relay |
// |---|---|---|---|
// | `"website"` | ❌ | ❌ | ✅（唯一） |
// | `"desktop"` | ✅（`:9311` HTTP） | ❌ | ✅ |
// | `"android"` | ❌ | ✅（`PosNative.*`） | ✅ |
//
// **互斥**：Android 唔再算 Companion 環境；desktop 唔會行 native 通道。

/** 當前頁面所處嘅打印環境。 */
export type PrintEnvironment = "website" | "desktop" | "android";

/**
 * 偵測當前打印環境。
 *
 * 判斷次序（**Android 優先**）：Android 殼（`PosNative.printJob`）→ desktop 殼
 * （`companionShell`）→ 純 website。
 *
 * 點解 Android 要排第一？因為兩者理論上唔會同時存在，但若果將來有任何一個
 * 殼注入兩者，Android 嘅 in-process bridge 一定比 HTTP loopback 可靠
 * （唔使賭 port 開唔開）。
 *
 * ⚠️ 呢個判斷**只讀 bridge 標記**，唔會 fetch 任何嘢 —— 純 website 上零副作用。
 */
export function detectPrintEnvironment(): PrintEnvironment {
  if (typeof window === "undefined") return "website";
  const w = window as unknown as {
    PosNative?: { printJob?: unknown };
    companionShell?: unknown;
  };
  if (w.PosNative && typeof w.PosNative.printJob === "function") return "android";
  if (w.companionShell) return "desktop";
  return "website";
}

/** 係唔係 Android native app 環境（`window.PosNative` 可用）？ */
export function isAndroidNativeEnv(): boolean {
  return detectPrintEnvironment() === "android";
}

/** 係唔係 desktop companion 環境（Electron 殼，loopback `:9311` 有人住）？ */
export function isDesktopCompanionEnv(): boolean {
  return detectPrintEnvironment() === "desktop";
}

/** 係唔係純 website / PWA（冇任何本地代理）？ */
export function isPlainWebsiteEnv(): boolean {
  return detectPrintEnvironment() === "website";
}
