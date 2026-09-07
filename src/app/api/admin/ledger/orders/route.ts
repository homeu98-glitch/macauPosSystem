import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
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
 * - start / end（可選）：ISO 區間，過濾口徑 = `created_at ∈ 區間`
 *   （同 POS / 報表 client 端口徑一致，轉 UTC ISO 避開 `+08:00` 解析歧義）
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
  const claims = readAdminSessionFromRequest(request);
  if (!claims) {
    return NextResponse.json({ ok: false, error: "未授權，請先登入管理後台。" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const merchantId = searchParams.get("merchantId")?.trim() || null;
  const startRaw = searchParams.get("start")?.trim() || null;
  const endRaw = searchParams.get("end")?.trim() || null;
  const start = startRaw ? toUtcIso(startRaw) : null;
  const end = endRaw ? toUtcIso(endRaw) : null;

  console.log("[admin/ledger/orders] request", {
    account: claims.account,
    merchantId: merchantId ?? "all",
    startRaw,
    endRaw,
    start,
    end,
  });

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
        .order("created_at", { ascending: false })
        .range(off, off + PAGE - 1);
      if (merchantId) q = q.eq("merchant_id", merchantId);
      if (start) q = q.gte("created_at", start);
      if (end) q = q.lte("created_at", end);

      const { data, error } = await q;
      if (error) {
        console.error("[admin/ledger/orders] query_failed", { merchantId, start, end, off, error });
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
      scope: merchantId ?? "all",
      rawCount: all.length,
      mappedCount: orders.length,
    });

    return NextResponse.json({
      ok: true,
      scope: merchantId ?? "all",
      orders,
      limit: all.length,
      offset: 0,
      debug: { start, end, count: orders.length },
    });
  } catch (err) {
    console.error("[admin/ledger/orders] unexpected", { merchantId, start, end, err });
    return NextResponse.json(
      { ok: false, error: "讀取線上單時發生錯誤。", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
