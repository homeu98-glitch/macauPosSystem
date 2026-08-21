"use client";

import { useEffect, useMemo, useState } from "react";

import { defaultPosLocalSettings, mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache } from "@/lib/storage";
import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import { PosSoldoutRow } from "@/lib/pos/pos-order-mapper";
import {
  buildKioskKitchenPrintJobs,
  buildKioskOrder,
  defaultZoneNames,
  fetchUnsettledKioskOrder,
  KioskCartItem,
  KioskDeviceBinding,
  KioskLanguage,
  KioskQuickType,
  loadKioskDeviceBinding,
  saveKioskDeviceBinding,
  submitKioskOrder,
} from "@/lib/kiosk-order";
import { MenuItem, OrderItem, PosOrder, PrinterGroup } from "@/lib/types";

type CartLine = {
  lineId: string;
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: OrderItem["selectedSpecs"];
  note?: string;
};

type SpecDraft = {
  item: MenuItem;
  specs: OrderItem["selectedSpecs"];
  priceDelta: number;
};

const I18N: Record<KioskLanguage, Record<string, string>> = {
  "zh-HK": {
    welcome: "歡迎光臨，請點餐",
    pickup: "自取",
    delivery: "外賣",
    dineIn: "堂食",
    table: "枱號",
    cart: "購物車",
    empty: "尚未點餐",
    add: "加入",
    qty: "數量",
    note: "備註",
    notePlaceholder: "如：走冰、少甜（可不填）",
    place: "落單",
    subtotal: "小計",
    tax: "稅",
    service: "服務費",
    total: "總計",
    confirm: "確認落單",
    cancel: "取消",
    thanks: "落單成功！",
    payAtCounter: "請往收銀付款 / 取餐",
    orderNo: "單號",
    pickupNo: "取餐號",
    settings: "設定",
    bindStore: "綁定店舖",
    storeId: "店舖 ID",
    language: "語言",
    save: "保存",
    newOrder: "再點一單",
    soldout: "售罄",
    needSpec: "請選規格",
    specConfirm: "確定",
    submitting: "落單中…",
    resumeHint: "此枱有未完成訂單，已載入可繼續加單",
    scanAgain: "如需重開新單，請向職員查詢",
  },
  pt: {
    welcome: "Bem-vindo, por favor faça o pedido",
    pickup: "Recolha",
    delivery: "Entrega",
    dineIn: "Comer aqui",
    table: "Mesa",
    cart: "Carrinho",
    empty: "Ainda não pediu",
    add: "Adicionar",
    qty: "Qtd",
    note: "Nota",
    notePlaceholder: "Ex: sem gelo, pouco doce (opcional)",
    place: "Encomendar",
    subtotal: "Subtotal",
    tax: "Imposto",
    service: "Serviço",
    total: "Total",
    confirm: "Confirmar",
    cancel: "Cancelar",
    thanks: "Pedido enviado!",
    payAtCounter: "Por favor pague / recolha no balcão",
    orderNo: "Número",
    pickupNo: "Número de recolha",
    settings: "Definições",
    bindStore: "Vincular loja",
    storeId: "ID da loja",
    language: "Idioma",
    save: "Guardar",
    newOrder: "Novo pedido",
    soldout: "Esgotado",
    needSpec: "Escolha opções",
    specConfirm: "OK",
    submitting: "A enviar…",
    resumeHint: "Mesa com pedido em aberto, carregado para continuar",
    scanAgain: "Para novo pedido, fale com o funcionário",
  },
  en: {
    welcome: "Welcome, please order",
    pickup: "Pickup",
    delivery: "Delivery",
    dineIn: "Dine-in",
    table: "Table",
    cart: "Cart",
    empty: "Nothing ordered yet",
    add: "Add",
    qty: "Qty",
    note: "Note",
    notePlaceholder: "e.g. no ice, less sweet (optional)",
    place: "Place order",
    subtotal: "Subtotal",
    tax: "Tax",
    service: "Service",
    total: "Total",
    confirm: "Confirm",
    cancel: "Cancel",
    thanks: "Order placed!",
    payAtCounter: "Please pay / collect at the counter",
    orderNo: "Order No.",
    pickupNo: "Pickup No.",
    settings: "Settings",
    bindStore: "Bind store",
    storeId: "Store ID",
    language: "Language",
    save: "Save",
    newOrder: "New order",
    soldout: "Sold out",
    needSpec: "Choose options",
    specConfirm: "OK",
    submitting: "Submitting…",
    resumeHint: "Table has an open order, loaded so you can add more",
    scanAgain: "For a new order, ask a staff member",
  },
};

function lineSignature(line: Omit<CartLine, "lineId" | "quantity">): string {
  const specs = (line.selectedSpecs ?? [])
    .map((s) => `${s.groupId}:${s.optionId}`)
    .sort()
    .join(",");
  return `${line.menuItemId}|${specs}|${line.note ?? ""}`;
}

export default function OrderPage() {
  const t = (key: string) => I18N[language][key] ?? key;

  const [language, setLanguage] = useState<KioskLanguage>("zh-HK");
  const [binding, setBinding] = useState<KioskDeviceBinding | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderNote, setOrderNote] = useState("");
  const [quickType, setQuickType] = useState<KioskQuickType>("pickup");
  const [soldoutIds, setSoldoutIds] = useState<Set<string>>(new Set());
  const [specDraft, setSpecDraft] = useState<SpecDraft | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<PosOrder | null>(null);
  const [resumedOrder, setResumedOrder] = useState<PosOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bootstrap = useMemo(() => loadBootstrapCache() ?? mockBootstrap, []);
  const storeId = binding?.storeId ?? "macau-store-a";
  const kitchenMode = defaultPosLocalSettings.kioskKitchenMode;
  const zoneNames = defaultZoneNames();

  // 初始化：讀 URL ?tableId=、綁店、語言
  useEffect(() => {
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    const tid = params.get("tableId")?.trim() || null;
    setTableId(tid);

    const b = loadKioskDeviceBinding();
    setBinding(b);
    if (b?.language) setLanguage(b.language);

    setActiveCategory(bootstrap.categories[0]?.id ?? "");
  }, [bootstrap.categories]);

  // 售罄即時（Realtime，禁 polling）
  usePosRealtime(binding?.storeId ?? null, true, {
    onSoldoutUpsert: (row: PosSoldoutRow) => {
      setSoldoutIds((prev) => {
        const next = new Set(prev);
        if (row.sold_out) next.add(row.menu_item_id);
        else next.delete(row.menu_item_id);
        return next;
      });
    },
  });

  // resume：重複掃碼載入該枱 / 上次單嘅未結單
  useEffect(() => {
    let cancelled = false;
    if (!tableId && submittedOrder) return;
    if (resumedOrder) return;
    void (async () => {
      const lastOrderId =
        typeof window !== "undefined" ? window.sessionStorage.getItem("kiosk-last-order") ?? undefined : undefined;
      const existing = await fetchUnsettledKioskOrder(storeId, tableId, lastOrderId);
      if (cancelled || !existing) return;
      const lines: CartLine[] = existing.items.map((it, idx) => ({
        lineId: `resume-${idx}-${it.menuItemId}`,
        menuItemId: it.menuItemId,
        name: it.name,
        price: it.price,
        quantity: it.quantity,
        printerGroup: it.printerGroup,
        selectedSpecs: it.selectedSpecs,
        note: it.note,
      }));
      setCart(lines);
      setResumedOrder(existing);
      if (existing.orderNote) setOrderNote(existing.orderNote);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, storeId]);

  const mode: "dine_in" | "quick" = tableId ? "dine_in" : "quick";

  const tableName = useMemo(() => {
    if (mode === "dine_in" && tableId) {
      return bootstrap.tables.find((tb) => tb.id === tableId)?.name ?? tableId;
    }
    return quickType === "delivery" ? I18N[language].delivery : I18N[language].pickup;
  }, [mode, tableId, quickType, bootstrap.tables, language]);

  const visibleItems = useMemo(
    () =>
      bootstrap.menuItems.filter(
        (item) => item.customerOrderable !== false && !soldoutIds.has(item.id),
      ),
    [bootstrap.menuItems, soldoutIds],
  );

  const categoryItems = useMemo(
    () => visibleItems.filter((item) => item.categoryId === activeCategory),
    [visibleItems, activeCategory],
  );

  const cartTotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.price * line.quantity, 0),
    [cart],
  );

  function addItem(item: MenuItem) {
    if (soldoutIds.has(item.id)) return;
    const required = (item.specGroups ?? []).filter((g) => g.required);
    if (required.length > 0) {
      setSpecDraft({ item, specs: [], priceDelta: 0 });
      return;
    }
    pushLine({ menuItemId: item.id, name: item.name, price: item.price, quantity: 1, printerGroup: item.printerGroup });
  }

  function pushLine(base: Omit<CartLine, "lineId" | "quantity">) {
    const sig = lineSignature(base);
    setCart((prev) => {
      const existing = prev.find((line) => lineSignature(line) === sig);
      if (existing) {
        return prev.map((line) => (line.lineId === existing.lineId ? { ...line, quantity: line.quantity + 1 } : line));
      }
      const line: CartLine = { ...base, lineId: `line-${crypto.randomUUID().slice(0, 8)}`, quantity: 1 };
      return [...prev, line];
    });
  }

  function changeQty(lineId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((line) => (line.lineId === lineId ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  async function placeOrder() {
    if (cart.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const items: KioskCartItem[] = cart.map((line) => ({
        menuItemId: line.menuItemId,
        name: line.name,
        price: line.price,
        quantity: line.quantity,
        printerGroup: line.printerGroup,
        selectedSpecs: line.selectedSpecs,
        note: line.note,
      }));
      const order = buildKioskOrder({
        storeId,
        tableId,
        tableName,
        mode,
        quickType: mode === "quick" ? quickType : undefined,
        kitchenMode,
        items,
        taxRate: bootstrap.rules.taxRate,
        serviceRate: bootstrap.rules.serviceChargeRate,
        orderNote: orderNote || undefined,
        id: resumedOrder?.id,
        status: resumedOrder?.status,
        fulfillmentStatus: resumedOrder?.fulfillmentStatus,
      });
      const printJobs = buildKioskKitchenPrintJobs(order, zoneNames);
      await submitKioskOrder(storeId, order, printJobs, resumedOrder ? "ORDER_UPDATED" : "ORDER_CREATED");

      if (typeof window !== "undefined") window.sessionStorage.setItem("kiosk-last-order", order.id);
      setSubmittedOrder(order);
      setCart([]);
      setResumedOrder(null);
      setOrderNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function saveBinding(next: KioskDeviceBinding) {
    saveKioskDeviceBinding(next);
    setBinding(next);
    setLanguage(next.language);
    setSettingsOpen(false);
  }

  // ── 確認頁 ──
  if (submittedOrder) {
    const isPickup = submittedOrder.tableId === "counter";
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="mb-4 text-6xl">✅</div>
        <h1 className="mb-2 text-2xl font-bold text-slate-900">{t("thanks")}</h1>
        <div className="w-full rounded-2xl bg-white p-5 shadow-sm">
          <div className="mb-3 text-sm text-slate-500">{t("orderNo")}</div>
          <div className="mb-4 text-3xl font-bold text-slate-900">{submittedOrder.localOrderNo}</div>
          <div className="mb-1 text-sm text-slate-500">
            {mode === "dine_in" ? t("table") : t("pickupNo")}
          </div>
          <div className="text-lg font-semibold text-slate-900">{submittedOrder.tableName}</div>
        </div>
        <p className="mt-4 text-base text-slate-600">{t("payAtCounter")}</p>
        <button
          onClick={() => setSubmittedOrder(null)}
          className="mt-6 w-full rounded-xl bg-orange-500 py-3 text-lg font-semibold text-white"
        >
          {t("newOrder")}
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col bg-slate-50">
      {/* 頂欄 */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow-sm">
        <div>
          <div className="text-lg font-bold text-slate-900">
            {binding?.storeName ?? bootstrap.storeName}
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
        <nav className="w-28 shrink-0 border-r border-slate-200 bg-white p-2">
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
        <section className="flex-1 p-3">
          <h2 className="mb-3 text-sm font-semibold text-slate-500">{t("welcome")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {categoryItems.map((item) => {
              const sold = soldoutIds.has(item.id);
              return (
                <button
                  key={item.id}
                  disabled={sold}
                  onClick={() => addItem(item)}
                  className={`flex flex-col rounded-2xl bg-white p-3 text-left shadow-sm ${
                    sold ? "opacity-50" : "active:scale-95"
                  }`}
                >
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
        <aside className="flex w-72 shrink-0 flex-col border-l border-slate-200 bg-white p-3">
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
                          const nextSpecs: OrderItem["selectedSpecs"] =
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
                  quantity: 1,
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
            <div className="mb-3 text-base font-semibold text-slate-900">{t("bindStore")}</div>
            <label className="mb-1 block text-xs text-slate-500">{t("storeId")}</label>
            <input
              defaultValue={storeId}
              id="kiosk-store-id"
              className="mb-3 w-full rounded-lg border border-slate-200 p-2 text-sm"
            />
            <label className="mb-1 block text-xs text-slate-500">{t("language")}</label>
            <select
              id="kiosk-lang"
              defaultValue={language}
              className="mb-4 w-full rounded-lg border border-slate-200 p-2 text-sm"
            >
              <option value="zh-HK">中文 (繁)</option>
              <option value="pt">Português</option>
              <option value="en">English</option>
            </select>
            <button
              onClick={() => {
                const sid = (document.getElementById("kiosk-store-id") as HTMLInputElement)?.value?.trim() || "macau-store-a";
                const lng = (document.getElementById("kiosk-lang") as HTMLSelectElement)?.value as KioskLanguage;
                saveBinding({ storeId: sid, language: lng, storeName: bootstrap.storeName, boundAt: new Date().toISOString() });
              }}
              className="w-full rounded-xl bg-orange-500 py-3 font-semibold text-white"
            >
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
