import { NextResponse } from "next/server";

import { prepareLedgerServerClient, resolveLedgerPublicConfig } from "@/lib/ledger/supabase-server-auth";
import { fetchTopupShopId } from "@/lib/topup/fetch-shop-id.server";
import { getTopupBaseUrl, isTopupSsoConfigured, signTopupOwnerSsoToken } from "@/lib/topup/sso.server";

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function POST(request: Request) {
  if (!isTopupSsoConfigured()) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "TOPUP SSO 未設定" }, { status: 503 });
  }

  const accessToken = readBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "缺少 Ledger 登入憑證" }, { status: 401 });
  }

  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "Ledger 環境變數未設定" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    staffAccount?: string;
    refreshToken?: string;
  };

  const supabase = await prepareLedgerServerClient(accessToken, body.refreshToken);
  if (!supabase) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "Ledger 環境變數未設定" }, { status: 503 });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "Ledger 登入已過期" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffError || !staffRows?.[0]?.merchant_id) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "無法讀取商戶員工資料" }, { status: 403 });
  }

  const staffRow = staffRows[0];
  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("name")
    .eq("id", staffRow.merchant_id)
    .limit(1);

  const merchant = merchantRows?.[0] as { name?: string } | undefined;
  const staffAccount = String(body.staffAccount ?? "").replace(/\D/g, "").slice(0, 8);
  const { shopId } = await fetchTopupShopId(supabase, {
    merchantId: staffRow.merchant_id,
    staffRole: staffRow.staff_role as string | undefined,
    userEmail: userData.user.email,
    staffAccount,
  });

  if (!/^\d{8}$/.test(shopId)) {
    return NextResponse.json({ ok: false, pendingCount: 0, error: "無法取得充值店舖編號" }, { status: 400 });
  }

  const shopName = merchant?.name?.trim() || shopId;
  const ownerLogin = /^\d{8}$/.test(staffAccount) ? staffAccount : shopId;
  const token = signTopupOwnerSsoToken({ shopId, shopName, ownerLogin });
  const baseUrl = getTopupBaseUrl();
  const pendingUrl = `${baseUrl}/api/integration/sitea/pending-count?shopId=${encodeURIComponent(shopId)}`;

  const topupResponse = await fetch(pendingUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = (await topupResponse.json().catch(() => ({}))) as {
    pendingCount?: number;
    error?: string;
  };

  if (!topupResponse.ok) {
    return NextResponse.json(
      {
        ok: false,
        pendingCount: 0,
        error: payload.error ?? "讀取待審核數量失敗",
      },
      { status: 502 },
    );
  }

  const pendingCount = Math.max(0, Number(payload.pendingCount) || 0);
  return NextResponse.json({
    ok: true,
    pendingCount,
    shopId,
    updatedAt: new Date().toISOString(),
  });
}
