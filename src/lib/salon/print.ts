// Salon 收據列印（寫入 salon 隔離列印佇列 macau-pos-salon/print-jobs）
//
// 注意：刻意不呼叫餐飲的 loadPrintJobs/savePrintJobs（那些寫入 macau-pos/print-jobs）。
// 這裡複用共享 PrintJob 型別與 sendJobToHub（Printer Hub 基建共用）。

import type { PrintJob } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { loadDeviceConfig } from "@/lib/storage";
import {
  isHubConfigured,
  resolveJobPrinter,
  resolvePrintJobStatus,
  sendJobToHub,
} from "@/lib/print-bridge/hub";
import { dispatchJobToNative, isNativeBridgeAvailable } from "@/lib/print-bridge/native";
import { getRelayTransport } from "@/lib/print-bridge/relay-config";
import { getCompanionTransport } from "@/lib/print-bridge/companion-config";
import {
  loadSalonPrintJobs,
  saveSalonPrintJobs,
  loadSalonBootstrap,
} from "@/lib/salon/storage";
import type { SalonPosOrder } from "@/lib/salon/types";
import { playSuccessBeep, playErrorBeep } from "@/lib/salon/sound";

/**
 * 統一 dispatch 入口：native bridge（PosNative.printJob，完整 ESC/POS 格式）優先，
 * 唔得就桌面 Companion（localhost HTTP，見 docs/47），再 fallback Printer Hub HTTP（LAN 直打），
 * 最後經 Cloud Print Relay（互聯網備援，見 docs/46）。
 * 餐飲同 salon 共用同一條基建（見 dispatch.ts）。
 */
async function dispatchPrint(
  job: PrintJob,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const printer = resolveJobPrinter(job);
  if (!printer) {
    return { ok: false, error: `搵唔到對應打印機（printerGroup=${job.printerGroup}）` };
  }
  // 1) Native bridge（Android APK WebView）：native 側自己決定 LAN 直打 or relay
  if (isNativeBridgeAvailable()) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadSalonBootstrap()?.storeName;
    return dispatchJobToNative(job, { printer, kind, storeName });
  }
  // 2) 桌面 Companion（localhost HTTP）：瀏覽器開嘅 POS 喺桌面打到 LAN/USB/BT（見 docs/47）
  const companion = getCompanionTransport();
  if (companion) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadSalonBootstrap()?.storeName;
    const res = await companion.send(job, printer, { kind, storeName });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || "companion 打印失敗" };
  }
  // 3) Hub HTTP（LAN 直打，經店內打印機 IP）
  if (isHubConfigured() && printer.ipAddress) {
    return sendJobToHub(job);
  }
  // 4) 互聯網備援：經 Cloud Print Relay → 店內 Stationary Agent（見 docs/46 / relay-transport.ts）
  const relay = getRelayTransport();
  if (relay) {
    const kind = printer.role === "receipt" ? "receipt" : "kitchen";
    const storeName = loadSalonBootstrap()?.storeName;
    const res = await relay.send(job, printer, { kind, storeName });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.error || "relay 打印失敗" };
  }
  // 最舊 fallback（無 relay / 無 companion）：保持舊 Hub 行為
  return sendJobToHub(job);
}

export const SALON_PRINT_JOBS_CHANGED_EVENT = "salon-print-jobs-changed";

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

type ReceiptLine = NonNullable<PrintJob["items"]>[number];

/** 把 SalonPosOrder 轉成收據 PrintJob 的 items 段落 */
function buildReceiptLines(order: SalonPosOrder, currency: string): ReceiptLine[] {
  const lines: ReceiptLine[] = [];

  const bootstrap = loadSalonBootstrap();
  if (bootstrap?.storeName) {
    lines.push({ name: "門店", quantity: 1, specs: [], note: bootstrap.storeName });
  }
  lines.push({ name: "單號", quantity: 1, specs: [], note: order.orderNo });
  lines.push({ name: "客戶", quantity: 1, specs: [], note: order.customerName });

  for (const it of order.items) {
    const noteParts = [formatMoney(it.unitPrice * it.quantity, currency)];
    if (it.note) noteParts.push(it.note);
    lines.push({
      name: it.name,
      quantity: it.quantity,
      specs: it.staffName ? [`技師:${it.staffName}`] : [],
      note: noteParts.join(" · "),
    });
  }

  lines.push({ name: "小計", quantity: 1, specs: [], note: formatMoney(order.subtotal, currency) });

  if (order.discountAmount > 0) {
    lines.push({ name: "折扣", quantity: 1, specs: [], note: `-${formatMoney(order.discountAmount, currency)}` });
  }
  if (order.birthdayDiscount) {
    lines.push({ name: "生日折扣", quantity: 1, specs: [], note: "已享生日優惠" });
  }
  if (order.packageDeduction && order.packageDeduction > 0) {
    lines.push({ name: "套票抵扣", quantity: 1, specs: [], note: `-${formatMoney(order.packageDeduction, currency)}` });
  }
  if (order.pointsDeduction && order.pointsDeduction > 0) {
    lines.push({
      name: "積分兌換",
      quantity: 1,
      specs: [],
      note: `-${formatMoney(order.pointsDeduction, currency)}（${order.pointsRedeemed ?? 0}分）`,
    });
  }
  if (order.depositApplied && order.depositApplied > 0) {
    lines.push({ name: "已付定金", quantity: 1, specs: [], note: `-${formatMoney(order.depositApplied, currency)}` });
  }
  for (const t of order.tips) {
    lines.push({ name: `小費·${t.staffName}`, quantity: 1, specs: [], note: formatMoney(t.amount, currency) });
  }
  lines.push({ name: "應收總計", quantity: 1, specs: [], note: formatMoney(order.grandTotal, currency) });

  for (const p of order.payments) {
    const methodLabel =
      p.method === "cash"
        ? "現金"
        : p.method === "card"
          ? "卡"
          : p.method === "ledger_balance"
            ? "Ledger餘額"
            : "外部";
    lines.push({ name: `付款·${methodLabel}`, quantity: 1, specs: [], note: formatMoney(p.amount, currency) });
  }
  if (order.changeDue && order.changeDue > 0) {
    lines.push({ name: "找零", quantity: 1, specs: [], note: formatMoney(order.changeDue, currency) });
  }
  if (order.pointsEarned && order.pointsEarned > 0) {
    lines.push({ name: "本次賺分", quantity: 1, specs: [], note: `+${order.pointsEarned} 分` });
  }
  if (order.notes) {
    lines.push({ name: "備註", quantity: 1, specs: [], note: order.notes });
  }

  return lines;
}

/**
 * 把收據 PrintJob 寫入 salon 隔離列印佇列，並嘗試 dispatch 到 print-bridge。
 * 回傳建立的 PrintJob（可能為空陣列，若無啟用的收據機）。
 */
export async function dispatchSalonReceipt(order: SalonPosOrder): Promise<PrintJob[]> {
  if (typeof window === "undefined") return [];

  const deviceConfig = loadDeviceConfig();
  const printers = (deviceConfig?.printers ?? []).filter(
    (p) => p.enabled && p.role === "receipt",
  );
  if (printers.length === 0) return [];

  const bootstrap = loadSalonBootstrap();
  const currency = bootstrap?.currency ?? "MOP";
  const now = new Date().toISOString();
  const items = buildReceiptLines(order, currency);

  const jobs: PrintJob[] = printers.map((printer) => ({
    id: uid("print"),
    orderId: order.id,
    orderNo: order.orderNo,
    ticketType: "normal",
    printerGroup: "receipt",
    printerId: printer.id,
    printerName: printer.name,
    items,
    status: resolvePrintJobStatus(typeof navigator !== "undefined" ? navigator.onLine : true),
    createdAt: now,
  }));

  const dispatched = await Promise.all(
    jobs.map(async (job) => {
      const res = await dispatchPrint(job);
      return res.ok ? { ...job, status: "sent" as PrintJob["status"] } : job;
    }),
  );

  saveSalonPrintJobs([...dispatched, ...loadSalonPrintJobs()]);
  window.dispatchEvent(
    new CustomEvent(SALON_PRINT_JOBS_CHANGED_EVENT, { detail: { count: jobs.length } }),
  );

  const allSent = dispatched.length > 0 && dispatched.every((j) => j.status === "sent");
  if (allSent) playSuccessBeep();
  else playErrorBeep();

  return dispatched;
}

/**
 * 返結（反結賬）列印：把已結單退回可編輯狀態時，印一張「返結單」到啟用中的
 * 收據機，記錄原單號、原因、操作人。寫入 salon 隔離佇列並 dispatch。
 * ticketType 沿用 "void"（修正單），並於項目名稱前加【返結】標記。
 */
export async function dispatchSalonReopenTicket(
  order: SalonPosOrder,
  reason: string,
  operator: string,
): Promise<PrintJob[]> {
  if (typeof window === "undefined") return [];

  const deviceConfig = loadDeviceConfig();
  const printers = (deviceConfig?.printers ?? []).filter((p) => p.enabled && p.role === "receipt");
  if (printers.length === 0) return [];

  const bootstrap = loadSalonBootstrap();
  const currency = bootstrap?.currency ?? "MOP";
  const now = new Date().toISOString();

  const items: ReceiptLine[] = [
    { name: "門店", quantity: 1, specs: [], note: bootstrap?.storeName ?? "" },
    { name: "單號", quantity: 1, specs: [], note: order.orderNo },
    { name: "客戶", quantity: 1, specs: [], note: order.customerName ?? "" },
    { name: "【返結】", quantity: 1, specs: [], note: `原因：${reason || "結帳錯誤"}｜操作人：${operator}` },
  ];
  for (const it of order.items) {
    items.push({
      name: `【返結】${it.name}`,
      quantity: it.quantity,
      specs: it.staffName ? [`技師:${it.staffName}`] : [],
      note: formatMoney(it.unitPrice * it.quantity, currency),
    });
  }
  items.push({ name: "應收總計", quantity: 1, specs: [], note: formatMoney(order.grandTotal, currency) });

  const jobs: PrintJob[] = printers.map((printer) => ({
    id: uid("print"),
    orderId: order.id,
    orderNo: order.orderNo,
    ticketType: "void",
    printerGroup: "receipt",
    printerId: printer.id,
    printerName: printer.name,
    items,
    status: resolvePrintJobStatus(typeof navigator !== "undefined" ? navigator.onLine : true),
    createdAt: now,
  }));

  const dispatched = await Promise.all(
    jobs.map(async (job) => {
      const res = await dispatchPrint(job);
      return res.ok ? { ...job, status: "sent" as PrintJob["status"] } : job;
    }),
  );

  saveSalonPrintJobs([...dispatched, ...loadSalonPrintJobs()]);
  window.dispatchEvent(new CustomEvent(SALON_PRINT_JOBS_CHANGED_EVENT, { detail: { count: jobs.length } }));

  const allSent = dispatched.length > 0 && dispatched.every((j) => j.status === "sent");
  if (allSent) playSuccessBeep();
  else playErrorBeep();

  return dispatched;
}

/**
 * 重印既有收據任務：依 job.printerId 找到機器並重新 dispatch。
 * 成功/失敗會同步更新 salon 佇列中該 job 的 status 並派發變更事件。
 */
export async function reprintSalonJob(job: PrintJob): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === "undefined") return { ok: false, error: "無效環境" };
  const res = await dispatchPrint(job);
  const nextStatus: PrintJob["status"] = res.ok ? "sent" : "failed";
  const jobs = loadSalonPrintJobs().map((j) =>
    j.id === job.id ? { ...j, status: nextStatus } : j,
  );
  saveSalonPrintJobs(jobs);
  window.dispatchEvent(
    new CustomEvent(SALON_PRINT_JOBS_CHANGED_EVENT, { detail: { count: 1 } }),
  );
  if (res.ok) playSuccessBeep();
  else playErrorBeep();
  return res;
}
