/**
 * 支付方式標籤 —— **全系統唯一真源**。
 *
 * ## 點解要有呢個檔案（2026-10-07）
 *
 * `pos_orders.payment_method` 係一個 `text` 欄，**冇 FK、冇 enum 約束**，所以兩類值會撈埋一齊：
 *
 * ① 收銀台手動結帳寫入嘅** store 自訂中文名**（「Mpay」「會員餘額」「中銀」「現金」…）
 *    —— 見 `pos-app.tsx` `confirmPayment()`；外賣平台單寫死「外賣平台」（`grabber-order.ts`）。
 *
 * ② Ledger 線上單投影入本機時寫入嘅 **Ledger enum 原文**
 *    —— `ledger-pos-bridge.ts` `paymentMethod: ledgerOrder.paymentMode`（冇翻譯）。
 *    值域：`in_store`（客人落單時揀「到店付款」）、`balance`（用會員餘額／扣點線上付款）…
 *
 * ② 令報表「支付方式分項」出現 `in_store` / `balance` 呢類英文行。
 * 病灶係**漏咗一層翻譯**，唔係資料錯 —— 所以喺**讀取時映射**就夠，
 * 唔使 backfill DB（舊單自動變中文）。
 *
 * ## 點解喺呢度（而唔係直接叫 `paymentModeLabel`）
 *
 * `ledger/order-mapper.ts` 嘅 `paymentModeLabel()` 只譯 Ledger 兩個值（balance / in_store），
 * 其餘原樣返回 —— 用喺 Ledger 側啱，但用喺「POS 單 + Ledger 單」合併嘅 breakdown 就唔夠。
 * 而家 `paymentModeLabel()` 委託畀呢個模組（單一真源，唔會兩邊漂移）。
 *
 * ## 設計約束（睇 `payment-method-label.test.ts`）
 *
 * - **零 import** ⇒ 可以俾 `node --test` 直接載入（記憶 §6：`.tsx`／`@/` 測試會載入唔到）。
 * - **唔會改變 store 自訂名**：查唔到映射就原樣返回（store 可能自己叫「Alipay」）。
 * - **冇 / 空白 → `fallback`**（預設「未記錄」），統一兩頁口徑。
 */

/**
 * Ledger enum（`orders.payment_mode`）→ 繁中標籤。
 *
 * 🔴 key 一律 **trim + 小寫**：Ledger 同一個值大小寫曾經唔一致過，
 * 而 `PosOrder.paymentMethod` 亦可能係手機輸入。**唔可以**只比 `===`。
 *
 * ⚠️ 收緊呢個表之前要諗清楚：`pos_orders.payment_method` 同時載住 store 自訂名，
 * 加入會撞名嘅 key（例如將 `cash` 譯做「現金」）有可能令 store 自己叫「現金」嘅項
 * 被改寫。**只收錄「Ledger 側確定會寫入嘅值」**。
 */
const LEDGER_PAYMENT_MODE_LABELS: Record<string, string> = {
  // ── Ledger `orders.payment_mode` 真實值域（`order-mapper.ts` 已用呢兩個）──
  /** 客人揀「到店付款／貨到付款」—— 錢喺店內收，但單係線上落。 */
  in_store: "到店付款",
  /** 客人用會員餘額／扣點喺線上直接付清。 */
  balance: "餘額扣點",

  // ── 防禦性：其他可能出現嘅 enum 拼法（寧可譯中，唔好漏英文上畫面）──
  online_in_store: "到店付款",
  online_balance: "餘額扣點",
  member_balance: "會員餘額",
  online_paid: "線上已支付",
  prepaid: "線上已支付",
};

/**
 * 將 `pos_orders.payment_method` / `orders.payment_mode` 嘅**原始值**映射成畫面標籤。
 *
 * @param raw 原始值（可 `null` / `undefined` / 空白字串）
 * @param fallback `raw` 冇意思時用嘅標籤。**預設「未記錄」**，令多頁口徑一致。
 * @returns 映射後嘅繁中標籤；查唔到映射時**原樣返回 `raw`**（store 自訂名唔可以被改）。
 */
export function posPaymentMethodLabel(raw?: string | null, fallback = "未記錄"): string {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  return LEDGER_PAYMENT_MODE_LABELS[value.toLowerCase()] ?? value;
}

/** 映射表嘅唯讀视图（供守衛測試用；唔好喺 runtime 改）。 */
export function knownLedgerPaymentModes(): readonly string[] {
  return Object.keys(LEDGER_PAYMENT_MODE_LABELS);
}