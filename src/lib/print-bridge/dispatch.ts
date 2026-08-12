import {
  dispatchJobToPrintBridge,
  isPrintBridgeEnabled,
  syncPrintBridgeConfig,
} from "@/lib/print-bridge/client";
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
  if (!isPrintBridgeEnabled()) {
    return loadPrintJobs();
  }

  const deviceConfig = loadDeviceConfig();
  if (deviceConfig) {
    await syncPrintBridgeConfig(deviceConfig);
  }

  const printers = deviceConfig?.printers ?? [];
  const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  let changed = false;
  const nextJobs = [...jobs];

  for (const job of pending) {
    const index = nextJobs.findIndex((row) => row.id === job.id);
    if (index < 0) continue;

    const printer = findPrinterForJob(job, printers);
    const result = await dispatchJobToPrintBridge(job, printer);
    if (result.ok) {
      nextJobs[index] = { ...job, status: "sent" };
      changed = true;
    } else {
      nextJobs[index] = { ...job, status: "failed" };
      changed = true;
    }
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
