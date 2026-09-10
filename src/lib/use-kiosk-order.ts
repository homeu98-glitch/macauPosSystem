"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache, saveBootstrapCache, nextLocalDailyOrderNo } from "@/lib/storage";
import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import { fetchKioskSettings } from "@/lib/pos/kiosk-settings";
import { fetchStoreSoldoutIds } from "@/lib/pos/soldout";
import { diffAddedItems } from "@/lib/pos/order-item-diff";
import {
  enqueuePendingKioskOrder,
  flushPendingKioskOrders,
  KIOSK_PENDING_CHANGED_EVENT,
  pendingKioskOrderCount,
} from "@/lib/pos/kiosk-outbox";
import { printKioskReceiptForOrder, isPrintContentEnabled } from "@/lib/print-jobs";
import { PosSoldoutRow } from "@/lib/pos/pos-order-mapper";
import {
  changeCartQty,
  computeOrderTotals,
  mergeCartLine,
  type CartLine,
} from "@/lib/kiosk-cart";
import {
  buildKioskOrder,
  clearKioskDeviceBinding,
  fetchScanOrderById,
  fetchScanTableOrder,
  fetchUnsettledKioskOrder,
  KioskCartItem,
  KioskDeviceBinding,
  KioskLanguage,
  KioskOrderRejectedError,
  KioskOrderTransientError,
  loadKioskDeviceBinding,
  newKioskOrderId,
  saveKioskDeviceBinding,
  submitKioskOrder,
} from "@/lib/kiosk-order";
import { MenuItem, OrderItem, PosBootstrap, PosOrder } from "@/lib/types";

// 購物車行型別而家喺 `@/lib/kiosk-cart`（純函式，可單元測試）；呢度 re-export 保持介面穩定。
export type { CartLine } from "@/lib/kiosk-cart";

// ─────────────────────────────────────────────────────────────
// 共用型別：規格草稿（kiosk 平板 / 手機介面共用）
// ─────────────────────────────────────────────────────────────
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
    marketPrice: "時價",
    marketPriceHint: "請聯絡職員",
    needSpec: "請選規格",
    specConfirm: "確定",
    submitting: "落單中…",
    resumeHint: "此枱有未完成訂單，已載入可繼續加單",
    scanAgain: "如需重開新單，請向職員查詢",
    tableOrderTitle: "本枱已落單",
    addOrder: "加單",
    addToOrderHint: "如需加點，請按「加單」進入點餐",
    currentTotal: "枱上總計",
    done: "完成",
    viewCart: "查看購物車",
    specs: "規格",
    selectOptions: "請選規格",
    clearCart: "清空購物車",
    addToCart: "加入購物車",
    placeFailed: "落單失敗，請重試。",
    retryPlace: "重試落單",
    syncPending: "訂單已收到，正在同步…",
    menuUnavailableTitle: "餐牌準備中",
    menuUnavailableBody: "本店餐牌尚未開放線上點餐，請聯絡職員協助。",
    closeSheet: "關閉",
  },
};

/**
 * 安全取詞：`language` 一旦出現未知值（例如將來加語言但漏填詞庫），
 * 舊寫法 `I18N[language][key]` 會直接 throw 令成頁崩（審查 P3-4）。
 */
export function kioskT(language: KioskLanguage | string, key: string): string {
  const dict = KIOSK_I18N[language as KioskLanguage] ?? KIOSK_I18N["zh-HK"];
  return dict[key] ?? KIOSK_I18N["zh-HK"][key] ?? key;
}

/**
 * 落單流程變體（2026-09-10 需求 2：兩套流程邏輯與介面完全拆分）。
 *
 * - `"kiosk"`：店內自助點餐機（平板 `/order`）。有**單號**（店內同日序號）、
 *   落單後本機印顧客小票、成功頁 5 秒倒數返主頁。
 * - `"scan"`：**客人掃枱 QR**（手機 `/menu`）。**冇單號**（以台號為查詢／呈現依據）、
 *   唔印小票（由收銀台部機出單）、本枱已有單就由 DB 載入並鎖定「已落單」頁。
 *
 * 兩者嘅介面入口已經完全分開：`/order` 用 `useKioskOrder()`、`/menu` 用
 * `useScanOrder()`（`src/lib/use-scan-order.ts`）。呢個 core 只係兩者共用嘅
 * **中性基礎設施**（menu bootstrap、售罄、realtime、購物車、金額、落單重試／隊列），
 * 所有「以單號為導向」嘅行為都已經用 `variant` 分流，唔會漏落掃碼路徑。
 */
export type OrderingVariant = "kiosk" | "scan";

/**
 * 落單共用邏輯 core（kiosk 平板 /order 與手機 /menu 共用嘅中性部分）。
 * 抽出嚟避免兩套介面各自維護 cart / realtime / resume / 落單重試重複碼。
 * 介面（UI）各自實現，互不影響。
 *
 * ⚠️ **新 code 唔應該直接叫呢個 core**：請用 `useKioskOrder()`（自助機）或
 * `useScanOrder()`（客人掃碼）——咁樣 call site 一眼睇得出係邊套流程。
 */
export function useOrderingCore(variant: OrderingVariant = "kiosk") {
  const router = useRouter();

  const [language, setLanguage] = useState<KioskLanguage>("zh-HK");
  const [binding, setBinding] = useState<KioskDeviceBinding | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderNote, setOrderNote] = useState("");
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
  // bootstrap cache 嘅 store scope（2026-09-10 P1-6）：由 init effect 設定，
  // 確保讀 cache 一定係「呢間店」而唔會 fallback 去全局 key（上一間店嘅餐牌）。
  const [cacheScope, setCacheScope] = useState<string | null>(null);
  // 落單草稿 id（P2-5）：同一輪重試重用同一個 id → server upsert idempotent。
  const draftOrderIdRef = useRef<string | null>(null);
  // 落單同步鎖（P2-5）：React state 非同步，撳得太快會兩個 request 都過閘。
  const submittingRef = useRef(false);
  // 有冇收過 realtime 售罄事件（P1-2）：收過就唔用初始快照覆蓋（避免舊快照蓋走新變更）。
  const soldoutRealtimeRef = useRef(false);
  // 落單成功但係「排隊等同步」（P1-4）：UI 顯示「已收到，同步中…」。
  const [orderSyncPending, setOrderSyncPending] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  // ── 店舖真源（P1-1 統一優先級）──
  // ⚠️ 2026-09-02 舊註釋：**移除 `?? DEFAULT_KIOSK_STORE_ID`**（示範店代碼）。
  // ⚠️ 2026-09-10（審查 P1-1）：舊版三處優先級唔一致 —— `storeId` 用 binding 優先，
  // 但 menu fetch 用掃碼優先 → 「曾綁過店」嘅瀏覽器掃另一間店嘅 QR 會
  // 「睇 B 店餐牌、落單入 A 店」（跨店串單）。一律改為：
  //   **有掃碼參數（?tableId= / ?store=）→ 掃碼 URL 為真源；冇先 fallback 去綁店。**
  // 掃碼變體一律當掃碼（即使 URL 參數未解析完 / 客人用 ?store= 開）；
  // 另外保留 URL 參數推導，令 `/order` 萬一被帶 ?tableId= 開都唔會當成 kiosk 落單。
  const isScanLink = variant === "scan" || Boolean(tableId) || Boolean(scanStoreId);
  const storeId = isScanLink ? scanStoreId ?? "" : binding?.storeId ?? "";
  const needsBinding = !storeId;

  // 按 storeId 讀**自己店**嘅 bootstrap cache：
  //   - 有 scope 就用 scoped key 讀；
  //   - 讀到嘅 cache 若 `storeId` 同 scope 唔一致 → 唔採用（防污染）。
  const scopedCache = useMemo(() => {
    if (!cacheScope) return null;
    const cached = loadBootstrapCache(cacheScope);
    if (!cached) return null;
    if (cached.storeId && cached.storeId !== cacheScope) return null;
    return cached;
  }, [cacheScope]);

  // 手機掃碼（scanStoreId）同 kiosk 綁店（binding.storeId）都會去 backend 攞所屬店嘅真 menu
  // （pos_bootstrap_config，與商家點餐機同一份）。
  const bootstrap = useMemo(
    () => fetchedBootstrap ?? scopedCache ?? mockBootstrap,
    [fetchedBootstrap, scopedCache],
  );

  // 手機掃碼 / kiosk 綁店：攞緊所屬店 menu 時嘅 loading 狀態（確保唔會 flash demo 餐牌）。
  const menuLoading = Boolean(storeId) && !menuFetchDone;

  /**
   * 「呢間店未開放線上點餐」閘（P1-5）：
   *   - server 明確回 `menuUnavailable`（pos_bootstrap_config 冇 row → 未知店 / 未同步）；或
   *   - fetch 失敗 / 離線，而且冇**自己店**嘅 cache（剩返 mockBootstrap 示範餐牌）。
   * 舊版喺呢兩種情況都會露出示範店（macau-store-a）餐牌，而且客人可以真金白銀落單入真店。
   */
  const menuUnavailable = useMemo(() => {
    if (fetchedBootstrap) return Boolean(fetchedBootstrap.menuUnavailable);
    if (scopedCache) return Boolean(scopedCache.menuUnavailable);
    return Boolean(storeId) && menuFetchDone;
  }, [fetchedBootstrap, scopedCache, storeId, menuFetchDone]);

  // 顯示店名：掃碼情境以 server 回嘅真店名為準；kiosk 用綁店名。
  const displayStoreName = useMemo(() => {
    if (isScanLink) {
      return fetchedBootstrap?.storeName || scanStoreName || binding?.storeName || bootstrap.storeName;
    }
    return binding?.storeName ?? bootstrap.storeName;
  }, [isScanLink, fetchedBootstrap, scanStoreName, binding, bootstrap]);

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

    // 掃碼為真源；冇掃碼參數先用綁店（同上面 storeId 一致）
    setCacheScope(sid ?? b?.storeId ?? null);

    setActiveCategory(bootstrap.categories[0]?.id ?? "");
    setHydrated(true);
  }, [bootstrap.categories]);

  // 按 storeId 去 backend 攞商家點餐機同步落 pos_bootstrap_config 嘅真 menu。
  useEffect(() => {
    if (!storeId) return;
    const targetStoreId = storeId;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/pos/bootstrap?storeId=${encodeURIComponent(targetStoreId)}`);
        if (cancelled) return;
        if (!res.ok) {
          // 後端回非 200（例如 500）：唔卡 loading，fallback 去 cache（冇 cache 就顯示「餐牌準備中」）
          setMenuFetchDone(true);
          return;
        }
        const data = (await res.json()) as PosBootstrap;
        if (cancelled) return;
        setFetchedBootstrap(data);
        setActiveCategory(data.categories?.[0]?.id ?? "");
        setMenuFetchDone(true);
        // 寫入 cache：明確按 store scope（P1-6），避免污染全局 key。
        if (!data.menuUnavailable) {
          try {
            saveBootstrapCache(data, targetStoreId);
          } catch {
            // 寫 cache 失敗唔影響今次攞餐牌
          }
        }
      } catch {
        // 失敗就保留本地 cache fallback（冇 cache → menuUnavailable，唔露 demo）
        setMenuFetchDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // 售罄初始快照（P1-2）：Realtime 只係增量，客人掃碼嗰刻已售罄嘅菜唔會推送。
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      const ids = await fetchStoreSoldoutIds(storeId);
      // 已經收過 realtime 事件就唔用快照覆蓋（免得舊快照蓋走新變更）
      if (cancelled || !ids || soldoutRealtimeRef.current) return;
      setSoldoutIds(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // 售罄即時（Realtime，禁 polling）
  usePosRealtime(storeId, true, {
    onSoldoutUpsert: (row: PosSoldoutRow) => {
      soldoutRealtimeRef.current = true;
      setSoldoutIds((prev) => {
        const next = new Set(prev);
        if (row.sold_out) next.add(row.menu_item_id);
        else next.delete(row.menu_item_id);
        return next;
      });
    },
  });

  // resume：載入本枱未結單（DB 為準）。
  //
  // 掃碼流程（variant="scan"）嘅次序是關鍵：客人掃 QR 之後**先查 DB**，有單就直接
  // 顯示「本枱訂單」而唔會停喺 landing / 顯示空白餐牌（需求 1、3）。
  useEffect(() => {
    let cancelled = false;
    if (!tableId && submittedOrder) return;
    if (resumedOrder) return;
    // 冇真實 storeId 就唔好去 server 查未結單（會查落假店 / 空店）
    if (!storeId) return;
    void (async () => {
      // 同一部手機重複掃碼 → sessionStorage 仲有上次單 id（快路）；
      // 換手機 / 清過 session / 第一次掃呢張枱 → 由 `tableId` 依台號查 DB（DB 為準）。
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
      // ⚠️ P0-2：resume 一定要同步 `tableOrder`。舊版只 setResumedOrder，
      // 而 `addToOrder()` 只讀 tableOrder → 客人撳「加單」完全冇反應（硬死鎖）。
      setTableOrder(existing);
      if (existing.orderNote) setOrderNote(existing.orderNote);
      // 掃碼：本枱已有單 → 跳過 landing（「開始點餐」），直接入「本枱訂單」頁。
      if (variant === "scan") setStarted(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, storeId]);

  // 待同步隊列（P1-4）：入頁 / 網絡恢復時補推上次落單失敗嘅單。
  useEffect(() => {
    if (!storeId) return;
    setPendingSyncCount(pendingKioskOrderCount(storeId));
    const sync = () => {
      void flushPendingKioskOrders(storeId).then(setPendingSyncCount);
    };
    sync();
    const onOnline = () => sync();
    const onChanged = () => setPendingSyncCount(pendingKioskOrderCount(storeId));
    window.addEventListener("online", onOnline);
    window.addEventListener(KIOSK_PENDING_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(KIOSK_PENDING_CHANGED_EVENT, onChanged);
    };
  }, [storeId]);

  // 手機掃碼閒置自動返回（P3-6）：共用裝置 / 客人放低手機時唔好殘留購物車。
  useEffect(() => {
    if (!isScanLink || !started) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      // 20 分鐘：足夠長，唔會打斷正常點餐；又唔會令 cart 無限殘留。
      timer = setTimeout(() => {
        setCart([]);
        setSubmittedOrder(null);
        setStarted(false);
        setOrdering(false);
        if (typeof window !== "undefined") window.sessionStorage.removeItem("kiosk-started");
      }, 20 * 60_000);
    };
    const events = ["mousemove", "mousedown", "touchstart", "keydown", "scroll"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [isScanLink, started]);

  const mode: "dine_in" | "quick" = tableId ? "dine_in" : "quick";

  const tableName = useMemo(() => {
    if (mode === "dine_in" && tableId) {
      return bootstrap.tables.find((tb) => tb.id === tableId)?.name ?? tableId;
    }
    // 自助點餐機 / 掃碼無枱號 = 自取（docs/87 §5.1：唔提供外賣）
    return KIOSK_I18N["zh-HK"].pickup;
  }, [mode, tableId, bootstrap.tables]);

  // 本枱現有單（用嚟顯示已落單明細 + 加單）：resume 載入嘅單 或 剛落嘅單（dine_in 先保留）
  const activeTableOrder = useMemo(
    () => (mode === "dine_in" ? resumedOrder ?? tableOrder : null),
    [mode, resumedOrder, tableOrder],
  );

  /**
   * 客人可見菜單（P2-1）：
   * 舊版 `visibleItems` 直接 filter 走售罄項 → 兩頁嘅「售罄」分支永遠行唔到（死碼），
   * 而客人亦分唔清「售罄」同「菜單根本冇呢個菜」。
   * 改為**保留售罄項**，由 UI 灰化 + 標籤（客人理解為暫時缺貨，可轉點其他菜）。
   */
  const visibleItems = useMemo(
    () => bootstrap.menuItems.filter((item) => item.customerOrderable !== false),
    [bootstrap.menuItems],
  );

  const categoryItems = useMemo(
    () => visibleItems.filter((item) => item.categoryId === activeCategory),
    [visibleItems, activeCategory],
  );

  /**
   * 金額真源（P1-3）：同 `buildKioskOrder()` 共用 `computeOrderTotals()`，
   * 保證客人所見 == 寫入訂單（含稅 / 服務費）。
   */
  const totals = useMemo(() => computeOrderTotals(cart, bootstrap.rules), [cart, bootstrap.rules]);
  const cartTotal = totals.subtotal;

  function pushLine(base: Omit<CartLine, "lineId" | "quantity">) {
    // 實作喺 `@/lib/kiosk-cart`（純函式，有單元測試）；呢度只負責產生 lineId。
    const newLineId = `line-${crypto.randomUUID().slice(0, 8)}`;
    setCart((prev) => mergeCartLine(prev, base, newLineId));
  }

  /** 加入購物車：售罄 / 時價菜一律唔准（P1-2 / P1-3b）。 */
  function addItem(item: MenuItem) {
    if (soldoutIds.has(item.id)) return;
    if (item.isMarketPrice) return;
    const required = (item.specGroups ?? []).filter((g) => g.required);
    if (required.length > 0) {
      setSpecDraft({ item, specs: [], priceDelta: 0 });
      return;
    }
    pushLine({ menuItemId: item.id, name: item.name, price: item.price, printerGroup: item.printerGroup });
  }

  function changeQty(lineId: string, delta: number) {
    setCart((prev) => changeCartQty(prev, lineId, delta));
  }

  /**
   * 落單。
   * @returns `true` = 已落單（可能係「已收到，同步中」）；`false` = 失敗，UI 必須保留購物車並提示重試。
   *
   * 審查對應：
   *   P0-1 —— 回傳 boolean，避免 UI 未等結果就閂 sheet 造成「靜默丟單」。
   *   P1-4 —— 明確重試（`submitKioskOrder` 內部）＋失敗入本地待同步隊列。
   *   P2-5 —— `submittingRef` 同步鎖 + 重用 `draftOrderIdRef` 做 idempotency key。
   */
  async function placeOrder(): Promise<boolean> {
    if (cart.length === 0) return false;
    if (submittingRef.current) return false;
    submittingRef.current = true;
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

      // 今次事件類型：單已存在（resume / 加單）→ ORDER_UPDATED，否則 ORDER_CREATED。
      const eventType: "ORDER_CREATED" | "ORDER_UPDATED" = resumedOrder ? "ORDER_UPDATED" : "ORDER_CREATED";
      const orderId = resumedOrder?.id ?? draftOrderIdRef.current ?? (draftOrderIdRef.current = newKioskOrderId());

      // 落單號碼（需求 2：呢度就係「兩套流程」嘅分水嶺）。
      //
      // ── 客人掃碼（isScanLink）──
      // **完全唔產生單號**：唔打 /api/pos/sequence、唔叫 nextLocalDailyOrderNo()、
      // 唔燒店內序號資源。訂單標識就係台號（由 buildKioskOrder 嘅 orderNoSource:"table"
      // 直接寫台名）。客人端亦唔會顯示任何單號。
      //
      // ── 自助點餐機（kiosk）──
      // 維持原狀：跟店內線下同日序號（/api/pos/sequence），kind 對齊店內
      // （堂食→pos、自取→pickup），攞唔到先 fallback 本地每日序號。
      const seqKind = mode === "dine_in" ? "pos" : "pickup";
      let localOrderNo: string | undefined;
      if (!isScanLink) {
        try {
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
          // 失敗（離線 / 序列函數未佈署）就 fallback
        }
        if (!localOrderNo) {
          // P1-4：fallback 改用**本地每日序號**（同店內同日遞增），
          // 唔再用 `堂食${時戳後4位}` 呢類同店內序號唔同源嘅亂號。
          localOrderNo = nextLocalDailyOrderNo(seqKind, mode === "dine_in" ? "堂食" : "自取");
        }
      }

      // 「自動接自助單」開關嘅真源喺 DB（`pos_kiosk_settings`），落單當刻先攞一次（禁 polling）。
      // 離線 / 後端失敗 → fallback 自動接單（規格 5：免確認直接出單係開關嘅預設值）。
      const kioskSettings = await fetchKioskSettings(storeId);

      const order = buildKioskOrder({
        storeId,
        tableId,
        tableName,
        mode,
        autoAcceptSelfOrder: kioskSettings.selfOrderAutoAccept,
        // 自助點餐機（綁定設備）vs 客人掃碼（URL 帶 tableId 或 ?store=）：
        // kiosk 機本身唔會帶呢兩個參數，所以有就當掃碼落單。
        source: isScanLink ? "scan" : "kiosk",
        items,
        taxRate: bootstrap.rules.taxRate,
        serviceRate: bootstrap.rules.serviceChargeRate,
        orderNote: orderNote || undefined,
        id: orderId,
        // ⚠️ P2-2：**唔再**把現有 status / fulfillmentStatus 塞返入 payload。
        // 狀態機 owner 係收銀端；客人加單只應該提交 items / 備註。舊版重寫整張單，
        // 會把收銀已標記嘅 `sent_to_kitchen→preparing` 打返轉頭（非終態降級 server 唔擋）。
        localOrderNo,
        // 需求 2：掃碼單唔行「單號」邏輯，直接以台號作為訂單標識。
        orderNoSource: isScanLink ? "table" : "sequence",
      });

      // ⚠️ 2026-09-10 加單修復：算出今次**新增**嘅菜品（舊單 items → 新單 items 嘅差額）。
      // 用途：① server 端「只驗新增菜品有冇售罄」（唔會因為舊菜賣完而鎖死加單）；
      //       ② 上送 payload 一定要用 `{ order, addedItems }` 形狀（見 submitKioskOrder 註解）。
      const addedItems = eventType === "ORDER_UPDATED" ? diffAddedItems(resumedOrder?.items, order.items) : undefined;

      let queuedForSync = false;
      try {
        await submitKioskOrder(storeId, order, eventType, addedItems);
      } catch (e) {
        if (e instanceof KioskOrderRejectedError) throw e;
        if (e instanceof KioskOrderTransientError) {
          // 網絡抖動 / 5xx / 429：收單入本地隊列，UI 當「已收到，同步中」（P1-4）
          const count = enqueuePendingKioskOrder(storeId, order, eventType, addedItems);
          setPendingSyncCount(count);
          queuedForSync = true;
        } else {
          throw e;
        }
      }

      // ⚠️ 唔建廚房單、唔推 PRINT_JOB_CREATED（docs/87 §3.1）：
      // 廚房單一律由收銀端收到單之後先建，否則會雙重打印。
      // 顧客小票：自助點餐機（kiosk）落單後即時印，本機排隊、唔上雲。
      // 掃碼單（scan）唔喺度印 —— 由收銀台部機印（規格 4）。
      if (!isScanLink && isPrintContentEnabled("kiosk")) {
        try {
          printKioskReceiptForOrder(order);
        } catch {
          // 打印失敗唔可以阻住落單：訂單已寫入 DB，收銀台會見到，可以手動補印。
        }
      }

      // 📌 需求 1 後半（「確認掃碼下單成功後，資料即時且正確寫入 DB」）：
      // 掃碼單喺 server 回 `ok` 之後，**即刻由 DB 回讀一次**該台訂單，並用 DB 版本
      // 做畫面真源。咁樣：
      //   ① 客人見到嘅一定係 DB 真正落咗嘅內容（唔會「畫面有、DB 冇」）；
      //   ② 收銀端可能同時改過單（例如已經標記製作中）→ 客人即刻見到最新狀態；
      //   ③ 一旦 DB 寫入有問題，呢一步回唔到單 → 唔會被「假成功」蒙混（配合上面嘅
      //      ack 分類，業務拒絕已經會 throw）。
      // ⚠️ 只在**真正寫入成功**（非入隊）先回讀 —— 離線入隊時 DB 當然冇，回讀會
      // 反而蓋走客人手上嗰張單。回讀失敗（網絡 / 未配置）保留本地版本，唔影響落單。
      let settledOrder = order;
      if (isScanLink && !queuedForSync) {
        // 優先精確回讀自己嗰張單（同台有第二張未結單嘅異常情況下唔會攞錯單）；
        // 攞唔到（例如 server 未及回讀）先退而用台號查。
        const confirmed =
          (await fetchScanOrderById(storeId, order.id)) ??
          (tableId ? await fetchScanTableOrder(storeId, tableId) : null);
        if (confirmed) settledOrder = confirmed;
      }

      if (typeof window !== "undefined") window.sessionStorage.setItem("kiosk-last-order", settledOrder.id);
      setOrderSyncPending(queuedForSync);
      setSubmittedOrder(settledOrder);
      setCart([]);
      setResumedOrder(null);
      // dine_in 保留本枱單（顯示已落單明細 + 加單）；quick 模式落單後清走，唔畀加單
      setTableOrder(mode === "dine_in" ? settledOrder : null);
      setOrderNote("");
      setOrdering(false); // 落完單返去「明細」介面（鎖定餐牌）
      draftOrderIdRef.current = null; // 落單成功：下張單用新 id
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function persistLanguage(lng: KioskLanguage) {
    setLanguage(lng);
    if (binding) saveKioskDeviceBinding({ ...binding, language: lng });
  }

  /**
   * 加單（堂食先准）：把本枱現有單嘅項目載返入購物車，重用同一 order.id（下一次落單 → ORDER_UPDATED）。
   *
   * ⚠️ P0-2 修復：舊版條件係 `!tableOrder`，但 resume 路徑只寫 `resumedOrder`
   * （而畫面 gate 用 `activeTableOrder = resumedOrder ?? tableOrder`）→
   * 客人重複掃碼入到「已落單」畫面，撳「加單」完全冇反應，按「完成」再開始點餐仍然回到同一畫面（硬死鎖）。
   * 改為兩個 state 一齊睇。
   */
  function addToOrder() {
    const source = resumedOrder ?? tableOrder;
    if (mode !== "dine_in" || !source) return;
    const lines: CartLine[] = source.items.map((it, idx) => ({
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
    if (source.orderNote) setOrderNote(source.orderNote);
    setResumedOrder(source); // 下次 placeOrder 重用同一 id → ORDER_UPDATED
    setTableOrder(source);
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
    setOrderSyncPending(false);
    setStarted(false);
    setOrdering(false);
    if (typeof window !== "undefined") window.sessionStorage.removeItem("kiosk-started");
  }

  return {
    hydrated,
    menuLoading,
    menuUnavailable,
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
    totals,
    orderNote,
    setOrderNote,
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
    orderSyncPending,
    pendingSyncCount,
    placeOrder,
    rebindStore,
  };
}

/** `useOrderingCore()` 嘅完整回傳型別（即 `useKioskOrder()` 嘅介面）。 */
export type OrderingApi = ReturnType<typeof useOrderingCore>;

/**
 * **自助點餐機**（店內平板 `/order`）嘅落單 hook。
 *
 * 有單號（店內同日序號）、落單後本機印顧客小票、成功頁 5 秒倒數返主頁。
 * 客人掃碼請用 `useScanOrder()`（`src/lib/use-scan-order.ts`）—— 兩套流程
 * 喺 call site 層面已經分開，唔會互相撈錯行為。
 */
export function useKioskOrder(): OrderingApi {
  return useOrderingCore("kiosk");
}
