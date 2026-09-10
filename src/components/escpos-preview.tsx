"use client";

import { EscPosLine, RECEIPT_PAPER_COLUMNS, SIZE_PX } from "@/lib/escpos-render";
import { QR_QUIET_MODULES, QR_SIZE_FRACTION } from "@/lib/escpos-qr";
import type { EscPosSize, QrPayload } from "@/lib/types";

// 相對行高（CSS）。因 SIZE_PX.l = 2× SIZE_PX.s（22 vs 11），l 行箱自然 = 2× s 行箱，
// 同 Companion / Android ESC 3 n 表（s/m=30, l=60，比例 1:1:2）對齊 → 預覽 == 出紙（docs/74）。
const PREVIEW_LINE_HEIGHT = 1.4;

// CJK-aware 等寬字型回退：mono 默認只含拉丁字，CJK 由 PingFang TC / Microsoft JhengHei
// / Noto Sans CJK TC / Source Han Sans TC 接住，確保店名 / 標題 / 規格等繁體字唔變方塊 / 唔走樣。
const PREVIEW_FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC", "Source Han Sans", system-ui, sans-serif';

/**
 * 打印時保留顏色 / 底色（`#3`）。
 *
 * 瀏覽器列印預設會「優化」掉背景色同部分前景色（慳墨模式），令預覽有顏色、
 * 列印出嚟變黑白。呢組 style 強制保留設計介面見到嘅顏色同底色。
 * 兩個 property 都寫：WebKit / Blink 認 `-webkit-` 前綴，Firefox 認標準名。
 */
const KEEP_PRINT_COLOR = {
  printColorAdjust: "exact",
  WebkitPrintColorAdjust: "exact",
} as const;

/**
 * 字型設定（#4「文字輕微變形／拉伸」）。
 *
 * 兩條規則：
 * - `fontSynthesis: "none"`：等寬字堆入面嘅 CJK fallback（PingFang TC 最淨得 Semibold）
 *   冇 800 / 700 實體字重，瀏覽器會用「合成粗體」——即將字形橫向塗粗少少嚟扮粗體，
 *   視覺上就係「變形 / 拉伸 / 矇」。關咗合成之後只會用字型原有字重，字形乾淨。
 * - `letterSpacing: 0` + `fontVariantNumeric: "tabular-nums"`：鎖死字距同數字闊度，
 *   等 CSS 唔會因為 `justify-between` / `text-align` 而微調字距。
 */
const CLEAN_TEXT = {
  fontSynthesis: "none",
  letterSpacing: 0,
  fontVariantNumeric: "tabular-nums",
} as const;

/**
 * 把 `formatSpecLine` 拼接嘅 `"加購:加麵 $5"` 拆成 (label, price)，用嚟做 flex 左右排版。
 * 冇價錢就 price = null。
 */
function splitSpecLine(s: string): { label: string; price: string | null } {
  // 匹配結尾 ` $N` / ` -$N` / ` -N`（負數加購罕見，但支援）
  const match = s.match(/^(.*?)\s+(-?\$\d+|-\d+)$/);
  if (!match) return { label: s, price: null };
  return { label: match[1].trimEnd(), price: match[2].startsWith("$") ? match[2] : ` ${match[2]}` };
}

/**
 * 判斷一件菜有冇單品折扣：要同時有 discountRate 同 savingAmount > 0
 * （renderer 唔信任 caller 嘅單一判斷）。
 */
function hasItemDiscount(item: { discountRate?: number; savingAmount?: number }): boolean {
  const rate = item.discountRate;
  if (rate == null || !Number.isFinite(rate) || rate <= 0 || rate >= 100) return false;
  return typeof item.savingAmount === "number" && item.savingAmount > 0;
}

/** 把 item.discountRate 格式化到小票用嘅字串。80 → "80%"；7.5 → "7.5%"。 */
function formatDiscountRate(rate: number): string {
  return Number.isInteger(rate) ? `${rate}%` : `${rate.toFixed(1)}%`;
}

/**
 * 80mm 熱敏紙每行可印嘅 `-` 數量（font A：12 dots 闊 × 48 = 576 dots = 可印闊）。
 * 同 `escpos-render.ts` 嘅 `RECEIPT_PAPER_COLUMNS` 同一個數 —— 實體分格線就係 `"-".repeat(48)`。
 */
/** 舊版 fallback（冇 `cols` 嘅快照）；新邏輯一律用 `EscPosLine.cols`。 */
const DASHES_PER_LINE = 48;
/** 等寬字型入面 `-` 嘅字寬 ÷ font-size（用嚟由「紙闊」反推預覽 dash 嘅字體大細）。 */
const DASH_WIDTH_RATIO = 0.6;
/**
 * 一個 s 檔字符喺預覽入面佔幾多 px。
 *
 * 紙闊由**每行字符數**反推出嚟（`columns × CHAR_PX`），而唔係由 mm 直接乘一個係數：
 * 咁樣先可以保證「預覽每行排到幾多個字」同實體打印機一致（80mm→48 字、58mm→32 字）。
 * 以前係 `mm × 3.2`，結果 80mm 紙只得 ~36 字位、但實機印到 48 字 —— 預覽會提早換行，
 * 排版對唔上出紙（2026-09-10 修）。
 */
const CHAR_PX = SIZE_PX.s * DASH_WIDTH_RATIO;
/** 左右 padding（px-2 = 8px × 2）。 */
const PAPER_PADDING_PX = 16;

/**
 * 分格線（分格線 = 一行 `-` 字符，唔係 CSS border）。
 *
 * 實體打印（`print-relay` `EscPosRenderer.renderTemplateTicket`）嘅分格線係**文字行**：
 * `s` = 1× 闊（48 個 dash 啱啱一行）；`m` = 雙闊；`l` = 2×2（`ESC ! n` / `GS ! n`）。
 * 雙闊之後 48 個 dash 會 **wrap 成兩個物理行**（每行 24 個），呢度照樣模擬 ——
 * 所以預覽見到嘅 dash 大細 / 行數同實紙 100% 一致（2026-09-09 修「預覽條線唔跟字體放大」）。
 */
function DividerRows({
  size,
  paperInnerPx,
  cols = DASHES_PER_LINE,
}: {
  size: EscPosSize;
  paperInnerPx: number;
  /** 呢行要有幾多個 `-`（由 `EscPosTemplateSnapshot.cols` 帶落嚟）。 */
  cols?: number;
}) {
  // 基準（s）：`cols` 個 dash 排滿紙闊 → 每個 dash 嘅 px，再反推 font-size。
  const baseFontPx = paperInnerPx / cols / DASH_WIDTH_RATIO;
  const scaleX = size === "s" ? 1 : 2; // m / l 都係雙闊
  const scaleY = size === "l" ? 2 : 1; // 得 l 係雙高
  const rows = scaleX; // cols 個 dash ÷ 每行一半 = 2 個物理行
  const perRow = cols / rows;
  const rowHeight = baseFontPx * PREVIEW_LINE_HEIGHT * scaleY;
  return (
    <div style={{ overflow: "hidden" }}>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          style={{
            height: rowHeight,
            fontSize: baseFontPx,
            lineHeight: PREVIEW_LINE_HEIGHT,
            whiteSpace: "pre",
            // scaleX / scaleY 模擬 ESC/POS 嘅字符放大（唔影響 layout box，所以要自己俾 height）
            transform: `scale(${scaleX}, ${scaleY})`,
            transformOrigin: "left top",
            ...CLEAN_TEXT,
          }}
        >
          {"-".repeat(perRow)}
        </div>
      ))}
    </div>
  );
}

/**
 * 二維碼（#2）。同 `kiosk-qr-panel` 嘅 QR 用同一個 `encodeQrMatrix` 矩陣、同一個 quiet zone，
 * 而 Companion / APK 出紙亦係讀同一個 `QrPayload` → 預覽 == 出紙 100% 一致。
 *
 * 顯示大細跟紙闊同 `size`（`template.qrSize`）：80mm 紙可印約 48mm 闊，
 * 按 QR_SIZE_FRACTION 取紙闊嘅比例做 QR 邊長（掃得到又唔逼爆）。
 */
function QrBlock({ qr, paperInnerPx, size }: { qr: QrPayload; paperInnerPx: number; size: EscPosSize }) {
  const total = qr.size + QR_QUIET_MODULES * 2;
  // 保證起碼有 56px（QR v1 都睇得到），同時唔會大到甩出紙邊
  const px = Math.max(56, Math.min(paperInnerPx - 8, Math.round(paperInnerPx * QR_SIZE_FRACTION[size])));
  const cell = px / total;
  const rects: React.ReactElement[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.bits[r * qr.size + c] === "1") {
        rects.push(
          <rect
            key={`${r}-${c}`}
            x={(c + QR_QUIET_MODULES) * cell}
            y={(r + QR_QUIET_MODULES) * cell}
            width={cell}
            height={cell}
            fill="#0f172a"
          />,
        );
      }
    }
  }
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      style={{ background: "#ffffff", ...KEEP_PRINT_COLOR }}
      aria-label="收據二維碼"
      role="img"
    >
      <rect width={px} height={px} fill="#ffffff" />
      {rects}
    </svg>
  );
}

/**
 * 真實可打印樣式預覽：等寬字型、單色、粗體 / 對齊 / 字型大小對應 ESC/POS 輸出。
 *
 * 主菜行規則（仿 57.doc 風格 + 適合小票寬度）：
 * - 冇折扣：`1. 人氣半筋半肉麵 ............ x1   $72`
 * - 有折扣：`1. 人氣半筋半肉麵 .......... x1   $58（原價 $72，8折 折讓 $14）`
 *
 * ⚠️ 熱敏機只印到黑白，所以預覽入面用嚟做「層次」嘅顏色（琥珀色折扣行）喺實紙上
 * 係靠 renderer 出**反白（黑底白字）**表達（見 companion-server.mjs / EscPosRenderer.kt）。
 * 呢度保留顏色係為咗設計介面同瀏覽器列印（PDF / 彩色機）睇得到層次。
 */
export function EscPosPreview({
  lines,
  columns = RECEIPT_PAPER_COLUMNS,
}: {
  lines: EscPosLine[];
  /**
   * 每行可印字符數（80mm→48、58mm→32、標籤跟紙尺寸 preset）。
   * 紙闊由呢個數反推出嚟，保證預覽換行位同實體機一致。
   */
  columns?: number;
}) {
  const paperPx = Math.round(columns * CHAR_PX) + PAPER_PADDING_PX;
  // 減返左右 padding（px-2 = 8px × 2），QR 先唔會迫出紙邊
  const paperInnerPx = paperPx - 16;
  return (
    <div className="mx-auto rounded-xl border border-slate-300 bg-white shadow-sm" style={{ width: paperPx }}>
      <div
        className="px-2 py-3 text-slate-900"
        style={{ fontFamily: PREVIEW_FONT_STACK, fontSize: SIZE_PX.s, lineHeight: PREVIEW_LINE_HEIGHT, ...CLEAN_TEXT }}
      >
        {lines.map((line, index) => {
          if (line.kind === "divider") {
            return <DividerRows key={index} size={line.size} paperInnerPx={paperInnerPx} />;
          }
          if (line.kind === "qr") {
            return (
              <div
                key={index}
                className="my-1 flex"
                style={{ justifyContent: line.align === "center" ? "center" : line.align === "right" ? "flex-end" : "flex-start" }}
              >
                <QrBlock qr={line.qr} paperInnerPx={paperInnerPx} size={line.size} />
              </div>
            );
          }
          if (line.kind === "items") {
            const isCard = line.layout === "card";
            return (
              <div key={index} className="space-y-1">
                {line.items.length === 0 ? (
                  <div className="text-slate-400">（無菜品內容）</div>
                ) : (
                  line.items.map((item, idx) => {
                    const hasDiscount = hasItemDiscount(item);
                    const originalShown = hasDiscount && typeof item.originalUnitPrice === "number";
                    return (
                      <div key={idx} className={isCard ? "mb-2 last:mb-0" : ""}>
                        <div
                          className="flex items-baseline justify-between gap-2"
                          style={{ fontSize: SIZE_PX[line.size], fontWeight: line.bold ? 700 : 400, textAlign: line.align, lineHeight: PREVIEW_LINE_HEIGHT }}
                        >
                          <span style={{ textAlign: "left" }}>
                            {isCard ? `${idx + 1}. ` : ""}
                            {item.name}
                          </span>
                          <span className="shrink-0 font-bold tabular-nums">
                            x{item.quantity}
                            {typeof item.price === "number" && item.price > 0 ? (
                              originalShown ? (
                                // 有折扣時：主行只印「折後價」，原價搬到 subline 顯示
                                <span className="ml-1 text-slate-900" style={{ fontWeight: 700 }}>${item.price}</span>
                              ) : (
                                <span className="ml-1 text-slate-700" style={{ fontWeight: 600 }}>${item.price}</span>
                              )
                            ) : null}
                          </span>
                        </div>
                        {/* 有單品折扣時喺菜名下附加一行「折扣率 X%  折讓 $Z」—— 仿 57.doc sub-line */}
                        {hasDiscount ? (
                          <div
                            // 黑底白字（反白）= 熱敏紙實際出紙嘅樣（Companion / APK 用 `ESC { 1`
                            // inverse 印呢行，見 companion-server.mjs `textLine(..., inverse=true)`）。
                            // 以前係琥珀底 + 深色字，但實體列印根本印唔出黃色，預覽同出紙對唔上；
                            // 依家用反白之後，螢幕所見 == 熱敏紙所見，而且係純黑白、對比度最高。
                            className={
                              isCard
                                ? "flex items-baseline justify-between gap-2 rounded bg-slate-900 px-1 pl-4 text-white"
                                : "flex items-baseline justify-between gap-2 rounded bg-slate-900 px-1 pl-3 text-white"
                            }
                            style={{ fontSize: SIZE_PX[line.subSize ?? "s"], ...KEEP_PRINT_COLOR }}
                          >
                            <span>
                              {isCard ? "" : "· "}
                              折扣率 {formatDiscountRate(item.discountRate as number)}
                              {/* ⚠️ 唔好 Math.round：Companion 係 `${it.originalUnitPrice}`、APK 係 num()（2 位小數 trimmed），
                                  呢度 round 咗會令 30.5 顯示成 31、出紙卻係 30.5（「預覽 == 出紙」就斷咗）。 */}
                              {originalShown ? `（原價 $${item.originalUnitPrice}）` : ""}
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums opacity-80">
                              折讓 ${Math.round(item.savingAmount as number)}
                            </span>
                          </div>
                        ) : null}
                        {/* card 排版「每件菜之間」嘅分格線：實機紧跟菜品主行，size 由模板 divider 區塊決定 */}
                        {isCard && line.dividerSize ? (
                          <DividerRows size={line.dividerSize} paperInnerPx={paperInnerPx} cols={columns} />
                        ) : null}
                        <div style={{ fontSize: SIZE_PX[line.subSize ?? "s"] }}>
                          {(item.specs ?? []).map((s, si) => {
                            const { label, price } = splitSpecLine(s);
                            return (
                              <div
                                key={`spec-${si}`}
                                className={isCard ? "flex items-baseline justify-between gap-2 pl-4 opacity-70" : "flex items-baseline justify-between gap-2 pl-3 opacity-70"}
                              >
                                <span>{isCard ? label : `· ${label}`}</span>
                                {price ? <span className="shrink-0 font-semibold opacity-90">{price}</span> : null}
                              </div>
                            );
                          })}
                          {item.note ? (
                            <div
                              key="note"
                              className={isCard ? "pl-4 font-semibold" : "pl-3 font-semibold"}
                            >
                              注：{item.note}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            );
          }
          return (
            <div
              key={index}
              // whitespace-pre-wrap：`content` 入面有 `\n`（例如 discount_breakdown 逐項折讓
              // 用換行串起）時，HTML 默認會摺成空格 → 預覽變一行、出紙卻係幾行。
              // 加 pre-wrap 之後預覽換行位同熱敏紙完全一致（「設計 == 預覽 == 出紙」）。
              className="whitespace-pre-wrap"
              style={{ fontSize: SIZE_PX[line.size], fontWeight: line.bold ? 700 : 400, textAlign: line.align, lineHeight: PREVIEW_LINE_HEIGHT }}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
