import type { OrderItem, PrinterGroup } from "@/lib/types";

/**
 * Kiosk / 掃碼購物車嘅**純函式**（無 React、無 `@/` runtime import）。
 *
 * 2026-09-10 掃碼點餐審查 P3-1：原本 `lineSignature` / 金額計算都夾喺
 * `use-kiosk-order.ts`（一個 import 咗 `next/navigation` 嘅 client hook），
 * 令佢哋完全冇得做單元測試。抽出嚟之後：
 *   - hook 同 UI 照樣共用同一份實作（唔會漂移）；
 *   - `kiosk-cart.test.ts` 可以用 Node 內建 test runner 直接測（唔使裝新依賴）。
 */

export type CartLine = {
  lineId: string;
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: OrderItem["selectedSpecs"];
  note?: string;
};

/**
 * 購物車行簽名：同「菜品 + 規格組合 + 備註」就當同一行（自動合併數量）。
 * 規格 order 唔影響簽名（`sort()`），所以「先揀 A 再揀 B」同「先 B 再 A」會合併。
 */
export function lineSignature(line: Omit<CartLine, "lineId" | "quantity">): string {
  const specs = (line.selectedSpecs ?? [])
    .map((s) => `${s.groupId}:${s.optionId}`)
    .sort()
    .join(",");
  return `${line.menuItemId}|${specs}|${line.note ?? ""}`;
}

/**
 * 將一行加入購物車：同簽名就 quantity+1，否則新增一行。
 * 純函式（回傳新陣列），方便測試。
 */
export function mergeCartLine(cart: CartLine[], base: Omit<CartLine, "lineId" | "quantity">, newLineId: string): CartLine[] {
  const sig = lineSignature(base);
  const existing = cart.find((line) => lineSignature(line) === sig);
  if (existing) {
    return cart.map((line) => (line.lineId === existing.lineId ? { ...line, quantity: line.quantity + 1 } : line));
  }
  return [...cart, { ...base, lineId: newLineId, quantity: 1 }];
}

/** 改變某一行數量；數量歸零就移除該行。 */
export function changeCartQty(cart: CartLine[], lineId: string, delta: number): CartLine[] {
  return cart
    .map((line) => (line.lineId === lineId ? { ...line, quantity: line.quantity + delta } : line))
    .filter((line) => line.quantity > 0);
}

/**
 * 落單金額嘅**單一真源**（2026-09-10 掃碼點餐審查 P1-3）。
 *
 * 【問題】舊版客人端「總計」＝ `subtotal`（只加 price × qty），但
 * `buildKioskOrder()` 實際寫入嘅 `total = subtotal + tax + serviceCharge` ——
 * 澳門常見 10% 服務費，客人見到嘅報價同實收金額唔一致 → 收銀爭議。
 *
 * 【方案】客人端 UI 同 `buildKioskOrder()` 共用呢個函式，保證「報價 == 寫入訂單」。
 * 刻意**唔做四捨五入**（同舊 buildKioskOrder 一致），顯示層先 `toFixed(2)`。
 */
export type KioskOrderTotals = {
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  total: number;
};

export function computeOrderTotals(
  items: Array<{ price: number; quantity: number }>,
  rules?: { taxRate?: number | null; serviceChargeRate?: number | null } | null,
): KioskOrderTotals {
  const subtotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
  const taxRate = Number(rules?.taxRate ?? 0) || 0;
  const serviceRate = Number(rules?.serviceChargeRate ?? 0) || 0;
  const taxAmount = subtotal * taxRate;
  const serviceChargeAmount = subtotal * serviceRate;
  return { subtotal, taxAmount, serviceChargeAmount, total: subtotal + taxAmount + serviceChargeAmount };
}
