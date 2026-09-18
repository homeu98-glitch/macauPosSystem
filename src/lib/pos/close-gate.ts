/**
 * 「關店總掣」—— 交班時**一次過**關閉本店全部接單通路（2026-09-18）。
 *
 * ── 點解需要呢個模組 ─────────────────────────────────────────────────────
 * 交班（`closeShift()`）以前**完全唔碰**任何接單開關：班次收咗，但
 * 掃碼／kiosk（`pos_store_status.is_open`）同線上（Ledger `merchant_enabled`）
 * 照樣開住 → 客人仍然落得到單（J 2026-09-18 回報）。
 *
 * ── 三條獨立軌道（唔可以當佢哋係一件事）──────────────────────────────────
 * | 軌道 | 真源 | 擋邊個 |
 * |---|---|---|
 * | 班次 | `pos_shifts` | 收銀台自己（`ensureShiftOpened()`） |
 * | 線下接單 | POS DB `pos_store_status.is_open` | 掃碼 `/menu` `/quick`、kiosk `/order` |
 * | 線上接單 | Ledger `merchants.merchant_enabled` | 會員通線上落單 |
 *
 * ── 執行紀律 ─────────────────────────────────────────────────────────────
 * 1. **序列，唔並行**：先線下後線上。線下係「店門口」嗰道閘，佢失敗嘅話
 *    線上關咗只會更差（客人落得到單但你唔知）——所以次序有意義，唔係求其。
 * 2. **線下成功 + 線上失敗 → 保留線下已關**（J 2026-09-18 拍板）。唔回滾：
 *    回滾等於「因為線上關唔到，所以連線下都開返」＝店門大開，更差。
 * 3. **唔 throw**：交班流程唔應該因為關店出問題而中斷。所有失敗經
 *    `CloseGateResult` 回報，由 UI 決定點講。
 * 4. **`null`（未讀到）＝ `skipped`，唔算失敗**：本來就冇值可以關，寫落去
 *    反而會樂觀製造一個假狀態（同兩個 hook 嘅紀律一致）。
 *
 * ── ⚠️ 本模組**刻意零 import**（2026-09-18）────────────────────────────
 * 專案嘅 `npm test` ＝ `node --test`，**唔行 bundler、唔認 `@/` 別名**。
 * 所以可測模組一律唔准 import 任何嘢（現有 `store-status.ts`、
 * `date-range.ts` 等全部係咁樣）。
 *
 * 需要真正執行（要 call `applyStoreOpen` / `applyMerchantEnabled`）嘅部分
 * 拆去 `close-gate-run.ts`，呢個檔只留純決策 + 文案。
 */

/** 單一通道嘅結果。 */
export type CloseGateChannelResult =
  /** 已成功寫入關閉。 */
  | "closed"
  /** 嘗試寫入但失敗（網絡 / 憑證 / RPC 拒絕）。 */
  | "failed"
  /** 本來就唔需要關（已是關／未讀到／未登入）——**唔算失敗**。 */
  | "skipped";

export type CloseGateResult = {
  /** 線下（掃碼 + kiosk）＝ `pos_store_status.is_open`。 */
  store: CloseGateChannelResult;
  /** 線上（會員通）＝ Ledger `merchants.merchant_enabled`。 */
  online: CloseGateChannelResult;
};

/**
 * 逐格判斷 `closeShift()` 應該為「線下」做啲乜。
 *
 * 抽成純函式嘅原因：`isOpen` 係 `boolean | null`，三個值嘅處理都唔同，
 * 而且「`null` 唔等於 `false`」呢條紀律極易寫錯（寫錯就係「未讀到當已關」
 * 或者「未讀到走去寫 RPC」）。純函式好測，唔使開 Supabase。
 *
 * | `isOpen` | 動作 | 原因 |
 * |---|---|---|
 * | `false` | skip | 已經關咗，唔好囉嗦 |
 * | `true` | close | 真正要關嘅情況 |
 * | `null` | skip | 未讀到 → 唔准樂觀寫（會出假狀態） |
 */
export function decideStoreClose(isOpen: boolean | null): "close" | "skip" {
  return isOpen === true ? "close" : "skip";
}

/**
 * 逐格判斷 `closeShift()` 應該為「線上」做啲乜。
 *
 * | `merchantEnabled` | 動作 | 原因 |
 * |---|---|---|
 * | `false` | skip | 已經關咗 |
 * | `true` | close | 真正要關嘅情況 |
 * | `null` | skip | 未讀到 → Ledger 唔可以樂觀寫（`applyMerchantEnabled` 會直接拒絕） |
 */
export function decideOnlineClose(merchantEnabled: boolean | null): "close" | "skip" {
  return merchantEnabled === true ? "close" : "skip";
}

/**
 * 由「動作 → 執行結果」砌出最終 `CloseGateResult`（純函式，方便測）。
 *
 * @param store 線下：`skip` ／ 實際執行結果
 * @param online 線上：`skip` ／ 實際執行結果
 */
export function buildCloseGateResult(
  store: CloseGateChannelResult,
  online: CloseGateChannelResult,
): CloseGateResult {
  return { store, online };
}

/** 全成功（或無需動作）＝ 唔使喺狀態列加任何警告。 */
export function isCloseGateClean(result: CloseGateResult): boolean {
  return result.store !== "failed" && result.online !== "failed";
}

/**
 * 全部通道都冇關到（而且唔係「本來就關咗」）→ 最嚴重，UI 應該用紅色。 */
export function isCloseGateTotalFailure(result: CloseGateResult): boolean {
  return result.store === "failed" && result.online === "failed";
}

/**
 * 砌交班狀態列嗰段「關店結果」附註。
 *
 * @returns 冇任何失敗 → `""`（呼叫端唔使加括號）；有失敗 → 一段以「）」收尾嘅中文附註。
 *
 * ── 文案紀律 ─────────────────────────────────────────────────────────────
 * 一定要**同時講清楚兩件事**：
 * ① 邊條通道未關到（唔可以只講「部分失敗」——收銀要知道而家仲有咩開住）；
 * ② 去邊度補救（側欄商店名卡）。
 * 只講「失敗」而唔講後果，收銀會以為只係一個無關痛癢嘅提示。
 */
export function describeCloseGate(result: CloseGateResult): string {
  const parts: string[] = [];

  if (result.store === "failed") {
    parts.push("⚠️ 店內接單（掃碼／自助機）未能關閉");
  }
  if (result.online === "failed") {
    parts.push("⚠️ 線上接單未能暫停");
  }

  if (parts.length === 0) return "";

  const recovery =
    result.store === "failed" && result.online === "failed"
      ? "請到側欄商店名卡手動關閉。"
      : "請到側欄商店名卡手動處理未關嘅通道。";

  return `（${parts.join("；")}，${recovery}）`;
}
