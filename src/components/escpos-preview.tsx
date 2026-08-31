"use client";

import { EscPosLine, SIZE_PX } from "@/lib/escpos-render";

// 相對行高（CSS）。因 SIZE_PX.l = 2× SIZE_PX.s（22 vs 11），l 行箱自然 = 2× s 行箱，
// 同 Companion / Android ESC 3 n 表（s/m=30, l=60，比例 1:1:2）對齊 → 預覽 == 出紙（docs/74）。
const PREVIEW_LINE_HEIGHT = 1.4;

// CJK-aware 等寬字型回退：mono 默認只含拉丁字，CJK 由 PingFang TC / Microsoft JhengHei
// / Noto Sans CJK TC / Source Han Sans TC 接住，確保店名 / 標題 / 規格等繁體字唔變方塊 / 唔走樣。
const PREVIEW_FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC", "Source Han Sans", system-ui, sans-serif';

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
 * 真實可打印樣式預覽：等寬字型、單色、粗體 / 對齊 / 字型大小對應 ESC/POS 輸出。
 * 唔用任何 CSS 顏色 / 邊框 / 絕對定位（熱敏機印唔到），確保設計介面 == 實際輸出。
 *
 * 主菜行規則（仿 57.doc 風格 + 適合小票寬度）：
 * - 冇折扣：`1. 人氣半筋半肉麵 ............ x1   $72`
 * - 有折扣：`1. 人氣半筋半肉麵 .......... x1   $58（原價 $72，8折 折讓 $14）`
 *
 * Spec rows：一律印右邊價錢（addons）。
 * Item-level discount（無 spec row 位置）：sub-line 印「折扣率 X%  折讓 $Z」。
 */
export function EscPosPreview({ lines, paperWidthMm = 80 }: { lines: EscPosLine[]; paperWidthMm?: number }) {
  return (
    <div className="mx-auto rounded-xl border border-slate-300 bg-white shadow-sm" style={{ width: Math.round(paperWidthMm * 3.2) }}>
      <div
        className="px-2 py-3 text-slate-900"
        style={{ fontFamily: PREVIEW_FONT_STACK, fontSize: SIZE_PX.s, lineHeight: PREVIEW_LINE_HEIGHT }}
      >
        {lines.map((line, index) => {
          if (line.kind === "divider") {
            return <div key={index} className="my-1 border-t border-dashed border-slate-300" />;
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
                          <span className="shrink-0 font-extrabold tabular-nums">
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
                            className={isCard ? "flex items-baseline justify-between gap-2 pl-4 text-amber-700" : "flex items-baseline justify-between gap-2 pl-3 text-amber-700"}
                            style={{ fontSize: SIZE_PX[line.subSize ?? "s"] }}
                          >
                            <span>
                              {isCard ? "" : "· "}
                              折扣率 {formatDiscountRate(item.discountRate as number)}
                              {originalShown ? `（原價 $${Math.round(item.originalUnitPrice as number)}）` : ""}
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
            <div key={index} style={{ fontSize: SIZE_PX[line.size], fontWeight: line.bold ? 700 : 400, textAlign: line.align, lineHeight: PREVIEW_LINE_HEIGHT }}>
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
