/**
 * Native print agent adapter — 當 POS 跑喺 Android WebView 外殼入面，
 * Kotlin 端會注入 `window.PosNative` JS bridge，POS 直接呼叫做 LAN 打印。
 *
 * 無 mixed content、無 Tunnel、無 cert；斷網照印（LAN 係本地 socket）。
 *
 * Bridge 合約（MainActivity.kt → Bridge()）:
 *   PosNative.printJob(payloadJson): string   — 同步回 {ok,queued,jobId,ip,port}；異步 window.__posNativePrintResult(json)
 *   PosNative.testPrint(payloadJson): string   — 同上
 *   PosNative.getStatus(): string              — {ok,available,localIp,printerCount}
 *   PosNative.listDevices(): string             — {ok,devices:[...]}
 *   PosNative.openPrinterSettings(): void      — 跳 app 內掃描/綁定 UI
 *   PosNative.backToPos(): void                — 返回 POS
 *
 * 完全取代策略：只有 Android 裝置能打印；desktop / tablet 無 PosNative 就 fallback 走舊 HTTP bridge（如有設）。
 */

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";

/** window 上可能存在嘅 PosNative bridge（由 Android WebView 注入）。 */
interface PosNativeBridge {
  printJob(payloadJson: string): string;
  testPrint(payloadJson: string): string;
  getStatus(): string;
  listDevices(): string;
  openPrinterSettings(): void;
  backToPos(): void;
}

declare global {
  interface Window {
    PosNative?: PosNativeBridge;
    __posNativePrintResult?: (json: string) => void;
  }
}

/** 當前係咪跑喺 native Android WebView 外殼入面。 */
export function isNativeBridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PosNative?.printJob === "function";
}

/** Bridge 同步回應嘅形狀。 */
interface NativeSyncResponse {
  ok: boolean;
  queued?: boolean;
  jobId?: string;
  ip?: string;
  port?: number;
  error?: string;
}

/** 異步結果回呼嘅形狀（window.__posNativePrintResult）。 */
interface NativeAsyncResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

/**
 * 把 DevicePrinterConfig 揀成 Kotlin 端需要嘅子集。
 * 加 `charset` 俾每台打印機獨立配（預設 GB18030）。
 */
function toPrinterPayload(printer: DevicePrinterConfig | null) {
  if (!printer) return undefined;
  return {
    id: printer.id,
    name: printer.name,
    role: printer.role,
    connectionType: printer.connectionType,
    ipAddress: printer.ipAddress,
    lanPort: printer.lanPort ?? 9100,
    paperSize: printer.paperSize,
    model: printer.model,
    charset: printer.charset, // 可選；null 就走 Kotlin 預設 GB18030
  };
}

/**
 * 把 PrintJob + printer + meta 包成 bridge payload JSON。
 * kind: "kitchen" | "receipt" | "test"
 */
function buildPayload(
  job: PrintJob,
  printer: DevicePrinterConfig | null,
  meta?: Record<string, unknown>,
  kind: "kitchen" | "receipt" | "test" = "kitchen",
) {
  return JSON.stringify({
    job: {
      id: job.id,
      orderId: job.orderId,
      orderNo: job.orderNo,
      tableName: job.tableName,
      ticketType: job.ticketType,
      printerGroup: job.printerGroup,
      printerId: job.printerId,
      printerName: job.printerName,
      items: job.items,
      createdAt: job.createdAt,
    },
    printer: toPrinterPayload(printer),
    kind,
    storeName: (meta?.storeName as string) || undefined,
    paymentMethod: (meta?.paymentMethod as string) || undefined,
    total: meta?.total as number | undefined,
    meta,
  });
}

/**
 * 透過 native bridge 落單打印。
 *
 * printJob() 同步 return okQueued；真正打印異步完成後 Kotlin 會
 * evalJs("window.__posNativePrintResult(json)")。
 *
 * 呢個 function 返回一個 Promise，等異步結果（最多 8 秒超時）。
 * 如果 sync response 已經係 error，即刻 reject。
 */
export function dispatchJobToNative(
  job: PrintJob,
  printer: DevicePrinterConfig | null,
  meta?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isNativeBridgeAvailable() || !window.PosNative) {
    return Promise.resolve({ ok: false, error: "Native bridge 唔可用" });
  }

  const payload = buildPayload(job, printer, meta, "kitchen");

  const bridge = window.PosNative;
  if (!bridge) {
    return Promise.resolve({ ok: false, error: "Native bridge 唔可用" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // 超時——但 native 可能仍然喺度印緊；我哋當佢 queued ok（同步 response 已 ok）
      resolve({ ok: true });
    }, 8000);

    function onResult(json: string) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const r: NativeAsyncResult = JSON.parse(json);
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error ?? "打印失敗" });
      } catch {
        resolve({ ok: true }); // 解析唔到都當 ok（sync 已 queued）
      }
    }

    function cleanup() {
      window.clearTimeout(timeout);
      // 釋放回呼，避免重複觸發
      if (window.__posNativePrintResult === onResult) {
        window.__posNativePrintResult = undefined;
      }
    }

    window.__posNativePrintResult = onResult;

    try {
      const sync: NativeSyncResponse = JSON.parse(bridge.printJob(payload));
      if (!sync.ok) {
        settled = true;
        cleanup();
        resolve({ ok: false, error: sync.error ?? "native printJob 同步失敗" });
        return;
      }
      // sync.ok + queued = 已 queue，等異步結果（或超時 ok）
    } catch (e) {
      settled = true;
      cleanup();
      resolve({ ok: false, error: e instanceof Error ? e.message : "native bridge 例外" });
    }
  });
}

/**
 * 透過 native bridge 測試打印。
 */
export function testPrintNative(
  printer: DevicePrinterConfig,
  meta?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isNativeBridgeAvailable() || !window.PosNative) {
    return Promise.resolve({ ok: false, error: "Native bridge 唔可用" });
  }

  const payload = JSON.stringify({
    printer: toPrinterPayload(printer),
    storeName: (meta?.storeName as string) || undefined,
    kind: "test",
  });

  const bridge = window.PosNative;
  if (!bridge) {
    return Promise.resolve({ ok: false, error: "Native bridge 唔可用" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true });
    }, 8000);

    function onResult(json: string) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const r: NativeAsyncResult = JSON.parse(json);
        resolve(r.ok ? { ok: true } : { ok: false, error: r.error ?? "測試打印失敗" });
      } catch {
        resolve({ ok: true });
      }
    }

    function cleanup() {
      window.clearTimeout(timeout);
      if (window.__posNativePrintResult === onResult) {
        window.__posNativePrintResult = undefined;
      }
    }

    window.__posNativePrintResult = onResult;

    try {
      const sync: NativeSyncResponse = JSON.parse(bridge.testPrint(payload));
      if (!sync.ok) {
        settled = true;
        cleanup();
        resolve({ ok: false, error: sync.error ?? "native testPrint 同步失敗" });
        return;
      }
    } catch (e) {
      settled = true;
      cleanup();
      resolve({ ok: false, error: e instanceof Error ? e.message : "native bridge 例外" });
    }
  });
}

/** Native bridge 健康檢查（同步，唔行 HTTP）。 */
export function fetchNativeHealth(): { ok: boolean; available: boolean; localIp?: string; printerCount?: number } {
  if (!isNativeBridgeAvailable()) {
    return { ok: false, available: false };
  }
  const bridge = window.PosNative;
  if (!bridge) {
    return { ok: false, available: false };
  }
  try {
    const raw = bridge.getStatus();
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      available?: boolean;
      localIp?: string;
      printerCount?: number;
    };
    return {
      ok: parsed.ok ?? false,
      available: parsed.available ?? false,
      localIp: parsed.localIp,
      printerCount: parsed.printerCount,
    };
  } catch {
    return { ok: false, available: false };
  }
}
