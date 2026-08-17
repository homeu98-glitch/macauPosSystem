// WebUSB 直接打印通道（browser 直印，唔使 print-bridge）
//
// 設計：browser 用 WebUSB（navigator.usb）自己 claim 部 USB 打印機、send ESC/POS bytes。
// 適用：部機係 ESC/POS 且 OS 冇將個 USB interface 綁死 driver（要 claimable）。
// 限制（已知）：
//  - 要 Chromium 系瀏覽器（Chrome / Edge）；Firefox / Safari 唔支援 WebUSB。
//  - 要 HTTPS 或 localhost（Vercel https 頁 OK）。
//  - 第一次要 user 撳掣授權（requestDevice）；之後 getDevices() 記住。
//  - 部機要 WebUSB-claimable；唔係就要用 Zadig / 設 vendor mode 換 driver。

import { loadDeviceConfig } from "@/lib/storage";
import type { DevicePrinterConfig, PrintJob } from "@/lib/types";
import { renderKitchenTicket, renderReceiptTicket, renderTestPage } from "@/lib/escpos";

// WebUSB 類型喺部份 TS lib 唔一定齊，用 minimal any 避開編譯問題。
type WebUsbDevice = any;

const PRINTER_CLASS_CODE = 0x07;

export function isWebUsbSupported(): boolean {
  return typeof window !== "undefined" && Boolean((navigator as any)?.usb);
}

/** 彈授權對話框，等 user 揀部打印機並授予。返回授予嘅 device 或 null。 */
export async function requestWebUsbDevice(): Promise<WebUsbDevice | null> {
  if (!isWebUsbSupported()) return null;
  try {
    const device = await (navigator as any).usb.requestDevice({
      filters: [{ classCode: PRINTER_CLASS_CODE }],
    });
    return device ?? null;
  } catch {
    // user cancel / 無符合設備
    return null;
  }
}

/** 列出已授予嘅 WebUSB 打印機（唔使再彈對話框）。 */
export async function listWebUsbDevices(): Promise<WebUsbDevice[]> {
  if (!isWebUsbSupported()) return [];
  try {
    const devices = await (navigator as any).usb.getDevices();
    return Array.isArray(devices) ? devices : [];
  } catch {
    return [];
  }
}

/** 按 serial 配對已授予設備；無 serial 或搵唔到就用第一部已授予設備。 */
export async function findWebUsbDevice(serial?: string): Promise<WebUsbDevice | null> {
  const devices = await listWebUsbDevices();
  if (devices.length === 0) return null;
  if (serial) {
    const hit = devices.find((d) => d.serialNumber === serial);
    if (hit) return hit;
  }
  return devices[0];
}

export function webUsbDeviceLabel(device: WebUsbDevice | null): string {
  if (!device) return "（未授權）";
  const name = device.productName || `VID:${device.vendorId?.toString(16)} PID:${device.productId?.toString(16)}`;
  return device.serialNumber ? `${name} · ${device.serialNumber}` : name;
}

function describeWebUsbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/access denied|failed to execute ['"]?open/i.test(raw)) {
    return "WebUSB 無法開啟部機（Access denied）：Windows 已將部 USB 打印機嘅 interface 綁住 driver（usbprint.sys），WebUSB 搶唔到。解決：① 用 Zadig 將部機 interface 換成 WinUSB（會令部機暫時唔係「正常 Windows 打印機」，可逆）；② 或改用 print-bridge + USB（連接方式選 USB、填 Windows 印表機名，由 OS driver 行 RAW 打印，最穩陣）。";
  }
  if (/claim/i.test(raw)) {
    return `WebUSB 無法 claim 部機 interface（可能唔 claimable）：${raw}`;
  }
  return raw;
}

function findOutEndpoint(device: WebUsbDevice): { interfaceNumber: number; endpointNumber: number } | null {
  const cfg = device?.configuration;
  if (!cfg?.interfaces) return null;
  const ifaces = cfg.interfaces as any[];
  // 優先揀 Printer Class (0x07) interface 嘅 bulk-out；冇就第一部 bulk-out
  const byClass = ifaces.find((i) => i.alternates?.[0]?.interfaceClass === PRINTER_CLASS_CODE);
  const candidates = byClass ? [byClass, ...ifaces] : ifaces;
  for (const iface of candidates) {
    const alt = iface.alternates?.[0];
    const ep = alt?.endpoints?.find((e: any) => e.direction === "out" && e.type === "bulk");
    if (ep) return { interfaceNumber: iface.interfaceNumber, endpointNumber: ep.endpointNumber };
  }
  return null;
}

/** 開設備 → claim → transferOut → 收。每印一次獨立開關，適合熱插拔。 */
export async function printToWebUsb(
  device: WebUsbDevice,
  bytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!device) return { ok: false, error: "無 WebUSB 設備。" };
  try {
    if (!device.opened) await device.open();
    // 揀第一部 config（唔硬寫 1；部份機 config value 唔係 1，硬寫會 select 失敗）
    if (!device.configuration) {
      const first = device.configurations?.[0];
      if (first) await device.selectConfiguration(first.configurationValue);
    }
    const target = findOutEndpoint(device);
    if (!target) {
      const ifaceCount = device.configuration?.interfaces?.length ?? 0;
      const cfgCount = device.configurations?.length ?? 0;
      return {
        ok: false,
        error: `找不到 USB 批量輸出端點（config=${cfgCount}, iface=${ifaceCount}；部機 descriptor 可能無 bulk-out，或 WinUSB 換錯咗 interface）。`,
      };
    }
    console.debug("[print-webusb] transferOut", target, "bytes", bytes.length);
    await device.claimInterface(target.interfaceNumber);
    await device.transferOut(target.endpointNumber, bytes);
    // 等部機 flush 再 release/close（部份熱敏機 print-on-close，太快收會漏印）
    await new Promise((resolve) => setTimeout(resolve, 200));
    await device.releaseInterface(target.interfaceNumber);
    if (device.opened) await device.close();
    return { ok: true };
  } catch (err) {
    try {
      if (device?.opened) await device.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: describeWebUsbError(err) };
  }
}

function storeName(): string | undefined {
  return loadDeviceConfig()?.terminalName;
}

/** 將一個 PrintJob 經 WebUSB 直印（按 role 揀收據 / 廚房模板）。 */
export async function printWebUsbJob(
  job: PrintJob,
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const device = await findWebUsbDevice(printer.webusbSerial);
  if (!device) {
    return { ok: false, error: "未授權 WebUSB 打印機，請到設置頁『偵測 WebUSB 打印機』授權。" };
  }
  const items = job.items ?? [];
  const bytes =
    printer.role === "receipt"
      ? renderReceiptTicket({ storeName: storeName(), paperSize: printer.paperSize, items })
      : renderKitchenTicket({
          storeName: storeName(),
          paperSize: printer.paperSize,
          ticketType: job.ticketType,
          items,
        });
  return printToWebUsb(device, bytes);
}

/** 測試打印：授權（如未授權）後印測試頁。 */
export async function requestTestPrintWebUsb(
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let device = await findWebUsbDevice(printer.webusbSerial);
  if (!device) device = await requestWebUsbDevice();
  if (!device) return { ok: false, error: "未揀選 / 授權 WebUSB 打印機。" };
  const bytes = renderTestPage({ storeName: storeName(), printerName: printer.name, connectionType: "webusb" });
  return printToWebUsb(device, bytes);
}
