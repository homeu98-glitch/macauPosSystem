import { NextResponse } from "next/server";

import { prepareLedgerServerClient, resolveLedgerPublicConfig } from "@/lib/ledger/supabase-server-auth";
import { resolveTopupShopId } from "@/lib/topup/resolve-shop-id";
import { buildTopupOwnerEmbedUrl, getTopupBaseUrl, isTopupSsoConfigured } from "@/lib/topup/sso.server";

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export async function POST(request: Request) {
  if (!isTopupSsoConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "POS 尚未設定 TOPUP_SITEA_SSO_SECRET，無法接入充值審核。",
      },
      { status: 503 },
    );
  }

  const accessToken = readBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "缺少 Ledger 登入憑證。" }, { status: 401 });
  }

  const { url, anonKey } = resolveLedgerPublicConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    staffAccount?: string;
    refreshToken?: string;
  };

  const supabase = await prepareLedgerServerClient(accessToken, body.refreshToken);
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ ok: false, error: "Ledger 登入已過期，請重新登入 POS。" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffError) {
    return NextResponse.json(
      {
        ok: false,
        error: "無法讀取商戶員工資料，請稍後再試。",
        detail: staffError.message,
      },
      { status: 503 },
    );
  }

  const staffRow = staffRows?.[0];
  if (!staffRow?.merchant_id) {
    return NextResponse.json(
      { ok: false, error: "此帳號未綁定 merchant_staff，無法使用充值審核。" },
      { status: 403 },
    );
  }

  const { data: merchantRows, error: merchantError } = await supabase
    .from("merchants")
    .select("name, phone")
    .eq("id", staffRow.merchant_id)
    .limit(1);

  if (merchantError) {
    return NextResponse.json(
      {
        ok: false,
        error: "無法讀取商戶資料。",
        detail: merchantError.message,
      },
      { status: 503 },
    );
  }

  const merchant = merchantRows?.[0] as { name?: string; phone?: string } | undefined;
  const staffAccount = String(body.staffAccount ?? "").replace(/\D/g, "").slice(0, 8);
  const shopId = resolveTopupShopId({
    merchantPhone: merchant?.phone,
    staffAccount,
  });

  if (!/^\d{8}$/.test(shopId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "無法取得充值店舖編號，請確認 Ledger 商戶已設定 8 位電話（merchants.phone）。",
      },
      { status: 400 },
    );
  }

  const shopName = merchant?.name?.trim() || shopId;
  const ownerLogin = /^\d{8}$/.test(staffAccount) ? staffAccount : shopId;
  const embedUrl = buildTopupOwnerEmbedUrl({ shopId, shopName, ownerLogin });

  return NextResponse.json({
    ok: true,
    embedUrl,
    topupBaseUrl: getTopupBaseUrl(),
    shopId,
    shopName,
    staffAccount: ownerLogin,
    merchantPhone: merchant?.phone ?? null,
  });
}
