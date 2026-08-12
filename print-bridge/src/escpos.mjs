import iconv from "iconv-lite";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function cmd(...bytes) {
  return Buffer.from(bytes);
}

function encodeText(text, encoding = "gb18030") {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  try {
    return iconv.encode(normalized, encoding);
  } catch {
    return Buffer.from(normalized, "utf8");
  }
}

function line(text = "", encoding = "gb18030") {
  return Buffer.concat([encodeText(text, encoding), cmd(LF)]);
}

function separator(width = 32) {
  return line("-".repeat(width));
}

function ticketTypeLabel(ticketType) {
  if (ticketType === "addon") return "【加單】";
  if (ticketType === "void") return "【退菜】";
  return "【廚房單】";
}

/**
 * @param {{ job: import('./types.mjs').BridgePrintJob, printer?: import('./types.mjs').BridgePrinter, storeName?: string }} input
 */
export function renderKitchenTicket({ job, printer, storeName }) {
  const width = String(printer?.paperSize ?? "").includes("58") ? 32 : 42;
  const encoding = "gb18030";
  const chunks = [];

  chunks.push(cmd(ESC, 0x40)); // init
  chunks.push(cmd(ESC, 0x61, 0x01)); // center
  chunks.push(line(storeName || "Macau POS", encoding));
  chunks.push(line(ticketTypeLabel(job.ticketType), encoding));
  chunks.push(cmd(ESC, 0x61, 0x00)); // left
  chunks.push(separator(width));

  if (job.orderNo) chunks.push(line(`單號: ${job.orderNo}`, encoding));
  if (job.tableName) chunks.push(line(`桌台: ${job.tableName}`, encoding));
  if (job.printerName) chunks.push(line(`打印機: ${job.printerName}`, encoding));
  chunks.push(separator(width));

  for (const item of job.items ?? []) {
    const qty = Number(item.quantity ?? 1);
    chunks.push(line(`${item.name}  x${qty}`, encoding));
    for (const spec of item.specs ?? []) {
      chunks.push(line(`  · ${spec}`, encoding));
    }
    if (item.note) chunks.push(line(`  備註: ${item.note}`, encoding));
  }

  chunks.push(separator(width));
  chunks.push(line(new Date(job.createdAt ?? Date.now()).toLocaleString("zh-HK", { hour12: false }), encoding));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00)); // cut

  return Buffer.concat(chunks);
}

export function renderTestPage({ printer, storeName }) {
  const encoding = "gb18030";
  const chunks = [];
  chunks.push(cmd(ESC, 0x40));
  chunks.push(cmd(ESC, 0x61, 0x01));
  chunks.push(line(storeName || "Macau POS", encoding));
  chunks.push(line("打印測試頁", encoding));
  chunks.push(cmd(ESC, 0x61, 0x00));
  chunks.push(separator());
  chunks.push(line(`打印機: ${printer?.name ?? "-"}`, encoding));
  chunks.push(line(`連接: ${printer?.connectionType ?? "-"}`, encoding));
  if (printer?.connectionType === "lan") {
    chunks.push(line(`IP: ${printer?.ipAddress ?? "-"}:${printer?.lanPort ?? 9100}`, encoding));
  } else {
    chunks.push(line(`USB: ${printer?.usbLabel ?? "-"}`, encoding));
  }
  chunks.push(separator());
  chunks.push(line("若看到此行，LAN/USB 橋接正常。", encoding));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00));
  return Buffer.concat(chunks);
}

export function renderReceiptTicket({ job, printer, storeName, paymentMethod, total }) {
  const encoding = "gb18030";
  const chunks = [];
  chunks.push(cmd(ESC, 0x40));
  chunks.push(cmd(ESC, 0x61, 0x01));
  chunks.push(line(storeName || "Macau POS", encoding));
  chunks.push(line("收據", encoding));
  chunks.push(cmd(ESC, 0x61, 0x00));
  chunks.push(separator());
  if (job.orderNo) chunks.push(line(`單號: ${job.orderNo}`, encoding));
  if (job.tableName) chunks.push(line(`桌台: ${job.tableName}`, encoding));
  chunks.push(separator());
  for (const item of job.items ?? []) {
    chunks.push(line(`${item.name} x${item.quantity}`, encoding));
  }
  chunks.push(separator());
  if (total != null) chunks.push(line(`總計: MOP ${Number(total).toFixed(0)}`, encoding));
  if (paymentMethod) chunks.push(line(`支付: ${paymentMethod}`, encoding));
  chunks.push(line(new Date().toLocaleString("zh-HK", { hour12: false }), encoding));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00));
  return Buffer.concat(chunks);
}
