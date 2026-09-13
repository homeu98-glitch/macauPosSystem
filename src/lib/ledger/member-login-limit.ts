/**
 * 顧客會員登入限流（in-memory，per server instance）。
 *
 * 契約 §4.5.2 明文建議：「POS 後端應對同 IP／同電話做失敗限流
 * （**建議 15 分鐘 5 次鎖 15 分鐘**）」。呢個模組就係嗰條規則嘅唯一實作。
 *
 * 同 `src/lib/pos/rate-limit.ts`（純計數、`boolean`）嘅分別：
 *   會員登入 UI 要顯示「**剩餘 3 次機會**」同「**請於 14:37 後再試**」，
 *   所以呢度要回狀態（剩餘次數 / 解鎖時間），唔止係放行 / 唔放行。
 *
 * ⚠️ 同 `rate-limit.ts` 一樣係 per-instance：Vercel serverless 多 instance 時
 * 實際窗口會鬆啲。呢個係「拉高攻擊成本」嘅第一道閘，唔係精確配額；
 * 要精確要上 Redis。喺引入之前，呢個已足夠擋走隨手寫 script 撞 PIN。
 *
 * ⚠️ **只計「憑證錯」**：網絡 / 上游故障唔應該消耗客人嘅嘗試次數
 *（否則 Ledger 打嗝一次就鎖死全店客人）。
 */

type Bucket = {
  /** 窗口內累積嘅失敗次數。 */
  failures: number;
  /** 本窗口第一次失敗嘅時間（窗口起點）。 */
  windowStartedAt: number;
  /** 已鎖則為解鎖時間戳；未鎖 = 0。 */
  lockedUntil: number;
};

export type MemberLoginLimitState = {
  /** `false` = 已鎖，呼叫端應回 429 並顯示鎖定訊息。 */
  allowed: boolean;
  /** 剩餘可嘗試次數（已鎖時為 0）。 */
  remaining: number;
  /** 距離解鎖秒數（未鎖時為 0）。 */
  retryAfterSec: number;
};

export type MemberLoginLimiterOptions = {
  /** 窗口內允許嘅失敗次數。預設 5（契約建議）。 */
  maxAttempts?: number;
  /** 失敗計數窗口。預設 15 分鐘（契約建議）。 */
  windowMs?: number;
  /** 達上限後鎖幾耐。預設 15 分鐘（契約建議）。 */
  lockMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_LOCK_MS = 15 * 60_000;

/** 避免 map 無限增長：超過上限就掃走已完全過期嘅 bucket。 */
const MAX_BUCKETS = 5000;

export function createMemberLoginLimiter(options: MemberLoginLimiterOptions = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;

  const buckets = new Map<string, Bucket>();

  function sweep(now: number) {
    if (buckets.size < MAX_BUCKETS) return;
    for (const [key, bucket] of buckets) {
      const expired = now >= bucket.lockedUntil && now - bucket.windowStartedAt >= windowMs;
      if (expired) buckets.delete(key);
    }
  }

  /** 已鎖 → 回鎖定狀態；否則按窗口內剩餘次數回狀態。 */
  function check(key: string, now = Date.now()): MemberLoginLimitState {
    const bucket = buckets.get(key);
    if (!bucket) {
      return { allowed: true, remaining: maxAttempts, retryAfterSec: 0 };
    }
    if (bucket.lockedUntil) {
      if (now < bucket.lockedUntil) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
        };
      }
      // 鎖已過 → 當**全新窗口**。
      // 🔴 唔可以沿用舊 `failures`：若 `lockMs < windowMs`（或鎖後窗口仍未過），
      //    舊計數會令客人「解鎖後第一次失敗即刻再鎖」= 實際上永遠解唔開。
      //    鎖定本身已經係懲罰，唔應該再累加。
      return { allowed: true, remaining: maxAttempts, retryAfterSec: 0 };
    }
    if (now - bucket.windowStartedAt >= windowMs) {
      return { allowed: true, remaining: maxAttempts, retryAfterSec: 0 };
    }
    return {
      allowed: true,
      remaining: Math.max(0, maxAttempts - bucket.failures),
      retryAfterSec: 0,
    };
  }

  /**
   * 記一次**憑證失敗**（`bad_credential` 專用）。
   * @returns 記帳之後嘅狀態（呼叫端直接攞去砌回應，唔使再 check）。
   */
  function recordFailure(key: string, now = Date.now()): MemberLoginLimitState {
    sweep(now);
    const bucket = buckets.get(key);
    // 同 `check()` 保持同一口徑：新 key / 窗口過 / **鎖已過** 三者都算「新鮮」。
    const fresh =
      !bucket ||
      now - bucket.windowStartedAt >= windowMs ||
      (bucket.lockedUntil > 0 && now >= bucket.lockedUntil);
    const next: Bucket = fresh
      ? { failures: 0, windowStartedAt: now, lockedUntil: 0 }
      : { ...bucket };

    next.failures += 1;
    if (next.failures >= maxAttempts) {
      next.lockedUntil = now + lockMs;
    }
    buckets.set(key, next);
    return check(key, now);
  }

  /** 登入成功時清除（失敗紀錄唔應該跨成功保留）。 */
  function clear(key: string) {
    buckets.delete(key);
  }

  return { check, recordFailure, clear };
}

/**
 * 全 process 共用嘅單例 —— route 一定要用呢個，唔好自己 `createMemberLoginLimiter()`
 * （每個 request 開一個新 limiter = 完全冇限流，而且唔會報錯，只會靜靜失效）。
 */
export const memberLoginLimiter = createMemberLoginLimiter();
