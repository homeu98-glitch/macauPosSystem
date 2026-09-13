"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { mockBootstrap } from "@/lib/mock-data";
import { loadBootstrapCache, saveBootstrapCache, nextLocalDailyOrderNo, loadKioskPrinters, saveKioskPrinters } from "@/lib/storage";
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
  quickScanOfflineOrderNo,
  saveKioskDeviceBinding,
  submitKioskOrder,
} from "@/lib/kiosk-order";
import {
  clearQuickScanLastOrder,
  saveQuickScanLastOrder,
} from "@/lib/pos/quick-scan-remembered-order";
import { applyPosDeduct } from "@/lib/ledger/members";
import {
  buildDeductIdempotencyKey,
  formatElapsed,
  formatRetryClock,
  isPinFree,
  mopToAvos,
  type MemberPayMethod,
  type MemberPayStage,
} from "@/lib/ledger/member-pay";
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

/**
 * 已登入嘅會員會話（**只存在記憶體，禁止持久化**）。
 *
 * 🔴 個資紅線（Ledger 契約 §7.2）：`displayName` / 餘額**只准當次 UI 渲染** ——
 *    禁寫入 `localStorage` / POS Supabase / analytics / console。
 *    落 POS 訂單只准落 `customerId`（uuid），**唔准落電話**。
 *
 * 🔴 亦**唔會**持有任何 Ledger token：顧客憑證留喺 server 側
 *    （見 `member-login.server.ts` — Kiosk 係共用平板，唔應該留低顧客憑證）。
 */
export type OrderingMember = {
  customerId: string;
  /**
   * 登入用嘅電話號碼。
   *
   * ⚠️ **唯一用途**：呼叫 Ledger 扣款 RPC（`merchant_apply_pos_txn` 需要 `p_phone`，
   *    §5.7）。Ledger 端係按電話搵錢包，冇第二條路。
   *
   * 🔴 界線（契約 §7.2 嘅立法原意 = 防止個資被**持久化 / 外洩**）：
   *    - ✅ 准：存在 React state（記憶體），喺同一次請求內做參數。
   *    - ❌ 禁：渲染成畫面上嘅文字（UI 只顯示 `displayName`，唔顯示電話）、
   *      寫 `localStorage` / `sessionStorage` / POS Supabase / analytics / `console.*`。
   *    - ❌ 禁：落 POS 訂單 —— 訂單只准 `customerId`（uuid）。
   *    即係話：呢個欄位**唔可以**傳落 `placeOrder()` 之外嘅地方。
   */
  phone: string;
  displayName: string | null;
  balanceAvos: number;
  giftBalanceAvos: number;
  /** 登入成功時間戳 —— 免 PIN 180 秒窗口嘅**唯一**起計點（refresh 唔可延長）。 */
  loggedInAt: number;
  /**
   * 顧客 Ledger access token —— **只掃碼（客人自己手機）有**。
   *
   * v3.5 `scan-debit/quote|commit` 嘅 `Authorization: Bearer` 需要它。
   * ⚠️ Kiosk 一律 `undefined`（共用平板唔應該留顧客憑證；Kiosk 走店員 RPC 唔需要）。
   * 🔴 只准存在記憶體 —— 禁 sessionStorage / localStorage / console。
   */
  customerAccessToken?: string;
  /**
   * 免 PIN 窗口票（server 簽發，綁 customerId + 到期時間，TTL 180s）。
   *
   * 🔴 Ledger **完全唔驗 PIN**（Q5）→ 呢張票係唯一二次確認防線。
   *    過期／缺失 → server 回 `pin_required`，要客人重新入 PIN。
   */
  pinWindowToken?: string;
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

    // ── 會員登入 + 付款（2026-09-13，確認稿 member-login-payment-flow）──
    // 🔴 呢批文案同確認稿逐字對齊。改文案要同步改確認稿，否則下次對稿又會漂移。
    memberAskTitle: "你是會員嗎？",
    memberAskSubtitle: "使用會員儲值餘額付款，結帳更快",
    memberAskSubtitleKiosk: "使用會員儲值餘額付款，結帳更快；非會員亦可直接點餐，到櫃檯付款",
    memberNonMemberHint: "非會員亦可直接點餐，到前台付款",
    memberYes: "是，我是會員",
    memberNo: "不是，直接點餐",
    memberLoginHint: "會員登入後可查看儲值餘額並直接扣款",
    memberForgotPin: "忘記 PIN？請到前台由店員協助",
    memberLoginTitle: "會員登入",
    memberLoginSubtitle: "請輸入會員帳號及 PIN 碼",
    memberPhoneLabel: "會員帳號（手機號碼）",
    memberPinLabel: "PIN 碼（4 位數字）",
    memberLoginSubmit: "登入並繼續點餐",
    memberLoginSkip: "跳過，直接點餐",
    memberPinIssuedHint: "PIN 碼由店員發出，如需協助請到前台",
    memberLockWarning: "連續 5 次錯誤將鎖定 15 分鐘",
    memberLoginFailed: "帳號或 PIN 不正確",
    memberRemainingAttempts: "剩餘 {n} 次機會",
    memberRetryInput: "重新輸入",
    memberLockedTitle: "帳號已暫時鎖定",
    memberLockedReason: "連續 5 次輸入錯誤",
    memberLockedRetryAt: "請於 {time} 後再試",
    memberStillCanOrder: "仍然可以點餐",
    memberLockedExplain: "鎖定只影響「扣餘額」。你仍然可以直接點餐，完成後到前台付款即可。",
    memberSwitchToGuest: "改用非會員，直接點餐",
    memberBalanceLabel: "儲值餘額",
    // 付款方式（S6）
    payTitle: "選擇付款方式",
    payAmountLabel: "應付總額",
    payOptionBalance: "扣會員儲值餘額",
    payBalanceAfter: "餘額 {balance} → 扣後剩 {after}",
    payInsufficientShort: "餘額不足 · 尚欠 {short}",
    payInsufficientTitle: "餘額不足",
    payOptionCounter: "到前台支付",
    payOptionCounterHint: "落單後去櫃檯付款（現金 / 電子支付）",
    payNoPartialHint: "暫不支援「先扣餘額、差額到前台補」（會產生兩筆對帳），請改用「到前台支付」。",
    payConfirm: "確認付款",
    // 扣款確認（S7）
    deductTitle: "確認扣款",
    deductAmountLabel: "扣款金額",
    deductMemberLabel: "會員",
    deductBalanceBefore: "扣款前餘額",
    deductBalanceAfter: "扣款後餘額",
    deductNeedPin: "請再次輸入 PIN 碼確認",
    deductPinFree: "免 PIN（登入後 180 秒內）",
    deductPinFreeHint: "你已於 {ago} 前完成登入，可直接確認。",
    deductPinFreeGuard: "保障：登入後 3 分鐘內才免 PIN。",
    deductConfirm: "確認扣款",
    deductCancelToCounter: "取消，改為到前台支付",
    // 結果（S8）
    deductSuccess: "扣款成功",
    deductSuccessBody: "已從會員儲值餘額扣款",
    deductRemainingBalance: "剩餘餘額",
    deductTxnId: "交易編號",
    resultPlacedTitle: "落單成功",
    resultPayAtCounter: "請到前台付款",
    resultPendingAmount: "待付金額",
    resultOrderStatus: "訂單狀態",
    resultPendingPayment: "待付款",
    resultKitchenSent: "訂單已直接送往廚房，無需等候確認。",
    resultKitchenSentAfterPay: "訂單已送往廚房。付款完成後，桌台會顯示為「已結帳」。",
    // 異常（S9）
    payInsufficientKept: "訂單已保留",
    payInsufficientKeptBody: "你嘅訂單唔會取消，可以直接改為到前台付款，唔需要重新點餐。",
    payBackToCounter: "改為到前台支付",
    payChooseAgain: "重新選擇付款方式",
    deductUnknownTitle: "連線中斷",
    deductUnknownSub: "未能確認扣款結果",
    deductUnknownKeep: "請勿關閉此頁",
    deductUnknownBadge: "結果未知",
    deductUnknownBody: "系統無法查詢呢筆扣款到底成功咗未。撳「重試」會用同一筆交易再送一次（唔會重複扣）。",
    deductUnknownHint: "如多次失敗，請到前台由店員處理。",
    deductRetry: "重試（不會重複扣款）",
    deductGoCounter: "到前台處理",
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
  //
  // 🔴🔴 2026-09-13 J 實案修正：**掃碼（手機）唔可以讀 `kiosk-started`**。
  //
  // 舊寫法無論 kiosk 定掃碼都讀同一個 sessionStorage key，於是：
  //   客人撳過一次「開始點餐」（舊版 Landing 嘅唯一掣）→ key 記住 1 →
  //   之後**任何 reload / 重新開 link 都直接跳過 Landing**。
  // 結果：新加嘅「你是會員嗎？」同會員登入**永遠冇機會出現** —— 客人只會直接落入餐牌。
  // （J 2026-09-13 堂食掃碼實案：「見唔到會員登入」。）
  //
  // 口徑：只有 **Kiosk**（店內平板）需要記 —— 同一部機、同一 session，
  // 落完單返 Landing 再開新單，但中途網絡抖動 reload 時唔想彈返 Landing 重新撳。
  // 客人手機掃碼每次都要由 Landing 開始（會員問句就係 Landing 嘅一部分）。
  const persistStarted = variant !== "scan";
  const [started, setStarted] = useState(
    () =>
      persistStarted &&
      typeof window !== "undefined" &&
      window.sessionStorage.getItem("kiosk-started") === "1",
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

  // ── 會員登入 + 付款（2026-09-13，確認稿 member-login-payment-flow）──
  // 🔴 全部只係**記憶體** state —— 唔入 localStorage / sessionStorage（個資紅線 §7.2），
  //    亦刻意唔會因為 reload 而復原：Kiosk 係共用平板，上一位客人嘅會員狀態
  //    一定要喺「倒數歸零 / 返回主頁」時徹底清走（見 `returnToHome()` 嘅硬重置）。
  const [member, setMember] = useState<OrderingMember | null>(null);
  const [memberLoginOpen, setMemberLoginOpen] = useState(false);
  const [memberLoginSubmitting, setMemberLoginSubmitting] = useState(false);
  const [memberLoginError, setMemberLoginError] = useState<string | null>(null);
  const [memberLoginRemaining, setMemberLoginRemaining] = useState<number | null>(null);
  /** 已鎖定時嘅解鎖時間戳（ms）；null = 未鎖。 */
  const [memberLoginLockedUntil, setMemberLoginLockedUntil] = useState<number | null>(null);
  // 付款 sheet
  const [paySheetOpen, setPaySheetOpen] = useState(false);
  const [payStage, setPayStage] = useState<MemberPayStage>("choose");
  const [payMethod, setPayMethod] = useState<MemberPayMethod | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  /** 免 PIN 倒數用嘅 tick —— 只有喺 `deduct` 階段先會跑（避免無謂 render）。 */
  const [payTick, setPayTick] = useState(() => Date.now());
  /** 扣款成功收據（成功頁顯示 `txn_*` + 剩餘餘額）。 */
  const [deductReceipt, setDeductReceipt] = useState<{
    txnId: string;
    balanceAfterAvos: number;
    pointsEarnedAvos?: number;
  } | null>(null);
  /**
   * 掃碼扣款嘅「未完成報價」（v3.5 quote）。
   *
   * 🔴 為咩要留住：commit 網絡失敗 = **結果未知**（Ledger 冇 lookup API，Q6）。
   *    重試時**一定要**重用同一個 `quoteId` / `quoteSig` —— Ledger 會回**同一** `txnId`
   *    （唔會雙扣）。如果重新 quote 就會變成一筆新交易 → 客人被扣兩次。
   */
  const [pendingQuote, setPendingQuote] = useState<{ quoteId: string; quoteSig: string } | null>(null);
  /**
   * `member` 嘅**同步鏡像**。
   *
   * 🔴 為咗咩要呢個：`confirmDeduct` 驗 PIN 成功之後會 `setMember({... pinWindowToken: 新票})`，
   *    但同一輪嘅 closure 仍然係**舊** `member` → 跟住即刻呼叫嘅 `runScanDebit` 會讀到**舊票**
   *    → server 回 `pin_required` → 客人再入 PIN → 又舊票 → **死循環**。
   *    React state 非同步，所以要用 ref 讀「啱啱寫入」嘅值。
   */
  const memberRef = useRef<OrderingMember | null>(null);

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
    /**
     * ⚠️ 快餐掃碼（`/quick`，`variant === "scan"` 但**冇台號**）**完全唔 resume**（docs/115 G2/G3）。
     *
     * 快餐係「一單一單獨立」—— 冇「本枱現有單」呢個概念。舊版會用 sessionStorage
     * 嘅 `kiosk-last-order` 撈返客人自己上一張快餐單（`source === "scan"` 且未結），
     * 於是客人再點餐會變成「加單」落到舊單度；而 `activeTableOrder` 對快餐又永遠係
     * `null`（quick 模式唔保留本枱單）→ 兩邊唔一致，行為同 kiosk 快餐唔同。
     *
     * 所以快餐掃碼一律當新單：唔查 DB、唔 resume。（kiosk 唔受影響：`isScanLink` false，
     * 而且 `fetchScanOrderById()` 只認 `source === "scan"`，kiosk 單本身撈唔到。）
     */
    if (variant === "scan" && !tableId) return;
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

  /**
   * 落單模式（規格 5：**自助點餐機只做快餐**）。
   *
   * ⚠️ 2026-09-11 修：舊版係 `tableId ? "dine_in" : "quick"` —— 即係只要 URL 帶到
   * `?tableId=` 就會變堂食。`/order`（kiosk 裝置）正常唔會帶台號，但呢個寫法令
   * 「kiosk 只做快餐」**只係隱含**（靠冇 UI 產生台號），唔係規則。
   * 一旦有 QR / 舊連結 / 人手打 `/order?tableId=A01`，自助機就會落一張堂食單。
   *
   * 改為**以 `variant` 為準**：只有「客人掃枱 QR」（`variant === "scan"` 且真係帶台號）
   * 才係堂食；其餘一律快餐。
   *   - `/order`（variant="kiosk"）→ 永遠 quick，唔理 URL 有咩參數 ✅
   *   - `/menu?tableId=A01`（variant="scan"）→ dine_in ✅ 堂食掃碼照舊
   *   - `/quick?store=x`（variant="scan"、冇台號）→ quick ✅
   */
  const mode: "dine_in" | "quick" = variant === "scan" && tableId ? "dine_in" : "quick";

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

      // 落單號碼（需求 2 / docs/115：呢度就係「兩套流程」嘅分水嶺）。
      //
      // ── 堂食掃碼（/menu?tableId=，isScanLink && dine_in）──
      // **完全唔產生單號**：唔打 /api/pos/sequence、唔叫 nextLocalDailyOrderNo()、
      // 唔燒店內序號資源。訂單標識就係台號（由 buildKioskOrder 嘅 orderNoSource:"table"
      // 直接寫台名）。客人端亦唔會顯示任何單號。
      //
      // ── 自助點餐機（kiosk）／快餐掃碼（/quick）──
      // 跟店內線下同日序號（/api/pos/sequence），kind 對齊店內
      // （堂食→pos、自取→pickup），攞唔到先 fallback。
      //
      // ⚠️ 2026-09-10 docs/115 G2：**快餐掃碼必須行呢條路**。快餐冇台號
      // （tableId="counter"、tableName="自取"），如果照堂食咁拎台名做單號，
      // 全店快餐單會統統叫「自取」→ 廚房單／標籤／收據／POS 列表分唔清邊張打邊張。
      // 快餐同 kiosk 共用同一條 `pickup` 序號 → 兩邊號碼天然唔會撞（in sync）。
      const seqKind = mode === "dine_in" ? "pos" : "pickup";
      const needsSequence = !isScanLink || mode === "quick";
      let localOrderNo: string | undefined;
      if (needsSequence) {
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
          //
          // ⚠️ 例外：**快餐掃碼離線**唔可以用本地每日序號（docs/115 R2）。
          // 客人手機同收銀機係兩部唔同裝置，兩邊各自由「自取01」開始數 → 必撞。
          // 改用明顯非序號嘅短後綴（`自取-K7Q2`），收銀一眼睇得出未對號。
          localOrderNo =
            isScanLink && mode === "quick"
              ? quickScanOfflineOrderNo()
              : nextLocalDailyOrderNo(seqKind, mode === "dine_in" ? "堂食" : "自取");
        }
      }

      // 「自動接自助單」開關 ＋「自助點餐機專屬打印機」嘅真源都喺 DB（`pos_kiosk_settings`），
      // 落單當刻先攞一次（禁 polling）。
      // 離線 / 後端失敗 → fallback 自動接單（規格 5：免確認直接出單係開關嘅預設值）。
      //
      // ⚠️ 打印機清單要傳入本機快取做底：`resolveJobPrinter()` 係**同步**函數，
      // 出紙嗰刻唔可以等 HTTP。server 攞唔到時照用快取，令斷網都印得到。
      const kioskSettings = await fetchKioskSettings(storeId, {
        fallbackPrinters: loadKioskPrinters(),
      });
      // 只有**真係 server 回嘅值**先寫快取（`fromServer`）。
      // 離線時 `printers` 係本機快取原值，寫返落去無害；但若 server 明確清空設定
      // （空陣列）就一定要跟住清 —— 分唔清「server 話冇」同「攞唔到」就會兩邊都錯。
      // 必須喺下面 `printKioskReceiptForOrder()` **之前**寫，因為 builder 會即刻讀快取。
      if (kioskSettings.fromServer) {
        saveKioskPrinters(kioskSettings.printers);
      }

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
        // 需求 2 / docs/115：只有**堂食**掃碼唔行「單號」邏輯（以台號作訂單標識）；
        // kiosk 同快餐掃碼一律用店內序號。
        orderNoSource: isScanLink && mode === "dine_in" ? "table" : "sequence",
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
          //
          // ⚠️ 2026-09-11 修：舊版隊列滿會**丟走最舊一張單**再照樣當成功 ——
          // 客人見到「已收到，同步中」，但嗰張單永遠上唔到雲（廚房漏單）。
          // 所以滿咗就直接報錯，唔扮成功；購物車保留，客人可以再試。
          const enqueueResult = enqueuePendingKioskOrder(storeId, order, eventType, addedItems);
          setPendingSyncCount(enqueueResult.count);
          if (!enqueueResult.enqueued) {
            throw new Error("訂單暫時未能送出（待同步額滿），請通知職員協助落單。");
          }
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
      // 快餐掃碼（手機端）：記住今次嗰張單，令 reload / 誤關分頁之後仍然睇得返取餐號。
      // （手機端成功頁刻意唔用倒數，取餐號就係客人去櫃檯唯一嘅憑據；快餐又唔 resume，
      //  所以唔可以單靠 state —— 見 kiosk-order.ts 該段長註解。）
      if (isScanLink && mode === "quick") saveQuickScanLastOrder(settledOrder);
      setOrderSyncPending(queuedForSync);
      setSubmittedOrder(settledOrder);
      setCart([]);
      setResumedOrder(null);
      // dine_in 保留本枱單（顯示已落單明細 + 加單）；quick 模式落單後清走，唔畀加單
      setTableOrder(mode === "dine_in" ? settledOrder : null);
      setOrderNote("");
      setOrdering(false); // 落完單返去「明細」介面（鎖定餐牌）
      draftOrderIdRef.current = null; // 落單成功：下張單用新 id

      // ── 會員扣款（確認稿 S7 / S8 / S9）──
      //
      // ⚠️ 順序刻意係「**先落單、後扣款**」：
      //    反過來（先扣後落單）一旦落單失敗就係「錢扣咗但冇單」，要人手去 Ledger 沖正。
      //    而先落單後扣款最壞情況只係「單喺度、錢未收」→ 客人到前台付即可
      //    （確認稿 S9a「訂單已保留」正是此意）。
      //
      // ⚠️ 扣款失敗**唔可以** `return false` —— `placeOrder` 回 false 嘅語義係
      //    「落單失敗，保留購物車重試」，但呢度單已經落咗。回 false 會令 UI 顯示
      //    落單失敗、購物車仲喺度 → 客人再落一次 = 兩張單。所以照回 true，
      //    由 `payStage` 去表達「扣款未成功」。
      if (member && payMethod === "balance") {
        // 兩條**完全唔同**嘅扣款路（契約 §4.5.0 / v3.5 交接文檔）：
        //   掃碼（客人手機）→ POS **伺服器**簽名代打 Ledger `scan-debit/quote|commit`
        //                    （客人只有顧客 JWT，冇店員 session）
        //   Kiosk（店內平板）→ 店員 session 走既有 RPC `merchant_apply_pos_txn`（§5.7）
        // ⚠️ 唔可以混用：掃碼冇店員 session、Kiosk 冇顧客 JWT。
        const deducted =
          variant === "scan" ? await runScanDebit(settledOrder) : await runMemberDeduct(settledOrder);
        if (!deducted) return true;
      }

      setPaySheetOpen(false);
      setPayStage("choose");
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

  // ─────────────────────────────────────────────────────────────
  // 會員登入（確認稿 S1–S3）
  // ─────────────────────────────────────────────────────────────

  /**
   * 打 `POST /api/ledger/member-login`（顧客登入，契約 §4.5）。
   *
   * @param mode `"login"` = Landing 撳「是，我是會員」→ 成功後開始點餐；
   *             `"verify"` = S7a 需要 PIN 再確認 → 成功後即刻扣款，**唔會**重新開始點餐。
   * @returns 驗證成功 = `true`。
   */
  async function submitMemberCredentials(
    phone: string,
    pin: string,
    mode: "login" | "verify",
  ): Promise<boolean> {
    if (memberLoginSubmitting) return false;
    setMemberLoginSubmitting(true);
    setMemberLoginError(null);
    try {
      const res = await fetch("/api/ledger/member-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ⚠️ `channel` 決定 server 會唔會回顧客 JWT：
        //    scan（客人自己手機）→ 回，v3.5 掃碼扣款要用；
        //    kiosk（店內共用平板）→ **唔回**（避免下一位客人扣上一位嘅錢）。
        body: JSON.stringify({ phone, pin, storeId, channel: variant === "scan" ? "scan" : "kiosk" }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        code?: string;
        message?: string;
        remainingAttempts?: number;
        retryAfterSec?: number;
        pinWindowToken?: string | null;
        customerAccessToken?: string;
        member?: {
          customerId: string;
          displayName: string | null;
          balanceAvos: number;
          giftBalanceAvos: number;
        };
      };

      if (!res.ok || !payload.ok || !payload.member) {
        const code = payload.code ?? "upstream";
        // 鎖定（該電話）／限流（該 IP）：顯示解鎖時間，客人仍可改用非會員。
        if (code === "locked" || code === "rate_limited") {
          setMemberLoginLockedUntil(Date.now() + (payload.retryAfterSec ?? 900) * 1000);
          setMemberLoginRemaining(0);
          setMemberLoginError(null);
          return false;
        }
        // 🔴 帳號唔存在 / 未設 PIN / PIN 錯 —— server 已統一文案（防枚舉）。直接用佢嗰句。
        if (code === "bad_credential") {
          setMemberLoginError(payload.message ?? kioskT(language, "memberLoginFailed"));
          setMemberLoginRemaining(payload.remainingAttempts ?? null);
          return false;
        }
        setMemberLoginError(payload.message ?? kioskT(language, "placeFailed"));
        return false;
      }

      // 🔴 只存記憶體。**唔可以**寫落 localStorage / sessionStorage / console（§7.2）。
      const nextMember: OrderingMember = {
        customerId: payload.member.customerId,
        phone,
        displayName: payload.member.displayName,
        balanceAvos: payload.member.balanceAvos,
        giftBalanceAvos: payload.member.giftBalanceAvos,
        loggedInAt: Date.now(),
        // 憑證：唔入 storage，唔 log。
        customerAccessToken: payload.customerAccessToken,
        pinWindowToken: payload.pinWindowToken ?? undefined,
      };
      // ⚠️ 一定要**同步**寫 ref：同一輪 closure 嘅 `member` 仲係舊值（見 `memberRef` 註解）。
      memberRef.current = nextMember;
      setMember(nextMember);
      // 驗 PIN 成功 → 舊報價作廢（票換咗，但報價本身未用過；保險起見清走）。
      setPendingQuote(null);
      setMemberLoginRemaining(null);
      setMemberLoginLockedUntil(null);
      setMemberLoginError(null);

      if (mode === "login") {
        setMemberLoginOpen(false);
        // S6：預設揀「扣餘額」—— 會員登入嘅意圖就係想扣（確認稿已拍板）。
        setPayMethod("balance");
        startOrdering();
      }
      return true;
    } catch {
      setMemberLoginError(kioskT(language, "placeFailed"));
      return false;
    } finally {
      setMemberLoginSubmitting(false);
    }
  }

  /** S1「是，我是會員」→ 開登入 sheet。 */
  function openMemberLogin() {
    setMemberLoginError(null);
    setMemberLoginRemaining(null);
    setMemberLoginOpen(true);
  }

  /**
   * S1「不是，直接點餐」／S2「跳過，直接點餐」／S3b「改用非會員，直接點餐」。
   *
   * ⚠️ 一定要清走殘留會員態：Kiosk 係共用平板，上一位客人登入過就直接沿用 = 幫人扣錯錢。
   * ⚠️ **唔清** `memberLoginLockedUntil` —— 嗰個係 server 側鎖，客人再撳「我是會員」應該照見到鎖定。
   */
  function skipMemberLogin() {
    setMemberLoginOpen(false);
    setMemberLoginError(null);
    setMemberLoginRemaining(null);
    setMember(null);
    setPayMethod(null);
    setDeductReceipt(null);
    startOrdering();
  }

  /** 關閉登入 sheet（未登入狀態）。 */
  function closeMemberLogin() {
    setMemberLoginOpen(false);
    setMemberLoginError(null);
    setMemberLoginRemaining(null);
  }

  // ─────────────────────────────────────────────────────────────
  // 付款（確認稿 S6 / S7 / S9）
  // ─────────────────────────────────────────────────────────────

  /** 開付款 sheet（S6）。只有會員先開得到 —— 非會員直接落單（S4 冇扣餘額能力）。 */
  function openPaySheet() {
    if (!member) return;
    setPayMethod("balance");
    setPayStage("choose");
    setPayError(null);
    setPaySheetOpen(true);
  }

  function selectPayMethod(method: MemberPayMethod) {
    setPayMethod(method);
    setPayError(null);
  }

  /** S6「確認付款」：前台付 = 直接落單；扣餘額 = 先去 S7 確認扣款。 */
  function confirmPay() {
    if (!member || payBusy) return;
    if (payMethod === "counter") {
      void placeOrder();
      return;
    }
    setPayStage("deduct");
    setPayTick(Date.now());
  }

  /** S7「確認扣款」：免 PIN 直接扣；需 PIN 就先驗 PIN 再扣。 */
  async function confirmDeduct(pin: string | null) {
    if (!member || payBusy) return;
    if (pin !== null) {
      // ⚠️ 一定要傳 `member.phone`（唔係 `customerId`）—— 驗證係用電話 + PIN 派生密碼。
      const verified = await submitMemberCredentials(member.phone, pin, "verify");
      if (!verified) return;
    }
    // 🔴 如果訂單**已經落咗**（S9 `pin_required` 或「結果未知」之後客人補 PIN／重試），
    //    就**唔可以**再 `placeOrder()` —— 會落多一張新單：新 `order.id` → 新冪等鍵 →
    //    Ledger 唔會擋 → **客人真·被扣兩次**。
    //    呢種情況只可以對**已落嘅同一張單**重打扣款。
    const settled = submittedOrder;
    if (settled) {
      if (variant === "scan") {
        await runScanDebit(settled);
        return;
      }
      await runMemberDeduct(settled);
      return;
    }
    await placeOrder();
  }

  /** S9a「改為到前台支付」／S7「取消，改為到前台支付」：關 sheet，訂單保留。 */
  function switchPayToCounter() {
    setPaySheetOpen(false);
    setPayStage("choose");
    setPayError(null);
  }

  /** S9a「重新選擇付款方式」：返去 S6。 */
  function backToMethodChoice() {
    setPayStage("choose");
    setPayError(null);
  }

  /**
   * S9b「重試（不會重複扣款）」。
   *
   * 🔴 **唔可以**重用 `placeOrder()` —— 佢會重新落一張**新單**（新 `order.id`），
   *    即係新冪等鍵 → Ledger 唔會擋 → 客人真·被扣兩次。
   *    呢度只可以對**已落嘅同一張單**重打扣款（同一 `order.id` → 同一 key → 回同一 `txnId`）。
   */
  async function retryDeduct() {
    if (!member || payBusy) return;
    const target = submittedOrder;
    if (!target) return;
    // 掃碼：`runScanDebit` 會重用 `pendingQuote`（同一 quoteId → Ledger 回同一 txnId，唔會雙扣）。
    if (variant === "scan") {
      await runScanDebit(target);
      return;
    }
    await runMemberDeduct(target);
  }

  function closePaySheet() {
    if (payBusy) return;
    setPaySheetOpen(false);
    setPayStage("choose");
    setPayError(null);
  }

  /**
   * 掃碼自助扣款（v3.5 `scan-debit/quote` → `commit`）—— **只掃碼用**。
   *
   * 流程：報價（唔扣錢，180s 有效）→ commit（真正扣）→ server 已寫 `pos_orders`（`status: paid`）。
   *
   * 🔴 四條唔可以錯：
   *   1. **金額由 server 核價** —— route 由 `pos_orders.total` 讀，client 完全唔傳金額
   *      （Ledger 唔核價，POS server 係唯一防線，即 P2）。
   *   2. **commit 網絡失敗 = 結果未知** → 留住 `quoteId` / `quoteSig`，重試**重用同一對**，
   *      Ledger 會回**同一** `txnId`（唔會雙扣）。重新 quote = 新交易 = **真·雙扣**。
   *   3. **`pin_required` 唔係扣款失敗** —— 只係免 PIN 票過期，要客人重新入 PIN。
   *   4. 成功之後**唔再**發 `ORDER_UPDATED` —— server 已經用 write client 寫咗 DB，
   *      再經匿名通道寫一次只會多一個覆蓋風險。
   */
  async function runScanDebit(order: PosOrder): Promise<boolean> {
    // ⚠️ 用 ref 而唔係 closure 嘅 member —— 驗 PIN 之後嘅新票／新 token 都喺 ref 度（見 memberRef 註解）。
    const m = memberRef.current ?? member;
    if (!m) return false;
    if (!m.customerAccessToken) {
      // 掃碼登入一定應該有 token；冇 = 舊 client 或 channel 判斷出錯 → 唔可以靜默當成功。
      setPayError(kioskT(language, "placeFailed"));
      setPayStage("unknown");
      return false;
    }

    setPayBusy(true);
    setPayError(null);

    try {
      // ── 1) 報價（有未完成報價就重用，見上面第 2 條）──
      let quote = pendingQuote;
      if (!quote) {
        const quoteRes = await fetch("/api/ledger/scan-debit/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storeId,
            posOrderId: order.id,
            customerAccessToken: m.customerAccessToken,
          }),
        });
        const quotePayload = (await quoteRes.json()) as {
          ok?: boolean;
          code?: string;
          message?: string;
          quoteId?: string;
          quoteSig?: string;
        };

        if (!quoteRes.ok || !quotePayload.ok || !quotePayload.quoteId || !quotePayload.quoteSig) {
          const code = quotePayload.code ?? "upstream";
          if (code === "insufficient_balance") {
            setPayStage("insufficient");
            return false;
          }
          if (code === "already_debited") {
            // 呢張單已經扣過（可能係客人重試）→ 當「同步中」交返成功頁，唔好再扣。
            setOrderSyncPending(true);
            setPaySheetOpen(false);
            setPayStage("choose");
            return true;
          }
          setPayError(quotePayload.message ?? kioskT(language, "placeFailed"));
          setPayStage("unknown");
          return false;
        }
        quote = { quoteId: quotePayload.quoteId, quoteSig: quotePayload.quoteSig };
        setPendingQuote(quote);
      }

      // ── 2) commit（真正扣錢）──
      const commitRes = await fetch("/api/ledger/scan-debit/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          posOrderId: order.id,
          quoteId: quote.quoteId,
          quoteSig: quote.quoteSig,
          customerAccessToken: m.customerAccessToken,
          pinWindowToken: m.pinWindowToken,
        }),
      });
      const commitPayload = (await commitRes.json()) as {
        ok?: boolean;
        code?: string;
        message?: string;
        txnId?: string;
        balanceAfterAvos?: number | null;
        pointsEarnedAvos?: number;
        syncPending?: boolean;
      };

      if (!commitRes.ok || !commitPayload.ok) {
        const code = commitPayload.code ?? "upstream";
        // 免 PIN 票過期（>180s）→ 交返 S7 要客人再入 PIN。票係 server 簽，client 造唔到。
        if (code === "pin_required") {
          setPayStage("deduct");
          setPayError(null);
          return false;
        }
        if (code === "insufficient_balance") {
          setPayStage("insufficient");
          return false;
        }
        // 報價過期（~180s）→ 清走，客人撳重試時會重新 quote（未 commit 唔佔冪等鍵，安全）。
        if (code === "quote_invalid") setPendingQuote(null);
        setPayError(commitPayload.message ?? kioskT(language, "placeFailed"));
        setPayStage("unknown");
        return false;
      }

      // ── 3) 成功 ──
      const paidOrder: PosOrder = {
        ...order,
        status: "paid",
        prepaidAmount: order.total,
        memberCustomerId: m.customerId,
        memberDeductionAvos: mopToAvos(order.total),
        memberDeductTxnId: commitPayload.txnId || undefined,
        updatedAt: new Date().toISOString(),
      };
      setDeductReceipt({
        txnId: commitPayload.txnId ?? "",
        // 掃碼 route 唔會回餘額（commit 只回 txnId/balanceAfter；冇值就當 0 顯示）
        balanceAfterAvos: Number(commitPayload.balanceAfterAvos ?? 0),
        pointsEarnedAvos: Number(commitPayload.pointsEarnedAvos ?? 0),
      });
      setSubmittedOrder(paidOrder);
      setTableOrder(mode === "dine_in" ? paidOrder : null);
      if (commitPayload.syncPending) setOrderSyncPending(true);
      setPendingQuote(null);
      setPaySheetOpen(false);
      setPayStage("choose");
      return true;
    } catch (e) {
      // 網絡 / 非預期 → **結果未知**（唔可以當未扣）。
      setPayError(e instanceof Error ? e.message : String(e));
      setPayStage("unknown");
      return false;
    } finally {
      setPayBusy(false);
    }
  }

  /**
   * 走 Ledger `merchant_apply_pos_txn`（`p_type: "deduct"`）扣會員儲值餘額。
   *
   * 成功之後：
   *   ① 發 `ORDER_UPDATED` 把訂單轉 `paid` + `prepaidAmount = total` + 三個 member 欄；
   *   ② 記 `deductReceipt`（成功頁顯示 `txn_*` + 剩餘餘額）。
   *
   * @returns `true` = 錢已扣（訂單已更新）；`false` = 未扣（已設好對應 stage 畀 UI 顯示）。
   *
   * 🔴 三條唔可以錯嘅：
   *   1. **冪等鍵**必須係 `scan-debit:{storeId}:{orderId}`（docs/129 P1）——
   *      換咗格式，Ledger 端 `apply_transaction` 就唔會擋重複扣款（真·雙扣）。
   *   2. 扣款成功**一定要**即刻轉 `paid` + 寫 `prepaidAmount`（J 2026-09-13 拍板）：
   *      唔寫，收銀機仲當「未付款」→ 會再收一次錢。
   *   3. 失敗**唔可以**當「未扣款」：Ledger 冇 lookup API（Q6），
   *      網絡失敗 = **結果未知** → 只可以同鍵重試，唔可以靜默當成功或當失敗。
   */
  async function runMemberDeduct(order: PosOrder): Promise<boolean> {
    if (!member) return false;

    const amountAvos = mopToAvos(order.total);
    if (amountAvos <= 0) {
      setPayError(null);
      setPayStage("insufficient");
      return false;
    }

    setPayBusy(true);
    setPayError(null);
    const idempotencyKey = buildDeductIdempotencyKey(storeId, order.id);

    try {
      const result = await applyPosDeduct({
        merchantId: storeId,
        // ⚠️ `member.phone` 只喺呢度用一次（RPC 參數），唔會落單、唔會 log（§7.2）。
        phone: member.phone,
        amountAvos,
        idempotencyKey,
      });

      const paidOrder: PosOrder = {
        ...order,
        status: "paid",
        // 全額已預付：收銀機見到呢個值就唔會再收錢。
        prepaidAmount: order.total,
        memberCustomerId: member.customerId,
        memberDeductionAvos: result.amountAvos,
        memberDeductTxnId: result.txnId,
        updatedAt: new Date().toISOString(),
      };

      try {
        await submitKioskOrder(storeId, paidOrder, "ORDER_UPDATED");
      } catch (e) {
        // ⚠️ **錢已經扣咗**，只係「轉 paid」未上到雲。呢個情況唔可以當扣款失敗
        //    （客人明明畀咗錢）→ 入本地待同步隊列等 flush，UI 照當扣款成功，
        //    只係 `orderSyncPending` 會照出（唔可以講「已同步」講大話）。
        if (!(e instanceof KioskOrderRejectedError)) {
          enqueuePendingKioskOrder(storeId, paidOrder, "ORDER_UPDATED");
          setPendingSyncCount(pendingKioskOrderCount(storeId));
          setOrderSyncPending(true);
        }
        console.warn(
          "[kiosk] 會員扣款成功但轉 paid 未上雲，已入待同步隊列:",
          e instanceof Error ? e.message : String(e),
        );
      }

      setDeductReceipt({ txnId: result.txnId, balanceAfterAvos: result.balanceAfterAvos });
      setSubmittedOrder(paidOrder);
      setTableOrder(mode === "dine_in" ? paidOrder : null);
      setPaySheetOpen(false);
      setPayStage("choose");
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 餘額不足：訂單**保留**唔取消，客人可以直接轉「到前台付款」（確認稿 S9a）。
      if (/insufficient/i.test(message)) {
        setPayStage("insufficient");
        return false;
      }
      // 其餘（網絡 / 5xx / 店員 Ledger session 過期）→ **結果未知**（確認稿 S9b）。
      setPayError(message);
      setPayStage("unknown");
      return false;
    } finally {
      setPayBusy(false);
    }
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
    // 上一輪嘅扣款收據唔應該帶落新一輪（會員身分本身保留 —— 登入後就係用呢條路入餐牌）。
    setDeductReceipt(null);
    // ⚠️ 只有 Kiosk 記落 sessionStorage（見 `persistStarted` 長註解）；
    //    掃碼記住就會令下次掃碼跳過 Landing（連會員登入都見唔到）。
    if (persistStarted && typeof window !== "undefined") {
      window.sessionStorage.setItem("kiosk-started", "1");
    }
  }

  // kiosk 落單成功倒數後自動返回：清走成功頁 + 重置 landing（等下一個客人重新「開始點餐」）
  function returnToHome() {
    setSubmittedOrder(null);
    setOrderSyncPending(false);
    setStarted(false);
    setOrdering(false);
    // 快餐掃碼嘅「記住嗰張單」都要清：唔清就會喺下一次 reload 又跳返成功頁
    //（客人撳「再點一單」= 明確表示唔再需要睇舊號）。
    clearQuickScanLastOrder();

    // ── 🔴 歸零硬重置三件事（確認稿 S12T）──
    // 清會員 session / 清付款選擇 / 清扣款收據。
    // ⚠️ 呢個係**安全必要**而唔係清潔：Kiosk 係**共用平板**，唔清就走下一張單嘅話，
    //    下一位客人一坐低就已經「登入咗上一位客人嘅會員」→ 直接扣錯人錢。
    // ⚠️ 唯一**唔清**嘅係 `memberLoginLockedUntil` —— 嗰個係 server 側「連續 5 次錯 PIN」
    //    嘅鎖定，本來就要跨客人有效（換個客人打同一個電話號碼都應該照鎖）。
    setMember(null);
    setMemberLoginOpen(false);
    setMemberLoginError(null);
    setMemberLoginRemaining(null);
    setPaySheetOpen(false);
    setPayStage("choose");
    setPayMethod(null);
    setPayError(null);
    setPayBusy(false);
    setDeductReceipt(null);
    // 未完成嘅報價都要清（換客人 = 唔應該帶住上一單嘅 quote）。
    setPendingQuote(null);

    // ⚠️ 換機 / 清 cache 之前殘留嘅 key 一定要清（就算呢次係掃碼，都順手清走
    //    上一位客人喺同一部機留低嘅 kiosk key）。
    if (typeof window !== "undefined") window.sessionStorage.removeItem("kiosk-started");
  }

  // 免 PIN 倒數：只有喺「確認扣款」畫面先需要每秒重算。
  // 唔想全頁每秒 render —— 所以 tick 條件式啟動（`payStage` 一離開 `deduct` 就停）。
  useEffect(() => {
    if (!paySheetOpen || payStage !== "deduct") return;
    const timer = setInterval(() => setPayTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [paySheetOpen, payStage]);

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

    // ── 會員登入（確認稿 S1–S3）──
    member,
    memberLoginOpen,
    memberLoginSubmitting,
    memberLoginError,
    memberLoginRemaining,
    /** 已鎖定時嘅解鎖時間（例 `14:37`）；未鎖 = null。UI 直接顯示，唔使再格式化。 */
    memberLoginLockedRetryAt:
      memberLoginLockedUntil === null
        ? null
        : formatRetryClock(
            Math.max(0, Math.ceil((memberLoginLockedUntil - Date.now()) / 1000)),
            Date.now(),
          ),
    openMemberLogin,
    closeMemberLogin,
    skipMemberLogin,
    submitMemberCredentials,

    // ── 付款（確認稿 S6 / S7 / S9）──
    paySheetOpen,
    payStage,
    payMethod,
    payBusy,
    payError,
    /** 扣款成功收據（`txn_*` + 剩餘餘額）；null = 未扣款成功。 */
    deductReceipt,
    /**
     * 免 PIN 時嘅「已登入多久」（例 `2 分 12 秒`）。
     * `null` = 已逾 180 秒（或未登入）→ UI 要顯示 PIN 輸入。
     */
    pinFreeAgoLabel:
      member === null || !isPinFree(member.loggedInAt, payTick)
        ? null
        : formatElapsed(payTick - member.loggedInAt),
    openPaySheet,
    closePaySheet,
    selectPayMethod,
    confirmPay,
    confirmDeduct,
    switchPayToCounter,
    backToMethodChoice,
    retryDeduct,
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
