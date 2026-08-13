import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { buildTopupOwnerEmbedUrl, getTopupBaseUrl, isTopupSsoConfigured } from "@/lib/topup/sso.server";

function resolveSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return { url, anonKey };
}

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

  const { url, anonKey } = resolveSupabaseConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ ok: false, error: "Ledger 登入已過期，請重新登入 POS。" }, { status: 401 });
  }

  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", userData.user.id)
    .limit(1);

  if (staffError || !staffRows?.[0]?.merchant_id) {
    return NextResponse.json({ ok: false, error: "無本店操作權限。" }, { status: 403 });
  }

  const staffRow = staffRows[0];
  const { data: merchantRows, error: merchantError } = await supabase
    .from("merchants")
    .select("name, phone")
    .eq("id", staffRow.merchant_id)
    .limit(1);

  if (merchantError) {
    return NextResponse.json({ ok: false, error: "無法讀取商戶資料。" }, { status: 503 });
  }

  const merchant = merchantRows?.[0] as { name?: string; phone?: string } | undefined;
  const body = (await request.json().catch(() => ({}))) as { shopId?: string };
  const shopIdFromBody = String(body.shopId ?? "").replace(/\D/g, "").slice(0, 8);
  const merchantPhone = String(merchant?.phone ?? "").replace(/\D/g, "").slice(0, 8);
  const shopId = /^\d{8}$/.test(shopIdFromBody)
    ? shopIdFromBody
    : /^\d{8}$/.test(merchantPhone)
      ? merchantPhone
      : "";

  if (!/^\d{8}$/.test(shopId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "無法取得 8 位店舖編號（請確認 Ledger merchants.phone 或 POS 登入帳號為 8 位數字）。",
      },
      { status: 400 },
    );
  }

  const shopName = merchant?.name?.trim() || shopId;
  const embedUrl = buildTopupOwnerEmbedUrl({ shopId, shopName });

  return NextResponse.json({
    ok: true,
    embedUrl,
    topupBaseUrl: getTopupBaseUrl(),
    shopId,
    shopName,
  });
}
