import {
  dispatchJobToPrintBridge,
  isPrintBridgeEnabled,
  syncPrintBridgeConfig,
} from "@/lib/print-bridge/client";
import { isNativeBridgeAvailable, dispatchJobToNative } from "@/lib/print-bridge/native";
import { isWebUsbSupported, printWebUsbJob } from "@/lib/print-webusb";
import { printBrowserJob } from "@/lib/print-browser";
import { loadDeviceConfig, loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { DevicePrinterConfig, PrintJob } from "@/lib/types";

function findPrinterForJob(job: PrintJob, printers: DevicePrinterConfig[]): DevicePrinterConfig | null {
  if (job.printerId) {
    const byId = printers.find((row) => row.id === job.printerId);
    if (byId) return byId;
  }
  return printers.find((row) => row.name === job.printerName) ?? null;
}

export async function flushPendingPrintJobs(): Promise<PrintJob[]> {
  const deviceConfig = loadDeviceConfig();
  const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  const printers = deviceConfig?.printers ?? [];
  const bridgeOn = isPrintBridgeEnabled();
  const webusbOn = isWebUsbSupported();
  const nativeOn = isNativeBridgeAvailable();

  let changed = false;
  const nextJobs = [...jobs];

  for (const job of pending) {
    const index = nextJobs.findIndex((row) => row.id === job.id);
    if (index < 0) continue;

    const printer = findPrinterForJob(job, printers);
    if (!printer) {
      nextJobs[index] = { ...job, status: "failed" };
      changed = true;
      continue;
    }

    // WebUSB 直印（唔使 bridge；browser 自己 claim USB 設備）
    if (printer.connectionType === "webusb") {
      if (!webusbOn) {
        nextJobs[index] = { ...job, status: "failed" };
        changed = true;
        continue;
      }
      const result = await printWebUsbJob(job, printer);
      nextJobs[index] = { ...job, status: result.ok ? "sent" : "failed" };
      changed = true;
      continue;
    }

    // 瀏覽器原生打印（window.print / iframe）— 零額外安裝 fallback，唔使 bridge / webusb
    if (printer.connectionType === "browser") {
      const result = await printBrowserJob(job, printer);
      nextJobs[index] = { ...job, status: result.ok ? "sent" : "failed" };
      changed = true;
      continue;
    }

    // Native Android bridge（POS 跑喺 WebView 外殼入面）—— 最高優先，
    // 直接 LAN raw socket，唔使 HTTP fetch，無 mixed content，斷網照印。
    if (nativeOn) {
      const result = await dispatchJobToNative(job, printer);
      nextJobs[index] = { ...job, status: result.ok ? "sent" : "failed" };
      changed = true;
      continue;
    }

    // 其餘行 print-bridge（LAN / USB 系統打印機）
    if (!bridgeOn) continue; // 無 bridge 就維持 pending（同舊行為）
    const result = await dispatchJobToPrintBridge(job, printer);
    nextJobs[index] = { ...job, status: result.ok ? "sent" : "failed" };
    changed = true;
  }

  if (changed) {
    savePrintJobs(nextJobs);
    window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }));
  }

  return nextJobs;
}

export async function retryFailedPrintJob(jobId: string): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  const nextJobs = jobs.map((job) => (job.id === jobId ? { ...job, status: "pending" as const } : job));
  savePrintJobs(nextJobs);
  window.dispatchEvent(new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }));
  return flushPendingPrintJobs();
}
