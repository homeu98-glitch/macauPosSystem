import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { isPlaceholderStoreId } from "@/lib/pos/store-id-guard";

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

/** 解析 ISO 時間戳做毫秒數；非法 → 0（當最舊）。 */
function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** 已有 row 記錄（LWW 比較用）。 */
type ExistingOrderRow = { id: string; status: string | null; updated_at: string | null };

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
    if (t !== "ORDER_CREATED" && t !== "ORDER_UPDATED") continue;
    const p = (typeof ev.payload === "object" && ev.payload !== null ? ev.payload : {}) as Record<string, unknown>;
    const candidate = (t === "ORDER_UPDATED" ? p.order : p) as Record<string, unknown> | undefined;
    const id = candidate && typeof candidate.id === "string" ? candidate.id.slice(0, MAX_ID_LEN) : "";
    if (id) orderIds.add(id);
  }
  const existingById = new Map<string, ExistingOrderRow>();
  if (orderIds.size > 0) {
    const idArr = [...orderIds].slice(0, MAX_EVENTS_PER_REQUEST);
    const { data: existingRows, error: existingErr } = await supabase
      .from("pos_orders")
      .select("id,status,updated_at")
      .eq("store_id", storeId)
      .in("id", idArr);
    if (existingErr) {
      console.error("[pos/sync] 預取現有訂單失敗（LWW 守門降級為無條件寫入）:", existingErr.message);
    } else {
      for (const row of (existingRows ?? []) as ExistingOrderRow[]) existingById.set(row.id, row);
    }
  }

  const errors: string[] = [];

  for (const rawEvent of events) {
    if (typeof rawEvent !== "object" || rawEvent === null) {
      errors.push("事件格式錯誤");
      continue;
    }
    const event = rawEvent as Record<string, unknown>;
    const eventId = text(event.id, MAX_ID_LEN);
    const eventType = typeof event.type === "string" ? event.type : "";

    if (!eventId) {
      errors.push("事件缺少 id");
      continue;
    }
    // ── 3) 事件類型白名單：唔喺名單內嘅一律跳過（防未知 type 走進寫入分支）──
    if (!VALID_EVENT_TYPES.has(eventType)) {
      errors.push(`未知事件類型：${eventType.slice(0, 40)}`);
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
      errors.push(`事件 ${eventId} 的店舖標識與請求不一致（跨店事件），已拒絕`);
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
      console.error("[pos/sync] queue_events upsert failed:", qErr.message);
      errors.push(`queue_events 寫入失敗`);
    }

    if (eventType === "ORDER_CREATED" || eventType === "ORDER_UPDATED") {
      const order = (eventType === "ORDER_UPDATED" ? eventPayload.order : eventPayload) as
        | Record<string, unknown>
        | undefined;
      const orderId = order && typeof order.id === "string" ? order.id.slice(0, MAX_ID_LEN) : "";
      // `order &&` 要再寫多次：TS 唔會由 `orderId` 嘅 truthiness 反推 `order` 已經 narrowing 咗，
      // 唔加會令下面 23 處 `order.xxx` 全部報 TS18048「possibly undefined」。
      if (order && orderId) {
        const incomingStatus = text(order.status, 64) ?? "draft";
        const incomingUpdatedAt = text(order.updatedAt, 64) ?? new Date().toISOString();
        const existing = existingById.get(orderId);

        if (existing) {
          const incomingTs = parseIsoMs(incomingUpdatedAt);
          const existingTs = parseIsoMs(existing.updated_at);
          const existingStatus = existing.status ?? "";
          // (a) LWW：incoming 舊過現有 row → stale，跳過唔寫（唔報錯 —— client 收到 200
          //     會當成功剷走呢條過期事件，唔會 burn attempts，亦唔會反覆將單打回舊狀態）；
          // (b) 終態守門：settled/cancelled/refunded/partially_refunded 唔可以被 open snapshot
          //     降級。唯一合法嘅終態 → open 轉移係明確 `reopened`（返結帳）。
          const isStale = incomingTs < existingTs;
          const isDowngrade =
            TERMINAL_ORDER_STATUSES.has(existingStatus) &&
            !TERMINAL_ORDER_STATUSES.has(incomingStatus) &&
            incomingStatus !== "reopened";
          if (isStale || isDowngrade) {
            console.warn(
              `[pos/sync] 拒絕覆寫訂單 ${orderId}（現有=${existingStatus}@${existing.updated_at ?? "?"}，` +
                `incoming=${incomingStatus}@${incomingUpdatedAt}，` +
                `${isStale ? "stale（incoming 較舊）" : "終態降級"}）`,
            );
            continue;
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
          status: incomingStatus,
          fulfillment_status: text(order.fulfillmentStatus, 64),
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
          updated_at: incomingUpdatedAt,
        };
        const { error: oErr } = existing
          ? await supabase
              .from("pos_orders")
              .update(baseRecord)
              .eq("id", orderId)
              .eq("store_id", storeId)
          : await supabase.from("pos_orders").upsert(
              {
                ...baseRecord,
                created_at: text(order.createdAt, 64) ?? new Date().toISOString(),
              },
              { onConflict: "id" },
            );
        if (oErr) {
          console.error("[pos/sync] pos_orders upsert/update failed:", oErr.message);
          errors.push(`訂單 ${text(order.localOrderNo, MAX_NAME_LEN) ?? orderId} 寫入失敗`);
        }
      }
    }

    if (eventType === "ORDER_SETTLED") {
      const settledOrderId =
        typeof eventPayload.orderId === "string" ? eventPayload.orderId.slice(0, MAX_ID_LEN) : "";
      if (settledOrderId) {
        const patch: Record<string, unknown> = {
          status: text(eventPayload.status, 64) ?? "settled",
          fulfillment_status: text(eventPayload.fulfillmentStatus, 64),
          sent_to_kitchen_at: text(eventPayload.sentToKitchenAt, 64),
          served_at: eventPayload.servedAt ? text(eventPayload.servedAt, 64) : null,
          payment_method: text(eventPayload.paymentMethod, MAX_NAME_LEN),
          discount_amount: money(eventPayload.discountAmount),
          total: money(eventPayload.total),
          updated_at: text(event.createdAt, 64) ?? new Date().toISOString(),
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

        const { data: settledRows, error: sErr } = await supabase
          .from("pos_orders")
          .update(patch)
          .eq("id", settledOrderId)
          .eq("store_id", storeId)
          .select("id");

        if (sErr) {
          console.error("[pos/sync] pos_orders settle failed:", sErr.message);
          errors.push(`訂單結帳狀態寫入失敗`);
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
              created_at: text(event.createdAt, 64) ?? new Date().toISOString(),
              updated_at: text(event.createdAt, 64) ?? new Date().toISOString(),
            },
            { onConflict: "id" },
          );
          if (iErr) {
            console.error("[pos/sync] pos_orders settle upsert fallback failed:", iErr.message);
            errors.push(`訂單結帳狀態寫入失敗`);
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
          errors.push(`列印工作寫入失敗`);
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
            errors.push(`列印工作寫入失敗`);
          }
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
          errors.push(`列印工作刪除失敗`);
        }
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
          errors.push(`訂單刪除失敗`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        // 對外只返第一條通用訊息；詳細 DB 錯誤只落 server log，唔外洩 schema / 欄位名
        error: errors[0],
        syncedCount: Math.max(0, events.length - errors.length),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    syncedCount: events.length,
    receivedAt: new Date().toISOString(),
  });
}
