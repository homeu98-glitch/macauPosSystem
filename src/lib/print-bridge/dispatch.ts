import { resolveJobPrinter } from "@/lib/print-bridge/hub";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { getRelayTransport, isRelayConfigured } from "@/lib/print-bridge/relay-config";
import { getCompanionTransport, isCompanionConfigured } from "@/lib/print-bridge/companion-config";
import { loadBootstrapCache, loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { PrintJob } from "@/lib/types";

/**
 * 刷新待打印佇列：所有 pending job 發送。
 *
 * 路由優先級：
 *   1) Native bridge（Sunmi APK WebView，PosNative.printJob）→ 完整 ESC/POS 格式（EscPosRenderer）
 *   2) 否則桌面 Companion（localhost HTTP，瀏覽器開嘅 POS 喺桌面打到 LAN/USB/BT，見 docs/47）
 *   3) 否則經 Cloud Print Relay（relay-transport.ts）→ 店內 Stationary Agent（互聯網備援，見 docs/46）
 *
 * 未配對 native / companion / relay 嘅 job 維持 pending，等店主喺設置頁配置 companion / relay。
 */
export async function flushPendingPrintJobs(): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  // 有無任何派發通道：native bridge（Android APK）/ Companion（桌面）/ relay（互聯網備援）。
  // 無通道先維持 pending 等下次 flush（店主配置 companion / relay 後自動重試）。
  const hasChannel =
    isNativeBridgeAvailable() || isCompanionConfigured() || isRelayConfigured();
  let changed = false;
  const nextJobs = [...jobs];

  for (const job of pending) {
    const index = nextJobs.findIndex((row) => row.id === job.id);
    if (index < 0) continue;

    const result = await dispatchOneJob(job);
    if (result.ok) {
      nextJobs[index] = { ...job, status: "sent" };
    } else if (!hasChannel) {
      // 完全無通道（未配 companion、又無 native bridge、又無 relay）：維持 pending，等店主配置後下次 flush 再試。
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
 * 單一 job 派發：native bridge 優先 → 桌面 Companion（localhost）→ relay（互聯網備援）。
 * 路由按 resolveJobPrinter 搵出目標打印機（單一真源）。
 */
async function dispatchOneJob(
  job: PrintJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const printer = resolveJobPrinter(job);
  if (!printer) {
    return { ok: false, error: `搵唔到對應打印機（printerGroup=${job.printerGroup}）` };
  }
  // 1) Native bridge（Android APK WebView）：native 側自己決定 LAN 直打 or relay
  if (isNativeBridgeAvailable()) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadBootstrapCache()?.storeName;
    return dispatchJobToNative(job, { printer, kind, storeName });
  }
  // 2) 桌面 Companion（localhost HTTP）：瀏覽器開嘅 POS 喺桌面（Windows/macOS/Linux）
  //    經 localhost agent 打到 LAN:9100 / USB / BT，由 OS 權限出單（見 docs/47 / companion-transport.ts）。
  //    唔需要 printer.ipAddress（USB/BT 機經標識符），所以唔做 IP 閘門。
  const companion = getCompanionTransport();
  if (companion) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadBootstrapCache()?.storeName;
    const res = await companion.send(job, printer, { kind, storeName });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || "companion 打印失敗" };
  }
  // 3) 互聯網備援：經 Cloud Print Relay → 店內 Stationary Agent（見 docs/46 / relay-transport.ts）
  const relay = getRelayTransport();
  if (relay) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadBootstrapCache()?.storeName;
    const res = await relay.send(job, printer, { kind, storeName });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || "relay 打印失敗" };
  }
  return { ok: false, error: "無可用打印通道（native / companion / relay 都無）" };
}
