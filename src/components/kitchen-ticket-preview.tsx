"use client";

import { useMemo } from "react";

import { PrintJob } from "@/lib/types";
import {
  buildSnapshot,
  DEFAULT_KITCHEN_TEMPLATE,
  DEFAULT_SHIFT_TEMPLATE,
  ticketTypeLabel,
} from "@/lib/escpos-template";
import { RECEIPT_PAPER_COLUMNS, renderEscPosLines } from "@/lib/escpos-render";
import { EscPosPreview } from "@/components/escpos-preview";

/**
 * **冇模板快照**嘅任務預覽（舊 job / 快照丟失時嘅兜底）。
 *
 * 有 `job.template` 嘅 job 唔會行到呢度 —— 打印中心直接 `renderEscPosLines(job.template, …)`。
 *
 * ## 🔴 2026-09-13 修：以前一律套廚房模板（商家實案）
 *
 * 舊寫法條 fallback 係無條件噉：
 *
 * ```ts
 * return renderEscPosLines(buildSnapshot("kitchen", DEFAULT_KITCHEN_TEMPLATE), content, job.items ?? []);
 * ```
 *
 * 後果（交班單為例）：
 *   1. **抬頭錯**：`buildSnapshot("kitchen", …)` → 硬印「＊＊＊ 廚房 ＊＊＊」
 *      （交班單本來就係 fallthrough 去空標題，見 `escpos-render.ts` TITLE 表註釋）；
 *   2. **內容空**：呢條 fallback 只餵 6 個廚房欄位，**完全冇讀 `job.content`** ——
 *      而交班單嘅營業額 / 現金 / 單數**全部喺 `job.content`**，加上 `items: []`
 *      → 出紙剩返「門店 + 單號」兩行 → 商家睇落就係「一張空白單」。
 *
 * 呢個係典型「靜默出錯」：唔會 throw、唔會紅標，只係靜靜印錯嘢。
 * （同 2026-09-10「杯標籤被當 kitchen 印錯抬頭」係同一個病。）
 *
 * ## 而家點分流
 *
 * 按 `job.kind`（2026-09-13 新增嘅權威欄位）判別：
 *   - `shift` **＋有 `content`** → 用預設交班模板重建 → **可以完整還原交班結算單**；
 *   - 其餘（`kitchen` / 未知）→ 保持原本嘅廚房兜底（兼容舊 pending 廚房 job）。
 *
 * ⚠️ 舊版（2026-09-10 前）交班 job 冇 `kind` 亦冇 `content`，只能靠單號前綴認；
 * 認到但冇 `content` 都冇嘢可還原（數據根本冇入過 job）→ 照走廚房兜底。
 * 呢類記錄請用「重打」重新產生一張（新 job 會帶齊 `kind` + `template` + `content`）。
 */
export function KitchenTicketPreview({ job }: { job: PrintJob }) {
  const lines = useMemo(() => {
    // ① 有快照 → 永遠最優先（同實際出紙 100% 一致）。理論上行唔到，保險而已。
    if (job.template) {
      return renderEscPosLines(job.template, job.content, job.items ?? [], { qr: job.qr ?? null });
    }

    // ② 交班單 → 用預設交班模板 + `job.content` 還原。
    //    ⚠️ 一定要有 `content`：交班單冇 items，全部數字都喺 content；
    //    冇 content 就冇嘢可還原，強行行呢條只會出一張真空單。
    if (isShiftJob(job) && job.content) {
      return renderEscPosLines(buildSnapshot("shift", DEFAULT_SHIFT_TEMPLATE), job.content, []);
    }

    // ③ 其餘 → 廚房兜底（兼容舊 pending 廚房 job：本身冇 template / content）。
    const content: Record<string, string> = {
      store_name: "門店",
      order_no: job.orderNo ?? job.orderId,
      table_name: job.tableName ?? "",
      order_type: ticketTypeLabel(job.ticketType),
      order_note: job.content?.order_note ?? "",
      footer: "",
    };
    return renderEscPosLines(buildSnapshot("kitchen", DEFAULT_KITCHEN_TEMPLATE), content, job.items ?? []);
  }, [job]);

  return <EscPosPreview lines={lines} columns={RECEIPT_PAPER_COLUMNS} />;
}

/**
 * 呢張 job 係唔係交班單。
 *
 * 主判據 = `job.kind`（新 job 一定帶）。單號前綴只係**過渡兼容**
 * 2026-09-10 改版前建立、冇 `kind` 嘅舊記錄 —— 唔好再加其他魔法字串。
 */
function isShiftJob(job: PrintJob): boolean {
  if (job.kind === "shift") return true;
  return /^交班單/.test(job.orderNo ?? "");
}
