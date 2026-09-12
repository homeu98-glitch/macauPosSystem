"use client";

import { useCallback, useMemo, useState } from "react";

import { loadBootstrapCache, loadDeviceConfig, loadPosLocalSettings } from "@/lib/storage";
import { defaultDeviceConfig } from "@/lib/mock-data";
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import { buildRetailLabelPrintJobs } from "@/lib/print-jobs";
import {
  buildSnapshot,
  labelPaperPreset,
  normalizeRetailLabelTemplate,
  paperColumnsFromSize,
} from "@/lib/escpos-template";
import { formatMoney } from "@/lib/format";
import { buildRetailLabelContent } from "@/lib/retail/retail-label-content";
import { filterProducts } from "@/lib/retail/catalog-ops";
import type { RetailProduct } from "@/lib/retail/types";

const money = (v: number) => `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;

export function RetailLabelPrint({
  products,
  onClose,
}: {
  products: readonly RetailProduct[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [copies, setCopies] = useState(1);
  const [toast, setToast] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

  const flash = useCallback((tone: "ok" | "err" | "info", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const sellable = useMemo(
    () => filterProducts(products, { keyword: query, onlyActive: true }),
    [products, query],
  );

  const selectedProducts = useMemo(
    () => products.filter((p) => selected.has(p.id)),
    [products, selected],
  );

  /** 標籤機（同飲品標籤共用 `role === "label"`） */
  const labelPrinters = useMemo(() => {
    return (loadDeviceConfig() ?? defaultDeviceConfig).printers.filter(
      (p) => p.enabled && p.role === "label",
    );
  }, []);

  /** 模板 + 欄寬（跟打印機機頭同標籤紙取較窄者，同出紙口徑一致） */
  const template = useMemo(
    () => normalizeRetailLabelTemplate(loadPosLocalSettings().printTemplates.retailLabel),
    [],
  );
  const columns = useMemo(() => {
    const preset = labelPaperPreset(template.paperSize).columns;
    const head = labelPrinters[0]?.paperSize;
    if (!head) return preset;
    // 同出紙完全同一口徑：`min(標籤紙闊, 打印機機頭闊)`
    return Math.min(preset, paperColumnsFromSize(head));
  }, [template.paperSize, labelPrinters]);

  /** 預覽：用第一件已揀商品（冇揀就第一件篩選結果） */
  const previewProduct = selectedProducts[0] ?? sellable[0];

  const previewLines = useMemo(() => {
    if (!previewProduct) return [];
    const storeName = loadBootstrapCache()?.storeName ?? "門店";
    const content = buildRetailLabelContent(previewProduct, {
      storeName,
      formatAmount: (v) => formatMoney(v, "MOP"),
      footerText: template.footerText,
      printedDate: new Date().toISOString().slice(0, 10),
      columns,
    });
    // 預覽同出紙同一跳過規則：`!visible` 跳過、`!text` 跳過
    return buildSnapshot("label", template, columns)
      .blocks.filter((b) => b.visible && (content[b.id as keyof typeof content] ?? "").trim())
      .flatMap((b) =>
        (content[b.id as keyof typeof content] ?? "").split("\n").map((text) => ({ id: b.id, text, b })),
      );
  }, [previewProduct, template, columns]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const print = useCallback(() => {
    if (selectedProducts.length === 0) {
      flash("err", "未揀任何商品");
      return;
    }
    const bootstrap = loadBootstrapCache();
    if (!bootstrap) {
      flash("err", "冇門店資料快取（bootstrap）→ 唔可以印");
      return;
    }
    try {
      const jobs = buildRetailLabelPrintJobs(selectedProducts, {
        storeName: bootstrap.storeName,
        currency: bootstrap.currency,
        copies: Math.max(1, Math.floor(copies) || 1),
      });
      if (jobs.length === 0) {
        // 🔴 唔可以靜默：冇標籤機係最常見嘅「撳完冇反應」
        flash("err", "冇啟用嘅標籤機（role=label）→ 未出紙，請去設備設置加標籤機");
        return;
      }
      const count = appendPrintJobsWithSync(jobs);
      flash("ok", `已排 ${count} 張價籤（${selectedProducts.length} 件商品 × ${Math.max(1, copies)} 份）`);
      setSelected(new Set());
    } catch (e) {
      console.error("[retail] 價籤出票失敗", e);
      flash("err", "出票失敗（詳見 console）");
    }
  }, [selectedProducts, copies, flash]);

  const missingBarcode = selectedProducts.filter((p) => !String(p.barcode ?? "").trim()).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 md:items-center md:p-6">
      <div className="flex max-h-[94dvh] w-full max-w-[900px] flex-col rounded-t-3xl bg-white md:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-slate-200 p-4">
          <h2 className="text-[15px] font-bold">印價籤</h2>
          <span className="text-[11.5px] text-slate-500">
            標籤紙 {labelPaperPreset(template.paperSize).label} · {columns} 字／行
          </span>
          <button
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-[14px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        {labelPrinters.length === 0 ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
            ⚠️ 未配置啟用嘅標籤機（role = label）→ 撳「印」唔會出紙。
            去「設備設置 → 打印機」加一部標籤機。
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px]">
          {/* 左：揀商品 */}
          <div className="flex min-h-0 flex-col border-r border-slate-200">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <input
                className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-orange-400"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜商品名 / 條碼 / PLU"
                value={query}
              />
              <button
                className="rounded-lg bg-slate-100 px-3 py-2 text-[11.5px] font-semibold text-slate-700"
                onClick={() => setSelected(new Set(sellable.map((p) => p.id)))}
                type="button"
              >
                全選（{sellable.length}）
              </button>
              <button
                className="rounded-lg bg-slate-100 px-3 py-2 text-[11.5px] font-semibold text-slate-700"
                onClick={() => setSelected(new Set())}
                type="button"
              >
                清除
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {sellable.length === 0 ? (
                <p className="mt-6 text-center text-[12px] text-slate-400">冇符合嘅商品</p>
              ) : (
                <div className="grid gap-1.5">
                  {sellable.slice(0, 200).map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50"
                    >
                      <input
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">{p.name}</span>
                        <span className="mt-0.5 block text-[11px] text-slate-500">
                          {money(p.price)} / {p.unit}
                          {p.barcode ? ` · ${p.barcode}` : " · ⚠️ 冇條碼"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右：預覽 + 數量 + 印 */}
          <div className="flex min-h-0 flex-col p-3">
            <div className="text-[11.5px] font-semibold text-slate-600">
              預覽{previewProduct ? `（${previewProduct.name}）` : ""}
            </div>
            <div className="mt-2 min-h-[120px] rounded-xl bg-slate-50 p-3 font-mono text-[11px] leading-tight">
              {previewLines.length === 0 ? (
                <p className="text-slate-400">揀一件商品睇預覽</p>
              ) : (
                previewLines.map((l, i) => (
                  <div
                    key={`${l.id}-${i}`}
                    className={`whitespace-pre ${
                      l.id === "price" ? "text-[15px] font-bold" : ""
                    } ${l.b.align === "center" ? "text-center" : l.b.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {l.text}
                  </div>
                ))
              )}
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400">
              預覽同出紙同一套跳過規則（熄咗嘅區塊、冇內容嘅區塊都唔會印）。
              「原價」只會喺原價**高過**售價時才出。
            </p>

            <label className="mt-3 grid gap-1">
              <span className="text-[11.5px] font-semibold text-slate-600">每件印幾張</span>
              <input
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-[13px]"
                inputMode="numeric"
                min={1}
                onChange={(e) => setCopies(Number(e.target.value) || 1)}
                type="number"
                value={copies}
              />
            </label>

            {selectedProducts.length > 0 ? (
              <div className="mt-2 rounded-xl bg-slate-50 p-2.5 text-[11.5px] font-semibold text-slate-600">
                已揀 {selectedProducts.length} 件 → 共印 {selectedProducts.length * Math.max(1, copies)} 張
                {labelPrinters.length > 0 ? ` × ${labelPrinters.length} 部標籤機` : ""}
                {missingBarcode > 0 ? (
                  <div className="mt-1 font-normal text-amber-700">
                    ⚠️ {missingBarcode} 件冇條碼（價籤只會印名同價錢）
                  </div>
                ) : null}
              </div>
            ) : null}

            <button
              className="mt-3 w-full rounded-2xl bg-orange-600 py-3.5 text-[14px] font-bold text-white disabled:bg-slate-300"
              disabled={selectedProducts.length === 0}
              onClick={print}
              type="button"
            >
              印價籤
            </button>
          </div>
        </div>

        {toast ? (
          <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2">
            <div
              className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${
                toast.tone === "ok" ? "bg-emerald-600" : toast.tone === "err" ? "bg-rose-600" : "bg-slate-800"
              }`}
            >
              {toast.text}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
