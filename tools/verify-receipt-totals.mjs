/**
 * 收據金額對帳驗證（純 Node，唔使 build）
 *   node tools/verify-receipt-totals.mjs
 *
 * 複製 `src/lib/escpos-template.ts` 嘅金額邏輯（改嗰邊要同步改呢度），
 * 用真實客訴數字驗證：
 *   - 原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額  ← 收據鐵律
 *   - 「優惠合計 -81」case（stale discountAmount）要被雙軌對帳擋住
 *   - 服務費要計入結帳總額（docs/95 §14）
 */

// ── escpos-template.ts 嘅邏輯複本 ────────────────────────────────────────
const roundMoney = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0);
const computeSubtotalBeforeDiscount = (order) =>
  order.items.reduce((s, it) => s + it.price * it.quantity, 0);
// 基數用 it.price（包加購），同 pos-app.tsx::orderTotals() 一致
const computeItemSavings = (order) =>
  order.items.reduce((s, it) => {
    const rate = it.discountRate ?? 0;
    if (rate <= 0 || rate >= 100) return s;
    return s + (it.price * it.quantity * (100 - rate)) / 100;
  }, 0);
function resolveTotalDiscount({ naive, derived, subtotalBefore }) {
  const safeNaive = Number.isFinite(naive) ? Math.max(0, naive) : 0;
  const cap = Number.isFinite(subtotalBefore) ? Math.max(0, subtotalBefore) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(derived) || derived < 0) return Math.min(safeNaive, cap);
  return Math.max(0, Math.min(safeNaive, derived, cap));
}
const fmt = (n) => `MOP ${Math.round(n).toLocaleString("en-US")}`;

function receiptTotals(order) {
  const subtotalBefore = roundMoney(computeSubtotalBeforeDiscount(order));
  const itemSavings = roundMoney(computeItemSavings(order));
  const orderDiscount = roundMoney(Math.max(0, order.discountAmount ?? 0));
  const serviceCharge = roundMoney(Math.max(0, order.serviceChargeAmount ?? 0));
  const tax = roundMoney(Math.max(0, order.taxAmount ?? 0));
  const rounding = roundMoney(Math.max(0, order.roundingAmount ?? 0));
  const orderTotal = roundMoney(Math.max(0, order.total ?? 0));
  const naive = roundMoney(orderDiscount + itemSavings);
  const derived = roundMoney(subtotalBefore + serviceCharge + tax - rounding - orderTotal);
  const totalDiscount = resolveTotalDiscount({ naive, derived, subtotalBefore });
  return { subtotalBefore, itemSavings, orderDiscount, serviceCharge, tax, rounding, orderTotal, naive, derived, totalDiscount };
}

let failed = 0;
function scenario(title, order, expect) {
  const r = receiptTotals(order);
  const balanced = Math.abs(r.subtotalBefore + r.serviceCharge + r.tax - r.rounding - r.totalDiscount - r.orderTotal) < 0.01;
  const discountOk = expect.discount == null || Math.abs(r.totalDiscount - expect.discount) < 0.01;
  // expect.balanced === false = 已知上游 bug（服務費喺結帳時被丟棄），
  // 收據層面只保證「唔虛報折讓」，對帳失衡屬上游問題，唔當測試失敗。
  const balanceOk = expect.balanced === false ? true : balanced;
  const ok = balanceOk && discountOk;
  if (!ok) failed++;
  console.log(`\n── ${title} ──`);
  console.log(`  原價合計   ${r.subtotalBefore}`);
  if (r.serviceCharge) console.log(`  服務費     ${r.serviceCharge}`);
  if (r.tax) console.log(`  稅金       ${r.tax}`);
  if (r.rounding) console.log(`  系統抹零   ${r.rounding}`);
  console.log(`  優惠合計  -${r.totalDiscount}   → 打印「${fmt(-r.totalDiscount)}」`);
  console.log(`  總金額     ${r.orderTotal}`);
  console.log(`  [對帳] naive=${r.naive} derived=${r.derived} → 取 ${r.totalDiscount}`);
  console.log(`  ${ok ? "✅" : "❌"} 鐵律 ${r.subtotalBefore}+${r.serviceCharge}+${r.tax}-${r.rounding}-${r.totalDiscount} = ${r.orderTotal} ` +
    (expect.balanced === false ? "⚠️ 已知上游失衡" : balanced ? "✅" : "❌") +
    (expect.discount == null ? "" : ` ／ 期望折讓 ${expect.discount} ${discountOk ? "✅" : "❌"}`));
  if (expect.note) console.log(`  ℹ️  ${expect.note}`);
}

// ── Case A：ROUND 2 截圖（修好後應係 -2）───────────────────────────────
scenario(
  "A. ROUND 2 客訴單：牛三寶(100 含加麵5) + 牛肚麵(65 含蛋5) + 綠茶(15, 85折)",
  {
    items: [
      { name: "招牌牛三寶", price: 100, quantity: 1, selectedSpecs: [{ priceDelta: 5 }] },
      { name: "牛肚麵", price: 65, quantity: 1, selectedSpecs: [{ priceDelta: 5 }] },
      { name: "茉莉綠茶", price: 15, quantity: 1, discountRate: 85 },
    ],
    discountAmount: 0,
    total: 177.75,
  },
  { discount: 2.25, note: "15 × 15% = 2.25 → formatMoney 印 -2" },
);

// ── Case B：ROUND 3 客訴單（-81），stale discountAmount ─────────────────
scenario(
  "B. ROUND 3 客訴單：原價 155 / 總金額 150，但 order.discountAmount 殘留 80.85",
  {
    items: [
      { name: "A 餐", price: 100, quantity: 1 },
      { name: "B 餐", price: 55, quantity: 1 },
    ],
    discountAmount: 80.85, // ← stale：退菜／加單／返結 後冇按新基數重計
    total: 150,
  },
  { discount: 5, note: "naive 會印 MOP -81（客訴原狀）；雙軌對帳取細值 → -5 ✅" },
);

// ── Case C：加購 + 單品折扣（基數對齊 regression）──────────────────────
scenario(
  "C. 加購菜做單品折扣：原價 105（基價100+加購5）打 9 折 + 另一道 50",
  {
    items: [
      { name: "牛三寶", price: 105, quantity: 1, selectedSpecs: [{ priceDelta: 5 }], discountRate: 90 },
      { name: "小食", price: 50, quantity: 1 },
    ],
    discountAmount: 0,
    total: 144.5, // 105×0.9 + 50
  },
  { discount: 10.5, note: "舊碼用 unitBasePrice 只計到 10（少 0.5，對唔返總金額）；新碼計 10.5 ✅" },
);

// ── Case D：全單折扣 + 服務費 + 抹零（正常健康單）──────────────────────
scenario(
  "D. 健康單：原價 200，全單 9 折(-20)，服務費 18，抹零 0.2",
  {
    items: [{ name: "A", price: 200, quantity: 1 }],
    discountAmount: 20,
    serviceChargeAmount: 18, // (200-20) × 10%
    taxAmount: 0,
    roundingAmount: 0.2,
    total: 197.8, // 180 + 18 - 0.2
  },
  { discount: 20 },
);

// ── Case E：免單（total = 0）────────────────────────────────────────────
scenario(
  "E. 免單：原價 155 全減，total = 0",
  {
    items: [{ name: "A", price: 155, quantity: 1 }],
    discountAmount: 155,
    total: 0,
  },
  { discount: 155 },
);

// ── Case F1：服務費正常計入（docs/95 §14 修好後）────────────────────────
scenario(
  "F1. 服務費計入結帳總額（修好後）：原價 100 / 服務費 10 / total 110",
  {
    items: [{ name: "A", price: 100, quantity: 1 }],
    discountAmount: 0,
    serviceChargeAmount: 10,
    total: 110, // ← 落單同結帳都係 subtotal + service + tax
  },
  {
    discount: 0,
    note: "pos-app.tsx::paymentBase 已改為 subtotal + serviceChargeAmount + taxAmount，對帳平衡 ✅",
  },
);

// ── Case F2：舊單（fix 前已結帳落 DB）────────────────────────────────────
// 呢啲單嘅 total 係冇服務費嘅舊數，收據層面只保證「唔虛報折讓」，對帳失衡屬歷史資料問題。
scenario(
  "F2. 舊單仍帶舊 total（服務費被丟棄嘅歷史資料）：原價 100 / 服務費 10 / total 100",
  {
    items: [{ name: "A", price: 100, quantity: 1 }],
    discountAmount: 0,
    serviceChargeAmount: 10,
    total: 100,
  },
  {
    discount: 0,
    balanced: false,
    note: "⚠️ 歷史資料（fix 前結帳落 DB 嘅單）。收據層面取細值 → 唔會虛報 10 蚊折讓（安全方向），"
      + "對帳失衡只會出現喺舊單；新單走 F1。",
  },
);

// ── 規格行兩欄對齊（保持原有 regression）───────────────────────────────
const RECEIPT_PAPER_COLUMNS = 48;
const isWideChar = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd);
const displayWidth = (s) => { let w = 0; for (const ch of String(s)) w += isWideChar(ch.codePointAt(0)) ? 2 : 1; return w; };
const splitSpecLine = (s) => {
  const m = String(s).match(/^(.*?)\s+(-?\$\d+|-\d+)$/);
  if (!m) return { label: String(s), price: null };
  return { label: m[1].trimEnd(), price: m[2].startsWith("$") ? m[2] : ` ${m[2]}` };
};
const twoColumn = (left, right, cols = RECEIPT_PAPER_COLUMNS) => {
  const pad = cols - displayWidth(left) - displayWidth(right);
  return pad >= 1 ? left + " ".repeat(pad) + right : `${left}  ${right}`;
};

console.log("\n── G. 加購價錢靠右對齊（48 格）──");
for (const s of ["麵體:寬版拉麵", "加購:加麵 $5", "加購:糖心蛋 $5", "甜度:半糖"]) {
  const { label, price } = splitSpecLine(s);
  const text = price ? twoColumn("  " + label, price) : "  " + label;
  const w = displayWidth(text);
  const ok = price ? w === RECEIPT_PAPER_COLUMNS : true;
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${JSON.stringify(text)}  (闊度 ${w}/48)`);
}

console.log(`\n${failed === 0 ? "✅ 全部通過" : `❌ ${failed} 個 case 失敗`}\n`);
process.exit(failed === 0 ? 0 : 1);
