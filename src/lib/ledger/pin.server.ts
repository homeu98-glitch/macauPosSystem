import "server-only";

import { createHmac } from "crypto";

import { normalizePhone } from "@/lib/ledger/phone";

/** HMAC-SHA256 PIN → Supabase Auth password (matches Ledger Web / Android). */
export function deriveLedgerAuthPassword(phone: string, pin: string, pepper: string): string {
  const message = `${normalizePhone(phone)}:${pin}`;
  return createHmac("sha256", pepper).update(message).digest("hex");
}
