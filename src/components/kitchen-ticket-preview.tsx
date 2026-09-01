"use client";

import { useMemo } from "react";

import { PrintJob } from "@/lib/types";
import { buildSnapshot, DEFAULT_KITCHEN_TEMPLATE, ticketTypeLabel } from "@/lib/escpos-template";
import { renderEscPosLines } from "@/lib/escpos-render";
import { EscPosPreview } from "@/components/escpos-preview";

/**
 * 廚房 / 分區單預覽：優先用 PrintJob 自帶嘅 template 快照 + content（與實際打印完全一致）；
 * 冇快照（舊 pending job）就 fallback 用預設廚房模板 + job 既有欄位重建。
 */
export function KitchenTicketPreview({ job }: { job: PrintJob }) {
  const lines = useMemo(() => {
    if (job.template) {
      return renderEscPosLines(job.template, job.content, job.items ?? [], { qr: job.qr ?? null });
    }
    // 兼容舊 job：用預設廚房模板 + job 既有欄位
    const content: Record<string, string> = {
      store_name: "門店",
      order_no: job.orderNo ?? job.orderId,
      table_name: job.tableName ?? "",
      order_type: ticketTypeLabel(job.ticketType),
      footer: "",
    };
    return renderEscPosLines(buildSnapshot("kitchen", DEFAULT_KITCHEN_TEMPLATE), content, job.items ?? []);
  }, [job]);

  return <EscPosPreview lines={lines} paperWidthMm={80} />;
}
