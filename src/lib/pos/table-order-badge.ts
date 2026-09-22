/**
 * 桌台總覽「訂單號」右上角角標（2026-09-22 商家需求）。
 *
 * 規則（單一真源，唔准喺 UI 重寫）：
 *   1. **有單先出角標**：枱狀態非 `idle`（即 `draft` / `sent_to_kitchen` / `paid` / `reopened`）
 *      而且有 `localOrderNo` → 出角標。
 *   2. **空閒枱一律唔出**：`idle` 枱（白卡）冇單號，出空白角標只會製造雜訊。
 *      ⚠️「空閒」係真冇單：`confirmOpenTable()` 只設定入座人數 ＋ 開工作台，
 *      **唔會建立訂單**，所以開咗枱未落單嘅枱狀態仍然係 `idle`（＝商家講嘅「尚未下單」）。
 *   3. `localOrderNo` 係空字串／全空白（快餐 counter 自助單 / backfill 未 stamp）→ 唔出，
 *      避免出現「一格空白白色藥丸」睇落似爛 UI。
 *
 * `draft` 算「有單」：實測只有**客人自助落單**（掃碼 / 自助機，見 `kiosk-order.ts`）先寫 `draft`
 * —— 店員喺收銀台落單一律寫 `sent_to_kitchen`（`upsertCurrentOrder("sent_to_kitchen")` 係唯一呼叫點）。
 * 即 `draft` 枱卡標籤寫「未下單」＝「店員未確認／未送廚房」，但**客人已經落咗單、單號已經存在**，
 * 正正係最需要靠角標認單嘅情況，所以照出角標。
 *
 * ⚠️ 呢個模組**零 import** —— `npm test`（`node --test`）唔認 `@/` 別名、唔支援 `.tsx`，
 *    所以判別邏輯要獨立成檔先測得到（見 `table-order-badge.test.ts`）。
 */

/** 只讀枱狀態；`idle` = 未開枱（冇單）。 */
export type TableBadgeStatus = "idle" | "draft" | "sent_to_kitchen" | "paid" | "reopened" | (string & {});

export interface TableOrderBadgeInput {
  /** 枱狀態；`null` / `undefined` 一律當 `idle`。 */
  status?: TableBadgeStatus | null;
  /** 訂單號（`PosOrder.localOrderNo`，例如「訂單1」「快餐01」「A01」）。 */
  localOrderNo?: string | null;
}

export interface TableOrderBadge {
  /** 應否顯示角標。 */
  show: boolean;
  /** 角標文字（已 trim）；`show=false` 時為空字串。 */
  text: string;
}

/**
 * 由枱狀態 ＋ 訂單號推導右上角角標。
 *
 * @example
 *   tableOrderBadge({ status: "sent_to_kitchen", localOrderNo: "訂單1" })
 *   // → { show: true, text: "訂單1" }
 *   tableOrderBadge({ status: "idle", localOrderNo: "訂單1" })
 *   // → { show: false, text: "" }  // 空閒枱唔出角標
 */
export function tableOrderBadge(input: TableOrderBadgeInput | null | undefined): TableOrderBadge {
  const status = input?.status ?? "idle";
  const text = (input?.localOrderNo ?? "").trim();
  const occupied = status !== "idle";
  if (!occupied || text.length === 0) {
    return { show: false, text: "" };
  }
  return { show: true, text };
}
