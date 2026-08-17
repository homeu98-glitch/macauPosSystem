// 瀏覽器端 ESC/POS 編碼器（WebUSB / 直接打印用）
//
// 結構指令與 print-bridge/src/escpos.mjs 完全一致（init / 對齊 / 列項 / 切紙），
// 唯一分別：文字編碼用瀏覽器原生 TextEncoder（UTF-8），唔使 iconv-lite（避免引入新依賴）。
//
// ⚠️ 中文 caveat：經典 ESC/POS 唔係真正 UTF-8；部份中文打印機支援 UTF-8 傳輸模式，
// 否則中文會變亂碼（同 print-bridge 嘅「中文亂碼」已知限制一致）。如需完美中文，
// 可後續喺此檔改用 GBK 編碼（加 iconv-lite 或細粒 GBK 表）。v1 先求「browser 直印」通。

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function cmd(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function encodeText(text: string): Uint8Array {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return new TextEncoder().encode(normalized);
}

function line(text = ""): Uint8Array {
  return concat(cmd(LF), encodeText(text));
}

function separator(width = 32): Uint8Array {
  return line("-".repeat(width));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function ticketTypeLabel(ticketType: string): string {
  if (ticketType === "addon") return "【加單】";
  if (ticketType === "void") return "【退菜】";
  return "【廚房單】";
}

interface EscPosItem {
  name: string;
  quantity: number;
  specs?: string[];
  note?: string;
}

interface RenderBase {
  storeName?: string;
  paperSize?: string;
  ticketType?: string;
}

export function renderKitchenTicket({
  storeName,
  paperSize,
  ticketType,
  items,
}: RenderBase & { items: EscPosItem[] }): Uint8Array {
  const width = String(paperSize ?? "").includes("58") ? 32 : 42;
  const chunks: Uint8Array[] = [];
  chunks.push(cmd(ESC, 0x40)); // init
  chunks.push(cmd(ESC, 0x61, 0x01)); // center
  chunks.push(line(storeName || "Macau POS"));
  chunks.push(line(ticketTypeLabel(ticketType ?? "")));
  chunks.push(cmd(ESC, 0x61, 0x00)); // left
  chunks.push(separator(width));

  for (const item of items) {
    const qty = Number(item.quantity ?? 1);
    chunks.push(line(`${item.name}  x${qty}`));
    for (const spec of item.specs ?? []) chunks.push(line(`  · ${spec}`));
    if (item.note) chunks.push(line(`  備註: ${item.note}`));
  }

  chunks.push(separator(width));
  chunks.push(line(new Date().toLocaleString("zh-HK", { hour12: false })));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00)); // cut
  return concat(...chunks);
}

export function renderReceiptTicket({
  storeName,
  paperSize,
  items,
  totalText,
  paymentMethod,
}: RenderBase & { items: EscPosItem[]; totalText?: string; paymentMethod?: string }): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(cmd(ESC, 0x40)); // init
  chunks.push(cmd(ESC, 0x61, 0x01)); // center
  chunks.push(line(storeName || "Macau POS"));
  chunks.push(line("收據"));
  chunks.push(cmd(ESC, 0x61, 0x00)); // left
  chunks.push(separator());
  for (const item of items) {
    chunks.push(line(`${item.name} x${item.quantity}`));
  }
  chunks.push(separator());
  if (totalText) chunks.push(line(`總計: ${totalText}`));
  if (paymentMethod) chunks.push(line(`支付: ${paymentMethod}`));
  chunks.push(line(new Date().toLocaleString("zh-HK", { hour12: false })));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00)); // cut
  return concat(...chunks);
}

export function renderTestPage({
  storeName,
  printerName,
  connectionType,
}: {
  storeName?: string;
  printerName?: string;
  connectionType?: string;
}): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(cmd(ESC, 0x40));
  chunks.push(cmd(ESC, 0x61, 0x01));
  chunks.push(line(storeName || "Macau POS"));
  chunks.push(line("打印測試頁"));
  chunks.push(cmd(ESC, 0x61, 0x00));
  chunks.push(separator());
  chunks.push(line(`打印機: ${printerName ?? "-"}`));
  chunks.push(line(`連接: ${connectionType ?? "-"}`));
  chunks.push(separator());
  chunks.push(line("若看到此行，WebUSB 直印正常。"));
  chunks.push(cmd(LF, LF, LF));
  chunks.push(cmd(GS, 0x56, 0x00));
  return concat(...chunks);
}
