const LEDGER_AUTH_EMAIL_SUFFIX = "@phone.macau-ledger.app";

/** Normalize Macau phone to 8 digits (strip non-digits). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-8);
}

export function isValidMacauPhone(phone: string): boolean {
  return /^\d{8}$/.test(normalizePhone(phone));
}

export function ledgerAuthEmail(phone: string): string {
  return `${normalizePhone(phone)}${LEDGER_AUTH_EMAIL_SUFFIX}`;
}

/** 從 Ledger Auth email 還原 8 位登入電話。 */
export function parsePhoneFromLedgerAuthEmail(email: string): string {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized.endsWith(LEDGER_AUTH_EMAIL_SUFFIX)) return "";
  return normalizePhone(normalized.slice(0, -LEDGER_AUTH_EMAIL_SUFFIX.length));
}
