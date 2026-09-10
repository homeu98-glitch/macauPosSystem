/**
 * 掃碼點餐 QR 嘅**列印**（docs/115 §6）。
 *
 * 場景：老闆要將 QR 印出嚟貼枱（堂食）或者貼櫃檯／快餐區（快餐）。
 * 所以呢度做兩件事：
 *   1. `buildQrSvgMarkup()` —— 由 `encodeQrMatrix()` 直接砌 SVG 字串（唔靠 canvas /
 *      外部圖庫），可以放入任何 HTML（包括列印視窗）。
 *   2. `openQrPrintWindow()` —— 開一個乾淨嘅列印視窗（大字 QR + 店名 + 提示），
 *      載入完成自動叫 `print()`，印完自動關窗。
 *
 * ⚠️ 為何唔用 `window.print()` 直接印當前頁：設定頁係密密麻麻嘅表單，
 *   直接印會連整個表單一齊印出嚟，而且 QR 會被壓到細細粒。
 *   開獨立視窗可以控制版面（A4 正中、大尺寸、黑白），掃碼成功率高好多。
 *
 * ⚠️ `window.open` 可能被瀏覽器／WebView 攔截 → 回傳 `false`，由呼叫方提示用家
 *   「請允許彈出視窗，或者直接複製網址／截圖」。
 */

import { encodeQrMatrix } from "@/lib/qrcode";

/** 最少限度嘅 HTML escape（QR URL / 店名都會放入 HTML）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 砌 QR 嘅 SVG 字串（黑格 + 白底 + 靜區）。
 * 內容過長 / 無法編碼 → 回 `null`（呼叫方應顯示「太長，無法生成 QR」）。
 */
export function buildQrSvgMarkup(text: string, size = 320): string | null {
  if (!text) return null;
  const matrix = encodeQrMatrix(text);
  if (!matrix) return null;
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const cell = size / total;
  let body = "";
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.modules[r][c]) {
        body += `<rect x="${(c + quiet) * cell}" y="${(r + quiet) * cell}" width="${cell}" height="${cell}"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g fill="#000000">${body}</g>` +
    `</svg>`
  );
}

export type QrPrintCardOptions = {
  /** 卡上面嘅大字（枱號 / 「掃碼點餐」）。 */
  title: string;
  /** 細字標題（店名）。 */
  subtitle?: string;
  /** 卡下面嘅提示（預設「掃碼點餐」）。 */
  footer?: string;
  /** QR 內容（完整網址）。 */
  url: string;
  /** QR 邊長（px）。貼枱 / 貼櫃檯建議 320–420。 */
  size?: number;
};

/**
 * 開列印視窗並即時列印。
 * @returns `true` = 已開窗（唔代表用家按咗列印）；`false` = 被攔截 / 無法編碼。
 */
export function openQrPrintWindow(options: QrPrintCardOptions): boolean {
  if (typeof window === "undefined") return false;
  const size = options.size ?? 360;
  const svg = buildQrSvgMarkup(options.url, size);
  if (!svg) return false;

  const title = escapeHtml(options.title);
  const subtitle = options.subtitle ? escapeHtml(options.subtitle) : "";
  const footer = escapeHtml(options.footer ?? "掃碼點餐");

  const html = `<!doctype html>
<html lang="zh-HK">
<head>
<meta charset="utf-8">
<title>${subtitle ? `${subtitle} · ` : ""}${title}</title>
<style>
  @page { margin: 12mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang HK", "Microsoft JhengHei", sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; text-align: center; color: #111;
  }
  .shop { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .label { font-size: 34px; font-weight: 800; letter-spacing: 1px; margin-bottom: 18px; }
  .qr { line-height: 0; }
  .hint { font-size: 15px; color: #444; margin-top: 14px; }
  .url { font-size: 9px; color: #999; margin-top: 10px; word-break: break-all; max-width: 420px; }
</style>
</head>
<body>
  ${subtitle ? `<div class="shop">${subtitle}</div>` : ""}
  <div class="label">${title}</div>
  <div class="qr">${svg}</div>
  <div class="hint">${footer}</div>
  <div class="url">${escapeHtml(options.url)}</div>
  <script>
    // 等版面完成先 print（否則可能印白紙）；印完自動關窗，唔會留一堆 tab。
    window.addEventListener('load', function () {
      setTimeout(function () { window.print(); }, 200);
    });
    window.addEventListener('afterprint', function () { setTimeout(function () { window.close(); }, 300); });
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, "_blank", "width=680,height=860");
  if (!win) {
    URL.revokeObjectURL(objectUrl);
    return false;
  }
  // 唔可以即刻 revoke：列印期間視窗仍然讀住個 blob。留 60 秒後清走。
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return true;
}
