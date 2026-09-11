"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { kioskT, useKioskOrder } from "@/lib/use-kiosk-order";
import { loadKioskMode, saveKioskMode } from "@/lib/kiosk-order";
import { KioskPrinterPanel } from "@/components/kiosk-printer-panel";
import { OrderSummaryCard, money2 } from "@/components/kiosk/order-summary-card";
import { SpecSheet } from "@/components/kiosk/spec-sheet";

// 自助點餐機（店內平板）介面：3 欄佈局完全不變。
//
// ⚠️ 2026-09-10（需求 2）：手機 /menu（客人掃碼）**已經同呢頁完全分家** ——
// 嗰邊用 `useScanOrder()`（台號為本、冇單號、冇「完成」），呢邊用 `useKioskOrder()`
// （有單號、落單後本機印小票、成功頁倒數返主頁）。兩者只共用中性基礎設施（core）。

export default function OrderPage() {
  const router = useRouter();

  const {
    hydrated,
    menuLoading,
    menuUnavailable,
    bootstrap,
    displayStoreName,
    language,
    mode,
    storeId,
    tableName,
    needsBinding,
    activeCategory,
    setActiveCategory,
    cart,
    totals,
    orderNote,
    setOrderNote,
    soldoutIds,
    categoryItems,
    specDraft,
    setSpecDraft,
    addItem,
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
    rebindStore,
    started,
    startOrdering,
    returnToHome,
  } = useKioskOrder();

  const t = (key: string) => kioskT(language, key);

  // kiosk 專屬 UI state：設定（綁店）彈窗開關
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 裝置模式：部機係咪固定做自助點餐機（`loadKioskMode()`）。
  // SSR 一定係 false（冇 localStorage），所以放 useEffect 讀，避免 hydration mismatch。
  const [kioskMode, setKioskMode] = useState(false);
  useEffect(() => {
    setKioskMode(loadKioskMode());
  }, []);

  // 職員退出自助點餐模式：熄咗旗標再返收銀台（唔係「換店」，唔使重新登入）
  function exitKioskMode() {
    saveKioskMode(false);
    setKioskMode(false);
    router.replace("/");
  }

  // kiosk 落單成功：5 秒倒數自動返回主頁（loading 狀態）
  const submittedRef = useRef(submittedOrder);
  const returnHomeRef = useRef(returnToHome);
  // ⚠️ 唔可以喺 render 期間寫 ref（react-hooks/refs）。用 effect 同步。
  useEffect(() => {
    submittedRef.current = submittedOrder;
    returnHomeRef.current = returnToHome;
  }, [submittedOrder, returnToHome]);
  const [returnIn, setReturnIn] = useState(0);
  useEffect(() => {
    if (!submittedOrder) {
      setReturnIn(0);
      return;
    }
    setReturnIn(5);
    const id = setInterval(() => {
      setReturnIn((n) => {
        if (n <= 1) {
          clearInterval(id);
          if (submittedRef.current) returnToHome();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [submittedOrder]);

  // kiosk 閒置 1 分鐘自動返回 landing（任何操作重置計時）
  useEffect(() => {
    if (!started) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => returnHomeRef.current(), 60_000);
    };
    const events = ["mousemove", "mousedown", "touchstart", "keydown", "scroll"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [started]);

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

  // ── 所屬店餐牌載入中（kiosk 綁店 / 手機掃碼都會去 backend 攞真 menu）──
  // 未攞到前唔畀入餐牌，避免 flash demo store（macau-store-a）嘅餐牌。
  if (menuLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-400">
        載入中…
      </main>
    );
  }

  // ── 餐牌未開放（P1-5）：未知店 / 未同步 / 離線無 cache 一律唔露示範餐牌 ──
  if (menuUnavailable) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-4 text-6xl">🧾</div>
        <h1 className="mb-2 text-xl font-bold text-slate-900">{t("menuUnavailableTitle")}</h1>
        <p className="mb-6 max-w-sm text-sm text-slate-500">{t("menuUnavailableBody")}</p>
        <button
          onClick={rebindStore}
          className="w-full max-w-xs rounded-xl bg-orange-500 py-3 text-lg font-semibold text-white"
        >
          前往登入綁店
        </button>
      </main>
    );
  }

  // ── Landing：未「開始點餐」先顯示 landing page（唔用點餐介面做主頁）──
  if (!started) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-6 text-8xl">🍽️</div>
        <h1 className="mb-2 text-3xl font-bold text-slate-900">{displayStoreName}</h1>
        <p className="mb-10 text-base text-slate-500">歡迎光臨，點擊開始為您點餐</p>
        <button
          onClick={startOrdering}
          className="w-full max-w-xs rounded-2xl bg-orange-500 py-5 text-2xl font-semibold text-white active:scale-[0.98]"
        >
          開始點餐
        </button>
      </main>
    );
  }

  // ── 確認頁：落單成功後顯示 loading + 5 秒倒數，自動返回主頁 ──
  if (submittedOrder) {
    const isDineIn = mode === "dine_in";
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-5 flex h-24 w-24 items-center justify-center rounded-full bg-emerald-100 text-7xl">✅</div>
        <h1 className="mb-3 text-4xl font-bold text-slate-900">{t("thanks")}</h1>
        {/* P1-4：訂單入咗本地待同步隊列就唔可以講「已完成同步」 */}
        {orderSyncPending && (
          <p className="mb-4 rounded-xl bg-amber-100 px-4 py-2 text-sm font-medium text-amber-800" role="status">
            {t("syncPending")}
          </p>
        )}
        <div className="w-full rounded-3xl bg-white p-8 shadow-sm">
          <div className="mb-2 text-base text-slate-500">{t("orderNo")}</div>
          <div className="mb-4 text-5xl font-bold text-slate-900">{submittedOrder.localOrderNo}</div>
          <div className="mb-1 text-base text-slate-500">
            {isDineIn ? t("table") : t("pickupNo")}
          </div>
          <div className="text-2xl font-semibold text-slate-900">{submittedOrder.tableName}</div>
        </div>
        <p className="mt-5 text-lg text-slate-600">{t("payAtCounter")}</p>

        {/* 堂食：顯示本枱已落單明細（5 秒內可加單，否則自動返回主頁） */}
        {isDineIn && (
          <div className="mt-5 w-full text-left">
            <OrderSummaryCard order={submittedOrder} title={t("tableOrderTitle")} />
          </div>
        )}

        {/* 5 秒倒數自動返回主頁（loading 狀態） */}
        <div className="mt-6 flex w-full flex-col items-center">
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-orange-500 transition-[width] duration-1000 ease-linear"
              style={{ width: `${((5 - returnIn) / 5) * 100}%` }}
            />
          </div>
          <div className="mt-3 text-sm text-slate-500">
            {returnIn > 0 ? `${returnIn} 秒後自動返回主頁…` : t("submitting")}
          </div>
          {isDineIn && (
            <button
              onClick={addToOrder}
              className="mt-4 w-full rounded-2xl bg-orange-500 py-4 text-xl font-semibold text-white"
            >
              {t("addOrder")}
            </button>
          )}
        </div>
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
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600"
          >
            {t("settings")}
          </button>
        </div>
      </header>

      {/* 待同步提示（P1-4） */}
      {pendingSyncCount > 0 && (
        <div className="bg-amber-100 px-4 py-2 text-xs font-medium text-amber-800" role="status">
          {t("syncPending")}（{pendingSyncCount}）
        </div>
      )}

      {activeTableOrder && (
        <div className="bg-amber-50 px-4 py-2">
          <OrderSummaryCard order={activeTableOrder} title={t("tableOrderTitle")} />
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
              // P1-3b：時價菜唔可以提供一個可以係 0 元嘅價 → 客人端停用
              const marketPrice = Boolean(item.isMarketPrice);
              const blocked = sold || marketPrice;
              return (
                <button
                  key={item.id}
                  disabled={blocked}
                  onClick={() => addItem(item)}
                  aria-label={blocked ? `${item.name}（${sold ? t("soldout") : t("marketPrice")}）` : item.name}
                  className={`flex flex-col rounded-2xl bg-white p-4 text-left shadow-sm ${
                    blocked ? "opacity-50" : "active:scale-95"
                  }`}
                >
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Ledger 圖片係任意外部域名，唔適合 next/image 固定 remotePatterns
                    <img
                      src={item.image}
                      alt={item.name}
                      width={320}
                      height={80}
                      decoding="async"
                      className="mb-2 h-20 w-full rounded-xl object-cover"
                      loading="lazy"
                    />
                  ) : null}
                  <span className="text-base font-semibold text-slate-900">{item.name}</span>
                  <span className="mt-1 text-sm text-orange-600">
                    {marketPrice ? t("marketPrice") : `MOP ${money2(item.price)}`}
                  </span>
                  {/* P2-1：售罄項保留 + 灰化標籤（舊版 filter 走售罄項 → 呢個分支係死碼） */}
                  {sold && <span className="mt-1 text-xs font-medium text-red-500">{t("soldout")}</span>}
                  {!sold && marketPrice && (
                    <span className="mt-1 text-xs font-medium text-slate-400">{t("marketPriceHint")}</span>
                  )}
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
          {/* docs/87 §5.1：自助點餐鎖「自取」，唔提供外賣（免配送地址 / 運費複雜度）。 */}
          {mode === "quick" && (
            <div className="mb-3 rounded-lg bg-orange-50 py-2 text-center text-xs font-semibold text-orange-700">
              {t("pickup")}
            </div>
          )}
          <div className="flex-1 space-y-2 overflow-y-auto">
            {cart.length === 0 && <div className="py-8 text-center text-sm text-slate-400">{t("empty")}</div>}
            {cart.map((line) => (
              <div key={line.lineId} className="rounded-lg bg-slate-50 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900">{line.name}</span>
                  {/* P2-3：統一 2 位小數 */}
                  <span className="text-sm text-slate-600">MOP {money2(line.price * line.quantity)}</span>
                </div>
                {(line.selectedSpecs?.length ?? 0) > 0 && (
                  <div className="text-xs text-slate-400">
                    {line.selectedSpecs!.map((s) => s.optionLabel).join(" / ")}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <button
                    onClick={() => changeQty(line.lineId, -1)}
                    aria-label={`${line.name} 減少一件`}
                    className="h-7 w-7 rounded bg-slate-200 text-slate-700"
                  >
                    −
                  </button>
                  <span className="text-sm">{line.quantity}</span>
                  <button
                    onClick={() => changeQty(line.lineId, 1)}
                    aria-label={`${line.name} 增加一件`}
                    className="h-7 w-7 rounded bg-slate-200 text-slate-700"
                  >
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
            aria-label={t("note")}
            className="mt-2 h-14 w-full resize-none rounded-lg border border-slate-200 p-2 text-xs text-slate-700"
          />

          {/* P1-3：金額真源同寫入訂單一致（含稅 / 服務費） */}
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>{t("subtotal")}</span>
              <span>MOP {money2(totals.subtotal)}</span>
            </div>
            {totals.serviceChargeAmount > 0 && (
              <div className="flex justify-between text-slate-600">
                <span>{t("service")}</span>
                <span>MOP {money2(totals.serviceChargeAmount)}</span>
              </div>
            )}
            {totals.taxAmount > 0 && (
              <div className="flex justify-between text-slate-600">
                <span>{t("tax")}</span>
                <span>MOP {money2(totals.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-slate-900">
              <span>{t("total")}</span>
              <span>MOP {money2(totals.total)}</span>
            </div>
          </div>

          <div aria-live="assertive" role="alert">
            {error && <div className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-600">{error}</div>}
          </div>

          <button
            onClick={() => void placeOrder()}
            disabled={cart.length === 0 || submitting}
            className="mt-3 w-full rounded-xl bg-orange-500 py-3 text-lg font-semibold text-white disabled:opacity-50"
          >
            {submitting ? t("submitting") : error ? t("retryPlace") : t("place")}
          </button>
        </aside>
      </div>

      {/* 規格彈窗（共用元件，P2-6） */}
      {specDraft && (
        <SpecSheet
          draft={specDraft}
          t={t}
          variant="kiosk"
          onClose={() => setSpecDraft(null)}
          onChangeSpecs={(specs, priceDelta) => setSpecDraft({ ...specDraft, specs, priceDelta })}
          onConfirm={() => {
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

      {/* 設定（綁店）彈窗 */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/40"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="裝置設定"
            className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-base font-semibold text-slate-900">裝置設定</div>
            <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
              已綁定店鋪：<span className="font-semibold text-slate-900">{displayStoreName}</span>
            </div>
            <button
              onClick={rebindStore}
              className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white"
            >
              重新綁定（換店）
            </button>
            {kioskMode && (
              <button
                onClick={exitKioskMode}
                className="mt-2 w-full rounded-xl bg-slate-900 py-3 font-semibold text-white"
              >
                退出自助點餐模式（返回收銀台）
              </button>
            )}

            {/* 自助點餐機專屬打印機（docs/87 §6.2）：客人落單後由呢部機出小票。
                真源喺 DB（per-store，改一次全店即時生效），本機有快取做離線 fallback。 */}
            <KioskPrinterPanel storeId={storeId} />

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
