# 88. 收據折扣區段（原價合計 / 系統抹零 / 優惠合計）

> **目的**：收據現狀只印 `總金額: MOP X`（已包折扣），顧客對帳 / 退稅都唔透明，店家亦唔知「原價幾多、減幾多、抹幾多」。
> 參考主流餐飲 POS 收據（老味道麵館 / 流水號打印 / 漢拿山），統一加返「**原價合計 → 系統抹零 → 優惠合計 → 總金額**」明細區段。
>
> **本輪範圍**：只動**收據**（receipt）模板 + 結帳頁 UI（抹零 / 現金輸入）。**唔做**付款明細多行（cash / 支付寶 / 微信分開）、**唔做**酒水分組小計（參見 §89 待定 task）。

---

## 1. 現狀問題（點解要改）

收銀結帳時用家可以：
- 全單折扣（§19 下拉選 preset，寫 `PosOrder.discountAmount`）
- 單品折扣（§19 每個菜品「折扣」掣，寫 `OrderItem.discountRate`）

但收據只印：
```
總金額: MOP 86
```
顧客完全唔知「原價幾多、減咗幾多」。**違反 docs/74「design == output」對帳透明度原則**。

---

## 2. 設計目標（參考圖）

| 參考 | 格式 |
|---|---|
| 老味道麵館 | 原價合計 → 系統抹零（-）→ 優惠合計（-）→ 現金支付 → 實收金額 |
| 流水號打印 | 合計 → 優惠金額（-）→ 實收 → 收款 → 找零 |
| 漢拿山 | 小計（按酒水/食品分組）→ 消費金額 → 支付寶實收 → 已結算 |

**本輪採用老味道格式**：原價合計 / 系統抹零 / 優惠合計 三行（抹零同優惠都係負值獨立顯示）。

---

## 3. 數據模型

### 3.1 `PosOrder` 新增 fields（types.ts）

```ts
roundingAmount?: number;  // 系統抹零（金額，例如 0.4；total = subtotal - discount - rounding）
cashTendered?:  number;  // 顧客實際畀嘅現金（預設 = total）
changeAmount?:  number;  // 找零（= max(0, cashTendered - total)）
```

- 全部 optional，舊 settled 單（schema 升級前）冇呢啲 field → 收據 block 自動 hidden（forward-compatible）。
- 唔使 migration：`pos_orders.items` 係 JSONB 整條存（`/api/pos/sync` L58），`PosOrder` 加 field 自動透傳。

### 3.2 `ReceiptSectionId` 新增（types.ts）

```ts
"subtotal_before_discount"  // 原價合計（= Σ 基價 × qty，未扣折扣）
"rounding_amount"           // 系統抹零（負值顯示）
"discount_amount"           // 優惠合計（負值顯示）
```

### 3.3 全單折扣語義（沿用 §19）

`PosOrder.discountAmount` = **「減多少」**（例如 22 = 減 $22）。收據「優惠合計」顯示 `-22`（負數）。

---

## 4. 收據 builder（escpos-template.ts）

### 4.1 Section meta + defaults

```ts
RECEIPT_SECTION_META.push(
  { id: "subtotal_before_discount", label: "原價合計" },
  { id: "rounding_amount", label: "系統抹零" },
  { id: "discount_amount", label: "優惠合計" },
);

RECEIPT_BLOCK_DEFAULTS = {
  ...原有,
  subtotal_before_discount: block(true,  "s", false, "right"),  // 預設顯示
  rounding_amount:         block(false, "s", false, "right"),  // 預設隱藏（冇抹零就唔顯示）
  discount_amount:         block(false, "s", false, "right"),  // 預設隱藏（冇折扣就唔顯示）
};
```

### 4.2 Template order

`DEFAULT_RECEIPT_TEMPLATE.order`（insert 喺 `items` 之後、`total` 之前）：

```ts
[..., "items",
 "subtotal_before_discount", "rounding_amount", "discount_amount",
 "total", "payment_method", "order_note", "footer"]
```

### 4.3 builder

```ts
function buildReceiptContent(order, opts) {
  const subtotalBeforeDiscount = computeSubtotalBeforeDiscount(order);
  const totalDiscount = computeTotalDiscount(order);
  const roundingAmount = order.roundingAmount ?? 0;
  return {
    ...原有,
    subtotal_before_discount: `原價合計: ${formatMoney(subtotalBeforeDiscount, opts.currency)}`,
    rounding_amount: roundingAmount > 0 ? `系統抹零: ${formatMoney(-roundingAmount, opts.currency)}` : "",
    discount_amount: totalDiscount > 0 ? `優惠合計: ${formatMoney(-totalDiscount, opts.criteria)}` : "",
  };
}

// 原價合計：Σ (unitBasePrice(it) × quantity)，未扣任何折扣
function computeSubtotalBeforeDiscount(order: PosOrder): number {
  return order.items.reduce((sum, it) => sum + unitBasePrice(it) * it.quantity, 0);
}

// 優惠合計：全單折扣 + 各單品折扣 savings
function computeTotalDiscount(order: PosOrder): number {
  const orderDiscount = order.discountAmount ?? 0;  // §19：「減多少」
  const itemDiscount = order.items.reduce((sum, it) => {
    const rate = it.discountRate ?? 0;              // §19：80 = 8折 = 減 20%
    return sum + (rate > 0 ? unitBasePrice(it) * it.quantity * rate / 100 : 0);
  }, 0);
  return orderDiscount + itemDiscount;
}
```

> `unitBasePrice` 係 §17 新增 helper（從 `OrderItem.price` 倒推基價，扣減 spec delta）。

---

## 5. 結帳頁 UI（pos-app.tsx）

### 5.1 抹零 input

全單折扣 dropdown 旁邊加「**抹零**」金額 input（預設 0，placeholder「0.00」）。改動寫 `order.roundingAmount`。

### 5.2 現金輸入 + 找零

「應收」section 改為「實收 + 找零」：
- 「應收 MOP 24」（= total）
- 「顧客付現金 [input] MOP [25]」← 用戶填入，預設 = total
- 「找零 MOP 1」← 自動計 = `cashTendered - total`

改動寫 `order.cashTendered` / `order.changeAmount`。

### 5.3 載入已存單

舊單（schema 升級前）冇 `roundingAmount` / `cashTendered` / `changeAmount` → UI 當 0 處理（input 顯示空 / 0，找零顯示 0）。

---

## 6. 渲染範例

### case A：全單 9 折 + 抹零 $0.5
```
原價合計:           MOP 220
系統抹零:           MOP  -0.5
優惠合計:           MOP -22
─────────────────
總金額:             MOP 197.5
```

### case B：單品 8 折（招牌牛三寶）+ 冇抹零
```
原價合計:           MOP 105
優惠合計:           MOP -19
─────────────────
總金額:             MOP 86
```
（rounding hidden，因 = 0）

### case C：冇折扣冇抹零
```
總金額:             MOP 105
```
（3 個 block 全 hidden）

---

## 7. 通道影響

| 通道 | 影響 |
|---|---|
| **POS 網頁 preview** | EscPosPreview 自動 render 新 block（content map 已帶 key） |
| **Native bridge (APK)** | `content` map 已經帶新 key（`native.ts` 已轉發 `content`，§18+20）；APK `EscPosRenderer.renderReceiptTicket` 需要升級識讀 `content.subtotal_before_discount` 等新 key 先印到實紙 |
| **Companion (desktop)** | companion-transport.ts 直接 `JSON.stringify({ job })` 透傳 content；companion repo renderer 需要升級識讀新 key |
| **Relay** | 直接 `ws.send(JSON.stringify({ job }))` 透傳 |

> ⚠️ **實紙生效需要 agent repo 升級**：POS 網頁 source commit 後，`content` map 已經帶新 key，但 APK / Companion renderer 要識讀先印到。同 §18+20 菜價 fix 一樣，係 agent repo 工作。

---

## 8. 驗收標準

- [ ] `tsc --noEmit` 通過（只剩 layout.tsx LayoutProps 假陽性）
- [ ] Print Center designer 預覽：打開商家收據模板，見到 `subtotal_before_discount`（on）/ `rounding_amount` / `discount_amount`（off）三個新 block，可以 toggle visible
- [ ] 收銀結帳：開新單 → 加單品折扣 + 全單折扣 + 抹零 → 收據預覽見「原價合計 / 系統抹零 / 優惠合計」三行
- [ ] 舊 settled 單（無新 field）收據：3 個 block 自動 hidden，只見 `總金額`
- [ ] 設計介面 == 輸出：POS preview 同 APK / Companion 升級後實紙一致

---

## 9. 待決（不在本輪）

- **付款明細多行**（cash / 支付寶 / 微信分開 + 找零行）：另起 task（§89 候選），需要 POS 結帳 UI 加多 payment method selector
- **酒水分組小計**（食品 / 酒水 / 其他）：另起 task，需要 `OrderItem.category` field + printerGroup 擴展
