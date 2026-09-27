/**
 * Ledger「線下營業摘要」API —— **契約純邏輯**（零 `@/` 依賴，可被 `node --test` 直接載入）。
 *
 * 契約文件：`docs/integration/pos-offline-report-api.md`（Ledger 2026-09-24 發出）
 * 增補契約：`docs/integration/pos-offline-report-v1-addendum-2026-09-26.md`（orders/dishes）
 * 審視報告：`docs/integration/pos-offline-report-contract-review-2026-09-25.md`
 * 路線實作：`src/app/api/integration/ledger/offline-report/route.ts`
 * DB 聚合  ：`supabase/migrations/0058_pos_offline_report_rpc.sql`（KPI）
 *            `supabase/migrations/0059_pos_offline_report_detail.sql`（＋ orders／dishes，
 *            同一簽名 create or replace ⇒ 兩者係同一支函數嘅先後版本）
 *
 * ── 為何要拆出呢個檔案（同 `order-event-time.ts` 同一個理由）──────────────
 * 🔴 `npm test` ＝ `node --test`：**唔認 `@/` 別名、唔行 bundler、唔支援 `.tsx`**。
 *    所以驗簽／clamp／payload 驗證呢啲要單元測試嘅邏輯一律放 `.ts`、用相對 import。
 *    詳見 `docs/113-agent-gotchas.md` §開發注意事項。
 *
 * ── 安全模型（重要）───────────────────────────────────────────────────────
 * 呢條 route 係**公開網段可達**嘅（Ledger 伺服器打過嚟），冇店員 session、冇 POS 終端憑證：
 *   ① 唯一身分證明 ＝ HMAC-SHA256 簽名（secret 只喺兩邊 server）；
 *   ② 簽名覆蓋 `${timestamp}.GET.${pathWithQuery}` ⇒ 換 storeId／改區間一定要重簽；
 *   ③ 時間窗 5 分鐘（Ledger 端係伺服器對伺服器，正常誤差 < 1 秒）；
 *   ④ 回應 = 聚合數字 ＋ 訂單明細（2026-09-26 增補：**只有訂單號、金額、狀態**）
 *      ＋ 菜品排名。🔴 **仍然冇任何顧客個資、冇任何自由文字**：
 *      `order_note` / item `note` / `discount_note` / `comp_note` 一律唔出
 *      （店員手打，可能寫咗姓名／電話）；`pos_orders` 本身亦冇收銀員欄。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Route 路徑（合約固定；簽名要簽嘅係 `pathname + search`）。 */
export const OFFLINE_REPORT_PATH = "/api/integration/ledger/offline-report";

/** 契約固定值（回應 `v`）。 */
export const OFFLINE_REPORT_VERSION = 1;

/** 區間硬上限：90 個日曆日（含首尾）。超出 → 由 `to` 倒推 89 日並回 `clamped=true`。 */
export const OFFLINE_REPORT_MAX_DAYS = 90;

/** 簽名時間容差（5 分鐘；契約 §驗證順序 1）。 */
export const OFFLINE_REPORT_SIGNATURE_WINDOW_MS = 5 * 60_000;

/** 限流：每個 storeId 每分鐘 ≤ 30 次（契約 §驗證順序 6）。 */
export const OFFLINE_REPORT_RATE_LIMIT = { windowMs: 60_000, max: 30 } as const;

/** 支付方式標籤長度上限（契約：> 32 字整包拒收 ⇒ 我哋先截斷，唔好令整張卡消失）。 */
export const OFFLINE_REPORT_MAX_METHOD_LEN = 32;

// ── 2026-09-26 增補：`orders[]`（訂單明細）＋ `dishes[]`（菜品排名）───────
// 契約 v1 只回 KPI；Ledger 要「單次呼叫拎齊」線下報表頁嘅明細同排行
//（增補文件：`docs/integration/pos-offline-report-v1-addendum-2026-09-26.md`）。
// 🔴 全部係 **additive**：`v` 仍然係 1，Ledger 未讀新欄位都唔會爆。

/** 訂單明細上限（0059；超 3000 由 SQL 截斷並令 `ordersTruncated = true`）。 */
export const OFFLINE_REPORT_MAX_ORDERS = 3000;

/** 菜品排名上限（0059）。 */
export const OFFLINE_REPORT_MAX_DISHES = 300;

/** 菜品名稱長度上限（同 SQL 嘅 `left(name, 64)` 對齊）。 */
export const OFFLINE_REPORT_MAX_DISH_NAME_LEN = 64;

/** 訂單號長度上限（同 SQL 嘅 `left(local_order_no, 64)` 對齊）。 */
export const OFFLINE_REPORT_MAX_ORDER_NO_LEN = 64;

/** 訂單狀態長度上限（同 SQL 嘅 `left(status, 32)` 對齊）。 */
export const OFFLINE_REPORT_MAX_STATUS_LEN = 32;

/**
 * 回應能力清單 —— 放喺回應標頭 `x-pos-offline-report-caps`。
 *
 * 🔴 點解要有：`v` 按契約寫死係 `1`，所以**加欄位唔會反映喺 `v`**（升 `v` 會令
 *    Ledger 既有可能 `v === 1` 嘅檢查失效 ⇒ 整包丟棄）。改用呢個標頭做能力探測：
 *    對方見到 `orders` / `dishes` 就知可以讀，見唔到（舊部署）就自動退回只顯示 KPI。
 *
 * 🔴🔴 **部署次序唔可以靠「記得先跑 0059」**：Vercel push 即自動部署，
 *    若 route 比 migration 先上線，舊 `0058` 會回一份冇 `orders` 嘅 payload。
 *    如果嗰時嚴格驗證 ⇒ **Ledger 現有嗰張已對數嘅卡即刻 503**（＝人為故障）。
 *    ⇒ 所以 `orders` / `dishes` 係**可選**：四個 key 全缺 = 舊版本 ⇒ 回應**唔出**呢兩節
 *    （缺席 ≠ 空陣列，唔會被當成「今日冇單」嘅假零），caps 亦唔會宣告佢哋。
 *    但「只出現一部分」＝ SQL 有 bug ⇒ 照樣 503（見 `rpc-partial-detail-keys`）。
 */
export const OFFLINE_REPORT_CAPS_BASE = ["kpi", "byPayment"] as const;
export const OFFLINE_REPORT_CAPS_DETAIL = ["orders", "dishes"] as const;

/** 標頭值（逗號分隔；Ledger 用 `includes` 判斷即可）。 */
export function offlineReportCapsHeader(hasDetail: boolean): string {
  return (
    hasDetail
      ? [...OFFLINE_REPORT_CAPS_BASE, ...OFFLINE_REPORT_CAPS_DETAIL]
      : [...OFFLINE_REPORT_CAPS_BASE]
  ).join(",");
}

// ─────────────────────────────────────────────────────────────────────────────
// 參數驗證
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * `storeId` 是否合法 UUID（契約 §驗證順序 3）。
 *
 * ⚠️ 只做格式檢查 —— POS 嘅 `store_id` 就係 Ledger 登入回嘅 `merchant_id`
 * （`src/app/api/ledger/login/route.ts` → `pos_orders.store_id`），唔存在「POS 自己嘅店號」。
 */
export function isStoreId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** 正規化 `storeId`：去空白 + 轉小寫（DB 一律小寫 UUID）；唔合法回 `""`。 */
export function normalizeStoreId(value: unknown): string {
  if (!isStoreId(value)) return "";
  return (value as string).trim().toLowerCase();
}

/**
 * `YYYY-MM-DD` 且係**真實存在**嘅日曆日（拒絕 `2026-02-30` / `2026-13-01`）。
 *
 * 🔴 唔可以用 `Date.parse()` 做呢件事：佢對 `2026-02-30` 會**靜靜地滾到 3 月 2 日**
 *    （同 `docs/113` §時間篩選記錄嘅坑同源）。所以自己逐格檢查。
 */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_KEY_RE.exec(value.trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** `YYYY-MM-DD` → 該日 UTC 零時嘅 epoch ms（純日曆運算，同澳門時區無關）。 */
export function dateKeyToUtcMs(dateKey: string): number {
  const m = DATE_KEY_RE.exec(dateKey.trim());
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** epoch ms → `YYYY-MM-DD`（UTC 日曆）。 */
export function utcMsToDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** 日期鍵位移（＋日曆日，負數＝往前）。 */
export function shiftDateKey(dateKey: string, days: number): string {
  return utcMsToDateKey(dateKeyToUtcMs(dateKey) + days * 86_400_000);
}

/** 區間日數（含首尾兩天）：`2026-09-01 → 2026-09-01` ＝ 1。 */
export function dateKeySpanDays(fromKey: string, toKey: string): number {
  return Math.round((dateKeyToUtcMs(toKey) - dateKeyToUtcMs(fromKey)) / 86_400_000) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 範圍截斷（90 日）
// ─────────────────────────────────────────────────────────────────────────────

export type ClampedRange = { from: string; to: string; clamped: boolean };

/**
 * 契約 §驗證順序 4：`to − from ≥ 90`（即 ≥ 91 個日曆日）⇒ 保留 `to`、`from = to − 89 日`。
 *
 * ⚠️ 邊界係**日差**唔係「日數」：`from=2026-06-27, to=2026-09-24` 日差 89 ⇒ **唔截斷**
 * （Ledger 驗收清單嗰條 `2026-01-01 → 2026-09-24` 就會變成 `from=2026-06-27`）。
 *
 * 傳入已經係 route 驗過嘅合法日期鍵；防禦性上仍然自己檢查一次。
 */
export function clampOfflineReportRange(fromKey: string, toKey: string): ClampedRange {
  if (!isDateKey(fromKey) || !isDateKey(toKey)) {
    // 唔應該發生（route 已回 400）；保底回 `to` 當日，唔會拋錯。
    const safeTo = isDateKey(toKey) ? toKey : utcMsToDateKey(Date.now());
    return { from: safeTo, to: safeTo, clamped: false };
  }
  if (dateKeyToUtcMs(fromKey) > dateKeyToUtcMs(toKey)) {
    return { from: toKey, to: toKey, clamped: false };
  }
  if (dateKeySpanDays(fromKey, toKey) > OFFLINE_REPORT_MAX_DAYS) {
    return { from: shiftDateKey(toKey, -(OFFLINE_REPORT_MAX_DAYS - 1)), to: toKey, clamped: true };
  }
  return { from: fromKey, to: toKey, clamped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC 驗簽
// ─────────────────────────────────────────────────────────────────────────────

export type SignatureFailReason =
  | "missing-secret"
  | "missing-header"
  | "bad-timestamp"
  | "stale-timestamp"
  | "bad-signature";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailReason };

/** 計算期望簽名：`HMAC_SHA256(secret, timestamp + "." + "GET" + "." + pathWithQuery)`。 */
export function computeOfflineReportSignature(
  secret: string,
  timestamp: string,
  pathWithQuery: string,
): string {
  return createHmac("sha256", secret).update(`${timestamp}.GET.${pathWithQuery}`).digest("hex");
}

/**
 * 驗 Ledger 伺服器嘅入站簽名（契約 §驗證順序 1–2）。
 *
 * 🔴 三個一定要跟嘅細節：
 *   ① `pathWithQuery` 必須係**收到嘅原字串**（`request.nextUrl.pathname + search`）——
 *      重排 query、或者 `decodeURIComponent` 再 encode 返，簽名都一定對唔上；
 *   ② 先用 `/^[0-9a-f]{64}$/i` 擋長度：`Buffer.from(壞hex, "hex")` 會**靜默截斷**尾碼，
 *      令比對變成「前綴相同就過」；
 *   ③ 秒／毫秒都要接受（Ledger 用 unix 秒，但唔排除日後改毫秒）。
 */
export function verifyOfflineReportSignature(args: {
  timestampHeader?: string | null;
  signatureHeader?: string | null;
  pathWithQuery: string;
  secret?: string | null;
  /** 測試注入用；預設 `Date.now()`。 */
  nowMs?: number;
}): SignatureResult {
  const secret = (args.secret ?? "").trim();
  if (!secret) return { ok: false, reason: "missing-secret" };

  const ts = (args.timestampHeader ?? "").trim();
  const sig = (args.signatureHeader ?? "").trim();
  if (!ts || !sig) return { ok: false, reason: "missing-header" };

  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "bad-timestamp" };
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  const now = args.nowMs ?? Date.now();
  if (Math.abs(now - ms) > OFFLINE_REPORT_SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: "stale-timestamp" };
  }

  if (!HEX64_RE.test(sig)) return { ok: false, reason: "bad-signature" };

  try {
    const expected = Buffer.from(computeOfflineReportSignature(secret, ts, args.pathWithQuery), "hex");
    const received = Buffer.from(sig.toLowerCase(), "hex");
    if (expected.length !== received.length) return { ok: false, reason: "bad-signature" };
    return timingSafeEqual(expected, received) ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC 結果驗證 + 回應組裝
// ─────────────────────────────────────────────────────────────────────────────

export type OfflineReportKpi = {
  orderCount: number;
  revenueAvos: number;
  refundedAvos: number;
  discountAvos: number;
  covers: number;
};

export type OfflineReportPaymentBucket = { method: string; amountAvos: number };

/**
 * 訂單明細一列（2026-09-26 增補）。
 *
 * 🔴 **刻意只有三個欄位**（用戶拍板「就訂單號、價格、狀態就夠，唔使回所有嘢」）：
 *    `orderNo` ＝ 本地單號（**可為 null**：部分由外部平台推入嘅單冇本地單號，Ledger 要處理）；
 *    `totalAvos` ＝ 該單金額（avos 整數；未結帳單係「當前應收」）；
 *    `status` ＝ 原始 POS 狀態（**封閉值域**，見下）。
 *
 * `status` 全部可能值（＝ `restaurant-daily-report.tsx POS_ORDER_STATUS_LABELS`）：
 * | 值 | 意思 | 已結帳？ | 計入 KPI？ |
 * |---|---|---|---|
 * | `draft` | 未送單 | ✗ | ✗ |
 * | `sent_to_kitchen` | 已送廚房（未結帳） | ✗ | ✗ |
 * | `reopened` | 已重開（返結後未再結） | ✗ | ✗ |
 * | `paid` | 已付款（未結帳） | ✗ | ✅ |
 * | `settled` | 已結帳 | ✅ | ✅ |
 * | `partially_refunded` | 部分退款 | ✅ | ✗ |
 * | `refunded` | 已退款 | ✅ | ✗ |
 *
 * ⚠️ 唔可以用單一個 boolean 取代 `status`：
 *    任何 boolean 對 `refunded`（曾結帳、已退）同 `paid`（未結帳、已收錢）都會講錯嘢。
 *    所以權威係原始 `status`，由 Ledger 自己 map 文案。
 */
export type OfflineReportOrderRow = {
  orderNo: string | null;
  totalAvos: number;
  status: string;
};

/** 菜品排名一列（2026-09-26 增補）：聚合 key ＝ 落單當時嘅 `menuItemId|名稱` 快照。 */
export type OfflineReportDishRow = { name: string; qty: number; revenueAvos: number };

export type OfflineReportResponse = {
  v: typeof OFFLINE_REPORT_VERSION;
  storeId: string;
  from: string;
  to: string;
  generatedAt: string;
  kpi: OfflineReportKpi;
  breakdown: { byPayment: OfflineReportPaymentBucket[] };
  /** 訂單明細（全部線下單，含未結帳；事件時間倒序）。0059 未跑時**缺席**（唔會係空陣列）。 */
  orders?: OfflineReportOrderRow[];
  /** 符合條件嘅線下單總數（**截斷前**）⇒ `ordersTotal > orders.length` ＝ 有截斷。 */
  ordersTotal?: number;
  /** 菜品排名（只計 settled／paid，銷量倒序）。0059 未跑時**缺席**。 */
  dishes?: OfflineReportDishRow[];
  /** 不同菜品款數（截斷前）。 */
  dishesTotal?: number;
  flags: {
    refundsNetted: boolean;
    clamped: boolean;
    /** 訂單明細被 3000 筆上限截斷（只保留最新）。0059 未跑時缺席。 */
    ordersTruncated?: boolean;
    /** 菜品排名被 300 款上限截斷。0059 未跑時缺席。 */
    dishesTruncated?: boolean;
  };
};

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RpcValidation =
  | {
      ok: true;
      found: boolean;
      /** RPC **實際**用嘅區間（已核對過同 `expected` 逐位相等）。回應要 echo 呢兩個值。 */
      from: string;
      to: string;
      clamped: boolean;
      kpi: OfflineReportKpi;
      byPayment: OfflineReportPaymentBucket[];
      /**
       * RPC 有冇 0059 嘅增補欄位。
       * `false` ＝ 舊版 0058（仲未跑 0059）⇒ 回應唔出 orders／dishes 兩節，
       * 亦唔會喺 caps 標頭宣告佢哋。**唔可以**當成「空資料」回空陣列。
       */
      hasDetail: boolean;
      /** 訂單明細（已驗型別；截斷與否由 SQL 嘅 `ordersTotal` 推導，route 唔准自己再截）。 */
      orders: OfflineReportOrderRow[];
      ordersTotal: number;
      ordersTruncated: boolean;
      dishes: OfflineReportDishRow[];
      dishesTotal: number;
      dishesTruncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * 嚴格驗證 0058 RPC 回嚟嘅 jsonb。
 *
 * 🔴 點解要驗自己嘅 RPC：契約明文「任何欄位型別不符 ⇒ Ledger 整包丟棄並顯示暫時無法取得」。
 *    與其送一份 Ledger 會扔嘅 payload，不如**我哋自己回 503**（Ledger 顯示降級一行），
 *    呢個就係「**唔可以渲染假零**」嘅落實位。任何唔確定 ⇒ 唔回 200。
 *
 * 🔴 `expected` 係由 route 按**請求嘅原始區間**算出（`clampOfflineReportRange(原始 from, 原始 to)`）。
 *    截斷嘅**唯一權威係 SQL**（route 只係計一個預期值嚟核對）——
 *    若 route 先截斷再傳落 SQL，SQL 收到嘅已經係 90 日內 ⇒ 會回 `clamped=false`
 *    而同 `expected.clamped=true` 對唔上 ⇒ 驗值即刻 503（2026-09-25 實案，已修）。
 */
export function validateOfflineReportRpc(raw: unknown, expected: ClampedRange): RpcValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: "rpc-not-object" };
  if (typeof raw.found !== "boolean") return { ok: false, reason: "rpc-bad-found" };
  if (typeof raw.clamped !== "boolean") return { ok: false, reason: "rpc-bad-clamped" };
  if (typeof raw.from !== "string" || typeof raw.to !== "string") {
    return { ok: false, reason: "rpc-bad-range-type" };
  }
  if (raw.from !== expected.from || raw.to !== expected.to) {
    return { ok: false, reason: "rpc-range-mismatch" };
  }
  if (raw.clamped !== expected.clamped) return { ok: false, reason: "rpc-clamped-mismatch" };

  // 0058 RPC 回嘅係**扁平** jsonb（`orderCount` / `revenueAvos` … 直接喺頂層），
  // nested `kpi` 係契約回應嘅形狀，由 `buildOfflineReportResponse()` 負責砌。
  const fields: Array<keyof OfflineReportKpi> = [
    "orderCount",
    "revenueAvos",
    "refundedAvos",
    "discountAvos",
    "covers",
  ];
  for (const key of fields) {
    if (!isNonNegativeSafeInt(raw[key])) return { ok: false, reason: `rpc-bad-kpi:${key}` };
  }

  const rawBuckets = raw.byPayment;
  if (!Array.isArray(rawBuckets)) return { ok: false, reason: "rpc-bad-byPayment" };
  const byPayment: OfflineReportPaymentBucket[] = [];
  for (const bucket of rawBuckets) {
    if (!isPlainObject(bucket)) return { ok: false, reason: "rpc-bad-bucket" };
    const method = bucket.method;
    if (typeof method !== "string" || method.length < 1 || method.length > OFFLINE_REPORT_MAX_METHOD_LEN) {
      return { ok: false, reason: "rpc-bad-method" };
    }
    if (!isNonNegativeSafeInt(bucket.amountAvos)) return { ok: false, reason: "rpc-bad-amount" };
    byPayment.push({ method, amountAvos: bucket.amountAvos });
  }

  // ── 訂單明細 ＋ 菜品排名（0059 增補；**四個 key 要麼全有、要麼全無**）──────
  // 🔴 部署次序安全閥：Vercel push 即自動部署，route 可能比 `0059` 先上線。
  //    · 四個 key 全缺 ⇒ 判定「舊版 0058」⇒ 優雅降級（唔出 orders／dishes、caps 亦唔宣告），
  //      ✅ Ledger 現有嗰張已對數嘅卡**完全唔受影響**（唔會 503）。
  //    · 只出現一部分 ⇒ SQL 有 bug（例如漏咗一個 key）⇒ **503 失敗得響**，唔好靜靜降級。
  const detailKeys = ["orders", "ordersTotal", "dishes", "dishesTotal"] as const;
  const presentDetailKeys = detailKeys.filter((k) => raw[k] !== undefined);
  if (presentDetailKeys.length !== 0 && presentDetailKeys.length !== detailKeys.length) {
    return { ok: false, reason: "rpc-partial-detail-keys" };
  }
  const hasDetail = presentDetailKeys.length === detailKeys.length;

  const orders: OfflineReportOrderRow[] = [];
  let ordersTotal = 0;
  const dishes: OfflineReportDishRow[] = [];
  let dishesTotal = 0;

  if (hasDetail) {
    if (!isNonNegativeSafeInt(raw.ordersTotal)) return { ok: false, reason: "rpc-bad-ordersTotal" };
    if (!Array.isArray(raw.orders)) return { ok: false, reason: "rpc-bad-orders" };
    for (const row of raw.orders) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-order-row" };
      // orderNo 可為 null（外部平台推入嘅單冇本地單號），但唔可以係其他型別
      const orderNo = row.orderNo;
      if (orderNo !== null && (typeof orderNo !== "string" || orderNo.length > OFFLINE_REPORT_MAX_ORDER_NO_LEN)) {
        return { ok: false, reason: "rpc-bad-order-no" };
      }
      if (!isNonNegativeSafeInt(row.totalAvos)) return { ok: false, reason: "rpc-bad-order-total" };
      const status = row.status;
      if (typeof status !== "string" || status.length < 1 || status.length > OFFLINE_REPORT_MAX_STATUS_LEN) {
        return { ok: false, reason: "rpc-bad-order-status" };
      }
      orders.push({ orderNo: orderNo as string | null, totalAvos: row.totalAvos, status });
    }
    // 🔴 截斷嘅唯一權威係 SQL：SQL 話總數係 N，就唔可以回多過 N 筆。
    //    多過 = SQL 有 bug（例如漏了 where）⇒ 寧願 503 都唔好回一份自相矛盾嘅 payload。
    //    （刻意**唔**核對「截斷時 length 一定等於上限」：上限係 SQL 側嘅常數，
    //     喺 route 再寫死一次只會製造第二個真源，日後改上限就會誤報 503。）
    if (orders.length > raw.ordersTotal) return { ok: false, reason: "rpc-orders-exceed-total" };
    ordersTotal = raw.ordersTotal;

    if (!isNonNegativeSafeInt(raw.dishesTotal)) return { ok: false, reason: "rpc-bad-dishesTotal" };
    if (!Array.isArray(raw.dishes)) return { ok: false, reason: "rpc-bad-dishes" };
    for (const row of raw.dishes) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-dish-row" };
      const name = row.name;
      // 空名唔收：Ledger 顯示唔到嘢，而且空字串通常代表 SQL 側漏了 coalesce
      if (typeof name !== "string" || name.length < 1 || name.length > OFFLINE_REPORT_MAX_DISH_NAME_LEN) {
        return { ok: false, reason: "rpc-bad-dish-name" };
      }
      if (!isNonNegativeSafeInt(row.qty)) return { ok: false, reason: "rpc-bad-dish-qty" };
      if (!isNonNegativeSafeInt(row.revenueAvos)) return { ok: false, reason: "rpc-bad-dish-revenue" };
      dishes.push({ name, qty: row.qty, revenueAvos: row.revenueAvos });
    }
    if (dishes.length > raw.dishesTotal) return { ok: false, reason: "rpc-dishes-exceed-total" };
    dishesTotal = raw.dishesTotal;
  }

  return {
    ok: true,
    found: raw.found,
    from: raw.from,
    to: raw.to,
    clamped: raw.clamped,
    kpi: {
      orderCount: raw.orderCount as number,
      revenueAvos: raw.revenueAvos as number,
      refundedAvos: raw.refundedAvos as number,
      discountAvos: raw.discountAvos as number,
      covers: raw.covers as number,
    },
    byPayment,
    hasDetail,
    orders,
    ordersTotal,
    ordersTruncated: hasDetail && ordersTotal > orders.length,
    dishes,
    dishesTotal,
    dishesTruncated: hasDetail && dishesTotal > dishes.length,
  };
}

/**
 * 組出契約 §回應 200 嘅**完整** payload。
 *
 * ⚠️ `breakdown` 只有 `byPayment` —— 契約嘅 `dineIn` / `quick` 兩格係 optional，
 *    而 POS `/reports` 根本冇「堂食／快餐 × 營業額」呢個維度（2026-09-25 用戶拍板：v1 唔出），
 *    所以**省略**而唔係回 0（回 0 會被當成真數據）。
 *
 * 2026-09-26 增補：`orders` / `dishes`（同 `ordersTotal` / `dishesTotal`）＋ 兩個 truncated flag。
 * 🔴 `v` **仍然係 1**：加欄位係 additive，升 `v` 反而會令 Ledger 既有可能 `v === 1`
 *    嘅檢查失效 ⇒ 整包丟棄。能力探測改用回應標頭 `x-pos-offline-report-caps`。
 *
 * 🔴 `hasDetail === false`（＝ 0059 未跑）⇒ **整節 omit**，唔係回空陣列。
 *    回 `orders: []` 會被 Ledger 讀成「今日冇單」＝ 假零。
 */
export function buildOfflineReportResponse(input: {
  storeId: string;
  range: ClampedRange;
  kpi: OfflineReportKpi;
  byPayment: OfflineReportPaymentBucket[];
  hasDetail: boolean;
  orders: OfflineReportOrderRow[];
  ordersTotal: number;
  dishes: OfflineReportDishRow[];
  dishesTotal: number;
  generatedAt: string;
}): OfflineReportResponse {
  return {
    v: OFFLINE_REPORT_VERSION,
    storeId: input.storeId,
    from: input.range.from,
    to: input.range.to,
    generatedAt: input.generatedAt,
    kpi: input.kpi,
    breakdown: { byPayment: input.byPayment },
    // 缺席 ≠ 空陣列：舊版（0059 未跑）連 key 都唔出，Ledger 就唔會 render 呢兩節。
    ...(input.hasDetail
      ? {
          orders: input.orders,
          ordersTotal: input.ordersTotal,
          dishes: input.dishes,
          dishesTotal: input.dishesTotal,
        }
      : {}),
    flags: {
      refundsNetted: false,
      clamped: input.range.clamped,
      // 截斷與否**由 SQL 嘅總數推導**（route 唔准自己再截一次）——「權威只可以有一個」。
      ...(input.hasDetail
        ? {
            ordersTruncated: input.ordersTotal > input.orders.length,
            dishesTruncated: input.dishesTotal > input.dishes.length,
          }
        : {}),
    },
  };
}
