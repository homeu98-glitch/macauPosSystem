/**
 * UI 唯一入口：呢張單應唔應該顯示「派送」掣。
 *
 * 點解要多一層（唔直接喺 component 用 `evaluateDispatchEligibility`）：
 *   ① 功能旗標（`NEXT_PUBLIC_DELIVERY_DISPATCH` / `..._ONLINE`）喺呢度一次過處理，
 *      component 唔會有人漏咗檢查；
 *   ② **權限**（`dispatchDelivery`）喺呢度一次過處理 —— 三個入口（訂單頁／快餐 strip／
 *      外送 tab）唔會有人唔記得 gate；
 *   ③ 將來如果要再加條件，改呢一個檔就夠。
 *
 * ## 三層閘（順序有意義）
 *
 * 1. **功能旗標**：未開 → 全世界都冇掣（連店主都冇）。
 * 2. **線上單旗標**：`NEXT_PUBLIC_DELIVERY_ONLINE` 未開 → 線上單冇掣（Ledger A 線未好）。
 *    ⚠️ 只影響線上單；店內／平台單照舊（用戶 2026-10-31 拍板：線下先上）。
 * 3. **權限**：店員冇 `dispatchDelivery` → 冇掣（店主／冇操作員時沿用 L1）。
 *
 * ⚠️ `visible: false` 唔等於「唔准」—— 可能只係旗標未開。要顯示原因就睇 `reason`。
 */

import { evaluateDispatchEligibility, type DispatchBlockReason, type DispatchInput } from "./eligibility.ts";
import { isDeliveryDispatchEnabled, isDeliveryOnlineEnabled } from "./flag.ts";

/** 唔顯示掣嘅原因：業務規則（`DispatchBlockReason`）＋環境／權限。 */
export type DispatchActionReason =
  | DispatchBlockReason
  | "flag_off"
  | "online_disabled"
  | "no_permission";

export type DispatchActionState = {
  visible: boolean;
  reason: DispatchActionReason;
};

export type DispatchActionOptions = {
  /** 主功能旗標。預設讀 `NEXT_PUBLIC_DELIVERY_DISPATCH`。 */
  enabled?: boolean;
  /** 線上單旗標。預設讀 `NEXT_PUBLIC_DELIVERY_ONLINE`。 */
  onlineEnabled?: boolean;
  /** 目前操作員／帳號有冇 `dispatchDelivery` 權限。`undefined` = 未計算（當有）。 */
  canDispatch?: boolean;
};

export function resolveDispatchAction(
  input: DispatchInput,
  options?: DispatchActionOptions,
): DispatchActionState {
  const enabled = options?.enabled ?? isDeliveryDispatchEnabled();
  if (!enabled) return { visible: false, reason: "flag_off" };

  // 線上單（Ledger）要另外開 —— Ledger A 線（派送／取消／催單／加價）未好之前，
  // 撳落去只會寫一張永遠停留喺 draft 嘅 job，比冇掣更差（商家以為叫咗車）。
  if (input.kind === "online" && !(options?.onlineEnabled ?? isDeliveryOnlineEnabled())) {
    return { visible: false, reason: "online_disabled" };
  }

  if (options?.canDispatch === false) return { visible: false, reason: "no_permission" };

  const result = evaluateDispatchEligibility(input);
  return { visible: result.can, reason: result.reason };
}
