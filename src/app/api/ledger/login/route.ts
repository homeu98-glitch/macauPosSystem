import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { deriveLedgerAuthPassword } from "@/lib/ledger/pin.server";
import { isValidMacauPhone, ledgerAuthEmail, normalizePhone } from "@/lib/ledger/phone";
import { fetchTopupShopId } from "@/lib/topup/fetch-shop-id.server";
import { ensureExpenseShopUser } from "@/lib/expense-identity";

type LoginAttemptBucket = { count: number; resetAt: number };

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, LoginAttemptBucket>();

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

function resolveSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const pepper = process.env.AUTH_PIN_PEPPER;
  return { url, anonKey, pepper };
}

/** Ledger merchant_staff.staff_role is `owner` | `staff` — there is NO `role` column (§4.3). */
function mapLedgerStaffRole(staffRole: string | null | undefined): "admin" | "manager" | "cashier" {
  if (String(staffRole ?? "").toLowerCase() === "owner") return "admin";
  return "cashier";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ ok: false, error: "登入嘗試過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json()) as { account?: string; pin?: string; phone?: string };
  const phone = normalizePhone(payload.phone ?? payload.account ?? "");
  const pin = String(payload.pin ?? "").trim();

  if (!isValidMacauPhone(phone)) {
    return NextResponse.json({ ok: false, error: "請輸入 8 位數字帳號。" }, { status: 400 });
  }
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ ok: false, error: "請輸入 4 位數字 PIN。" }, { status: 400 });
  }

  const { url, anonKey, pepper } = resolveSupabaseConfig();
  if (!url || !anonKey) {
    return NextResponse.json({ ok: false, error: "Ledger Supabase 環境變數未設定。" }, { status: 503 });
  }
  if (!pepper) {
    return NextResponse.json(
      { ok: false, error: "伺服器尚未設定 AUTH_PIN_PEPPER，請聯絡管理員完成 Ledger 登入對接。" },
      { status: 503 },
    );
  }

  const password = deriveLedgerAuthPassword(phone, pin, pepper);
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: ledgerAuthEmail(phone),
    password,
  });

  if (authError || !authData.session || !authData.user) {
    return NextResponse.json({ ok: false, error: "帳號或 PIN 不正確。" }, { status: 401 });
  }

  await supabase.auth.setSession({
    access_token: authData.session.access_token,
    refresh_token: authData.session.refresh_token,
  });

  // §4.3: merchant_staff.staff_role — NOT `role`. Wrong column → PostgREST 42703 / 503.
  const { data: staffRows, error: staffError } = await supabase
    .from("merchant_staff")
    .select("merchant_id, staff_role")
    .eq("user_id", authData.user.id)
    .limit(1);

  if (staffError) {
    return NextResponse.json(
      { ok: false, error: "無法讀取商戶員工資料，請稍後再試或聯絡管理員。", detail: staffError.message },
      { status: 503 },
    );
  }

  const staffRow = staffRows?.[0];
  if (!staffRow?.merchant_id) {
    // §4.3 / §4.4: non-staff — clear this POS login attempt only (scope local).
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.json({ ok: false, error: "非本店 Ledger 帳號，無法登入 POS。" }, { status: 403 });
  }

  const { data: merchantRows, error: merchantError } = await supabase
    .from("merchants")
    .select("status, name")
    .eq("id", staffRow.merchant_id)
    .limit(1);

  if (merchantError) {
    return NextResponse.json(
      { ok: false, error: "無法讀取商戶資料，請稍後再試或聯絡管理員。", detail: merchantError.message },
      { status: 503 },
    );
  }

  const merchant = merchantRows?.[0] as { status?: string; name?: string } | undefined;
  const merchantStatus = String(merchant?.status ?? "").toLowerCase();
  if (merchantStatus === "suspended") {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.json({ ok: false, error: "商戶已停用，請聯絡管理員。" }, { status: 403 });
  }
  if (merchantStatus && merchantStatus !== "active" && merchantStatus !== "pending") {
    await supabase.auth.signOut({ scope: "local" });
    return NextResponse.json({ ok: false, error: "商戶狀態異常，暫時無法登入。" }, { status: 403 });
  }

  const role = mapLedgerStaffRole(staffRow.staff_role as string | undefined);
  const { shopId: topUpShopId } = await fetchTopupShopId(supabase, {
    merchantId: staffRow.merchant_id,
    staffRole: staffRow.staff_role as string | undefined,
    userEmail: authData.user.email,
    staffAccount: phone,
  });
  const permissions =
    role === "admin"
      ? { refundOrder: true, voidItem: true, manageAccounts: true }
      : { refundOrder: false, voidItem: false, manageAccounts: false };

  // 整合：登入當下建立/刷新 expenseRecorder 專案的 shop_users 對應（§5.3）。
  // 失敗不阻斷登入——inventory 分頁會降級顯示「未連線」。
  try {
    const mapped = await ensureExpenseShopUser({
      merchantId: staffRow.merchant_id,
      phone,
      shopName: merchant?.name,
    });
    if (!mapped.ok) {
      console.warn("[inventory] 身份對應失敗（不阻斷登入）:", mapped.reason);
    }
  } catch (mapErr) {
    console.warn(
      "[inventory] 身份對應例外（不阻斷登入）:",
      mapErr instanceof Error ? mapErr.message : mapErr,
    );
  }

  return NextResponse.json({
    ok: true,
    source: "ledger",
    session: {
      account: phone,
      name: merchant?.name ?? `店員 ${phone.slice(-4)}`,
      role,
      merchantId: staffRow.merchant_id,
      topUpShopId: topUpShopId || undefined,
      storeIds: [staffRow.merchant_id],
      permissions,
      loggedInAt: new Date().toISOString(),
      ledgerAccessToken: authData.session.access_token,
      ledgerRefreshToken: authData.session.refresh_token,
    },
    accessToken: authData.session.access_token,
    refreshToken: authData.session.refresh_token,
  });
}
