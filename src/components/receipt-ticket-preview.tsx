"use client";

import { useMemo } from "react";

import { loadBootstrapCache, loadPosLocalSettings } from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { buildReceiptContent, buildSnapshot } from "@/lib/escpos-template";
import { renderEscPosLines, formatSpecLine, unitBasePrice } from "@/lib/escpos-render";
import { discountedUnitPrice } from "@/lib/pos/discount";
import { resolveStoreTel } from "@/lib/pos/store-tel";
import { EscPosPreview } from "@/components/escpos-preview";

/**
 * 收據預覽：讀真實 order + 真實門店名 + 商家收據模板，用統一 ESC/POS 渲染，
 * 等同收銀機實際打印出嚟嘅收據（設計介面 == 輸出）。
 *
 * 每件菜都帶埋 PrintItemLine 嘅全欄位（基價 / 折後 / 折扣率 / savingAmount），
 * renderer（EscPosPreview 同 APK / Companion）會自動印「原價 / 折後 / 折讓」三欄。
 */
export function ReceiptTicketPreview({ order }: { order: PosOrder }) {
  const template = loadPosLocalSettings().printTemplates.receipt;
  const bootstrap = loadBootstrapCache();
  const storeName = bootstrap?.storeName ?? "門店";
  const currency = bootstrap?.currency ?? "MOP";
  // 收據電話：門店設定 → 商家登入號碼 fallback。見 src/lib/pos/store-tel.ts。
  const storeTel = resolveStoreTel(bootstrap?.storeTel);

  const lines = useMemo(() => {
    const items = order.items.map((it) => {
      const base = unitBasePrice(it);
      const hasDiscount = typeof it.discountRate === "number" && it.discountRate > 0 && it.discountRate < 100;
      const discounted = hasDiscount ? discountedUnitPrice(base, it.discountRate) : base;
      const saving = hasDiscount ? Math.round((base - discounted) * it.quantity * 100) / 100 : 0;
      return {
        name: it.name,
        quantity: it.quantity,
        // 主行價：冇折扣 → 原價 × quantity；有折扣 → 折後價 × quantity（renderer 會另外印 originalUnitPrice）。
        price:
          it.price > 0
            ? Math.round(discounted * it.quantity)
            : undefined,
        discountRate: hasDiscount ? it.discountRate : undefined,
        originalUnitPrice: hasDiscount ? Math.round(base) : undefined,
        discountedUnitPrice: hasDiscount ? Math.round(discounted) : undefined,
        savingAmount: saving > 0 ? saving : undefined,
        specs: (it.selectedSpecs ?? []).map((s) => formatSpecLine(s)),
        note: it.note,
      };
    });
    const content = buildReceiptContent(order, { storeName, storeTel, currency, footerText: template.footerText });
    return renderEscPosLines(buildSnapshot("receipt", template), content, items);
  }, [order, template, storeName, storeTel, currency]);

  return <EscPosPreview lines={lines} paperWidthMm={80} />;
}
