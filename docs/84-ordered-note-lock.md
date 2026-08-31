# 84 · 已下單備註鎖定（Order Note Lock）

> 狀態：✅ 已實作（2026-08-31）
> 範圍：`src/components/pos-app.tsx`、新增 `src/lib/pos/order-note-lock.ts`
> 關聯：docs/80、81（打印放大）、Stream 7（`print-agent-android` 對齊「注：」用語）

---

## 1. 需求

訂單**送出嗰刻**備註內容即固定，之後唔可以再改：

1. 關閉所有「下單後仍能改備註／規格」嘅入口。
2. UI 層 + 資料層**同時**加「訂單已成立」判斷（單靠 UI 唔夠）。
3. 被擋住時顯示清楚提示：`訂單已送出，備註無法修改` / `訂單已送出，規格無法修改`。

---

## 2. 點解要鎖（三條獨立理由）

### 2.1 廚房單係送出當下嘅 snapshot

`buildKitchenPrintJobs()` 行 `note: opts.itemNoteOverride ?? it.note` —— PrintJob 一建立就快照複製。
送出後改備註 → **廚房手上張單同螢幕、同後台都唔一致**，而且系統唔會自動補印 → 廚房做錯菜。

### 2.2 `pos_orders.items` 係 JSONB 整條存

`/api/pos/sync` L58 `items: order.items`。改備註會連住寫入後台同收據，
造成「後台／收據改咗、廚房單冇改」嘅雙軌不一致（帳目對唔上廚房）。

### 2.3 ⚠️ note 係 `itemIdentity()` 一部分（最危險）

```ts
// pos-app.tsx itemIdentity()
`${menuItemId}|${serializeSpecs(item)}|${item.price}|${item.note ?? ""}`
```

`orderedItemQtyMap` 由 `baseOrderItems` 用**同一個 identity** 計 → `locked = orderedQty > 0`。
改已下單菜嘅 note → identity 變 → map 搵唔返 →

- 「已下單 x N」標記消失
- `+ / −` 復活（可以改已送廚房嘅數量）
- 「退 1 份」消失
- `voidOrderedItem` 彈「這個菜品尚未正式下單，不能退菜」

即係**三邊同步鐵律**（見 MEMORY.md）：`cartItems` + `baseOrderItems` + `order.items` 要一齊改。
與其補三邊同步，直接鎖住更簡單更安全 → 本文件方案。

---

## 3. 鎖定時機與條件

### 3.1 單品備註／規格

> 條件：菜品已喺一張 `sent_to_kitchen` 嘅單入面，即 `orderedItemQtyMap.get(itemIdentity(item)) > 0`

`baseOrderItems` 只喺 `loadOrderIntoWorkspace` 當 `order.status === "sent_to_kitchen"` 時載入（L1110），
所以 `orderedQty > 0` 就等於「已送出廚房」。

### 3.2 全單備註

> 條件：訂單 status ∈ `NOTE_LOCKED_ORDER_STATUSES`

```ts
export const NOTE_LOCKED_ORDER_STATUSES: ReadonlySet<PosOrder["status"]> = new Set([
  "sent_to_kitchen", "paid", "settled", "cancelled", "partially_refunded", "refunded",
]);
```

**唔鎖**（設計上要改得）：

| status | 點解唔鎖 |
| --- | --- |
| `draft` | 未送出，本來就係草稿 |
| `reopened` | 返結帳，就係要改返 |

**自動解鎖**：結帳／取消／刪除後 `setActiveOrderId(null)` → `workspaceOrder` 變 null →
`isOrderNoteLocked(null) === false` → 唔會影響下一張單。（已核對 L2541 / L2153 / L2190 / L1257 / L1675 五個 reset 點。）

---

## 4. 鎖咗嘅入口（全部）

| # | 層 | 位置 | 原本 | 而家 |
| --- | --- | --- | --- | --- |
| 1 | UI | `openItemNoteEditor()` | 靜默 `return`，**無提示** | toast `訂單已送出，備註無法修改` |
| 2 | 資料 | `applyItemNote()` | **完全冇防線** | 擋 + toast，回傳 `boolean` |
| 3 | 資料 | `applySpecSelection()` | **完全冇防線** | 擋 + toast `訂單已送出，規格無法修改` |
| 4 | UI | 全單備註「編輯」掣 | 只 `disabled={isReadOnlySettled}` → **送出廚房後仍改得（真漏洞）** | `disabled={isReadOnlySettled \|\| orderNoteLocked}`，label 變「已鎖定」+ 琥珀提示行 |
| 5 | 資料 | 備註彈窗「保存」 | 無防線 | 擋 + toast（彈窗就算被其他途徑打開都擋到） |
| 6 | UI | 購物車已下單菜備註行 | 只顯示 `備註：xxx` | 加 `已鎖定` 琥珀標記 |

### 入口排查結論（已排除）

- **`openSpecPicker(item, editingKey)`**：全 repo 得 `addMenuItem` 兩個 call site（L1447 / L1457），
  都**冇傳 `editingKey`** → `specEditingKey` 永遠係 null → 改規格入口實際上唔存在。
  仍然加咗資料層防線（#3）做日後保險。
- **Kiosk（`/order`、`/menu`）**：落單後 `setOrdering(false)` / `submittedOrder` 直接 return 成功頁，
  備註 textarea 唔會 render → **本身已經鎖咗**。`addToOrder()` L415 `setOrderNote(tableOrder.orderNote)`
  會還原全單備註 → 加單唔會丟備註。✅ 唔使改。
- **Salon**：預約備註屬另一個 domain（預約 vs 廚房單），唔喺今次範圍。
- **`viewingOrder` 明細抽屜**（L4147）：純顯示，無編輯。
- **`setOrderNote` 全部 call site**：1111（載入）/ 1260、1678、2156、2193（reset 清空）/ 3852（彈窗）— 無其他寫入口。

---

## 5. 異動檔案

| 檔案 | 改動 |
| --- | --- |
| `src/lib/pos/order-note-lock.ts` | 🆕 共用 predicate + 狀態集合 + 提示字串常量（UI／資料層共用同一份真源） |
| `src/components/pos-app.tsx` | +53 / −10：6 個入口（見 §4 表） |

無 DB schema 改動、無 migration（`OrderItem.note` 本身已存在，`pos_orders.items` 係 JSONB）。

---

## 6. 驗證

```bash
npx tsc --noEmit          # 只餘已知誤報 src/app/layout.tsx(37) LayoutProps
npx eslint src/components/pos-app.tsx src/lib/pos/order-note-lock.ts   # 0 error
```

### 人手驗收步驟

1. **未落單（draft）**：加菜 → 「加備註」掣可撳 → 儲存 → 見到 `備註：多飯`（無「已鎖定」）→ 全單備註「編輯」可撳。
2. **落單（送廚房）**：
   - 菜品列變「已下單 x1」+「退 1 份」，備註行尾出現琥珀 `已鎖定`。
   - 「加備註」掣消失。
   - 全單備註掣變灰底「已鎖定」，下方出現 `訂單已送出，備註已鎖定`。
3. **加單**：加新菜 → 新菜仍然可以「加備註」（未送廚房）；舊菜維持鎖定。
4. **退菜**：鎖定嘅菜「退 1 份」仍然正常，冇彈「尚未正式下單」。
5. **結帳**：`setActiveOrderId(null)` → 下一張單全單備註回復「編輯」可撳。
6. **返結帳**：`reopened` → 全單備註可以改（設計如此）。

---

## 7. 已知取捨

- **加單模式下全單備註會鎖住**：order 仍係 `sent_to_kitchen`，所以加單嗰陣改唔到全單備註。
  呢個係刻意嘅——全單備註已經印咗喺第一張廚房單上面，改咗廚房唔會知。
  如果日後要放寬，要同時解決「改全單備註 → 補印 / 提示」嘅問題（參見 Stream 6 嘅懸而未決問題 1）。
- **規格鎖定係防禦性嘅**：現時無入口可達（`specEditingKey` 永遠 null），加嚟防日後。
