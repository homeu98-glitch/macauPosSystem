import { NextRequest, NextResponse } from "next/server";

import { fetchTopupShopId } from "@/lib/topup/fetch-shop-id.server";
import {
  getTopupBaseUrl,
  isTopupSsoConfigured,
  signTopupOwnerSsoToken,
} from "@/lib/topup/sso.server";
import {
  prepareLedgerServerClient,
  resolveLedgerPublicConfig,
} from "@/lib/ledger/supabase-server-auth";

/**
 * 店主審核 API 嘅 server-side proxy。
 *
 * 目的：取代 macau-pos 入面嵌 topup 嘅 iframe —— macau-pos 原生 React UI 改為 call 呢度，
 * 呢度再簽 Site A（macau-pos）owner JWT、Bearer 轉發去 topup 嘅 /api/owner/* 端點。
 * topup 嗰邊嘅 owner 端點經 resolveOwnerRequest 接受呢支 JWT（見 topup lib/topup-service.js）。
 *
 * 認證流程完全 mirror 現有 /api/topup/owner-embed 與 /api/topup/pending-count：
 *   1. 驗 Ledger Bearer → 2. merchant_staff → 3. fetchTopupShopId 拎 8 位編號
 *   4. signTopupOwnerSsoToken 簽 JWT → 5. Bearer 轉發去 topup。
 *
 * 靜態路徑 /api/topup/owner-embed 與 /api/topup/owner/pending-count 唔會中呢度（Next 優先靜態段）。
 */

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

type ProxyContext = { params: Promise<{ slug: string[] }> };

export async function GET(request: NextRequest, ctx: ProxyContext) {
  return proxyOwnerRequest(request, ctx, "GET");
}

export async function POST(request: NextRequest, ctx: ProxyContext) {
  return proxyOwnerRequest(request, ctx, "POST");
}

async function proxyOwnerRequest(
  request: NextRequest,
  ctx: ProxyContext,
  method: "GET" | "POST",
) {
  if (!isTopupSsoConfigured()) {
    return NextResponse.json(
      { ok: false, error: "POS 尚未設定 TOPUP_SITEA_SSO_SECRET，無法接入充值審核。" },
      { status: 503 },
    );
  }

  const ledgerToken = readBearerToken(request);
  if (!ledgerToken) {
    return NextResponse.json({ ok: false, error: "缺少 Ledger 登入憑證。" }, { status: 401 });
  }

  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const refreshToken =
    (body.refreshToken as string | undefined) ??
    request.nextUrl.searchParams.get("refreshToken") ??
    null;

  const supabase = await prepareLedgerServerClient(ledgerToken, refreshToken);
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(ledgerToken);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ ok: false, error: "Ledger 登入已過期，請重新登入 POS。" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffError || !staffRows?.[0]?.merchant_id) {
    return NextResponse.json(
      { ok: false, error: "此帳號未綁定 merchant_staff，無法使用充值審核。" },
      { status: 403 },
    );
  }

  const staffRow = staffRows[0];
  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("name")
    .eq("id", staffRow.merchant_id)
    .limit(1);
  const merchant = merchantRows?.[0] as { name?: string } | undefined;

  const staffAccount = String(
    (body.staffAccount as string | undefined) ?? request.nextUrl.searchParams.get("staffAccount") ?? "",
  )
    .replace(/\D/g, "")
    .slice(0, 8);

  const { shopId } = await fetchTopupShopId(supabase, {
    merchantId: staffRow.merchant_id,
    staffRole: staffRow.staff_role as string | undefined,
    userEmail: userData.user.email,
    staffAccount,
  });

  if (!/^\d{8}$/.test(shopId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "無法取得充值店舖編號。請以店主帳號登入 POS，或在 Vercel 設定 TOPUP_SHOP_ID_OVERRIDES（merchant UUID → 8 位店舖編號）。",
      },
      { status: 400 },
    );
  }

  const shopName = merchant?.name?.trim() || shopId;
  const ownerLogin = /^\d{8}$/.test(staffAccount) ? staffAccount : shopId;
  const topupJwt = signTopupOwnerSsoToken({ shopId, shopName, ownerLogin });

  const slug = (await ctx.params).slug;
  const topupPath = slug.join("/");
  const topupUrl = `${getTopupBaseUrl()}/api/owner/${topupPath}${request.nextUrl.search}`;

  const topupRes = await fetch(topupUrl, {
    method,
    headers: {
      Authorization: `Bearer ${topupJwt}`,
      "Content-Type": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });

  const payload = (await topupRes.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(payload, { status: topupRes.status });
}
