// Native Print Agent bridge —— POS 經 window.PosNative.* 直接落單去 Sunmi APK。
//
// 呢條係「格式適配」嘅主路：APK 收到 PrintJob JSON 後用 EscPosRenderer
// （renderReceiptTicket / renderKitchenTicket）產生完整 ESC/POS 票據
// （店名抬頭、票種、單號、時間戳、切紙、每台 charset）。
//
// 非 Android / 無 native bridge 時，dispatch.ts 同 salon/print.ts 會 fallback
// 去 sendJobToHub（純文字路徑），所以呢度只負責「有 bridge 時點樣發」。

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";

export type NativePrintKind = "receipt" | "kitchen" | "test";

/** 判斷 POS 而家係咪跑喺 Sunmi APK WebView（有 PosNative bridge）。 */
export function isNativeBridgeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const p = (window as unknown as { PosNative?: { printJob?: unknown } }).PosNative;
  return !!(p && typeof p.printJob === "function");
}

interface NativeDispatchOpts {
  printer: DevicePrinterConfig;
  kind: NativePrintKind;
  storeName?: string;
  /** 收據用：直接經 APK 參數印總計（我哋暫唔用，靠 job.items note 兼容 HTTP fallback）。 */
  paymentMethod?: string;
  total?: number;
}

/**
 * 經 PosNative.printJob(json) 落單。
 * APK 同步回傳 JSON 字串：okQueued（ok=true, queued=true）或 err(error)。
 * 真正打印結果會經 window.__posNativePrintResult 非同步回，但呢度以「成功 queue」當 ok。
 */
export async function dispatchJobToNative(
  job: PrintJob,
  opts: NativeDispatchOpts,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isNativeBridgeAvailable()) {
    return { ok: false, error: "PosNative bridge 未可用" };
  }

  const createdAt = job.createdAt ? Date.parse(job.createdAt) || Date.now() : Date.now();

  const payload = {
    job: {
      id: job.id,
      orderNo: job.orderNo ?? "",
      tableName: job.tableName ?? "",
      orderId: job.orderId ?? "",
      printerGroup: job.printerGroup,
      ticketType: job.ticketType,
      printerId: job.printerId ?? "",
      printerName: job.printerName,
      items: (job.items ?? []).map((it) => ({
        name: it.name,
        quantity: it.quantity,
        specs: it.specs ?? [],
        note: it.note ?? "",
      })),
      createdAt,
    },
    printer: {
      id: opts.printer.id,
      name: opts.printer.name,
      connectionType: opts.printer.connectionType,
      ipAddress: opts.printer.ipAddress ?? "",
      lanPort: opts.printer.lanPort ?? 9100,
      paperSize: opts.printer.paperSize ?? "",
      charset: opts.printer.charset ?? "gb18030",
      // 雙路徑 contract（Phase 0）：USB / Bluetooth 連接識別
      usbVendorId: opts.printer.usbVendorId ?? "",
      usbProductId: opts.printer.usbProductId ?? "",
      bluetoothAddress: opts.printer.bluetoothAddress ?? "",
      bluetoothName: opts.printer.bluetoothName ?? "",
    },
    kind: opts.kind,
    storeName: opts.storeName ?? "",
    paymentMethod: opts.paymentMethod ?? "",
    total: typeof opts.total === "number" ? opts.total : null,
    // 雙路徑 contract（Phase 0）：relay 路由 + job 過期
    storeId: job.storeId ?? "",
    ttl: typeof job.ttl === "number" ? job.ttl : null,
  };

  try {
    const res = (window as unknown as { PosNative: { printJob: (json: string) => unknown } }).PosNative.printJob(
      JSON.stringify(payload),
    );
    if (typeof res === "string") {
      try {
        const parsed = JSON.parse(res) as { ok?: boolean; queued?: boolean; error?: string };
        if (parsed && (parsed.ok === true || parsed.queued === true)) return { ok: true };
        if (parsed && parsed.error) return { ok: false, error: String(parsed.error) };
      } catch {
        // 非 JSON 同步回傳：當作已 queue
        return { ok: true };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
