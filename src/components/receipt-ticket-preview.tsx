"use client";

import { useMemo } from "react";

import { loadBootstrapCache, loadPosLocalSettings } from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { buildReceiptContent, buildSnapshot } from "@/lib/escpos-template";
import { renderEscPosLines, formatSpecLine } from "@/lib/escpos-render";
import { EscPosPreview } from "@/components/escpos-preview";

/**
 * 收據預覽：讀真實 order + 真實門店名 + 商家收據模板，用統一 ESC/POS 渲染，
 * 等同收銀機實際打印出嚟嘅收據（設計介面 == 輸出）。
 */
export function ReceiptTicketPreview({ order }: { order: PosOrder }) {
  const template = loadPosLocalSettings().printTemplates.receipt;
  const bootstrap = loadBootstrapCache();
  const storeName = bootstrap?.storeName ?? "門店";
  const currency = bootstrap?.currency ?? "MOP";

  const lines = useMemo(() => {
    const items = order.items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      price: it.price > 0 ? Math.round(it.price * it.quantity) : undefined,
      specs: (it.selectedSpecs ?? []).map((s) => formatSpecLine(s)),
      note: it.note,
    }));
    const content = buildReceiptContent(order, { storeName, currency, footerText: template.footerText });
    return renderEscPosLines(buildSnapshot("receipt", template), content, items);
  }, [order, template, storeName, currency]);

  return <EscPosPreview lines={lines} paperWidthMm={80} />;
}
