/**
 * online-orders.tsx：`t(orderCodeLabel(x))` → `tOrderCode(t, x)`。
 *
 * 🔴 因為 `orderCodeLabel()` 回傳已填值字串（`取餐碼 005`），字典 key 係
 *    `取餐碼 {code}` ⇒ 直接 t() 永遠命中唔到（靜默漏譯）。
 */
const fs = require("fs");

const FILE = "C:/dev/macauPos/macauPosSystem/src/components/online-orders.tsx";
const WRITE = process.argv.includes("--write");

let src = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

// 1) import
const IMPORT_FROM = `  orderCodeLabel,\n`;
const IMPORT_TO = `  orderCodeLabel,\n  orderCodeLabelParts,\n`;
if ((src.split(IMPORT_FROM).length - 1) !== 1) {
  console.error("❌ 搵唔到 orderCodeLabel 嘅 import（預期 1 次）");
  process.exit(1);
}
src = src.replace(IMPORT_FROM, IMPORT_TO);

// 2) 插 helper（放喺 TABS 之前，module scope）
const ANCHOR = `const TABS: Array<{ key: LedgerOrderTab; label: string }> = [`;
const HELPER = `/**
 * 單號顯示（可翻譯）—— module scope helper，唔可以喺 module scope call \`useT()\`，
 * 所以 \`t\` 由 caller 傳入。
 *
 * 🔴 \`orderCodeLabel()\` 回傳已填值字串（\`取餐碼 005\`），字典 key 係 \`取餐碼 {code}\`
 *    ⇒ 直接 \`t(orderCodeLabel(order))\` 永遠命中唔到字典（英文版第一欄殘留中文，
 *    而且唔會報錯）。要行 \`orderCodeLabelParts()\` 攞 key + vars。
 */
function tOrderCode(
  t: (key: string, vars?: Record<string, string | number>) => string,
  order: Parameters<typeof orderCodeLabelParts>[0],
): string {
  const parts = orderCodeLabelParts(order);
  return t(parts.key, parts.vars);
}

`;
if ((src.split(ANCHOR).length - 1) !== 1) {
  console.error("❌ 搵唔到 TABS anchor（預期 1 次）");
  process.exit(1);
}
src = src.replace(ANCHOR, HELPER + ANCHOR);

// 3) 逐個 call site
const before = src;
src = src.replace(/t\(orderCodeLabel\(([A-Za-z0-9_.]+)\)\)/g, "tOrderCode(t, $1)");
const hits = (before.match(/t\(orderCodeLabel\(([A-Za-z0-9_.]+)\)\)/g) || []).length;
console.log(`替換 ${hits} 個 t(orderCodeLabel(...)) call site`);

// 4) autoAcceptToast 嘅 code 參數
const AA_FROM = "autoAcceptToast(orderCodeLabel(order), outcome)";
const AA_TO = "autoAcceptToast(tOrderCode(t, order), outcome)";
const aaHits = src.split(AA_FROM).length - 1;
if (aaHits !== 1) {
  console.error(`❌ autoAcceptToast call site 出現 ${aaHits} 次（預期 1）`);
  process.exit(1);
}
src = src.replace(AA_FROM, AA_TO);
console.log("替換 1 個 autoAcceptToast code 參數");

if (WRITE) {
  fs.writeFileSync(FILE, src.replace(/\n/g, "\r\n"));
  console.log("✅ 已寫入");
} else {
  console.log("dry-run（加 --write 才寫）");
}
