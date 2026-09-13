import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { isMissingColumnError } from "@/lib/supabase-errors";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";
import {
  isPosDeviceAuthRequired,
  readPosDeviceTokenFromRequest,
} from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";
import { totalItemQuantity } from "@/lib/pos/order-item-diff";
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
const MAX_PARTY_SIZE = 999; // 對齊 0017 migration 嘅 CHECK 約束
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
// 注意：唔好加 DEFAULT_STORE_ID fallback。缺 storeId 一定要大聲失敗（400），
// 否則會靜默寫入假店（舊日嘅 "macau-store-a"），令雲端中繼配咗對但一張都印唔出。

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

/** 入座人數：只接受 1..999 嘅整數，其餘一律 null（對齊 DB CHECK，避免 upsert 成單成批失敗）。 */
function partySizeOrNull(value: unknown): number | null {
  return intOrNull(value, MAX_PARTY_SIZE);
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
  if (anonymousOrderEvents.length > 0) {
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
      candidate = (t === "ORDER_UPDATED" ? p.order : p) as Record<string, unknown> | undefined;
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
    const { data: existingRows, error: existingErr } = await supabase
      .from("pos_orders")
      .select("id,status,fulfillment_status,items,updated_at,client_updated_at")
      .eq("store_id", storeId)
      .in("id", idArr);
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

    const { error: qErr } = await supabase.from("pos_queue_events").upsert(
      {
        id: eventId,
        type: eventType,
        entity_id: text(event.entityId, MAX_ID_LEN),
        payload: eventPayload,
        status: text(event.status, 64),
        created_at: typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString(),
        // 🛡️ 跨店隔離：queue 行記錄事件歸屬店（/api/pos/state 按呢欄過濾派發）。
        // 上面已驗證 eventStoreId === storeId（或 null legacy）→ 直接落 eventStoreId。
        store_id: eventStoreId,
      },
      { onConflict: "id" },
    );
    if (qErr) {
      // ⚠️ 只記 warning，**唔**令成批回 500：審計表寫入失敗唔代表訂單冇寫入成功。
      // 舊版呢度 push 入 errors → 回應 500 → client 當失敗重推已成功嘅事件（假失敗）。
      // `pos_queue_events` 唔係業務真源（`/api/pos/state` 直接讀 `pos_orders`），
      // 所以降級 + 留 server log 排查就夠。
      console.error("[pos/sync] queue_events upsert failed（降級為 warning）:", qErr.message);
      warnings.push(`queue_events 寫入失敗：${qErr.message}`);
    }

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
      const nestedOrder =
        typeof eventPayload.order === "object" && eventPayload.order !== null
          ? (eventPayload.order as Record<string, unknown>)
          : null;
      const order = (eventType === "ORDER_UPDATED" ? nestedOrder ?? eventPayload : eventPayload) as
        | Record<string, unknown>
        | undefined;
      /** 收銀台帶嘅「本次新增菜品」（kiosk / 舊 client 冇）。 */
      const addedItems = Array.isArray(eventPayload.addedItems)
        ? (eventPayload.addedItems as Record<string, unknown>[])
        : null;
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
        const writeStatus = existing && !authorized ? existing.status ?? incomingStatus : incomingStatus;
        const writeFulfillment =
          existing && !authorized ? existing.fulfillment_status : text(order.fulfillmentStatus, 64);

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
           * （匿名加單改唔到狀態機）；② 「items 變多」唔可能覆蓋任何嘢，只會新增。
           * 所以「incoming 項目數 > 現有項目數」時唔應該因為時間戳就丟棄。
           */
          const incomingQty = totalItemQuantity(
            Array.isArray(order.items) ? (order.items as OrderItem[]) : undefined,
          );
          const existingQty = totalItemQuantity(
            Array.isArray(existing.items) ? (existing.items as OrderItem[]) : undefined,
          );
          const isAdditiveUpdate = eventType === "ORDER_UPDATED" && incomingQty > existingQty;
          // (a) LWW：incoming 舊過現有 row → stale，跳過唔寫；
          // (b) 終態守門：settled/cancelled/refunded/partially_refunded 唔可以被 open snapshot
          //     降級。唯一合法嘅終態 → open 轉移係明確 `reopened`（返結帳）。
          const isStale = incomingTs > 0 && incomingTs < existingTs && !isAdditiveUpdate;
          if (isAdditiveUpdate && incomingTs > 0 && incomingTs < existingTs) {
            console.info(
              `[pos/sync] 加菜豁免：接受較舊時間戳嘅加單 ${orderId}（項目 ${existingQty} → ${incomingQty}）`,
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
           */
          const isPaidDowngrade =
            PAID_ORDER_STATUSES.has(existingStatus) && OPEN_ORDER_STATUSES.has(writeStatus);
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
          // 方案 B（2026-09-09）：`updated_at` 一律 server 蓋章（收件時間，單一鐘域）；
          // client 裝置時鐘時間戳另存 `client_updated_at`，專供 LWW 守門同鐘域比較。
          // 注意：`created_at` 維持 client 時間（首次建立）—— 訂單排序（compareOrderByLocalNo）
          // 同報表「下單時間」口徑都靠佢，唔可以俾補傳時間蓋走。
          updated_at: new Date().toISOString(),
          client_updated_at: incomingUpdatedAt,
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
          // 🔻 0034 migration 未跑：`discount_note` 呢條新欄唔存在（42703）。
          // 一定要拔走新欄重寫一次 —— 唔係「折扣備註同步唔到」咁小事，而係
          // **整張單都上唔到雲**（落單主流程被新功能拖冧）。
          // 呢個降級係一次過嘅：migration 跑完之後寫入自然帶返新欄。
          console.warn(
            `[pos/sync] pos_orders.discount_note 欄唔存在（0034 未跑），降級寫入訂單 ${orderId}`,
          );
          const legacyRecord = { ...baseRecord };
          delete legacyRecord.discount_note;
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

        const writeSettlePatch = async (record: Record<string, unknown>) =>
          await supabase.from("pos_orders").update(record).eq("id", settledOrderId).eq("store_id", storeId).select("id");

        let { data: settledRows, error: sErr } = await writeSettlePatch(patch);
        if (sErr && isMissingColumnError(sErr)) {
          // 🔻 0034 未跑：拔走 `discount_note` 再寫，唔可以因為新欄令結帳狀態上唔到雲。
          console.warn(`[pos/sync] pos_orders.discount_note 欄唔存在（0034 未跑），降級寫入結帳 ${settledOrderId}`);
          const legacyPatch = { ...patch };
          delete legacyPatch.discount_note;
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
        const contentPatch = {
          order_id: text(eventPayload.orderId, MAX_ID_LEN),
          order_no: text(eventPayload.orderNo, MAX_NAME_LEN),
          table_name: text(eventPayload.tableName, MAX_NAME_LEN),
          ticket_type: text(eventPayload.ticketType, 64) ?? "normal",
          printer_group: text(eventPayload.printerGroup, 64) ?? "kitchen",
          printer_name: text(eventPayload.printerName, MAX_NAME_LEN),
          items: jobItems,
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
        // 1) 先試 update（只更新內容，唔動 status）—— 命中即張 job 已存在，唔應該重置佢嘅打印狀態
        const { data: upd, error: uErr } = await supabase
          .from("pos_print_jobs")
          .update(contentPatch)
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
          const { error: iErr } = await supabase.from("pos_print_jobs").insert({
            id: jobId,
            store_id: storeId,
            ...contentPatch,
            status: text(eventPayload.status, 64) ?? "pending",
            created_at: text(eventPayload.createdAt, 64) ?? new Date().toISOString(),
          });
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
