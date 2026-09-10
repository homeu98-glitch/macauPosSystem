"use client";

import { useEffect, useRef, useState } from "react";

import { kioskT, useKioskOrder } from "@/lib/use-kiosk-order";
import { MenuItem } from "@/lib/types";
import { OrderSummaryCard, money2 } from "@/components/kiosk/order-summary-card";
import { SpecSheet } from "@/components/kiosk/spec-sheet";

// 手機介面（客掃枱 QR 開 /menu）：外賣 App 風，與 kiosk 平板 /order 完全分家

export default function MenuPage() {
  const {
    hydrated,
    menuLoading,
    menuUnavailable,
    bootstrap,
    displayStoreName,
    language,
    mode,
    tableName,
    needsBinding,
    activeCategory,
    setActiveCategory,
    cart,
    setCart,
    totals,
    orderNote,
    setOrderNote,
    soldoutIds,
    categoryItems,
    specDraft,
    setSpecDraft,
    pushLine,
    changeQty,
    submittedOrder,
    activeTableOrder,
    addToOrder,
    submitting,
    error,
    orderSyncPending,
    pendingSyncCount,
    placeOrder,
    started,
    startOrdering,
    returnToHome,
    ordering,
  } = useKioskOrder();

  const t = (key: string) => kioskT(language, key);

  // 手機專屬 UI state
  const [cartOpen, setCartOpen] = useState(false);
  const cartSheetRef = useRef<HTMLDivElement | null>(null);

  const totalCount = cart.reduce((s, l) => s + l.quantity, 0);
  const cartCountByItem = (id: string) => cart.filter((l) => l.menuItemId === id).reduce((s, l) => s + l.quantity, 0);
  const firstLineId = (id: string) => cart.find((l) => l.menuItemId === id)?.lineId;

  // 購物車 sheet 無障礙（P3-2）：焦點 + Esc 關閉
  useEffect(() => {
    if (!cartOpen) return;
    cartSheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCartOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cartOpen]);

  // 手機：有規格（必選 / 可選）都開規格 sheet；完全無規格先直接加
  function handleAdd(item: MenuItem) {
    if (soldoutIds.has(item.id) || item.isMarketPrice) return;
    if ((item.specGroups ?? []).length > 0) {
      setSpecDraft({ item, specs: [], priceDelta: 0 });
      return;
    }
    pushLine({ menuItemId: item.id, name: item.name, price: item.price, printerGroup: item.printerGroup });
  }

  /**
   * 落單（P0-1 修復）：**等結果**，成功先閂購物車；失敗保留 sheet 顯示錯誤 + 可直接重試。
   * 舊版 `void placeOrder(); setCartOpen(false);` —— 未等結果就閂 sheet，
   * 而錯誤訊息只喺已關閉嘅 sheet 內部渲染 → 客人以為落咗單，實際上冇（靜默丟單）。
   */
  async function handlePlaceOrder() {
    const ok = await placeOrder();
    if (ok) setCartOpen(false);
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

  // ── 餐牌未開放（P1-5）：未知店 / 未同步 / 離線無 cache 一律唔露示範餐牌，亦唔畀落單 ──
  if (menuUnavailable) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center bg-stone-50 p-6 text-center">
        <div className="mb-4 text-6xl">🧾</div>
        <h1 className="mb-2 text-xl font-bold text-stone-900">{t("menuUnavailableTitle")}</h1>
        <p className="max-w-sm text-sm text-stone-500">{t("menuUnavailableBody")}</p>
      </main>
    );
  }

  // ── Landing：未「開始點餐」先顯示 landing page（唔用點餐介面做主頁）──
  if (!started) {
    return (
      <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center bg-stone-50 p-6 text-center">
        <div className="mb-6 text-7xl">🍽️</div>
        <h1 className="mb-2 text-2xl font-bold text-stone-900">{displayStoreName}</h1>
        <p className="mb-8 text-sm text-stone-500">掃描枱上 QR，手機輕鬆點餐</p>
        <button
          onClick={startOrdering}
          className="w-full rounded-2xl bg-orange-500 py-4 text-lg font-semibold text-white active:scale-[0.98]"
        >
          開始點餐
        </button>
      </main>
    );
  }

  // ── 落單成功確認頁：顯示下完單內容 + 加單（返回/完成唔會再顯示完整餐牌）──
  if (submittedOrder) {
    const isDineIn = mode === "dine_in";
    return (
      <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden bg-stone-50">
        <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-6 py-8 text-center">
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-5xl">✅</div>
        <h1 className="mb-1 text-2xl font-bold text-stone-900">{t("thanks")}</h1>
        <p className="mb-6 text-sm text-stone-500">{t("payAtCounter")}</p>
        {/* P1-4：網絡抖動時訂單入咗本地待同步隊列，唔可以講「已同步」講大話 */}
        {orderSyncPending && (
          <p className="mb-6 rounded-xl bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800" role="status">
            {t("syncPending")}
          </p>
        )}
        <div className="w-full rounded-3xl bg-white p-6 shadow-sm">
          <div className="mb-1 text-xs text-stone-400">{t("orderNo")}</div>
          <div className="mb-4 text-4xl font-extrabold tracking-tight text-stone-900">{submittedOrder.localOrderNo}</div>
          <div className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-3 py-1 text-sm font-semibold text-orange-600">
            {isDineIn ? `${t("dineIn")} · ${t("table")} ${tableName}` : tableName}
          </div>
        </div>

        {/* 落單內容（本單明細）：所有模式都顯示，按返回只會見到呢個 + 加單 */}
        <div className="mt-5 w-full text-left">
          <OrderSummaryCard order={submittedOrder} title={t("tableOrderTitle")} />
        </div>

        {/* 加單：堂食先准（手機掃碼 = 枱號 → dine_in，故一定顯示）；快餐模式唔准加單 */}
        {isDineIn && (
          <button
            onClick={addToOrder}
            className="mt-4 w-full rounded-2xl bg-orange-500 py-3.5 text-lg font-semibold text-white active:scale-[0.98]"
          >
            {t("addOrder")}
          </button>
        )}

        {/* 完成：返回 landing（唔會再顯示完整餐牌，下次落單先「開始點餐」） */}
        <button
          onClick={returnToHome}
          className="mt-2 w-full py-2.5 text-sm text-stone-400"
        >
          {t("done")}
        </button>
        </div>
        </div>
      </main>
    );
  }

  // ── 已落單枱「明細」介面（鎖定餐牌，必須按加單先入點餐）──
  if (activeTableOrder && !ordering) {
    return (
      <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden bg-stone-50">
        <div className="flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-6 py-8 text-center">
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-amber-100 text-5xl">🧾</div>
        <h1 className="mb-1 text-2xl font-bold text-stone-900">已落單</h1>
        <p className="mb-6 text-sm text-stone-500">如需加點，請按「加單」進入點餐</p>
        <div className="w-full rounded-3xl bg-white p-6 shadow-sm">
          <div className="mb-1 text-xs text-stone-400">{t("orderNo")}</div>
          <div className="mb-4 text-4xl font-extrabold tracking-tight text-stone-900">{activeTableOrder.localOrderNo}</div>
          <div className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-3 py-1 text-sm font-semibold text-orange-600">
            {t("dineIn")} · {t("table")} {tableName}
          </div>
        </div>
        <div className="mt-5 w-full text-left">
          <OrderSummaryCard order={activeTableOrder} title={t("tableOrderTitle")} />
        </div>
        <button
          onClick={addToOrder}
          className="mt-4 w-full rounded-2xl bg-orange-500 py-3.5 text-lg font-semibold text-white active:scale-[0.98]"
        >
          {t("addOrder")}
        </button>
        <button
          onClick={returnToHome}
          className="mt-2 w-full py-2.5 text-sm text-stone-400"
        >
          {t("done")}
        </button>
        </div>
        </div>
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

      {/* 待同步提示（P1-4）：之前落單入咗隊列仲未補推完 */}
      {pendingSyncCount > 0 && (
        <div className="mx-4 mt-2 rounded-xl bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          {t("syncPending")}（{pendingSyncCount}）
        </div>
      )}

      {activeTableOrder && (
        <div className="mx-4 mt-2">
          <OrderSummaryCard order={activeTableOrder} title={t("tableOrderTitle")} />
        </div>
      )}

      {/* 菜單：單欄 list */}
      <section className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {categoryItems.map((item) => {
          const sold = soldoutIds.has(item.id);
          // P1-3b 時價菜：客人端唔可以提供一個可以係 0 元嘅價（舊版會 0 元落單）。
          const marketPrice = Boolean(item.isMarketPrice);
          const blocked = sold || marketPrice;
          const qty = cartCountByItem(item.id);
          const lineId = firstLineId(item.id);
          return (
            <div
              key={item.id}
              className={`flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ${
                blocked ? "opacity-60" : ""
              }`}
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Ledger 圖片係任意外部域名，唔適合 next/image 固定 remotePatterns
                <img
                  src={item.image}
                  alt={item.name}
                  width={56}
                  height={56}
                  decoding="async"
                  className="h-14 w-14 shrink-0 rounded-xl object-cover"
                  loading="lazy"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold text-stone-900">{item.name}</div>
                <div className="mt-1 text-sm font-semibold text-orange-600">
                  {marketPrice ? `${t("marketPrice")} · ${t("marketPriceHint")}` : `MOP ${money2(item.price)}`}
                </div>
              </div>

              {blocked ? (
                // P2-1：售罄項**保留**喺菜單（客人理解為暫時缺貨，可以轉點其他菜），
                // 灰化 + 標籤。舊版 filter 走售罄項 → 呢個分支係死碼。
                <span className="shrink-0 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-500">
                  {sold ? t("soldout") : t("marketPrice")}
                </span>
              ) : qty > 0 && lineId ? (
                <div className="flex shrink-0 items-center gap-2.5">
                  <button
                    onClick={() => changeQty(lineId, -1)}
                    aria-label={`${item.name} 減少一件`}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-lg text-stone-700 active:scale-90"
                  >
                    −
                  </button>
                  <span className="w-5 text-center text-[15px] font-semibold text-stone-900">{qty}</span>
                  <button
                    onClick={() => handleAdd(item)}
                    aria-label={`${item.name} 增加一件`}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-lg text-white active:scale-90"
                  >
                    +
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleAdd(item)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xl text-white active:scale-90"
                  aria-label={`${t("add")} ${item.name}`}
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
              <span className="text-sm font-medium">MOP {money2(totals.total)}</span>
            </span>
            <span className="text-base font-semibold">{t("viewCart")}</span>
          </button>
        </div>
      )}

      {/* 購物車 bottom sheet */}
      {cartOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/40"
          onClick={() => setCartOpen(false)}
        >
          <div
            ref={cartSheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t("cart")}
            className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-4 pb-6 outline-none"
            onClick={(e) => e.stopPropagation()}
          >
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
              aria-label={t("note")}
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
                    {/* P2-3：統一 2 位小數（舊版 `line.price * line.quantity` 冇 toFixed） */}
                    <div className="mt-0.5 text-xs text-orange-600">MOP {money2(line.price * line.quantity)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => changeQty(line.lineId, -1)}
                      aria-label={`${line.name} 減少一件`}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-200 text-stone-700 active:scale-90"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-sm font-medium text-stone-900">{line.quantity}</span>
                    <button
                      onClick={() => changeQty(line.lineId, 1)}
                      aria-label={`${line.name} 增加一件`}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-white active:scale-90"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* P1-3：小計 + 稅 / 服務費明細，同寫入訂單嘅金額同源 */}
            <div className="mb-1 flex items-center justify-between text-sm text-stone-600">
              <span>{t("subtotal")}</span>
              <span>MOP {money2(totals.subtotal)}</span>
            </div>
            {totals.serviceChargeAmount > 0 && (
              <div className="mb-1 flex items-center justify-between text-sm text-stone-600">
                <span>{t("service")}</span>
                <span>MOP {money2(totals.serviceChargeAmount)}</span>
              </div>
            )}
            {totals.taxAmount > 0 && (
              <div className="mb-1 flex items-center justify-between text-sm text-stone-600">
                <span>{t("tax")}</span>
                <span>MOP {money2(totals.taxAmount)}</span>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between text-base font-bold text-stone-900">
              <span>{t("total")}</span>
              <span>MOP {money2(totals.total)}</span>
            </div>

            {/* P0-1：錯誤必須喺 sheet **仍然打開** 嘅時候顯示，並且用 aria-live 播報 */}
            <div aria-live="assertive" role="alert">
              {error && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
            </div>

            <button
              onClick={() => void handlePlaceOrder()}
              disabled={cart.length === 0 || submitting}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-lg font-semibold text-white disabled:opacity-50 active:scale-[0.99]"
            >
              {submitting ? t("submitting") : error ? t("retryPlace") : t("place")}
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

      {/* 規格 bottom sheet（共用元件，P2-6） */}
      {specDraft && (
        <SpecSheet
          draft={specDraft}
          t={t}
          variant="mobile"
          onClose={() => setSpecDraft(null)}
          onChangeSpecs={(specs, priceDelta) => setSpecDraft({ ...specDraft, specs, priceDelta })}
          onConfirm={() => {
            // 守門：售罄 / 時價菜唔准入（P1-2 / P1-3b）
            if (!soldoutIds.has(specDraft.item.id) && !specDraft.item.isMarketPrice) {
              pushLine({
                menuItemId: specDraft.item.id,
                name: specDraft.item.name,
                price: specDraft.item.price + specDraft.priceDelta,
                printerGroup: specDraft.item.printerGroup,
                selectedSpecs: specDraft.specs,
              });
            }
            setSpecDraft(null);
          }}
        />
      )}
    </main>
  );
}
