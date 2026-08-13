import type { SupabaseClient } from "@supabase/supabase-js";

import { isValidMacauPhone, parsePhoneFromLedgerAuthEmail } from "@/lib/ledger/phone";
import { normalizeTopupShopId } from "@/lib/topup/resolve-shop-id";

function readTopupShopIdOverrides(): Record<string, string> {
  const raw = process.env.TOPUP_SHOP_ID_OVERRIDES?.trim();
  if (!raw) return {};
  try {
    return (JSON.parse(raw) as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

function readTopupShopIdOverride(merchantId: string): string {
  const value = normalizeTopupShopId(readTopupShopIdOverrides()[merchantId]);
  return isValidMacauPhone(value) ? value : "";
}

async function fetchOwnerPhoneFromProfiles(
  supabase: SupabaseClient,
  merchantId: string,
): Promise<string> {
  const { data: ownerRows, error: ownerError } = await supabase
    .from("merchant_staff")
    .select("user_id")
    .eq("merchant_id", merchantId)
    .eq("staff_role", "owner")
    .limit(1);

  if (ownerError || !ownerRows?.[0]?.user_id) return "";

  const ownerUserId = ownerRows[0].user_id as string;

  for (const column of ["email", "phone"] as const) {
    const { data, error } = await supabase.from("profiles").select(column).eq("id", ownerUserId).limit(1);

    if (error?.message?.includes("does not exist")) continue;
    if (error || !data?.[0]) continue;

    const row = data[0] as Record<string, string | undefined>;
    const candidate =
      column === "email"
        ? parsePhoneFromLedgerAuthEmail(row.email ?? "")
        : normalizeTopupShopId(row[column]);
    if (isValidMacauPhone(candidate)) return candidate;
  }

  return "";
}

/** 解析 topUp SSO 用的 8 位店舖編號（優先店主，其次 env 覆寫，最後才用店員登入號）。 */
export async function fetchTopupShopId(
  supabase: SupabaseClient,
  params: {
    merchantId: string;
    staffRole?: string | null;
    userEmail?: string | null;
    staffAccount?: string | null;
  },
): Promise<{ shopId: string; source: string }> {
  const sessionPhone =
    parsePhoneFromLedgerAuthEmail(params.userEmail ?? "") || normalizeTopupShopId(params.staffAccount);

  if (String(params.staffRole ?? "").toLowerCase() === "owner" && isValidMacauPhone(sessionPhone)) {
    return { shopId: sessionPhone, source: "owner_session" };
  }

  const override = readTopupShopIdOverride(params.merchantId);
  if (override) return { shopId: override, source: "env_override" };

  const ownerPhone = await fetchOwnerPhoneFromProfiles(supabase, params.merchantId);
  if (ownerPhone) return { shopId: ownerPhone, source: "owner_profile" };

  if (isValidMacauPhone(sessionPhone)) {
    return { shopId: sessionPhone, source: "staff_session" };
  }

  return { shopId: "", source: "none" };
}
