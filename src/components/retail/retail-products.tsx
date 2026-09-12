"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadRetailProducts, saveRetailProducts } from "@/lib/storage";
import type { RetailProduct, RetailVariant } from "@/lib/retail/types";
import {
  categoriesOf,
  emptyProductDraft,
  filterProducts,
  nextProductId,
  productStats,
  removeRetailProduct,
  setProductActive,
  upsertRetailProduct,
  applyImportPlan,
} from "@/lib/retail/catalog-ops";
import { buildImportPlan, describeImportPlan, type ImportPlan } from "@/lib/retail/csv-import";
import { createCatalog } from "@/lib/retail/barcode-index";
import { RetailLabelPrint } from "@/components/retail/retail-label-print";

const money = (v: number) => `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;

type Toast = { tone: "ok" | "err" | "info"; text: string };

export function RetailProducts() {
  const [products, setProducts] = useState<RetailProduct[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [editing, setEditing] = useState<RetailProduct | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    setProducts(loadRetailProducts());
  }, []);

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  /** 寫入一定要檢查回傳值 —— 靜默失敗會出現「撳完似成功、reload 打回原形」 */
  const persist = useCallback(
    (next: RetailProduct[], okText: string) => {
      setProducts(next);
      const wrote = saveRetailProducts(next);
      if (!wrote) {
        flash("err", "寫入失敗（儲存空間不足 / 私隱模式）→ 改動可能未儲存");
        return false;
      }
      flash("ok", okText);
      return true;
    },
    [flash],
  );

  const stats = useMemo(() => productStats(products), [products]);
  const catalog = useMemo(() => createCatalog(products), [products]);
  const list = useMemo(
    () => filterProducts(products, { keyword: query, categoryId: category || undefined, onlyLowStock: onlyLow, onlyActive: false }),
    [products, query, category, onlyLow],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="text-[15px] font-bold">商品管理</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            共 {stats.total} 件 · 有效 {stats.active} · 變體 {stats.variantCount} · 低庫存 {stats.lowStock} · 缺貨 {stats.outOfStock}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            className="rounded-xl border border-slate-300 px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => setLabelOpen(true)}
            type="button"
          >
            印價籤
          </button>
          <button
            className="rounded-xl border border-slate-300 px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => setImportOpen(true)}
            type="button"
          >
            匯入 CSV
          </button>
          <button
            className="rounded-xl bg-orange-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-orange-700"
            onClick={() => setEditing({ ...emptyProductDraft(undefined, nextProductId(products)) })}
            type="button"
          >
            ＋ 新增商品
          </button>
        </div>
      </header>

      {catalog.conflicts.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
          ⚠️ {catalog.conflicts.length} 個條碼 / PLU 撞咗 —— 掃碼會收錯錢，請修正：
          {catalog.conflicts.slice(0, 5).map((c) => ` ${c.code}`).join("、")}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <input
          className="w-full max-w-[280px] rounded-xl border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-orange-400"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜商品名 / 條碼 / PLU / SKU"
          value={query}
        />
        <button
          className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${category === "" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
          onClick={() => setCategory("")}
          type="button"
        >
          全部
        </button>
        {categoriesOf(products).map((c) => (
          <button
            key={c}
            className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${category === c ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setCategory(c)}
            type="button"
          >
            {c}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[12px] font-semibold text-slate-600">
          <input checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} type="checkbox" />
          只睇低庫存 / 缺貨
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {list.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-slate-400">
            {products.length === 0 ? "未有商品 → 撳「新增商品」或者「匯入 CSV」" : "冇符合嘅商品"}
          </p>
        ) : (
          <div className="grid gap-2">
            {list.map((p) => (
              <div
                key={p.id}
                className={`flex flex-wrap items-center gap-3 rounded-xl border bg-white p-3 ${
                  p.isActive === false ? "border-slate-200 opacity-60" : "border-slate-200"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold">{p.name}</span>
                    {p.isActive === false ? <Badge tone="slate">已停售</Badge> : null}
                    {p.isWeighed ? <Badge tone="cyan">稱重</Badge> : null}
                    {p.isSerialized ? <Badge tone="amber">序號</Badge> : null}
                    {p.requiresRecord ? <Badge tone="blue">需登記</Badge> : null}
                    {p.minAge ? <Badge tone="rose">{p.minAge}+</Badge> : null}
                    {(p.variants ?? []).length > 0 ? (
                      <Badge tone="violet">{p.variants!.length} 變體</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    <span>{p.categoryId || "未分類"}</span>
                    <span>{money(p.price)} / {p.unit}</span>
                    {p.barcode ? <span>條碼 {p.barcode}</span> : null}
                    {p.plu ? <span>PLU {p.plu}</span> : null}
                    {p.sku ? <span>SKU {p.sku}</span> : null}
                    {p.trackStock ? <span>存 {p.stockQty ?? 0}</span> : <span>唔追蹤庫存</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <SmallBtn onClick={() => setEditing(p)}>編輯</SmallBtn>
                  <SmallBtn
                    onClick={() =>
                      persist(
                        setProductActive(products, p.id, p.isActive === false),
                        p.isActive === false ? "已恢復售賣" : "已停售",
                      )
                    }
                  >
                    {p.isActive === false ? "恢復" : "停售"}
                  </SmallBtn>
                  <SmallBtn
                    tone="danger"
                    onClick={() => {
                      if (!window.confirm(`確定刪除「${p.name}」？（歷史訂單唔受影響）`)) return;
                      persist(removeRetailProduct(products, p.id), "已刪除");
                    }}
                  >
                    刪除
                  </SmallBtn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {toast ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 md:bottom-8">
          <div
            className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${
              toast.tone === "ok" ? "bg-emerald-600" : toast.tone === "err" ? "bg-rose-600" : "bg-slate-800"
            }`}
          >
            {toast.text}
          </div>
        </div>
      ) : null}

      {editing ? (
        <ProductEditor
          existing={products}
          onClose={() => setEditing(null)}
          onSave={(p) => {
            const ok = persist(upsertRetailProduct(products, p), "已儲存");
            if (ok) setEditing(null);
          }}
          product={editing}
        />
      ) : null}

      {labelOpen ? (
        <RetailLabelPrint onClose={() => setLabelOpen(false)} products={products} />
      ) : null}

      {importOpen ? (
        <CsvImport
          onApply={(plan) => {
            const r = applyImportPlan(products, plan);
            const ok = persist(
              r.products,
              `已匯入：新增 ${r.createdCount} · 更新 ${r.updatedCount}${r.missing.length ? ` · 對唔中 ${r.missing.length}` : ""}`,
            );
            if (ok) setImportOpen(false);
          }}
          onClose={() => setImportOpen(false)}
          products={products}
        />
      ) : null}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    cyan: "bg-cyan-50 text-cyan-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-blue-50 text-blue-700",
    rose: "bg-rose-50 text-rose-700",
    violet: "bg-violet-50 text-violet-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tones[tone] ?? tones.slate}`}>
      {children}
    </span>
  );
}

function SmallBtn({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${
        tone === "danger"
          ? "bg-rose-50 text-rose-700 hover:bg-rose-100"
          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11.5px] font-semibold text-slate-600">{label}</span>
      {children}
      {hint ? <span className="text-[10.5px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-[13px] outline-none focus:border-orange-400";

function ProductEditor({
  product,
  existing,
  onSave,
  onClose,
}: {
  product: RetailProduct;
  existing: readonly RetailProduct[];
  onSave: (p: RetailProduct) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RetailProduct>(product);
  const isNew = !existing.some((p) => p.id === product.id);

  const set = <K extends keyof RetailProduct>(k: K, v: RetailProduct[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const setVariant = (i: number, patch: Partial<RetailVariant>) =>
    setDraft((d) => ({
      ...d,
      variants: (d.variants ?? []).map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    }));

  const addVariant = () =>
    setDraft((d) => ({
      ...d,
      variants: [
        ...(d.variants ?? []),
        { id: `v-${Date.now().toString(36)}`, label: "", attributes: {}, stockQty: 0 },
      ],
    }));

  const removeVariant = (i: number) =>
    setDraft((d) => {
      const next = (d.variants ?? []).filter((_, idx) => idx !== i);
      return { ...d, variants: next.length > 0 ? next : undefined };
    });

  const nameOk = draft.name.trim().length > 0;
  const weighedOk = !draft.isWeighed || Boolean(draft.plu?.trim());
  const canSave = nameOk && weighedOk;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 md:items-center md:p-6">
      <div className="max-h-[94dvh] w-full max-w-[720px] overflow-y-auto rounded-t-3xl bg-white p-4 md:rounded-3xl">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-bold">{isNew ? "新增商品" : `編輯 · ${product.name}`}</h2>
          <button
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-[14px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="商品名 *">
            <input className={inputCls} onChange={(e) => set("name", e.target.value)} value={draft.name} />
          </Field>
          <Field label="分類">
            <input
              className={inputCls}
              list="retail-categories"
              onChange={(e) => set("categoryId", e.target.value)}
              value={draft.categoryId}
            />
            <datalist id="retail-categories">
              {categoriesOf(existing).map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="售價（MOP）">
            <input
              className={inputCls}
              inputMode="decimal"
              onChange={(e) => set("price", Number(e.target.value) || 0)}
              value={draft.price}
            />
          </Field>
          <Field label="單位">
            <input
              className={inputCls}
              list="retail-units"
              onChange={(e) => set("unit", e.target.value)}
              value={draft.unit}
            />
            <datalist id="retail-units">
              {["件", "kg", "包", "盒", "個", "支"].map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field label="主條碼" hint="可以多個條碼：下面用逗號 / 空格分隔">
            <input
              className={inputCls}
              onChange={(e) => set("barcode", e.target.value.trim())}
              value={draft.barcode ?? ""}
            />
          </Field>
          <Field label="額外條碼">
            <input
              className={inputCls}
              onChange={(e) =>
                set(
                  "extraBarcodes",
                  e.target.value.split(/[|;、,，\s]+/).map((s) => s.trim()).filter(Boolean),
                )
              }
              value={(draft.extraBarcodes ?? []).join(" ")}
            />
          </Field>
          <Field label="SKU">
            <input
              className={inputCls}
              onChange={(e) => set("sku", e.target.value.trim() || undefined)}
              value={draft.sku ?? ""}
            />
          </Field>
          <Field
            hint={draft.isWeighed ? "稱重商品必填（秤端只認 PLU）" : "非稱重商品可留空"}
            label={`PLU${draft.isWeighed ? " *" : ""}`}
          >
            <input
              className={inputCls}
              onChange={(e) => set("plu", e.target.value.trim() || undefined)}
              value={draft.plu ?? ""}
            />
          </Field>
          <Field label="成本">
            <input
              className={inputCls}
              inputMode="decimal"
              onChange={(e) => set("cost", e.target.value === "" ? undefined : Number(e.target.value))}
              value={draft.cost ?? ""}
            />
          </Field>
          <Field label="原價（畫刪除線用）">
            <input
              className={inputCls}
              inputMode="decimal"
              onChange={(e) =>
                set("originalPrice", e.target.value === "" ? undefined : Number(e.target.value))
              }
              value={draft.originalPrice ?? ""}
            />
          </Field>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="text-[12px] font-bold text-slate-700">形態與庫存</div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <Check
              checked={draft.trackStock}
              label="追蹤庫存（售出即扣）"
              onChange={(v) => set("trackStock", v)}
            />
            <Check
              checked={Boolean(draft.isWeighed)}
              label="稱重商品（以重量計價）"
              onChange={(v) => set("isWeighed", v)}
            />
            <Check
              checked={Boolean(draft.isSerialized)}
              label="序號商品（售出要登記）"
              onChange={(v) => set("isSerialized", v)}
            />
            <Check
              checked={Boolean(draft.requiresRecord)}
              label="需登記（藥房 / 受管制）"
              onChange={(v) => set("requiresRecord", v)}
            />
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="庫存數量">
              <input
                className={inputCls}
                inputMode="decimal"
                onChange={(e) => set("stockQty", Number(e.target.value) || 0)}
                value={draft.stockQty ?? 0}
              />
            </Field>
            <Field label="補貨警戒線">
              <input
                className={inputCls}
                inputMode="numeric"
                onChange={(e) =>
                  set("reorderLevel", e.target.value === "" ? undefined : Number(e.target.value))
                }
                value={draft.reorderLevel ?? ""}
              />
            </Field>
            <Field label="年齡限制">
              <input
                className={inputCls}
                inputMode="numeric"
                onChange={(e) => set("minAge", e.target.value === "" ? undefined : Number(e.target.value))}
                value={draft.minAge ?? ""}
              />
            </Field>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label="批次">
              <input
                className={inputCls}
                onChange={(e) => set("batchNo", e.target.value.trim() || undefined)}
                value={draft.batchNo ?? ""}
              />
            </Field>
            <Field label="有效日期">
              <input
                className={inputCls}
                onChange={(e) => set("expiryDate", e.target.value.trim() || undefined)}
                placeholder="YYYY-MM-DD"
                value={draft.expiryDate ?? ""}
              />
            </Field>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-bold text-slate-700">
              變體（顏色 × 尺碼）{(draft.variants ?? []).length > 0 ? `· ${draft.variants!.length}` : ""}
            </span>
            <button
              className="ml-auto rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700"
              onClick={addVariant}
              type="button"
            >
              ＋ 新增變體
            </button>
          </div>
          {(draft.variants ?? []).length === 0 ? (
            <p className="mt-2 text-[11px] text-slate-400">
              有變體嘅商品，售價同庫存以變體為準（母體數值只作參考）。稱重商品唔應該行變體。
            </p>
          ) : (
            <div className="mt-2 grid gap-2">
              {(draft.variants ?? []).map((v, i) => (
                <div key={v.id} className="grid grid-cols-[1.4fr_1.6fr_0.8fr_0.8fr_auto] gap-2">
                  <input
                    className={inputCls}
                    onChange={(e) => setVariant(i, { label: e.target.value })}
                    placeholder="黑 / L"
                    value={v.label}
                  />
                  <input
                    className={inputCls}
                    onChange={(e) => setVariant(i, { barcode: e.target.value.trim() || undefined })}
                    placeholder="條碼"
                    value={v.barcode ?? ""}
                  />
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    onChange={(e) => setVariant(i, { stockQty: Number(e.target.value) || 0 })}
                    placeholder="庫存"
                    value={v.stockQty ?? 0}
                  />
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    onChange={(e) =>
                      setVariant(i, { price: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                    placeholder={`價 ${draft.price}`}
                    value={v.price ?? ""}
                  />
                  <button
                    className="rounded-lg bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-700"
                    onClick={() => removeVariant(i)}
                    type="button"
                  >
                    刪
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <button
            className="rounded-2xl border border-slate-300 px-5 py-3 text-[13px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="flex-1 rounded-2xl bg-orange-600 py-3 text-[14px] font-bold text-white disabled:bg-slate-300"
            disabled={!canSave}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
            type="button"
          >
            {!nameOk ? "要填商品名" : !weighedOk ? "稱重商品要填 PLU" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Check({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-700">
      <input checked={checked} onChange={(e) => onChange(e.target.checked)} type="checkbox" />
      {label}
    </label>
  );
}

function CsvImport({
  products,
  onApply,
  onClose,
}: {
  products: readonly RetailProduct[];
  onApply: (plan: ImportPlan) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const preview = useCallback(() => {
    const p = buildImportPlan(text, products);
    setPlan(p);
  }, [text, products]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 md:items-center md:p-6">
      <div className="max-h-[94dvh] w-full max-w-[860px] overflow-y-auto rounded-t-3xl bg-white p-4 md:rounded-3xl">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-bold">匯入商品 CSV</h2>
          <button
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-[14px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <p className="mt-2 rounded-xl bg-slate-50 p-3 text-[11.5px] leading-relaxed text-slate-600">
          由 Excel 直接出 CSV，**第一行要係表頭**。支援中文表頭（商品名 / 條碼 / 售價 / 分類 / 單位 /
          追蹤庫存 / 庫存 / 稱重 / PLU / 序號 / 有效日期 …）。
          <br />
          貼上 CSV 內容 → 撳「預覽」→ 確認計劃（新增 / 更新 / 錯誤）→ 才寫入。
          <br />
          ⚠️ 稱重商品一定要填 PLU；商品名同售價唔可以空白。匯入**唔會清走** CSV 冇填嘅欄位。
        </p>

        <textarea
          className="mt-3 h-[180px] w-full rounded-xl border border-slate-300 p-3 font-mono text-[12px] outline-none focus:border-orange-400"
          onChange={(e) => {
            setText(e.target.value);
            setPlan(null);
          }}
          placeholder={"商品名,條碼,售價,分類,單位,追蹤庫存,庫存\n維他檸檬茶 250ml,4891028001232,9.5,飲品,件,是,48"}
          value={text}
        />

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-[12px] font-semibold text-white disabled:bg-slate-300"
            disabled={text.trim().length === 0}
            onClick={preview}
            type="button"
          >
            預覽
          </button>
          {plan ? (
            <button
              className="rounded-xl bg-orange-600 px-4 py-2.5 text-[12px] font-semibold text-white disabled:bg-slate-300"
              disabled={plan.errors.length > 0 || (plan.creates.length === 0 && plan.updates.length === 0)}
              onClick={() => onApply(plan)}
              type="button"
            >
              寫入（新增 {plan.creates.length} · 更新 {plan.updates.length}）
            </button>
          ) : null}
        </div>

        {plan ? (
          <div className="mt-3 grid gap-3">
            <div className="rounded-xl bg-slate-50 p-3 text-[12px] font-semibold text-slate-700">
              {describeImportPlan(plan)}
              {plan.unmappedHeaders.length > 0 ? (
                <div className="mt-1 text-[11px] font-normal text-slate-500">
                  未對照嘅欄位（唔會匯入）：{plan.unmappedHeaders.join("、")}
                </div>
              ) : null}
            </div>

            {plan.errors.length > 0 ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                <div className="text-[12px] font-bold text-rose-800">錯誤（{plan.errors.length}）—— 要修好才可以匯入</div>
                <ul className="mt-1 grid gap-0.5 text-[11.5px] text-rose-700">
                  {plan.errors.slice(0, 12).map((e, i) => (
                    <li key={i}>
                      第 {e.rowNumber} 行：{e.message}
                    </li>
                  ))}
                  {plan.errors.length > 12 ? <li>…仲有 {plan.errors.length - 12} 個</li> : null}
                </ul>
              </div>
            ) : null}

            {plan.warnings.length > 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <div className="text-[12px] font-bold text-amber-800">警告（{plan.warnings.length}）—— 唔擋匯入但要留意</div>
                <ul className="mt-1 grid gap-0.5 text-[11.5px] text-amber-700">
                  {plan.warnings.slice(0, 8).map((w, i) => (
                    <li key={i}>
                      第 {w.rowNumber} 行：{w.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan.updates.length > 0 ? (
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-[12px] font-bold text-slate-700">會更新（{plan.updates.length}）</div>
                <ul className="mt-1 grid gap-0.5 text-[11.5px] text-slate-600">
                  {plan.updates.slice(0, 10).map((u, i) => (
                    <li key={i}>
                      第 {u.row.rowNumber} 行 · {u.existing.name}：改 {u.changedFields.join("、")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan.creates.length > 0 ? (
              <div className="rounded-xl border border-slate-200 p-3">
                <div className="text-[12px] font-bold text-slate-700">會新增（{plan.creates.length}）</div>
                <ul className="mt-1 grid gap-0.5 text-[11.5px] text-slate-600">
                  {plan.creates.slice(0, 10).map((r) => (
                    <li key={r.rowNumber}>
                      第 {r.rowNumber} 行 · {r.product.name} · {money(r.product.price)}
                    </li>
                  ))}
                  {plan.creates.length > 10 ? <li>…仲有 {plan.creates.length - 10} 個</li> : null}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
