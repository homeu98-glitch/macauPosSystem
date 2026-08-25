"use client";

import { useMemo } from "react";

import { formatMoney } from "@/lib/format";
import { loadBootstrapCache, loadPosLocalSettings } from "@/lib/storage";
import { PosOrder } from "@/lib/types";

type ReceiptSectionId =
  | "store_name"
  | "order_no"
  | "table_name"
  | "items"
  | "total"
  | "payment_method"
  | "order_note"
  | "footer";

const RECEIPT_SECTION_LABELS: Record<ReceiptSectionId, string> = {
  store_name: "門店名",
  order_no: "單號",
  table_name: "類型/桌台",
  items: "菜品明細",
  total: "總計",
  payment_method: "付款方式",
  order_note: "全單備註",
  footer: "頁尾文案",
};

type ReceiptTemplate = ReturnType<typeof loadPosLocalSettings>["printTemplates"]["receipt"];

/**
 * 菜品明細 section 嘅結構化 entries：每張單嘅「菜品」+「細項（規格/加料/備註）」拆為獨立行。
 * - dish：主行（左：菜名 / 右：份數 x1）
 * - spec：細項（規格 / 加料），視覺上縮入、字體較細
 * - note：備註細項，視覺上縮入、字體較細 + 紅色
 * 視覺位置喺 print-center / 收據預覽保持一致。per-line 拖移需要 section schema 重構（目前 items section 仍為
 * top-level draggable block；dish/spec/note 行作為 sub-element 渲染，繼承 section 嘅 position/size）。
 */
type ReceiptItemLine =
  | { kind: "dish"; name: string; quantity: number }
  | { kind: "spec"; label: string }
  | { kind: "note"; text: string };

export type { ReceiptItemLine };

type ReceiptBlocks = {
  store_name: string[];
  order_no: string[];
  table_name: string[];
  items: ReceiptItemLine[];
  total: string[];
  payment_method: string[];
  order_note: string[];
  footer: string[];
};

// 同 print-center 收據預覽嘅 section 內容邏輯一致（樣板：receiptPreviewBlocks），
// 改為讀真實 order + 真實門店名，唔使 designer 嘅 ruler / drag / 選取框。
function buildReceiptBlocks(order: PosOrder, template: ReceiptTemplate): ReceiptBlocks {
  const bootstrap = loadBootstrapCache();
  const storeName = bootstrap?.storeName ?? "門店";
  const currency = bootstrap?.currency ?? "MOP";
  return {
    store_name: template.showStoreName ? [storeName] : [],
    order_no: template.showOrderNo ? [order.localOrderNo] : [],
    table_name: template.showTableName ? [order.tableName] : [],
    items: order.items.flatMap<ReceiptItemLine>((item) => {
      const lines: ReceiptItemLine[] = [{ kind: "dish", name: item.name, quantity: item.quantity }];
      for (const spec of item.selectedSpecs ?? []) {
        if (spec.optionLabel) lines.push({ kind: "spec", label: `${spec.groupName ?? ""}：${spec.optionLabel}`.replace(/^：/, "") });
      }
      if (item.note) lines.push({ kind: "note", text: item.note });
      return lines;
    }),
    total: [formatMoney(order.total, currency)],
    payment_method: template.showPaymentMethod ? [order.paymentMethod ?? "現金"] : [],
    order_note: template.showOrderNote && order.orderNote ? [order.orderNote] : [],
    footer: template.footerText ? [template.footerText] : [],
  };
}

/**
 * 按現有收據打印模板樣式渲染一張收據預覽（與打印中心預覽同一套 printTemplates.receipt）。
 * 用作「查看」完成單嘅彈窗內容，唔跳點餐介面。
 */
export function ReceiptTicketPreview({ order }: { order: PosOrder }) {
  const template = loadPosLocalSettings().printTemplates.receipt;
  const blocks = useMemo(() => buildReceiptBlocks(order, template), [order, template]);

  return (
    <div className="overflow-auto">
      <div
        className="relative mx-auto rounded-xl border border-slate-300 bg-white shadow-sm"
        style={{
          width: template.canvas.width,
          height: template.canvas.height,
          transform: `scale(${template.canvas.zoom})`,
          transformOrigin: "top center",
        }}
      >
        {template.sectionOrder.map((section) => {
          const layout = template.sectionLayouts[section];
          const lines = blocks[section] ?? [];
          const style = template.sectionStyles[section];
          const isItems = section === "items";
          return (
            <div
              key={section}
              className="absolute overflow-hidden rounded-lg"
              style={{
                left: layout.x,
                top: layout.y,
                width: layout.width,
                height: layout.height,
                padding: style.padding,
                textAlign: style.textAlign,
                backgroundColor: style.backgroundColor,
                borderColor: style.borderColor,
              }}
            >
              <div className="text-[10px] font-semibold tracking-wide text-orange-700">
                {RECEIPT_SECTION_LABELS[section] ?? section}
              </div>
              <div
                className="mt-1 space-y-1 leading-4"
                style={{ fontSize: style.fontSize, fontWeight: style.fontWeight, textAlign: style.textAlign, color: style.textColor }}
              >
                {lines.length > 0 ? (
                  isItems ? (
                    // 菜品明細：菜品主行 + 細項 sub-element（縮入、字級較細、note 紅色）
                    (lines as ReceiptItemLine[]).slice(0, 8).map((line, index) => {
                      if (line.kind === "dish") {
                        return (
                          <div key={`dish-${index}`} className="flex items-baseline justify-between gap-2">
                            <span style={{ fontSize: style.fontSize, fontWeight: 600 }}>{line.name}</span>
                            <span className="shrink-0 font-extrabold">x{line.quantity}</span>
                          </div>
                        );
                      }
                      if (line.kind === "spec") {
                        return (
                          <div
                            key={`spec-${index}`}
                            className="pl-3 text-[0.85em] opacity-80"
                            style={{ color: style.textColor }}
                          >
                            · {line.label}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={`note-${index}`}
                          className="pl-3 text-[0.85em] font-semibold text-red-700"
                        >
                          注：{line.text}
                        </div>
                      );
                    })
                  ) : (
                    (lines as string[]).slice(0, 6).map((line, index) => (
                      <div key={`${section}-${index}`}>{line}</div>
                    ))
                  )
                ) : (
                  <div className="text-slate-400">未顯示</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
