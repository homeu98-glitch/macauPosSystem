import type { PosOrder, ShiftSettlementSnapshot } from "@/lib/types";

/**
 * 模板設計介面嘅**唯一靜態資料源**（2026-09-10）。
 *
 * 背景：以前設計頁預覽係「抽商家最新一張真實訂單」（`orders[0]`），抽唔到先用
 * `SYNTHETIC_SAMPLE_ORDER`。問題係：
 * 1. 真單通常無折扣 / 無服務費 / 無稅 / 無抹零 / 無備註 → 呢啲區塊**全部隱形**，
 *    商家永遠睇唔到完整版面，以為「我嘅模板少咗嘢」；
 * 2. 唔同店、唔同時段開設計頁見到唔同嘢 → 版面唔可以重現，報 bug 都對唔上；
 * 3. 用真單會泄漏顧客資料（桌號、備註、金額）落截圖。
 *
 * 而家一律用呢份 fixture。設計原則：
 * - **只係一張普通 `PosOrder`**，照樣餵入原有 `buildReceiptContent` / `buildKitchenContent`
 *   / `buildLabelContent` → 欄位格式、兩欄對齊、折扣計算**自動同源**，
 *   第日改 builder 唔使再維護多一組假字串。
 * - 所有可選欄位（服務費 / 稅 / 抹零 / 實收 / 找零 / 全單備註 / 單品折扣）都填**非零值**，
 *   等全部區塊都有嘢印（預覽再做 force-visible，見 `print-center.tsx`）。
 * - 範例值要**睇得出係範例**，唔好扮真單（單號用 `SAMPLE-` 前綴、備註寫「（示例）」）。
 */

/** 設計頁預覽用門店名（同 `PREVIEW_STORE_TEL` 一齊，全部區塊都出到嘢）。 */
export const PREVIEW_STORE_NAME = "澳門示範店";
export const PREVIEW_STORE_TEL = "(853) 2888-0000";
/** 收據「服務員」區塊：真實出紙係讀登入員工名，預覽用固定示例。 */
export const PREVIEW_SERVER_NAME = "示例收銀員";
/**
 * 收據二維碼區塊：商家未填網址時照樣出一個示例碼，等佢見到呢個區塊嘅位置同大細。
 * 空白網址喺真實出紙係「唔印」，所以呢個值**淨用於預覽**（見 `print-center.tsx`）。
 */
export const PREVIEW_QR_URL = "https://macau-pos.example";

/**
 * 收據 / 自助點餐機 / 廚房單共用嘅示例訂單。
 *
 * ⚠️ 金額係**手砌而且要對得住數**：`buildReceiptContent` 有「優惠合計」雙軌對帳，
 * 對唔到會喺 dev 噴 warning 兼自動取細值（見 `resolveTotalDiscount`）。
 * 呢條式一定要成立：
 *   原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額
 *   142     + 14    + 7 − 1    − 14        === 148
 * 而「優惠合計」= 全單折扣(5) + Σ單品折讓(9) = 14。
 * 改任何一個數都要重新對一次，唔係預覽會出「-0」或者對唔到數嘅神秘負數。
 */
export const PREVIEW_RECEIPT_ORDER: PosOrder = {
  id: "__preview_sample__",
  localOrderNo: "SAMPLE-1001",
  tableId: "table-a01",
  tableName: "A01 · 堂食",
  status: "settled",
  items: [
    {
      // 有單品折扣 → 食埋「單品折扣明細」區塊（真單好少有，預覽要補）。
      menuItemId: "sample-noodle",
      name: "招牌半筋半肉麵",
      quantity: 1,
      price: 60,
      printerGroup: "kitchen",
      discountRate: 85,
      selectedSpecs: [],
      note: "",
    },
    {
      // 有齊 溫度 / 甜度 / 冰量 / 杯型 / 加料 → 標籤模板 13 個區塊全部有嘢印。
      menuItemId: "sample-milk-tea",
      name: "珍珠奶茶",
      quantity: 2,
      price: 28,
      printerGroup: "drinks",
      selectedSpecs: [
        { groupId: "temp", groupName: "溫度", optionId: "cold", optionLabel: "凍", priceDelta: 0 },
        { groupId: "sugar", groupName: "甜度", optionId: "half", optionLabel: "半糖", priceDelta: 0 },
        { groupId: "ice", groupName: "冰量", optionId: "less", optionLabel: "少冰", priceDelta: 0 },
        { groupId: "cup", groupName: "杯型", optionId: "large", optionLabel: "大杯", priceDelta: 0 },
        { groupId: "addon", groupName: "加料", optionId: "pearl", optionLabel: "珍珠", priceDelta: 0 },
      ],
      note: "珍珠另上（示例）",
    },
    {
      // 有加價加購 → 廚房 / 收據 spec row 出到「加料:椰果 $4」呢一層。
      menuItemId: "sample-lemon-tea",
      name: "檸檬茶",
      quantity: 1,
      price: 26,
      printerGroup: "drinks",
      selectedSpecs: [
        { groupId: "temp", groupName: "溫度", optionId: "cold", optionLabel: "凍", priceDelta: 0 },
        { groupId: "addon", groupName: "加料", optionId: "coconut", optionLabel: "椰果", priceDelta: 4 },
      ],
      note: "",
    },
  ],
  // 142 = 60×1 + 28×2 + 26×1
  subtotal: 142,
  // 下列各項刻意填非零，等服務費 / 稅 / 抹零 / 實收 / 找零 區塊全部現形。
  serviceChargeAmount: 14,
  taxAmount: 7,
  roundingAmount: 1,
  discountAmount: 5,
  total: 148,
  paymentMethod: "現金",
  cashTendered: 200,
  changeAmount: 52,
  orderNote: "唔要香菜，麵條硬身（示例）",
  // 有 originalSettledAt → 「結帳時間」區塊有嘢印（未結帳單呢格係空、會隱形）。
  originalSettledAt: "2026-09-10T12:34:00+08:00",
  createdAt: "2026-09-10T12:05:00+08:00",
  updatedAt: "2026-09-10T12:34:00+08:00",
};

/** 廚房單預覽：同收據共用一張單，等「設計 == 出紙」嘅資料基礎一致。 */
export const PREVIEW_KITCHEN_ORDER: PosOrder = PREVIEW_RECEIPT_ORDER;

/** 標籤預覽用邊件菜（珍珠奶茶：有齊溫度/甜度/冰量/杯型/加料）。 */
export const PREVIEW_LABEL_ITEM = PREVIEW_RECEIPT_ORDER.items[1]!;

/**
 * 交班結算單嘅示例快照。
 *
 * 由 `escpos-template.ts` 搬過嚟：嗰度係 lib（server 都會 import），
 * 唔應該夾住一份純 UI 用嘅假資料。
 */
export const SHIFT_PREVIEW_SAMPLE: ShiftSettlementSnapshot = {
  closedAt: "2026-09-09T21:32:00+08:00",
  shiftNo: "2026-09-09-02",
  storeName: "澳門示範店",
  employee: "陳大文",
  openedAt: "2026-09-09T09:05:00+08:00",
  store: {
    count: 30,
    revenue: 1967,
    receivableTotal: 1971,
    paidTotal: 1967,
    prepaid: 0,
    refundCount: 1,
    refundAmount: 28,
  },
  online: {
    orderCount: 5,
    paidMop: 233,
    balancePaidMop: 121,
    inStorePaidMop: 112,
  },
  payments: [
    { method: "Mpay", receivable: 1229, paid: 1228, count: 16 },
    { method: "未記錄", receivable: 606, paid: 606, count: 12 },
    { method: "現金", receivable: 138, paid: 133, count: 2 },
  ],
  purchase: { paid: 240, unpaid: 60 },
  cash: { expected: 133, actual: 130, diff: -3 },
  pendingEvents: 0,
  failedEvents: 0,
  skippedEvents: 0,
  pendingPrints: 0,
  note: "示例備註：第二班收銀機紙巾用完（示例）",
};
