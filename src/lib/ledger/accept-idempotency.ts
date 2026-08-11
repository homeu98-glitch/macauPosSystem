/** In-memory idempotency keys for accept_order_with_deduct — reuse on retry, one key per order accept attempt. */
const acceptKeys = new Map<string, string>();
const acceptInFlight = new Set<string>();

export function getAcceptIdempotencyKey(orderId: string): string {
  const existing = acceptKeys.get(orderId);
  if (existing) return existing;
  const key = crypto.randomUUID();
  acceptKeys.set(orderId, key);
  return key;
}

export function clearAcceptIdempotencyKey(orderId: string): void {
  acceptKeys.delete(orderId);
}

export function beginAcceptInFlight(orderId: string): boolean {
  if (acceptInFlight.has(orderId)) return false;
  acceptInFlight.add(orderId);
  return true;
}

export function endAcceptInFlight(orderId: string): void {
  acceptInFlight.delete(orderId);
  clearAcceptIdempotencyKey(orderId);
}
