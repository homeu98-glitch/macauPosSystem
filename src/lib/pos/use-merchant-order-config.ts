"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  getMerchantOrderConfig,
  setMerchantAutoAccept,
  setMerchantOrderEnabled,
  type MerchantOrderConfig,
} from "@/lib/ledger/order-config";
import { UNKNOWN_ORDER_CONFIG } from "@/lib/ledger/order-config-parse";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import { getPosRealtimeConfig, getPosSupabaseClient } from "@/lib/pos/supabase-client";
import { createSingleFlight } from "@/lib/pos/single-flight";
import { loadPosLocalSettings, savePosLocalSettings } from "@/lib/storage";

/**
 * 商家接單設定（**開啟接單** + 自動接單）—— Ledger 真源，POS 只做鏡像。
 *
 * ── 三層各自嘅角色 ──────────────────────────────────────────────────────
 * 1. **Ledger（權威）**：店員 JWT 直連 RPC `get_merchant_order_config` /
 *    `merchant_set_order_enabled` / `merchant_set_auto_accept`
 *    （`src/lib/ledger/order-config.ts`）。改完**回傳整份 config**，唔使再 GET。
 * 2. **POS DB（鏡像）**：RPC 成功後將回傳值 POST 去 `/api/online-order-settings`。
 *    目的**唔係**存資料，係借用 0019 已經加好嘅 Realtime publication ——
 *    Ledger 冇 MQTT／webhook，一部收銀機關咗店，另一部唔會知；
 *    經 POS DB 廣播就即刻跟住變（docs/92 §1.2 同一個「冇渠道知」問題）。
 * 3. **localStorage（離線快取）**：`PosLocalSettings.onlineOrderSettings.autoAccept`
 *    （沿用，冇加欄 → 唔使改 `normalizePosLocalSettings` 白名單）。
 *
 * ── 點解係 module-level singleton ───────────────────────────────────────
 * `online-orders.tsx`、`pos-app.tsx`、快餐標題列、設備設定會**同時**要呢啲值。
 * 各自 `useState` 會開幾條 Realtime channel、打幾次 RPC，而且幾邊 state 會唔同步
 * （一邊顯示營業中、一邊顯示已暫停）。用 `useSyncExternalStore` 包一個 module store，
 * 全部 call site 共享同一份。
 *
 * ── 禁 polling ─────────────────────────────────────────────────────────
 * 只有兩個觸發點：mount 一次、`visibilitychange` 返前景補一次。冇 setInterval。
 */

export type MerchantOrderSaving = "none" | "merchant" | "auto";
export type MerchantOrderSource = "cache" | "server" | "realtime";

export type MerchantOrderConfigState = {
  /**
   * 「開啟接單」主開關。**`null` = 未讀到**（未登入 / Ledger 未提供該欄 /
   * 前端接錯 Supabase 專案）→ UI 一定要顯示「未接通」並停用，唔可以當 false。
   */
  merchantEnabled: boolean | null;
  autoAccept: boolean;
  adminEnabled: boolean | null;
  openNow: boolean | null;
  hoursEnabled: boolean | null;
  allowBalanceDeduct: boolean | null;
  allowPayInStore: boolean | null;
  status: string | null;
  /** 第一次 Ledger 讀取完成之前係 true（UI 可以用嚟 disable）。 */
  loading: boolean;
  saving: MerchantOrderSaving;
  error: string | null;
  /**
   * Ledger 通道可唔可以寫。`false` = RPC 未上線 **或** 冇店員 session
   * → UI 收埋開關（唔好畀人撳一粒零反應嘅掣），改為只顯示 POS 鏡像值。
   */
  available: boolean;
  /**
   * 跨機同步嘅實際能力：
   * - `instant`：其他收銀機 toggle 完**即時**跟住變（POS DB Realtime 真係訂到）
   * - `on-enter`：只會喺**入頁／返前景**重拉時更新
   *
   * 點解要分：`getPosSupabaseClient()` 未設 `NEXT_PUBLIC_POS_SUPABASE_URL` 時會
   * **退回 Ledger 專案**，而鏡像表 `pos_online_order_settings` 唔喺嗰度 ——
   * Supabase **唔會報錯**（channel 照樣 SUBSCRIBED），係典型靜默失效
   * （同 docs/reviews/qr-self-order-audit-2026-09-10.md 附錄 B.6 同一個坑）。
   * 唔可以靜靜當「即時」。
   */
  crossTerminalSync: "instant" | "on-enter";
  /** 而家顯示緊嘅值係邊度嚟。 */
  source: MerchantOrderSource | null;
};

const INITIAL: MerchantOrderConfigState = {
  merchantEnabled: null,
  autoAccept: UNKNOWN_ORDER_CONFIG.autoAccept,
  adminEnabled: null,
  openNow: null,
  hoursEnabled: null,
  allowBalanceDeduct: null,
  allowPayInStore: null,
  status: null,
  loading: true,
  saving: "none",
  error: null,
  available: true,
  crossTerminalSync: "on-enter",
  source: null,
};

let state: MerchantOrderConfigState = INITIAL;
const listeners = new Set<() => void>();

/**
 * 唯讀快照（2026-09-21）。
 *
 * 用途：畀**非 React 呼叫端**讀（輪詢閘要判斷「線上通路係咪都關咗」）。
 * 純讀取 —— **唔會**發請求、唔會改 state、唔會 notify。React component 繼續用
 * `useMerchantOrderConfig()`。
 */
export function getMerchantOrderConfigSnapshot(): MerchantOrderConfigState {
  return state;
}

let activeStoreId: string | null = null;
let refCount = 0;
let channel: ReturnType<
  NonNullable<ReturnType<typeof getPosSupabaseClient>>["channel"]
> | null = null;
let cacheHydrated = false;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<MerchantOrderConfigState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function getServerSnapshot() {
  return INITIAL;
}

/** 由 RPC / Realtime 回傳嘅 config 併入 state。 */
function applyConfig(config: MerchantOrderConfig, source: MerchantOrderSource) {
  setState({
    merchantEnabled: config.merchantEnabled,
    autoAccept: config.autoAccept,
    adminEnabled: config.adminEnabled,
    openNow: config.openNow,
    hoursEnabled: config.hoursEnabled,
    allowBalanceDeduct: config.allowBalanceDeduct,
    allowPayInStore: config.allowPayInStore,
    status: config.status,
    loading: false,
    saving: "none",
    error: null,
    available: true,
    source,
  });
  writeCache(config.autoAccept);
}

/** 寫 localStorage 快取（離線時用家撳掣仍然有反應）。 */
function writeCache(autoAccept: boolean) {
  if (typeof window === "undefined") return;
  try {
    const current = loadPosLocalSettings();
    savePosLocalSettings({
      ...current,
      onlineOrderSettings: { ...current.onlineOrderSettings, autoAccept },
    });
  } catch {
    // 快取寫唔到唔好拖累主流程
  }
}

/** 第 1 步：用 localStorage 快取做初值（只做一次）。 */
function hydrateFromCache() {
  if (cacheHydrated || typeof window === "undefined") return;
  cacheHydrated = true;
  try {
    setState({ autoAccept: loadPosLocalSettings().onlineOrderSettings.autoAccept, source: "cache" });
  } catch {
    // 讀唔到就用 default
  }
}

/**
 * in-flight 去重（**single-flight**，2026-09-21 請求數優化）。
 *
 * ## 為咩要（實測）
 *
 * Supabase log 實測：`pos_online_order_settings` 喺**同一秒**出現 **4~5 次**：
 * `23:06 ×4`、`35:29 ×5`、`36:42 ×1`、`36:43 ×3`。
 * 根因：呢個檔係 module-level store（一份 state），但 `refreshMirror()` /
 * `refreshFromLedger()` **係喺每個 mount 嘅 effect 內各自呼叫** ——
 * 而 POS 主畫面同時有 4~5 個 component 用同一個 hook
 *（`pos-app`、`store-open-pill`、`online-open-pill`、`quick-mode-orders-bar`、
 *  `merchant-order-config-section`）⇒ **5 個 mount ＝ 5 個 GET**。
 *
 * ## 為何呢個改動係**零功能影響**
 *
 * · 同一個 `storeId`、同一刻嘅重複呼叫 → 只發**一個**請求，**所有人共用同一個 promise**
 *   ⇒ 每個 mount 一樣會等到「同一次讀取嘅結果」（值本身完全相同）。
 * · 唔涉及任何「時間窗」（唔係「X 秒內唔拉」）—— **只合併同刻並發**，
 *   所以唔會改變「幾時會讀到新值」嘅語義。
 * · 🔴 一定要**按 storeId 分開**：切店時舊 promise 唔可以餵落新店
 *   ⇒ key 用 `storeId`，唔匹配就開新 flight。
 * · 🔴 失敗一定要喺 `.finally()` 清走，否則一次失敗會令之後所有呼叫
 *   共用同一個**已失敗**嘅 promise（永遠拿唔到值）。
 * · 失敗之後嘅行為不變：`refreshFromLedger` 內部仍然係「讀唔到就靜靜用快取」。
 */
const ledgerFlight = createSingleFlight<void>();
const mirrorFlight = createSingleFlight<void>();

/**
 * 回到前景補拉用嘅**單一** listener（module-level，2026-09-21 請求數優化）。
 *
 * ## 為何唔可以每個 mount 各掛一個
 *
 * 原本寫法係喺 `useMerchantOrderConfig` 嘅 effect 內 `document.addEventListener(...)`，
 * 而 POS 主畫面有 4~5 個 component 用同一個 hook ⇒ **一次切返前景會發 4~5 次**
 * `refreshFromLedger()` ＋ 4~5 次 `refreshMirror()`（實測 Supabase 同一秒 4~5 次）。
 *
 * ## 為何零功能影響
 *
 * 原本 N 個 listener 各自做「同一件事、同一個 store」；收成一個之後
 * **結果完全一樣**（值相同），只係做少幾次重複請求。
 * `refCount === 0`（全部卸載）或 `activeStoreId` 為 null（未登入）時一樣 no-op。
 *
 * ⚠️ 刻意**唔加**「X 秒內唔拉」嘅時間窗 —— 嗰樣會改變「幾時讀到新值」嘅語義。
 */
let visibilityListenerInstalled = false;

function ensureVisibilityListener() {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const store = activeStoreId;
    if (!store) return; // refCount 0 / 未登入 → no-op（同原本一樣）
    void refreshFromLedger(store);
    void refreshMirror(store);
  });
}

/** 讀 Ledger（權威）。 */
async function refreshFromLedger(storeId: string) {
  return ledgerFlight(storeId, () => runRefreshFromLedger(storeId));
}

async function runRefreshFromLedger(storeId: string) {
  const result = await getMerchantOrderConfig(storeId);

  if (result.ok) {
    applyConfig(result.config, "server");
    return;
  }

  if (result.code === "unavailable" || result.code === "unauthorized") {
    // - `unavailable`：Ledger 未提供呢套 RPC（migration 未上線 / 前端接錯 Supabase 專案）
    // - `unauthorized`：冇店員 session（例如 admin 模式）
    // 兩者都係「Ledger 通道用唔到」，唔係「操作失敗」→ 收埋開關，改為靠 POS 鏡像表顯示。
    // **唔**當紅色錯誤嚇收銀（同舊版「server 讀唔到就靜靜用快取」一致）。
    setState({ loading: false, available: false, error: null });
    return;
  }

  setState({ loading: false, error: result.message });
}

/**
 * 讀 POS 鏡像表（`pos_online_order_settings`）。
 *
 * 只補**未知**嘅欄位：Ledger RPC 已經權威讀到嘅值，唔可以用鏡像覆蓋
 * （鏡像可能係幾日前寫落嘅舊值）。
 */
async function refreshMirror(storeId: string) {
  return mirrorFlight(storeId, () => runRefreshMirror(storeId));
}

async function runRefreshMirror(storeId: string) {
  try {
    const response = await fetch(
      `/api/online-order-settings?storeId=${encodeURIComponent(storeId)}`,
      // 🔒 2026-09-15：該端點已加鑑權閘 → 必須帶 POS 終端憑證（會自動續期）。
      { headers: await posDeviceAuthHeadersFresh(), cache: "no-store" },
    );
    if (!response.ok) return;

    const payload = (await response.json()) as {
      ok?: boolean;
      autoAccept?: boolean | null;
      merchantEnabled?: boolean | null;
    };

    const patch: Partial<MerchantOrderConfigState> = {};
    if (typeof payload.autoAccept === "boolean" && state.source !== "server" && state.source !== "realtime") {
      patch.autoAccept = payload.autoAccept;
      writeCache(payload.autoAccept);
    }
    if (typeof payload.merchantEnabled === "boolean" && state.merchantEnabled === null) {
      patch.merchantEnabled = payload.merchantEnabled;
    }
    if (Object.keys(patch).length > 0) setState(patch);
  } catch {
    // 離線：維持快取值
  }
}

/** RPC 成功之後將回傳值鏡像去 POS DB（跨機 Realtime 廣播用）。失敗唔 rollback。 */
async function mirrorToPosDb(
  storeId: string,
  values: { autoAccept?: boolean; merchantEnabled?: boolean },
) {
  try {
    const response = await fetch("/api/online-order-settings", {
      method: "POST",
      // 🔒 2026-09-15：該端點已加鑑權閘 → 必須帶 POS 終端憑證（會自動續期）。
      headers: { "Content-Type": "application/json", ...(await posDeviceAuthHeadersFresh()) },
      body: JSON.stringify({ storeId, ...values }),
    });
    if (!response.ok && process.env.NODE_ENV !== "production") {
      console.warn("[merchant-order-config] 鏡像寫入失敗：HTTP", response.status);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[merchant-order-config] 鏡像寫入失敗（離線？）", err);
    }
  }
}

/** 第 3 步：訂閱 Realtime，其他收銀機 toggle 完即時跟住變（**唔 polling**）。 */
function subscribeRealtime(storeId: string) {
  const supabase = getPosSupabaseClient();
  if (!supabase) {
    setState({ crossTerminalSync: "on-enter" });
    return;
  }

  // 🔴 先確認連線目標係 POS 專案。退回 Ledger 專案時，鏡像表根本唔喺嗰邊 ——
  // channel 會照樣 SUBSCRIBED 但永遠收唔到事件（Supabase 唔會報錯）→ 靜默失效。
  // 呢個唔使額外網絡請求：`resolvePosRealtimeConfig()` 靠 env 就判得出。
  // 詳細探測（表唔存在／key 唔啱）由 `pos-app.tsx` / KDS 嘅 `probePosRealtimeTarget()` 負責。
  const target = getPosRealtimeConfig();
  if (!target || target.source !== "pos") {
    setState({ crossTerminalSync: "on-enter" });
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[merchant-order-config] 跨機即時同步未生效：POS Realtime 退回 Ledger 專案（source=" +
          `${target?.source ?? "none"}, host=${target?.url ?? "?"}）` +
          " → 需要設 NEXT_PUBLIC_POS_SUPABASE_URL / _ANON_KEY 並重新部署。",
      );
    }
    return;
  }

  channel = supabase
    .channel(`pos-merchant-order-config:${storeId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pos_online_order_settings",
        filter: `store_id=eq.${storeId}`,
      },
      (payload) => {
        const row = payload.new as {
          store_id?: string;
          auto_accept?: boolean;
          merchant_enabled?: boolean;
        } | null;
        if (!row) return;

        const patch: Partial<MerchantOrderConfigState> = { source: "realtime" };
        if (typeof row.auto_accept === "boolean") {
          patch.autoAccept = row.auto_accept;
        }
        if (typeof row.merchant_enabled === "boolean") {
          patch.merchantEnabled = row.merchant_enabled;
        }
        setState(patch);
        if (typeof row.auto_accept === "boolean") writeCache(row.auto_accept);
      },
    )
    .subscribe();

  setState({ crossTerminalSync: "instant" });
}

function unsubscribeRealtime() {
  if (!channel) return;
  void channel.unsubscribe();
  channel = null;
}

/**
 * 開 / 關「接單」（Ledger `merchant_enabled`）—— **模組層實作**
 * （hook 內嘅 `setMerchantEnabled` 直接轉呼叫呢個）。
 *
 * ── 點解要抽成模組層函式（2026-09-18）──────────────────────────────────
 * 「結數交班時一齊關店」嘅 `closeShift()`（`shift-page.tsx`）係普通 async function，
 * **唔可以**呼叫 hook（違反 Hooks 規則），但佢一定要寫 Ledger 呢一欄。
 * 抽喺模組層 → hook 同交班流程行同一段碼，唔會有第二份實作。
 *
 * ── 紀律（唔可以省）──────────────────────────────────────────────────────
 * - `previous === null`（未讀到）→ **直接拒絕**，唔准樂觀寫（會令收銀見到假狀態）。
 *   交班流程遇到呢個情況應該當「跳過」而唔係「失敗」—— 本來就冇值可以關。
 * - 失敗 **rollback 成 `previous`**，並且唔會 rollback 已鏡像落 POS DB 嘅值。
 *
 * @returns `true` = Ledger 已接受（UI 用嚟決定要唔要出 success toast）。
 */
export async function applyMerchantEnabled(next: boolean): Promise<boolean> {
  const store = activeStoreId;
  const previous = state.merchantEnabled;

  if (!store) {
    setState({ error: "尚未登入 Ledger，無法開關接單。" });
    return false;
  }
  if (previous === null) {
    // 未讀到就唔好亂寫 —— 樂觀更新會令收銀見到一個假狀態
    setState({ error: "未讀到 Ledger 接單狀態，請重新載入頁面。" });
    return false;
  }

  setState({ merchantEnabled: next, saving: "merchant", error: null });

  const result = await setMerchantOrderEnabled(store, next);
  if (result.ok) {
    // RPC 回傳就係最新狀態；merchantEnabled 缺欄時保留今次意圖值
    applyConfig(
      { ...result.config, merchantEnabled: result.config.merchantEnabled ?? next },
      "server",
    );
    void mirrorToPosDb(store, {
      merchantEnabled: result.config.merchantEnabled ?? next,
      autoAccept: result.config.autoAccept,
    });
    return true;
  }

  setState({
    merchantEnabled: previous,
    saving: "none",
    error: result.message,
    available: result.code !== "unavailable",
  });
  return false;
}

/**
 * 商家接單設定（開啟接單 + 自動接單）。
 *
 * @param storeId 商家 id（`loadAuthSession()?.merchantId`，同 Ledger `merchant_id` 同一套）
 * @param enabled 關掉就唔拉資料、唔訂閱（例如離線模式）
 */
export function useMerchantOrderConfig(storeId: string | null, enabled = true) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!enabled || !storeId) {
      // 唔會拉資料（未登入 / 離線模式 / admin 模式）→ **唔可以**永遠顯示「讀取中…」。
      // ⚠️ 但 `merchantEnabled` 要繼續保持 `null`（＝「未接通」）：真係未讀到，
      //    唔可以假裝營業中或者已暫停。
      if (state.loading) setState({ loading: false });
      return;
    }

    refCount += 1;
    activeStoreId = storeId;
    hydrateFromCache();
    setState({ loading: true });

    // 先讀 POS 鏡像（快，唔使 Ledger token），再用 Ledger RPC 覆蓋成權威值
    void refreshMirror(storeId);
    void refreshFromLedger(storeId);
    if (refCount === 1) subscribeRealtime(storeId);

    // 後備：由背景切返前景時補拉一次。唔係 polling —— 淨係用家真係返嚟嗰陣先 call。
    // 點解要：Ledger 側（Ledger Web / 另一部 Android）改咗 merchant_enabled 冇任何推播，
    // 呢條保證收銀返嚟之後最多一秒內見到正確狀態。
    //
    // 🔴 2026-09-21 請求數優化：改為**模組層單一 listener**（原本係每個 mount 各掛一個，
    //    而 POS 主畫面有 4~5 個 component 用同一個 hook ⇒ 一次返前景爆 4~5 次 ×2 個請求）。
    //    值完全一樣，只係唔再重複打；`activeStoreId` 為 null 時一樣 no-op。
    ensureVisibilityListener();

    return () => {
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        activeStoreId = null;
        unsubscribeRealtime();
      }
    };
  }, [enabled, storeId]);

  /**
   * 開店 / 關店。回傳 `true` = Ledger 已接受（UI 用嚟決定要唔要出 success toast）。
   *
   * ⚠️ 只改 `merchant_enabled`。**唔會**順手寫 `auto_accept`／時段／付款方式。
   */
  const setMerchantEnabled = useCallback(async (next: boolean): Promise<boolean> => applyMerchantEnabled(next), []);

  /**
   * 自動接單（真源 = Ledger RPC）。
   *
   * 失敗處理分兩種：
   * - `unavailable`（Ledger 未接呢支 RPC）→ 退返舊嘅「純鏡像」路徑，保留樂觀值，
   *   唔好因為 Ledger 未上線而令收銀完全冇得設 —— 同 docs/92 §4.4「Ledger 失敗唔 rollback」一致。
   * - 其餘（真拒絕 / 冇權限）→ rollback + 顯示原因。
   */
  const setAutoAccept = useCallback(async (next: boolean): Promise<boolean> => {
    const store = activeStoreId;
    const previous = state.autoAccept;

    setState({ autoAccept: next, saving: "auto", error: null });
    writeCache(next);

    if (!store) {
      // 冇登入記錄：淨係落快取（同 docs/92 §6.3 離線語意一致）
      setState({ saving: "none" });
      return true;
    }

    const result = await setMerchantAutoAccept(store, next);
    if (result.ok) {
      applyConfig(
        { ...result.config, merchantEnabled: result.config.merchantEnabled ?? state.merchantEnabled },
        "server",
      );
      void mirrorToPosDb(store, {
        autoAccept: result.config.autoAccept ?? next,
        merchantEnabled: result.config.merchantEnabled ?? undefined,
      });
      return true;
    }

    if (result.code === "unavailable") {
      setState({ saving: "none", available: false, error: null });
      await mirrorToPosDb(store, { autoAccept: next });
      return true;
    }

    setState({ autoAccept: previous, saving: "none", error: result.message });
    writeCache(previous);
    return false;
  }, []);

  /** 手動重新讀 Ledger（設定頁「重新整理」掣用）。 */
  const refresh = useCallback(async () => {
    const store = activeStoreId;
    if (!store) return;
    setState({ loading: true, error: null });
    await refreshFromLedger(store);
  }, []);

  return {
    ...snapshot,
    setMerchantEnabled,
    setAutoAccept,
    refresh,
  };
}
