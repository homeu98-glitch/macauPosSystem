import { NextResponse } from "next/server";

import { getLedgerServiceClient, isLedgerServiceConfigured } from "@/lib/ledger/admin-server";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { orderEventInstant } from "@/lib/pos/order-event-time";
import { fetchOrdersInRange } from "@/lib/pos-orders-range";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * GET /api/admin/merchants — admin panel 店鋪總覽數據（只讀）。
 *
 * 回傳：
 * - 全體商家列表（Ledger `merchants`：id / name / status）——要 Ledger service-role
 * - 每店營業統計（POS DB `pos_orders` 聚合：今日 / 近 7 日嘅可計銷售單數同營業額、
 *   最近落單時間）——POS service-role
 *
 * 把關：admin session token（`/admin` 登入換返嚟嗰張 12h HMAC token）。
 * 冇 Ledger service key 時仍可返 POS 統計，但 `ledgerConfigured: false`
 * 畀前端提示「商家列表需要配置 LEDGER_SERVICE_ROLE_KEY」。
 *
 * 🔴 日歸屬口徑（2026-09-30 修）：一律用 `orderEventInstant()`
 *    （`settled_at → reopened_at → updated_at → created_at`，結帳時間優先），
 *    同營業報表／交班**同一套**。舊實作讀 `created_at` ⇒ 同報表永遠夾唔埋。
 */

type MerchantStats = {
  todayOrders: number;
  todayRevenue: number;
  d7Orders: number;
  d7Revenue: number;
  lastOrderAt: string | null;
};

type LedgerMerchantRow = {
  id: string;
  name: string | null;
  status: string | null;
  created_at?: string | null;
};

/** 澳門時區「今日 00:00」嘅 ISO 字串（+08:00 固定偏移，唔使依賴 server TZ）。 */
function macauTodayStartIso(now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(now);
  return `${day}T00:00:00+08:00`;
}

/** 澳門時區「N 日前 00:00」嘅 ISO 字串。 */
function macauDaysAgoStartIso(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
  return `${day}T00:00:00+08:00`;
}

/**
 * 統計用投影（egress 最小化）：只要分店／狀態／金額 ＋ 四個時間欄。
 * `orderEventInstant()` 需要時間欄齊（`settled_at → reopened_at → updated_at → created_at`）。
 */
const STATS_COLUMNS = "store_id,status,total,created_at,updated_at,reopened_at,settled_at";

/**
 * 單次拉取上限。近 7 日 × 全店嘅單量遠低於此；真係觸頂會 warn（唔會靜靜截斷）。
 *
 * ⚠️ 舊實作係兩個 `.gte()` 查詢而且**冇帶 limit**（PostgREST 預設只回 1000 行）
 *    ⇒ 改為單次 5000 反而**更寬鬆**，唔會比舊行為少單。
 */
const STATS_ROW_LIMIT = 5000;

/**
 * 「可計銷售」狀態 —— 同報表 `isSaleCountable()`（`restaurant-daily-report.tsx`）一致：
 * 只認 `settled` / `paid`（`refunded` / `partially_refunded` 一律唔計）。
 *
 * ⚠️ 刻意**複製**而唔 import：`isSaleCountable` 住喺 `.tsx` 元件檔（`node --test`
 *    載入唔到），而 server route 亦唔應該為一個兩行判斷去拉整個報表元件。
 *    改動時兩邊要一齊改 —— 口徑分歧正正係本次 21 vs 20 事故嘅第二層原因。
 */
function isCountableSale(status: unknown): boolean {
  const s = String(status ?? "");
  return s === "settled" || s === "paid";
}

/**
 * POS DB 聚合：每店「今日 / 近 7 日」可計銷售單數＋營業額、最近落單時間。
 *
 * 🔴 2026-09-30 口徑修正（admin 店鋪總覽 21 單 vs 營業報表 20 單）：
 *    舊實作日歸屬用 `created_at`（下單時間），而報表／交班用 `orderEventInstant()`
 *    （`settled_at` 結帳時間優先）⇒ 兩頁**永遠可能夾唔埋**。
 *    實案：一張 09-29 20:23 結帳嘅澳覓單，其 `created_at` 因插件時區偏移被記成
 *    09-30 03:47 ⇒ 總覽多算 1 張、09-29 少算 1 張，21/1,407 vs 20/1,294。
 *
 *    點解唔可以直接喺 PostgREST filter 寫 `coalesce(...)`：唔支援 ⇒ 改為用報表同一套
 *    查詢（`fetchOrdersInRange()`：RPC `pos_orders_page` 四腿 OR → 降級四條時間腿）
 *    攞近 7 日超集，再喺 Node 端按 `orderEventInstant()` 分桶。
 *    呢個做法同時令「今日」與「近 7 日」出自**同一批 row**，唔會再有兩次查詢之間
 *    嘅時序差異。
 *
 * ⚠️ 只改日歸屬口徑，**冇改**「可計銷售狀態」定義、金額來源（`total`）同無上限語義
 *    —— 同舊行為逐位對齊嘅部分保持原樣。
 */
async function loadPosStats(): Promise<{
  today: Map<string, { orders: number; revenue: number }>;
  d7: Map<string, { orders: number; revenue: number }>;
  lastOrderAt: Map<string, string>;
}> {
  const empty = {
    today: new Map<string, { orders: number; revenue: number }>(),
    d7: new Map<string, { orders: number; revenue: number }>(),
    lastOrderAt: new Map<string, string>(),
  };
  const supabase = getSupabaseServerClient();
  if (!supabase) return empty;

  const todayStartMs = Date.parse(macauTodayStartIso());
  const d7StartMs = Date.parse(macauDaysAgoStartIso(7));

  const [rangeRes, lastRes] = await Promise.all([
    fetchOrdersInRange({
      supabase,
      storeId: null,
      // start / end 一律 UTC ISO（`fetchOrdersInRange` 嘅約定；同 /api/admin/orders 一致）。
      start: new Date(d7StartMs).toISOString(),
      // end: null = 無上限 —— 保持舊實作「只設下限」嘅語義，唔加新限制。
      end: null,
      limit: STATS_ROW_LIMIT,
      offset: 0,
      columns: STATS_COLUMNS,
    }),
    supabase
      .from("pos_orders")
      .select("store_id,created_at,updated_at,reopened_at,settled_at")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  // 唔可以靜默當 0：否則總覽會顯示「今日冇單」而管理員無從判斷係查詢失敗定真係冇單。
  if (rangeRes.error) {
    console.error("[admin/merchants] pos_orders 區間查詢失敗", rangeRes.error);
  }
  if (rangeRes.orders.length >= STATS_ROW_LIMIT) {
    console.warn("[admin/merchants] 近 7 日訂單觸及拉取上限，統計可能偏低", {
      limit: STATS_ROW_LIMIT,
    });
  }

  const today = new Map<string, { orders: number; revenue: number }>();
  const d7 = new Map<string, { orders: number; revenue: number }>();
  const bump = (
    map: Map<string, { orders: number; revenue: number }>,
    key: string,
    total: unknown,
  ) => {
    const cur = map.get(key) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(total ?? 0);
    map.set(key, cur);
  };

  for (const row of rangeRes.orders) {
    if (!isCountableSale(row.status)) continue;
    // DB row 係 snake_case；`orderEventInstant()` 收 structural typing（唔綁死 PosOrder），
    // 所以直接餵入去，唔使先過 `mapOrderRow()` 徒增開銷。
    const ms = orderEventInstant({
      settledAt: row.settled_at,
      reopenedAt: row.reopened_at,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    });
    if (!(ms > 0)) continue;
    const key = row.store_id ?? "(null)";
    if (ms >= d7StartMs) bump(d7, key, row.total);
    if (ms >= todayStartMs) bump(today, key, row.total);
  }

  // 「最近落單」——口徑同上（事件時間），唔用 `created_at`。
  // 仍然係「最新 2000 單入面每店取一個值」嘅近似（舊註釋已承認係近似）；
  // 分別只係由「created_at DESC 第一條」改為「逐條取 max 事件時間」，
  // 避免澳覓單因 `created_at` 偏移而顯示到**未來時間**。
  const lastMs = new Map<string, number>();
  for (const row of (lastRes.data ?? []) as Array<{
    store_id: string | null;
    created_at: string | null;
    updated_at: string | null;
    reopened_at: string | null;
    settled_at: string | null;
  }>) {
    const ms = orderEventInstant({
      settledAt: row.settled_at,
      reopenedAt: row.reopened_at,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    });
    if (!(ms > 0)) continue;
    const key = row.store_id ?? "(null)";
    const prev = lastMs.get(key);
    if (prev === undefined || ms > prev) lastMs.set(key, ms);
  }
  const lastOrderAt = new Map<string, string>(
    [...lastMs].map(([key, ms]) => [key, new Date(ms).toISOString()]),
  );

  return { today, d7, lastOrderAt };
}

export async function GET(request: Request) {
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  const ledgerConfigured = isLedgerServiceConfigured();
  const posStats = await loadPosStats();

  let merchants: Array<{
    id: string;
    name: string;
    status: string;
    stats: MerchantStats;
  }> = [];

  if (ledgerConfigured) {
    const ledger = getLedgerServiceClient();
    if (!ledger) {
      return NextResponse.json({ ok: false, error: "Ledger service client 初始化失敗。" }, { status: 503 });
    }
    const { data, error } = await ledger
      .from("merchants")
      .select("id, name, status, created_at")
      .order("name", { ascending: true });

    if (error) {
      return NextResponse.json(
        { ok: false, error: "無法讀取商家列表。", detail: error.message },
        { status: 502 },
      );
    }

    merchants = ((data ?? []) as LedgerMerchantRow[]).map((m) => {
      const key = m.id ?? "(null)";
      const t = posStats.today.get(key) ?? { orders: 0, revenue: 0 };
      const w = posStats.d7.get(key) ?? { orders: 0, revenue: 0 };
      return {
        id: m.id,
        name: m.name ?? m.id,
        status: String(m.status ?? "").toLowerCase() || "unknown",
        stats: {
          todayOrders: t.orders,
          todayRevenue: Math.round(t.revenue * 100) / 100,
          d7Orders: w.orders,
          d7Revenue: Math.round(w.revenue * 100) / 100,
          lastOrderAt: posStats.lastOrderAt.get(key) ?? null,
        },
      };
    });
  }

  // Ledger 冇配置時，都把 POS DB 入面有單嘅 store 列出嚟（id 當名稱），等總覽唔會完全空白。
  if (!ledgerConfigured) {
    const ids = new Set<string>([...posStats.today.keys(), ...posStats.d7.keys(), ...posStats.lastOrderAt.keys()]);
    merchants = [...ids]
      .filter((id) => id !== "(null)")
      .sort()
      .map((id) => {
        const t = posStats.today.get(id) ?? { orders: 0, revenue: 0 };
        const w = posStats.d7.get(id) ?? { orders: 0, revenue: 0 };
        return {
          id,
          name: id,
          status: "unknown",
          stats: {
            todayOrders: t.orders,
            todayRevenue: Math.round(t.revenue * 100) / 100,
            d7Orders: w.orders,
            d7Revenue: Math.round(w.revenue * 100) / 100,
            lastOrderAt: posStats.lastOrderAt.get(id) ?? null,
          },
        };
      });
  }

  return NextResponse.json({
    ok: true,
    ledgerConfigured,
    merchants,
    generatedAt: new Date().toISOString(),
  });
}
