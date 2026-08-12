import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import { deriveLedgerAuthPassword } from "@/lib/ledger/pin.server";
import { isValidMacauPhone, ledgerAuthEmail, normalizePhone } from "@/lib/ledger/phone";

type LoginAttemptBucket = { count: number; resetAt: number };

type StaffLookup = {
  merchantId: string;
  role: string | null;
};

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

function mapStaffRole(rawRole: string | null | undefined): "admin" | "manager" | "cashier" {
  const role = String(rawRole ?? "").toLowerCase();
  if (role.includes("admin") || role.includes("owner")) return "admin";
  if (role.includes("manager")) return "manager";
  return "cashier";
}

/** Use .limit(1) — NOT maybeSingle() (PGRST116 when user has >1 staff row). */
async function lookupMerchantStaff(
  client: SupabaseClient,
  userId: string,
): Promise<{ staff: StaffLookup | null; error: string | null }> {
  const withRole = await client
    .from("merchant_staff")
    .select("merchant_id, role")
    .eq("user_id", userId)
    .limit(1);

  if (!withRole.error && withRole.data?.[0]?.merchant_id) {
    return {
      staff: {
        merchantId: String(withRole.data[0].merchant_id),
        role: (withRole.data[0].role as string | null) ?? null,
      },
      error: null,
    };
  }

  // role column may not exist on older Ledger schemas
  const idOnly = await client.from("merchant_staff").select("merchant_id").eq("user_id", userId).limit(1);

  if (!idOnly.error && idOnly.data?.[0]?.merchant_id) {
    return { staff: { merchantId: String(idOnly.data[0].merchant_id), role: null }, error: null };
  }

  const err = withRole.error ?? idOnly.error;
  return { staff: null, error: err?.message ?? null };
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

  const { staff, error: staffLookupError } = await lookupMerchantStaff(supabase, authData.user.id);

  if (staffLookupError) {
    await supabase.auth.signOut();
    return NextResponse.json(
      {
        ok: false,
        error: "無法讀取商戶員工資料，請稍後再試或聯絡管理員。",
        detail: staffLookupError,
      },
      { status: 503 },
    );
  }

  if (!staff?.merchantId) {
    await supabase.auth.signOut();
    return NextResponse.json({ ok: false, error: "非本店 Ledger 帳號，無法登入 POS。" }, { status: 403 });
  }

  const { data: merchantRows } = await supabase
    .from("merchants")
    .select("status, name")
    .eq("id", staff.merchantId)
    .limit(1);

  const merchant = (merchantRows?.[0] ?? null) as { status?: string; name?: string } | null;
  const merchantStatus = String(merchant?.status ?? "").toLowerCase();
  if (merchantStatus === "suspended") {
    await supabase.auth.signOut();
    return NextResponse.json({ ok: false, error: "商戶已停用，請聯絡管理員。" }, { status: 403 });
  }
  if (merchantStatus && merchantStatus !== "active" && merchantStatus !== "pending") {
    await supabase.auth.signOut();
    return NextResponse.json({ ok: false, error: "商戶狀態異常，暫時無法登入。" }, { status: 403 });
  }

  const role = mapStaffRole(staff.role);
  const permissions =
    role === "admin"
      ? { refundOrder: true, voidItem: true, manageAccounts: true }
      : role === "manager"
        ? { refundOrder: true, voidItem: true, manageAccounts: false }
        : { refundOrder: false, voidItem: false, manageAccounts: false };

  return NextResponse.json({
    ok: true,
    source: "ledger",
    session: {
      account: phone,
      name: merchant?.name ?? `店員 ${phone.slice(-4)}`,
      role,
      merchantId: staff.merchantId,
      storeIds: [staff.merchantId],
      permissions,
      loggedInAt: new Date().toISOString(),
      ledgerAccessToken: authData.session.access_token,
      ledgerRefreshToken: authData.session.refresh_token,
    },
    accessToken: authData.session.access_token,
    refreshToken: authData.session.refresh_token,
  });
}
