/** Normalize Macau phone to 8 digits (strip non-digits). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-8);
}

export function isValidMacauPhone(phone: string): boolean {
  return /^\d{8}$/.test(normalizePhone(phone));
}

export function ledgerAuthEmail(phone: string): string {
  return `${normalizePhone(phone)}@phone.macau-ledger.app`;
}
