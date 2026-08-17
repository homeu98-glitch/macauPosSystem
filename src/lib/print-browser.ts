// 瀏覽器原生打印模式（window.print / 隱藏 iframe）
//
// 用途：web app 零額外安裝嘅 fallback。需 OS 已裝打印機 driver（Windows 裝 WL-R80A-win 等），
//       然後經瀏覽器「列印」對話框出紙。唔使 print-bridge、唔使 WebUSB、唔使 claim 設備。
//
// 限制（已知，fallback 定位）：
//  - 無 ESC/POS 切紙 / 錢箱 / 廚房指令；收據以 HTML 經瀏覽器打印，切紙靠部機「列印後自動切」設定或手撕。
//  - 中文視瀏覽器 + 部機 driver 碼頁；通常正常（同 window.print 普通文件一樣）。
//  - 自動打印由後台 worker flush 觸發 window.print()，部分瀏覽器對非用戶手勢嘅 print 對話框可能彈提示，
//    屬正常現象。

import { loadDeviceConfig } from "@/lib/storage";
import type { DevicePrinterConfig, PrintJob } from "@/lib/types";

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 58mm ≈ 220px、80mm ≈ 300px（96dpi 近似），用嚟定 HTML 收據寬度。 */
function paperWidthPx(paperSize?: string): number {
  if (String(paperSize ?? "").includes("58")) return 220;
  return 300;
}

function ticketTypeLabel(ticketType?: string): string {
  if (ticketType === "addon") return "【加單】";
  if (ticketType === "void") return "【退菜】";
  return "【廚房單】";
}

function storeName(): string {
  try {
    return loadDeviceConfig()?.terminalName ?? "Macau POS";
  } catch {
    return "Macau POS";
  }
}

/** 生成一張熱敏收據 HTML（內聯 CSS，@page 跟紙寬）。 */
export function renderTicketHtml({
  storeName: store,
  paperSize,
  title,
  lines,
  footer,
}: {
  storeName?: string;
  paperSize?: string;
  title: string;
  lines: string[];
  footer?: string;
}): string {
  const width = paperWidthPx(paperSize);
  const body = lines
    .map((line) => `<div class="row">${escapeHtml(line)}</div>`)
    .join("");
  const foot = footer ?? new Date().toLocaleString("zh-HK", { hour12: false });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${width}px auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: "Courier New", Consolas, monospace; font-size: 12px; line-height: 1.35; color: #000; }
    .receipt { width: ${width}px; padding: 8px 6px; margin: 0 auto; }
    .center { text-align: center; }
    .bold { font-weight: 700; }
    .sep { border-top: 1px dashed #000; margin: 6px 0; }
    .row { white-space: pre-wrap; word-break: break-word; }
  </style></head><body>
    <div class="receipt">
      <div class="center bold">${escapeHtml(store || "Macau POS")}</div>
      <div class="center bold">${escapeHtml(title)}</div>
      <div class="sep"></div>
      ${body}
      <div class="sep"></div>
      <div>${escapeHtml(foot)}</div>
    </div>
  </body></html>`;
}

function renderReceiptLines(job: PrintJob): string[] {
  const lines: string[] = [];
  if (job.orderNo) lines.push(`單號: ${job.orderNo}`);
  if (job.tableName) lines.push(`枱號: ${job.tableName}`);
  lines.push("");
  for (const item of job.items ?? []) {
    lines.push(`${item.name} x${item.quantity ?? 1}`);
    for (const spec of item.specs ?? []) lines.push(`  · ${spec}`);
    if (item.note) lines.push(`  備註: ${item.note}`);
  }
  return lines;
}

function renderKitchenLines(job: PrintJob): string[] {
  const lines: string[] = [];
  if (job.orderNo) lines.push(`單號: ${job.orderNo}`);
  if (job.tableName) lines.push(`枱號: ${job.tableName}`);
  lines.push("");
  for (const item of job.items ?? []) {
    lines.push(`${item.name} x${item.quantity ?? 1}`);
    for (const spec of item.specs ?? []) lines.push(`  · ${spec}`);
    if (item.note) lines.push(`  備註: ${item.note}`);
  }
  return lines;
}

/** 經隱藏 iframe 叫瀏覽器打印對話框；用完移除 iframe。 */
function printHtmlViaIframe(html: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.setAttribute("aria-hidden", "true");
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;
      if (!doc) {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve({ ok: false, error: "無法建立打印框架。" });
        return;
      }
      doc.open();
      doc.write(html);
      doc.close();
      const target = iframe.contentWindow;
      if (!target) {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve({ ok: false, error: "無法建立打印框架。" });
        return;
      }
      const cleanup = () => {
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1500);
      };
      const onLoad = () => {
        try {
          target.focus();
          target.print();
        } catch {
          /* ignore */
        }
        cleanup();
        resolve({ ok: true });
      };
      if (target.document.readyState === "complete") onLoad();
      else target.addEventListener("load", onLoad, { once: true });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** 將一個 PrintJob 經瀏覽器打印（按 role 揀收據 / 廚房 HTML）。 */
export async function printBrowserJob(
  job: PrintJob,
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lines = printer.role === "receipt" ? renderReceiptLines(job) : renderKitchenLines(job);
  const title = printer.role === "receipt" ? "收據" : ticketTypeLabel(job.ticketType);
  const html = renderTicketHtml({ storeName: storeName(), paperSize: printer.paperSize, title, lines });
  return printHtmlViaIframe(html);
}

/** 測試打印：經瀏覽器打印一張測試頁。 */
export async function printBrowserTestPage(
  printer: DevicePrinterConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const html = renderTicketHtml({
    storeName: storeName(),
    paperSize: printer.paperSize,
    title: "打印測試頁",
    lines: [
      `打印機: ${printer.name ?? "-"}`,
      `連接: browser（window.print）`,
      "若看到此頁，瀏覽器打印正常。",
    ],
  });
  return printHtmlViaIframe(html);
}
