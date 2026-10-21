import { NextResponse } from "next/server";

import { requireAdmin, storeFilterOrDeny } from "@/lib/admin-guard.server";
import { getLedgerServiceClient } from "@/lib/ledger/admin-server";
import { mapLedgerOrderRow, type LedgerOrderRow, type LedgerOnlineOrder } from "@/lib/ledger/order-mapper";

/**
 * GET /api/admin/ledger/orders — admin panel 跨店讀取 Ledger 線上單（只讀）。
 *
 * 解決 root cause（2026-09-07）：舊版 admin 報表永遠冇讀 Ledger 線上單，因為
 * `listMerchantOrders` RPC 要商戶 JWT，而 admin 裝置冇商戶身份 → 線上單永遠空。
 * 呢個 endpoint 改用 **Ledger service-role client**（`getLedgerServiceClient()`，
 * 同一個讀 `merchants` 表成功嘅通道），直接查 `public.orders`，唔使任何商戶 session。
 *
 * Query params：
 * - merchantId（可選）：不帶 = 全部商家（「全部」彙總）；帶 = 指定商家 UUID
 *   （Ledger merchant_id == POS store_id，同一個 UUID，可直接用）
 * - start / end（可選）：ISO 區間，過濾口徑 = **`updated_at` ∈ 區間**
 *   （同 POS / 報表 client 端口徑一致 —— 前端用 `orderEventInstant()`，即 `updatedAt` 優先）
 *
 * 🔴 2026-09-24 改：由 `created_at` 改為 `updated_at`。
 *   前端口徑（`restaurant-daily-report.tsx` admin 分支）係 `orderEventInstant()`
 *   （`reopenedAt → originalSettledAt → updatedAt → createdAt`），若 server 仍按
 *   `created_at` 篩，就會靜默丟棄「昨日落單、今日完成」嘅預約單 ——
 *   2026-09-24 實案：表嫂美食取餐碼 001（MOP 43、餘額扣點）就係咁樣唔入報表。
 *   排序同時改為 `updated_at DESC`（同 RPC `list_merchant_orders` 一致）。
 *
 * 把關：admin session token。service-role key 只存 server，絕不落 client bundle。
 * 未配置 `LEDGER_SERVICE_ROLE_KEY` → fail-closed 出 503（唔可以靜默返空，否則
 * 用戶又分唔到「真·冇單」定「資料庫未連到」）。
 *
 * 分頁：server 內部用 `.range()` 翻頁（PostgREST 單次上限 1000 行），累積到
 * CAP=4000 行或無更多為止，一次過返晒畀前端（前端再做 range/cancel/unpaid 細分）。
 */

function toUtcIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString();
}

const CAP = 4000;
const PAGE = 1000;

export async function GET(request: Request) {
  // 🔴 2026-10-21（P1）：舊版唔帶 merchantId 就查全部商家線上單。
  // 店主帳號只可以見自己嘅店；指定其他店 → 403（唔會靜默降級）。
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.res;
  const { claims } = guard;

  const { searchParams } = new URL(request.url);
  const requestedMerchantId = searchParams.get("merchantId")?.trim() || null;
  const filter = storeFilterOrDeny(guard.scope, requestedMerchantId, request);
  if (!filter.ok) return filter.res;
  /** null = 平台級（全部商家）；陣列 = scope 內店舖（空陣列 = 一間都冇）。 */
  const merchantIds = filter.storeIds;

  const startRaw = searchParams.get("start")?.trim() || null;
  const endRaw = searchParams.get("end")?.trim() || null;
  const start = startRaw ? toUtcIso(startRaw) : null;
  const end = endRaw ? toUtcIso(endRaw) : null;

  console.log("[admin/ledger/orders] request", {
    account: claims.account,
    merchantIds: merchantIds ?? "all",
    startRaw,
    endRaw,
    start,
    end,
  });

  // 空 scope：直接回空，唔好打 Ledger（亦唔可以變成「查全部」）。
  if (Array.isArray(merchantIds) && merchantIds.length === 0) {
    return NextResponse.json({
      ok: true,
      scope: [],
      orders: [],
      limit: 0,
      offset: 0,
      debug: { start, end, count: 0 },
    });
  }

  const supabase = getLedgerServiceClient();
  if (!supabase) {
    const missing: string[] = [];
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!process.env.LEDGER_SERVICE_ROLE_KEY && !process.env.LEDGER_SUPABASE_SERVICE_ROLE_KEY) {
      missing.push("LEDGER_SERVICE_ROLE_KEY");
    }
    console.error("[admin/ledger/orders] ledger_not_configured", { missing });
    return NextResponse.json(
      {
        ok: false,
        code: "ledger_not_configured",
        error: `Ledger 資料庫未配置（缺少 ${missing.join(" / ")}），無法讀取線上單。`,
      },
      { status: 503 },
    );
  }

  try {
    const all: LedgerOrderRow[] = [];
    for (let off = 0; off < CAP; off += PAGE) {
      let q = supabase
        .from("orders")
        .select("*")
        .order("updated_at", { ascending: false })
        .range(off, off + PAGE - 1);
      // scope：null = 全部商家；陣列 = `merchant_id in (...)`
      if (merchantIds !== null) q = q.in("merchant_id", merchantIds);
      // 🔴 一定要 `updated_at`：前端口徑係 `orderEventInstant()`（updatedAt 優先）。
      // 用 `created_at` 會靜默丟棄「昨日落單、今日完成」嘅預約單（2026-09-24 實案）。
      if (start) q = q.gte("updated_at", start);
      if (end) q = q.lte("updated_at", end);

      const { data, error } = await q;
      if (error) {
        console.error("[admin/ledger/orders] query_failed", { merchantIds, start, end, off, error });
        return NextResponse.json(
          { ok: false, error: "讀取線上單失敗。", detail: error.message },
          { status: 502 },
        );
      }
      const rows = (data ?? []) as LedgerOrderRow[];
      all.push(...rows);
      if (rows.length < PAGE) break;
    }

    const orders: LedgerOnlineOrder[] = all.map(mapLedgerOrderRow);
    console.log("[admin/ledger/orders] result", {
      account: claims.account,
      scope: merchantIds ?? "all",
      rawCount: all.length,
      mappedCount: orders.length,
    });

    return NextResponse.json({
      ok: true,
      scope: merchantIds ?? "all",
      orders,
      limit: all.length,
      offset: 0,
      debug: { start, end, count: orders.length },
    });
  } catch (err) {
    console.error("[admin/ledger/orders] unexpected", { merchantIds, start, end, err });
    return NextResponse.json(
      { ok: false, error: "讀取線上單時發生錯誤。", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
