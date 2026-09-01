# 免單（Comp Order）

> **需求**：結帳頁新增「免單」掣 → 必須選／輸入備註 → 備註清單嚟自
> `設置 → 備註 → 免單備註`。

## 1. 語意定義（同退菜 / 折扣嘅分別）

| | 免單 | 退菜 | 折扣 |
| --- | --- | --- | --- |
| 出廚房單 | ✅ 照出 | ❌ 退單 | ✅ 照出 |
| 出收據 | ✅ 照出 | ❌ | ✅ 照出 |
| 計入營業額 | ✅ 計（原額） | ❌ 唔計 | ✅ 計（折後） |
| 實收 | **0** | 0 | 折後價 |
| 庫存扣減 | ✅ 照扣 | 視退菜時機 | ✅ 照扣 |
| 需要備註 | **必填** | 需要（取消備註） | 選填 |

一句講晒：**免單 = 照做照出，但唔收錢，所以要留低原因俾對帳**。

會計上：
- `total = 0`
- `discountAmount = 應收原額`（全額減免，`paymentBase.total`）
- `paymentMethod = "免單"`（`PaymentMethod = string`，無須改 type）
- `roundingAmount` / `cashTendered` / `changeAmount` 一律 `0`（收據 block 自動 hidden）

## 2. 點解唔用 `orderNote` 裝免單備註

`orderNote` 係**廚房備註**，受 `docs/84` 鎖定（`isOrderNoteLocked()`：
`sent_to_kitchen` 起鎖死）。而免單**一定**發生喺 `sent_to_kitchen` 之後 ——
寫入 `orderNote` 即係直接違反鎖定規則。

鎖嘅三個理由（見 `src/lib/pos/order-note-lock.ts`）全部唔適用於免單備註：
1. 廚房單係送出當下 snapshot → 免單備註唔使落廚房
2. `pos_orders.items` 係 JSONB 整條存 → 免單備註唔喺 items 入面
3. `itemIdentity()` 含 note → 免單備註唔係 item note

**所以用獨立審計欄位**，跟 `cancelledReason` / `reopenReason` / `voidedReason`
嘅既有模式：喺邊個 lifecycle 階段寫就歸邊個管，兩邊唔互相污染。

```ts
// src/lib/types.ts — PosOrder
compNote?: string;   // 免單備註（結帳時寫入）
compedAt?: string;   // 免單操作時間（ISO）
```

## 3. 改動清單

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `PosLocalSettings.compNotePresets: string[]`；`PosOrder.compNote?` / `compedAt?` |
| `src/lib/mock-data.ts` | `compNotePresets` 預設值：老闆請客 / 員工餐 / 客人投訴補償 / 試食推廣 / 熟客優惠 |
| `src/lib/storage.ts` | normalize 防呆：舊 localStorage 冇呢欄 → fallback 預設清單 |
| `src/components/device-settings.tsx` | 備註 tab 加「免單備註」卡（增刪）；`syncConfig` payload 帶埋；`newCompNotePreset` state |
| `src/components/pos-app.tsx` | `compModalOpen` / `compNote` state；`settleCompOrder()` + `confirmComp()`；「免單」掣（去結帳掣下面）；免單 modal；viewing modal 顯示免單備註 |
| `src/components/local-orders-panel.tsx` | `/orders` 訂單明細顯示免單備註（對帳位） |

## 4. 結帳邏輯（`settleCompOrder`）

放喺 `confirmPayment` 隔離，刻意**重用**佢嘅收尾流程，確保對帳口徑統一：
寫入 orders（merge + saveOrders）→ 推 `ORDER_SETTLED` 事件 → `syncNow` 即時上雲 →
打印收據 → `backToTables()`（快餐 counter 則 `setViewingOrderId(null)`）。

同 `confirmPayment` 嘅**唯一**分別：
- **唔行會員扣款／核券**：免費單唔需要扣會員錢，亦避免離線時俾
  `memberLedgerOpsNeeded` 擋住（`confirmPayment` 開頭三個 guard 會直接 return）。
  免單明確寫 `ledgerMemberPhone: undefined` / `memberDeductionAvos: 0`。

快餐模式購物車結帳（`payingOrderId === CART_PAYING_ID`）同 `confirmPayment` 一樣，
要先 `sendToKitchen({ silent: true, forceNewOrder: true })` 落單先至結。

## 5. 雲端 / 報表（follow-up）

**現況**：免單備註跟 `ORDER_SETTLED` 事件嘅 `payload.compNote` 上雲。
`queue_events.payload` 係 JSONB，**唔使 migration 就留到底稿**，報表可以
由 `queue_events` 追溯「點解免單」。

**未做**：`pos_orders` 冇 `comp_note` 直欄 —— 因為 `/api/pos/sync` 嘅
`pos_orders` upsert 用**顯式欄位清單**（`src/app/api/pos/sync/route.ts:177-208`），
加欄要跑 migration。要落嘅話：

```sql
-- supabase/migrations/0018_pos_comp_note.sql
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS comp_note text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS comped_at timestamptz;
```

跟住要改三處：
1. `src/app/api/pos/sync/route.ts` — `ORDER_CREATED/UPDATED` upsert 加
   `comp_note: text(order.compNote, MAX_TEXT_LEN)`、`comped_at`
2. 同上 `ORDER_SETTLED` patch 加 `comp_note: text(eventPayload.compNote, MAX_TEXT_LEN)`
3. `src/lib/pos/pos-order-mapper.ts` — `PosOrderRow` 加欄 + `mapPosOrderRow` 映射

**喺跑 migration 之前**：`compNote` 只喺本機 localStorage + `queue_events` 有，
由 server state 重新載入（`loadOrders()` from `/api/pos/state`）會**冇咗**呢個欄。
即係「換機／清 cache 後睇唔到舊免單備註」。前台收銀當場睇冇問題。

## 6. 相關

- `docs/84-ordered-note-lock.md` — 備註鎖定（`orderNote` 點解寫唔到）
- `docs/88-receipt-discount-section.md` — 折扣區塊（免單會出「優惠合計 = 全額」）
- `docs/90-receipt-optimization-57doc-style.md` — 收據格式（免單嘅 `discount_amount` 會印全額）
