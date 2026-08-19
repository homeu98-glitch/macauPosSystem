import { DeviceConfig, DevicePrinterConfig, PrintJob } from "@/lib/types";
import { loadDeviceConfig } from "@/lib/storage";

export function getPrintBridgeUrl(): string | null {
  const deviceOverride =
    typeof window !== "undefined" ? loadDeviceConfig()?.printBridgeUrl?.trim() : "";
  const raw = deviceOverride || process.env.NEXT_PUBLIC_PRINT_BRIDGE_URL?.trim();
  if (!raw) {
    // On-prem：若 app 本身由 LAN IP 載（例如 http://192.168.31.106:3000），
    // bridge 同喺部機 :9222 跑，自動推斷，店主零配置。
    if (typeof window !== "undefined") {
      const h = window.location.hostname;
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) && h !== "127.0.0.1" && h !== "localhost") {
        return `http://${h}:9222`;
      }
    }
    return null;
  }

  const url = raw.replace(/\/+$/, "");

  // Env default localhost only works when POS is opened on the same machine as print-bridge.
  if (typeof window !== "undefined" && !deviceOverride) {
    const pageHost = window.location.hostname;
    const pageIsLocal = pageHost === "localhost" || pageHost === "127.0.0.1";
    const bridgeIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url);
    if (!pageIsLocal && bridgeIsLocal) return null;
  }

  return url;
}

export function isPrintBridgeEnabled(): boolean {
  return Boolean(getPrintBridgeUrl());
}

export function resolvePrintJobStatus(networkOnline: boolean): PrintJob["status"] {
  if (isPrintBridgeEnabled()) return "pending";
  return networkOnline ? "sent" : "pending";
}

export type PrintBridgeHealth = {
  ok: boolean;
  service?: string;
  version?: string;
  hasConfig?: boolean;
  printerCount?: number;
  uptimeSec?: number;
  error?: string;
};

export async function fetchPrintBridgeHealth(): Promise<PrintBridgeHealth> {
  const baseUrl = getPrintBridgeUrl();
  if (!baseUrl) {
    return { ok: false, error: "未設定 NEXT_PUBLIC_PRINT_BRIDGE_URL" };
  }

  try {
    const response = await fetch(`${baseUrl}/health`, { method: "GET", cache: "no-store" });
    const payload = (await response.json()) as PrintBridgeHealth;
    if (!response.ok) {
      return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
    }
    return payload;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "橋接服務離線" };
  }
}

export async function syncPrintBridgeConfig(deviceConfig: DeviceConfig | null): Promise<boolean> {
  const baseUrl = getPrintBridgeUrl();
  if (!baseUrl || !deviceConfig) return false;

  try {
    const response = await fetch(`${baseUrl}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceConfig }),
    });
    const payload = (await response.json()) as { ok?: boolean };
    return response.ok && payload.ok !== false;
  } catch {
    return false;
  }
}

export async function dispatchJobToPrintBridge(
  job: PrintJob,
  printer: DevicePrinterConfig | null,
  meta?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = getPrintBridgeUrl();
  if (!baseUrl) {
    return { ok: false, error: "未設定打印橋接 URL" };
  }
  if (!printer) {
    return { ok: false, error: `找不到打印機「${job.printerName}」` };
  }

  try {
    const response = await fetch(`${baseUrl}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job, printer, meta }),
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || payload.ok === false) {
      return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "橋接打印失敗" };
  }
}

export async function requestTestPrintBridge(printer: DevicePrinterConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = getPrintBridgeUrl();
  if (!baseUrl) {
    return { ok: false, error: "未設定 NEXT_PUBLIC_PRINT_BRIDGE_URL" };
  }

  try {
    const response = await fetch(`${baseUrl}/test-print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printerId: printer.id, printerName: printer.name, printer }),
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || payload.ok === false) {
      return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "測試打印失敗" };
  }
}

export async function listSystemPrintersFromBridge(): Promise<Array<{ name: string; isDefault?: boolean }>> {
  const baseUrl = getPrintBridgeUrl();
  if (!baseUrl) return [];

  try {
    const response = await fetch(`${baseUrl}/printers/system`, { cache: "no-store" });
    const payload = (await response.json()) as { printers?: Array<{ name: string; isDefault?: boolean }> };
    return payload.printers ?? [];
  } catch {
    return [];
  }
}
