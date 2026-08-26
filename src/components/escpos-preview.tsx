"use client";

import { EscPosLine, SIZE_PX } from "@/lib/escpos-render";

/**
 * 真實可打印樣式預覽：等寬字型、單色、粗體 / 對齊 / 字型大小對應 ESC/POS 輸出。
 * 唔用任何 CSS 顏色 / 邊框 / 絕對定位（熱敏機印唔到），確保設計介面 == 實際輸出。
 */
export function EscPosPreview({ lines, paperWidthMm = 80 }: { lines: EscPosLine[]; paperWidthMm?: number }) {
  return (
    <div className="mx-auto rounded-xl border border-slate-300 bg-white shadow-sm" style={{ width: Math.round(paperWidthMm * 3.2) }}>
      <div className="px-2 py-3 font-mono text-slate-900" style={{ fontSize: SIZE_PX.s, lineHeight: 1.35 }}>
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
                  line.items.map((item, idx) => (
                    <div key={idx} className={isCard ? "mb-2 last:mb-0" : ""}>
                      <div
                        className="flex items-baseline justify-between gap-2"
                        style={{ fontSize: SIZE_PX[line.size], fontWeight: line.bold ? 700 : 400, textAlign: line.align }}
                      >
                        <span style={{ textAlign: "left" }}>
                          {isCard ? `${idx + 1}. ` : ""}
                          {item.name}
                        </span>
                        <span className="shrink-0 font-extrabold">x{item.quantity}</span>
                      </div>
                      {isCard ? <div className="my-1 border-t border-dashed border-slate-300" /> : null}
                      <div style={{ fontSize: SIZE_PX[line.subSize ?? "s"] }}>
                        {(item.specs ?? []).map((s, si) => (
                          <div
                            key={`spec-${si}`}
                            className={isCard ? "pl-4 opacity-70" : "pl-3 opacity-70"}
                          >
                            {isCard ? s : `· ${s}`}
                          </div>
                        ))}
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
                  ))
                )}
              </div>
            );
          }
          return (
            <div key={index} style={{ fontSize: SIZE_PX[line.size], fontWeight: line.bold ? 700 : 400, textAlign: line.align }}>
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
