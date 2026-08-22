"use client";

import { useState } from "react";

import { KIOSK_I18N, useKioskOrder } from "@/lib/use-kiosk-order";
import { MenuItem, OrderItem } from "@/lib/types";

// 手機介面（客掃枱 QR 開 /menu）：外賣 App 風，與 kiosk 平板 /order 完全分家
const I18N = KIOSK_I18N;

export default function MenuPage() {
  const t = (key: string) => I18N[language][key] ?? key;

  const {
    hydrated,
    menuLoading,
    bootstrap,
    displayStoreName,
    mode,
    tableName,
    needsBinding,
    activeCategory,
    setActiveCategory,
    cart,
    setCart,
    cartTotal,
    orderNote,
    setOrderNote,
    soldoutIds,
    categoryItems,
    specDraft,
    setSpecDraft,
    pushLine,
    changeQty,
    submittedOrder,
    setSubmittedOrder,
    resumedOrder,
    submitting,
    error,
    placeOrder,
  } = useKioskOrder();

  // 手機專屬 UI state
  const [cartOpen, setCartOpen] = useState(false);

  const totalCount = cart.reduce((s, l) => s + l.quantity, 0);
  const cartCountByItem = (id: string) => cart.filter((l) => l.menuItemId === id).reduce((s, l) => s + l.quantity, 0);
  const firstLineId = (id: string) => cart.find((l) => l.menuItemId === id)?.lineId;

  // 手機：有規格（必選 / 可選）都開規格 sheet；完全無規格先直接加
  function handleAdd(item: MenuItem) {
    if (soldoutIds.has(item.id)) return;
    if ((item.specGroups ?? []).length > 0) {
      setSpecDraft({ item, specs: [], priceDelta: 0 });
      return;
    }
    pushLine({ menuItemId: item.id, name: item.name, price: item.price, printerGroup: item.printerGroup });
  }

  // ── 載入中（含手機攞所屬店 menu）──
  if (!hydrated || menuLoading) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-stone-50 text-sm text-stone-400">
        載入中…
      </main>
    );
  }

  // ── 無掃碼參數（唔應該直接開 /menu）──
  if (needsBinding) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center bg-stone-50 p-6 text-center">
        <div className="mb-4 text-6xl">📷</div>
        <h1 className="mb-2 text-xl font-bold text-stone-900">請掃描枱上 QR 點餐</h1>
        <p className="max-w-sm text-sm text-stone-500">
          手機點餐需由店內枱號 QR 開啟，請掃描枱面貼紙後再點餐。
        </p>
      </main>
    );
  }

  // ── 落單成功確認頁 ──
  if (submittedOrder) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center bg-stone-50 p-6 text-center">
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-5xl">✅</div>
        <h1 className="mb-1 text-2xl font-bold text-stone-900">{t("thanks")}</h1>
        <p className="mb-6 text-sm text-stone-500">{t("payAtCounter")}</p>
        <div className="w-full rounded-3xl bg-white p-6 shadow-sm">
          <div className="mb-1 text-xs text-stone-400">{t("orderNo")}</div>
          <div className="mb-4 text-4xl font-extrabold tracking-tight text-stone-900">{submittedOrder.localOrderNo}</div>
          <div className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-3 py-1 text-sm font-semibold text-orange-600">
            {mode === "dine_in" ? `${t("dineIn")} · ${t("table")} ${tableName}` : tableName}
          </div>
        </div>
        <button
          onClick={() => {
            setSubmittedOrder(null);
            setCartOpen(false);
          }}
          className="mt-6 w-full rounded-2xl bg-orange-500 py-3.5 text-lg font-semibold text-white active:scale-[0.98]"
        >
          {t("newOrder")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden bg-stone-50">
      {/* 頂欄：店名 + 枱號 + 語言 */}
      <header className="sticky top-0 z-10 shrink-0 bg-white/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="truncate text-lg font-bold text-stone-900">{displayStoreName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-stone-500">
              <span className="rounded-full bg-orange-50 px-2 py-0.5 font-medium text-orange-600">
                {mode === "dine_in" ? `${t("dineIn")} · ${t("table")} ${tableName}` : t("pickup")}
              </span>
            </div>
          </div>
        </div>

        {/* 分類橫向 chips */}
        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {bootstrap.categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition ${
                activeCategory === cat.id
                  ? "bg-stone-900 text-white"
                  : "bg-white text-stone-600 ring-1 ring-stone-200"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </header>

      {resumedOrder && (
        <div className="mx-4 mt-2 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs text-amber-700">
          {t("resumeHint")}
        </div>
      )}

      {/* 菜單：單欄 list */}
      <section className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {categoryItems.map((item) => {
          const sold = soldoutIds.has(item.id);
          const qty = cartCountByItem(item.id);
          const lineId = firstLineId(item.id);
          return (
            <div
              key={item.id}
              className={`flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ${
                sold ? "opacity-60" : ""
              }`}
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Ledger 圖片係任意外部域名，唔適合 next/image 固定 remotePatterns
                <img
                  src={item.image}
                  alt={item.name}
                  className="h-14 w-14 shrink-0 rounded-xl object-cover"
                  loading="lazy"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-stone-900">{item.name}</div>
                <div className="mt-1 text-sm font-semibold text-orange-600">MOP {item.price}</div>
              </div>

              {sold ? (
                <span className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-500">
                  {t("soldout")}
                </span>
              ) : qty > 0 && lineId ? (
                <div className="flex shrink-0 items-center gap-2.5">
                  <button
                    onClick={() => changeQty(lineId, -1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-lg text-stone-700 active:scale-90"
                  >
                    −
                  </button>
                  <span className="w-5 text-center text-[15px] font-semibold text-stone-900">{qty}</span>
                  <button
                    onClick={() => handleAdd(item)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-lg text-white active:scale-90"
                  >
                    +
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleAdd(item)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xl text-white active:scale-90"
                  aria-label={t("add")}
                >
                  +
                </button>
              )}
            </div>
          );
        })}
        {categoryItems.length === 0 && (
          <div className="py-16 text-center text-sm text-stone-400">{t("empty")}</div>
        )}
      </section>

      {/* 底部固定購物車 bar */}
      {cart.length > 0 && (
        <div className="sticky bottom-0 z-10 shrink-0 border-t border-stone-200 bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
          <button
            onClick={() => setCartOpen(true)}
            className="flex w-full items-center justify-between rounded-2xl bg-orange-500 px-4 py-3.5 text-white active:scale-[0.99]"
          >
            <span className="flex items-center gap-2">
              <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-sm">
                🛒
                <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-[11px] font-bold">
                  {totalCount}
                </span>
              </span>
              <span className="text-sm font-medium">MOP {cartTotal.toFixed(2)}</span>
            </span>
            <span className="text-base font-semibold">{t("viewCart")}</span>
          </button>
        </div>
      )}

      {/* 購物車 bottom sheet */}
      {cartOpen && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40" onClick={() => setCartOpen(false)}>
          <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-4 pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-stone-200" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-stone-900">{t("cart")}</h2>
              <button onClick={() => setCartOpen(false)} className="text-sm text-stone-400">
                {t("cancel")}
              </button>
            </div>

            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              className="mb-3 h-14 w-full resize-none rounded-xl border border-stone-200 p-2.5 text-sm text-stone-700"
            />

            <div className="mb-3 max-h-64 space-y-2.5 overflow-y-auto">
              {cart.map((line) => (
                <div key={line.lineId} className="flex items-center gap-3 rounded-xl bg-stone-50 p-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-stone-900">{line.name}</div>
                    {(line.selectedSpecs?.length ?? 0) > 0 && (
                      <div className="truncate text-xs text-stone-400">
                        {line.selectedSpecs!.map((s) => s.optionLabel).join(" / ")}
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-orange-600">MOP {line.price * line.quantity}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => changeQty(line.lineId, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-200 text-stone-700 active:scale-90"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-sm font-medium text-stone-900">{line.quantity}</span>
                    <button
                      onClick={() => changeQty(line.lineId, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-white active:scale-90"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mb-1 flex items-center justify-between text-sm text-stone-600">
              <span>{t("subtotal")}</span>
              <span>MOP {cartTotal.toFixed(2)}</span>
            </div>
            <div className="mb-3 flex items-center justify-between text-base font-bold text-stone-900">
              <span>{t("total")}</span>
              <span>MOP {cartTotal.toFixed(2)}</span>
            </div>

            {error && <div className="mb-2 text-xs text-red-500">{error}</div>}

            <button
              onClick={() => {
                void placeOrder();
                setCartOpen(false);
              }}
              disabled={cart.length === 0 || submitting}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-lg font-semibold text-white disabled:opacity-50 active:scale-[0.99]"
            >
              {submitting ? t("submitting") : t("place")}
            </button>
            <button
              onClick={() => setCart([])}
              className="mt-2 w-full py-2 text-xs text-stone-400"
            >
              {t("clearCart")}
            </button>
          </div>
        </div>
      )}

      {/* 規格 bottom sheet */}
      {specDraft && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40" onClick={() => setSpecDraft(null)}>
          <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-4 pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-stone-200" />
            <h2 className="mb-3 text-lg font-bold text-stone-900">{specDraft.item.name}</h2>
            {specDraft.item.specGroups?.map((group) => (
              <div key={group.id} className="mb-4">
                <div className="mb-1.5 text-sm font-semibold text-stone-700">
                  {group.name}
                  {group.required && <span className="ml-1 text-xs text-red-400">*</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.options.map((opt) => {
                    const selected = specDraft.specs.find((s) => s.groupId === group.id && s.optionId === opt.id);
                    return (
                      <button
                        key={opt.id}
                        onClick={() => {
                          const others = specDraft.specs.filter((s) => s.groupId !== group.id);
                          const nextSpecs: NonNullable<OrderItem["selectedSpecs"]> =
                            group.selectionMode === "single"
                              ? [
                                  ...others,
                                  {
                                    groupId: group.id,
                                    groupName: group.name,
                                    optionId: opt.id,
                                    optionLabel: opt.label,
                                    priceDelta: opt.priceDelta,
                                  },
                                ]
                              : selected
                                ? others
                                : [
                                    ...others,
                                    {
                                      groupId: group.id,
                                      groupName: group.name,
                                      optionId: opt.id,
                                      optionLabel: opt.label,
                                      priceDelta: opt.priceDelta,
                                    },
                                  ];
                          const priceDelta = nextSpecs.reduce((s, x) => s + x.priceDelta, 0);
                          setSpecDraft({ ...specDraft, specs: nextSpecs, priceDelta });
                        }}
                        className={`rounded-full px-3.5 py-1.5 text-sm ${
                          selected
                            ? "bg-orange-500 text-white"
                            : "bg-stone-100 text-stone-600"
                        }`}
                      >
                        {opt.label}
                        {opt.priceDelta ? ` +${opt.priceDelta}` : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button
              disabled={(specDraft.item.specGroups ?? []).filter((g) => g.required).some((g) => !specDraft.specs.find((s) => s.groupId === g.id))}
              onClick={() => {
                pushLine({
                  menuItemId: specDraft.item.id,
                  name: specDraft.item.name,
                  price: specDraft.item.price + specDraft.priceDelta,
                  printerGroup: specDraft.item.printerGroup,
                  selectedSpecs: specDraft.specs,
                });
                setSpecDraft(null);
              }}
              className="mt-1 w-full rounded-2xl bg-orange-500 py-3.5 text-base font-semibold text-white disabled:opacity-50 active:scale-[0.99]"
            >
              {t("addToCart")}
              {specDraft.priceDelta ? ` · MOP ${(specDraft.item.price + specDraft.priceDelta).toFixed(2)}` : ` · MOP ${specDraft.item.price.toFixed(2)}`}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
