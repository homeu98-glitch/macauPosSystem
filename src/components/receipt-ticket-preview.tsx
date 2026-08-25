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

// 同 print-center 收據預覽嘅 section 內容邏輯一致（樣板：receiptPreviewBlocks），
// 改為讀真實 order + 真實門店名，唔使 designer 嘅 ruler / drag / 選取框。
function buildReceiptBlocks(order: PosOrder, template: ReceiptTemplate): Record<ReceiptSectionId, string[]> {
  const bootstrap = loadBootstrapCache();
  const storeName = bootstrap?.storeName ?? "門店";
  const currency = bootstrap?.currency ?? "MOP";
  return {
    store_name: template.showStoreName ? [storeName] : [],
    order_no: template.showOrderNo ? [order.localOrderNo] : [],
    table_name: template.showTableName ? [order.tableName] : [],
    items: order.items.map((item) => {
      const specs = (item.selectedSpecs ?? []).map((spec) => spec.optionLabel).join(" / ");
      return [item.name, specs, item.note ?? ""].filter(Boolean).join(" · ");
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
                  lines.slice(0, 6).map((line, index) => <div key={`${section}-${index}`}>{line}</div>)
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
