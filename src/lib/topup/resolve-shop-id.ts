import { isValidMacauPhone, normalizePhone } from "@/lib/ledger/phone";

/** topUp / Ledger 對外的 8 位店舖編號（非店員登入帳號）。 */
export function normalizeTopupShopId(value: string | null | undefined): string {
  return normalizePhone(String(value ?? ""));
}

/**
 * 充值 SSO 須用 Ledger 商戶主檔電話（merchants.phone），
 * 店員 POS 登入號（merchant_staff 帳號）可能與店舖編號不同。
 */
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
