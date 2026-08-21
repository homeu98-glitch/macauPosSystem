"use client";

import { useState } from "react";

import { KIOSK_I18N, useKioskOrder } from "@/lib/use-kiosk-order";
import { KioskLanguage } from "@/lib/kiosk-order";
import { OrderItem } from "@/lib/types";

// kiosk 平板介面：3 欄佈局完全不變，邏輯抽去 useKioskOrder（與手機 /menu 共用）
const I18N = KIOSK_I18N;

export default function OrderPage() {
  const t = (key: string) => I18N[language][key] ?? key;

  const {
    hydrated,
    bootstrap,
    language,
    setLanguage,
    persistLanguage,
    displayStoreName,
    mode,
    tableName,
    needsBinding,
    activeCategory,
    setActiveCategory,
    cart,
    cartTotal,
    orderNote,
    setOrderNote,
    quickType,
    setQuickType,
    soldoutIds,
    categoryItems,
    specDraft,
    setSpecDraft,
    addItem,
    pushLine,
    changeQty,
    submittedOrder,
    setSubmittedOrder,
    resumedOrder,
    submitting,
    error,
    placeOrder,
    rebindStore,
  } = useKioskOrder();

  // kiosk 專屬 UI state：設定（綁店）彈窗開關
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── 載入中 / 未綁店閘門 ──
  if (!hydrated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-400">
        載入中…
      </main>
    );
  }

  if (needsBinding) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-4 text-6xl">🔒</div>
        <h1 className="mb-2 text-xl font-bold text-slate-900">此裝置尚未綁定店鋪</h1>
        <p className="mb-6 max-w-sm text-sm text-slate-500">
          掃碼點餐機需要先以商戶帳號登入，綁定所屬店鋪後先可以使用。
        </p>
        <button
          onClick={rebindStore}
          className="w-full max-w-xs rounded-xl bg-orange-500 py-3 text-lg font-semibold text-white"
        >
          前往登入綁店
        </button>
      </main>
    );
  }

  // ── 確認頁 ──
  if (submittedOrder) {
    const isPickup = submittedOrder.tableId === "counter";
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-5 flex h-24 w-24 items-center justify-center rounded-full bg-emerald-100 text-7xl">✅</div>
        <h1 className="mb-3 text-4xl font-bold text-slate-900">{t("thanks")}</h1>
        <div className="w-full rounded-3xl bg-white p-8 shadow-sm">
          <div className="mb-2 text-base text-slate-500">{t("orderNo")}</div>
          <div className="mb-4 text-5xl font-bold text-slate-900">{submittedOrder.localOrderNo}</div>
          <div className="mb-1 text-base text-slate-500">
            {mode === "dine_in" ? t("table") : t("pickupNo")}
          </div>
          <div className="text-2xl font-semibold text-slate-900">{submittedOrder.tableName}</div>
        </div>
        <p className="mt-5 text-lg text-slate-600">{t("payAtCounter")}</p>
        <button
          onClick={() => setSubmittedOrder(null)}
          className="mt-7 w-full rounded-2xl bg-orange-500 py-4 text-xl font-semibold text-white"
        >
          {t("newOrder")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-7xl flex-col bg-slate-50">
      {/* 頂欄 */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow-sm">
        <div>
          <div className="text-lg font-bold text-slate-900">
            {displayStoreName}
          </div>
          <div className="text-xs text-slate-500">
            {mode === "dine_in" ? `${t("dineIn")} · ${t("table")} ${tableName}` : t("pickup")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-slate-200 text-xs">
            {(["zh-HK", "pt", "en"] as KioskLanguage[]).map((lng) => (
              <button
                key={lng}
                onClick={() => setLanguage(lng)}
                className={`px-2 py-1 ${language === lng ? "bg-orange-500 text-white" : "bg-white text-slate-600"}`}
              >
                {lng === "zh-HK" ? "中" : lng === "pt" ? "PT" : "EN"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
          >
            {t("settings")}
          </button>
        </div>
      </header>

      {resumedOrder && (
        <div className="bg-amber-50 px-4 py-2 text-center text-xs text-amber-700">
          {t("resumeHint")}
        </div>
      )}

      <div className="flex flex-1">
        {/* 分類 */}
        <nav className="w-28 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-2 sm:w-32">
          {bootstrap.categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`mb-2 w-full rounded-lg px-2 py-3 text-sm font-medium ${
                activeCategory === cat.id ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </nav>

        {/* 菜單 */}
        <section className="flex-1 overflow-y-auto p-3 sm:p-4">
          <h2 className="mb-3 text-base font-semibold text-slate-500">{t("welcome")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {categoryItems.map((item) => {
              const sold = soldoutIds.has(item.id);
              return (
                <button
                  key={item.id}
                  disabled={sold}
                  onClick={() => addItem(item)}
                  className={`flex flex-col rounded-2xl bg-white p-4 text-left shadow-sm ${
                    sold ? "opacity-50" : "active:scale-95"
                  }`}
                >
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Ledger 圖片係任意外部域名，唔適合 next/image 固定 remotePatterns
                    <img
                      src={item.image}
                      alt={item.name}
                      className="mb-2 h-20 w-full rounded-xl object-cover"
                      loading="lazy"
                    />
                  ) : null}
                  <span className="text-base font-semibold text-slate-900">{item.name}</span>
                  <span className="mt-1 text-sm text-orange-600">MOP {item.price}</span>
                  {sold && <span className="mt-1 text-xs text-red-500">{t("soldout")}</span>}
                </button>
              );
            })}
            {categoryItems.length === 0 && (
              <div className="col-span-full py-10 text-center text-sm text-slate-400">—</div>
            )}
          </div>
        </section>

        {/* 購物車 */}
        <aside className="flex w-72 shrink-0 flex-col border-l border-slate-200 bg-white p-3 sm:w-80 lg:w-96">
          <div className="mb-2 text-sm font-semibold text-slate-700">{t("cart")}</div>
          {mode === "quick" && (
            <div className="mb-3 flex gap-2 text-xs">
              <button
                onClick={() => setQuickType("pickup")}
                className={`flex-1 rounded-lg py-2 ${quickType === "pickup" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {t("pickup")}
              </button>
              <button
                onClick={() => setQuickType("delivery")}
                className={`flex-1 rounded-lg py-2 ${quickType === "delivery" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {t("delivery")}
              </button>
            </div>
          )}
          <div className="flex-1 space-y-2 overflow-y-auto">
            {cart.length === 0 && <div className="py-8 text-center text-sm text-slate-400">{t("empty")}</div>}
            {cart.map((line) => (
              <div key={line.lineId} className="rounded-lg bg-slate-50 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900">{line.name}</span>
                  <span className="text-sm text-slate-600">MOP {line.price * line.quantity}</span>
                </div>
                {(line.selectedSpecs?.length ?? 0) > 0 && (
                  <div className="text-xs text-slate-400">
                    {line.selectedSpecs!.map((s) => s.optionLabel).join(" / ")}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <button onClick={() => changeQty(line.lineId, -1)} className="h-7 w-7 rounded bg-slate-200 text-slate-700">
                    −
                  </button>
                  <span className="text-sm">{line.quantity}</span>
                  <button onClick={() => changeQty(line.lineId, 1)} className="h-7 w-7 rounded bg-slate-200 text-slate-700">
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          <textarea
            value={orderNote}
            onChange={(e) => setOrderNote(e.target.value)}
            placeholder={t("notePlaceholder")}
            className="mt-2 h-14 w-full resize-none rounded-lg border border-slate-200 p-2 text-xs text-slate-700"
          />

          <div className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>{t("subtotal")}</span>
              <span>MOP {cartTotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-slate-900">
              <span>{t("total")}</span>
              <span>MOP {cartTotal.toFixed(2)}</span>
            </div>
          </div>

          {error && <div className="mt-2 text-xs text-red-500">{error}</div>}

          <button
            onClick={placeOrder}
            disabled={cart.length === 0 || submitting}
            className="mt-3 w-full rounded-xl bg-orange-500 py-3 text-lg font-semibold text-white disabled:opacity-50"
          >
            {submitting ? t("submitting") : t("place")}
          </button>
        </aside>
      </div>

      {/* 規格彈窗 */}
      {specDraft && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40" onClick={() => setSpecDraft(null)}>
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-base font-semibold text-slate-900">{specDraft.item.name}</div>
            {specDraft.item.specGroups?.map((group) => (
              <div key={group.id} className="mb-3">
                <div className="mb-1 text-sm font-medium text-slate-700">
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
                        className={`rounded-lg border px-3 py-1 text-sm ${
                          selected ? "border-orange-500 bg-orange-50 text-orange-600" : "border-slate-200 text-slate-600"
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
              className="mt-2 w-full rounded-xl bg-orange-500 py-3 font-semibold text-white disabled:opacity-50"
            >
              {t("add")}
            </button>
          </div>
        </div>
      )}

      {/* 設定（綁店）彈窗 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setSettingsOpen(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-base font-semibold text-slate-900">裝置設定</div>
            <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
              已綁定店鋪：<span className="font-semibold text-slate-900">{displayStoreName}</span>
            </div>
            <label className="mb-1 block text-xs text-slate-500">{t("language")}</label>
            <select
              value={language}
              onChange={(e) => persistLanguage(e.target.value as KioskLanguage)}
              className="mb-4 w-full rounded-lg border border-slate-200 p-2 text-sm"
            >
              <option value="zh-HK">中文 (繁)</option>
              <option value="pt">Português</option>
              <option value="en">English</option>
            </select>
            <button
              onClick={rebindStore}
              className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white"
            >
              重新綁定（換店）
            </button>
            <button
              onClick={() => setSettingsOpen(false)}
              className="mt-2 w-full rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
