/**
 * 《雲端登入（Ledger 會話）已失效》旗標 —— client 側模組 store（2026-11-03）。
 *
 * ## 為何要有（實案，唔係假設）
 *
 * 收銀機係 24 小時開住嘅。Ledger access token 一個鐘就過期，靠 refresh token 續；
 * 一旦 refresh 都死（過夜、換密碼、被撤銷），舊版程式**完全靜默**：
 *
 * · `/api/pos/device-token` 每 30 秒回 503「無法驗證商戶身份」⇒ client 當成臨時故障一直重試；
 * · 收銀員照樣落單，但全部堆喺本機 outbox，永遠上唔到雲（報表／交班／線上單全部斷）；
 * · 冇任何一句提示 ⇒ 唯一「症狀」係報告數字唔對，通常幾日後才發現。
 *
 * 實測代價：一部機一日 2,880 次失敗請求，幾部機一齊燒 Vercel Function Invocations；
 * 而且嗰朝 Vercel log 全部係 `JWT expired`，真正問題被噪音蓋住。
 *
 * ## 設計（同 `session-revoked.ts` 一致）
 *
 * · **零 import** —— `npm test` 係 `node --test`，唔行 bundler、唔認 `@/` 別名；
 * · 純記憶、唔讀 storage、唔做網絡請求；
 * · 訂閱用 `subscribe + getSnapshot`（React 側配 `useState` 或 `useSyncExternalStore` 都得）；
 * · **唔自動 reload / 唔自動清 session** —— 收銀結帳中途重載係災難，只提示 + 交人手撳。
 *
 * 注意：呢個 store 只代表「**雲端身分**失效」；本機落單能力仍然正常（offline-first），
 * 所以文案一定要講清楚「本機照開單、只係上唔到雲」，唔可以嚇到收銀員唔敢做生意。
 */

let expired = false;
let reason: string | null = null;
let at: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 標記「雲端登入已失效」。重複呼叫係便宜的（同值唔會通知訂閱者）。 */
export function markPosAuthExpired(nextReason: string): void {
  const normalized = nextReason.trim() || "session-expired";
  if (expired && reason === normalized) return;
  expired = true;
  reason = normalized;
  at = new Date().toISOString();
  emit();
}

/** 清走旗標（重新登入成功／續期成功）。 */
export function clearPosAuthExpired(): void {
  if (!expired) return;
  expired = false;
  reason = null;
  at = null;
  emit();
}

export function isPosAuthExpired(): boolean {
  return expired;
}

export function getPosAuthExpiredReason(): string | null {
  return reason;
}

/** 幾時開始失效（ISO）。純診斷用：收銀員報「幾點開始唔對數」時對得上。 */
export function getPosAuthExpiredAt(): string | null {
  return at;
}

export function subscribePosAuthExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
