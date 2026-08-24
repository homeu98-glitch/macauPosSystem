import {
  isCompanionConfigured,
  resolveJobPrinter,
  sendJobToCompanion,
} from "@/lib/print-bridge/companion";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { loadBootstrapCache, loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { PrintJob } from "@/lib/types";

/**
 * 刷新待打印佇列：所有 pending job 發送。
 *
 * 路由優先級：
 *   1) Native bridge（Sunmi Android WebView，PosNative.printJob）→ 完整 ESC/POS 格式
 *   2) 否則 fallback 去桌面 Companion 代理（sendJobToCompanion，經 loopback → :9100/USB/BT）
 *
 * 未配對 Companion 且無 native 嘅 job 維持 pending，等店主喺設置頁配對 Companion / 重連後再試。
 * （Sunmi Printer Hub 基建已移除，由桌面 Companion 取代。）
 */
export async function flushPendingPrintJobs(): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  // 有無任何派發通道：native bridge（Android）或已配對 Companion。
  const hasChannel = isNativeBridgeAvailable() || isCompanionConfigured();
  let changed = false;
  const nextJobs = [...jobs];

  for (const job of pending) {
    const index = nextJobs.findIndex((row) => row.id === job.id);
    if (index < 0) continue;

    const result = await dispatchOneJob(job);
    if (result.ok) {
      nextJobs[index] = { ...job, status: "sent" };
    } else if (!hasChannel) {
      // 完全無通道（未配 Companion、又無 native bridge）：維持 pending，等配對後下次 flush 再試。
      nextJobs[index] = { ...job, status: "pending" };
    } else {
      nextJobs[index] = { ...job, status: "failed" };
    }
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
 * 單一 job 派發：native bridge 優先，fallback 桌面 Companion 代理。
 * 路由按 resolveJobPrinter 搵出目標打印機（單一真源）。
 * 注意：USB / 藍牙打印機無 ipAddress，故唔再以 ipAddress 缺失而報錯（交由 Companion 處理）。
 */
async function dispatchOneJob(
  job: PrintJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const printer = resolveJobPrinter(job);
  if (!printer) {
    return { ok: false, error: `搵唔到對應打印機（printerGroup=${job.printerGroup}）` };
  }
  if (isNativeBridgeAvailable()) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadBootstrapCache()?.storeName;
    return dispatchJobToNative(job, { printer, kind, storeName });
  }
  if (isCompanionConfigured()) {
    return sendJobToCompanion(job, printer);
  }
  return { ok: false, error: "未配對打印通道（Companion 代理未啟動）" };
}
