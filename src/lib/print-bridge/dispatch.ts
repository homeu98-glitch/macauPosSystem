import { isHubConfigured, resolveJobPrinter, sendJobToHub } from "@/lib/print-bridge/hub";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { loadBootstrapCache, loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { PrintJob } from "@/lib/types";

/**
 * 刷新待打印佇列：所有 pending job 發送。
 *
 * 路由優先級：
 *   1) Native bridge（Sunmi APK WebView，PosNative.printJob）→ 完整 ESC/POS 格式（EscPosRenderer）
 *   2) 否則 fallback 去 Printer Hub HTTP（sendJobToHub，純文字路徑）
 *
 * 未配對 Hub 且無 native 嘅 job 維持 pending，等店主喺設置頁配對 Hub。
 */
export async function flushPendingPrintJobs(): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  const hubOn = isHubConfigured();
  let changed = false;
  const nextJobs = [...jobs];

  for (const job of pending) {
    const index = nextJobs.findIndex((row) => row.id === job.id);
    if (index < 0) continue;

    if (!hubOn) {
      // 未配對 Hub：維持 pending，等店主喺設置頁配對 Sunmi Hub。
      nextJobs[index] = { ...job, status: "pending" };
      changed = true;
      continue;
    }

    const result = await dispatchOneJob(job);
    nextJobs[index] = { ...job, status: result.ok ? "sent" : "failed" };
    changed = true;
  }

  if (changed) {
    savePrintJobs(nextJobs);
    window.dispatchEvent(
      new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }),
    );
  }

  return nextJobs;
}

export async function retryFailedPrintJob(jobId: string): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  const nextJobs = jobs.map((job) =>
    job.id === jobId ? { ...job, status: "pending" as const } : job,
  );
  savePrintJobs(nextJobs);
  window.dispatchEvent(
    new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }),
  );
  return flushPendingPrintJobs();
}

/**
 * 單一 job 派發：native bridge 優先，fallback Hub HTTP 純文字。
 * 路由按 resolveJobPrinter 搵出目標打印機（單一真源）。
 */
async function dispatchOneJob(
  job: PrintJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const printer = resolveJobPrinter(job);
  if (!printer || !printer.ipAddress) {
    return { ok: false, error: `搵唔到對應打印機 IP（printerGroup=${job.printerGroup}）` };
  }
  if (isNativeBridgeAvailable()) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadBootstrapCache()?.storeName;
    return dispatchJobToNative(job, { printer, kind, storeName });
  }
  return sendJobToHub(job);
}
