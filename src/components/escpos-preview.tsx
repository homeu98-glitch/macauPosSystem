"use client";

import { EscPosLine, SIZE_PX } from "@/lib/escpos-render";
import { QR_QUIET_MODULES } from "@/lib/escpos-qr";
import type { QrPayload } from "@/lib/types";

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
 * 二維碼（#2）。同 `kiosk-qr-panel` 嘅 QR 用同一個 `encodeQrMatrix` 矩陣、同一個 quiet zone，
 * 而 Companion / APK 出紙亦係讀同一個 `QrPayload` → 預覽 == 出紙 100% 一致。
 *
 * 顯示大細跟紙闊：80mm 紙可印約 48mm 闊，取紙闊嘅 ~60% 做 QR 邊長（掃得到又唔逼爆）。
 */
function QrBlock({ qr, paperInnerPx }: { qr: QrPayload; paperInnerPx: number }) {
  const total = qr.size + QR_QUIET_MODULES * 2;
  const px = Math.max(72, Math.round(paperInnerPx * 0.6));
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
export function EscPosPreview({ lines, paperWidthMm = 80 }: { lines: EscPosLine[]; paperWidthMm?: number }) {
  const paperPx = Math.round(paperWidthMm * 3.2);
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
            return <div key={index} className="my-1 border-t border-dashed border-slate-300" />;
          }
          if (line.kind === "qr") {
            return (
              <div
                key={index}
                className="my-1 flex"
                style={{ justifyContent: line.align === "center" ? "center" : line.align === "right" ? "flex-end" : "flex-start" }}
              >
                <QrBlock qr={line.qr} paperInnerPx={paperInnerPx} />
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
                            // 琥珀底 + 深色字 = 設計介面同瀏覽器列印見到「呢行係折扣」；
                            // 熱敏紙印唔到色，renderer 改用反白（黑底白字）表達同一個層次。
                            className={isCard ? "flex items-baseline justify-between gap-2 rounded bg-amber-100 px-1 pl-4 text-amber-800" : "flex items-baseline justify-between gap-2 rounded bg-amber-100 px-1 pl-3 text-amber-800"}
                            style={{ fontSize: SIZE_PX[line.subSize ?? "s"], ...KEEP_PRINT_COLOR }}
                          >
                            <span>
                              {isCard ? "" : "· "}
                              折扣率 {formatDiscountRate(item.discountRate as number)}
                              {/* ⚠️ 唔好 Math.round：Companion 係 `${it.originalUnitPrice}`、APK 係 num()（2 位小數 trimmed），
                                  呢度 round 咗會令 30.5 顯示成 31、出紙卻係 30.5（「預覽 == 出紙」就斷咗）。 */}
                              {originalShown ? `（原價 $${item.originalUnitPrice}）` : ""}
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums opacity-90">
                              折讓 ${Math.round(item.savingAmount as number)}
                            </span>
                          </div>
                        ) : null}
                        {isCard ? <div className="my-1 border-t border-dashed border-slate-300" /> : null}
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
