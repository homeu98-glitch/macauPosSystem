# Receipt 小票優化（仿 57.doc 風格 + 折扣修復）

> **背景**：用戶截圖（人氣半筋半肉麵 $72 + 糖心蛋 $5，總金額 MOP 77）出現三個 bug：
> 1. 神秘「優惠合計 MOP -72」（數值錯誤）
> 2. 菜品右邊價錢格式唔夠 user-friendly
> 3. 單品折扣冇顯示
> 同時參考 `Desktop/57小票餐厅.doc` 嘅傳統內地餐廳小票格式（「名稱 / 數量 / 售價」三欄 + 每菜 sub-line「折扣率 X% / 折扣金額 Y」）。

## 改動範圍

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `PosBootstrap.storeTel?`、`ReceiptSectionId` 加 `store_tel` / `server` / `discount_breakdown` / `service_charge_amount` / `tax_amount` / `cash_tendered` / `change_amount`、`PrintJob.items[]` 加 `discountRate` / `originalUnitPrice` / `discountedUnitPrice` / `savingAmount` |
| `src/lib/escpos-render.ts` | `PrintItemLine` 加上述 4 個可選 fields + 加 comment 教訓「加新 field 必須 audit `native.ts` payload map」 |
| `src/lib/escpos-template.ts` | `RECEIPT_BLOCK_DEFAULTS` 加新 section defaults、`DEFAULT_RECEIPT_TEMPLATE` 排版仿 57.doc 風格、`buildReceiptContent` 加新 content field、`computeTotalDiscount` 加 sanitization（截頂到 subtotalBefore）、新增 `computeItemSavings` / `clampMoney` |
| `src/components/escpos-preview.tsx` | 主菜行檢測 `hasItemDiscount`，渲染 sub-line「折扣率 X%  折讓 $Y」+ 顯示原價 |
| `src/components/receipt-ticket-preview.tsx` | 構造 PrintItemLine 帶上新 fields、傳 `storeTel` |
| `src/components/print-center.tsx` | sample 帶上新 fields + 加 `storeTel` / `serverName` 預覽字串 |
| `src/lib/print-jobs.ts` | `buildTemplateReceiptJobs` 帶上新 fields + 由 `loadAuthSession().name` derive `serverName` |
| `src/lib/print-bridge/native.ts` | APK payload map 加 4 個新 optional spreads（`...(typeof X === "number" ? { X } : {})`，forward-compatible） |
| `src/lib/mock-data.ts` | `mockBootstrap.storeTel`、receipt / kiosk template 嘅 `blocks` 加新 sections、`order` 排版仿 57.doc |

## Bug 根因

### Bug-1 「優惠合計 MOP -72」

源頭：`computeTotalDiscount`（`escpos-template.ts:234-241`，v1.0）唔做 sanitization。

```ts
// ❌ v1.0（出 -72 嗰版）
export function computeTotalDiscount(order: PosOrder): number {
  const orderDiscount = order.discountAmount ?? 0;
  const itemDiscount = order.items.reduce(...);
  return orderDiscount + itemDiscount;
}
```

如果 `order.discountAmount` 被無意填成 72（例如系統抹零被誤傳；preset 計算 bug；數據 corruption），
呢個值會原汁原味印出嚟：`MOP -72`，同真正 savings = 8 嘅單唔相符。

**修法（v1.1）**：
```ts
// ✅ v1.1：永遠 max(0, min(discount, subtotalBefore))
const subtotalBefore = computeSubtotalBeforeDiscount(order);
const orderDiscount = Math.max(0, order.discountAmount ?? 0);
const itemSavings = Math.max(0, computeItemSavings(order));
const raw = orderDiscount + itemSavings;
return Math.max(0, Math.min(raw, subtotalBefore));
```

`buildReceiptContent` 嘅 `total` / `discount_amount` 都會過 `clampMoney(v) = max(0, round2(v))`，
防呆多層。

### Bug-2 「菜品右邊價錢冇出」

用戶原意：希望菜名右邊唔只印一個 `x1 $72` 總計，而係當菜品有折扣時**雙欄並列**：
- 主行：`x1 $58`（折後）
- sub-line：`折扣率 80%（原價 $72）` + `折讓 $14`

v1.0 嘅 `PrintItemLine.price` 已經跟折後邏輯（`docs/82 §17`），但 designer 唔識表達
「原價 vs 折後」嘅對比。咁 v1.1 加：
- `originalUnitPrice`：`discountedUnitPrice(unitBasePrice, undefined)` 嘅 round 版本
- `discountedUnitPrice`：套 `discountRate` 後嘅 round 版本
- `savingAmount`：(base − discounted) × qty

renderer（POS preview + Companion + Android）依家可以按 `discountRate > 0` 自動出 sub-line。

### Bug-3「單品折扣冇顯示」

兩個原因：
1. `PrintItemLine` 冇帶 `discountRate` 出去 → renderer 自動忽略
2. Receipt section `discount_breakdown` 之前唔存在 → 收銀彙總的折讓冇位置印

v1.1：
- `PrintItemLine` 加 `discountRate`/其它 fields（Bug-2）
- 新 section `discount_breakdown`：逐件菜「`菜名  折扣率 X%  折讓 $Z`」
  仿 57.doc 嘅逐項格式
- 新 section `discount_amount`：合計「`優惠合計: -$X`」

## 7 個新 receipt section

| Section ID | 顯示 | Default visible | 對應 57.doc |
| --- | --- | --- | --- |
| `store_tel` | `電話: (853) 2888-0000` | ❌（要 bootstrap.storeTel） | ✓ |
| `server` | `服務員: 收銀員名` | ❌（要 auth） | — |
| `discount_breakdown` | `人氣半筋半肉麵  折扣率 80%  折讓 $14` | ✅ | ✓ |
| `service_charge_amount` | `服務費: $5` | ❌ | — |
| `tax_amount` | `稅金: $3` | ❌ | — |
| `cash_tendered` | `实收: $80` | ❌（要 order.cashTendered） | ✓ |
| `change_amount` | `找零: $3` | ❌（要 order.changeAmount） | ✓ |

## Payload map 教訓（已 audit）

`src/lib/print-bridge/native.ts:56-65` 嘅 payload map 顯式只攞四個 field：
`name` / `quantity` / `specs` / `note`，加後每個 new field 都要逐個去 spread。
今次加咗 4 個 `...(typeof X === "number" ? { X } : {})` 模式，等舊 APK / Companion 唔識新 field 自動忽略，唔會 regression。

> **鐵律（memory §Native bridge protocol）**：每加新 field 到 `PrintItemLine` 之後必須 audit `native.ts` 嘅 payload map——否則 APK / Companion 收唔到 data。

## 測試建議

1. 撳落單 → 選擇 1 件菜 + discount 80% → 撳結帳 → preview receipt：
   - 應見到 `人氣半筋半肉麵 ... x1 $14（原價 $72 → 8 折 折讓 $58）`
   - discount_breakdown 行顯示「折扣率 80% / 折讓 $58」
   - 優惠合計 = -$58
2. 改 settings → 店家電話 + 服務員顯示 → 應見到兩行喺 store_name 下面
3. 強行寫入測試：用 dev console `localStorage.macau-pos-store-config` → 改 `discountAmount: 999`，預覽應該 cap 喺 subtotalBefore

## Related

- `docs/82-meituan-style-printer-setup-redesign.md`（§17 `price` 字段、§18+20 payload map 教訓）
- `docs/88-receipt-discount-section.md`（小票折扣區塊舊版）
