import { NextResponse } from "next/server";

import { getLedgerServiceClient, isLedgerServiceConfigured } from "@/lib/ledger/admin-server";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
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

  // 可計銷售口徑同報表一致：settled / paid（唔計 refunded / cancelled）。
  const saleStatuses = "settled,paid";
  const todayStart = macauTodayStartIso();
  const d7Start = macauDaysAgoStartIso(7);

  const [todayRes, d7Res, lastRes] = await Promise.all([
    supabase
      .from("pos_orders")
      .select("store_id, total")
      .in("status", saleStatuses.split(","))
      .gte("created_at", todayStart),
    supabase
      .from("pos_orders")
      .select("store_id, total")
      .in("status", saleStatuses.split(","))
      .gte("created_at", d7Start),
    supabase.from("pos_orders").select("store_id, created_at").order("created_at", { ascending: false }).limit(2000),
  ]);

  const today = new Map<string, { orders: number; revenue: number }>();
  for (const row of (todayRes.data ?? []) as Array<{ store_id: string | null; total: number | null }>) {
    const key = row.store_id ?? "(null)";
    const cur = today.get(key) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(row.total ?? 0);
    today.set(key, cur);
  }

  const d7 = new Map<string, { orders: number; revenue: number }>();
  for (const row of (d7Res.data ?? []) as Array<{ store_id: string | null; total: number | null }>) {
    const key = row.store_id ?? "(null)";
    const cur = d7.get(key) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(row.total ?? 0);
    d7.set(key, cur);
  }

  // 最近落單時間：pos_orders 冇 per-store max() 嘅直接聚合查詢結果型別，
  // 用「最新 2000 單入面每店第一個出現嘅時間」近似（訂單量極大時足夠準）。
  const lastOrderAt = new Map<string, string>();
  for (const row of (lastRes.data ?? []) as Array<{ store_id: string | null; created_at: string }>) {
    const key = row.store_id ?? "(null)";
    if (!lastOrderAt.has(key)) lastOrderAt.set(key, row.created_at);
  }

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
