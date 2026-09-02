import { resolveJobPrinter } from "@/lib/print-bridge/hub";
import {
  dispatchJobToNative,
  isNativeBridgeAvailable,
  type NativePrintKind,
} from "@/lib/print-bridge/native";
import { getRelayTransport, isRelayConfigured } from "@/lib/print-bridge/relay-config";
import { getCompanionTransport, isCompanionConfigured } from "@/lib/print-bridge/companion-config";
import { loadBootstrapCache, loadPrintJobs, savePrintJobs } from "@/lib/storage";
import { pruneSentPrintJobs } from "@/lib/print-jobs";
import { PrintJob, PrintKind } from "@/lib/types";

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
let isFlushing = false;

export async function flushPendingPrintJobs(): Promise<PrintJob[]> {
  // 防止 PrintFlushWorker 每 2.5s tick 重疊：若上一次 flush 仲喺度（companion 慢 / 多 job），
  // 今次直接 skip，避免同一張 pending job 被 dispatch 兩次 → 重複打印。
  if (isFlushing) return loadPrintJobs();
  isFlushing = true;
  try {
    const jobs = loadPrintJobs();
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return jobs;

  // P1（docs/60）：模板快照保證「設計 == 預覽 == 出紙」。若仲有舊 job 冇 template 快照，
  // 對應通道會 fallback 去硬編渲染（唔會出錯），但呢度 warn 出嚟方便排查。
  if (process.env.NODE_ENV !== "production") {
    for (const job of pending) {
      if (!job.template || !Array.isArray(job.template.blocks) || job.template.blocks.length === 0) {
        console.warn(
          `[print] job ${job.id} (printerGroup=${job.printerGroup}, ticketType=${job.ticketType}) 冇 template 快照，將用通道 fallback 渲染`,
        );
      }
    }
  }

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
      // 成功：清走上次嘅失敗原因，唔好留低誤導。
      const { lastError: _dropped, ...cleanJob } = job;
      nextJobs[index] = { ...cleanJob, status: "sent" };
    } else if (!hasChannel) {
      // 完全無通道（未配 companion、又無 native bridge、又無 relay）：維持 pending，等店主配置後下次 flush 再試。
      nextJobs[index] = { ...job, status: "pending" };
    } else {
      // 一定要寫低原因：否則打印中心淨係顯示「失敗」，用戶完全無從追查
      // （dispatchOneJob 整咗句好詳細嘅 error 出嚟，唔好喺呢度掉咗佢）。
      nextJobs[index] = { ...job, status: "failed", lastError: result.error };
    }
    changed = true;
  }

  if (changed) {
    savePrintJobs(nextJobs);
    window.dispatchEvent(
      new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }),
    );
  }

  if (jobs.length > 0) pruneSentPrintJobs();
  return nextJobs;
  } finally {
    isFlushing = false;
  }
}

export async function retryFailedPrintJob(jobId: string): Promise<PrintJob[]> {
  const jobs = loadPrintJobs();
  // 重試時清走舊嘅失敗原因：否則重試又失敗但新原因寫唔到（例如冇通道維持 pending），
  // 會殘留上一次嘅原因誤導人。
  const nextJobs = jobs.map((job) => {
    if (job.id !== jobId) return job;
    const { lastError: _dropped, ...cleanJob } = job;
    return { ...cleanJob, status: "pending" as const };
  });
  savePrintJobs(nextJobs);
  window.dispatchEvent(
    new CustomEvent("pos-print-jobs-changed", { detail: { printJobs: nextJobs } }),
  );
  return flushPendingPrintJobs();
}

/**
 * 單一 job 派發：native bridge 優先 → 桌面 Companion（localhost）→ relay（互聯網備援）。
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
  // docs/60：票種以「模板快照」為權威。之前一律 `receipt ? receipt : kitchen`，
  // 搞到 label（杯標籤）機被當 kitchen → 標籤頂頭硬印「＊＊＊ 廚房 ＊＊＊」，版面錯晒。
  const kind: PrintKind =
    job.template?.kind ?? (printer.role === "receipt" ? "receipt" : printer.role === "label" ? "label" : "kitchen");
  // 舊版 APK 只認 receipt / kitchen / test，所以 native 通道繼續發 legacy 值（避免舊 APK 收唔識嘅 kind）。
  // 新版 APK 請改讀 `job.template.kind`（已隨 payload 轉發，見 docs/55 §2.1），嗰個先係權威。
  const nativeKind: NativePrintKind = printer.role === "receipt" ? "receipt" : "kitchen";
  const storeName = loadBootstrapCache()?.storeName;
  // 每次打單打印份數：未設定 / ≤1 / 非正整數 → 1 份（見 docs/54）
  const copies = Math.max(1, Math.floor(printer.copies ?? 1));

  // 1) Native bridge（Android APK WebView）：native 側自己決定 LAN 直打 or relay
  if (isNativeBridgeAvailable()) {
    for (let i = 0; i < copies; i++) {
      const res = await dispatchJobToNative(job, { printer, kind: nativeKind, storeName });
      if (!res.ok) return res;
    }
    return { ok: true };
  }
  // 2) 桌面 Companion（localhost HTTP）：瀏覽器開嘅 POS 喺桌面（Windows/macOS/Linux）
  //    經 localhost agent 打到 LAN:9100 / USB / BT，由 OS 權限出單（見 docs/47 / companion-transport.ts）。
  //    唔需要 printer.ipAddress（USB/BT 機經標識符），所以唔做 IP 閘門。
  const companion = getCompanionTransport();
  if (companion) {
    for (let i = 0; i < copies; i++) {
      const res = await companion.send(job, printer, { kind, storeName });
      if (!res.ok) return { ok: false, error: res.error || "companion 打印失敗" };
    }
    return { ok: true };
  }
  // 3) 互聯網備援：經 Cloud Print Relay → 店內 Stationary Agent（見 docs/46 / relay-transport.ts）
  const relay = getRelayTransport();
  if (relay) {
    for (let i = 0; i < copies; i++) {
      const res = await relay.send(job, printer, { kind, storeName });
      if (!res.ok) return { ok: false, error: res.error || "relay 打印失敗" };
    }
    return { ok: true };
  }
  return { ok: false, error: "無可用打印通道（native / companion / relay 都無）" };
}
