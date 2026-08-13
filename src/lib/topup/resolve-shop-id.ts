import { isValidMacauPhone, normalizePhone } from "@/lib/ledger/phone";

/** topUp / Ledger 對外的 8 位店舖編號（非店員登入帳號）。 */
export function normalizeTopupShopId(value: string | null | undefined): string {
  return normalizePhone(String(value ?? ""));
}

/** @deprecated 請改用 fetchTopupShopId（server）以解析店主電話。 */
export function resolveTopupShopId(params: {
  merchantPhone?: string | null;
  staffAccount?: string | null;
}): string {
  const merchantPhone = normalizeTopupShopId(params.merchantPhone);
  if (isValidMacauPhone(merchantPhone)) return merchantPhone;

  const staffAccount = normalizeTopupShopId(params.staffAccount);
  if (isValidMacauPhone(staffAccount)) return staffAccount;

  return "";
}
