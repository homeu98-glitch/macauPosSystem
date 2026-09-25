/**
 * Ledger「線下營業摘要」API —— **契約純邏輯**（零 `@/` 依賴，可被 `node --test` 直接載入）。
 *
 * 契約文件：`docs/integration/pos-offline-report-api.md`（Ledger 2026-09-24 發出）
 * 審視報告：`docs/integration/pos-offline-report-contract-review-2026-09-25.md`
 * 路線實作：`src/app/api/integration/ledger/offline-report/route.ts`
 * DB 聚合  ：`supabase/migrations/0058_pos_offline_report_rpc.sql`
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
 *   ④ 回應**只有聚合數字**，冇顧客個資、冇訂單明細、冇單號。
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

export type OfflineReportResponse = {
  v: typeof OFFLINE_REPORT_VERSION;
  storeId: string;
  from: string;
  to: string;
  generatedAt: string;
  kpi: OfflineReportKpi;
  breakdown: { byPayment: OfflineReportPaymentBucket[] };
  flags: { refundsNetted: boolean; clamped: boolean };
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
      clamped: boolean;
      kpi: OfflineReportKpi;
      byPayment: OfflineReportPaymentBucket[];
    }
  | { ok: false; reason: string };

/**
 * 嚴格驗證 0058 RPC 回嚟嘅 jsonb。
 *
 * 🔴 點解要驗自己嘅 RPC：契約明文「任何欄位型別不符 ⇒ Ledger 整包丟棄並顯示暫時無法取得」。
 *    與其送一份 Ledger 會扔嘅 payload，不如**我哋自己回 503**（Ledger 顯示降級一行），
 *    呢個就係「**唔可以渲染假零**」嘅落實位。任何唔確定 ⇒ 唔回 200。
 *
 * `expected` 由 route 自己按 clamp 規則算出；RPC 回嘅 `from`/`to`/`clamped` 一定要**逐位相等**
 * （Ledger 亦會核對，兩邊各自驗一次 = 雙保險）。
 */
export function validateOfflineReportRpc(raw: unknown, expected: ClampedRange): RpcValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: "rpc-not-object" };
  if (typeof raw.found !== "boolean") return { ok: false, reason: "rpc-bad-found" };
  if (typeof raw.clamped !== "boolean") return { ok: false, reason: "rpc-bad-clamped" };
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

  return {
    ok: true,
    found: raw.found,
    clamped: raw.clamped,
    kpi: {
      orderCount: raw.orderCount as number,
      revenueAvos: raw.revenueAvos as number,
      refundedAvos: raw.refundedAvos as number,
      discountAvos: raw.discountAvos as number,
      covers: raw.covers as number,
    },
    byPayment,
  };
}

/**
 * 組出契約 §回應 200 嘅**完整** payload。
 *
 * ⚠️ `breakdown` 只有 `byPayment` —— 契約嘅 `dineIn` / `quick` 兩格係 optional，
 *    而 POS `/reports` 根本冇「堂食／快餐 × 營業額」呢個維度（2026-09-25 用戶拍板：v1 唔出），
 *    所以**省略**而唔係回 0（回 0 會被當成真數據）。
 */
export function buildOfflineReportResponse(input: {
  storeId: string;
  range: ClampedRange;
  kpi: OfflineReportKpi;
  byPayment: OfflineReportPaymentBucket[];
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
    flags: { refundsNetted: false, clamped: input.range.clamped },
  };
}
