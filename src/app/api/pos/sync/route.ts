import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { isMissingColumnError, isUniqueViolationError } from "@/lib/supabase-errors";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";
import { decideOrderWrite, describeWriteGateRejection } from "@/lib/pos/write-gate";
import {
  isPosDeviceAuthRequired,
  readPosDeviceTokenFromRequest,
} from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { totalItemQuantity, refundRecordCount } from "@/lib/pos/order-item-diff";
import { addedItemsOfEventPayload, unwrapOrderEventPayload } from "@/lib/pos/sync-order-payload";
import { touchPosSession } from "@/lib/pos/session-registry-server";
import {
  POS_BUILD_HEADER,
  POS_SESSION_HEADER,
  SESSION_TOUCH_THROTTLE_MS,
  sanitizeBuildId,
  sanitizeSessionKey,
} from "@/lib/pos/session-record";
import {
  flushQueueEventRows,
  type QueueEventsUpsertClient,
} from "@/lib/pos/queue-event-batch";
import type { OrderItem } from "@/lib/types";

/**
 * POST /api/pos/sync — 收銀 / Kiosk 離線優先同步入口。
 *
 * 2026-08-31 資安加固（見 docs/89 §2）：
 *   1. 寫入改行 `getSupabaseWriteClient()`（service_role only，唔再 fallback anon key）。
 *      0016 migration 已將所有業務表收做 service_role-only，留 anon fallback 會靜默寫入失敗。
 *   2. 加輸入驗證：body 大小、events 數量、storeId 白名單字元、字串長度、陣列長度、數值範圍。
 *      之前任何人都 POST 任意 JSON 落嚟（`storeId` 任意、items 無上限）→ 可寫爆 DB / 跨店污染。
 *   3. 錯誤訊息唔再直出 DB 內部訊息（會洩漏 schema / 欄位名），改記 server log、對外返通用訊息。
 *
 * 2026-08-31 party_size 上雲（見 docs/89 §3）：upsert 同 ORDER_SETTLED 都會寫 `party_size`。
 *
 * 2026-09-01 comp_note / comped_at 上雲（見 docs/91）：免單備註要落 `pos_orders` 直欄，
 *   否則換機／清 cache 由 server state reload 之後會冇咗（本地有、雲端冇）。
 *
 * 2026-09-06 跨店隔離（0022 migration，見 docs/pos-cross-store-isolation-fix-plan.md）：
 *   事件自帶 `storeId`（client `withStoreScope()` 於產生嗰刻 stamp）。本路由驗證
 *   `event.storeId === 請求 storeId`，唔一致即拒收（跨店事件）—— 杜絕「flush 嗰刻
 *   邊個登入，張單就歸邊間店」嘅舊行為（切帳號後外店訂單被請求級 storeId 蓋章
 *   寫入 pos_orders 嘅 root cause）。`pos_queue_events` 同步落 `store_id` 欄。
 */

// ─────────────────────────────────────────────────────────────
// 輸入驗證常數
// ─────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB：一張單最多幾百個 item，綽綽有餘
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_ORDER_ITEMS = 500;
const MAX_ID_LEN = 128;
const MAX_STORE_ID_LEN = 64;
const MAX_TEXT_LEN = 2000; // order_note / 備註
const MAX_NAME_LEN = 200;
/**
 * 出紙內容唯一鍵上限（`<orderId>|<onceScope>|<printerId>`，見 migration 0045）。
 * 實際長度約 60–120 字（`ledger-<uuid>` 43 字 + scope + `printer-xxxxxxxx`）。
 * ⚠️ 超過上限**唔用**（唔截斷）—— 截斷會令兩條唔同鍵撞成同一條 → 誤攔真出紙。
 */
const MAX_ONCE_KEY_LEN = 240;
const MAX_PARTY_SIZE = 999; // 對齊 0017 migration 嘅 CHECK 約束
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// 注意：唔好加 DEFAULT_STORE_ID fallback。缺 storeId 一定要大聲失敗（400），
// 否則會靜默寫入假店（舊日嘅 "macau-store-a"），令雲端中繼配咗對但一張都印唔出。

/**
 * `pos_queue_events` 每批 upsert 嘅行數上限（2026-09-21 egress 優化）。
 *
 * 背景：舊版**逐個事件** upsert（N 個事件 ＝ N 個 PostgREST POST）。
 * 實測 2026-09-21（Supabase log）：單一表 `pos_queue_events` 26 分鐘內 **150 次 POST**，
 * 係整個專案請求數第一位，而 `/api/pos/sync` 由 client 睇其實只係**一個** HTTP 請求。
 *
 * 為咩要分 chunk，唔一次過塞最多 200 行：
 *   ① `payload` 係完整訂單快照（≈1.7 KB／行），200 行可以到 ~340 KB；分 100 行一批
 *      令每個 body 保持細（~170 KB），對 PostgREST 嘅 body 上限留足餘量。
 *   ② `onConflict: "id"` 之下，同一批內**重複 id** 會觸發 Postgres 21000
 *      （cannot affect row a second time）→ 會令整批失敗。所以寫入前一定要先去重
 *      （見下面 `queueRowsById`）。
 */
const QUEUE_EVENTS_UPSERT_CHUNK = 100;

/**
 * `pos_queue_events` 一批審計行嘅形狀（`payload` 直落 JSONB，所以係 unknown）。
 *
 * ⚠️ `entity_id` / `status` 保留 `| null`：`text()` 對非字串輸入會回 `null`，
 * 而舊版逐條 upsert 就係直接寫呢個值 —— 型別要忠實反映，否則就係偷偷改咗行為。
 */
type QueueEventRow = {
  id: string;
  type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  status: string | null;
  created_at: string;
  store_id: string | null;
};

/**
 * `pos_orders` 嘅「退款 / 退菜審計 3 欄」係唔係存在？——**每個 server instance 只探一次**
 *（2026-09-21 修正：營業中每 30 秒一個 Postgres `ERROR` 嘅根因）。
 *
 * ## 問題（實測）
 *
 * Supabase log（營業中，5.5 分鐘）：**11 個 `error 42703`**
 * `column pos_orders.refund_records does not exist` ＋ **11 個 `warning 400`**
 *（`GET /rest/v1/pos_orders?select=…,refund_records,refunded_amount,voided_items…`）
 * —— 即係**每次 `/api/pos/sync` 都撞一次**（實測每 30 秒一次，＝每次 flush）。
 *
 * ## 成因
 *
 * `refund_records` / `refunded_amount` / `voided_items` 呢 3 欄：
 *   · **43 條 migration 全部冇定義**（已 grep 全 repo 確認）；
 *   · **全 codebase 冇任何地方寫入**（只有本檔讀）。
 * ⇒ 舊版每次都試 9 欄、每次都 42703、每次都降級再查 6 欄
 *   ⇒ **每個 sync 白打一個註定失敗嘅查詢 ＋ 白寫一條 Error 級 Postgres log**。
 *
 * ## 修法（為何係零功能影響）
 *
 * 加一個 **per-instance 快取**：第一次照試（保留「將來真係加咗欄就自動啟用」嘅能力），
 * 確認唔存在之後就直接查 6 欄。
 *
 * · **結果完全相同**：呢 3 欄從來冇存在過 ⇒ 實際一直行嘅都係 6 欄嗰條
 *   ⇒「降級之後嘅資料」同「唔試直接查」**逐欄一樣**。
 * · **唔會鎖死**：快取係 per server instance（in-memory），每次 cold start 重探一次
 *   ⇒ 將來真係跑 migration 加返呢 3 欄，新 instance 會自動用返 9 欄，**唔使改 code**。
 * · **失敗行為不變**：6 欄查詢照樣有 error handling；`existingById` 全空時嘅
 *   `console.error` 同「LWW 守門降級為無條件寫入」嘅既有行為一字不改。
 */
let refundAuditColumnsAvailable: boolean | null = null;

const VALID_EVENT_TYPES = new Set([
  "ORDER_CREATED",
  "ORDER_UPDATED",
  "ORDER_ITEM_VOIDED",
  "ORDER_SETTLED",
  "ORDER_DELETED",
  "DEVICE_CONFIG_UPDATED",
  "PRINT_JOB_CREATED",
  "PRINT_JOB_DELETED",
  "TEST_PRINT_REQUESTED",
]);

/** 截斷字串（防止超長輸入寫爆 jsonb / text 欄）。非字串一律 null。 */
function text(value: unknown, maxLen = MAX_TEXT_LEN): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

/** 安全整數：非數字 / NaN / 負數 → null；超過 max → clamp。 */
function intOrNull(value: unknown, max = 1_000_000_000): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 1) return null;
  return Math.min(i, max);
}

/** 金額：非數字 → 0；clamp 到 ±1e9，避免 numeric 溢出 / 負數亂寫。 */
function money(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1_000_000_000, Math.min(1_000_000_000, n));
}

/**
 * UUID 或 null（`member_customer_id` 用）。
 *
 * ⚠️ 唔可以只用 `text()`：`pos_orders.member_customer_id` 係 **`uuid`** 型別，
 * Postgres 收到唔合法嘅字串會**直接報錯**，令成個 upsert 失敗（張單寫唔入雲），
 * 而唔係靜靜截斷。所以要驗過形狀先寫。
 */
function uuidOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

/**
 * avos 金額：非數字 / ≤0 → 0。
 *
 * `member_deduction_avos` 係 `bigint not null default 0` —— 寫 `NULL` 會 violate
 * not-null constraint，令整張單上唔到雲。所以一定要落 0 而唔係 null。
 */
function avosOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.trunc(n), 1_000_000_000);
}

/** 入座人數：只接受 1..999 嘅整數，其餘一律 null（對齊 DB CHECK，避免 upsert 成單成批失敗）。 */
function partySizeOrNull(value: unknown): number | null {
  return intOrNull(value, MAX_PARTY_SIZE);
}

/**
 * 打印任務有效期（`pos_print_jobs.ttl`，epoch **millis** 絕對期限）。
 *
 * ── 🔴 2026-09-15（P1）為咩要喺 server 端補呢個欄 ──────────────────────
 * `ttl` 由 0020 加咗落表，`types.ts:1399` 亦有型別宣告，但**全 repo 冇任何一處寫入過**：
 *   - 客戶端 `PrintJob` 從來冇設 `ttl`（所有 builder 都冇）；
 *   - 呢個 route 舊寫法嘅 `contentPatch` 同 `insert` **都冇 `ttl`** ⇒ 恆為 NULL。
 * ⇒ `0035` 第 60 行嘅守衛 `j.ttl is null or j.ttl > now_ms` **永遠成立 = 死代碼**，
 *   即「隔夜補印」完全冇保護（2026-09-15 生產事故：58 張 9/11–9/15 嘅舊 pending 單
 *   一直掛住，中繼機一恢復就全部出紙）。
 *
 * 做法：**由 server 落章**（唔靠 client），因為
 *  ① 各端時鐘唔一致（client 可能係 iPad，時區／NTP 偏差）；
 *  ② client 即使漏寫都仍然有保護（呢個 route 係上雲嘅唯一入口）。
 *
 * 期限 = `created_at + 12 小時`：
 *  - 同一營業日足夠長（餐飲營業日一般 ≤ 12h）；
 *  - 12 小時之後嘅單一定係跨日舊單，唔應該再突然出紙。
 *
 * ⚠️ 一定要用 `created_at` 計，唔可以用 `now()` 計 —— 否則一條**補推嘅舊事件**
 *    （離線 2 日後才上雲）會被當成「新鮮單」，ttl 寫成「今日 + 12h」，
 *    隔夜保護即刻失效。
 */
const PRINT_JOB_TTL_MS = 12 * 60 * 60 * 1000;

function printJobTtl(createdAtIso: string | null): number {
  const createdMs = createdAtIso ? Date.parse(createdAtIso) : NaN;
  const base = Number.isFinite(createdMs) ? createdMs : Date.now();
  return base + PRINT_JOB_TTL_MS;
}

/**
 * 只保留「同一個澳門營業日」內嘅任務可以再被認領。
 *
 * 同 `ttl` 係**兩重**保護，唔係重複：
 *  - `ttl` = 建單起 12 小時（Rolling，跨日都仲可能未過）。
 *  - 呢個 = **絕對**邊界（澳門時間當日 23:59:59.999）→ 收工後唔會再出昨日嘅單。
 *
 * @returns 該單嘅營業日截止 epoch millis
 */
function printJobBusinessDayEnd(createdAtIso: string | null): number {
  // 澳門 = UTC+8，冇夏令時間，所以固定 +8 小時偏移就準（同報表口徑一致）。
  const MACAU_OFFSET_MS = 8 * 60 * 60 * 1000;
  const createdMs = createdAtIso ? Date.parse(createdAtIso) : NaN;
  const base = Number.isFinite(createdMs) ? createdMs : Date.now();
  const macau = new Date(base + MACAU_OFFSET_MS);
  const dayEndMacauMs = Date.UTC(
    macau.getUTCFullYear(),
    macau.getUTCMonth(),
    macau.getUTCDate(),
    23,
    59,
    59,
    999,
  );
  return dayEndMacauMs - MACAU_OFFSET_MS;
}

/**
 * 收據二維碼點陣（0020 `pos_print_jobs.qr` jsonb，`{ size, bits }`）。
 *
 * ⚠️ 呢欄係 print-relay APK 出紙二維碼嘅**唯一來源**：APK `fromRow` 讀 row 嘅 `qr`
 * → `qrRaster()` 用 `GS v 0` 點陣圖指令出紙。舊版呢個 route 淨係冇寫 `qr`／`qr_url`
 * → 雲端行永遠 NULL → APK 靜默跳過 `qr_code` 區塊 → 實體收據永遠冇二維碼
 * （網頁預覽讀 localStorage 嘅 job 有 qr，所以「設計==預覽==出紙」斷喺最後一環）。
 * 結構唔對（唔係 `{size,bits}` / bits 唔夠長）→ 返 null 留空，唔好寫壞數據落 DB。
 */
function qrPayloadOrNull(value: unknown): { size: number; bits: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { size?: unknown; bits?: unknown };
  const size = typeof raw.size === "number" ? Math.trunc(raw.size) : 0;
  if (size < 21 || size > 177) return null; // QR version 1..40 嘅合法 module 邊長
  if (typeof raw.bits !== "string") return null;
  const bits = raw.bits.replace(/[^01]/g, "");
  if (bits.length < size * size) return null;
  return { size, bits: bits.slice(0, size * size) };
}

/**
 * ISO 時間戳：非字串 / 空 / 唔係合法時間 → null。
 *
 * 同 `text()` 唔同：`comped_at` 呢類 `timestamptz` 欄位，Postgres 收到非法字串會**直接報錯**，
 * 令成個 upsert 失敗（張單寫唔入雲），而唔係靜默截斷。所以必須驗過先寫。
 * 回傳 null 只係「呢一欄留空」，唔影響同一行其他欄。
 */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * 終態訂單狀態（2026-09-09 LWW / 終態守門，docs/桌台回退根因）：
 * 呢啲狀態代表「單已經完結」，唔可以被一部離線機重推嘅「結帳前」open snapshot 降級。
 * 唯一合法嘅終態 → open 轉移係明確 `reopened`（返結帳），唔喺呢個 set 內。
 */
const TERMINAL_ORDER_STATUSES = new Set(["settled", "cancelled", "refunded", "partially_refunded"]);

/**
 * 已收款狀態（2026-09-12 付款階段單向閘）。
 *
 * 快餐 counter 單結帳後係 `paid`（唔係 `settled` —— 佢要等出餐「完成」先 terminal），
 * 所以 `TERMINAL_ORDER_STATUSES` **擋唔到**佢被 open snapshot 降級。
 *
 * 實案（用戶反映）：快餐單撳完結帳顯示「已結帳」，跟住一條時序亂咗嘅
 * `ORDER_UPDATED`（帶 `status: "sent_to_kitchen"`、但 `client_updated_at` 較新）上到雲，
 * 就把 `paid` 打返做「未結帳」。同 client 端 `mergeOrderLists()` 嘅付款階段單向閘口徑一致。
 */
const PAID_ORDER_STATUSES = new Set(["paid", "settled", "refunded", "partially_refunded"]);

/** 未收款嘅 open 狀態 —— 唯一兩種可以（錯誤地）覆蓋已收款單嘅狀態。 */
const OPEN_ORDER_STATUSES = new Set(["draft", "sent_to_kitchen"]);

/** 解析 ISO 時間戳做毫秒數；非法 → 0（當最舊）。 */
function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** 已有 row 記錄（LWW / 終態守門比較用）。 */
type ExistingOrderRow = {
  id: string;
  status: string | null;
  /** 2026-09-10 P2-2：客人加單（匿名）時要保留收銀端已標記嘅出餐狀態。 */
  fulfillment_status: string | null;
  /**
   * 2026-09-10 加單修復：現有單嘅菜品快照（jsonb）。
   * 用嚟判斷「客人今次係**加菜**（項目變多）」——加菜係**加法**，唔應該被
   * 時間戳 LWW 判 stale 而靜默丟棄（見下面 isAdditiveUpdate 註解）。
   */
  items: unknown;
  updated_at: string | null;
  /**
   * 方案 B（2026-09-09）：client 生成嘅時間戳（裝置時鐘）。
   * `updated_at` 改為 server 蓋章（Vercel/DB 時鐘）之後，LWW 比較必須用同鐘域嘅
   * client 時間先有意義 —— 否則「Vercel 收件時間」永遠新過「任何 client 時間」，
   * 守門會拒絕晒所有正常更新。呢欄由 client updatedAt 寫入；migration 0029 已將
   * 舊行 backfill 做 updated_at（舊 row 本來就係 client 蓋章）。
   */
  client_updated_at: string | null;
  /**
   * 🔴 退款審計欄（2026-09-17 退貨修復）—— 判斷「今次更新係唔係一次退貨」嘅唯一可靠信號。
   *
   * `refund_records` 只會**追加**（`applyReturnToOrder()` 永不覆寫）⇒ 筆數增加 = 新退款；
   * `refunded_amount` 係累計值；`voided_items` 係退菜紀錄（餐飲全退 / 單項退）。
   *
   * 舊 row / 未跑 migration 嘅環境冇呢幾欄 → undefined，helpers 一律當 0 處理。
   */
  refund_records?: unknown;
  refunded_amount?: number | null;
  voided_items?: unknown;
};

/**
 * 按事件回執（方案 C + docs/112 L1）。
 *
 * ⚠️ `ok` 同 `applied` 係**兩個唔同嘅問題**，新舊 client 靠唔同欄位分流：
 *   - `ok`：呢條事件 server 受理咗（舊 client 靠佢決定剷唔剷事件）。為了向後兼容，
 *     「stale / 終態降級」呢類**有意跳過**嘅情況仍然係 `ok:true`。
 *   - `applied`：呢條事件**真係有寫入 `pos_orders`**。新 client 只認呢個欄位。
 *     舊 client 唔識 `applied`，會照 `ok` 剷走事件 —— 所以客戶端仲需要
 *     「常駐對賬守護」做第二道保險（見 src/lib/pos/sync-reconcile-daemon.ts）。
 *
 * `reason`（applied=false 時）：stale / downgrade / unauthorized / not-found / db-error / ack-skip。
 */
type EventAck = {
  id: string;
  ok: boolean;
  applied?: boolean;
  reason?: string;
  error?: string;
};

export async function POST(request: Request) {
  // ── 0) body 大小閘：超大 body 直接拒，唔好入 JSON.parse ──
  const declaredLen = Number(request.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "請求內容過大" }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤（不是合法 JSON）" }, { status: 400 });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "請求格式錯誤" }, { status: 400 });
  }

  const payload = raw as Record<string, unknown>;
  const events = Array.isArray(payload?.events) ? payload.events : [];

  // ── 1) storeId 驗證：長度 + 白名單字元（防 path/JSON 注入 + 跨店亂寫）──
  const rawStoreId = typeof payload?.storeId === "string" ? payload.storeId.trim() : "";
  if (!rawStoreId) {
    // 大聲失敗：寧願 sync 報錯，都唔好靜默寫入預設店。
    // 正常情況下 client 會由 resolveStoreId()（登入 merchantId 或 kiosk 綁定）帶上 storeId。
    return NextResponse.json(
      {
        ok: false,
        error:
          "缺少 storeId：本機未帶店舖識別（未登入 POS 帳號，或自助點餐機未綁定店舖）。請重新登入 POS 帳號後再試。",
      },
      { status: 400 },
    );
  }
  const storeId = rawStoreId;
  if (storeId.length > MAX_STORE_ID_LEN || !STORE_ID_PATTERN.test(storeId)) {
    return NextResponse.json({ ok: false, error: "storeId 格式不合法" }, { status: 400 });
  }
  // ⚠️ 格式檢查擋唔到假店：`macau-store-a` 完全符合 STORE_ID_PATTERN。
  // 照寫落 pos_print_jobs.store_id 會變「雲端中繼配咗對、但一張單都印唔出」嘅
  // silent failure（Realtime filter 永遠唔 match）。所以呢度要額外過黑名單。
  // 見 src/lib/pos/store-id-guard.ts 嘅註解。
  if (isPlaceholderStoreId(storeId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `storeId「${storeId}」係示範店代碼，唔係真實商戶 ID。請重新登入 POS 帳號 —— ` +
          `本機帶住嘅店舖識別應該係登入攞到嘅 merchants.id。`,
      },
      { status: 400 },
    );
  }

  // ── 2) events 數量閘 ──
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return NextResponse.json(
      { ok: false, error: `單次同步事件過多（上限 ${MAX_EVENTS_PER_REQUEST}）` },
      { status: 413 },
    );
  }

  // ── 2.2) 通道授權（2026-09-10 審查 P0-3）──
  // 背景：`/api/pos/sync` 用 service_role 寫入，而枱 QR 已經公開 storeId
  //（`/menu?tableId=…&store=<merchantId>`），全 repo 又冇 middleware →
  // 掃過碼嘅人可以直接偽造 / 刪除訂單。家陣分兩條通道：
  //
  //   A. **已授權**（帶有效 POS 終端憑證，或 admin session token）→ 全部事件類型放行。
  //      憑證由 `/api/ledger/login` 登入時簽發（server 端唯一權威知道 merchantId 嘅地方）。
  //   B. **匿名**（客人掃碼 / kiosk 未登入）→ **只准** `ORDER_CREATED` / `ORDER_UPDATED`，
  //      而且 payload `source` 必須係 `scan` / `kiosk`。結帳、刪單、打印任務、設定一律拒。
  //
  // 應急回滾：設定 `POS_REQUIRE_DEVICE_AUTH=0` 可以暫時關閉（會寫 warning log）。
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const ip = clientIp(request);
  const authEnforced = isPosDeviceAuthRequired();
  const authorized =
    !authEnforced ||
    Boolean(adminClaims) ||
    Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authEnforced) {
    console.warn(
      "[pos/sync] ⚠️ POS_REQUIRE_DEVICE_AUTH=0：跳過通道授權（應急模式，請盡快恢復）。",
    );
  } else if (!authorized) {
    // 匿名通道：唔算錯誤（客人掃碼正常行），只落 debug 級提示
    console.info(`[pos/sync] 匿名通道請求（store=${storeId}, ip=${ip}）`);
  }

  // ── 2.1) Rate limit（2026-09-10 資安加固 P0-3 / P3-5）──
  //
  // ⚠️ 2026-09-10 修正（加單「冇反應」事故）：原本**一律用 client IP** 做 key，
  // 但餐飲現場全部裝置（收銀機、自助機、客人手機、廚房平板）都係經**同一個 NAT
  // 公網 IP** 出街 → 收銀機自己嘅同步流量會同客人爭同一個額度，busy 時段會
  // 自我 DoS：`sync` 被 429 擋 → client 當網絡抖動重試 → 最後靜默入隊。
  // 家陣分流：
  //   - **已授權**（收銀機 / 自助機，帶憑證）→ 按 **storeId** 計，額度拉高（600/min）。
  //     同一間店所有機共用一個池，唔會因為場內 IP 被外人拉低。
  //   - **匿名**（掃碼客）→ 按 IP 計，額度放寬到 300/min（一家人同一個 Wi-Fi / CGNAT
  //     之下多部手機共用一個 IP，120 太窄）。
  const rlKey = authorized ? `pos-sync:store:${storeId}` : `pos-sync:ip:${ip}`;
  const rlMax = authorized ? 600 : 300;
  if (!rateLimit(rlKey, rlMax, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。", retryable: true }, { status: 429 });
  }

  /** 匿名通道只准嘅事件類型。 */
  const ANONYMOUS_ALLOWED_EVENTS = new Set(["ORDER_CREATED", "ORDER_UPDATED"]);
  /** 匿名通道只准嘅訂單來源（客人掃碼 / 自助點餐機未登入）。 */
  const ANONYMOUS_ALLOWED_SOURCES = new Set(["scan", "kiosk"]);

  // 寫入一律 service_role（0016 之後 anon 已經寫唔入，留 fallback 只會靜默失敗）
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    console.error("[pos/sync] SUPABASE_SERVICE_ROLE_KEY 未設定，寫入拒絕。");
    return NextResponse.json(
      {
        ok: false,
        error:
          "Supabase 伺服器端未配置（缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY），落單無法寫入。",
      },
      { status: 503 },
    );
  }

  if (events.length === 0) {
    return NextResponse.json({ ok: true, syncedCount: 0, receivedAt: new Date().toISOString() });
  }

  // ── 2.7) 工作階段續期（2026-09-22，migration 0047）──────────────────────
  //
  // 寫入請求係「有人喺度做嘢」嘅最強訊號，所以喺呢度續期（60 秒節流）。
  // `allowCreate: true` —— 舊分頁（開喺 login 加 header 之前）第一次寫入就會自動登記，
  // 唔需要佢重新登入。GET 側（`/api/pos/state`）係 `allowCreate: false`，
  // 保持「讀取唔創造狀態」。
  //
  // 🔴 零新增請求、零阻擋：`touchPosSession()` 永遠唔 throw；查唔到就當「未知」。
  const syncSessionKey = sanitizeSessionKey(request.headers.get(POS_SESSION_HEADER));
  const syncSessionTouch =
    authorized && deviceClaims && deviceClaims.storeId === storeId && syncSessionKey
      ? await touchPosSession({
          storeId,
          sessionKey: syncSessionKey,
          buildId: sanitizeBuildId(request.headers.get(POS_BUILD_HEADER)),
          account: deviceClaims.account ?? null,
          role: deviceClaims.role ?? null,
          ip,
          userAgent: request.headers.get("user-agent"),
          throttleMs: SESSION_TOUCH_THROTTLE_MS,
          allowCreate: true,
        })
      : null;
  /**
   * 管理員已強制關閉呢個工作階段？
   *
   * 交畀 `decideOrderWrite()`（下面授權通道寫入閘）一齊判斷，**唔喺呢度直接拒** ——
   * 咁「只擋新生意、結帳／退款／刪單／出紙照放行」呢條口徑就只有一份
   *（`@/lib/pos/write-gate`，有單測）。
   */
  const sessionRevoked = Boolean(syncSessionTouch?.revokedAt);
  if (sessionRevoked) {
    console.warn(
      `[pos/sync] 此工作階段已被管理員關閉（store=${storeId}, session=${syncSessionKey}）` +
        "：只擋新生意，結帳／退款／刪單／出紙照放行。",
    );
  }

  // ── 2.55) 店內營業閘（2026-09-14，migration 0039）：匿名落單時服務端把關 ──
  //
  // 客人掃碼 / kiosk 落單係**匿名**（冇 POS 憑證），店員把「店內營業」撳成暫停之後，
  // 客人端手上嗰個餐牌頁完全唔會知（除非佢自己 reload）—— 呢度就係**權威閘**。
  //
  // 口徑（同售罄校驗一致）：
  //   - 只擋**匿名**（`!authorized`）。收銀台帶憑證落單 / 結帳**唔受影響** ——
  //     店員要照樣做嘢（逃生門：客人已坐低、要補單之類）。
  //   - 查唔到（migration 未跑 42P01 / 網絡失敗）→ **放行**（fail-open）。
  //     反過來當「全部停業」就會一斷網全店客人落唔到單。
  //   - 未設定過 row → 營業中（default true，見 0039）。
  //
  // ⚠️ 呢個查詢每個 request **只做一次**（唔好逐個 event 打 DB），
  //    同下面 `soldoutSet` 同一個 pattern。
  let storeClosed = false;
  /**
   * 🔴 2026-09-21：閘要唔要查，唔再單睇 `authorized`。
   *
   * 以前兩道閘（2.55 / 2.56）都係 `if (!authorized)` ⇒ **收銀台帶憑證就完全唔受影響**
   * ⇒「店已關／已收工，收銀台照樣開新單」（J 2026-09-21 回報嘅錯行為）。
   *
   * 而家：只要請求**含有 `ORDER_CREATED` / `ORDER_UPDATED`**（＝可能係「開新生意」），
   * 就一律查一次狀態（**每個 request 仍然只查一次**，唔會逐個 event 打 DB）。
   * 純基建／出紙／結帳類事件唔會白查。
   */
  const hasOrderWriteEvents = events.some((rawEvent) => {
    if (typeof rawEvent !== "object" || rawEvent === null) return false;
    const t = (rawEvent as Record<string, unknown>).type;
    return t === "ORDER_CREATED" || t === "ORDER_UPDATED";
  });
  const needsStoreGate = !authorized || hasOrderWriteEvents;
  // ⚠️ 用 `!authorized` 而唔係 `anonymousOrderEvents`：後者喺下面 2.6 段先宣告，
  //    而匿名請求本身就只准 ORDER_CREATED / ORDER_UPDATED（上面已擋其他類型）→ 兩者等價。
  if (needsStoreGate) {
    const { data: statusRow, error: statusErr } = await supabase
      .from("pos_store_status")
      .select("is_open")
      .eq("store_id", storeId)
      .maybeSingle();
    if (statusErr) {
      // 表未建立（42P01）會行呢度 → 放行。唔可以當「已暫停」。
      console.warn("[pos/sync] 營業狀態查詢失敗，本次放行:", statusErr.message);
    } else if (statusRow && statusRow.is_open === false) {
      storeClosed = true;
    }
  }

  // ── 2.56) 班次（開工）閘（2026-09-18）：匿名落單時服務端把關 ──
  //
  // ── 點解要加 ─────────────────────────────────────────────────────────────
  // 收銀台落單本身有 `ensureShiftOpened()` 把關（未開工唔准開單），但**客人端冇**：
  // 掃碼 / kiosk 係匿名通道，未開工照樣落得到單 → 收銀機收咗班、店入面冇人做嘢，
  // 客人仍然落單，單只會靜靜躺喺雲端冇人接（J 2026-09-18 回報嘅同一個缺口）。
  //
  // ── 口徑（同 2.55 一致，刻意唔另立一套）────────────────────────────────
  //   - 只擋**匿名**（`!authorized`）。收銀台帶憑證，即使未開工都唔受影響 ——
  //     店員要開工前先試單、或者用收銀台補單嘅逃生門要留住。
  //   - 查唔到（42P01 / 網絡失敗）→ **放行**（fail-open）。呢點極重要：
  //     反過來「查唔到就當未開工」＝一斷網全店即刻落唔到單。
  //   - **查唔到 `pos_shifts` 有任何未收工嘅班次 → 當未開工**（同 2.55 default 相反，
  //     見下面解釋）。
  //
  // ── ⚠️ 同 2.55 嘅 default 方向唔同，係**故意**嘅 ─────────────────────────
  // `pos_store_status` 未設定過 row ＝ 營業中（default true，0039）：因為嗰個掣
  // 係「店主主動暫停」，冇設定過即係冇暫停過。
  // 但 `pos_shifts` 冇 open row ＝ **真係未開工**：班次係每日開工時實際寫入嘅事實記錄，
  // 冇記錄就係冇開過工。所以呢度唔會 fail-open 成「當已開工」。
  //
  // ⚠️ 同 2.55 一樣：每個 request **只查一次**，唔好逐個 event 打 DB。
  let shiftClosed = false;
  if (needsStoreGate && !storeClosed) {
    const { data: openShiftRows, error: shiftErr } = await supabase
      .from("pos_shifts")
      .select("id")
      .eq("store_id", storeId)
      .is("closed_at", null)
      .limit(1);
    if (shiftErr) {
      // 表未建立（42P01）／查詢失敗 → 放行（fail-open，唔可以一斷網全店停單）
      console.warn("[pos/sync] 班次狀態查詢失敗，本次放行:", shiftErr.message);
    } else if ((openShiftRows ?? []).length === 0) {
      shiftClosed = true;
    }
  }

  // ── 2.6) 售罄校驗（2026-09-10 審查 P1-2）：匿名落單時服務端把關 ──
  // 客人端只靠 Realtime 增量，掃碼嗰刻已售罄嘅菜照樣落得到單。呢度喺 server 端
  // 對「匿名 + 有 order 事件」嘅請求預取本店售罄集合，命中即拒（收銀端有憑證，唔受影響）。
  let soldoutSet: Set<string> | null = null;
  const anonymousOrderEvents = !authorized
    ? events.filter((rawEvent) => {
        if (typeof rawEvent !== "object" || rawEvent === null) return false;
        const t = (rawEvent as Record<string, unknown>).type;
        return t === "ORDER_CREATED" || t === "ORDER_UPDATED";
      })
    : [];
  if (anonymousOrderEvents.length > 0 && !storeClosed) {
    const { data: soldoutRows, error: soldoutErr } = await supabase
      .from("pos_soldout")
      .select("menu_item_id")
      .eq("store_id", storeId)
      .eq("sold_out", true);
    if (soldoutErr) {
      // 查唔到唔好當「全部售罄」：放行（客人端 UI 仲有守門，收銀端都會再確認）
      console.warn("[pos/sync] 售罄校驗查詢失敗，本次跳過:", soldoutErr.message);
    } else {
      soldoutSet = new Set(
        (soldoutRows ?? [])
          .map((row) => (typeof row.menu_item_id === "string" ? row.menu_item_id : null))
          .filter((id): id is string => Boolean(id)),
      );
    }
  }

  // ── 2.5) LWW / 終態守門（2026-09-09）：一次過預取今批事件會撞到嘅 pos_orders 行 ──
  // 舊實作對 ORDER_CREATED/ORDER_UPDATED 係無條件 upsert（onConflict:id）→ 任何一部裝置
  // 重推一條「結帳前」嘅舊 snapshot（離線排隊 / v1 去重輸家）都會將雲端已 settled 嘅單
  // 打返做 sent_to_kitchen ——「收銀機手動更新後 8 枱回退做未結帳」嘅根因。家陣：
  //   a) incoming updated_at < 現有 row updated_at → stale，跳過唔寫（LWW）；
  //   b) 現有 row 係終態（settled/cancelled/refunded/partially_refunded）而 incoming 唔係
  //      終態、又唔係明確 reopened → 唔准降級。
  const orderIds = new Set<string>();
  for (const rawEvent of events) {
    if (typeof rawEvent !== "object" || rawEvent === null) continue;
    const ev = rawEvent as Record<string, unknown>;
    const t = typeof ev.type === "string" ? ev.type : "";
    const p = (typeof ev.payload === "object" && ev.payload !== null ? ev.payload : {}) as Record<string, unknown>;
    let candidate: Record<string, unknown> | undefined;
    if (t === "ORDER_CREATED" || t === "ORDER_UPDATED") {
      // ⚠️ 兩種 type 用**同一條**拆解規則（`unwrapOrderEventPayload`，2026-09-16 修）：
      // 舊寫法只喺 ORDER_UPDATED 拆 `.order` → 線上單橋接（`ledger-pos-bridge.ts`）嘅
      // ORDER_CREATED（payload = `{ order }`）喺呢度預取唔到現有 row → LWW 守門靜默失效
      // （有機會將已 settled 嘅單降級）。規則統一收喺 `@/lib/pos/sync-order-payload`，
      // 附迴歸測試，唔好喺呢度再自己寫一份。
      candidate = unwrapOrderEventPayload(p);
    } else if (t === "ORDER_SETTLED") {
      // 方案 C：settle 都要預取 —— 防止離線重排嘅舊 settled 事件把「已返結」單
      // 打回 settled（reopened 係唯一合法終態→open 轉移，唔可以被告 settle 覆蓋）。
      const oid = typeof p.orderId === "string" ? p.orderId.slice(0, MAX_ID_LEN) : "";
      if (oid) {
        orderIds.add(oid);
        continue;
      }
    }
    const id = candidate && typeof candidate.id === "string" ? candidate.id.slice(0, MAX_ID_LEN) : "";
    if (id) orderIds.add(id);
  }
  const existingById = new Map<string, ExistingOrderRow>();
  if (orderIds.size > 0) {
    const idArr = [...orderIds].slice(0, MAX_EVENTS_PER_REQUEST);
    const baseColumns = "id,status,fulfillment_status,items,updated_at,client_updated_at";
    // 退貨修復（2026-09-17）：多取退款 / 退菜審計欄，用嚟辨認「呢次更新係一次退貨」。
    // ⚠️ 呢 3 欄喺**全部 migration 都冇定義**（亦冇任何地方寫入）⇒ 現實一直行 6 欄嗰條
    //    （見 `refundAuditColumnsAvailable` 嘅完整說明）。舊版每次都試 9 欄
    //    ⇒ 每次 sync 一個 PostgREST 400 ＋ 一條 Postgres `42703` ERROR log（實測每 30 秒一次）。
    // ⚠️ 呢個探測**唔可以整段剷走**：將來真係加咗欄，改行 9 欄係為咗令
    //    「呢次更新係一次退貨」嘅守門豁免生效（所以改成「試一次、記住結果」）。
    const refundColumns =
      refundAuditColumnsAvailable === false ? "" : ",refund_records,refunded_amount,voided_items";
    let existingRows: unknown[] | null = null;
    let existingErr: { message?: string | null; code?: string | null } | null = null;
    {
      const res = await supabase
        .from("pos_orders")
        .select(`${baseColumns}${refundColumns}`)
        .eq("store_id", storeId)
        .in("id", idArr);
      existingRows = res.data as unknown[] | null;
      existingErr = res.error;
    }
    if (existingErr && isMissingColumnError(existingErr)) {
      // 記住「呢 3 欄唔存在」→ 同一 instance 之後唔再試（省一個註定失敗嘅查詢 ＋ 一條 ERROR log）
      refundAuditColumnsAvailable = false;
      console.warn(
        `[pos/sync] pos_orders 缺退款審計欄（migration 未跑）→ 降級查詢；` +
          `退貨內容更新嘅守門豁免會失效。詳見 supabase/migrations 的退款欄位定義。`,
      );
      const res = await supabase
        .from("pos_orders")
        .select(baseColumns)
        .eq("store_id", storeId)
        .in("id", idArr);
      existingRows = res.data as unknown[] | null;
      existingErr = res.error;
    } else if (!existingErr && refundColumns) {
      // 9 欄查得通（＝將來真係加咗欄）→ 記住，之後直接行 9 欄
      refundAuditColumnsAvailable = true;
    }
    if (existingErr) {
      console.error("[pos/sync] 預取現有訂單失敗（LWW 守門降級為無條件寫入）:", existingErr.message);
    } else {
      for (const row of (existingRows ?? []) as ExistingOrderRow[]) existingById.set(row.id, row);
    }
  }

  /**
   * 錯誤分類（2026-09-10 加單「冇反應」事故修復）。
   *
   * 【事故根因】舊版任何 `ack(false)`（業務拒絕）同 DB 失敗都一律回 **HTTP 500**。
   * 而 kiosk client 嘅規矩係「4xx（非 429）＝永久拒絕，其餘＝網絡抖動」→ 業務拒絕
   * 被當成抖動 → 重試 3 次 → 最後**入本地待同步隊列 + 顯示「落單成功，正在同步…」**。
   * 客人以為落咗單，收銀端永遠收唔到（冇單、冇打印、冇介面更新）——最壞嘅一種靜默。
   *
   * 家陣分三類，決定回應狀態碼：
   *   - `businessRejections` → 4xx（`unauthorized` → 401；其餘 → 400），`retryable:false`
   *     → client 應該**即刻報錯畀客人**，唔重試、唔入隊列。`results[].reason` 帶機器可讀原因
   *     （`soldout` / `forbidden` / `unauthorized` / `bad-payload`）。
   *   - `infraErrors` → 500，`retryable:true` → 真係可以重試（DB 抖動 / 超時）。
   *   - `warnings` → 唔影響事件成敗（例如審計表 `pos_queue_events` 寫入失敗）。
   *     ⚠️ 舊版審計寫入失敗都會令**整批回 500**，即使訂單其實已經成功寫入；
   *     咁樣 client 會重推已成功嘅事件，係一種假失敗。審計表唔係業務真源
   *     （`/api/pos/state` 直接讀 `pos_orders`），所以降級做 warning。
   */
  const businessRejections: string[] = [];
  const infraErrors: string[] = [];
  const warnings: string[] = [];
  const rejectBusiness = (msg: string) => {
    businessRejections.push(msg);
  };
  const failInfra = (msg: string) => {
    infraErrors.push(msg);
  };
  /** 按事件回執（方案 C）：正常路徑喺每次 iteration 尾 push。 */
  const results: EventAck[] = [];
  /**
   * 待寫入 `pos_queue_events` 嘅審計行（2026-09-21 egress 優化）。
   *
   * 收集成 array，loop 完之後**先去重再分批**一次過寫（見 loop 後嘅收尾）。
   * 🔴 去重唔可以省：`onConflict: "id"` 之下同一批內有重複 id，
   * Postgres 會回 21000（`cannot affect row a second time`）⇒ **整批一齊失敗**。
   * 去重／分批嘅實作同測試喺 `@/lib/pos/queue-event-batch`。
   */
  const queueRows: QueueEventRow[] = [];

  for (const rawEvent of events) {
    if (typeof rawEvent !== "object" || rawEvent === null) {
      rejectBusiness("事件格式錯誤");
      continue;
    }
    const event = rawEvent as Record<string, unknown>;
    const eventId = text(event.id, MAX_ID_LEN);
    const eventType = typeof event.type === "string" ? event.type : "";

    if (!eventId) {
      rejectBusiness("事件缺少 id");
      continue;
    }
    // ── 按事件回執（方案 C + docs/112 L1）：每個事件一個下場，client 淨剷 applied 嘅 ──
    let evAcked = false;
    /**
     * 落回執。
     *
     * `applied` 省略 = 同 `ok` 一致（真係有寫入）。**有意跳過**（stale / 終態降級 /
     * reopened 保護）要明確傳 `applied:false` —— 新 client 見到就唔會剷走事件、
     * 亦唔會以為已經上雲，改由對賬守護用完整快照補推。
     */
    const ack = (ok: boolean, error?: string, extra?: { applied?: boolean; reason?: string }) => {
      if (evAcked) return;
      evAcked = true;
      results.push({
        id: eventId,
        ok,
        applied: extra?.applied ?? ok,
        ...(extra?.reason ? { reason: extra.reason } : {}),
        ...(error ? { error } : {}),
      });
    };

    // ── 3) 事件類型白名單：唔喺名單內嘅一律跳過（防未知 type 走進寫入分支）──
    if (!VALID_EVENT_TYPES.has(eventType)) {
      rejectBusiness(`未知事件類型：${eventType.slice(0, 40)}`);
      ack(false, `未知事件類型：${eventType.slice(0, 40)}`);
      continue;
    }

    // ── 3.2) 通道授權閘（2026-09-10 P0-3）──
    // 匿名通道只准建單 / 加單；結帳、刪單、打印任務、裝置設定一律需要 POS 憑證。
    if (!authorized && !ANONYMOUS_ALLOWED_EVENTS.has(eventType)) {
      console.warn(`[pos/sync] 拒收匿名事件 ${eventId}（type=${eventType}，需要 POS 憑證）`);
      rejectBusiness(`事件 ${eventId} 未經授權（匿名通道唔接受 ${eventType}）`);
      // reason:unauthorized → client 知道要**先續期憑證**再重試（而唔係盲目退避）。
      ack(false, "未經授權：匿名通道只接受落單 / 加單事件", { reason: "unauthorized" });
      continue;
    }

    // ── 3.5) 🛡️ 跨店隔離（0022 migration，2026-09-06 修）──
    // 事件自帶 storeId（client withStoreScope() stamp）必須同請求級 storeId 一致，
    // 唔一致 = 跨店事件（server state merge 殘留 / 偽造）→ 大聲拒收。
    // 舊 client 唔帶 storeId（null）→ 溫和 fallback 請求級 storeId（legacy 相容；
    // 舊 client 嘅 flush 本來就用當前登入店，行為不變）。
    const rawEventStoreId = typeof event.storeId === "string" ? event.storeId.trim() : "";
    const eventStoreId = rawEventStoreId.slice(0, MAX_STORE_ID_LEN) || null;
    if (eventStoreId && eventStoreId !== storeId) {
      console.warn(
        `[pos/sync] 拒收跨店事件 ${eventId}（event.storeId=${eventStoreId} ≠ 請求 storeId=${storeId}）`,
      );
      rejectBusiness(`事件 ${eventId} 的店舖標識與請求不一致（跨店事件），已拒絕`);
      ack(false, "店舖標識與請求不一致（跨店事件）");
      continue;
    }

    const eventPayload = (typeof event.payload === "object" && event.payload !== null
      ? event.payload
      : {}) as Record<string, unknown>;

    // 🔴 2026-09-21 egress 優化：**唔再逐個事件 upsert**（N 個事件 ＝ N 個 PostgREST POST），
    //    改為收集入 `queueRows`，等 loop 完咗一次過去重 + 分批寫（見 loop 後嘅收尾）。
    //    實測：呢個表曾經係全專案請求數第一位（26 分鐘 150 次 POST），
    //    而 client 其實只發咗一個 `/api/pos/sync` 請求。
    queueRows.push({
      id: eventId,
      type: eventType,
      entity_id: text(event.entityId, MAX_ID_LEN),
      payload: eventPayload,
      status: text(event.status, 64),
      created_at: typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString(),
      // 🛡️ 跨店隔離：queue 行記錄事件歸屬店（/api/pos/state 按呢欄過濾派發）。
      // 上面已驗證 eventStoreId === storeId（或 null legacy）→ 直接落 eventStoreId。
      store_id: eventStoreId,
    });

    if (eventType === "ORDER_CREATED" || eventType === "ORDER_UPDATED") {
      /**
       * ⚠️⚠️ 加單事故根因（2026-09-10 修）：兩種 client 嘅 `ORDER_UPDATED` payload **形狀唔同**。
       *
       *   - 收銀台（`pos-app.tsx` `submitOrder()`）：`{ order, addedItems }`
       *   - kiosk / 掃碼（`kiosk-order.ts` `submitKioskOrder()`）：**裸 order**（同 ORDER_CREATED 一樣）
       *
       * 舊版呢度寫死 `eventPayload.order` → 掃碼加單時攞到 `undefined` → `orderId` 為空 →
       * 落去下面 `ack(false, "事件 payload 缺少訂單 id")` → HTTP 500 →
       * client 當「網絡抖動」重試 3 次 → 入本地待同步隊列 → 顯示「落單成功，正在同步…」。
       * 結果：**掃碼 / kiosk 加單 100% 必定失敗，而且客人以為成功、收銀端完全冇反應**
       * （冇單、冇打印、冇介面更新）。
       *
       * 修正：兩種形狀都收 —— 有 `.order` 就用（收銀台），冇就當成 payload 本身就係張單
       * （kiosk / 掃碼）。呢個順序唔會誤判：`PosOrder` 自己冇 `order` 呢個欄位。
       * 同時抽出 `addedItems`（收銀台有帶）畀下面售罄校驗用「只驗新增菜品」。
       */
      /**
       * ⚠️ **兩種 type、兩種形狀都要收**（2026-09-16 修）。
       *
       * 舊寫法只喺 ORDER_UPDATED 拆 `.order`；ORDER_CREATED 一律當 payload 本身就係張單。
       * 但 `ledger-pos-bridge.ts` 嘅 `enqueueOrderEvent()`（線上單首次排位／採納）**兩種 type 都送
       * `{ order }`** ⇒ 線上單嘅 ORDER_CREATED 每次都係 `order.id === undefined` → 落下面
       * `ack(false, "事件 payload 缺少訂單 id")` → HTTP 400 → **永久失敗**（2026-09-16 實案：
       * 6 筆 `entity_id = ledger-<uuid>` 事件喺「同步健康檢查」卡死，按「放棄」reload 後又彈返）。
       * 後果唔止 UI：該張線上單喺 POS 雲端冇完整記錄（最壞情況一直唔存在，結帳時才由
       * ORDER_SETTLED 嘅 0 列 upsert 兜底建一條最小記錄 → 冇 items）。
       *
       * 拆解規則已經抽去 `@/lib/pos/sync-order-payload`（附迴歸測試），
       * 同一條規則亦用喺上面「LWW 預取」，兩處口徑唔可以再各自實作。
       */
      const order = unwrapOrderEventPayload(eventPayload);
      /** 收銀台帶嘅「本次新增菜品」（kiosk / 舊 client 冇）。 */
      const addedItems = addedItemsOfEventPayload(eventPayload);
      const orderId = order && typeof order.id === "string" ? order.id.slice(0, MAX_ID_LEN) : "";
      // `order &&` 要再寫多次：TS 唔會由 `orderId` 嘅 truthiness 反推 `order` 已經 narrowing 咗，
      // 唔加會令下面 23 處 `order.xxx` 全部報 TS18048「possibly undefined」。
      if (order && orderId) {
        const incomingStatus = text(order.status, 64) ?? "draft";
        // 方案 B（2026-09-09）：呢個係 **client 裝置時鐘**時間戳，之後寫入 `client_updated_at`
        // 同做 LWW 比較（同鐘域）。`pos_orders.updated_at` 一律由 server 蓋章（下面）。
        const incomingUpdatedAt = isoOrNull(order.updatedAt) ?? new Date().toISOString();
        const existing = existingById.get(orderId);
        const orderSource = text(order.source, 32) ?? "pos";

        // ── P0-3：匿名通道只准客人 / kiosk 來源嘅單 ──
        // 收銀台落單一定會帶 POS 憑證；匿名而自稱 `source="pos"` = 偽造。
        if (!authorized && !ANONYMOUS_ALLOWED_SOURCES.has(orderSource)) {
          console.warn(`[pos/sync] 拒收匿名訂單 ${orderId}（source=${orderSource}）`);
          rejectBusiness(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 未經授權`);
          ack(false, "未經授權：匿名通道唔接受此訂單來源", { reason: "forbidden" });
          continue;
        }

        // ── 店內營業閘（2026-09-14，migration 0039）──
        // 店已暫停營業 → 客人掃碼 / kiosk 一律落唔到單（加單都唔准：店都落咗閘）。
        // ⚠️ `!authorized` 把關：收銀台（帶 POS 憑證）唔受影響 —— 店員照樣要落單 / 結帳。
        // `reason: "shop-closed"` 係客端 UI 嘅分流依據（轉全屏「商家不在營業中」，
        // 唔好叫客人「重試」—— 重試一萬次都唔會成功）。
        if (!authorized && storeClosed) {
          console.warn(`[pos/sync] 拒收店已暫停營業嘅訂單 ${orderId}（source=${orderSource}）`);
          rejectBusiness(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 商家不在營業中`);
          ack(false, "商家不在營業中", { reason: "shop-closed" });
          continue;
        }

        // ── 班次（開工）閘（2026-09-18）──
        // 本店冇任何未收工嘅班次 → 客人掃碼 / kiosk 一律落唔到單。
        // ⚠️ `!authorized` 把關：收銀台（帶 POS 憑證）唔受影響。
        // `reason: "shift-closed"` 係客端 UI 嘅分流依據 —— **唔可以**同 `shop-closed` 撈埋：
        // 「店已暫停營業」係店主主動嘅決定（客人應該見到「商家不在營業中」）；
        // 「未開工」係店員未夠鐘／已經收工，客人應該見到「未開始營業，請稍後再試」
        // （叫佢遲啲返嚟係有意義嘅，叫佢重試就冇）。
        if (!authorized && shiftClosed) {
          console.warn(`[pos/sync] 拒收本店未開工嘅訂單 ${orderId}（source=${orderSource}）`);
          rejectBusiness(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 商家尚未開始營業`);
          ack(false, "商家尚未開始營業", { reason: "shift-closed" });
          continue;
        }

        // ── 授權通道寫入閘（2026-09-21）──────────────────────────────────────
        //
        // 🔴 以前上面兩段（2.55／2.56）**只擋匿名**，收銀台帶 POS 憑證就完全唔受影響
        //    ⇒ 老闆撳「暫停營業」或交班之後，收銀台照樣開新單。
        //    最危險嘅情境：一部開咗一整日冇 reload 嘅分頁，本機 `shift.openedAt`
        //    仲係「開工」，另一部機已經交班 —— 佢落單，server 因為 `authorized`
        //    而**照收**，收銀員以為落咗單，雲端同本機從此唔一致。
        //
        // 口徑（J 2026-09-21 拍板）：**只擋「開新生意」**——
        //   · 拒：`ORDER_CREATED`、`ORDER_UPDATED` 帶 `addedItems`（加菜）
        //   · 准：結帳（`ORDER_SETTLED`）、退菜、刪單、出紙、純狀態推進、`ledger-` 線上鏡像
        // 完整理由同取捨見 `@/lib/pos/write-gate`（有單測）。
        //
        // ⚠️ 逃生門＝**重新開工**（開新班次），令補單變成有記錄、有意圖嘅動作，
        //    而唔係靜默允許。
        if (authorized) {
          const writeDecision = decideOrderWrite({
            eventType,
            hasAddedItems: Array.isArray(addedItems) && addedItems.length > 0,
            // `ledger-` 前綴 ＝ 線上鏡像（`ledger-pos-bridge` 為線上單補記錄）。
            // 擋咗會令線上單喺 POS 雲端永遠冇完整記錄 ⇒ 一定要放行。
            isOnlineMirror: orderId.startsWith("ledger-"),
            storeClosed,
            shiftClosed,
            // 2026-09-22：管理員強制關閉咗呢個工作階段（admin 頁）⇒ 唔准開新生意。
            // 同一道閘嘅既有口徑：結帳 / 退款 / 刪單 / 出紙一律照准。
            sessionRevoked,
          });
          if (!writeDecision.allow) {
            const message = describeWriteGateRejection(writeDecision.reason);
            console.warn(
              `[pos/sync] 拒收關店／收工／已關閉工作階段嘅新生意 ${orderId}` +
                `（${writeDecision.reason}，source=${orderSource}）`,
            );
            rejectBusiness(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} ${message}`);
            ack(false, message, { reason: writeDecision.reason });
            continue;
          }
        }

        // ── P1-2：server 端售罄校驗（匿名通道）──
        //
        // ⚠️ 2026-09-10 修正語義：只驗**今次新增**嘅菜品。
        // 舊版對整張單嘅 items 逐個驗 —— 加單（ORDER_UPDATED）時會把**一早已經被收銀端
        // 接受**嘅菜都攞去驗，只要其中一款之後賣完，客人**之後所有加單都會被永久拒絕**
        // （而且因為下面嘅錯誤分類舊問題，客人仲會見到「落單成功」）。正確語義：
        //   ① ORDER_CREATED → 全部菜品都係新嘅，要驗；
        //   ② ORDER_UPDATED 帶 `addedItems`（收銀台 / 新版 kiosk）→ 只驗新增嗰批；
        //   ③ ORDER_UPDATED 冇 `addedItems`（舊 client）→ **跳過**（唔知邊啲係新，
        //      寧願 fail-open，都唔好誤鎖客人加單）。
        //
        // ⚠️ 另外注意：呢個校驗目前係**無效**嘅 —— repo 內冇任何地方寫入 `pos_soldout`
        // （POS 嘅沽清係本機 localStorage + `/api/inventory/soldout` stub），生產專案亦
        // 冇呢張表 → 查詢失敗 → fail-open。保留呢段係為咗將來接上真正嘅店級售罄來源時
        // 即刻生效；詳見 docs/reviews/qr-self-order-audit-2026-09-10.md 附錄 B。
        if (soldoutSet && soldoutSet.size > 0) {
          const itemsToCheck =
            eventType === "ORDER_CREATED"
              ? Array.isArray(order.items)
                ? order.items
                : []
              : addedItems ?? null;
          const soldOutHit =
            itemsToCheck?.some((it) => {
              if (!it || typeof it !== "object") return false;
              const mid = (it as Record<string, unknown>).menuItemId;
              return typeof mid === "string" && soldoutSet!.has(mid);
            }) ?? false;
          if (soldOutHit) {
            console.warn(`[pos/sync] 拒收售罄訂單 ${orderId}（只驗新增菜品）`);
            rejectBusiness(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 含售罄菜品`);
            ack(false, "菜品已售罄，請重新選擇", { reason: "soldout" });
            continue;
          }
        }

        // ── P2-2：客人（匿名）加單唔可以改動狀態機 ──
        // 狀態機 owner 係收銀端。舊版客人加單會重寫整張單，把收銀已標記嘅
        // `sent_to_kitchen → preparing` 打返轉頭（非終態降級 server 唔擋）。
        // 家陣匿名寫入一律沿用 DB 現有狀態 / 出餐狀態，只更新 items / 備註。
        //
        // ── 🔴 2026-09-14 加菜修復（第二層閘，處理**舊 client**）──
        //
        // 實案：「商家加菜後 `order.items` 冇更新（金額欄有更新）」。
        //
        // 收銀端舊寫法喺已收款單（`paid`）加菜時無條件送 `status:"sent_to_kitchen"`
        // → 下面嘅「付款階段單向閘」（d）會**拒收整條 `ORDER_UPDATED`**
        // （`applied:false, reason:"paid-downgrade"`）→ `items` 永遠上唔到雲；
        // 之後 `ORDER_SETTLED` 只 patch 金額、**按設計唔重寫 `items`**
        // → 雲端單變成「1 項但總額 160」，再經 merge 蓋返本機 → 收據少一項。
        //
        // 新 client 已經喺 `upsertCurrentOrder()` 保留 `paid`（正本清源），但
        // **Android APK／desktop companion／舊網頁** 唔會即時更新 ⇒ 呢度要容忍：
        // 「已授權裝置 + 純加法（items 只變多）」時，**唔拒收**，改為沿用 DB 現有
        // `status` / `fulfillment_status`（即維持 `paid`），但**照寫 items 同金額**。
        //
        // 語義安全：① 純加法唔可能覆蓋任何現有內容，只會新增；② 狀態沿用 DB
        // → 唔會出現「已收款 → 未收款」嘅降級（呢個守門本意就係擋降級，唔係擋加菜）；
        // ③ 匿名通道（客人加單）本來就唔會寫狀態，唔受影響。
        const incomingQty = totalItemQuantity(
          Array.isArray(order.items) ? (order.items as OrderItem[]) : undefined,
        );
        const existingQty = totalItemQuantity(
          Array.isArray(existing?.items) ? (existing.items as OrderItem[]) : undefined,
        );
        /** 純加法更新（items 只變多）—— 收銀台加菜 / 客人加單共用同一判準。 */
        const isAdditiveUpdate =
          eventType === "ORDER_UPDATED" && Boolean(existing) && incomingQty > existingQty;
        /**
         * 🔴 2026-09-17 退貨修復：**退貨 / 退菜令 items 變少**（`incomingQty < existingQty`）
         * 係「減少」而唔係「降級」，但舊寫法只認 `isAdditiveUpdate`（只變多），
         * 所以退貨事件：
         *   ① 唔會豁免 stale → 被時間戳判 stale 而靜默丟棄；
         *   ② 落唔到 `paidAdditiveFromDevice` → 被付款階段單向閘擋（`paid-downgrade`）。
         * 結果 `items` 永遠上唔到雲，只有 `ORDER_SETTLED` 嘅**金額 patch** 入到去
         * ⇒ 雲端停留「舊數量 + 新金額」嘅自相矛盾單（實案：訂單06「×1 卻 MOP 62」、
         * 09-16 A03「1 項卻總額 160」）。再經 realtime / backfill merge 蓋返本機
         * ⇒ 收據／訂單詳情數量錯。
         *
         * 【判定「呢次係退貨」】唔可以只睇「數量變少」——刪行／改數量都會令數量變少。
         * 用**退款審計欄**（`refundRecords` / `refundedAmount`）做判準，同 client 端
         * `mergeOrderLists()` 用「返結審計欄」分辨新舊 snapshot 係同一個手法：
         * 退款欄係**單調**嘅（寫咗就唔會冇），所以係可靠嘅信號。
         * `voidedItems` 長度變長 = 退菜（餐飲全退 / 單項退），同樣係合法內容變更。
         *
         * ⚠️ `incomingStatus` 已喺上面（`keepExistingStatus` 之前）宣告 —— 狀態閘同呢度
         * 必須用**同一個**值，呢度唔可以再宣告一次（shadow 會令兩閘口徑分歧）。
         */
        const existingRefundedAmount = Number(existing?.refunded_amount ?? 0);
        const incomingRefundedAmount = Number(order.refundedAmount ?? 0);
        const existingRefundCount = refundRecordCount(existing?.refund_records);
        const incomingRefundCount = Array.isArray(order.refundRecords) ? order.refundRecords.length : 0;
        const existingVoidedCount = Array.isArray(existing?.voided_items) ? existing!.voided_items.length : 0;
        const incomingVoidedCount = Array.isArray(order.voidedItems) ? order.voidedItems.length : 0;
        /** 內容縮減更新（items 只變少）—— 退貨 / 退菜會令數量變少。 */
        const isReductiveUpdate =
          eventType === "ORDER_UPDATED" && Boolean(existing) && incomingQty < existingQty;
        /**
         * 呢次更新係「退貨 / 退菜」（有退款或作廢審計增量）→ 屬於**合法內容變更**，
         * 唔應該被當成狀態降級擋走。
         *
         * ⚠️ 一定要係 `isReductiveUpdate` 或者退款欄有增量 —— 唔可以單靠「有退款欄」
         * 就放行，因為退款之後嘅任何 snapshot 都會帶住退款欄。
         */
        const isRefundContentUpdate =
          eventType === "ORDER_UPDATED" &&
          Boolean(existing) &&
          (incomingRefundedAmount > existingRefundedAmount ||
            incomingRefundCount > existingRefundCount ||
            incomingVoidedCount > existingVoidedCount) &&
          (isReductiveUpdate || incomingQty === existingQty);
        /** 已授權裝置向**已收款單**加菜：保留 DB 現有 `paid`，但照寫 items / 金額。 */
        const paidAdditiveFromDevice =
          (isAdditiveUpdate || isRefundContentUpdate) &&
          authorized &&
          PAID_ORDER_STATUSES.has(existing?.status ?? "") &&
          OPEN_ORDER_STATUSES.has(incomingStatus);
        /** 沿用 DB 現有狀態（匿名一律；已授權但屬「已收款單加菜」亦然）。 */
        const keepExistingStatus = Boolean(existing) && (!authorized || paidAdditiveFromDevice);
        const writeStatus = keepExistingStatus
          ? existing?.status ?? incomingStatus
          : incomingStatus;
        const writeFulfillment = keepExistingStatus
          ? existing?.fulfillment_status ?? null
          : text(order.fulfillmentStatus, 64);

        if (existing) {
          const incomingTs = parseIsoMs(incomingUpdatedAt);
          // 同鐘域比較：優先用 client_updated_at（client 時鐘）；舊 row backfill 後唔會係 null
          const existingTs = parseIsoMs(existing.client_updated_at ?? existing.updated_at);
          const existingStatus = existing.status ?? "";
          /**
           * (a0) 🛡️ 「加菜」豁免（2026-09-10 加單修復）：
           *
           * 客人加單係**純加法**（items 只會變多），但收銀端任何動作（確認 / 製作中 /
           * 出餐 / 退菜 …）都會寫一條 ORDER_UPDATED 上去，把 `client_updated_at` 更新成
           * **收銀機嘅裝置時鐘**。若收銀機時鐘快過客人手機（iPad 冇 NTP 好常見，
           * 同 docs/112 M4 講嘅同一個病），之後客人加單就會被判 stale → 靜默 skip →
           * 「加單又冇反應」，而且今次連錯誤都冇（`ack(true, applied:false)`）。
           *
           * 語義上豁免係安全嘅：① 下面 `writeStatus` 已經強制沿用 DB 現有狀態
           * （匿名加單改唔到狀態機；已授權但屬「已收款單加菜」亦然 —— 見上面
           * `paidAdditiveFromDevice`）；② 「items 變多」唔可能覆蓋任何嘢，只會新增。
           * 所以「incoming 項目數 > 現有項目數」時唔應該因為時間戳就丟棄。
           *
           * ⚠️ `incomingQty` / `existingQty` / `isAdditiveUpdate` 已喺上面
           * （`keepExistingStatus` 之前）算好 —— 嗰度嘅狀態閘要用同一個判準，
           * 呢度**唔可以**再宣告一次（shadow 會令兩閘口徑分歧）。
           */
          // (a) LWW：incoming 舊過現有 row → stale，跳過唔寫；
          // (b) 終態守門：settled/cancelled/refunded/partially_refunded 唔可以被 open snapshot
          //     降級。唯一合法嘅終態 → open 轉移係明確 `reopened`（返結帳）。
          //
          // 🔴 2026-09-17 退貨修復：`isRefundContentUpdate` 同 `isAdditiveUpdate` 一樣要豁免 stale。
          //     原因同加菜完全對稱 —— 退貨亦係**合法內容變更**，而收銀機時鐘可能快過 /
          //     慢過雲端那條 row 嘅 `client_updated_at`（iPad 冇 NTP，見上面 (a0)）。
          //     若退貨事件被判 stale 丟棄，`items` 就永遠上唔到雲，只剩 `ORDER_SETTLED`
          //     嘅金額 patch ⇒ 雲端停留「舊數量 + 新金額」（實案：訂單06「×1 卻 MOP 62」）。
          //     語義安全：退款審計欄係單調嘅（只會增加），一條帶「更多退款紀錄」嘅 snapshot
          //     唔可能係「舊狀態」。
          const isStale =
            incomingTs > 0 && incomingTs < existingTs && !isAdditiveUpdate && !isRefundContentUpdate;
          if (isAdditiveUpdate && incomingTs > 0 && incomingTs < existingTs) {
            console.info(
              `[pos/sync] 加菜豁免：接受較舊時間戳嘅加單 ${orderId}（項目 ${existingQty} → ${incomingQty}）`,
            );
          }
          if (isRefundContentUpdate && incomingTs > 0 && incomingTs < existingTs) {
            console.info(
              `[pos/sync] 退貨豁免：接受較舊時間戳嘅退貨更新 ${orderId}（` +
                `項目 ${existingQty} → ${incomingQty}，退款 ${existingRefundedAmount} → ${incomingRefundedAmount}）`,
            );
          }
          const isDowngrade =
            TERMINAL_ORDER_STATUSES.has(existingStatus) &&
            !TERMINAL_ORDER_STATUSES.has(incomingStatus) &&
            incomingStatus !== "reopened";
          /**
           * (c) 🛡️ 終態升級豁免（docs/112 M4，2026-09-10）：
           * 「incoming 係終態、雲端仲係 open、而雲端唔係明確 reopened」→ **准寫**，
           * 唔理時間戳。
           *
           * 點解必須有：收銀機（iPad）嘅牆鐘可能冇 NTP、或者中途被 NTP 回撥，令結帳事件
           * 嘅 `updatedAt` 比建單時更舊 → 舊邏輯判 stale → 拒絕寫入 + `applied:false`。
           * 客戶端雖然唔會再剷走事件（L1），但要靠對賬守護反覆撞、最後標 blocked ——
           * 「本地已完成、後台未結帳」就會一直存在。
           *
           * 語義上呢個豁免係安全嘅：終態（已收錢 / 已作廢）本來就係最強證據，
           * 同 client 端 `mergeOrderLists()` 嘅「終態優先」口徑完全一致。
           * 仍然排除 `reopened`：返結係終態 → open 嘅**合法反轉**，唔可以被一條舊 settled 事件打回。
           */
          const isTerminalUpgrade =
            TERMINAL_ORDER_STATUSES.has(incomingStatus) &&
            !TERMINAL_ORDER_STATUSES.has(existingStatus) &&
            existingStatus !== "reopened";
          /**
           * (d) 🛡️ 付款階段單向閘（2026-09-12）：
           * 「雲端已收款（paid）、incoming 係未收款 open snapshot」→ **一律拒寫**，唔理時間戳。
           *
           * 點解一定要有：快餐 counter 單結帳只寫 `paid`（唔係 terminal），所以上面嘅
           * 終態守門擋唔到 —— 一條時序亂咗嘅 ORDER_UPDATED（例如離線重推、或另一部機
           * 時鐘快過而帶住 `status: "sent_to_kitchen"` 但較新嘅 `client_updated_at`）
           * 就會把雲端嘅「已結帳」打返做「未結帳」，收銀端見到嘅就係狀態閃一下又彈返。
           *
           * 語義安全：已收到錢係事實，同 client 端「終態優先」/「付款階段單向閘」一致。
           * 合法嘅「已收款 → 另一結局」唔受影響：
           *   - `cancelled` / `refunded` / `partially_refunded` / `settled` 係終態 → 上面已放行；
           *   - `reopened`（返結）唔喺 OPEN_ORDER_STATUSES 內 → 照行 LWW。
           * 收銀端「取消結帳」走嘅係 `cancelled`（終態），唔會因此卡住。
           *
           * ⚠️ 判斷用 `writeStatus`（實際會寫入嘅狀態）而唔係 raw `incomingStatus`：
           * 匿名通道（kiosk / 掃碼）上面已經強制 `writeStatus = existing.status`，
           * 用 raw 值會令「kiosk 向已收款單加菜」成條事件被拒 → items 上唔到雲。
           *
           * 🔴 2026-09-17 退貨修復：`isRefundContentUpdate` 一併豁免。
           * 收銀台退貨 / 退菜會先 `saveOrders()` 寫一次載入自 `sent_to_kitchen` 嘅
           * snapshot（`writeStatus` 可能係 `sent_to_kitchen`），但云�� row 已經 `paid`
           * → 舊寫法判 `isPaidDowngrade` 拒收 ⇒ 退貨嘅 `items` 永遠上唔到雲。
           * 語義安全：① `paidAdditiveFromDevice` 已經將 `keepExistingStatus` 設 true
           * → 實際寫入嘅 `writeStatus` 會沿用 DB 嘅 `paid`，唔會真係降級；
           * ② 退款審計欄單調增加，唔可能係舊狀態。呢個豁免只放行「內容 + 退款欄」，
           * 唔會令任何純狀態降級漏網（純狀態降級冇退款欄增量 → `isRefundContentUpdate` false）。
           */
          const isPaidDowngrade =
            PAID_ORDER_STATUSES.has(existingStatus) &&
            OPEN_ORDER_STATUSES.has(writeStatus) &&
            !isRefundContentUpdate;
          const isPaidUpgrade =
            OPEN_ORDER_STATUSES.has(existingStatus) && PAID_ORDER_STATUSES.has(writeStatus);
          /**
           * (e) 🔴 返結守門（2026-09-13 實案）：雲端已經返結（`reopened`），incoming 係
           * 一條較新嘅 `paid` / `settled` snapshot → **一律拒寫**。
           *
           * 點解上面擋唔到：`reopened` **唔喺** OPEN_ORDER_STATUSES（`draft` / `sent_to_kitchen`）
           * 亦唔喺 PAID_ORDER_STATUSES（`paid` / `settled` / `refunded` / `partially_refunded`）
           * 之內，所以 `isPaidUpgrade` / `isPaidDowngrade` 兩個都係 false。
           * 而 `isDowngrade` 只認「雲端係**終態**」——`paid` 按設計唔算終態（要佔枱、可加菜）
           * → 呢個組合完全冇守門，只要那條舊 `paid` 事件嘅 `client_updated_at` 較新就會贏出，
           * 把雲端已返結嘅單打返做已結帳（收銀撳完返結、掣轉頭消失）。
           *
           * 合法路徑唔受影響：返結之後收銀重結會寫 `settled`（終態 → 上面 `isTerminalUpgrade`
           * 已豁免）或作廢寫 `cancelled`，兩者都放行。呢個守門只擋「打返做**非終態**已收款」。
           * ⚠️ 一定要排除終態：`settled` 本身就喺 PAID_ORDER_STATUSES 內，唔排除就會
           * 令「返結 → 重結」呢條合法前進被擋死。
           */
          const isReopenRegression =
            existingStatus === "reopened" &&
            PAID_ORDER_STATUSES.has(writeStatus) &&
            !TERMINAL_ORDER_STATUSES.has(writeStatus);
          if (
            (isStale && !isTerminalUpgrade && !isPaidUpgrade) ||
            isDowngrade ||
            isPaidDowngrade ||
            isReopenRegression
          ) {
            console.warn(
              `[pos/sync] 拒絕覆寫訂單 ${orderId}（現有=${existingStatus}@${existing.updated_at ?? "?"}，` +
                `incoming=${incomingStatus}@${incomingUpdatedAt}，` +
                `                ${
                  isReopenRegression
                    ? "返結回退（雲端已 reopened，唔可以被舊已收款 snapshot 打返）"
                    : isPaidDowngrade
                      ? "付款階段降級（已收款唔可以被未收款 snapshot 覆蓋）"
                      : isStale
                        ? "stale（incoming 較舊）"
                        : "終態降級"
                }）`,
            );
            // 有意嘅 skip：**`applied:false`** —— 新 client 見到就唔會剷走呢條事件
            // （剷咗 = 本地冇副本、雲端停留舊狀態，就係 docs/112 M3「假成功」）。
            // `ok:true` 保留係為咗向後兼容舊 client（佢哋只讀 ok）。
            ack(true, undefined, {
              applied: false,
              reason: isReopenRegression
                ? "reopen-guard"
                : isPaidDowngrade
                  ? "paid-downgrade"
                  : isStale
                    ? "stale"
                    : "downgrade",
            });
            continue;
          }
          if (isStale && isTerminalUpgrade) {
            console.warn(
              `[pos/sync] 終態升級豁免：接受較舊時間戳嘅終態 ${orderId}（${existingStatus} → ${incomingStatus}）`,
            );
          }
        }

        const items = Array.isArray(order.items) ? order.items.slice(0, MAX_ORDER_ITEMS) : [];
        // created_at 唔喺 baseRecord：已存在行只 update 內容、唔郁建立時間（防 replay 倒退）；
        // 首次建立（upsert）先補 created_at。
        // ── 會員扣款（0038 migration，docs/130 §7.1）──
        //
        // 🔴 為咩一定要上雲：唔寫 = 收銀機睇唔到客人已經用會員餘額付款 →
        //    店員見單「未付款」→ **可能再收一次錢**。呢三欄唔係「順手同步」，
        //    而係防止重複收費嘅必要欄位。
        //
        // 🔴 為咩要「有值才寫」：舊 client（唔識呢三欄）payload 完全冇呢啲 key。
        //    如果照樣寫 `0` / `NULL`，就會**無條件覆蓋**另一部機已經寫入嘅扣款紀錄
        //    （呢個 update 唔經 LWW 守門，係直接覆寫）→ 收銀機又變返「未付款」。
        //
        // 🔴 個資紅線（契約 §7.2）：只寫 `customer_id`(uuid)。
        //    **唔准**寫電話 / 顯示名 / 餘額 —— 嗰啲只准當次 UI 渲染。
        const writesMemberFields =
          order.memberCustomerId !== undefined ||
          order.memberDeductionAvos !== undefined ||
          order.memberDeductTxnId !== undefined;
        const memberRecord: Record<string, unknown> = writesMemberFields
          ? {
              member_customer_id: uuidOrNull(order.memberCustomerId),
              member_deduction_avos: avosOrZero(order.memberDeductionAvos),
              member_deduct_txn_id: text(order.memberDeductTxnId, MAX_ID_LEN),
            }
          : {};

        const baseRecord: Record<string, unknown> = {
          id: orderId,
          local_order_no: text(order.localOrderNo, MAX_NAME_LEN),
          // 🛡️ 跨店隔離不變量：呢度用請求級 storeId 係安全嘅 —— 上面 3.5 已驗證
          // eventStoreId === storeId（事件自帶店）或 eventStoreId 為 null（legacy 舊 client）。
          // 即係「呢張單嘅店 = flush 請求聲稱嘅店 = 事件自己嘅店」，三者一致先會行到呢度。
          store_id: storeId,
          table_id: text(order.tableId, MAX_ID_LEN),
          table_name: text(order.tableName, MAX_NAME_LEN),
          status: writeStatus,
          fulfillment_status: writeFulfillment,
          sent_to_kitchen_at: text(order.sentToKitchenAt, 64),
          served_at: text(order.servedAt, 64),
          items,
          order_note: text(order.orderNote, MAX_TEXT_LEN),
          subtotal: money(order.subtotal),
          tax_amount: money(order.taxAmount),
          service_charge_amount: money(order.serviceChargeAmount),
          discount_amount: money(order.discountAmount),
          total: money(order.total),
          prepaid_amount: money(order.prepaidAmount),
          online_order_id: text(order.onlineOrderId, MAX_ID_LEN),
          // 訂單來源（docs/87 §5.2）："pos" 收銀台 / "kiosk" 自助點餐機 / "scan" 掃碼自點。
          // 舊 client 冇呢個欄 → fallback "pos"。
          source: text(order.source, 32) ?? "pos",
          payment_method: text(order.paymentMethod, MAX_NAME_LEN),
          // ── 入座人數上雲（docs/89 §3）：報表「覆蓋人數 / 人均消費」嘅唯一雲端來源。
          //    快餐／外賣／自取單係 undefined → 寫 NULL（唔好填 1，會污染人均消費分母）。
          party_size: partySizeOrNull(order.partySize),
          // ── 免單備註上雲（docs/91）：獨立審計欄，唔寫落 order_note
          //    （廚房備註受 docs/84 鎖定，sent_to_kitchen 起鎖死）。
          //    非免單單一律 undefined → 寫 NULL。
          comp_note: text(order.compNote, MAX_TEXT_LEN),
          comped_at: isoOrNull(order.compedAt),
          // ── 全單折扣備註上雲（0034 migration）：同 comp_note 一樣係結帳期獨立審計欄
          //    （唔寫落 order_note —— 後者受 docs/84 鎖定）。
          //    冇折扣 / 功能上線前嘅舊單 → undefined → 寫 NULL。
          //    單品折扣原因唔喺呢度：佢逐件存喺 `items` JSONB 內（OrderItem.discountNote），
          //    會跟 `items` 一齊上雲，唔需要另開欄。
          discount_note: text(order.discountNote, MAX_TEXT_LEN),
          // ── 返結審計上雲（0043 migration，2026-09-18）─────────────────────
          // 🔴 為何一定要上雲：報表同交班**讀雲端**（`pos_orders` 為唯一可信源），
          //    雲端冇呢幾欄 ⇒ ① 「已返結 ×N」標籤永遠唔會出現喺報表 / 交班明細；
          //    ② 換機 / 清 cache 之後完全睇唔出「呢張單被人返結改過」。
          //    同 0038 member_* 一樣，係「逐欄顯式複製」漏抄，唔係被 RLS 擋。
          //
          // `reopen_count` 單調遞增（重結唔清零）—— 「返結過」係歷史事實，
          // 前端 `reopen-badge.ts` 靠佢決定要唔要出標籤。
          // 未跑 migration → 下面 42703 降級會拔走呢三欄（功能靜默停用，主流程不受影響）。
          reopen_count: Math.max(0, Math.trunc(Number(order.reopenCount) || 0)),
          reopened_at: isoOrNull(order.reopenedAt),
          reopen_reason: text(order.reopenReason, MAX_TEXT_LEN),
          // 方案 B（2026-09-09）：`updated_at` 一律 server 蓋章（收件時間，單一鐘域）；
          // client 裝置時鐘時間戳另存 `client_updated_at`，專供 LWW 守門同鐘域比較。
          // 注意：`created_at` 維持 client 時間（首次建立）—— 訂單排序（compareOrderByLocalNo）
          // 同報表「下單時間」口徑都靠佢，唔可以俾補傳時間蓋走。
          updated_at: new Date().toISOString(),
          client_updated_at: incomingUpdatedAt,
          ...memberRecord,
        };
        const writeOrder = async (record: Record<string, unknown>) =>
          existing
            ? await supabase.from("pos_orders").update(record).eq("id", orderId).eq("store_id", storeId)
            : await supabase.from("pos_orders").upsert(
                {
                  ...record,
                  created_at: text(order.createdAt, 64) ?? new Date().toISOString(),
                },
                { onConflict: "id" },
              );

        let { error: oErr } = await writeOrder(baseRecord);
        if (oErr && isMissingColumnError(oErr)) {
          // 🔻 新欄未跑 migration（42703）→ 一定要拔走重寫一次。
          // 唔係「新功能同步唔到」咁小事，而係**整張單都上唔到雲**
          //（落單主流程被新功能拖冧）。
          // 一次過拔走 0034（discount_note）+ 0038（member_*）呢兩批新欄 ——
          // 兩個 migration 邊個未跑都修得返；呢啲欄本身值係 NULL / 0，拔走無損。
          // 呢個降級係一次過嘅：migration 跑完之後寫入自然帶返新欄。
          console.warn(
            `[pos/sync] pos_orders 新欄唔存在（0034 / 0038 / 0043 未跑），降級寫入訂單 ${orderId}`,
          );
          const legacyRecord = { ...baseRecord };
          delete legacyRecord.discount_note;
          delete legacyRecord.member_customer_id;
          delete legacyRecord.member_deduction_avos;
          delete legacyRecord.member_deduct_txn_id;
          // 0043 返結審計欄 —— 未跑 migration 時拔走。代價只係「已返結標籤暫時唔顯示」，
          // 金額 / items 全部照寫（唔可以因為新欄令整張單上唔到雲）。
          delete legacyRecord.reopen_count;
          delete legacyRecord.reopened_at;
          delete legacyRecord.reopen_reason;
          ({ error: oErr } = await writeOrder(legacyRecord));
        }
        if (oErr) {
          console.error("[pos/sync] pos_orders upsert/update failed:", oErr.message);
          failInfra(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 寫入失敗`);
          ack(false, "訂單寫入失敗", { reason: "db-error" });
          continue;
        }
        ack(true);
      } else {
        // 帶咗 ORDER_CREATED/UPDATED 但 payload 冇 order.id → 冇嘢可寫。
        // 當失敗處理：留喺 client 重試 / 同步健康可見，唔好靜默吞（資料流失風險）。
        //
        // ⚠️ 2026-09-10：呢個分支就係掃碼「加單完全冇反應」嘅現場（舊 client 嘅
        // ORDER_UPDATED payload 形狀唔夾）。上面已做形狀相容，正常唔會再落到嚟；
        // 落得嚟即代表 client 送咗真係冇 id 嘅 payload → 屬**永久**問題，
        // 唔應該回 500 令客人見到「落單成功，同步中」。
        console.error("[pos/sync] 訂單事件 payload 缺少訂單 id（type=%s）", eventType);
        rejectBusiness("事件 payload 缺少訂單 id");
        ack(false, "事件 payload 缺少訂單 id", { reason: "bad-payload" });
      }
    }
    if (eventType === "ORDER_SETTLED" && !evAcked) {
      const settledOrderId =
        typeof eventPayload.orderId === "string" ? eventPayload.orderId.slice(0, MAX_ID_LEN) : "";
      if (!settledOrderId) {
        ack(false, "事件 payload 缺少訂單 id");
      } else {
        // 方案 C：終態→open 唯一合法轉移係 reopened（返結）。若雲端已係 reopened，
        // 離線重排嘅舊 settled 事件唔可以把它打回 settled（要等重新結帳嘅新事件）。
        const settleExisting = existingById.get(settledOrderId);
        if (settleExisting?.status === "reopened") {
          console.warn(
            `[pos/sync] 跳過 ORDER_SETTLED ${settledOrderId}（雲端已 reopened，唔好打回 settled）`,
          );
          // 同樣係「有意跳過」：雲端狀態更終局，唔可以盲剷事件（docs/112 L1）。
          ack(true, undefined, { applied: false, reason: "reopened-guard" });
        } else {
        const patch: Record<string, unknown> = {
          status: text(eventPayload.status, 64) ?? "settled",
          fulfillment_status: text(eventPayload.fulfillmentStatus, 64),
          sent_to_kitchen_at: text(eventPayload.sentToKitchenAt, 64),
          served_at: eventPayload.servedAt ? text(eventPayload.servedAt, 64) : null,
          payment_method: text(eventPayload.paymentMethod, MAX_NAME_LEN),
          discount_amount: money(eventPayload.discountAmount),
          total: money(eventPayload.total),
          // 方案 B：updated_at server 蓋章；client 時間另存 client_updated_at（LWW 同鐘域用）
          updated_at: new Date().toISOString(),
          client_updated_at: isoOrNull(event.createdAt) ?? new Date().toISOString(),
        };
        // 入座人數：**唯有** payload 有帶先寫。舊版 client / 排隊中嘅舊事件冇呢個欄，
        // 若無條件寫 null 會抹走之前 ORDER_UPDATED 寫入嘅值。
        const settledPartySize = partySizeOrNull(eventPayload.partySize);
        if (settledPartySize !== null) patch.party_size = settledPartySize;

        // 🔴 2026-09-17 退貨修復：`ORDER_SETTLED` 唔再係「純金額 patch」。
        //
        // 【為何要改】舊註解話「按設計唔重寫 items」—— 呢個設計本身冇問題，
        // 但**前提係 `ORDER_UPDATED` 一定先成功寫入過 `items`**。退貨正正打破呢個前提：
        // 退貨事件帶 `sent_to_kitchen`（或 `paid`）狀態，撞正「付款階段單向閘」→ 被拒
        // （見上面 `isPaidDowngrade`）⇒ `items` 上唔到雲，之後 `ORDER_SETTLED` 只 patch
        // 金額 ⇒ 雲端停留「舊數量 + 新金額」嘅自相矛盾單（實案：訂單06「×1 卻 MOP 62」、
        // 09-16 A03「1 項卻總額 160」）。再經 realtime / backfill merge 蓋返本機
        // ⇒ 收據／訂單詳情少一項。
        //
        // 【點解喺呢度補】結帳 / 重結係**最後一次**有完整訂單內容嘅時機（收銀喺結帳頁
        // 見到嘅就係最終 items）。喺呢度寫 items = 俾雲端一次自愈機會，即使之前
        // 有 `ORDER_UPDATED` 被守門擋走，結帳都會將雲端校正返。
        //
        // 【保守寫法】同樣「**唯有** payload 有帶先寫」—— 舊 client 嘅 ORDER_SETTLED
        // payload 冇 `order` / `items`，若無條件寫空陣列會**抹走**雲端已有嘅 items。
        // 接受兩種形狀（同 ORDER_CREATED / ORDER_UPDATED 共用同一套拆解規則，見 docs/113）：
        //   - `payload.order.items`（帶全張單嘅新 client）
        //   - `payload.items`（只帶 items 嘅精簡寫法）
        //
        // ⚠️ `money()` 對缺值回 **0**（唔係 null）—— 所以**唔可以**用 `!== null` 判斷。
        //    一定要用 `"key" in obj` 判斷「payload 有冇帶呢個欄」，否則會用 0
        //    無條件抹走雲端已有嘅金額（離線重推時事件次序唔保證）。
        const settledOrderSnapshot = unwrapOrderEventPayload(eventPayload);
        const settledItems = Array.isArray(settledOrderSnapshot?.items)
          ? (settledOrderSnapshot.items as unknown[]).slice(0, MAX_ORDER_ITEMS)
          : Array.isArray(eventPayload.items)
            ? (eventPayload.items as unknown[]).slice(0, MAX_ORDER_ITEMS)
            : null;
        if (settledItems) {
          patch.items = settledItems;
        }
        // 逐個金額欄獨立判斷：nested（`payload.order.subtotal`）優先，唔存在就睇
        // payload 自己（`payload.subtotal`）。**唔可以**用單一個 `snapshotSource` ——
        // nested 存在但少一個欄（例如只帶 items 同 subtotal）就會漏寫另一個欄。
        const settledField = (key: string): unknown => {
          if (settledOrderSnapshot && key in settledOrderSnapshot) return settledOrderSnapshot[key];
          if (key in eventPayload) return eventPayload[key];
          return undefined;
        };
        if (settledField("subtotal") !== undefined) patch.subtotal = money(settledField("subtotal"));
        if (settledField("serviceChargeAmount") !== undefined) {
          patch.service_charge_amount = money(settledField("serviceChargeAmount"));
        }
        if (settledField("taxAmount") !== undefined) patch.tax_amount = money(settledField("taxAmount"));

        // 免單備註（docs/91）：免單正正喺結帳嗰刻發生，所以 ORDER_SETTLED 呢度係主寫入點。
        // 同樣**唯有 payload 有帶先寫** —— 一般結帳（現金／微信／信用卡）唔帶呢兩個欄，
        // 若無條件寫 null 會抹走 ORDER_UPDATED 寫入嘅值（雖然正常唔會發生，但離線重推
        // 時事件次序唔保證，保守寫法比較穩）。
        const settledCompNote = text(eventPayload.compNote, MAX_TEXT_LEN);
        if (settledCompNote) {
          patch.comp_note = settledCompNote;
          patch.comped_at = isoOrNull(eventPayload.compedAt) ?? new Date().toISOString();
        }

        // 全單折扣備註（0034）：折扣同結帳同一刻發生，所以呢度都係一個寫入點。
        // 判斷方式睇「payload 有冇帶呢個 key」而**唔係**值真假：
        //   - 帶字串 → 寫入原因（例如「員工優惠」）
        //   - 帶 null → 明確清空（例：原先打折，後來改成免單 → 原因改由 comp_note 承載）
        //   - 完全冇帶 → 唔關事，唔好無條件寫 null 抹走 ORDER_UPDATED 寫落嘅值
        //     （離線重推時事件次序唔保證，保守寫法比較穩）。
        if ("discountNote" in eventPayload) {
          patch.discount_note = text(eventPayload.discountNote, MAX_TEXT_LEN);
        }

        // ── 返結審計（0043，2026-09-18）：重結都係一個寫入點 ──
        // 🔴 為何要喺呢度寫：返結 → 加菜 → **重結** 呢條流程，重結嗰刻
        //    如果只靠 ORDER_UPDATED 寫 `reopen_count`，一旦加菜事件因為任何原因
        //    （離線重推次序、時鐘偏移）冇成功寫入，標籤就會消失 —— 但實體上
        //    張單明明返結過。喺結帳呢個「最後一次有完整內容嘅時機」補寫，
        //    等標籤有一個可靠嘅兜底。
        //    同理：`reopen_count` 用 `max()` 語義（唔可以倒退），同 ORDER_UPDATED
        //    寫入嘅值一致（兩邊都係「只會增加」）。
        // 判斷方式同 discountNote 一致：**payload 有冇帶 `reopenCount` key**
        //   - 帶數字 → 寫入（只寫 >= 1 嘅值，0 = 從未返結 → 唔覆蓋舊值）
        //   - 完全冇帶 → 唔關事（一般結帳唔會帶），唔好無條件寫而抹走 ORDER_UPDATED 嘅值
        if ("reopenCount" in eventPayload) {
          const settledReopenCount = Math.max(0, Math.trunc(Number(eventPayload.reopenCount) || 0));
          // 只在 > 0 時寫：`0` 代表「從未返結」，唔應該覆蓋 DB 可能已有嘅 >0 值
          //（離線重推時事件次序唔保證，保守寫法）。
          if (settledReopenCount > 0) {
            patch.reopen_count = settledReopenCount;
            patch.reopened_at = isoOrNull(eventPayload.reopenedAt);
            patch.reopen_reason = text(eventPayload.reopenReason, MAX_TEXT_LEN);
          }
        }

        const writeSettlePatch = async (record: Record<string, unknown>) =>
          await supabase.from("pos_orders").update(record).eq("id", settledOrderId).eq("store_id", storeId).select("id");

        let { data: settledRows, error: sErr } = await writeSettlePatch(patch);
        if (sErr && isMissingColumnError(sErr)) {
          // 🔻 0034 / 0043 未跑：拔走新欄再寫，唔可以因為新欄令結帳狀態上唔到雲。
          console.warn(`[pos/sync] pos_orders 新欄唔存在（0034 / 0043 未跑），降級寫入結帳 ${settledOrderId}`);
          const legacyPatch = { ...patch };
          delete legacyPatch.discount_note;
          delete legacyPatch.reopen_count;
          delete legacyPatch.reopened_at;
          delete legacyPatch.reopen_reason;
          ({ data: settledRows, error: sErr } = await writeSettlePatch(legacyPatch));
        }

        if (sErr) {
          console.error("[pos/sync] pos_orders settle failed:", sErr.message);
          failInfra(`訂單結帳狀態寫入失敗`);
          ack(false, "訂單結帳狀態寫入失敗");
        } else if (!settledRows || settledRows.length === 0) {
          // 🛡️ 兜底（docs/111）：ORDER_SETTLED 早過 ORDER_CREATED 到（離線一輪操作、
          // 或者 2026-09-08 之前嗰個「同 entityId 淨推最新一條」去重丟咗建立事件），
          // 純 update 會命中 0 列、**唔報錯、靜默丟單** —— 張單永遠唔會出現喺
          // pos_orders，報表同對賬都少咗佢。呢度 upsert 最小欄位救返條記錄，
          // 等 ORDER_CREATED 之後推到時會用完整 snapshot 覆寫。
          console.warn(
            `[pos/sync] ORDER_SETTLED 命中 0 列（訂單 ${settledOrderId} 未存在），改 upsert 建立最小記錄`,
          );
          const { error: iErr } = await supabase.from("pos_orders").upsert(
            {
              id: settledOrderId,
              store_id: storeId,
              status: text(eventPayload.status, 64) ?? "settled",
              total: money(eventPayload.total),
              discount_amount: money(eventPayload.discountAmount),
              payment_method: text(eventPayload.paymentMethod, MAX_NAME_LEN),
              fulfillment_status: text(eventPayload.fulfillmentStatus, 64),
              // created_at 維持 client 事件時間（報表「下單日」口徑）；updated_at server 蓋章
              created_at: text(event.createdAt, 64) ?? new Date().toISOString(),
              updated_at: new Date().toISOString(),
              client_updated_at: isoOrNull(event.createdAt) ?? new Date().toISOString(),
            },
            { onConflict: "id" },
          );
          if (iErr) {
            console.error("[pos/sync] pos_orders settle upsert fallback failed:", iErr.message);
            failInfra(`訂單結帳狀態寫入失敗`);
            ack(false, "訂單結帳狀態寫入失敗");
          } else {
            ack(true);
          }
        } else {
          ack(true);
        }
        }
      }
    }

    if (eventType === "PRINT_JOB_CREATED") {
      const jobId = typeof eventPayload.id === "string" ? eventPayload.id.slice(0, MAX_ID_LEN) : "";
      if (jobId) {
        const jobItems = Array.isArray(eventPayload.items) ? eventPayload.items.slice(0, MAX_ORDER_ITEMS) : [];
        // 唔郁 status 嘅列（重推同一個 id 時只更新內容快照，唔好把已 sent/failed/printing 嘅
        // 單打回 pending —— 否則 hub 重開時會 claim 到呢啲舊單重印，見 docs/101）。
        const contentStoreName =
          text(eventPayload.storeName, MAX_NAME_LEN) ??
          (typeof eventPayload.content === "object" && eventPayload.content !== null
            ? text((eventPayload.content as Record<string, unknown>).store_name, MAX_NAME_LEN)
            : null);
        // 🆕 P1（2026-09-15）：job 絕對有效期（epoch millis）。
        // 以前呢個 route 完全冇寫 `ttl` → 恆 NULL → 0035 嘅 ttl 守衛變死代碼
        // → 隔夜舊單補印（當日事故）。由 server 落章，client 漏寫都有保護。
        const jobCreatedAt = text(eventPayload.createdAt, 64) ?? new Date().toISOString();
        const jobTtl = Math.min(
          printJobTtl(jobCreatedAt),
          printJobBusinessDayEnd(jobCreatedAt),
        );
        const contentPatch = {
          order_id: text(eventPayload.orderId, MAX_ID_LEN),
          order_no: text(eventPayload.orderNo, MAX_NAME_LEN),
          table_name: text(eventPayload.tableName, MAX_NAME_LEN),
          ticket_type: text(eventPayload.ticketType, 64) ?? "normal",
          printer_group: text(eventPayload.printerGroup, 64) ?? "kitchen",
          printer_name: text(eventPayload.printerName, MAX_NAME_LEN),
          items: jobItems,
          // ⚠️ ttl 只喺「首次建立」寫（見下面 update 分支註釋），所以兩個分支都帶住，
          //    但 update 分支會手動剔除（唔可以改一張已存在 job 嘅有效期）。
          ttl: jobTtl,
          // 0015 migration 新增：模板快照 / 靜態內容 / 打印機綁定。
          // 冇呢三欄，job 同步去第二部機會退化做硬編 fallback 渲染（冇店名／時間／單據類型／
          // 頁尾，亦唔理商家設嘅字型大小）→ 兩部機印出嚟唔一致。見 docs/87 §7。
          template: eventPayload.template ?? null,
          content: eventPayload.content ?? null,
          // 0020：二維碼點陣 + 網址。冇呢兩欄，print-relay APK 出紙嘅收據永遠冇 QR
          //（APK `fromRow().qr` 讀到 NULL → `qr_code` 區塊被靜默跳過；2026-09-09 修復）。
          qr: qrPayloadOrNull(eventPayload.qr),
          qr_url: text(eventPayload.qrUrl, 512),
          printer_id: text(eventPayload.printerId, MAX_ID_LEN),
          // 0020 新增：Hub fallback renderer 用 store_name 印抬頭；寫入端一直漏填導致印出 "null"。
          store_name: contentStoreName,
        };
        // 🔴 `ttl` **只可以喺 insert 寫一次**，唔可以喺 update 覆蓋：
        //    重推同一條 PRINT_JOB_CREATED（離線補推 / 重試）時，如果連 ttl 都重算，
        //    一張原本已經過期嘅舊單會被「續命」，令 0035 嘅隔夜保護再次失效。
        //    有效期係「建單一刻」嘅屬性，唔應該隨每次推送改變。
        const contentPatchWithoutTtl: Record<string, unknown> = { ...contentPatch };
        delete contentPatchWithoutTtl.ttl;
        /**
         * 🆕 內容唯一鍵（2026-09-21，migration `0045_pos_print_jobs_once_key.sql`）。
         *
         * `orderId|onceScope|printerId`，由 client（`src/lib/pos/print-dedupe.ts`）砌好。
         * 只有**自動出紙路徑**會帶（收銀結帳／線上單完成／接單／補印兜底）；
         * 手動補打、加菜、退菜、返結一律唔帶 ⇒ NULL ⇒ 唔受唯一索引約束（行為不變）。
         *
         * ⚠️ 長度超上限一律**唔用**呢個鍵（而唔係截斷）—— 截斷會令兩條唔同嘅鍵
         * 撞成同一條 → 誤攔真出紙（客人冇紙），比「唔去重」危險得多。
         */
        const onceKeyRaw = typeof eventPayload.onceKey === "string" ? eventPayload.onceKey.trim() : "";
        const onceKey = onceKeyRaw.length > 0 && onceKeyRaw.length <= MAX_ONCE_KEY_LEN ? onceKeyRaw : null;

        // 1) 先試 update（只更新內容，唔動 status）—— 命中即張 job 已存在，唔應該重置佢嘅打印狀態
        //    ⚠️ `once_key` **刻意唔入 update**：佢係「首次建立」嘅身分，重推唔應該改（亦避免
        //       未跑 migration 時 update 分支撞 42703）。
        const { data: upd, error: uErr } = await supabase
          .from("pos_print_jobs")
          .update(contentPatchWithoutTtl)
          .eq("id", jobId)
          .eq("store_id", storeId)
          .select("id");
        if (uErr) {
          console.error("[pos/sync] pos_print_jobs update failed:", uErr.message);
          failInfra(`列印工作寫入失敗`);
          ack(false, "列印工作寫入失敗");
          continue;
        } else if (!upd || upd.length === 0) {
          // 2) 冇命中 → 首次建立，呢刻先寫 status（用 payload 嘅，通常 pending）
          const insertRow: Record<string, unknown> = {
            id: jobId,
            store_id: storeId,
            ...contentPatch,
            status: text(eventPayload.status, 64) ?? "pending",
            created_at: jobCreatedAt,
            ...(onceKey ? { once_key: onceKey } : {}),
          };
          let { error: iErr } = await supabase.from("pos_print_jobs").insert(insertRow);
          // 🔻 降級：`once_key` 欄未加（migration 0045 未跑）→ 拔走重寫一次，主流程唔可以壞
          //    （同 0034 discount_note / 0043 返結審計欄嘅降級慣例一致）。
          if (iErr && onceKey && isMissingColumnError(iErr)) {
            console.warn(
              "[pos/sync] pos_print_jobs 缺 once_key（migration 0045 未跑）→ 降級寫入；" +
                "內容唯一鍵去重暫時只在 client 側（localStorage 帳本）生效。",
            );
            const legacyRow = { ...insertRow };
            delete legacyRow.once_key;
            ({ error: iErr } = await supabase.from("pos_print_jobs").insert(legacyRow));
          }
          // 🔻 撞內容唯一索引（23505）＝ **同一件事已經出過紙** —— 呢個係預期結果：
          //    唔插入、但要 ack 成功（ack(false) 會令 client 永遠重試同一條已出紙嘅事件）。
          if (iErr && isUniqueViolationError(iErr)) {
            console.info(
              `[pos/sync] 內容唯一鍵重複 → 略過重複出紙（job=${jobId} once_key=${onceKey ?? "-"}）`,
            );
            ack(true);
            continue;
          }
          if (iErr) {
            console.error("[pos/sync] pos_print_jobs insert failed:", iErr.message);
            failInfra(`列印工作寫入失敗`);
            ack(false, "列印工作寫入失敗");
            continue;
          }
          ack(true);
        }
      }
    }

    // 真刪打印記錄（打印中心「清除已發送 / 已失敗 / 自動清理」）；必須按 store_id 隔離，避免跨店刪除（見 docs/52）
    if (eventType === "PRINT_JOB_DELETED") {
      const jobId = typeof eventPayload.id === "string" ? eventPayload.id.slice(0, MAX_ID_LEN) : "";
      if (jobId) {
        const { error: dErr } = await supabase
          .from("pos_print_jobs")
          .delete()
          .eq("id", jobId)
          .eq("store_id", storeId);
        if (dErr) {
          console.error("[pos/sync] pos_print_jobs delete failed:", dErr.message);
          failInfra(`列印工作刪除失敗`);
          ack(false, "列印工作刪除失敗");
          continue;
        }
        ack(true);
      }
    }

    // 真刪訂單（訂單詳情「刪除訂單」）；必須按 store_id 隔離，避免跨店刪除（見 docs/52）
    if (eventType === "ORDER_DELETED") {
      const orderId = typeof eventPayload.orderId === "string" ? eventPayload.orderId.slice(0, MAX_ID_LEN) : "";
      if (orderId) {
        const { error: dErr } = await supabase
          .from("pos_orders")
          .delete()
          .eq("id", orderId)
          .eq("store_id", storeId);
        if (dErr) {
          console.error("[pos/sync] pos_orders delete failed:", dErr.message);
          failInfra(`訂單刪除失敗`);
          ack(false, "訂單刪除失敗");
          continue;
        }
      }
    }

    // 冇明確下場嘅事件（ORDER_ITEM_VOIDED no-op、DEVICE_CONFIG_UPDATED、
    // TEST_PRINT_REQUESTED、缺 id 嘅 print job 等）：事件已記入 pos_queue_events，當 ok。
    ack(true);
  }

  // ── 收尾：一次過寫 pos_queue_events（2026-09-21 egress 優化）──
  //
  // 舊版係「每個事件一個 upsert」⇒ N 個事件 ＝ N 個 PostgREST POST
  //（實測 2026-09-21：該表 26 分鐘內 150 次 POST，係全專案請求數第一位，
  //  而 client 其實只發咗**一個** `/api/pos/sync` 請求）。
  // 改成分批寫（每批 ≤ QUEUE_EVENTS_UPSERT_CHUNK 行）⇒ 常見情況（一批 flush 幾個事件）
  // 由 N 次變 **1 次**。
  //
  // ⚠️ 一定要 `await`：Vercel function 一 return 就可能被凍結，
  //    fire-and-forget 嘅 write 會靜默消失（同「送唔出嘅 outbox」同一型問題）。
  // ⚠️ 失敗只記 warning，**唔** push 入 `infraErrors`（即唔可以令成批回 500）：
  //    `pos_queue_events` 唔係業務真源（`/api/pos/state` 直接讀 `pos_orders`），
  //    而 500 會令 client 重推已經成功寫入嘅事件（假失敗）。
  //    呢條規則同舊版逐條 upsert 完全一致，唔可以改。
  // ⚠️ 一定要喺 loop **之後**：loop 內任何 `continue`（業務拒絕 / 跨店事件）都唔應該
  //    留下審計行 —— 舊版都係「過咗驗證先寫」，呢度保留同一語義。
  if (queueRows.length > 0) {
    // 去重（同一批內重複 id 會令 ON CONFLICT 報 21000 → 整批失敗）＋ 分批（控 body 大小）
    // 兩件事都收喺 `flushQueueEventRows()`（純邏輯、零 import、有單測）。
    const flush = await flushQueueEventRows({
      // supabase-js 嘅 upsert 係多載 + 巨型泛型，同我哋嘅最小結構型別對唔上
      // ⇒ 呢度做一次**純型別層面**嘅 assertion（runtime 完全一樣）。
      client: supabase as unknown as QueueEventsUpsertClient<QueueEventRow>,
      rows: queueRows,
      chunkSize: QUEUE_EVENTS_UPSERT_CHUNK,
      onError: ({ message, batchSize }) => {
        console.error(
          `[pos/sync] queue_events 批次 upsert 失敗（${batchSize} 行，降級為 warning）:`,
          message,
        );
        warnings.push(`queue_events 寫入失敗：${message}`);
      },
    });
    if (process.env.NODE_ENV !== "production") {
      // 診斷用：確認「N 個事件 → 去重後幾多行 → 幾個請求」（優化前係 N 個請求）。
      console.log(
        `[pos/sync] queue_events：${queueRows.length} 個事件 → 去重後 ${flush.requested} 行，` +
          `${flush.batches} 個請求${flush.error ? `（失敗：${flush.error}）` : ""}`,
      );
    }
  }

  // ── 回應（方案 C）：永遠帶按事件 results。狀態碼按**失敗性質**分流 ──
  //
  // 2026-09-10 加單「冇反應」事故修復（核心）：舊版任何失敗都回 500，令
  // kiosk client 把「業務拒絕」（永久）誤判成「網絡抖動」（可重試）→ 重試 →
  // 入本地隊列 → 顯示「落單成功，正在同步…」假成功。家陣：
  //   - 全部成功            → 200 `{ok:true}`
  //   - 有基建 / DB 失敗     → 500 `{ok:false, retryable:true}`（真係可以重試）
  //   - 只有業務拒絕         → 400 `{ok:false, retryable:false}`（永久；client 應即刻報錯）
  //   - 只有未授權           → 401 `{ok:false, retryable:false, reason:"unauthorized"}`
  //                            （client 見到會強制續期憑證一次，見 sync-flush M1）
  //
  // 舊 POS client（`sync-flush.ts`）本來就會讀 `results` 逐條處理，唔靠頂層狀態碼，
  // 所以改狀態碼唔會令佢丟事件。
  const okCount = results.filter((r) => r.ok).length;
  const unauthorizedOnly =
    businessRejections.length > 0 &&
    infraErrors.length === 0 &&
    results.length > 0 &&
    results.every((r) => r.ok || r.reason === "unauthorized");
  const warningsField = warnings.length > 0 ? { warnings } : {};

  if (infraErrors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        retryable: true,
        // 對外只返第一條通用訊息；詳細 DB 錯誤只落 server log，唔外洩 schema / 欄位名
        error: infraErrors[0] ?? "部分事件寫入失敗",
        syncedCount: okCount,
        results,
        ...warningsField,
      },
      { status: 500 },
    );
  }

  if (businessRejections.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        retryable: false,
        error: businessRejections[0] ?? "部分事件被拒絕",
        syncedCount: okCount,
        results,
        ...warningsField,
      },
      { status: unauthorizedOnly ? 401 : 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    retryable: false,
    syncedCount: events.length,
    results,
    ...warningsField,
    receivedAt: new Date().toISOString(),
  });
}
