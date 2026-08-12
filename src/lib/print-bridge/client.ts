import { DeviceConfig, DevicePrinterConfig, PrintJob } from "@/lib/types";

export function getPrintBridgeUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_PRINT_BRIDGE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
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
