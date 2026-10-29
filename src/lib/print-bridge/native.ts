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
      // 收據二維碼（docs/95 §2）：POS 端已 encode 成點陣，APK 淨負責點陣 → ESC/POS 點陣圖。
      // 冇填網址時兩個欄位都係 undefined → 唔傳（舊版 APK 唔會因為多咗欄位而 parse 失敗）。
      ...(job.qrUrl ? { qrUrl: job.qrUrl } : {}),
      ...(job.qr ? { qr: job.qr } : {}),
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

/**
 * Android：探測 LAN 打印機 `ip:port` 有冇 listening。
 *
 * 對應 desktop 條路嘅 `probeLan()`（`POST /api/probe-lan`）。
 *
 * ⚠️ 同 desktop 嘅分別：desktop 走 `companionFetch` → HTTP；
 * Android 走 `window.PosNative.probeLan()` in-process（同步回 JSON）。
 * 兩者回同一個形狀（`{ ok, ip, port, reachable }`），呼叫端唔使分環境。
 *
 * 注意：Android native 分支**唔受** `shouldUseCompanionChannel()` 限制 ——
 * 呢個係 native 環境獨有嘅能力（見 native-environment.ts）。
 */
export async function probeNativeLan(ip: string, port = 9100): Promise<boolean> {
  const b = getNativeBridge() as (NativeBridge & {
    probeLan?: (ip: string, port: number) => unknown;
  }) | null;
  if (!b?.probeLan) return false;
  try {
    const res = b.probeLan(ip, port) as unknown;
    const parsed =
      typeof res === "string"
        ? (JSON.parse(res) as { reachable?: boolean })
        : (res as { reachable?: boolean });
    return parsed?.reachable === true;
  } catch {
    return false;
  }
}

function getNativeBridge(): NativeBridge | null {
  if (typeof window === "undefined") return null;
  const p = (window as unknown as { PosNative?: NativeBridge }).PosNative;
  return p ?? null;
}

// ──────────────────────────────────────────────────────────────────────────
// Android：整段網域掃描（2026-10-29 · P3「打印脫離 Sunmi」）
// ──────────────────────────────────────────────────────────────────────────

/** 掃描到嘅一部主機（APK `LanScanner.ScanHit` 嘅鏡像）。 */
export interface LanScanHit {
  ip: string;
  mac?: string;
  openPorts: number[];
  hostname?: string;
}

export interface LanScanOutcome {
  ok: boolean;
  hits: LanScanHit[];
  /** `ok=false` 時嘅原因（拎唔到本機 IP／逾時／已取消／機型唔支援）。 */
  error?: string;
  /** 本機所屬網段前三段，例如 `192.168.1`。 */
  subnet?: string;
}

export interface LanScanProgress {
  checked: number;
  total: number;
  found: number;
}

/** 同一時間只可能有一次掃描 → 用單一 resolver，避免多個 promise 爭回呼。 */
let lanScanResolve: ((r: LanScanOutcome) => void) | null = null;
let lanScanTimer: ReturnType<typeof setTimeout> | null = null;

function parseMaybeJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function settleLanScan(result: LanScanOutcome): void {
  if (lanScanTimer) {
    clearTimeout(lanScanTimer);
    lanScanTimer = null;
  }
  const resolve = lanScanResolve;
  lanScanResolve = null;
  resolve?.(result);
  // 回呼留喺 window 上冇害（下一次掃描會覆蓋），但清走可以避免舊 promise 已被
  // 結算後仍然觸發 `onProgress` 令 UI 亂跳。
  if (typeof window !== "undefined") {
    const w = window as unknown as {
      __onLanScanProgress?: unknown;
      __onLanScanResult?: unknown;
    };
    w.__onLanScanProgress = undefined;
    w.__onLanScanResult = undefined;
  }
}

/**
 * Android：掃描整個網段，列出有開 9100／631／80 嘅主機。
 *
 * ─────────────────────────────────────────────────────────────
 * 為何要（2026-10-29）
 * ─────────────────────────────────────────────────────────────
 * 之前 Android 只有 `probeNativeLan(ip)` —— **要店員自己知打印機 IP** 先加得到機。
 * 但換走 Sunmi 一體機之後，門店用嘅係普通 Android 平板 ＋ 網絡打印機，而打印機
 * IP 係 DHCP 派、機身又冇顯示 → 等於裝唔到機。APK 側嘅 `LanScanner` 一直存在
 * （64 並發、讀 ARP 攞 MAC、帶進度），只係從來冇經 bridge 匯出。
 *
 * 對應 desktop 條路嘅 `discoverCompanionLanPrinters()`（`:9311/api/discover`）；
 * 兩者回傳都會被呼叫端收斂成 `LanScanHit[]`。
 *
 * ⚠️ 逾時 45 秒：APK 側理論上一定會回（`__onLanScanResult`），但 native 崩／
 * 被系統殺嘅話 promise 會永遠掛住 → UI 永遠「搜尋中」。防守性結算係必要的。
 *
 * ⚠️ 只喺 Android native 環境有效；其他環境回 `ok:false` 而**唔會** throw，
 * 呼叫端可以一律顯示「此環境不支援自動搜尋，請手動填 IP」。
 */
export async function scanNativeLanPrinters(
  onProgress?: (p: LanScanProgress) => void,
): Promise<LanScanOutcome> {
  const b = getNativeBridge() as
    | (NativeBridge & { scanLanPrinters?: () => unknown; stopLanScan?: () => unknown })
    | null;
  if (!b?.scanLanPrinters) {
    return { ok: false, hits: [], error: "此裝置唔支援自動搜尋（請手動填 IP）" };
  }

  // 上一次未完 → 先結算，否則舊 promise 永遠唔 resolve（memory leak + UI 卡死）。
  if (lanScanResolve) settleLanScan({ ok: false, hits: [], error: "已被新一次搜尋取代" });

  const w = window as unknown as {
    __onLanScanProgress?: (raw: unknown) => void;
    __onLanScanResult?: (raw: unknown) => void;
  };

  return new Promise<LanScanOutcome>((resolve) => {
    lanScanResolve = resolve;

    w.__onLanScanProgress = (raw) => {
      const p = parseMaybeJson(raw);
      if (!p) return;
      onProgress?.({
        checked: Number(p.checked ?? 0),
        total: Number(p.total ?? 0),
        found: Number(p.found ?? 0),
      });
    };

    w.__onLanScanResult = (raw) => {
      const p = parseMaybeJson(raw);
      if (!p) {
        settleLanScan({ ok: false, hits: [], error: "掃描結果格式不正確" });
        return;
      }
      const rawHits = Array.isArray(p.hits) ? (p.hits as unknown[]) : [];
      const hits: LanScanHit[] = rawHits
        .map((item) => parseMaybeJson(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          ip: String(item.ip ?? ""),
          mac: item.mac ? String(item.mac) : undefined,
          openPorts: Array.isArray(item.openPorts)
            ? (item.openPorts as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
            : [],
          hostname: item.hostname ? String(item.hostname) : undefined,
        }))
        .filter((h) => h.ip.length > 0);

      settleLanScan({
        ok: p.ok !== false,
        hits,
        error: typeof p.error === "string" && p.error ? p.error : undefined,
        subnet: typeof p.subnet === "string" ? p.subnet : undefined,
      });
    };

    lanScanTimer = setTimeout(() => {
      settleLanScan({ ok: false, hits: [], error: "搜尋逾時（45 秒）" });
    }, 45_000);

    try {
      const res = b.scanLanPrinters!() as unknown;
      const parsed = parseMaybeJson(res);
      // 例如「拎唔到本機 IP」會即時回 ok:false —— 唔使等 45 秒。
      if (parsed && parsed.ok === false) {
        settleLanScan({
          ok: false,
          hits: [],
          error: typeof parsed.error === "string" ? parsed.error : "搜尋未能開始",
        });
      }
    } catch (e) {
      settleLanScan({ ok: false, hits: [], error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** 取消進行中嘅網段掃描（離開設定頁／關閉精靈時叫，避免背景繼續掃）。 */
export function stopNativeLanScan(): void {
  const b = getNativeBridge() as (NativeBridge & { stopLanScan?: () => unknown }) | null;
  try {
    b?.stopLanScan?.();
  } catch {
    // 取消失敗無所謂：APK 側 job 會自然完成
  }
  settleLanScan({ ok: false, hits: [], error: "已取消" });
}

/**
 * Android：插住嘅 USB ESC/POS 打印機清單。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 2026-09-18：修正「欄位在半路被丟棄」
 * ─────────────────────────────────────────────────────────────
 * 舊版只 map 4 個欄位（`source / name / connectionType / usbVendorId / usbProductId`），
 * 其餘全部丟棄 —— 就算 APK 側（`UsbPrinterCandidate.toJson()`）已經帶齊
 * `charset` / `paperSize` / `kanjiEnlarge` / `family` / `max|minLabelWidthMm`，
 * 呢個 mapper 都會將佢哋扔走。
 *
 * 後果（具體）：漢印 SL42 係標籤機（`family=label`、`charset=utf-8`、
 * `paperSize=100x75mm`），`printer-wizard-modal.tsx` 嘅 `selectUsbDevice()`
 * 收到冇 family 嘅 candidate → 當 `receipt` 處理 → 套 80mm 連續紙版面 →
 * 打去 100×75 標籤卷 → **出紙亂版**。
 *
 * 而家與 desktop 條路（`companion.ts` 嘅 `enumerateCompanionUsbPrinters()`）對齊，
 * 回同一個 `PrinterCandidate` 形狀。
 */
export async function listNativeUsbPrinters(): Promise<PrinterCandidate[]> {
  const b = getNativeBridge();
  if (!b?.listUsbPrinters) return [];
  try {
    const res = b.listUsbPrinters() as unknown;
    const parsed = typeof res === "string" ? (JSON.parse(res) as { printers?: unknown[] }) : (res as { printers?: unknown[] });
    const list = parsed.printers ?? [];
    return list.map((raw) => {
      const p = raw as {
        vendorId?: number;
        productId?: number;
        label?: string;
        name?: string;
        productName?: string;
        model?: string;
        charset?: string;
        paperSize?: string;
        kanjiEnlarge?: string;
        family?: string;
        maxLabelWidthMm?: number | null;
        minLabelWidthMm?: number | null;
      };
      // 型號表認到就用型號名，否則退回品牌/產品名（與 desktop 同口徑）。
      const displayName = p.model || p.label || p.productName || p.name || `USB 打印機 ${nativeHexId(p.vendorId)}`;
      return {
        source: "usb",
        name: displayName,
        connectionType: "usb",
        usbVendorId: nativeHexId(p.vendorId),
        usbProductId: nativeHexId(p.productId),
        // ── 以下 6 個係 2026-09-18 補上（USB 型號表解析結果）──
        // `selectUsbDevice()` 直接消費 model / charset / paperSize / kanjiEnlarge / family。
        model: p.model,
        charset: p.charset || undefined,
        paperSize: p.paperSize || undefined,
        kanjiEnlarge: p.kanjiEnlarge === "FS!" || p.kanjiEnlarge === "GS!" ? p.kanjiEnlarge : undefined,
        family:
          p.family === "receipt" || p.family === "label" || p.family === "portable"
            ? p.family
            : undefined,
        maxLabelWidthMm: typeof p.maxLabelWidthMm === "number" ? p.maxLabelWidthMm : undefined,
        minLabelWidthMm: typeof p.minLabelWidthMm === "number" ? p.minLabelWidthMm : undefined,
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
