/**
 * 零售價籤內容建構 —— **純函式，零 runtime 依賴**。
 *
 * 同 `receipt-retail-blocks.ts` 一樣抽出嚟嘅理由：`print-jobs.ts` / `escpos-template.ts`
 * 都有 runtime import → `node --test` 載入唔到，寫喺嗰度就零測試覆蓋。
 *
 * 🔑 所有輸出都係**純文字**（`content[sectionId]`）→ 下游三端只做
 * `content[block.id] ?: continue` 查表，**加呢個模板零跨 repo 改動**（docs/124 §11.1）。
 *
 * 🔴 **空字串 = 該區塊唔印**（同收據新區塊同一契約）。冇條碼 / 冇 PLU / 冇原價
 * 都唔可以回「標籤 + 空白」，否則價籤會出現一行莫名其妙嘅空行。
 */

import type { RetailProduct } from "@/lib/retail/types";
import type { RetailLabelSectionId } from "@/lib/types";

/** 金額格式化由呼叫端注入（保持零依賴；出紙端傳 `formatMoney` 入嚟） */
export type AmountFormatter = (amount: number) => string;

export interface RetailLabelContentOpts {
  storeName: string;
  /** 金額格式化（例如 `formatMoney(v, "MOP")`） */
  formatAmount: AmountFormatter;
  /** 頁尾文案（模板層級）。空白 = `footer` 區塊唔印。 */
  footerText?: string;
  /** 印製日期文字（例如 `2026-09-13`）。缺省 = `date` 區塊唔印。 */
  printedDate?: string;
  /** 每行可印字符數（用嚟預先摺行，避免打印機喺字中間斷開）。缺省 34（60×40 標籤）。 */
  columns?: number;
  /** 商品名最多印幾行（超出用 `…`）。缺省 2。 */
  maxNameLines?: number;
}

/** 全角（中日韓 + 全角標點）= 2 個字符位；其餘 = 1 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x1100 && code <= 0x115f) return 2; // 諺文
  if (code >= 0x2e80 && code <= 0xa4cf) return 2; // CJK 部首 / 假名 / 漢字
  if (code >= 0xac00 && code <= 0xd7a3) return 2; // 諺文音節
  if (code >= 0xf900 && code <= 0xfaff) return 2; // CJK 相容
  if (code >= 0xfe30 && code <= 0xfe6f) return 2; // CJK 標點
  if (code >= 0xff00 && code <= 0xff60) return 2; // 全角
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

/** 字串嘅顯示闊度（全角算 2） */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of String(text ?? "")) w += charWidth(ch);
  return w;
}

/**
 * 按顯示闊度摺行（全角算 2 位）。
 *
 * ⚠️ **唔可以純按 `length` 摺** —— 「維他檸檬茶 250ml」係 12 個 code point，
 * 但顯示闊度係 18（6 個中文字 ×2 + 6 個半角）。按 length 摺會令中文名一行塞爆 → 打印機再自動摺一次。
 */
export function wrapToWidth(text: string, columns: number, maxLines = 2): string {
  const src = String(text ?? "").trim();
  if (!src) return "";
  const cols = Math.max(4, Math.floor(columns));
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;

  for (const ch of src) {
    const w = charWidth(ch);
    if (lineWidth + w > cols) {
      lines.push(line);
      line = "";
      lineWidth = 0;
      if (lines.length >= maxLines) break;
    }
    line += ch;
    lineWidth += w;
  }
  if (lines.length < maxLines && line) lines.push(line);

  // 超出 maxLines → 最後一行尾加 `…`
  const consumed = lines.join("").length;
  if (consumed < src.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last && displayWidth(`${last}…`) > cols) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.join("\n");
}

/** 單位標示：稱重商品要講清楚係「每 kg」，唔可以只出「kg」 */
export function unitLabel(product: Pick<RetailProduct, "unit" | "isWeighed">): string {
  const u = String(product.unit ?? "").trim();
  if (!u) return product.isWeighed ? "每 kg" : "每件";
  return `每 ${u}`;
}

/**
 * 砌一張價籤嘅區塊內容。
 *
 * ⚠️ `original_price` 只有真係有 `originalPrice` **而且大過售價**時才出 ——
 * 否則會出現「售價 $10 / 原價 $10」呢種毫無意義（甚至誤導）嘅對比。
 */
export function buildRetailLabelContent(
  product: RetailProduct,
  opts: RetailLabelContentOpts,
): Record<RetailLabelSectionId, string> {
  const columns = opts.columns ?? 34;
  const maxNameLines = opts.maxNameLines ?? 2;

  const price = Number(product.price ?? 0);
  const original = product.originalPrice;

  const blocks: Record<RetailLabelSectionId, string> = {
    store_name: String(opts.storeName ?? "").trim(),
    product_name: wrapToWidth(product.name, columns, maxNameLines),
    price: Number.isFinite(price) && price > 0 ? opts.formatAmount(price) : "",
    original_price:
      typeof original === "number" && Number.isFinite(original) && original > price
        ? `原價 ${opts.formatAmount(original)}`
        : "",
    unit: unitLabel(product),
    barcode: String(product.barcode ?? "").trim(),
    plu: product.plu ? `PLU ${String(product.plu).trim()}` : "",
    date: String(opts.printedDate ?? "").trim(),
    footer: String(opts.footerText ?? "").trim(),
  };

  return blocks;
}

/** 顯示用摘要（UI toast / 記錄用，唔參與出紙） */
export function describeLabel(product: RetailProduct, formatAmount: AmountFormatter): string {
  const name = String(product.name ?? "").trim() || "(未命名)";
  return `${name} · ${formatAmount(Number(product.price ?? 0))}`;
}
