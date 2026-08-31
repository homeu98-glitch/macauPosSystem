// Native Print Agent bridge —— POS 經 window.PosNative.* 直接落單去 Sunmi APK。
//
// 呢條係「格式適配」嘅主路：APK 收到 PrintJob JSON 後用 EscPosRenderer
// （renderReceiptTicket / renderKitchenTicket）產生完整 ESC/POS 票據
// （店名抬頭、票種、單號、時間戳、切紙、每台 charset）。
//
// 非 Android / 無 native bridge 時，dispatch.ts 同 salon/print.ts 會 fallback
// 去 sendJobToCompanion（桌面 Companion 代理），所以呢度只負責「有 bridge 時點樣發」。

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import type { PrinterCandidate } from "@/lib/print-bridge/companion";

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
        // 收據主行菜價（基價 × quantity；OrderItem.price 已扣減 spec delta 避免重複收費，§17）。
        // 舊版 APK / Companion renderer 認唔到會忽略（forward-compatible）。
        // POS 自己嘅 EscPosPreview 已經 render；agent 升級後即可印到實紙。
        ...(typeof it.price === "number" ? { price: it.price } : {}),
        // 單品折扣（原價 / 折後 / 折扣率 / 折讓）—— 仿 57.doc 風格嘅 sub-line 必須傳。
        // 缺省不傳：forward-compatible（§20：只喺 typeof === "number" 時 spread）。
        ...(typeof it.discountRate === "number" ? { discountRate: it.discountRate } : {}),
        ...(typeof it.originalUnitPrice === "number" ? { originalUnitPrice: it.originalUnitPrice } : {}),
        ...(typeof it.discountedUnitPrice === "number" ? { discountedUnitPrice: it.discountedUnitPrice } : {}),
        ...(typeof it.savingAmount === "number" ? { savingAmount: it.savingAmount } : {}),
        specs: it.specs ?? [],
        note: it.note ?? "",
      })),
      createdAt,
      // ── 模板驅動（docs/55 §2.1 / docs/74）：與 Companion 同源 ──
      // 之前呢兩欄冇轉發，APK 收唔到模板快照 → fallback 硬編碼渲染，
      // 導致用家喺 print-center 設嘅字型大小（細/中/大）、粗體、對齊、
      // 區塊順序、抬頭/結尾文字一律唔會落到紙上（「揀大但出細」）。
      // 舊版 APK 認唔到呢兩個欄位會自動忽略，屬向後兼容，唔會 regression。
      template: job.template ?? null,
      content: job.content ?? null,
    },
    printer: {
      id: opts.printer.id,
      name: opts.printer.name,
      connectionType: opts.printer.connectionType,
      ipAddress: opts.printer.ipAddress ?? "",
      lanPort: opts.printer.lanPort ?? 9100,
      paperSize: opts.printer.paperSize ?? "",
      charset: opts.printer.charset ?? "gb18030",
      // 中文倍大指令（商頌 POS-80 = GS ! n，標準機 = FS ! n；空缺 Android 渲染器 fallback GS ! n）
      kanjiEnlarge: opts.printer.kanjiEnlarge ?? "GS!",
      // 行距覆寫（docs/74 §8.2）：逐機型校準大字行距，唔使 rebuild APK。空缺 = 渲染器預設 30/30/60。
      lineSpacing: opts.printer.lineSpacing ?? null,
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

// ──────────────────────────────────────────────────────────────────────────
// Android APK 原生發現（USB / 藍牙）—— 對應 PosNative 嘅 listUsbPrinters /
// listBtPrinters / scanBtPrinters / requestUsbPermission / requestBtPermission。
// 只有跑喺 Android WebView（isNativeBridgeAvailable）先有用；PC 用 Companion agent。
// ──────────────────────────────────────────────────────────────────────────

function nativeHexId(n: unknown): string {
  const num = typeof n === "number" ? n : parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(num) || num <= 0) return "";
  return "0x" + num.toString(16).toUpperCase().padStart(4, "0");
}

interface NativeBridge {
  listUsbPrinters?: () => unknown;
  requestUsbPermission?: (vid: number, pid: number) => unknown;
  listBtPrinters?: () => unknown;
  scanBtPrinters?: () => unknown;
  stopBtScan?: () => unknown;
  requestBtPermission?: () => unknown;
}

function getNativeBridge(): NativeBridge | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { PosNative?: NativeBridge }).PosNative;
  return p ?? null;
}

/** Android：插住嘅 USB ESC/POS 打印機清單（VID/PID/label/權限）。 */
export async function listNativeUsbPrinters(): Promise<PrinterCandidate[]> {
  const b = getNativeBridge();
  if (!b?.listUsbPrinters) return [];
  try {
    const res = b.listUsbPrinters() as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { printers?: unknown[] }) : (res as { printers?: unknown[] });
    const list = parsed.printers ?? [];
    return list.map((raw) => {
      const p = raw as { vendorId?: number; productId?: number; label?: string; name?: string; productName?: string };
      return {
        source: "usb",
        name: p.label || p.productName || p.name || `USB 打印機 ${nativeHexId(p.vendorId)}`,
        connectionType: "usb",
        usbVendorId: nativeHexId(p.vendorId),
        usbProductId: nativeHexId(p.productId),
      } as PrinterCandidate;
    });
  } catch {
    return [];
  }
}

/** Android：彈出系統授權對話框畀指定 VID/PID（已授權返 granted=true）。 */
export async function requestNativeUsbPermission(
  vid: number,
  pid: number,
): Promise<{ granted: boolean }> {
  const b = getNativeBridge();
  if (!b?.requestUsbPermission) return { granted: false };
  try {
    const res = b.requestUsbPermission(vid, pid) as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { granted?: boolean }) : (res as { granted?: boolean });
    return { granted: !!parsed.granted };
  } catch {
    return { granted: false };
  }
}

/** Android：已配對（bonded）藍牙打印機清單。 */
export async function listNativeBtPrinters(): Promise<PrinterCandidate[]> {
  const b = getNativeBridge();
  if (!b?.listBtPrinters) return [];
  try {
    const res = b.listBtPrinters() as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { printers?: unknown[] }) : (res as { printers?: unknown[] });
    const list = parsed.printers ?? [];
    return list.map((raw) => {
      const p = raw as { address?: string; name?: string; bluetoothName?: string };
      const name = p.name || p.bluetoothName || p.address || "藍牙打印機";
      return {
        source: "bluetooth",
        name,
        connectionType: "bluetooth",
        bluetoothName: name,
        bluetoothAddress: p.address,
      } as PrinterCandidate;
    });
  } catch {
    return [];
  }
}

/** Android：開始藍牙探索；結果經 window.onBtPrinterFound(candidate) 回傳。 */
export async function scanNativeBtPrinters(): Promise<{ ok: boolean }> {
  const b = getNativeBridge();
  if (!b?.scanBtPrinters) return { ok: false };
  try {
    const res = b.scanBtPrinters() as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { ok?: boolean }) : (res as { ok?: boolean });
    return { ok: parsed.ok !== false };
  } catch {
    return { ok: false };
  }
}

/** Android：觸發藍牙 runtime 授權（Android 12+）。 */
export async function requestNativeBtPermission(): Promise<{ ok: boolean }> {
  const b = getNativeBridge();
  if (!b?.requestBtPermission) return { ok: false };
  try {
    const res = b.requestBtPermission() as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { ok?: boolean }) : (res as { ok?: boolean });
    return { ok: parsed.ok !== false };
  } catch {
    return { ok: false };
  }
}
