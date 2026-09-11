"use client";

import { loadBootstrapCache } from "@/lib/storage";
import type { DevicePrinterConfig, PrintJob, PrintKind } from "@/lib/types";
import { isCompanionConfigured, sendJobToCompanion, shouldKeepCompanionAlive } from "@/lib/print-bridge/companion";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { getRelayTransport, isRelayConfigured } from "@/lib/print-bridge/relay-config";

/**
 * 測試打印（2026-09-11 由 `device-settings.tsx` 抽出成共用模組）。
 *
 * 點解要抽：呢段「三條通道逐條試」嘅邏輯本來只喺收銀台裝置設定用。
 * 加入「自助點餐機打印機」設定（`/order` 裝置設定，見 docs/87 §6.2）之後，
 * kiosk 都要有「測試打印」撳——照抄一份一定會出現「改咗其中一邊、另一邊唔同步」。
 *
 * 通道次序（同 `dispatchOneJob` 一致）：
 *   1. Native Print Agent（Android APK WebView）
 *   2. 桌面 Companion 代理（loopback，必須真係 Companion 環境）
 *   3. Cloud Print Relay（雲端中繼，互聯網備援）
 *   4. 都冇 → 明確講「未配置任何打印通道」，唔好誤導用戶以為 Companion 已啟動
 */

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface TestPrintResult {
  ok: boolean;
  /** 直接顯示畀用戶嘅訊息（成功 / 失敗原因）。 */
  message: string;
}

/** 依打印機 role 砌出測試用 PrintJob（內容同收銀台一致）。 */
export function buildTestPrintJob(printer: DevicePrinterConfig): PrintJob {
  return {
    id: uid("print"),
    orderId: "",
    orderNo: "TEST",
    tableName: "",
    ticketType: "normal",
    printerGroup:
      printer.role === "receipt"
        ? "receipt"
        : printer.role === "label"
          ? "label"
          : printer.zoneId ?? "zone:test",
    printerId: printer.id,
    printerName: printer.name,
    items: [{ name: "Macau POS 測試打印", quantity: 1, specs: [], note: "Printer Test OK" }],
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export async function sendTestPrint(printer: DevicePrinterConfig): Promise<TestPrintResult> {
  const copies = Math.max(1, Math.floor(printer.copies ?? 1));
  const testJob = buildTestPrintJob(printer);

  try {
    const storeName = loadBootstrapCache()?.storeName;
    const kind: PrintKind = "test";

    // 1) Native Print Agent（Android APK WebView）優先：經 PosNative 觸發 APK renderTestPage
    if (isNativeBridgeAvailable()) {
      let lastErr = "";
      for (let i = 0; i < copies; i++) {
        const res = await dispatchJobToNative(testJob, { printer, kind, storeName });
        if (!res.ok) {
          lastErr = res.error || `未能送出 ${printer.name} 測試打印。`;
          break;
        }
      }
      return {
        ok: !lastErr,
        message: lastErr
          ? lastErr
          : `已透過 Native Print Agent 送出 ${printer.name} 測試打印（${copies} 份）。`,
      };
    }

    // 2) 桌面 Companion 代理（loopback http://127.0.0.1:9311）——
    //    必須同時係「Companion 環境」（原生殼 / `?companion=` URL 參數）。
    //    純 website / PWA 即便 localStorage 有 stale `macau-pos-companion-url` 都要 skip——
    //    否則會無謂打 5s 連唔到嘅 loopback（companion-transport.ts 嘅 5s AbortController
    //    超時先返），同 `dispatchOneJob` 嘅 companion 分支語義完全對齊。
    if (shouldKeepCompanionAlive() && isCompanionConfigured()) {
      let lastErr = "";
      for (let i = 0; i < copies; i++) {
        const r = await sendJobToCompanion(testJob, printer);
        if (!r.ok) {
          lastErr = r.error ?? "";
          break;
        }
      }
      return {
        ok: !lastErr,
        message: lastErr
          ? `Companion 測試打印失敗：${lastErr}`
          : `已透過 Companion 送出 ${printer.name} 測試打印（${copies} 份）。`,
      };
    }

    // 3) Cloud Print Relay（雲端中繼，互聯網備援）——
    //    網頁 / PWA 嘅預設打印通道（companion 環境 gate 過唔到就落到呢度）。
    //    走 `getRelayTransport().send()`，同 `dispatchOneJob` relay 分支一致：
    //    relay 內部會 `flushPosSyncQueue` 確保 PRINT_JOB_CREATED 已上雲，
    //    中繼 APK 隨後經 Realtime 訂閱 + claim RPC 拎走出紙。
    if (isRelayConfigured()) {
      const relay = getRelayTransport();
      if (relay) {
        let lastErr = "";
        for (let i = 0; i < copies; i++) {
          const res = await relay.send(testJob, printer, { kind, storeName });
          if (!res.ok) {
            lastErr = res.error || "relay 打印失敗";
            break;
          }
        }
        return {
          ok: !lastErr,
          message: lastErr
            ? `Print Relay 測試打印失敗：${lastErr}`
            : `已透過 Print Relay 送出 ${printer.name} 測試單到雲端中繼（${copies} 份，店內中繼機會自動出紙）。`,
        };
      }
    }

    // 4) 真係乜都冇 —— 唔再誤導「桌面 Companion 已啟動」（喺 web/PWA 開 desktop agent 根本無解）
    return {
      ok: false,
      message:
        "未配置任何打印通道：請到「打印中繼」分頁配對雲端備援（relay），或於桌面裝置啟動 Companion 代理後再測試。",
    };
  } catch {
    return { ok: false, message: `未能送出 ${printer.name} 測試打印。` };
  }
}
