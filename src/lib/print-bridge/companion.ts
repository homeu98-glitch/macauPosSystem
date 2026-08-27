/**
 * 桌面 Companion 代理客戶端（取代 Sunmi Printer Hub）。
 *
 * 架構：POS（Vercel HTTPS / 本地 Electron）↔ Companion 代理（loopback http://127.0.0.1:9311）
 *        ↔ raw socket :9100 / node-usb / 藍牙 → 打印機。
 *
 * 優勢：
 *   - 零配置預配對：固定 loopback 地址 + 空 token，開 app 即自動連。
 *   - 跨平台：Windows / macOS / Linux 桌面 Electron 都經呢層打印（唔再靠 Android APK）。
 *   - 自動偵測：Companion 經 mDNS 掃區網 LAN 機、node-usb 枚舉 USB 機，商家唔使手填 VID/PID。
 *
 * localStorage 命名空間：macau-pos-companion-url / macau-pos-companion-token
 */

import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { loadDeviceConfig } from "@/lib/storage";
import { toHexId } from "@/lib/print-bridge/printer-models";

export const COMPANION_DEFAULT_URL = "http://127.0.0.1:9311";

const LS_URL = "macau-pos-companion-url";
const LS_TOKEN = "macau-pos-companion-token";

let cachedAvailable = false;
let cachedVersion = "";

// ─────────────────────────────────────────────────────────────
// 配置讀寫
// ─────────────────────────────────────────────────────────────

export function getCompanionUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LS_URL)?.trim() || "";
}

export function setCompanionUrl(url: string) {
  if (typeof window === "undefined") return;
  const v = url.trim();
  if (v) window.localStorage.setItem(LS_URL, v);
  else window.localStorage.removeItem(LS_URL);
}

export function getCompanionToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LS_TOKEN)?.trim() || "";
}

export function setCompanionToken(token: string) {
  if (typeof window === "undefined") return;
  const v = token.trim();
  if (v) window.localStorage.setItem(LS_TOKEN, v);
  else window.localStorage.removeItem(LS_TOKEN);
}

/** 是否已配對（地址非空即視為已配對；token 預設留空） */
export function isCompanionConfigured(): boolean {
  return getCompanionUrl() !== "";
}

export function getCachedCompanionVersion(): string {
  return cachedVersion;
}

// ─────────────────────────────────────────────────────────────
// 低階 fetch
// ─────────────────────────────────────────────────────────────

async function companionFetch(
  url: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const token = getCompanionToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (token) headers["X-POS-Token"] = token;
  return fetch(`${url}${path}`, { ...opts, headers, cache: "no-store" });
}

async function companionJson<T = unknown>(
  url: string,
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const r = await companionFetch(url, path, opts);
  if (!r.ok) throw new Error(`Companion ${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ─────────────────────────────────────────────────────────────
// 連線探測 / 自動配對
// ─────────────────────────────────────────────────────────────

export interface CompanionProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/** 探測指定（或當前已配對）Companion 地址是否可用 */
export async function probeCompanion(urlOverride?: string): Promise<CompanionProbeResult> {
  const url = urlOverride ?? (getCompanionUrl() || COMPANION_DEFAULT_URL);
  try {
    const j = (await companionJson<{ ok?: boolean; version?: string }>(url, "/api/health")) as {
      ok?: boolean;
      version?: string;
    };
    if (j && (j.ok || j.version)) {
      cachedAvailable = true;
      cachedVersion = j.version || cachedVersion;
      if (!getCompanionUrl()) setCompanionUrl(url);
      return { ok: true, version: cachedVersion };
    }
    cachedAvailable = false;
    return { ok: false, error: "Companion 回應唔正常" };
  } catch (e) {
    cachedAvailable = false;
    return { ok: false, error: e instanceof Error ? e.message : "Companion 離線" };
  }
}

/**
 * 零配置自動配對：優先 URL ?companion= → 已儲存地址 → 預設 loopback 探測。
 * 只要預設地址可連，就寫入 localStorage（token 留空），之後即用。
 */
export async function tryAutoPairCompanion(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  // 1) URL 參數（由桌面 Electron / 啟動器帶入）
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("companion");
    if (fromUrl) {
      const res = await probeCompanion(fromUrl.trim());
      if (res.ok) {
        setCompanionUrl(fromUrl.trim());
        return true;
      }
    }
  } catch {
    // ignore
  }

  // 2) 已儲存地址
  const stored = getCompanionUrl();
  if (stored) {
    const res = await probeCompanion(stored);
    return res.ok;
  }

  // 3) 預設 loopback 探測（零配置）
  const res = await probeCompanion(COMPANION_DEFAULT_URL);
  if (res.ok) {
    setCompanionUrl(COMPANION_DEFAULT_URL);
    setCompanionToken("");
    return true;
  }
  return false;
}

/** 取得可用性（recheck=true 時重新探測） */
export async function isCompanionAvailable(recheck = false): Promise<boolean> {
  if (recheck) {
    const res = await probeCompanion();
    return res.ok;
  }
  return cachedAvailable;
}

/** 畫面「測試連線」按鈕用：探測當前已配對地址 */
export async function testCompanionConnection(): Promise<CompanionProbeResult> {
  const url = getCompanionUrl();
  if (!url) return { ok: false, error: "未配對 Companion（地址空白）" };
  return probeCompanion(url);
}

// ─────────────────────────────────────────────────────────────
// 發送 PrintJob
// ─────────────────────────────────────────────────────────────

export async function sendJobToCompanion(
  job: PrintJob,
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = getCompanionUrl();
  if (!url) return { ok: false, error: "未配對 Companion 代理（http://127.0.0.1:9311 未啟動）" };
  try {
    const r = await companionFetch(url, "/api/print", {
      method: "POST",
      body: JSON.stringify({ job, printer }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (r.ok && (j.ok || r.status === 200)) return { ok: true };
    return { ok: false, error: j.error || `Companion 回應 HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "發送到 Companion 失敗" };
  }
}

// ─────────────────────────────────────────────────────────────
// 打印機發現（Meituan 式：商家唔使手填 VID/PID）
// ─────────────────────────────────────────────────────────────

export interface PrinterCandidate {
  source: "lan" | "usb" | "bluetooth";
  name: string;
  connectionType: "lan" | "usb" | "bluetooth";
  ipAddress?: string;
  lanPort?: number;
  usbVendorId?: string;
  usbProductId?: string;
  bluetoothName?: string;
  bluetoothAddress?: string;
  model?: string;
  charset?: string;
  paperSize?: string;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  Companion 由 VID/PID 對照型號表或 USB Printer Class 通用 fallback 回傳；web 直接採用。 */
  kanjiEnlarge?: "FS!" | "GS!";
}

interface DiscoveredLanPrinter {
  name?: string;
  ip?: string;
  port?: number;
  type?: string;
}

interface UsbPrinterRow {
  vendorId?: string | number;
  productId?: string | number;
  brand?: string;
  model?: string;
  charset?: string;
  paperSize?: string;
  kanjiEnlarge?: "FS!" | "GS!";
  recognized?: boolean;
}

/** mDNS 掃區網 LAN ESC/POS 機（:9100） */
export async function discoverCompanionLanPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; printers?: DiscoveredLanPrinter[] }>(
      url,
      "/api/discover",
    )) as { ok?: boolean; printers?: DiscoveredLanPrinter[] };
    return (j.printers ?? []).map((p) => ({
      source: "lan",
      name: p.name || `LAN 打印機 ${p.ip ?? ""}`,
      connectionType: "lan",
      ipAddress: p.ip,
      lanPort: p.port || 9100,
    }));
  } catch {
    return [];
  }
}

/** node-usb 枚舉 USB 打印機，按 VID/PID 對照型號表（商家唔使手填） */
export async function enumerateCompanionUsbPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; printers?: UsbPrinterRow[]; note?: string }>(
      url,
      "/api/usb",
    )) as { ok?: boolean; printers?: UsbPrinterRow[]; note?: string };
    return (j.printers ?? []).map((p) => {
      const vid = toHexId(p.vendorId);
      const pid = toHexId(p.productId);
      const name = p.model || p.brand || `USB 打印機 ${vid}`;
      return {
        source: "usb",
        name,
        connectionType: "usb",
        usbVendorId: vid,
        usbProductId: pid,
        model: p.model,
        charset: p.charset,
        paperSize: p.paperSize,
        kanjiEnlarge: p.kanjiEnlarge,
      } as PrinterCandidate;
    });
  } catch {
    return [];
  }
}

/** 合併 LAN + USB 清單（藍牙由商家手動 COM 名輸入） */
export async function listCompanionPrinters(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{
      ok?: boolean;
      lan?: DiscoveredLanPrinter[];
      usb?: UsbPrinterRow[];
    }>(url, "/api/printers")) as { ok?: boolean; lan?: DiscoveredLanPrinter[]; usb?: UsbPrinterRow[] };
    const lan: PrinterCandidate[] = (j.lan ?? []).map((p) => ({
      source: "lan",
      name: p.name || `LAN 打印機 ${p.ip ?? ""}`,
      connectionType: "lan",
      ipAddress: p.ip,
      lanPort: p.port || 9100,
    }));
    const usb: PrinterCandidate[] = (j.usb ?? []).map((p) => {
      const vid = toHexId(p.vendorId);
      const pid = toHexId(p.productId);
      return {
        source: "usb",
        name: p.model || p.brand || `USB 打印機 ${vid}`,
        connectionType: "usb",
        usbVendorId: vid,
        usbProductId: pid,
        model: p.model,
        charset: p.charset,
        paperSize: p.paperSize,
        kanjiEnlarge: p.kanjiEnlarge,
      } as PrinterCandidate;
    });
    return [...lan, ...usb];
  } catch {
    return [];
  }
}

interface BluetoothPortRow {
  path?: string;
  friendlyName?: string;
  pnpId?: string;
  manufacturer?: string;
}

/** 列舉藍牙（SPP）序列埠，俾「手動+ 藍牙打印機」從清單揀（Companion 經 serialport 列，網頁本身列唔到） */
export async function enumerateCompanionBluetoothDevices(): Promise<PrinterCandidate[]> {
  const url = getCompanionUrl();
  if (!url) return [];
  try {
    const j = (await companionJson<{ ok?: boolean; ports?: BluetoothPortRow[] }>(
      url,
      "/api/bluetooth",
    )) as { ok?: boolean; ports?: BluetoothPortRow[] };
    return (j.ports ?? []).map((p) => ({
      source: "bluetooth",
      name: p.friendlyName || p.path || "藍牙打印機",
      connectionType: "bluetooth",
      bluetoothName: p.path || "",
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 共用路由 helpers（取代 hub.ts 同名函式）
// ─────────────────────────────────────────────────────────────

/**
 * 新 PrintJob 嘅初始狀態。
 * 一律回 "pending"，交畀背景 flush worker（dispatch.ts）按 native / companion / relay 通道派發；
 * 無可用通道時 worker 會維持 pending 等下次 flush。
 *
 * ⚠️ 唔可以樂觀標 "sent"：flushPendingPrintJobs 只處理 status==="pending" 嘅 job，
 * 如果呢度回 "sent"，worker 會 skip 呢啲 job，令真實落單 / 收據 / 退款嘅打印永遠唔會派發
 * （打印靜默、Print Center 全部顯示「已發送」但張紙唔出）。見 hub.ts 同名函式註解。
 */
export function resolvePrintJobStatus(_networkOnline: boolean): PrintJob["status"] {
  return "pending";
}

/** 按 PrintJob.printerGroup 由 config.printers 搵出目標打印機（單一真源） */
export function resolveJobPrinter(job: PrintJob): DevicePrinterConfig | undefined {
  const printers = (loadDeviceConfig() ?? defaultDeviceConfig).printers;
  // 1) 直接用 job 記錄嘅 printerId
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
