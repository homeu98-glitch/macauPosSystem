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
 *            `supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql`（菜品改金額倒序）
 *            🔴 `supabase/migrations/0066_pos_offline_report_channel.sql`（**現行權威**：
 *              渠道維度 ＋ `kpiByChannel` ＋ `paymentBreakdown`）
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

// ── 2026-10-07 增補：渠道（channel）維度 ─────────────────────────────────────
// 增補契約：`docs/integration/pos-offline-report-channel-addendum-2026-10-07.md`
// 方案書  ：`docs/154-ledger-offline-report-online-channel.md`
// DB      ：`supabase/migrations/0066_pos_offline_report_channel.sql`
//
// 🔴🔴 **J 拍板嘅第一鐵律：JSON 數據架構唔可以改。**
//   Ledger 已經照 `v:1` 現有架構砌咗 UI ⇒ 現有欄位名／型別／層級／**數值**
//   全部唔准郁（`kpi` 五欄維持 v1 口徑、`byPayment` 維持舊邏輯、
//   `orders[]`／`dishes[]` 維持 0060 口徑同數量）。
//   所有新資料一律**新 key** ⇒ 舊 parser 唔識就忽略，UI 唔會壞。
//
// 🔴🔴🔴 **呢條鐵律要守三樣，唔係一樣：① 欄位名 ② 型別／層級 ③ 數值。**
//   2026-10-07 事故：0066 第一版守咗 ①②，漏咗 ③ ——
//   `dishes[].qty` 由 42 變 54、`orders[]` 由 75 張變 93 張，
//   而舊 code 收到新 payload **唔會 503**（照送 200）⇒ Ledger 張已對數嘅卡即刻跳數。
//   而家（方案 A）：線上數據全部喺 `ordersByChannel[]`／`dishesByChannel[]，
//   `orders[]`／`dishes[]` 一個數字都同 0060 逐位相同。
//
// 🔴🔴 **第二鐵律：`v` 唔可以升。** 升咗 Ledger 既有可能嘅 `v === 1` 檢查會失效
//   ⇒ 整包丟棄。能力探測一律靠 `x-pos-offline-report-caps` 標頭。

/**
 * 渠道三值（**封閉值域**，同 SQL 嘅 CASE 一一對應）。
 *
 * | 值 | 判定條件 | 意思 |
 * |---|---|---|
 * | `offline` | `source ∉ ('aomi','mfood')` 且 `online_order_id IS NULL` | 純線下 POS 單 |
 * | `online_projection` | `online_order_id IS NOT NULL` | 掃碼／排位／快餐**採納**入店（錢喺店內收） |
 * | `online_platform` | `source IN ('aomi','mfood')` | Grabber 推入嘅外賣平台單 |
 *
 * 🔴 **唔可以用 `online_order_id IS NULL` 當線下** —— 外賣平台單**冇**呢個欄位
 *    （佢有 `external_order_id` + `source`），會被錯標成線下。
 * 🔴 **唔可以淨係靠 `source`** —— 掃碼單冇 `source`，會被錯標成線下。
 */
export const OFFLINE_REPORT_CHANNELS = ["offline", "online_projection", "online_platform"] as const;

export type OfflineReportChannel = (typeof OFFLINE_REPORT_CHANNELS)[number];

/** `value` 係咪合法渠道值（其他一律回 `null` ⇒ route 寧願 503 都唔會送錯值）。 */
export function normalizeOfflineReportChannel(value: unknown): OfflineReportChannel | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return (OFFLINE_REPORT_CHANNELS as readonly string[]).includes(v) ? (v as OfflineReportChannel) : null;
}

/** 渠道標籤長度上限（同 SQL 嘅 `k_max_label_len` 對齊）。 */
export const OFFLINE_REPORT_MAX_LABEL_LEN = 32;

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
export const OFFLINE_REPORT_CAPS_CHANNEL = [
  "kpiByChannel",
  "paymentBreakdown",
  "ordersByChannel",
  "dishesByChannel",
] as const;

/** 標頭值（逗號分隔；Ledger 用 `includes` 判斷即可）。 */
export function offlineReportCapsHeader(hasDetail: boolean, hasChannel = false): string {
  return [
    ...OFFLINE_REPORT_CAPS_BASE,
    ...(hasDetail ? OFFLINE_REPORT_CAPS_DETAIL : []),
    // 🔴 `channel`／`paymentBreakdown` 係喺 `orders`／`dishes` **之上**嘅加法，
    //    所以只有 `hasDetail` 先可以宣告（冇明細就冇嘢可標示來源）。
    ...(hasDetail && hasChannel ? OFFLINE_REPORT_CAPS_CHANNEL : []),
  ].join(",");
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
  /**
   * 🔴 2026-10-07（0066 新增，**舊欄位唔郁**）：精確渠道拆分。
   *
   * 點解要有：`kpi` 五欄嘅口徑係 `online_order_id is null`，而**外賣平台單冇呢個欄位**
   * ⇒ 平台單一直被包埋喺「線下」入面。實測 90 日：v1 `kpi` = 74 張 / MOP 5,471
   * （線下 settled 66 ＋ 平台 settled 8）。而 Ledger 自己嘅 `public.orders` 已經有平台單
   * ⇒ 佢哋會重複計算。
   *
   * ⇒ **`kpi` 五欄一個數字都唔改**（改咗佢張已對數嘅卡即刻跳數），
   *    精確數放喺呢三個新 key。對數：`offline + onlinePlatform` == 舊 `kpi`。
   *
   * ⚠️ 呢三個 key **缺席**（唔係 null）＝ 0066 未跑 ⇒ 降級。
   */
  offline?: OfflineReportKpi;
  online?: OfflineReportKpi;
  onlinePlatform?: OfflineReportKpi;
};

export type OfflineReportPaymentBucket = { method: string; amountAvos: number };

/**
 * 支付方式分項一列（0066 新增；同 POS 報表頁「支付方式分項（店內收款）」卡同款欄位）。
 *
 * | 欄位 | 意思 |
 * |---|---|
 * | `method` | `pos_orders.payment_method` 原值（截 32）；外賣平台單固定「外賣平台」 |
 * | `label` | 翻譯後標籤（`in_store → 到店付款`、`balance → 餘額扣點`…）；查唔到原樣返回 |
 * | `channel` | 渠道三值 |
 * | `orderCount` | 該 (支付方式 × 渠道) 組合嘅單數 |
 * | `receivableAvos` | 應收 ＝ Σ(item.price × qty) ＋ 服務費 ＋ 稅（同 POS `aggregate()` 逐字一致） |
 * | `paidAvos` | 實收 ＝ Σ(`pos_orders.total`) |
 * | `diffAvos` | `receivableAvos − paidAvos`，**可以為負** |
 *
 * 🔴 `diffAvos` 嘅語意隨 `channel` 變，**唔可以叫「折扣」**：
 *    · `offline` ＝ 折扣／抹零（實收 ≤ 應收）
 *    · `online_platform` ＝ 平台抽成 ＋ 餐盒費（`platform_fees`），
 *      實收可能 **>** 應收（實測有 +27 嘅單）⇒ 方向相反。
 * 🔴 SQL **唔可以夾非負** —— 夾咗就變成假零。
 */
export type OfflineReportPaymentBreakdownRow = {
  method: string;
  label: string;
  channel: OfflineReportChannel;
  orderCount: number;
  receivableAvos: number;
  paidAvos: number;
  diffAvos: number;
};

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
  /**
   * 🔴 2026-10-07（0066 新增，additive）：來源渠道。
   *
   * ⚠️ **0066 未跑時會缺席**（舊 0059／0060 嘅 `orders[]` 冇呢欄）
   *    ⇒ 唔可以當成「舊版＝全部線下」，亦**唔可以**回 `"offline"` 補值：
   *    咁樣會令 Ledger 以為嗰啲係線下，但實際上舊版根本冇平台單，
   *    資料係完整嘅 —— 但將來 0066 上線後語意就會唔一致。
   *    正確做法：route 見到冇 `channel` 就唔宣告 `kpiByChannel`／`paymentBreakdown`
   *    能力（caps 標頭），Ledger 就唔會讀。
   */
  channel?: OfflineReportChannel;
};

/**
 * 菜品排名一列（2026-09-26 增補）：聚合 key ＝ 落單當時嘅 `menuItemId|名稱` 快照。
 *
 * 🔴🔴 2026-10-07（0066 方案 A）：**三欄原樣，一個都唔准加**。
 *    0066 第一版曾經喺呢度加四個拆欄，令 `qty` 由 42 變 54、`revenueAvos` 由 84000 變 108000
 *    ⇒ Ledger 張已對數嘅卡即刻跳數。J 拍板方案 A：舊欄還原，拆欄只喺新 key `dishesByChannel[]`。
 *    ⚠️ 呢個 key 嘅型別**冇 optional 欄位** —— 因為「可唔可以加拆欄」根本唔係型別問題，
 *    係 SQL 寫錯問題（驗證層見 `rpc-dish-split-on-legacy`）。
 */
export type OfflineReportDishRow = {
  name: string;
  qty: number;
  revenueAvos: number;
};

/**
 * 🆕 菜品排名（全渠道）一列 —— 0066 方案 A 新 key `dishesByChannel[]`。
 *
 * | 欄位 | 意思 |
 * |---|---|
 * | `name` | 菜品名（下單當時快照） |
 * | `qty` / `revenueAvos` | **總數**（線下 ＋ 線上） |
 * | `offlineQty` / `offlineRevenueAvos` | `offline` 渠道 |
 * | `onlineQty` / `onlineRevenueAvos` | `online_projection` ＋ `online_platform` |
 *
 * 🔴 四個拆欄係**必填**（唔係 optional）—— 呢個 key 存在就一定係 0066，
 *    而 0066 一定會寫齊四欄。冇欄 = SQL 有 bug ⇒ 寧願 503 都唔好俾假零。
 * 🔴 `offlineQty + onlineQty` **必須等於** `qty`（驗證層強制）。
 * 🔴 `offlineRevenueAvos + onlineRevenueAvos` **必須等於** `revenueAvos`（驗證層強制）。
 * 🔴🔴 但**唔可以**用 `offline*` 同舊 `dishes[]` 逐行對齊 —— 舊 `dishes[]` 嘅條件係
 *    `online_order_id is null`，包埋 `online_platform`（`source IN ('aomi','mfood')`
 *    冇 `online_order_id`）；`offline*` 只涵蓋 `channel = 'offline'`。
 *    ⇒ 正確關係係**單向包含**：舊 ⊂ 新，且多出嘅名 `offline*` 全部為 0。
 *    生產實測：舊 58 行 ⊂ 新 63 行，多出 5 款純線上菜。
 */
export type OfflineReportDishByChannelRow = {
  name: string;
  qty: number;
  revenueAvos: number;
  offlineQty: number;
  offlineRevenueAvos: number;
  onlineQty: number;
  onlineRevenueAvos: number;
};

export type OfflineReportResponse = {
  v: typeof OFFLINE_REPORT_VERSION;
  storeId: string;
  from: string;
  to: string;
  generatedAt: string;
  kpi: OfflineReportKpi;
  breakdown: {
    byPayment: OfflineReportPaymentBucket[];
    /**
     * 🔴 2026-10-07（0066）：全渠道支付方式分項。
     * **0066 未跑時整節缺席**（唔會係 `[]` —— 空陣列 = 「今日冇單」嘅假零）。
     * ⚠️ `byPayment`（v1 口徑）維持不變，兩者唔可以互相取代。
     */
    paymentBreakdown?: OfflineReportPaymentBreakdownRow[];
  };
  /** 訂單明細（**還原 0060 口徑**：排除 `online_order_id`，即唔含線上投影單）。0059 未跑時**缺席**。 */
  orders?: OfflineReportOrderRow[];
  /** 符合條件嘅訂單總數（**截斷前**）⇒ `ordersTotal > orders.length` ＝ 有截斷。 */
  ordersTotal?: number;
  /** 菜品排名（**還原 0060 口徑**：排除 `online_order_id`、只三欄、金額倒序）。0059 未跑時**缺席**。 */
  dishes?: OfflineReportDishRow[];
  /** 不同菜品款數（截斷前）。 */
  dishesTotal?: number;
  /**
   * 🆕 全渠道訂單明細（0066 方案 A）—— **線上投影單淨係喺呢度出現**。
   * 欄位同 `orders[]` **完全一樣** ⇒ Ledger 可以用同一個 renderer 讀兩個 key。
   * 0066 未跑時**缺席**（唔係 `[]` —— 空陣列 = 「今日冇單」嘅假零）。
   */
  ordersByChannel?: OfflineReportOrderRow[];
  /** 全渠道訂單總數（截斷前）。 */
  ordersByChannelTotal?: number;
  /** 🆕 全渠道菜品排名（0066 方案 A）—— 帶線上／線下拆欄。0066 未跑時**缺席**。 */
  dishesByChannel?: OfflineReportDishByChannelRow[];
  /** 全渠道菜品款數（截斷前）。 */
  dishesByChannelTotal?: number;
  flags: {
    refundsNetted: boolean;
    clamped: boolean;
    /** 訂單明細被 3000 筆上限截斷（只保留最新）。0059 未跑時缺席。 */
    ordersTruncated?: boolean;
    /** 菜品排名被 300 款上限截斷。0059 未跑時缺席。 */
    dishesTruncated?: boolean;
    /** 🆕 `ordersByChannel[]` 被 3000 筆上限截斷。0066 未跑時缺席。 */
    ordersByChannelTruncated?: boolean;
    /** 🆕 `dishesByChannel[]` 被 300 款上限截斷。0066 未跑時缺席。 */
    dishesByChannelTruncated?: boolean;
    /**
     * 🔴 2026-10-07：渠道拆分（`kpiByChannel`／`paymentBreakdown`／`ordersByChannel`／
     *    `dishesByChannel`）可用。0066 未跑時**缺席**（唔係 `false` —— 唔可以聲稱一件冇發生嘅事）。
     *
     * ⚠️ 呢個 flag 原本嘅名（喺還原舊欄之前）語意係「`orders[]`／`dishes[]` 已含線上單」。
     *    方案 A 還原咗舊欄（兩個 array 都**唔**含線上投影單），舊名會講錯嘢，
     *    所以改名。0066 從未成功交付畀 Ledger（舊欄數值被改 → 佢哋整張卡報錯），
     *    呢個 flag 對外從未被消費 ⇒ 改名零風險。
     *    要讀線上單 → 讀 `ordersByChannel[]`，唔係 `orders[]`。
     */
    channelBreakdownAvailable?: boolean;
    /**
     * 🔴 2026-10-07：誠實揭露 —— **線上營業額以 Ledger 自己嘅數據源為準**。
     *
     * 點解要有：Ledger 已經有線上訂單數據（佢哋自己嘅 `public.orders`），
     * 而 v1 `kpi` 嘅口徑又包埋咗外賣平台單 ⇒ 兩邊相加會**重複計算**。
     * 呢個 flag 係明確講「唔好加」。
     */
    ledgerOwnsOnlineRevenue?: boolean;
  };
};

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 🔴 有符號安全整數（只畀 `diffAvos` 用）。
 *
 * 點解要分開：其餘所有金額欄位都係**非負**（契約規定），
 * 但 `diffAvos` ＝ 應收 − 實收，平台單嘅平台抽成會令佢**為負**
 * （實測：mfood 單應收 259 / 實收 232 → −27）。
 * 🔴 唔可以因為「統一」而用 `isNonNegativeSafeInt` —— 咁樣平台單嘅差額會變 0
 *    （或者直接 503），變成渲染假零。
 */
function isSignedSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `isArray` 嘅 type-guard 包裝（收窄到 `unknown[]`）。
 *
 * 點解要：直接 `for (const row of raw.orders)` 會令 `row` 收窄成 `any`，
 * 之後 `row.totalAvos` 就冇型別檢查 ⇒ 一個拼錯嘅欄位名會靜靜變 `undefined`
 * 然後喺 `isNonNegativeSafeInt` 先爆，錯誤訊息指向錯位。行 `as unknown[]` 代替。
 */
function isArrayChecked(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** `kpiByChannel` 三個 key（`online` ＝ 線上投影；`onlinePlatform` ＝ Grabber 外賣平台）。 */
const KpiChannelKeys = ["offline", "online", "onlinePlatform"] as const;

/**
 * 🔴 `dishesByChannel[]` 嘅四個拆欄。
 *
 * 🔴 呢個清單**淨係**適用於新 key `dishesByChannel[]`。
 *    舊欄 `dishes[]` 出現任何一個 ⇒ `rpc-dish-split-on-legacy`（見驗證處）。
 */
const DISH_SPLIT_KEYS = ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"] as const;

/**
 * 🔴 0066 渠道能力嘅六個 key —— **要麼全有、要麼全無**。
 *
 * ⚠️ 之前只有兩個（`kpiByChannel`＋`paymentBreakdown`），但方案 A 加咗兩個新 key
 *    （`ordersByChannel`＋`dishesByChannel`）⇒ 降級閥必須包埋佢哋，
 *    否則會出現「有 paymentBreakdown 但冇 dishesByChannel」嘅半吊子狀態，
 *    Ledger 讀到部分新 key 就會以為全部都齊 ⇒ 畫面有洞但唔會報錯。
 */
const CHANNEL_CAPABILITY_KEYS = [
  "kpiByChannel",
  "paymentBreakdown",
  "ordersByChannel",
  "ordersByChannelTotal",
  "dishesByChannel",
  "dishesByChannelTotal",
] as const;

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
       * `false` ＝ 舊版 0058（仲未跑 0059/0060/0066）⇒ 回應唔出 orders／dishes 兩節，
       * 亦唔會喺 caps 標頭宣告佢哋。**唔可以**當成「空資料」回空陣列。
       */
      hasDetail: boolean;
      /**
       * 🔴 2026-10-07（0066）：RPC 有冇渠道能力。
       * `false` ＝ 0066 未跑 ⇒ `kpi.offline/online/onlinePlatform`、`paymentBreakdown`、
       * `flags.channelBreakdownAvailable`、`flags.ledgerOwnsOnlineRevenue` 全部**唔出**，
       * caps 標頭亦唔宣告 `kpiByChannel`／`paymentBreakdown`／`ordersByChannel`／`dishesByChannel`。
       *
       * ⚠️ 呢個旗標**唔可以**用嚟判斷 `orders[]`／`dishes[]` 嘅新欄位喺唔喺 ——
       *    舊版（0059/0060）嘅 `orders[]` **冇** `channel`，但個 array 本身仍然有用。
       *    所以 `channel` 係 optional，唔會令整份 payload 降級。
       */
      hasChannel: boolean;
      /** 訂單明細（已驗型別；截斷與否由 SQL 嘅 `ordersTotal` 推導，route 唔准自己再截）。 */
      orders: OfflineReportOrderRow[];
      ordersTotal: number;
      ordersTruncated: boolean;
      dishes: OfflineReportDishRow[];
      dishesTotal: number;
      dishesTruncated: boolean;
      /** 全渠道支付方式分項（0066）。 */
      paymentBreakdown: OfflineReportPaymentBreakdownRow[];
      /** 全渠道訂單明細（0066 方案 A）—— 線上投影單淨係喺呢度出現。 */
      ordersByChannel: OfflineReportOrderRow[];
      ordersByChannelTotal: number;
      ordersByChannelTruncated: boolean;
      /** 全渠道菜品排名 ＋ 拆欄（0066 方案 A）。 */
      dishesByChannel: OfflineReportDishByChannelRow[];
      dishesByChannelTotal: number;
      dishesByChannelTruncated: boolean;
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
  const KPI_FIELDS = ["orderCount", "revenueAvos", "refundedAvos", "discountAvos", "covers"] as const;

  /** 讀一組 5 欄 KPI；`prefix` 淨係用嚟砌錯誤訊息。 */
  function readKpi(src: Record<string, unknown>, prefix: string): OfflineReportKpi | string {
    for (const key of KPI_FIELDS) {
      if (!isNonNegativeSafeInt(src[key])) return `${prefix}:${key}`;
    }
    return {
      orderCount: src.orderCount as number,
      revenueAvos: src.revenueAvos as number,
      refundedAvos: src.refundedAvos as number,
      discountAvos: src.discountAvos as number,
      covers: src.covers as number,
    };
  }

  const v1Kpi = readKpi(raw, "rpc-bad-kpi");
  if (typeof v1Kpi === "string") return { ok: false, reason: v1Kpi };
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
    if (!isArrayChecked(raw.orders)) return { ok: false, reason: "rpc-bad-orders" };
    for (const row of raw.orders as unknown[]) {
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
      // 🔴 `channel` 係 **optional**（0066 未跑時舊版冇呢欄）。
      //    ⚠️ 唔可以因為「舊版應該全部都係線下」而回填 `"offline"`：
      //    咁樣 0066 上線後語意會唔一致，而且會令 Ledger 以為佢自己識分渠道。
      //    正確做法：唔填 → 響應冇呢欄 → caps 標頭唔宣告渠道能力。
      const channel = row.channel === undefined ? null : normalizeOfflineReportChannel(row.channel);
      if (row.channel !== undefined && channel === null) {
        return { ok: false, reason: "rpc-bad-order-channel" };
      }
      orders.push({
        orderNo: orderNo as string | null,
        totalAvos: row.totalAvos,
        status,
        ...(channel ? { channel } : {}),
      });
    }
    // 🔴 截斷嘅唯一權威係 SQL：SQL 話總數係 N，就唔可以回多過 N 筆。
    //    多過 = SQL 有 bug（例如漏了 where）⇒ 寧願 503 都唔好回一份自相矛盾嘅 payload。
    //    （刻意**唔**核對「截斷時 length 一定等於上限」：上限係 SQL 側嘅常數，
    //     喺 route 再寫死一次只會製造第二個真源，日後改上限就會誤報 503。）
    if (orders.length > raw.ordersTotal) return { ok: false, reason: "rpc-orders-exceed-total" };
    ordersTotal = raw.ordersTotal;

    if (!isNonNegativeSafeInt(raw.dishesTotal)) return { ok: false, reason: "rpc-bad-dishesTotal" };
    if (!isArrayChecked(raw.dishes)) return { ok: false, reason: "rpc-bad-dishes" };
    for (const row of raw.dishes as unknown[]) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-dish-row" };
      const name = row.name;
      // 空名唔收：Ledger 顯示唔到嘢，而且空字串通常代表 SQL 側漏了 coalesce
      if (typeof name !== "string" || name.length < 1 || name.length > OFFLINE_REPORT_MAX_DISH_NAME_LEN) {
        return { ok: false, reason: "rpc-bad-dish-name" };
      }
      if (!isNonNegativeSafeInt(row.qty)) return { ok: false, reason: "rpc-bad-dish-qty" };
      if (!isNonNegativeSafeInt(row.revenueAvos)) return { ok: false, reason: "rpc-bad-dish-revenue" };
      // 🔴🔴🔴 舊欄 `dishes[]` **唔准出現**任何拆欄（方案 A 鐵律）。
      //   0066 第一版就係喺呢度加咗 offlineQty/onlineQty 等四欄，而 `qty` 同時變成全渠道總數
      //   ⇒ `qty` 由 42 變 54。舊 Ledger 唔識新欄，於是照樣 render 一個**被改咗嘅舊數字**。
      //   驗證層呢度唔可以再當「拆欄只係 optional」—— 一旦出現就係 SQL 寫錯，503 拒收。
      for (const k of DISH_SPLIT_KEYS) {
        if (row[k] !== undefined) return { ok: false, reason: "rpc-dish-split-on-legacy" };
      }
      dishes.push({ name, qty: row.qty, revenueAvos: row.revenueAvos });
    }
    if (dishes.length > raw.dishesTotal) return { ok: false, reason: "rpc-dishes-exceed-total" };
    dishesTotal = raw.dishesTotal;
  }

  // ── 0066 渠道能力（六個 key：**要麼全有、要麼全無**）──────────────────────────
  // 🔴 同 `detailKeys` 同一個安全閥，但**降級條件更嚴**：渠道能力依賴明細
  //    （冇 `orders`/`dishes` 就根本冇嘢可標示來源）⇒ `hasDetail === false` 時
  //    即使 key 出現都當作舊版（唔宣告、唔 503）。
  // 🔴🔴 呢度必須守「**舊欄一個數字都冇改**」：舊欄（`kpi` 五欄／`byPayment`／
  //    `ordersTotal`／`orders`／`dishesTotal`／`dishes`）由上面各段負責，
  //    渠道段落**只可以讀新 key**，唔可以順手寫落舊 key。
  const presentChannelKeys = CHANNEL_CAPABILITY_KEYS.filter((k) => raw[k] !== undefined);
  if (presentChannelKeys.length !== 0 && presentChannelKeys.length !== CHANNEL_CAPABILITY_KEYS.length) {
    return { ok: false, reason: "rpc-partial-channel-keys" };
  }
  const hasChannel = hasDetail && presentChannelKeys.length === CHANNEL_CAPABILITY_KEYS.length;

  const paymentBreakdown: OfflineReportPaymentBreakdownRow[] = [];
  const ordersByChannel: OfflineReportOrderRow[] = [];
  const dishesByChannel: OfflineReportDishByChannelRow[] = [];
  let ordersByChannelTotal = 0;
  let dishesByChannelTotal = 0;

  if (hasChannel) {
    // ── kpiByChannel：三組各 5 欄 ──
    const rawByCh = raw.kpiByChannel;
    if (!isPlainObject(rawByCh)) return { ok: false, reason: "rpc-bad-kpiByChannel" };
    const byChannel: Record<string, OfflineReportKpi> = {};
    for (const ch of KpiChannelKeys) {
      const sub = rawByCh[ch];
      if (!isPlainObject(sub)) return { ok: false, reason: `rpc-bad-kpiByChannel:${ch}` };
      const k = readKpi(sub, `rpc-bad-kpiByChannel:${ch}`);
      if (typeof k === "string") return { ok: false, reason: k };
      byChannel[ch] = k;
    }
    v1Kpi.offline = byChannel.offline as OfflineReportKpi;
    v1Kpi.online = byChannel.online as OfflineReportKpi;
    v1Kpi.onlinePlatform = byChannel.onlinePlatform as OfflineReportKpi;

    // ── paymentBreakdown：全渠道支付分類 ──
    const rawPb = raw.paymentBreakdown;
    if (!isArrayChecked(rawPb)) return { ok: false, reason: "rpc-bad-paymentBreakdown" };
    for (const row of rawPb as unknown[]) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-pb-row" };
      const method = row.method;
      if (typeof method !== "string" || method.length < 1 || method.length > OFFLINE_REPORT_MAX_METHOD_LEN) {
        return { ok: false, reason: "rpc-bad-pb-method" };
      }
      const label = row.label;
      if (typeof label !== "string" || label.length < 1 || label.length > OFFLINE_REPORT_MAX_LABEL_LEN) {
        return { ok: false, reason: "rpc-bad-pb-label" };
      }
      const channel = normalizeOfflineReportChannel(row.channel);
      if (channel === null) return { ok: false, reason: "rpc-bad-pb-channel" };
      if (!isNonNegativeSafeInt(row.orderCount)) return { ok: false, reason: "rpc-bad-pb-count" };
      if (!isNonNegativeSafeInt(row.receivableAvos)) return { ok: false, reason: "rpc-bad-pb-receivable" };
      if (!isNonNegativeSafeInt(row.paidAvos)) return { ok: false, reason: "rpc-bad-pb-paid" };
      // 🔴 `diffAvos` 用**有符號**檢查：平台抽成會令佢為負，夾非負 = 假零。
      if (!isSignedSafeInt(row.diffAvos)) return { ok: false, reason: "rpc-bad-pb-diff" };
      paymentBreakdown.push({
        method,
        label,
        channel,
        orderCount: row.orderCount,
        receivableAvos: row.receivableAvos,
        paidAvos: row.paidAvos,
        diffAvos: row.diffAvos,
      });
    }

    // ── ordersByChannel：全渠道訂單明細 ──
    // 🔴 欄位同 `orders[]` 一模一樣（同一個 renderer），但**數量唔同**
    //    （`orders[]` 排除 online_order_id ⇒ 永遠冇線上投影單）。
    if (!isNonNegativeSafeInt(raw.ordersByChannelTotal)) {
      return { ok: false, reason: "rpc-bad-ordersByChannelTotal" };
    }
    if (!isArrayChecked(raw.ordersByChannel)) return { ok: false, reason: "rpc-bad-ordersByChannel" };
    for (const row of raw.ordersByChannel as unknown[]) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-orderch-row" };
      const orderNo = row.orderNo;
      if (orderNo !== null && (typeof orderNo !== "string" || orderNo.length > OFFLINE_REPORT_MAX_ORDER_NO_LEN)) {
        return { ok: false, reason: "rpc-bad-orderch-no" };
      }
      if (!isNonNegativeSafeInt(row.totalAvos)) return { ok: false, reason: "rpc-bad-orderch-total" };
      const status = row.status;
      if (typeof status !== "string" || status.length < 1 || status.length > OFFLINE_REPORT_MAX_STATUS_LEN) {
        return { ok: false, reason: "rpc-bad-orderch-status" };
      }
      // 🔴 呢個 key 一定帶 `channel`（冇 = SQL 寫錯，因為成個 key 就係為咗標示渠道而存在）
      const channel = normalizeOfflineReportChannel(row.channel);
      if (channel === null) return { ok: false, reason: "rpc-bad-orderch-channel" };
      ordersByChannel.push({ orderNo: orderNo as string | null, totalAvos: row.totalAvos, status, channel });
    }
    if (ordersByChannel.length > raw.ordersByChannelTotal) {
      return { ok: false, reason: "rpc-ordersch-exceed-total" };
    }
    ordersByChannelTotal = raw.ordersByChannelTotal;

    // ── dishesByChannel：全渠道菜品 ＋ 四個拆欄 ──
    if (!isNonNegativeSafeInt(raw.dishesByChannelTotal)) {
      return { ok: false, reason: "rpc-bad-dishesByChannelTotal" };
    }
    if (!isArrayChecked(raw.dishesByChannel)) return { ok: false, reason: "rpc-bad-dishesByChannel" };
    for (const row of raw.dishesByChannel as unknown[]) {
      if (!isPlainObject(row)) return { ok: false, reason: "rpc-bad-dishch-row" };
      const name = row.name;
      if (typeof name !== "string" || name.length < 1 || name.length > OFFLINE_REPORT_MAX_DISH_NAME_LEN) {
        return { ok: false, reason: "rpc-bad-dishch-name" };
      }
      if (!isNonNegativeSafeInt(row.qty)) return { ok: false, reason: "rpc-bad-dishch-qty" };
      if (!isNonNegativeSafeInt(row.revenueAvos)) return { ok: false, reason: "rpc-bad-dishch-revenue" };
      // 🔴 四個拆欄喺呢個 key 係**必填**：部分有 = SQL 寫漏 = 假零
      const present = DISH_SPLIT_KEYS.filter((k) => row[k] !== undefined);
      if (present.length !== DISH_SPLIT_KEYS.length) {
        return { ok: false, reason: "rpc-partial-dishch-split" };
      }
      for (const k of DISH_SPLIT_KEYS) {
        if (!isNonNegativeSafeInt(row[k])) return { ok: false, reason: `rpc-bad-dishch-split:${k}` };
      }
      // 🔴 加埋必須等於總數：唔等 = SQL merge 壞咗（例如漏咗某個 channel 分支）
      const qtySum = (row.offlineQty as number) + (row.onlineQty as number);
      if (qtySum !== row.qty) return { ok: false, reason: "rpc-dishch-split-qty-mismatch" };
      // 🔴🔴 金額同樣要守恆（2026-10-07 補）：淨守數量會漏咗「金額欄 merge 漏分支」呢類壞法。
      //   🔴 呢個**唔係** `offlineRevenueAvos + onlineRevenueAvos === revenueAvos` 就必然等於
      //      舊 `dishes[]` 同名行 —— 舊 `dishes[]` 包埋 `online_platform`，範圍唔同（見 §4.2.1）。
      const revSum = (row.offlineRevenueAvos as number) + (row.onlineRevenueAvos as number);
      if (revSum !== row.revenueAvos) return { ok: false, reason: "rpc-dishch-split-rev-mismatch" };
      dishesByChannel.push({
        name,
        qty: row.qty,
        revenueAvos: row.revenueAvos,
        offlineQty: row.offlineQty as number,
        offlineRevenueAvos: row.offlineRevenueAvos as number,
        onlineQty: row.onlineQty as number,
        onlineRevenueAvos: row.onlineRevenueAvos as number,
      });
    }
    if (dishesByChannel.length > raw.dishesByChannelTotal) {
      return { ok: false, reason: "rpc-dishch-exceed-total" };
    }
    dishesByChannelTotal = raw.dishesByChannelTotal;
  }

  return {
    ok: true,
    found: raw.found,
    from: raw.from,
    to: raw.to,
    clamped: raw.clamped,
    kpi: v1Kpi,
    byPayment,
    hasDetail,
    hasChannel,
    orders,
    ordersTotal,
    ordersTruncated: hasDetail && ordersTotal > orders.length,
    dishes,
    dishesTotal,
    dishesTruncated: hasDetail && dishesTotal > dishes.length,
    paymentBreakdown,
    ordersByChannel,
    ordersByChannelTotal,
    ordersByChannelTruncated: hasChannel && ordersByChannelTotal > ordersByChannel.length,
    dishesByChannel,
    dishesByChannelTotal,
    dishesByChannelTruncated: hasChannel && dishesByChannelTotal > dishesByChannel.length,
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
 * 🔴🔴 2026-10-07（0066）：J 拍板「**JSON 數據架構唔可以改**」⇒
 *    · `kpi` 五欄：`input.kpi` **原樣輸出**（連 `offline`/`online`/`onlinePlatform`
 *      三個新 key 都係喺 `kpi` 入面，唔會改名、唔會搬位）；
 *    · `byPayment`：**永遠照 v1 輸出**，唔會因為有渠道能力就改成全渠道；
 *    · `paymentBreakdown`：新 key，`hasChannel === false` 時**整個缺席**（唔係 `[]`）；
 *    · `flags.channelBreakdownAvailable` / `flags.ledgerOwnsOnlineRevenue`：`hasChannel === false` 時**缺席**。
 *
 * 🔴🔴 **方案 A（2026-10-07 J 拍板）**：`orders[]`／`dishes[]` **原樣輸出**（0060 口徑），
 *    `ordersTotal`／`dishesTotal` 亦照抄 —— 線上數據只喺 `ordersByChannel[]`／`dishesByChannel[]`。
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
  /** 0066 未跑時 `false` ⇒ `paymentBreakdown` 唔出、`flags` 唔宣告渠道。 */
  hasChannel?: boolean;
  orders: OfflineReportOrderRow[];
  ordersTotal: number;
  dishes: OfflineReportDishRow[];
  dishesTotal: number;
  /** 全渠道支付方式分項（只有 `hasChannel === true` 才有內容）。 */
  paymentBreakdown?: OfflineReportPaymentBreakdownRow[];
  /** 全渠道訂單明細（只有 `hasChannel === true` 才有內容）。 */
  ordersByChannel?: OfflineReportOrderRow[];
  ordersByChannelTotal?: number;
  /** 全渠道菜品排名 ＋ 拆欄（只有 `hasChannel === true` 才有內容）。 */
  dishesByChannel?: OfflineReportDishByChannelRow[];
  dishesByChannelTotal?: number;
  generatedAt: string;
}): OfflineReportResponse {
  const hasChannel = input.hasChannel === true && input.hasDetail;
  return {
    v: OFFLINE_REPORT_VERSION,
    storeId: input.storeId,
    from: input.range.from,
    to: input.range.to,
    generatedAt: input.generatedAt,
    kpi: input.kpi,
    breakdown: {
      // 🔴 `byPayment` 永遠照 v1 輸出（**唔會**因為有渠道能力就改成全渠道 ——
      //    咁樣 Ledger 嗰條 bar 上嘅「外賣平台」條會突然消失）。
      byPayment: input.byPayment,
      // 缺席 ≠ 空陣列：0066 未跑時連 key 都唔出，唔會被讀成「今日冇單」。
      ...(hasChannel ? { paymentBreakdown: input.paymentBreakdown ?? [] } : {}),
    },
    // 缺席 ≠ 空陣列：舊版（0059 未跑）連 key 都唔出，Ledger 就唔會 render 呢兩節。
    ...(input.hasDetail
      ? {
          orders: input.orders,
          ordersTotal: input.ordersTotal,
          dishes: input.dishes,
          dishesTotal: input.dishesTotal,
        }
      : {}),
    // 🔴🔴 線上數據**只喺呢四個新 key**（方案 A：舊欄一個數字都冇改）。
    //    `ordersByChannel` 先至有線上投影單；`orders[]` 永遠冇。
    ...(hasChannel
      ? {
          ordersByChannel: input.ordersByChannel ?? [],
          ordersByChannelTotal: input.ordersByChannelTotal ?? 0,
          dishesByChannel: input.dishesByChannel ?? [],
          dishesByChannelTotal: input.dishesByChannelTotal ?? 0,
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
      ...(hasChannel
        ? {
            ordersByChannelTruncated: (input.ordersByChannelTotal ?? 0) > (input.ordersByChannel?.length ?? 0),
            dishesByChannelTruncated:
              (input.dishesByChannelTotal ?? 0) > (input.dishesByChannel?.length ?? 0),
          }
        : {}),
      // 🔴 0066 未跑時**缺席**（唔係 `false` —— 唔可以聲稱一件冇發生嘅事）。
      ...(hasChannel
        ? {
            channelBreakdownAvailable: true,
            // 誠實揭露：線上營業額以 Ledger 自己嘅數據源為準，唔好同 `kpi` 相加
            // （v1 `kpi` 嘅口徑包埋咗外賣平台單）。
            ledgerOwnsOnlineRevenue: true,
          }
        : {}),
    },
  };
}
