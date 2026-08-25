"use client";

import { loadBootstrapCache } from "@/lib/storage";
import { PrintJob } from "@/lib/types";

/**
 * 廚房 / 分區單嘅真實打印樣貌預覽：80mm 熱敏票版面，對齊 APK EscPosRenderer.renderKitchenTicket 嘅 ESC/POS 輸出。
 * 直接用 PrintJob.items（name / quantity / specs / note）重畫，等同商家實際打印畀廚房嘅樣。
 * 收據單（printerGroup === "receipt"）請用 ReceiptTicketPreview（跟打印模板）；呢度專做廚房/分區/標籤單。
 */
export function KitchenTicketPreview({ job }: { job: PrintJob }) {
  const storeName = loadBootstrapCache()?.storeName ?? "門店";
  const items = job.items ?? [];

  return (
    <div className="mx-auto rounded-xl border border-slate-300 bg-white shadow-sm" style={{ width: 320 }}>
      <div className="px-3 py-3 font-mono text-slate-900">
        <div className="text-center text-base font-bold tracking-wide">{storeName}</div>
        <div className="mt-1 text-center text-lg font-extrabold tracking-widest text-red-700">＊＊＊ 廚房 ＊＊＊</div>
        <div className="my-2 border-t-2 border-dashed border-slate-400" />
        <div className="flex justify-between text-xs">
          <span>枱號：{job.tableName ?? "--"}</span>
          <span>單號：{job.orderNo ?? job.orderId}</span>
        </div>
        <div className="text-xs">類型：{job.ticketType === "void" ? "退菜" : job.ticketType === "addon" ? "加單" : "落單"}</div>
        <div className="my-2 border-t-2 border-dashed border-slate-400" />
        <div className="space-y-2">
          {items.length === 0 ? (
            <div className="text-center text-xs text-slate-400">（無菜品內容）</div>
          ) : (
            items.map((item, index) => (
              <div key={`${item.name}-${index}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-bold leading-tight">{item.name}</span>
                  <span className="shrink-0 text-lg font-extrabold">x{item.quantity}</span>
                </div>
                {item.specs && item.specs.length ? (
                  <div className="text-xs text-slate-600">　{item.specs.join(" / ")}</div>
                ) : null}
                {item.note ? <div className="text-xs font-semibold text-red-700">　注：{item.note}</div> : null}
              </div>
            ))
          )}
        </div>
        <div className="my-2 border-t-2 border-dashed border-slate-400" />
        <div className="text-center text-xs text-slate-500">{storeName} · 廚房留底</div>
      </div>
    </div>
  );
}
