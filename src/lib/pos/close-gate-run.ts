/**
 * 「關店總掣」嘅**執行層**（2026-09-18）—— 非 React 呼叫端專用。
 *
 * ── 點解同 `close-gate.ts` 分開 ─────────────────────────────────────────
 * `npm test` ＝ `node --test`（詳見 `close-gate.ts` 頂部註釋）：
 * 純決策模組**零 import** 先測得到。呢個檔要 import 兩個 hook 模組
 * （`applyStoreOpen` / `applyMerchantEnabled`），所以一定要分開，
 * 唔可以污染 `close-gate.ts` 嘅「零依賴」性質。
 *
 * ── 呼叫前必須已經讀到值 ─────────────────────────────────────────────────
 * `storeOpen` / `merchantEnabled` 由呼叫端**喺交班流程開始時**讀落嚟傳入
 * （呼叫端有掛 hook，所以讀得到）。呢個函式唔會自己去讀 —— 佢唔應該
 * 喺關店路徑上多打兩次 GET，亦唔認識 Realtime。
 *
 * ── 執行紀律 ─────────────────────────────────────────────────────────────
 * - **序列，唔並行**：先線下後線上（線下係店門口嗰道閘，次序有意義）。
 * - **中途失敗繼續行落去**：唔可以線下失敗就 `return`，否則「線下關唔到」
 *   會連帶令線上永遠關唔到（兩條軌道獨立故障）。
 * - **永遠唔 throw**：交班流程唔應該因為關店出問題而中斷。
 */

import {
  buildCloseGateResult,
  decideOnlineClose,
  decideStoreClose,
  type CloseGateChannelResult,
  type CloseGateResult,
} from "@/lib/pos/close-gate";
import { applyMerchantEnabled } from "@/lib/pos/use-merchant-order-config";
import { applyStoreOpen } from "@/lib/pos/use-store-status";

/**
 * 執行「關店總掣」：線下（掃碼 + kiosk）→ 線上（會員通）。
 *
 * @returns 兩個通道各自嘅結果；**永遠唔 throw**。
 */
export async function runCloseGate(params: {
  storeOpen: boolean | null;
  merchantEnabled: boolean | null;
}): Promise<CloseGateResult> {
  let store: CloseGateChannelResult = "skipped";
  let online: CloseGateChannelResult = "skipped";

  // ① 線下：掃碼 + kiosk（POS DB `pos_store_status.is_open`）
  if (decideStoreClose(params.storeOpen) === "close") {
    try {
      store = (await applyStoreOpen(false)) ? "closed" : "failed";
    } catch {
      // applyStoreOpen 內部已 rollback + set error；呢度只係守住「唔可以 throw」
      store = "failed";
    }
  }

  // ② 線上：會員通（Ledger `merchant_enabled`）
  // ⚠️ 就算 ① 失敗都要照做 —— 兩條軌道獨立，唔可以因為線下關唔到就放生線上。
  if (decideOnlineClose(params.merchantEnabled) === "close") {
    try {
      online = (await applyMerchantEnabled(false)) ? "closed" : "failed";
    } catch {
      online = "failed";
    }
  }

  return buildCloseGateResult(store, online);
}
