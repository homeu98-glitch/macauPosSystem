import { isHubConfigured, sendJobToHub } from "@/lib/print-bridge/hub";
import { loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { PrintJob } from "@/lib/types";

/**
 * 刷新待打印佇列：所有 pending job 經 Printer Hub（Sunmi APK HTTP :8787）發送。
 * Hub 收到後按 service（front/bar/kitchen）分發到對應 LAN 打印機（raw socket :9100）。
 *
 * 唯一路徑：未配對 Hub 嘅 job 維持 pending，等店主喺設置頁配對 Hub。
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

    const result = await sendJobToHub(job);
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
