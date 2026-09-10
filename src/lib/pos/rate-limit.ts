/**
 * POS 端點嘅輕量 rate limit（in-memory，per server instance）。
 *
 * 2026-09-10 掃碼點餐審查 P0-3 / P3-5：匿名通道（掃碼落單、單號、查找訂單）
 * 冇任何限流 —— 知道 storeId 就可以無限次呼叫。
 *
 * ⚠️ 限制：呢個係 per-instance 嘅計數器（Vercel serverless 會有多個 instance），
 * 只係「拉高攻擊成本」嘅第一道閘，唔係精確配額。要做真限流要上 Redis / Upstash；
 * 喺引入之前，呢個已經足夠擋走「隨手寫個 script 打爆」嘅情況。
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** 避免 map 無限增長：每次呼叫順手清走已過期嘅 bucket（O(n) 但 n 有界）。 */
const MAX_BUCKETS = 5000;

function sweep(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

/**
 * @returns `true` = 放行；`false` = 超限（呼叫端應回 429）。
 */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** 由 Request 抽 client IP（Vercel 會設 x-forwarded-for）。 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
