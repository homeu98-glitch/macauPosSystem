/**
 * Print bridge 共用工具（舊 Printer Hub adapter 已於 2026-08 移除，見 docs/50）。
 *
 * 本檔現只保留兩個被多個 transport 共用嘅函數：
 *   - resolveJobPrinter：按 PrintJob.printerGroup 由 config.printers ＋ kiosk 打印機搵目標打印機
 *     （單一真源，dispatch.ts 用；2026-09-11 起合併 `loadKioskPrinters()`，見 docs/87 §6.2）
 *   - loadJsQr：動態載入 jsQR
 *
 * 新打印通道：desktop 經 Companion（localhost）、Android 經 native bridge、互聯網備援經 relay。
 *
 * ⚠️ 2026-09-17：**已移除 `applyPairText()`**。它解析 `IP:8787` 配對地址，對應中繼機嘅
 * `HubHttpServer`（NanoHTTPD 8787；該 APK 端檔案亦已同步刪除，見 print-relay v1.1.5）。
 * 該通道要求網頁同中繼機**同一個 LAN 網段**才打得到，
 * 但 iPad 根本打唔到（`127.0.0.1` 係 iPad 自己），Android 平板亦已有更好的 PosNative 直印；
 * 結果設計目標同 relay 重疊，且**全 repo 零呼叫端**（從未接通）。
 * 中繼機出紙一律走雲端 relay（Supabase Realtime → claim），見 `relay-config.ts`。
 */

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import { loadDeviceConfig, loadKioskPrinters } from "@/lib/storage";
import { defaultDeviceConfig } from "@/lib/mock-data";

declare global {
  interface Window {
    jsQR?: (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options?: unknown,
    ) => { data: string } | null;
  }
}

/**
 * 按 PrintJob.printerGroup 由 config.printers 搵出目標打印機（單一真源）。
 *
 * ⚠️ 2026-09-11（docs/87 §6.2）：**要連 kiosk 專屬打印機一齊搵**。
 * 自助點餐機嘅小票 job 帶住 `printerId` = 一部**唔喺 `deviceConfig.printers`** 嘅機
 * （商家喺 `/order` 裝置設定加嘅「自助點餐機打印機」）。若果唔合併，
 * 就會出現最陰險嘅情況：step 1（by printerId）搵唔到 → 跌落 step 2（by role）
 * → **靜靜地印去收銀台嗰部收據機**，商家以為 kiosk 打印機冇反應。
 *
 * 非 kiosk 環境 `loadKioskPrinters()` 回 `[]` → 行為同以前 100% 一樣。
 */
export function resolveJobPrinter(job: PrintJob): DevicePrinterConfig | undefined {
  const printers = [
    ...(loadDeviceConfig() ?? defaultDeviceConfig).printers,
    ...loadKioskPrinters(),
  ];
  // 1) 直接用 job 記錄嘅 printerId（建 job 時已對應到某部 config.printers）
  if (job.printerId) {
    const byId = printers.find((p) => p.id === job.printerId && p.enabled);
    if (byId) return byId;
  }
  // 2) 按 printerGroup 對應 role / zoneId
  if (job.printerGroup === "receipt") {
    return printers.find((p) => p.role === "receipt" && p.enabled);
  }
  if (job.printerGroup === "label") {
    return printers.find((p) => p.role === "label" && p.enabled);
  }
  // 分區打印機：zoneId 對應 printerGroup
  return printers.find(
    (p) => (p.role === "zone" || p.role === "label") && (p.zoneId ?? "") === job.printerGroup && p.enabled,
  );
}

/**
 * 新 PrintJob 嘅初始狀態。
 * 一律回 "pending"，交畀背景 flush worker（dispatch.ts）按 native / companion / relay 通道派發；
 * 無可用通道時 worker 會維持 pending 等下次 flush。Printer Hub 已移除（見 docs/50），
 * 唔再樂觀標 "sent"（否則 worker 會 skip 呢啲 job，永遠唔會真正出單）。
 */
export function resolvePrintJobStatus(_networkOnline: boolean): PrintJob["status"] {
  return "pending";
}

// ─────────────────────────────────────────────────────────────
// QR 掃描（動態載入 jsQR from CDN，同 print.html）
// ─────────────────────────────────────────────────────────────

export function loadJsQr(): Promise<((data: Uint8ClampedArray, width: number, height: number) => { data: string } | null) | null> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.jsQR === "function") {
      resolve(window.jsQR);
      return;
    }
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const existing = document.querySelector("script[data-jsqr]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.jsQR ?? null));
      existing.addEventListener("error", () => resolve(null));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
    s.async = true;
    s.setAttribute("data-jsqr", "1");
    s.onload = () => resolve(window.jsQR ?? null);
    s.onerror = () => resolve(null);
    document.body.appendChild(s);
  });
}
