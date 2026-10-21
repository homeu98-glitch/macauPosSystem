/**
 * Admin 帳號「失敗鎖定」純函數（2026-10-21 · 多店控制台 P0-2）。
 *
 * ## 為何需要（D2 拍板：PIN 沿用 4 位）
 *
 * 4 位 PIN = 10⁴ 組合，而帳號係 8 位數字（澳門電話格式，**公開可枚舉**）。
 * 即係：知道 / 猜到一個電話號碼，理論上 10,000 次就可以撞開一個管理帳號。
 * 只靠 IP rate limit **唔夠** —— 換 IP（流動網絡、代理）即繞過。
 *
 * ⇒ 必須有 **per-account** 鎖定，而且狀態要**落 DB**（Vercel 多 instance，
 *   放記憶體等於每個 instance 各自計數，實際可試次數 × instance 數）。
 *
 * ## 設計取捨
 *
 * - 5 次失敗 → 鎖 15 分鐘。期間**唔會**再驗 PIN（連正確 PIN 都拒），避免「鎖定期間繼續爆破」。
 * - 鎖定過期後**重新計數**（唔會累積到永久鎖死）—— 避免支援電話暴增。
 * - 成功登入清零。
 * - 純函數、無 I/O：方便 `node --test` 直接測臨界值（4→5、鎖定邊界、過期重置）。
 */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60 * 1000;

export type LockoutState = {
  /** 連續失敗次數（成功登入或鎖定過期後歸零） */
  failedLoginCount: number;
  /** 鎖定到期時間（epoch ms）；`null` = 未鎖 */
  lockedUntilMs: number | null;
};

export const INITIAL_LOCKOUT: LockoutState = { failedLoginCount: 0, lockedUntilMs: null };

/** 由 DB row 的兩個欄位還原 state（欄位未加 / null 一律當「未鎖、0 次」）。 */
export function lockoutFromRow(row: {
  failed_login_count?: unknown;
  locked_until?: unknown;
}): LockoutState {
  const rawCount = Number(row.failed_login_count ?? 0);
  const failedLoginCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;

  let lockedUntilMs: number | null = null;
  const rawLocked = row.locked_until;
  if (typeof rawLocked === "string" && rawLocked) {
    const ms = Date.parse(rawLocked);
    lockedUntilMs = Number.isFinite(ms) ? ms : null;
  } else if (rawLocked instanceof Date) {
    const ms = rawLocked.getTime();
    lockedUntilMs = Number.isFinite(ms) ? ms : null;
  }

  return { failedLoginCount, lockedUntilMs };
}

/** 而家係咪鎖緊？（`lockedUntilMs` 已過 = 唔鎖） */
export function isLocked(state: LockoutState, nowMs: number): boolean {
  return state.lockedUntilMs !== null && state.lockedUntilMs > nowMs;
}

/** 仲要等幾秒（唔鎖 = 0）。用嚟砌 `Retry-After`。 */
export function lockRemainingSec(state: LockoutState, nowMs: number): number {
  if (!isLocked(state, nowMs)) return 0;
  return Math.max(1, Math.ceil(((state.lockedUntilMs as number) - nowMs) / 1000));
}

/**
 * 記一次失敗。
 *
 * ⚠️ 如果之前鎖過而且**已經過期**，先重新計數（當呢次係新一輪的第 1 次），
 *    唔可以喺舊 count 上繼續加 —— 否則一次失誤就會即刻再鎖，等同永久鎖死。
 */
export function onFailure(state: LockoutState, nowMs: number): LockoutState {
  const expired = state.lockedUntilMs !== null && state.lockedUntilMs <= nowMs;
  const base = expired ? 0 : state.failedLoginCount;
  const failedLoginCount = base + 1;

  if (failedLoginCount >= MAX_FAILED_ATTEMPTS) {
    return { failedLoginCount: MAX_FAILED_ATTEMPTS, lockedUntilMs: nowMs + LOCK_MS };
  }
  return { failedLoginCount, lockedUntilMs: null };
}

/** 登入成功：清零。 */
export function onSuccess(): LockoutState {
  return { ...INITIAL_LOCKOUT };
}

/** 需要寫返 DB 嘅欄位（DB 欄位名用 snake_case，同 migration 0068 一致）。 */
export function lockoutToRow(state: LockoutState): {
  failed_login_count: number;
  locked_until: string | null;
} {
  return {
    failed_login_count: state.failedLoginCount,
    locked_until: state.lockedUntilMs === null ? null : new Date(state.lockedUntilMs).toISOString(),
  };
}
