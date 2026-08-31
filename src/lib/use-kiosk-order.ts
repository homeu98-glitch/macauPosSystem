"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache, saveBootstrapCache } from "@/lib/storage";
import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import { fetchKioskSettings } from "@/lib/pos/kiosk-settings";
import { printKioskReceiptForOrder } from "@/lib/print-jobs";
import { PosSoldoutRow } from "@/lib/pos/pos-order-mapper";
import {
  buildKioskOrder,
  clearKioskDeviceBinding,
  DEFAULT_KIOSK_STORE_ID,
  fetchUnsettledKioskOrder,
  KioskCartItem,
  KioskDeviceBinding,
  KioskLanguage,
  KioskQuickType,
  loadKioskDeviceBinding,
  saveKioskDeviceBinding,
  submitKioskOrder,
} from "@/lib/kiosk-order";
import { MenuItem, OrderItem, PosBootstrap, PosOrder, PrinterGroup } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
// 共用型別：購物車一行 + 規格草稿（kiosk 平板 / 手機介面共用）
// ─────────────────────────────────────────────────────────────
export type CartLine = {
  lineId: string;
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: OrderItem["selectedSpecs"];
  note?: string;
};

export type SpecDraft = {
  item: MenuItem;
  specs: NonNullable<OrderItem["selectedSpecs"]>;
  priceDelta: number;
};

// ─────────────────────────────────────────────────────────────
// 多語（kiosk 與手機介面共用同一套詞庫；手機額外補咗 viewCart/specs 等 key）
// ─────────────────────────────────────────────────────────────
export const KIOSK_I18N: Record<KioskLanguage, Record<string, string>> = {
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
    tableOrderTitle: "本枱已落單",
    addOrder: "加單",
    currentTotal: "枱上總計",
    done: "完成",
    viewCart: "查看購物車",
    specs: "規格",
    selectOptions: "請選規格",
    clearCart: "清空購物車",
    addToCart: "加入購物車",
  },
};

function lineSignature(line: Omit<CartLine, "lineId" | "quantity">): string {
  const specs = (line.selectedSpecs ?? [])
    .map((s) => `${s.groupId}:${s.optionId}`)
    .sort()
    .join(",");
  return `${line.menuItemId}|${specs}|${line.note ?? ""}`;
}

/**
 * Kiosk 落單共用邏輯（kiosk 平板 /order 與手機介面 /menu 共用）。
 * 抽出嚟避免兩套介面各自維護 cart / realtime / resume / 落單重複碼。
 * 介面（UI）各自實現，互不影響。
 */
export function useKioskOrder() {
  const router = useRouter();

  const [language, setLanguage] = useState<KioskLanguage>("zh-HK");
  const [binding, setBinding] = useState<KioskDeviceBinding | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderNote, setOrderNote] = useState("");
  const [quickType, setQuickType] = useState<KioskQuickType>("pickup");
  const [soldoutIds, setSoldoutIds] = useState<Set<string>>(new Set());
  const [specDraft, setSpecDraft] = useState<SpecDraft | null>(null);
  const [submittedOrder, setSubmittedOrder] = useState<PosOrder | null>(null);
  const [resumedOrder, setResumedOrder] = useState<PosOrder | null>(null);
  // 落單後仍然保留嘅「本枱現有單」（dine_in 用嚟顯示已落單明細 + 加單；quick 模式落單後唔保留）
  const [tableOrder, setTableOrder] = useState<PosOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanStoreId, setScanStoreId] = useState<string | null>(null);
  const [scanStoreName, setScanStoreName] = useState<string | null>(null);
  const [fetchedBootstrap, setFetchedBootstrap] = useState<PosBootstrap | null>(null);
  // 所屬店 menu 嘗試過攞（成功或失敗都設 true）：避免離線 / 失敗時 menuLoading 卡死無限 loading
  const [menuFetchDone, setMenuFetchDone] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // 落單介面前嘅 landing gate：未「開始點餐」就顯示 landing page（唔用點餐介面做主頁）
  const [started, setStarted] = useState(
    () => typeof window !== "undefined" && window.sessionStorage.getItem("kiosk-started") === "1",
  );
  // 手機掃碼「已落單枱」鎖定：未按加單前唔開餐牌，只顯示本枱明細
  const [ordering, setOrdering] = useState(false);

  // 手機掃碼（scanStoreId）同 kiosk 綁店（binding.storeId）都會去 backend 攞所屬店嘅真 menu
  // （pos_bootstrap_config，與商家點餐機同一份）；fallback 先本地 cache 再 mockBootstrap。
  const bootstrap = useMemo(
    () => fetchedBootstrap ?? loadBootstrapCache() ?? mockBootstrap,
    [fetchedBootstrap],
  );
  // 手機掃碼 / kiosk 綁店：攞緊所屬店 menu 時嘅 loading 狀態（確保唔會 flash demo 餐牌）。
  // 用 menuFetchDone（成功或失敗都設 true）判斷，離線 / 失敗就 fallback 去 cache / mock，唔會卡死。
  const menuLoading =
    (Boolean(scanStoreId) || Boolean(binding?.storeId)) && !menuFetchDone;
  // 綁店 device（登入寫入）優先；掃碼連結 ?store= 次之；最後 fallback 預設店
  const storeId = binding?.storeId ?? scanStoreId ?? DEFAULT_KIOSK_STORE_ID;
  // 顯示店名：綁店名 > 掃碼連結 ?storeName= > 本地 mock 店名
  const displayStoreName = useMemo(
    () => binding?.storeName ?? scanStoreName ?? bootstrap.storeName,
    [binding, scanStoreName, bootstrap],
  );
  // 初始化：讀 URL ?tableId= / ?store=、綁店、語言
  useEffect(() => {
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    const tid = params.get("tableId")?.trim() || null;
    const sid = params.get("store")?.trim() || null;
    const sname = params.get("storeName")?.trim() || null;
    setTableId(tid);
    setScanStoreId(sid);
    setScanStoreName(sname);

    const b = loadKioskDeviceBinding();
    setBinding(b);
    if (b?.language) setLanguage(b.language);

    setActiveCategory(bootstrap.categories[0]?.id ?? "");
    setHydrated(true);
  }, [bootstrap.categories]);

  // ── 綁店閘門：kiosk 設備必須先登入綁店；掃碼連結（帶 tableId/store）唔使綁 ──
  const isScanLink = Boolean(tableId) || Boolean(scanStoreId);
  const needsBinding = !binding && !isScanLink;

  // 售罄即時（Realtime，禁 polling）
  usePosRealtime(storeId, true, {
    onSoldoutUpsert: (row: PosSoldoutRow) => {
      setSoldoutIds((prev) => {
        const next = new Set(prev);
        if (row.sold_out) next.add(row.menu_item_id);
        else next.delete(row.menu_item_id);
        return next;
      });
    },
  });

  // 按 storeId 去 backend 攞商家點餐機同步落 pos_bootstrap_config 嘅真 menu：
  // 手機掃碼用 scanStoreId；kiosk 綁店用 binding.storeId（避免 fallback 去 demo store macau-store-a）。
  useEffect(() => {
    const targetStoreId = scanStoreId ?? binding?.storeId ?? null;
    if (!targetStoreId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/pos/bootstrap?storeId=${encodeURIComponent(targetStoreId)}`);
        if (cancelled) return;
        if (!res.ok) {
          // 後端回非 200（例如 500）：唔卡 loading，fallback 去 cache / mock
          setMenuFetchDone(true);
          return;
        }
        const data = (await res.json()) as PosBootstrap;
        if (cancelled) return;
        setFetchedBootstrap(data);
        setActiveCategory(data.categories?.[0]?.id ?? "");
        setMenuFetchDone(true);
        // 寫入 cache：離線時 fallback 會係所屬店餐牌而唔係 demo
        try {
          saveBootstrapCache(data);
        } catch {
          // 寫 cache 失敗唔影響今次攞餐牌
        }
      } catch {
        // 失敗就保留本地 cache / mockBootstrap fallback
        setMenuFetchDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanStoreId, binding?.storeId]);

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
    return quickType === "delivery" ? KIOSK_I18N[language].delivery : KIOSK_I18N[language].pickup;
  }, [mode, tableId, quickType, bootstrap.tables, language]);

  // 本枱現有單（用嚟顯示已落單明細 + 加單）：resume 載入嘅單 或 剛落嘅單（dine_in 先保留）
  const activeTableOrder = useMemo(
    () => (mode === "dine_in" ? resumedOrder ?? tableOrder : null),
    [mode, resumedOrder, tableOrder],
  );

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
    pushLine({ menuItemId: item.id, name: item.name, price: item.price, printerGroup: item.printerGroup });
  }

  function pushLine(base: Omit<CartLine, "lineId" | "quantity">) {
    const sig = lineSignature(base);
    setCart((prev) => {
      const existing = prev.find((line) => lineSignature(line) === sig);
      if (existing) {
        return prev.map((line) =>
          line.lineId === existing.lineId ? { ...line, quantity: line.quantity + 1 } : line,
        );
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
      // 落單號碼：跟店內線下同日序號（/api/pos/sequence），kiosk/掃碼與店內共用同一日序列表。
      // kind 對齊店內：堂食→pos、自取→pickup、外賣→delivery；storeId 用所屬店。
      let localOrderNo: string | undefined;
      try {
        const seqKind = mode === "dine_in" ? "pos" : quickType === "delivery" ? "delivery" : "pickup";
        const seqRes = await fetch("/api/pos/sequence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: seqKind, storeId }),
        });
        if (seqRes.ok) {
          const seqPayload = (await seqRes.json()) as { display?: string };
          if (seqPayload.display) localOrderNo = seqPayload.display;
        }
      } catch {
        // 失敗（離線 / 序列函數未佈署）就 fallback 去 buildKioskOrder 內嘅 timestamp 後綴
      }

      // 「自動接自助單」開關嘅真源喺 DB（`pos_kiosk_settings`），落單當刻先攞一次（禁 polling）。
      // 離線 / 後端失敗 → fallback 自動接單（規格 5：免確認直接出單係開關嘅預設值）。
      const kioskSettings = await fetchKioskSettings(storeId);

      const order = buildKioskOrder({
        storeId,
        tableId,
        tableName,
        mode,
        quickType: mode === "quick" ? quickType : undefined,
        autoAcceptSelfOrder: kioskSettings.selfOrderAutoAccept,
        // 自助點餐機（綁定設備）vs 客人掃碼（URL 帶 tableId 或 ?store=）：
        // kiosk 機本身唔會帶呢兩個參數，所以有就當掃碼落單。
        source: isScanLink ? "scan" : "kiosk",
        items,
        taxRate: bootstrap.rules.taxRate,
        serviceRate: bootstrap.rules.serviceChargeRate,
        orderNote: orderNote || undefined,
        id: resumedOrder?.id,
        status: resumedOrder?.status,
        fulfillmentStatus: resumedOrder?.fulfillmentStatus,
        localOrderNo,
      });
      // ⚠️ 唔建廚房單、唔推 PRINT_JOB_CREATED（docs/87 §3.1）：
      // 廚房單一律由收銀端收到單之後先建，否則會雙重打印。
      await submitKioskOrder(storeId, order, resumedOrder ? "ORDER_UPDATED" : "ORDER_CREATED");

      // 顧客小票：自助點餐機（kiosk）落單後即時印，本機排隊、唔上雲（同上，避免收銀端再印一次）。
      // 掃碼單（scan）唔喺度印 —— 由收銀台部機印（規格 4：掃碼單嘅小票由收銀端打印機出）。
      if (!isScanLink) {
        try {
          printKioskReceiptForOrder(order);
        } catch {
          // 打印失敗唔可以阻住落單：訂單已寫入 DB，收銀台會見到，可以手動補印。
        }
      }

      if (typeof window !== "undefined") window.sessionStorage.setItem("kiosk-last-order", order.id);
      setSubmittedOrder(order);
      setCart([]);
      setResumedOrder(null);
      // dine_in 保留本枱單（顯示已落單明細 + 加單）；quick 模式落單後清走，唔畀加單
      setTableOrder(mode === "dine_in" ? order : null);
      setOrderNote("");
      setOrdering(false); // 落完單返去「明細」介面（鎖定餐牌）
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function persistLanguage(lng: KioskLanguage) {
    setLanguage(lng);
    if (binding) saveKioskDeviceBinding({ ...binding, language: lng });
  }

  // 加單（堂食先准）：把本枱現有單嘅項目載返入購物車，重用同一 order.id（下一次落單 → ORDER_UPDATED）
  // 快餐模式（quick）唔准加單，落單後就要再下一張新單。
  function addToOrder() {
    if (mode !== "dine_in" || !tableOrder) return;
    const lines: CartLine[] = tableOrder.items.map((it, idx) => ({
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
    if (tableOrder.orderNote) setOrderNote(tableOrder.orderNote);
    setResumedOrder(tableOrder); // 下次 placeOrder 重用同一 id → ORDER_UPDATED
    setSubmittedOrder(null); // 返去 menu 繼續加菜
    setOrdering(true); // 解鎖餐牌（進入點餐介面）
  }

  function rebindStore() {
    clearKioskDeviceBinding();
    setBinding(null);
    router.replace("/login?mode=kiosk");
  }

  // 落單介面前嘅 landing：客人按「開始點餐」先入菜單（避免一開就係點餐介面）
  function startOrdering() {
    setStarted(true);
    setOrdering(false); // 入餐牌前重置鎖定（無已落單枱 → 直接點餐；有 → 見明細）
    if (typeof window !== "undefined") window.sessionStorage.setItem("kiosk-started", "1");
  }

  // kiosk 落單成功 5 秒倒數後自動返回：清走成功頁 + 重置 landing（等下一個客人重新「開始點餐」）
  function returnToHome() {
    setSubmittedOrder(null);
    setStarted(false);
    setOrdering(false);
    if (typeof window !== "undefined") window.sessionStorage.removeItem("kiosk-started");
  }

  return {
    hydrated,
    menuLoading,
    bootstrap,
    language,
    setLanguage,
    persistLanguage,
    binding,
    storeId,
    displayStoreName,
    tableId,
    scanStoreId,
    mode,
    tableName,
    isScanLink,
    needsBinding,
    activeCategory,
    setActiveCategory,
    cart,
    setCart,
    cartTotal,
    orderNote,
    setOrderNote,
    quickType,
    setQuickType,
    soldoutIds,
    visibleItems,
    categoryItems,
    specDraft,
    setSpecDraft,
    addItem,
    pushLine,
    changeQty,
    submittedOrder,
    setSubmittedOrder,
    resumedOrder,
    activeTableOrder,
    addToOrder,
    started,
    startOrdering,
    returnToHome,
    ordering,
    submitting,
    error,
    placeOrder,
    rebindStore,
  };
}
