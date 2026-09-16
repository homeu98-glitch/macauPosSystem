"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePosRealtime } from "@/lib/pos/use-pos-realtime";
import {
  KioskOrderRejectedError,
  KioskOrderTransientError,
  submitKioskOrder,
} from "@/lib/kiosk-order";
import { changeCartQty, computeOrderTotals, mergeCartLine, type CartLine } from "@/lib/kiosk-cart";
import { buildKitchenPrintJobs } from "@/lib/print-jobs";
import { appendPrintJobsWithSync } from "@/lib/pos/print-job-enqueue";
import { isPrintContentEnabled } from "@/lib/print-toggles";
import { diffAddedItems } from "@/lib/pos/order-item-diff";
import { fetchStoreSoldoutIds } from "@/lib/pos/soldout";
import { refreshPosDeviceTokenIfNeeded, posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";
import {
  buildStaffOrder,
  applyStaffAddOn,
  newStaffOrderId,
  type StaffCartItem,
} from "@/lib/pos/staff-order";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadOrders,
  nextLocalDailyOrderNo,
  normalizeDeviceConfig,
  normalizePosLocalSettings,
  saveBootstrapCache,
  saveDeviceConfig,
  saveOrders,
  savePosLocalSettings,
  type AuthSession,
} from "@/lib/storage";
import { mockBootstrap } from "@/lib/mock-data";
import type { DeviceConfig, PosBootstrap, PosLocalSettings, PosOrder } from "@/lib/types";

/**
 * 店員手機落單（`/staff`）嘅狀態核心（2026-09-16）。
 *
 * ## 設計立場：唔改 `useOrderingCore`
 *
 * `useOrderingCore()` 係 kiosk / 掃碼共用嘅中性核心，但佢對
 * `variant === "scan"` 有 6 處硬判斷（resume 時序、扣款通道、單號策略…）。
 * 加第三個 variant 會令所有 `=== "scan"` 分支**默默把 staff 當 kiosk** ——
 * 呢類 bug 唔會 throw，只會喺某個邊緣情況出錯（例如客人手機掃碼流程忽然
 * 多咗個單號）。風險太高，所以店員手機自成一個 hook。
 *
 * 但**唔會重造輪子**：購物車（`kiosk-cart` 純函式）、金額真源
 * （`computeOrderTotals`）、落單重試（`submitKioskOrder`）、出紙
 * （`buildKitchenPrintJobs` + `appendPrintJobsWithSync`）全部復用。
 */

/** 枱況三態（由本機未結單即時計算）。 */
export type StaffTableState = "free" | "busy" | "paying" | "disabled";

export type StaffTable = {
  id: string;
  name: string;
  area: string;
  capacity?: number;
  state: StaffTableState;
  /** `busy` / `paying` 先有：該枱未結單金額。 */
  amount?: number;
  /** `busy` / `paying` 先有：本枱現有訂單（加菜用）。 */
  order?: PosOrder;
  partySize?: number;
};

export type StaffOrderApi = {
  hydrated: boolean;
  storeId: string;
  storeName: string;
  /** 未登入 / 冇 merchantId → 唔可以落單。 */
  needsLogin: boolean;
  menuLoading: boolean;
  menuUnavailable: boolean;
  bootstrap: PosBootstrap;
  tables: StaffTable[];
  /**
   * 🔴 枱況**未經雲端確認**（拉 `/api/pos/state` 失敗 / 回 401）。
   *
   * 呢個 flag 一定要顯示畀店員睇：手機本機可能一張單都冇，
   * 拉唔到雲端就會**所有枱都顯示「空枱」** —— 店員會去咗一張其實
   * 有人食緊嘅枱，甚至為同一張枱開多一張重複單。
   * 寧願顯示「枱況可能不準確」，都好過畀人以為一切正常。
   */
  tableStateStale: boolean;
  soldoutIds: Set<string>;
  activeCategory: string;
  setActiveCategory: (id: string) => void;
  categoryItems: PosBootstrap["menuItems"];
  /** 已選枱（null = 仲未揀）。 */
  selectedTable: StaffTable | null;
  selectTable: (tableId: string) => void;
  clearTable: () => void;
  cart: CartLine[];
  /**
   * 購物車**總件數**（quantity 加總）。
   *
   * ⚠️ 唔可以用 `cart.length`：`cart` 係「行」，同款菜合併成一行。
   * 2 份叉燒飯 + 1 份牛腩麵 ⇒ `cart.length === 2` 但實際係 **3 件** ——
   * 店員睇「已選 2 項」會以為落少咗一份。
   */
  cartCount: number;
  totals: ReturnType<typeof computeOrderTotals>;
  orderNote: string;
  setOrderNote: (v: string) => void;
  addItem: (item: PosBootstrap["menuItems"][number]) => void;
  pushLine: (line: Omit<CartLine, "lineId" | "quantity">) => void;
  changeQty: (lineId: string, delta: number) => void;
  clearCart: () => void;
  /** 加菜模式：本枱已有未結單。 */
  isAddOn: boolean;
  submitting: boolean;
  error: string | null;
  clearError: () => void;
  /** 送出成功後嘅回饋（含出紙張數）。 */
  submitted: { order: PosOrder; kitchenJobCount: number } | null;
  submit: () => Promise<void>;
  reset: () => void;
};

/** 「即將結帳」判定：本地已標 paid（待收款／已收款）但未 settled。 */
function isPayingState(order: PosOrder): boolean {
  return order.status === "paid";
}

function isOpenOrder(order: PosOrder): boolean {
  return order.status !== "settled" && order.status !== "cancelled" && order.status !== "refunded";
}

export function useStaffOrder(): StaffOrderApi {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [remoteBootstrap, setRemoteBootstrap] = useState<PosBootstrap | null>(null);
  const [menuFetchDone, setMenuFetchDone] = useState(false);
  const [localOrders, setLocalOrders] = useState<PosOrder[]>([]);
  /** 雲端權威訂單（枱況用）。見下面 effect 嘅註解。 */
  const [cloudOrders, setCloudOrders] = useState<PosOrder[]>([]);
  /** 枱況係咪「未經雲端確認」（拉 state 失敗）。見 `StaffOrderApi.tableStateStale`。 */
  const [tableStateStale, setTableStateStale] = useState(false);
  const [soldoutIds, setSoldoutIds] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState("");
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderNote, setOrderNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ order: PosOrder; kitchenJobCount: number } | null>(null);

  const submittingRef = useRef(false);
  /** 落單草稿 id：同一輪重試重用 → server upsert 冪等（同 kiosk 一致）。 */
  const draftOrderIdRef = useRef<string | null>(null);

  const storeId = session?.merchantId ?? "";
  const needsLogin = hydrated && !storeId;

  // ── 初始化 ──
  useEffect(() => {
    const current = loadAuthSession();
    setSession(current);

    const scope = current?.merchantId ?? null;
    const cached = scope ? loadBootstrapCache(scope) : null;
    setRemoteBootstrap(cached && cached.storeId === scope ? cached : null);

    setLocalOrders(loadOrders());
    setHydrated(true);
  }, []);

  // ── 菜單（同收銀台／自助機同一份 pos_bootstrap_config）──
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshPosDeviceTokenIfNeeded();
        const res = await fetch(`/api/pos/bootstrap?storeId=${encodeURIComponent(storeId)}`);
        if (cancelled) return;
        if (!res.ok) {
          setMenuFetchDone(true);
          return;
        }
        const data = (await res.json()) as PosBootstrap;
        if (cancelled) return;
        setRemoteBootstrap(data);
        setMenuFetchDone(true);
        if (!data.menuUnavailable) {
          try {
            saveBootstrapCache(data, storeId);
          } catch {
            // 寫 cache 失敗唔影響今次
          }
        }
      } catch {
        setMenuFetchDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  /**
   * ── 🔴 設備配置（出廚房單嘅**前提**）──
   *
   * `buildKitchenPrintJobs()` 係**同步**函式，佢由 `loadDeviceConfig()` 攞
   * 「分區打印機」清單（`role === "zone"`）同由 `loadPosLocalSettings()` 攞
   * 廚房單模板。冇呢兩個 → `zonePrinters.length === 0` → **回空陣列 →
   * 一張廚房紙都唔出**，而且**唔會報錯**（最難查嗰種）。
   *
   * 手機本身冇參與過打印機設定，所以一定要由店級 `/api/pos/device-config`
   * 拉落嚟寫入本機快取。呢個端點需要 POS 憑證（2026-09-15 加固）。
   */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshPosDeviceTokenIfNeeded();
        const res = await fetch(
          `/api/pos/device-config?storeId=${encodeURIComponent(storeId)}`,
          { headers: posDeviceAuthHeaders() },
        );
        if (cancelled || !res.ok) return;
        const payload = (await res.json()) as {
          ok?: boolean;
          deviceConfig?: unknown;
          localSettings?: unknown;
        };
        if (!payload?.ok) return;
        // 只有讀到真要落本機嘅嘢才寫 —— 唔可以因為「回 null」就清走本機設定。
        // 一律經 normalizer：DB / 舊版本回嘅 shape 唔一定完全對得上，
        // 直接信落去會令 `loadDeviceConfig()` 之後讀到壞 shape。
        if (payload.deviceConfig) {
          const normalized = normalizeDeviceConfig(payload.deviceConfig as DeviceConfig);
          if (normalized) saveDeviceConfig(normalized);
        }
        if (payload.localSettings) {
          savePosLocalSettings(normalizePosLocalSettings(payload.localSettings as PosLocalSettings));
        }
      } catch {
        // 拉唔到就沿用本機已有設定（可能係空 → 唔出紙，由 UI 提示）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  /**
   * ── 🔴 雲端權威訂單（枱況準確性嘅前提）──
   *
   * 只靠本機 `loadOrders()` 算枱況係**唔夠**嘅：一部啱啱登入嘅店員手機
   * 本機一張單都冇，於是**所有枱都會顯示「空枱」** —— 店員會去咗一張
   * 其實有人食緊嘅枱，或者見唔到要加菜嘅單。
   *
   * 所以一定要拉 `/api/pos/state`（帶 POS 憑證）。呢個端點係收銀台
   * 「手動更新」用嘅同一支，回嘅 order 已經係 `PosOrder` shape。
   *
   * ⚠️ 禁 polling（docs/52）：只有入頁一次 + `visibilitychange`。
   */
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;

    async function pull() {
      try {
        await refreshPosDeviceTokenIfNeeded();
        const res = await fetch(
          `/api/pos/state?storeId=${encodeURIComponent(storeId)}&limit=200`,
          { headers: posDeviceAuthHeaders() },
        );
        if (cancelled) return;
        if (!res.ok) {
          // 401（憑證無效／過期）或 5xx → 枱況退回本機資料，並且要告知店員。
          setTableStateStale(true);
          return;
        }
        const payload = (await res.json()) as { ok?: boolean; orders?: PosOrder[] };
        if (cancelled || !payload?.ok || !Array.isArray(payload.orders)) {
          setTableStateStale(true);
          return;
        }
        setCloudOrders(payload.orders);
        setTableStateStale(false);
      } catch {
        // 離線：保留本機訂單算枱況（可能唔完整）→ 標記為唔準確
        if (!cancelled) setTableStateStale(true);
      }
    }

    void pull();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [storeId]);

  // ── 售罄（入頁一次 + 由背景返前景補一次；全專案禁 polling）──
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void fetchStoreSoldoutIds(storeId).then((ids) => {
      if (!cancelled && ids) setSoldoutIds(ids);
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchStoreSoldoutIds(storeId).then((ids) => {
          if (!cancelled && ids) setSoldoutIds(ids);
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [storeId]);

  // ── Realtime：售罄變更（增量）──
  // `usePosRealtime(storeId, enabled, handlers)` —— 只訂售罄，唔訂訂單／打印任務：
  // 手機唔需要即時追蹤全店訂單（枱況由本機未結單算，權威來源係收銀台）。
  usePosRealtime(storeId || null, Boolean(storeId), {
    onSoldoutUpsert: (row) => {
      const id = row?.menu_item_id;
      if (!id) return;
      setSoldoutIds((prev) => {
        const next = new Set(prev);
        if (row.sold_out) next.add(id);
        else next.delete(id);
        return next;
      });
    },
  });

  const bootstrap = useMemo(() => remoteBootstrap ?? mockBootstrap, [remoteBootstrap]);
  const menuLoading = Boolean(storeId) && !menuFetchDone;
  const menuUnavailable = useMemo(() => {
    if (remoteBootstrap) return Boolean(remoteBootstrap.menuUnavailable);
    return Boolean(storeId) && menuFetchDone;
  }, [remoteBootstrap, storeId, menuFetchDone]);

  const storeName = remoteBootstrap?.storeName ?? "";

  // ── 枱況：由未結單即時計算（唔另建表）──
  //
  // 來源優先級：**雲端為權威**（店員剛登入時本機可能一張單都冇）；
  // 本機訂單補上（雲端未拉到 / 離線 / 啱啱送出未 round-trip 返嚟）。
  //
  // ⚠️ 一定要用 `id` 去重：同一張單可能兩邊都有，而**雲端版本狀態較權威**
  // （例如收銀台啱啱結咗帳，本機仲係 `sent_to_kitchen`）。
  // 唔去重就會出現「收銀已埋單、店員手機仲顯示用膳中」。
  const tables = useMemo<StaffTable[]>(() => {
    const cloudIds = new Set(cloudOrders.map((o) => o.id));
    const merged: PosOrder[] = [
      ...cloudOrders,
      ...localOrders.filter((o) => !cloudIds.has(o.id)),
    ];

    const openByTable = new Map<string, PosOrder>();
    for (const o of merged) {
      if (!isOpenOrder(o)) continue;
      if (!o.tableId || o.tableId === "counter") continue;
      // 同枱多張未結單 → 取 updatedAt 較新者
      const prev = openByTable.get(o.tableId);
      if (!prev || (o.updatedAt ?? "") > (prev.updatedAt ?? "")) openByTable.set(o.tableId, o);
    }

    return bootstrap.tables.map<StaffTable>((t) => {
      const order = openByTable.get(t.id);
      if (!order) {
        return { id: t.id, name: t.name, area: t.area, capacity: t.capacity, state: "free" };
      }
      return {
        id: t.id,
        name: t.name,
        area: t.area,
        capacity: t.capacity,
        state: isPayingState(order) ? "paying" : "busy",
        amount: order.total,
        order,
        partySize: order.partySize,
      };
    });
  }, [bootstrap.tables, localOrders, cloudOrders]);

  const selectedTable = useMemo(
    () => tables.find((t) => t.id === selectedTableId) ?? null,
    [tables, selectedTableId],
  );

  const categoryItems = useMemo(() => {
    const items = bootstrap.menuItems.filter((it) => it.categoryId === activeCategory);
    return items;
  }, [bootstrap.menuItems, activeCategory]);

  useEffect(() => {
    if (!activeCategory && bootstrap.categories[0]) {
      setActiveCategory(bootstrap.categories[0].id);
    }
  }, [activeCategory, bootstrap.categories]);

  const totals = useMemo(
    () =>
      computeOrderTotals(cart, {
        taxRate: bootstrap.rules.taxRate,
        serviceChargeRate: bootstrap.rules.serviceChargeRate,
      }),
    [cart, bootstrap.rules],
  );

  // ── 購物車 ──
  function newLineId() {
    return `stf-${crypto.randomUUID().slice(0, 8)}`;
  }

  const pushLine = useCallback((line: Omit<CartLine, "lineId" | "quantity">) => {
    setCart((prev) => mergeCartLine(prev, line, newLineId()));
  }, []);

  const addItem = useCallback(
    (item: PosBootstrap["menuItems"][number]) => {
      // 售罄：灰化保留（可向客人解釋），但唔准加落車。
      if (soldoutIds.has(item.id)) return;
      // 時價菜要店員當場輸入價錢 —— 唔喺呢度處理（需要額外彈窗），
      // 交返 UI 層用 `pushLine()` 自己帶價。
      if (item.isMarketPrice) return;
      pushLine({
        menuItemId: item.id,
        name: item.name,
        price: item.price,
        printerGroup: item.printerGroup,
        selectedSpecs: undefined,
      });
    },
    [soldoutIds, pushLine],
  );

  const changeQty = useCallback((lineId: string, delta: number) => {
    setCart((prev) => changeCartQty(prev, lineId, delta));
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  /**
   * 揀枱。有未結單 → 載入現有單嘅 items 落購物車（加菜模式）；
   * 空枱 → 清空購物車開新單。
   */
  const selectTable = useCallback(
    (tableId: string) => {
      setSelectedTableId(tableId);
      setError(null);
      setSubmitted(null);
      const t = tables.find((x) => x.id === tableId);
      if (t?.order) {
        setCart(
          t.order.items.map((it) => ({
            lineId: newLineId(),
            menuItemId: it.menuItemId,
            name: it.name,
            price: it.price,
            quantity: it.quantity,
            printerGroup: it.printerGroup,
            selectedSpecs: it.selectedSpecs,
            note: it.note,
          })),
        );
        setOrderNote(t.order.orderNote ?? "");
      } else {
        setCart([]);
        setOrderNote("");
      }
    },
    [tables],
  );

  const clearTable = useCallback(() => {
    setSelectedTableId(null);
    setCart([]);
    setOrderNote("");
    setError(null);
  }, []);

  const isAddOn = Boolean(selectedTable?.order);

  /** 總件數（quantity 加總）—— 見介面註解：唔係行數。 */
  const cartCount = useMemo(
    () => cart.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0),
    [cart],
  );

  const clearError = useCallback(() => setError(null), []);
  const reset = useCallback(() => {
    setSubmitted(null);
    setSelectedTableId(null);
    setCart([]);
    setOrderNote("");
    setError(null);
    draftOrderIdRef.current = null;
  }, []);

  // ── 送出 ──
  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    if (!storeId) {
      setError("未登入或帳戶未綁定店舖，請重新登入。");
      return;
    }
    if (!selectedTable) {
      setError("請先選擇枱號。");
      return;
    }
    if (cart.length === 0) {
      setError("購物車係空嘅。");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const items: StaffCartItem[] = cart.map((line) => ({
        menuItemId: line.menuItemId,
        name: line.name,
        price: line.price,
        quantity: line.quantity,
        printerGroup: line.printerGroup,
        selectedSpecs: line.selectedSpecs,
        note: line.note,
      }));

      const existing = selectedTable.order ?? null;
      const eventType: "ORDER_CREATED" | "ORDER_UPDATED" = existing ? "ORDER_UPDATED" : "ORDER_CREATED";

      // ── 單號：店員單一定有號（同掃碼單唔同）──
      let localOrderNo: string | undefined;
      if (!existing) {
        try {
          const seqRes = await fetch("/api/pos/sequence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "pos", storeId }),
          });
          if (seqRes.ok) {
            const p = (await seqRes.json()) as { display?: string };
            if (p.display) localOrderNo = p.display;
          }
        } catch {
          // 離線 → fallback
        }
        if (!localOrderNo) localOrderNo = nextLocalDailyOrderNo("pos", "堂食");
      }

      const order = existing
        ? applyStaffAddOn(existing, {
            items,
            taxRate: bootstrap.rules.taxRate,
            serviceRate: bootstrap.rules.serviceChargeRate,
            orderNote: orderNote || undefined,
          })
        : buildStaffOrder({
            tableId: selectedTable.id,
            tableName: selectedTable.name,
            items,
            taxRate: bootstrap.rules.taxRate,
            serviceRate: bootstrap.rules.serviceChargeRate,
            orderNote: orderNote || undefined,
            localOrderNo: localOrderNo!,
            // 同一輪重試重用同一個 id → server upsert 冪等（唔會變兩張單）。
            id: draftOrderIdRef.current ?? (draftOrderIdRef.current = newStaffOrderId()),
          });

      // 上送：用既有落單通道（含重試 / 業務拒絕分類 / 帶 POS 憑證）。
      const addedItems = existing ? diffAddedItems(existing.items, order.items) : undefined;
      await refreshPosDeviceTokenIfNeeded();
      await submitKioskOrder(storeId, order, eventType, addedItems);

      // ── 本地留底：令枱況 / 加菜判斷即時反映 ──
      const orders = loadOrders();
      const nextOrders = existing
        ? orders.map((o) => (o.id === order.id ? order : o))
        : [...orders, order];
      saveOrders(nextOrders);
      setLocalOrders(nextOrders);

      // ── 出紙：建廚房單 → **一定要用 appendPrintJobsWithSync** ──
      // 只 savePrintJobs() ＝ 零出紙（雲端 pos_print_jobs 冇行，中繼機 claim 唔到）。
      let kitchenJobCount = 0;
      if (isPrintContentEnabled("kitchen")) {
        const jobs = buildKitchenPrintJobs(order, {
          ticketType: existing ? "addon" : "normal",
          storeName: storeName || bootstrap.storeName || "門店",
          itemsOverride: existing ? addedItems : undefined,
        });
        kitchenJobCount = appendPrintJobsWithSync(jobs);
      }

      setSubmitted({ order, kitchenJobCount });
      draftOrderIdRef.current = null;
    } catch (e) {
      if (e instanceof KioskOrderRejectedError) {
        setError(e.message);
      } else if (e instanceof KioskOrderTransientError) {
        setError(`網絡唔穩定，訂單未確認送出：${e.message}。請保持購物車並重試。`);
      } else {
        setError(e instanceof Error ? e.message : "落單失敗，請重試。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [storeId, selectedTable, cart, orderNote, bootstrap, storeName]);

  return {
    hydrated,
    storeId,
    storeName,
    needsLogin,
    menuLoading,
    menuUnavailable,
    bootstrap,
    tables,
    tableStateStale,
    soldoutIds,
    activeCategory,
    setActiveCategory,
    categoryItems,
    selectedTable,
    selectTable,
    clearTable,
    cart,
    cartCount,
    totals,
    orderNote,
    setOrderNote,
    addItem,
    pushLine,
    changeQty,
    clearCart,
    isAddOn,
    submitting,
    error,
    clearError,
    submitted,
    submit,
    reset,
  };
}
