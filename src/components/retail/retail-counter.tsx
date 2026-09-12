"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadPosLocalSettings, loadRetailProducts } from "@/lib/storage";
import type { PosLocalSettings } from "@/lib/types";
import type { RetailProduct, RetailVariant, ScannerProfile } from "@/lib/retail/types";
import {
  createCatalog,
  isScannedHit,
  nextInternalBarcode,
  resolveScannedCode,
} from "@/lib/retail/barcode-index";
import { needsVariantChoice, priceOf } from "@/lib/retail/types";
import { defaultScannerProfile } from "@/lib/retail/scanner-profiles";
import { useBarcodeScanner } from "@/lib/retail/use-barcode-scanner";
import {
  addRetailLine,
  changeRetailQty,
  effectiveUnitPrice,
  lineDiscountAmount,
  lineGross,
  lineHasManualAdjustment,
  removeRetailLine,
  setLineDiscount,
  setLinePriceOverride,
  setLineSerial,
  retailOrderTotals,
  type RetailCartLine,
} from "@/lib/retail/retail-cart";
import {
  appendSplitEntry,
  buildSplitEntry,
  describeSplitSummary,
  isSplitSettled,
  normalizeRetailPaymentMethods,
  removeSplitEntryAt,
  splitChangeDue,
  splitRemaining,
  validateSplitPayment,
} from "@/lib/retail/split-payment";
import { settleRetailOrder } from "@/lib/retail/retail-orders";
import { categoriesOf, filterProducts } from "@/lib/retail/catalog-ops";
import type { RetailPaymentMethod, SplitPaymentEntry } from "@/lib/retail/types";

const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const money = (v: number) => `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;

type Toast = { tone: "ok" | "err" | "info"; text: string };

/** 常用折扣（rate 語義同 pos/discount.ts 一致：80 = 8 折） */
const DISCOUNT_CHIPS = [
  { rate: 95, label: "95 折" },
  { rate: 90, label: "9 折" },
  { rate: 85, label: "85 折" },
  { rate: 80, label: "8 折" },
];

export function RetailCounter() {
  const [products, setProducts] = useState<RetailProduct[]>([]);
  const [settings, setSettings] = useState<PosLocalSettings | null>(null);
  const [ready, setReady] = useState(false);

  const [cart, setCart] = useState<RetailCartLine[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);

  /** 展開調整嘅行（避免一次過顯示全部控制項，觸控太密） */
  const [expandedLine, setExpandedLine] = useState<string | null>(null);
  const [variantPick, setVariantPick] = useState<RetailProduct | null>(null);
  const [weightPick, setWeightPick] = useState<RetailProduct | null>(null);
  const [serialPick, setSerialPick] = useState<{ lineId: string; productId: string } | null>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [split, setSplit] = useState<SplitPaymentEntry[]>([]);
  const [activeMethod, setActiveMethod] = useState<RetailPaymentMethod | null>(null);
  const [cashInput, setCashInput] = useState("");

  /** 行 id 序號（用 ref 而唔用 state —— 唔想因為派 id 而 re-render） */
  const lineSeq = useRef(0);

  // ── 載入（localStorage 只可以喺 client 讀）────────────────────
  useEffect(() => {
    setProducts(loadRetailProducts());
    setSettings(loadPosLocalSettings());
    setReady(true);
  }, []);

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  // ── 衍生資料 ────────────────────────────────────────────────
  const catalog = useMemo(() => createCatalog(products), [products]);

  const scannerProfile: ScannerProfile = useMemo(() => {
    const list = settings?.scannerProfiles ?? [];
    return (
      list.find((p) => p.id === settings?.activeScannerProfileId) ?? list[0] ?? defaultScannerProfile()
    );
  }, [settings]);

  const weighedRules = useMemo(() => settings?.weighedBarcodeRules ?? [], [settings]);

  const paymentMethods = useMemo(() => {
    const structured = normalizeRetailPaymentMethods(settings?.retailPaymentMethods ?? []);
    // 有結構化就用；否則 fallback 舊自由文字（兼容現有商戶）
    return structured.length > 0
      ? structured
      : normalizeRetailPaymentMethods(settings?.paymentMethods ?? []);
  }, [settings]);

  const totals = useMemo(() => retailOrderTotals(cart), [cart]);
  const categories = useMemo(() => categoriesOf(products), [products]);
  const gridProducts = useMemo(
    () => filterProducts(products, { keyword: query, categoryId: category || undefined }).slice(0, 60),
    [products, query, category],
  );

  // ── 加入購物車 ──────────────────────────────────────────────
  const makeLine = useCallback(
    (
      product: RetailProduct,
      variant?: RetailVariant,
      extra?: { weightKg?: number; overrideUnitPrice?: number },
    ): Omit<RetailCartLine, "lineId" | "quantity"> => {
      const weightKg = extra?.weightKg;
      return {
        productId: product.id,
        variantId: variant?.id,
        variantLabel: variant?.label,
        sku: variant?.sku ?? product.sku,
        barcode: variant?.barcode ?? product.barcode,
        plu: product.plu,
        name: product.name,
        unitPrice: extra?.overrideUnitPrice ?? priceOf(product, variant?.id),
        unit: product.unit,
        // 只有真正有重量才當稱重行（stock.ts 靠 isWeighed 決定扣 kg 定扣件）
        isWeighed: Boolean(product.isWeighed && weightKg != null),
        ...(weightKg != null ? { weightKg } : {}),
        ...(product.isSerialized ? { nonMergeable: true } : {}),
      };
    },
    [],
  );

  const pushLine = useCallback((line: Omit<RetailCartLine, "lineId" | "quantity">) => {
    setCart((prev) => addRetailLine(prev, line, `l-${++lineSeq.current}`));
  }, []);

  /** 由商品（+可選變體）加入；需要變體 / 稱重 / 序號就開對應彈窗 */
  const addFromProduct = useCallback(
    (product: RetailProduct, variant?: RetailVariant) => {
      if (product.isActive === false) {
        flash("err", `${product.name} 已停售`);
        return;
      }
      if (!variant && needsVariantChoice(product)) {
        setVariantPick(product);
        return;
      }
      if (product.isWeighed) {
        setWeightPick(product);
        return;
      }
      pushLine(makeLine(product, variant));
      if (product.isSerialized) {
        flash("info", `${product.name} 係序號商品，記得登記序號`);
      }
    },
    [flash, makeLine, pushLine],
  );

  /** 掃碼結果處理 */
  const handleScan = useCallback(
    (code: string) => {
      const hit = resolveScannedCode(code, catalog, weighedRules);
      if (!isScannedHit(hit)) {
        flash("err", `條碼未登記：${code}`);
        return;
      }

      if (hit.kind === "weighed") {
        const product = hit.product;
        const w = hit.weighed;
        if (!product) {
          flash("err", `秤標籤 PLU ${w.plu} 對唔到商品`);
          return;
        }
        if (w.weightKg != null) {
          pushLine(makeLine(product, undefined, { weightKg: w.weightKg }));
          flash("ok", `${product.name} ${w.weightKg} kg`);
          return;
        }
        // 金額碼：反推重量（金額 ÷ 單價）→ 咁樣庫存都扣得到 kg
        const unit = priceOf(product);
        const price = w.price ?? 0;
        if (unit > 0) {
          const weightKg = Math.round((price / unit) * 1000) / 1000;
          pushLine(makeLine(product, undefined, { weightKg }));
          flash("ok", `${product.name} ${weightKg} kg（秤標籤 $${price.toFixed(2)}）`);
        } else {
          // 冇單價就唔可以反推重量 → 當普通一行，改價成秤上金額
          pushLine({ ...makeLine(product), priceOverride: price });
          flash("info", `${product.name} 按秤標籤金額 $${price.toFixed(2)}（未能反推重量）`);
        }
        return;
      }

      const { product, variant } = hit;
      if (product.isActive === false) {
        flash("err", `${product.name} 已停售`);
        return;
      }
      if (product.isWeighed) {
        setWeightPick(product);
        return;
      }
      pushLine(makeLine(product, variant));
      flash("ok", variant ? `${product.name} · ${variant.label}` : product.name);
    },
    [catalog, weighedRules, flash, makeLine, pushLine],
  );

  const handleReject = useCallback(() => {
    // 人手打字 / 雜訊：**唔可以當錯誤提示**，否則店員打搜尋字會見到一大堆紅字
  }, []);

  useBarcodeScanner({
    enabled: ready && !payOpen && !variantPick && !weightPick && !serialPick,
    profile: scannerProfile,
    onScan: handleScan,
    onReject: handleReject,
  });

  // ── 結帳 ────────────────────────────────────────────────────
  const openPayment = useCallback(() => {
    if (cart.length === 0) {
      flash("err", "購物車係空");
      return;
    }
    const cash = paymentMethods.find((m) => m.kind === "cash") ?? paymentMethods[0] ?? null;
    setSplit([]);
    setActiveMethod(cash);
    setCashInput("");
    setPayOpen(true);
  }, [cart.length, paymentMethods, flash]);

  const cashAmount = useMemo(() => {
    const n = Number(cashInput);
    return Number.isFinite(n) && n > 0 ? round2(n) : 0;
  }, [cashInput]);

  const cashChange = useMemo(
    () => (activeMethod?.kind === "cash" && cashAmount > 0 ? round2(Math.max(0, cashAmount - splitRemaining(totals.total, split))) : 0),
    [activeMethod, cashAmount, split, totals.total],
  );

  const addPaymentEntry = useCallback(
    (method: RetailPaymentMethod) => {
      const remaining = splitRemaining(totals.total, split);
      if (remaining <= 0) {
        flash("info", "已經收夠，唔需要再加");
        return;
      }
      if (method.kind === "cash" && cashAmount > 0) {
        // 現金：以輸入嘅實收為準，找零自動計
        setSplit((prev) => [
          ...prev,
          buildSplitEntry(method, cashAmount, cashAmount),
        ]);
        setCashInput("");
        setActiveMethod(method);
        return;
      }
      setSplit((prev) => appendSplitEntry(prev, buildSplitEntry(method, remaining)));
      setActiveMethod(method);
    },
    [totals.total, split, cashAmount, flash],
  );

  const confirmPayment = useCallback(() => {
    const check = validateSplitPayment(totals.total, split);
    if (!check.ok) {
      flash("err", check.errors[0]);
      return;
    }
    const result = settleRetailOrder({
      lines: cart,
      splitPayments: split,
      cashTendered: split.some((s) => s.tendered != null) ? splitChangeDue(split) + splitPaidTotalSafe(split) : undefined,
      changeAmount: splitChangeDue(split),
      primaryMethodLabel: split[0]?.label,
      discountNote: cartHasAdjustment(cart) ? "收銀台調整" : undefined,
    });

    if (!result.ok || !result.order) {
      flash("err", result.error ?? "落單失敗");
      return;
    }

    // 超賣要出聲（唔可以靜默）
    const oversold = (result.stockChanges ?? []).filter((c) => c.shortfall > 0);
    if (oversold.length > 0) {
      flash("info", `已落單 ${result.order.localOrderNo}（注意超賣：${oversold.map((c) => c.label).join("、")}）`);
    } else {
      flash("ok", `已結帳 ${result.order.localOrderNo} · 應收 ${money(totals.total)}`);
    }

    // 商品庫存改咗 → 重新讀，避免畫面同實際唔一致
    setProducts(loadRetailProducts());
    setCart([]);
    setPayOpen(false);
    setSplit([]);
    setCashInput("");
  }, [cart, split, totals.total, flash]);

  const addInternalBarcodeProduct = useCallback(() => {
    const code = nextInternalBarcode(catalog);
    void navigator.clipboard?.writeText(code).catch(() => undefined);
    flash("info", `下一個可用店內自編碼：${code}（已複製）`);
  }, [catalog, flash]);

  // ── 畫面 ────────────────────────────────────────────────────
  return (
    <div className="flex min-h-[calc(100dvh-0px)] flex-col">
      {/* 頂欄 */}
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="text-[15px] font-bold">零售收銀台</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {products.length} 件商品 · {catalog.activeCount} 件有效
            {catalog.conflicts.length > 0 ? ` · ⚠️ ${catalog.conflicts.length} 個撞碼` : ""}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700">
            掃碼槍：{scannerProfile.name}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600">
            折扣 / 改價需授權：{settings?.retailApprovalRules.minDiscountRate ?? 90} 折
          </span>
          <button
            className="rounded-xl border border-slate-300 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
            onClick={addInternalBarcodeProduct}
            type="button"
          >
            取店內自編碼
          </button>
        </div>
      </header>

      {catalog.conflicts.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
          ⚠️ 有 {catalog.conflicts.length} 個條碼 / PLU 撞咗（掃碼可能收錯錢）：
          {catalog.conflicts.slice(0, 3).map((c) => `${c.code}`).join("、")}
          {catalog.conflicts.length > 3 ? " …" : ""} → 去「商品」頁修正
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        {/* ── 左：商品識別 ── */}
        <section className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
          <div className="p-3">
            <input
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-[13px] outline-none focus:border-orange-400"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="掃碼 / 輸入條碼 · 商品名 / PLU / SKU"
              value={query}
            />
          </div>
          <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            <button
              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${category === "" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
              onClick={() => setCategory("")}
              type="button"
            >
              全部
            </button>
            {categories.map((c) => (
              <button
                key={c}
                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${category === c ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
                onClick={() => setCategory(c)}
                type="button"
              >
                {c}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {gridProducts.length === 0 ? (
              <p className="mt-6 text-center text-[12px] text-slate-400">
                {products.length === 0 ? "未有商品 → 去「商品」頁新增或匯入 CSV" : "冇符合嘅商品"}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {gridProducts.map((p) => (
                  <button
                    key={p.id}
                    className="flex min-h-[76px] flex-col justify-between rounded-xl border border-slate-200 p-2.5 text-left hover:border-orange-300 hover:bg-orange-50/40"
                    onClick={() => addFromProduct(p)}
                    type="button"
                  >
                    <span className="line-clamp-2 text-[12px] font-semibold leading-tight">{p.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[13px] font-bold text-orange-600">{money(p.price)}</span>
                      {p.isWeighed ? (
                        <span className="rounded-full bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700">
                          稱重
                        </span>
                      ) : null}
                      {needsVariantChoice(p) ? (
                        <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                          {p.variants?.length ?? 0} 款
                        </span>
                      ) : null}
                      {p.isSerialized ? (
                        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          序號
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── 中：購物車 ── */}
        <section className="flex min-h-0 flex-col bg-slate-50">
          <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
            <div className="min-w-0">
              <div className="text-[14px] font-bold">購物車</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {totals.lineCount} 項 · {totals.quantity} 件
                {totals.weighedTotalKg > 0 ? ` · 稱重 ${totals.weighedTotalKg} kg` : ""}
              </div>
            </div>
            <button
              className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-semibold text-slate-500 hover:bg-slate-100"
              onClick={() => setCart([])}
              type="button"
            >
              清空
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {cart.length === 0 ? (
              <p className="mt-10 text-center text-[12px] text-slate-400">
                掃碼或者撳左邊商品加入
              </p>
            ) : (
              cart.map((line) => {
                const open = expandedLine === line.lineId;
                return (
                  <div key={line.lineId} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold">{line.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {line.variantLabel ? (
                            <Tag tone="violet">{line.variantLabel}</Tag>
                          ) : null}
                          {line.isWeighed && line.weightKg != null ? (
                            <Tag tone="cyan">
                              淨重 {line.weightKg} kg · {money(line.unitPrice)}/{line.unit}
                            </Tag>
                          ) : null}
                          {line.barcode ? <Tag tone="slate">{line.barcode}</Tag> : null}
                          {line.plu ? <Tag tone="slate">PLU {line.plu}</Tag> : null}
                          {line.serialNo ? <Tag tone="amber">SN {line.serialNo}</Tag> : null}
                          {line.priceOverride != null ? (
                            <Tag tone="orange">
                              改價（牌價 {money(line.unitPrice)}）
                            </Tag>
                          ) : null}
                          {line.lineDiscountRate != null && line.lineDiscountRate < 100 ? (
                            <Tag tone="orange">
                              {line.lineDiscountRate} 折 −{money(lineDiscountAmount(line))}
                            </Tag>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {!line.isWeighed ? (
                          <>
                            <QtyBtn
                              onClick={() => setCart((prev) => changeRetailQty(prev, line.lineId, -1))}
                            >
                              −
                            </QtyBtn>
                            <span className="min-w-[34px] text-center text-[13px] font-bold">
                              {line.quantity}
                            </span>
                            <QtyBtn
                              onClick={() => setCart((prev) => changeRetailQty(prev, line.lineId, 1))}
                            >
                              +
                            </QtyBtn>
                          </>
                        ) : (
                          <span className="text-[12px] font-semibold text-slate-500">
                            {line.weightKg} kg
                          </span>
                        )}
                      </div>
                      <div className="w-[86px] text-right">
                        <div className="text-[13px] font-bold">{money(lineGross(line))}</div>
                        {line.priceOverride != null ? (
                          <div className="text-[10px] text-slate-400 line-through">
                            {money(line.unitPrice)}
                          </div>
                        ) : null}
                      </div>
                      <button
                        className="rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-100"
                        onClick={() => setExpandedLine(open ? null : line.lineId)}
                        type="button"
                      >
                        {open ? "收起" : "調整"}
                      </button>
                    </div>

                    {open ? (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-slate-500">折扣</span>
                          {DISCOUNT_CHIPS.map((d) => (
                            <button
                              key={d.rate}
                              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                                line.lineDiscountRate === d.rate
                                  ? "bg-orange-500 text-white"
                                  : "bg-slate-100 text-slate-700"
                              }`}
                              onClick={() =>
                                setCart((prev) =>
                                  setLineDiscount(prev, line.lineId, {
                                    rate: line.lineDiscountRate === d.rate ? undefined : d.rate,
                                  }),
                                )
                              }
                              type="button"
                            >
                              {d.label}
                            </button>
                          ))}
                          <button
                            className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600"
                            onClick={() =>
                              setCart((prev) => setLineDiscount(prev, line.lineId, {}))
                            }
                            type="button"
                          >
                            清除折扣
                          </button>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <label className="text-[11px] font-semibold text-slate-500">改價</label>
                          <input
                            className="w-[110px] rounded-lg border border-slate-300 px-2 py-1.5 text-[12px]"
                            inputMode="decimal"
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              setCart((prev) =>
                                setLinePriceOverride(
                                  prev,
                                  line.lineId,
                                  v === "" ? undefined : Number(v),
                                ),
                              );
                            }}
                            placeholder={String(line.unitPrice)}
                            value={line.priceOverride ?? ""}
                          />
                          <span className="text-[11px] text-slate-400">
                            實際單價 {money(effectiveUnitPrice(line))}
                          </span>
                          {line.priceOverride != null ? (
                            <button
                              className="rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
                              onClick={() =>
                                setCart((prev) => setLinePriceOverride(prev, line.lineId, undefined))
                              }
                              type="button"
                            >
                              還原牌價
                            </button>
                          ) : null}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200"
                            onClick={() => setSerialPick({ lineId: line.lineId, productId: line.productId })}
                            type="button"
                          >
                            {line.serialNo ? "改序號" : "登記序號"}
                          </button>
                          <button
                            className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100"
                            onClick={() => setCart((prev) => removeRetailLine(prev, line.lineId))}
                            type="button"
                          >
                            刪除呢行
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ── 右：結帳 ── */}
        <section className="flex min-h-0 flex-col border-l border-slate-200 bg-white">
          <div className="p-4">
            <div className="text-[11px] font-semibold text-slate-500">應收</div>
            <div className="mt-1 text-[34px] font-extrabold tracking-tight">
              {money(totals.total)}
            </div>
            <div className="mt-3 space-y-2 text-[12.5px]">
              <Row label="小計（牌價）" value={money(totals.listTotal)} />
              {totals.overrideSaving > 0 ? (
                <Row label="改價減免" value={`−${money(totals.overrideSaving)}`} tone="warn" />
              ) : null}
              {totals.itemDiscount > 0 ? (
                <Row label="單品折扣" value={`−${money(totals.itemDiscount)}`} tone="warn" />
              ) : null}
              {totals.orderDiscountAmount > 0 ? (
                <Row label="整單折扣" value={`−${money(totals.orderDiscountAmount)}`} tone="warn" />
              ) : null}
              {
                // 單品折扣 + 整單折扣 = 總優惠
              }
              <div className="border-t border-dashed border-slate-200 pt-2">
                <Row label="應收" value={money(totals.total)} strong />
              </div>
            </div>
          </div>

          <div className="px-4">
            <button
              className="w-full rounded-2xl bg-orange-600 py-4 text-[17px] font-bold text-white hover:bg-orange-700 disabled:bg-slate-300"
              disabled={cart.length === 0}
              onClick={openPayment}
              type="button"
            >
              結帳
            </button>
          </div>

          <div className="mt-auto p-4 text-[11px] leading-relaxed text-slate-400">
            掃碼槍已啟用（{scannerProfile.suffix === "enter" ? "Enter 結尾" : scannerProfile.suffix === "tab" ? "Tab 結尾" : "靠超時收尾"}，
            {scannerProfile.timeoutMs}ms）
            <br />
            人手打字唔會被當成掃碼（用輸入速度分辨）
          </div>
        </section>
      </div>

      {toast ? <ToastBar toast={toast} /> : null}

      {variantPick ? (
        <VariantPicker
          onClose={() => setVariantPick(null)}
          onPick={(v) => {
            const p = variantPick;
            setVariantPick(null);
            pushLine(makeLine(p, v));
          }}
          product={variantPick}
        />
      ) : null}

      {weightPick ? (
        <WeightPad
          onClose={() => setWeightPick(null)}
          onConfirm={(kg) => {
            const p = weightPick;
            setWeightPick(null);
            pushLine(makeLine(p, undefined, { weightKg: kg }));
            flash("ok", `${p.name} ${kg} kg = ${money(round2(kg * priceOf(p)))}`);
          }}
          product={weightPick}
        />
      ) : null}

      {serialPick ? (
        <SerialPad
          onClose={() => setSerialPick(null)}
          onConfirm={(sn) => {
            setCart((prev) => setLineSerial(prev, serialPick.lineId, sn));
            setSerialPick(null);
          }}
        />
      ) : null}

      {payOpen ? (
        <PaymentModal
          activeMethod={activeMethod}
          cart={cart}
          cashAmount={cashAmount}
          cashChange={cashChange}
          cashInput={cashInput}
          methods={paymentMethods}
          onAdd={addPaymentEntry}
          onCashInput={setCashInput}
          onClose={() => setPayOpen(false)}
          onConfirm={confirmPayment}
          onRemove={(i) => setSplit((prev) => removeSplitEntryAt(prev, i))}
          onSelect={setActiveMethod}
          split={split}
          total={totals.total}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 細件 UI
// ─────────────────────────────────────────────────────────────

function splitPaidTotalSafe(entries: readonly SplitPaymentEntry[]): number {
  return round2((entries ?? []).reduce((s, e) => s + (Number(e.amount) || 0), 0));
}

function cartHasAdjustment(lines: readonly RetailCartLine[]): boolean {
  return lines.some((l) => lineHasManualAdjustment(l));
}

function Tag({ children, tone }: { children: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    cyan: "bg-cyan-50 text-cyan-700",
    violet: "bg-violet-50 text-violet-700",
    amber: "bg-amber-50 text-amber-700",
    orange: "bg-orange-50 text-orange-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tones[tone] ?? tones.slate}`}>
      {children}
    </span>
  );
}

function QtyBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 text-[15px] font-bold text-slate-700 hover:bg-slate-50"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Row({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={strong ? "font-bold text-slate-900" : "text-slate-600"}>{label}</span>
      <span
        className={`font-semibold tabular-nums ${
          tone === "warn" ? "text-orange-700" : strong ? "text-[16px] font-extrabold text-orange-600" : "text-slate-800"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ToastBar({ toast }: { toast: Toast }) {
  const tones = {
    ok: "bg-emerald-600",
    err: "bg-rose-600",
    info: "bg-slate-800",
  } as const;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 md:bottom-8">
      <div className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${tones[toast.tone]}`}>
        {toast.text}
      </div>
    </div>
  );
}

function Modal({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 md:items-center md:p-6">
      <div className="max-h-[92dvh] w-full max-w-[560px] overflow-y-auto rounded-t-3xl bg-white p-4 md:rounded-3xl">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-bold">{title}</h2>
          <button
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-[14px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function VariantPicker({
  product,
  onPick,
  onClose,
}: {
  product: RetailProduct;
  onPick: (v: RetailVariant) => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} title={`揀變體 · ${product.name}`}>
      <div className="grid grid-cols-2 gap-2">
        {(product.variants ?? [])
          .filter((v) => v.isActive !== false)
          .map((v) => (
            <button
              key={v.id}
              className="flex min-h-[52px] flex-col justify-between rounded-xl border border-slate-200 p-3 text-left hover:border-orange-300 hover:bg-orange-50/40 disabled:opacity-40"
              disabled={v.stockQty != null && v.stockQty <= 0}
              onClick={() => onPick(v)}
              type="button"
            >
              <span className="text-[13px] font-semibold">{v.label}</span>
              <span className="mt-1 text-[11px] text-slate-500">
                {money(v.price ?? product.price)} · 存 {v.stockQty ?? "-"}
              </span>
            </button>
          ))}
      </div>
    </Modal>
  );
}

function WeightPad({
  product,
  onConfirm,
  onClose,
}: {
  product: RetailProduct;
  onConfirm: (kg: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const kg = Number(value);
  const valid = Number.isFinite(kg) && kg > 0;
  const unit = priceOf(product);

  return (
    <Modal onClose={onClose} title={`稱重 · ${product.name}`}>
      <div className="rounded-xl bg-slate-50 p-3">
        <div className="text-[11px] font-semibold text-slate-500">輸入重量（kg）</div>
        <div className="mt-1 text-[26px] font-extrabold tabular-nums">{value || "0"}</div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((k) => (
          <button
            key={k}
            className="min-h-[52px] rounded-xl border border-slate-300 text-[18px] font-bold text-slate-800 hover:bg-slate-50"
            onClick={() => setValue((v) => (k === "⌫" ? v.slice(0, -1) : `${v}${k}`))}
            type="button"
          >
            {k}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-[13px] font-semibold">
        <span className="text-slate-500">
          單價 {money(unit)} / {product.unit}
        </span>
        <span className="text-[17px] font-extrabold text-orange-600">
          {valid ? money(round2(kg * unit)) : "$0.00"}
        </span>
      </div>
      <button
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3.5 text-[15px] font-bold text-white disabled:bg-slate-300"
        disabled={!valid}
        onClick={() => onConfirm(Math.round(kg * 1000) / 1000)}
        type="button"
      >
        加入購物車
      </button>
    </Modal>
  );
}

function SerialPad({ onConfirm, onClose }: { onConfirm: (sn: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Modal onClose={onClose} title="登記序號 / IMEI">
      <input
        autoFocus
        className="w-full rounded-xl border border-slate-300 px-3 py-3 text-[14px] outline-none focus:border-orange-400"
        onChange={(e) => setValue(e.target.value)}
        placeholder="掃入或輸入序號"
        value={value}
      />
      <button
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3.5 text-[15px] font-bold text-white disabled:bg-slate-300"
        disabled={!value.trim()}
        onClick={() => onConfirm(value.trim())}
        type="button"
      >
        確定
      </button>
    </Modal>
  );
}

function PaymentModal({
  total,
  methods,
  split,
  activeMethod,
  cashInput,
  cashAmount,
  cashChange,
  onSelect,
  onAdd,
  onCashInput,
  onRemove,
  onConfirm,
  onClose,
  cart,
}: {
  total: number;
  methods: RetailPaymentMethod[];
  split: SplitPaymentEntry[];
  activeMethod: RetailPaymentMethod | null;
  cashInput: string;
  cashAmount: number;
  cashChange: number;
  cart: readonly RetailCartLine[];
  onSelect: (m: RetailPaymentMethod) => void;
  onAdd: (m: RetailPaymentMethod) => void;
  onCashInput: (v: string) => void;
  onRemove: (i: number) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const remaining = splitRemaining(total, split);
  const settled = isSplitSettled(total, split);
  const check = validateSplitPayment(total, split);

  return (
    <Modal onClose={onClose} title="結帳">
      <div className="rounded-2xl bg-orange-50 p-4">
        <div className="text-[11px] font-semibold text-orange-700">應收總額</div>
        <div className="mt-1 text-[30px] font-extrabold tabular-nums text-orange-900">{money(total)}</div>
        {!settled ? (
          <div className="mt-1 text-[11.5px] font-semibold text-orange-700">
            尚欠 {money(remaining)} · 收款未完成
          </div>
        ) : (
          <div className="mt-1 text-[11.5px] font-semibold text-emerald-700">已收足</div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[12px] font-bold text-slate-700">付款方式</div>
        {methods.length === 0 ? (
          <p className="rounded-xl bg-amber-50 p-3 text-[12px] font-semibold text-amber-800">
            未設定付款方式 → 去設備設置加入（或者舊設定嘅自由文字會自動轉換）
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {methods.map((m) => (
              <button
                key={m.id}
                className={`min-h-[52px] rounded-xl border px-2 py-3 text-[13px] font-bold ${
                  activeMethod?.id === m.id
                    ? "border-orange-500 bg-orange-50 text-orange-700"
                    : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => {
                  onSelect(m);
                  onAdd(m);
                }}
                type="button"
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeMethod?.kind === "cash" ? (
        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <label className="text-[11.5px] font-semibold text-slate-600">
            顧客付現金（實收）
          </label>
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[15px] tabular-nums"
            inputMode="decimal"
            onChange={(e) => onCashInput(e.target.value)}
            placeholder="例如 500"
            value={cashInput}
          />
          {cashAmount > 0 ? (
            <div className="mt-2 flex items-center justify-between text-[12.5px] font-semibold">
              <span className="text-slate-500">找零</span>
              <span className="text-[15px] font-extrabold text-slate-900">{money(cashChange)}</span>
            </div>
          ) : null}
          <p className="mt-1 text-[11px] text-slate-400">
            輸入實收之後，撳上面「{activeMethod.label}」就會加入呢一筆並計找零。
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="mb-2 text-[12px] font-bold text-slate-700">
          已收款項{split.length > 0 ? ` · ${describeSplitSummary(split)}` : ""}
        </div>
        {split.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-3 text-[12px] text-slate-500">未加入任何收款</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            {split.map((e, i) => (
              <div
                key={`${e.methodId}-${i}`}
                className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold">{e.label}</div>
                  {e.change != null && e.change > 0 ? (
                    <div className="text-[10.5px] text-slate-400">找零 {money(e.change)}</div>
                  ) : null}
                </div>
                <span className="text-[13px] font-bold tabular-nums">{money(e.amount)}</span>
                <button
                  className="rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-400 hover:bg-slate-100"
                  onClick={() => onRemove(i)}
                  type="button"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3">
          <MiniStat label="已收" value={money(splitPaidTotalSafe(split))} />
          <MiniStat label="尚欠" value={money(remaining)} tone={remaining > 0 ? "warn" : undefined} />
          <MiniStat label="找零" value={money(splitChangeDue(split))} />
        </div>
        {!check.ok ? (
          <p className="mt-2 text-[11.5px] font-semibold text-rose-600">{check.errors.join(" · ")}</p>
        ) : null}
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
          disabled={!check.ok}
          onClick={onConfirm}
          type="button"
        >
          {check.ok ? `完成結帳 · ${money(total)}` : `尚欠 ${money(remaining)}`}
        </button>
      </div>

      <p className="mt-2 text-center text-[10.5px] text-slate-400">
        {cart.length} 項 · 完成後即時扣庫存並上雲
      </p>
    </Modal>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold text-slate-500">{label}</div>
      <div className={`mt-0.5 text-[15px] font-bold tabular-nums ${tone === "warn" ? "text-rose-600" : "text-slate-900"}`}>
        {value}
      </div>
    </div>
  );
}
