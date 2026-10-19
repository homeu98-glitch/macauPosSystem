/**
 * 結帳差額判準（2026-10-19 到店優惠改價，mockup v3 畫面 ⑤）—— 純函式、零 import。
 *
 * ## 語意
 *
 * 線上單搬落嚟之後改價（例：到店 9 折）：**線上已付 > 新金額** → 應收 0，
 * 但客人多付咗錢 → 結帳時一定要處理差額（充值返回／現金退款／店方保留）。
 *
 * 反之**唔使處理**（現有行為零改動）：
 *  - 加菜情况（新價 > 已付）→ 自動補收差額；
 *  - 未付款線上單（`prepaidAmount = 0`）→ 正常收銀流程；
 *  - 純本地單（`onlineOrderId` 空）→ 恒 0（本地單根本冇預付）。
 *
 * ⚠️ 抹零（rounding）**刻意唔計入**：差額語意係「改價」同現金抹零無關
 *   （`completeOnlinePaidOrder` 都 ignore rounding，見 pos-app 註釋）。
 */

export type CheckoutDiffParams = {
  /** 線上單先有值（`PosOrder.onlineOrderId`）—— 純本地單恒 0。 */
  onlineOrderId?: string;
  /** 線上已付金額（`PosOrder.prepaidAmount`）。 */
  prepaidAmount?: number;
  /** 原價合計（paymentBase.total，未扣折扣）。 */
  baseTotal: number;
  /** 全單折扣金額。 */
  discountAmount: number;
};

/** 差額處理方式（同 `PosOrder.diffHandling`；本地聲明避免跨層 import）。 */
export type PosOrderDiffHandling = "topup" | "cash" | "none";

/**
 * 計出「客人多付」差額（正數先需要處理）。
 *
 * 判準：`onlineOrderId` 有值 ＋ `prepaidAmount > max(0, baseTotal − discountAmount)`。
 * 回傳 0 = 唔使彈差額模態（加菜／未付款／本地單）。
 */
export function computeCheckoutDiff(params: CheckoutDiffParams): number {
  if (!params.onlineOrderId) return 0;
  const prepaid = Number(params.prepaidAmount ?? 0);
  if (!Number.isFinite(prepaid) || prepaid <= 0) return 0;
  const settleTotal = Math.max(0, (Number(params.baseTotal) || 0) - (Number(params.discountAmount) || 0));
  const diff = prepaid - settleTotal;
  // 兩位小數（分對分），防 100 − 89.999999 類浮點尾數。
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}

/**
 * 電話遮罩（收據註腳／訂單徽章提示用）：`63936542` → `6393****`。
 *
 * 🔴 純顯示用途：完整會員電話係個資紅線，從來唔落 `pos_orders`；
 * 持久化嗰格（`PosOrder.diffPhoneMask`）只存呢個遮罩結果。
 * 少過 4 位（含空值）→ 原樣回傳（爛資料唔好變成假 mask）。
 */
export function maskPhoneForReceipt(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)}****`;
}

/**
 * 小票「差額處理」註腳（`ReceiptSectionId.diff_note` 嘅內容，純文字一／兩行）。
 *
 * 跟 `rounding_amount` 模式：冇處理過差額 → 空字串 → renderer 自動略過
 * （舊單／非差額單零影響）。格式跟 mockup v3 畫面 ⑥：
 *  - topup → `差額 MOP 10.00 已充值返回原支付戶口（6393****）· 憑證 TXN-8F3K2`
 *  - cash  → `差額 MOP 10.00 已現金退款`
 *  - none  → `差額 MOP 10.00 店方保留（原因）`
 *
 * ⚠️ 紙單屬第 3 層（唔入 i18n 字典）：客人／商家都會睇，全港統一中文。
 */
export function buildDiffNote(params: {
  handling?: PosOrderDiffHandling;
  amount?: number;
  txnId?: string;
  reason?: string;
  phoneMask?: string;
  formatAmount: (amount: number) => string;
}): string {
  const handling = params.handling;
  if (!handling) return "";
  const amount = Number(params.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const amt = params.formatAmount(amount);
  if (handling === "topup") {
    const account = params.phoneMask ? `已充值返回原支付戶口（${params.phoneMask}）` : "已充值返回原支付戶口";
    // 格式跟 mockup v3 畫面 ⑥：「差額 MOP 10.00 已充值返回原支付戶口（6234****）· 憑證 TXN-8F3K2」
    const voucher = params.txnId ? `· 憑證 ${params.txnId}` : "";
    return `差額 ${amt} ${account}${voucher}`;
  }
  if (handling === "cash") return `差額 ${amt} 已現金退款`;
  const reason = (params.reason ?? "").trim();
  return `差額 ${amt} 店方保留${reason ? `（${reason}）` : ""}`;
}
