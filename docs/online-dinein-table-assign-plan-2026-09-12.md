# 線上堂食單「排位」功能設計方案 + 可行性評估

- 日期：2026-09-12
- 需求來源：商家要求 —— 線上下單嘅「堂食單」要可以 assign 到桌台，並要有「已結帳」／「待安排座位」狀態
- 相關前文：`docs/reviews/online-order-kitchen-print-audit-2026-09-12.md`（同一批線上單問題）
- 狀態：**設計待拍板，未改任何代碼**

---

## 0. 我對需求嘅理解（先對齊，錯就一切都錯）

客人喺 Ledger 落單時**唔分**堂食／外賣（只有堂食店／快餐店之別），所以 POS 收到嘅 `tabType = "dine_in"` 單，**要按「本店係咩模式」分兩條完全唔同嘅路**：

| # | 店型（POS 登入模式） | 收到 `dine_in` 線上單 | 處理 |
|---|---|---|---|
| A | **堂食模式**（`operatingMode = dinein`） | 真·堂食單 | **需要「排位」**（本方案主體） |
| B | **快餐模式**（`operatingMode = quick`） | 有枱都唔會安排 | **當平常快餐 POS 單**：`tableId = "counter"`、出餐口自取、客人自己搵位 → **唔出「排位」掣** |
| C | 兩者 | `pickup` / `self_delivery` | 無枱，唔關事 |

**需求 1**：商家端要有「**排位**」掣 × 4 個入口（點餐快捷操作列表＋其查看彈窗／訂單頁線上訂單列表＋其查看彈窗）。
**需求 2**：線上單可能**已經付款**，同現有堂食單（落單→結帳）邏輯唔同 → 堂食點餐介面要**新增綠色「已結帳」狀態**，避免破壞現有邏輯。
**需求 3**：自動接單仍然自動接單＋打印，但**未 assign 座位、無枱號**時，狀態顯示「**待安排座位**」。

---

## 1. 現狀盤點：一半腳手架**已經存在**（呢個係可行性嘅關鍵）

| 已有嘅嘢 | 位置 | 意義 |
|---|---|---|
| `isLocalOrTransferredDineIn()`「本地單 ＋ **已轉到堂食枱嘅線上堂食單**」 | `src/lib/pos-order-filters.ts:11-19` | **設計上已經預留**「線上堂食單轉咗枱 → 當本地單管理」 |
| `LocalOrdersPanel` 用上面嘅 filter 撈單 | `local-orders-panel.tsx:149,165` | 只要線上單寫入 `orders` 且 `tableId` 係真枱，**自動出現喺「店內線下訂單」**（零改動） |
| 桌台佔用 = `openOrders`（draft/sent_to_kitchen/**paid**/reopened）→ `tableOrderMap` | `pos-app.tsx:1744-1754, 1836-1842` | 只要線上單以 **`paid` + 真枱號**寫入，**桌台卡片、佔用、快捷操作全部自動通** |
| 「排位」彈窗 UI | quick panel `assigningOrder`（`:738-770`）；online-orders（`:1071-1098`，文案已寫「選擇桌台後會接單、送廚，**並在收銀台建立堂食單**」） | 連**文案都已經寫住要建立本地堂食單** |
| 雲端欄位 `pos_orders.online_order_id` | `api/pos/sync/route.ts:751`；`pos-order-mapper.ts:75` | 雲端**支援**存放帶 onlineOrderId 嘅單 |
| 報表已處理「已同步入 POS DB 嘅線上單」去重 | `restaurant-daily-report.tsx:1698-1701, 1846-1859` | 即係**expected** 會有帶 `onlineOrderId` 嘅 POS 單，唔會雙計 |

### ⚠️ 但今日有 4 個缺陷令佢行唔通

1. **兩個 POS 介面都傳 `skipTableAssignment`**（`pos-app.tsx:4600`、`quick-mode-orders-bar.tsx:95`）→ 排位掣**根本唔會 render**；只有訂單頁 `/orders` 會出，但 `online-orders.tsx:517-521` 嘅自動接單又排除 `dine_in`（＝上一輪查到的「堂食單零 job」）。
2. **枱號只傳入 `bridgeLedgerOrderToPos()` → 只係 in-memory**（`bridgedOrders`），**冇任何持久化** → reload / 換頁即失，桌台總覽永遠唔會見到。
3. **「排位」同「接單」綁死**：`assignDineInTable() = runAcceptAndBridge(order, {tableId})`（`online-orders.tsx:644-650`）→ 已經自動接單／人手接咗之後**冇得再排位**；而對已 `accepted` 嘅單再行會打 `update_order_status('accepted')`，有機會 `invalid transition`。
4. **`pos-app` 兩處 render `QuickOnlineOrdersPanel` 冇傳 `tables`**（prop 預設 `[]`）→ 就算開咗彈窗，會顯示「尚未設定桌台，請至設置頁新增」。另外枱名格式唔一致（online-orders 用 `樓層 · 枱名`，quick panel 只用枱名）。

---

## 2. 三個必須拍板嘅決策（方案分岔嘅根源）

### D1 — 枱號／呢張單存去邊？

| 選項 | 做法 | 好處 | 代價 |
|---|---|---|---|
| **L1 只本機** | 新 store-scope key（`macau-pos/stores/<id>/online-table-map`），Ledger 單 id → tableId | 最細、唔掂契約 M3/M8、唔掂雲端 | **只喺呢部機有效**；第二部收銀／換機見唔到；桌台佔用只喺本機；reload 保留但清 cache 即失 |
| **L2 寫入 `orders`（本機＋`pos_orders`）** ⭐推薦 | id = `ledger-<ledgerId>`，帶 `onlineOrderId`、`tableId`、`status:"paid"` | 桌台佔用／店內線下訂單／快捷操作／報表**全部自動通**（因為上面第 1 節嗰批機制已經ready）；全店同步；報表已有去重 | **要明文修訂契約 M3/M8**（加一個「已轉枱線上堂食單」例外）；要保證唔會同 Ledger 雙寫衝突 |
| **L3 寫入 Ledger** | Ledger `orders` 加桌台欄位 / RPC | 最「正確」、跨裝置 | **要 Ledger 後端改動**（未知排期）；`acceptLedgerOrder()` 亦要跟住改 |

### D2 — 已付款嘅線上單入枱之後，「錢」點算？

- 現時堂食流程：`draft → sent_to_kitchen → settled`（收入口徑 `isSaleCountable()` 只計 `settled`；帶 `onlineOrderId` 嘅單 `paid` 或 `settled` 都計，`restaurant-daily-report.tsx:341-346`）。
- 線上單入枱時應寫 **`paid`**（＝已收款、但唔係「現場結帳」）→ **收入認列一次**，唔會同 Ledger feed 雙計（同一 `onlineOrderId`）。
- **未解決嘅業務問題**：入枱之後客人**加菜**點收？三個口徑揀一個：
  - (a) **唔准加菜**：枱上只係「座位指引」，加菜要另開本地單（收銀落單）→ 最安全，但雙單核對麻煩；
  - (b) **可以加菜，加菜另開一張本地單**（只收加菜錢）→ 收入正確，但同一張枱同時有兩張單，UI 要處理；
  - (c) **全單轉本地管理**（可加菜、可結帳、可返結）→ 體驗最好，但要改收入口徑（`paid` 單再加錢要變 `settled`），亦要解「返結」對線上單嘅意義。

### D3 — 唯一性

一張 Ledger 單 ↔ **最多一張** 本地單（`id = ledger-<ledgerId>`）↔ **最多一張**枱。重複排位 = 改枱（唔可以另開新單，否則收入雙計）。

---

## 3. 建議方案（我嘅推薦：L2 + 派生標籤）

### 3.1 資料
- 新增本地單：`id = "ledger-" + ledgerOrder.id`、`onlineOrderId`、`tableId`、`tableName`、`status: "paid"`（已付）／`sent_to_kitchen`（未付到店付款）、`prepaidAmount`、`source` 沿用 Ledger 渠道、`items` 由 `mapDetailToOrderItems()` 轉換（**直接用返 `bridgeLedgerOrderToPos()` 已經有嘅邏輯**）。
- 寫入：`saveOrders()`（本機）＋ `ORDER_CREATED` / `ORDER_UPDATED` 推上雲（`pos_orders.online_order_id` 已有欄）。
- **唔改** Ledger 側任何嘢。

### 3.2 狀態／標籤：**唔新增 `status` 值**（重點建議）

理由：`status` 係狀態機真源，牽扯 LWW 守門（2026-09-12 剛修嘅 `paid` 單向閘）、收入認列、返結、快餐雙標籤。加一個新值要全鏈路改。改用**派生標籤**（沿用 docs/113 快餐「出餐階段＋付款階段雙標籤」嘅做法）：

| 情境 | 訂單/出餐狀態 | **付款標籤** | **枱位標籤** | 「排位」掣 |
|---|---|---|---|---|
| 線上 dine_in、已付、未排位 | 待接單 / 已接單 | **已結帳（綠）** | **待安排座位（橙）** | ✅ 顯示 |
| 線上 dine_in、已付、已排位 | 已接單 / 製作中 | **已結帳（綠）** | 枱名（如 `A01`） | ✅ 顯示（文案變「改枱」） |
| 線上 dine_in、到店付款未付、未排位 | 已接單 | **未結帳（橙）** | 待安排座位 | ✅ |
| 到店付款、入枱後收咗錢 | 製作中/待取餐 | **已結帳（綠）**（由 `paid` 派生） | 枱名 | ✅ |
| 快餐模式嘅 dine_in 線上單 | 當快餐單 | 已結帳 / 未結帳 | **出餐口自取**（無枱） | ❌ 唔顯示 |
| 外賣自取 / 外送 | — | 同上 | 自取 / 外賣 | ❌ |

- 「**已結帳**」＝ `order.onlineOrderId && (paymentStatus === 'paid' || status === 'paid' || status === 'settled')` → **綠色**。
- 「**待安排座位**」＝ `tabType === 'dine_in' && !tableId && 本店係堂食模式`。
- 派生判斷放**純函式模組**（例如 `src/lib/pos/online-dinein-labels.ts`，零 `@/` 依賴）→ 可以 `npm run test` 覆蓋（跟 `quick-labels.ts` 先例）。

### 3.3 「排位」動作（**獨立於接單**，唔可以綁死）

```
assignOnlineOrderTable(order, table):
  ① 若 rawStatus === "pending" → 先 acceptLedgerOrder()（沿用現有）
  ② upsert 本地 PosOrder（id = ledger-<id>，帶 tableId/tableName/status）
     → saveOrders() + 推 ORDER_CREATED / ORDER_UPDATED（L2）
  ③ （可選）補印廚房單（帶枱名）——建議做，否則廚房唔知送去邊
  ④ toast：已排位 A01；卡片即時更新（dispatch pos-orders-changed）
```

- 已接單／自動接單之後**仍然可以按**（滿足需求 3 嘅「先接單、後排位」）。
- 重複按 = 改枱；需要 `removeTableAssignment()`（取消排位／客人走錯位）。
- 枱已被佔用：提示 + 允許強制（或只提示唔准，需要你定）。

### 3.4 快餐模式（依你嘅口徑）
- **唔出「排位」掣**；`dine_in` 線上單一律 `tableId = "counter"`、`tableName = 堂食取餐`（`ledger-pos-bridge.ts:276-280` 已經係咁）。
- ⚠️ **注意**：`isQuickCounterOrder()` = `isLocalPosOrder() && tableId === "counter"`（`pos-order-filters.ts:22-23`），而 `isLocalPosOrder()` = `!onlineOrderId` → **線上單唔算快餐 counter 單**，所以今日快餐「製作中／待取餐／可取餐」流程**撈唔到**線上單（`pos-app.tsx:1781,1801` 亦明文 `!order.onlineOrderId` 排除）。
  → 若你要快餐模式嘅線上單都行「可取餐 → 完成」，就**必須**走 L2（寫入 `orders` 做 counter 單）＋放寬嗰幾個 filter；否則快餐模式維持「線上單只喺線上訂單面板顯示」。（**需要你確認快餐模式要邊種**）

---

## 4. 四個入口（UI）

| # | 位置 | 檔案 | 做法 |
|---|---|---|---|
| 1 | 點餐介面 →「快捷操作」線上訂單**卡片** | `quick-online-orders-panel.tsx` `renderOrderCard` | 卡片底部加「排位」（沿用 `onlineOrderActionButtonClass` 風格；觸控 ≥40px） |
| 2 | 點餐介面 → 同一面板嘅**「查看」彈窗** | 同上 | 彈窗 actions 一行加「排位」 |
| 3 | 訂單頁 → 線上訂單**列表** | `online-orders.tsx:1102,1142` `renderOrderActions` | 同上（注意操作欄寬度，docs/113 有「按鈕換行」前科 → 用 2 字標籤＋`whitespace-nowrap`） |
| 4 | 訂單頁 → **「查看」彈窗** | 同上 | 同上 |
| 附 | 排位彈窗本體 | 兩邊共用一個元件（樓層分組、`grid-cols-2 md:grid-cols-4`、枱名＋樓層、已被佔用要標示） | 建議抽 `TableAssignModal`，順手統一枱名格式（用枱名，樓層做副標） |

---

## 5. 可行性評估

| 層 | 內容 | 工作量 | 風險 |
|---|---|---|---|
| **L1（只本機映射）** | 新 storage key + 四個入口 + 派生標籤 | ½～1 日 | 低（唔掂雲端/契約），但**價值有限**：桌台總覽唔會變、第二部機睇唔到 |
| **L2 ⭐** | L1 ＋ 寫入 `orders`/`pos_orders`（帶 `onlineOrderId`）＋ 桌台佔用自動生效 | 1.5～2.5 日（含測試） | 中：要修訂契約 M3/M8 嘅文字與守門；要驗證收入無雙計、LWW 唔會把 `paid` 打回；要驗證 `ORDER_UPDATED` 對帶 onlineOrderId 嘅單唔會整污糟同步 |
| **L3** | Ledger 落枱號 | 需後端 | 高（跨團隊、排期未知）→ 唔建議一期做 |
| 附加 | 「已結帳／待安排座位」派生標籤 | ½ 日 | 低；但要同步 5 處（types / 標籤真源 / UI / 測試 / docs） |
| 附加 | 快餐模式 counter 化 | ½ 日 | 中：要放寬 4 處 `!order.onlineOrderId` 過濾，影響面要逐個覆核 |

**技術風險清單**
1. **收入雙計**：唯一防線係「一張 Ledger 單只可以有一張本地單（`ledger-<id>`）」——upsert 唔可以 append。
2. **LWW**：寫入用 `clientUpdatedAt`（同 server 同鐘域，見 docs/113 8/9-12 修）；`paid` 係單向閘，唔可以被舊 snapshot 降級 —— 呢一點對「線上已付單入枱」反而係保護。
3. **返結**：`docs/115` 明言「純線上快餐／自取唔喺本地面板管理，**亦唔可以返結**」；已轉枱嘅線上單要唔要准返結？我建議**唔准**（返結要沖 Ledger，冇 RPC）。
4. **取消要釋放枱**：線上單取消 → 本地單要跟住 `cancelled`，否則枱面永遠卡住佔用。
5. **打印**：排位後枱名變 → 建議補印一張廚房單（帶枱名 + 標記「排位」），否則廚房唔知送邊；同時解決上一輪查到嘅「線上單廚房 job 冇 template 快照」問題。
6. **快餐／堂食模式切換**：同一部機切模式後，舊嘅已排位單點顯示？建議：`tableId === "counter"` 嘅單喺堂食模式顯示為「快餐」，唔參與枱面佔用。

---

## 6. 分階段建議

- **P1（最小可用）**：L2 基礎（寫入 orders + 桌台佔用）＋「排位」四入口＋派生標籤（已結帳／待安排座位）。
- **P2**：快餐模式 counter 化（若你要）、加菜口徑（D2）、取消/完成時釋放枱、補印廚房單。
- **P3**：Ledger 後端落枱號（L3，可選）。

---

## 7. 要你拍板嘅問題

1. ~~**D1**：枱號存邊度？~~ → **已定：L2（寫入 orders／`pos_orders`）**
2. ~~**D2**：加菜口徑？~~ → **已定：(c) 全單轉本地管理（可加菜／結帳／返結）**
3. ~~**快餐模式**：`dine_in` 線上單要唔要行「可取餐→完成」？~~ → **已定：要，當快餐 counter 單處理**
4. 枱衝突：枱已被佔用時，允許強制換位／覆蓋，定係只提示唔准？
5. 返結：已排位嘅線上單准唔准返結？（見 §9 風險）

---

# 8. 定案 v2（2026-09-12 · 按三個已選口徑收緊）

## 8.1 好消息：「全單轉本地管理」唔需要改結帳引擎

`prepaidAmount` **已經全鏈路接通**，唔使新造：

| 環節 | 位置 | 行為 |
|---|---|---|
| 結帳應收 | `pos-app.tsx:1908` | `payableBeforeMember = max(0, total − discount − prepaidAmount)` → **自動只收差額** |
| 結帳彈窗 | `pos-app.tsx:6237-6247` | 顯示「已付（預付）／剩餘需收／應收」 |
| 桌台卡片 | `pos-app.tsx:4466` | 顯示 `max(0, total − prepaid)` ＝枱上仍欠 |
| 已結帳判斷 | `pos-app.tsx:5934` | `status === "paid" \|\| prepaidAmount >= total` |
| 交班單 | `shift-page.tsx:85` | `prepaid` **獨立一欄**，唔會混入現金 |
| 本地／雲端 mapper | `pos-order-row.ts:64` / `pos/pos-order-mapper.ts:74` / `api/pos/sync/route.ts:750` | 欄位齊 |
| 收入認列 | `restaurant-daily-report.tsx:341-346` | **同一張單**：`paid` 或 `settled` 只認一次 → **零雙計** |

⇒ **入枱寫入規則**：
- 線上已付 → 本地單 `status: "paid"`、`prepaidAmount = ledgerOrder.total`（＝全額已收）
- 到店付款未付 → `status: "sent_to_kitchen"`、`prepaidAmount = 0`（入枱後照正常堂食流程結帳）
- 客人加菜 → 本地單 items/total 增加 → 結帳時 `payable = 加菜金額` → 結帳後 `settled`
- **永遠用同一張本地單**（`id = ledger-<id>`）→ 收入天然只認一次

## 8.2 快餐 counter 化：影響面已逐一查清（改 3 處，唔改 4 處）

**要改（3 處）**
| 位置 | 現狀 | 改成 |
|---|---|---|
| `pos-order-filters.ts:22-23` `isQuickCounterOrder()` | `isLocalPosOrder(order) && tableId === "counter"` → 線上單唔算 | 放寬為「本地單 **或** 帶 `onlineOrderId` 嘅單」且 `tableId === "counter"`。連帶 8 個使用點（`local-orders-panel.tsx:93/570/763`、`pos-app.tsx:5701/5945`、`quick-local-orders-strip.tsx:109`、`pos-order-filters.ts:328/341/380/432/438`）**自動正確** |
| `pos-app.tsx:1781` `actionBarLocalOrders` | `.filter(o => o.tableId === "counter" && !o.onlineOrderId)` | 移除 `!onlineOrderId`（快餐 strip 要見到線上快餐單） |
| `pos-app.tsx:1801` `counterKioskOrders` | 同上 | 同上（「自取／掃碼訂單」面板） |

**唔需要改（4 處，而且刻意保持排除）**
| 位置 | 為何保持 |
|---|---|
| `updateQuickFulfillmentInStore()`（`quick-order-fulfillment.ts:28-33`） | 只查 `tableId === "counter"` + 允許狀態（draft/sent_to_kitchen/paid），**冇** `onlineOrderId` 守門 → 寫入後「可取餐」直接生效 ✅ |
| `pos-app.tsx:2142` `resolveExistingOrderForUpsert` | 線上單**唔應該**做新訂單嘅合併目標（同 `paid` 單向閘一致）→ 保持 `!order.onlineOrderId` |
| `pos-app.tsx:2896` `findVoidableTableOrder`（退桌） | 退桌係「枱」嘅操作，`tableId !== "counter"` 已經擋住；線上單唔應該被當枱單退 |
| `api/pos/orders` 清除線下單 | 已經 `.is("online_order_id", null)`（`route.ts:63-69`）→ 自動保護 |

## 8.3 標籤定案（唔新增 `status` 值）

| 情境 | 本地單 `status` | 付款標籤 | 枱位標籤 |
|---|---|---|---|
| 堂食模式 · 線上已付 · 未排位 | `paid` | **已結帳（綠）** | **待安排座位（橙）** |
| 堂食模式 · 線上已付 · 已排位 | `paid` | 已結帳（綠） | 枱名（`A01`） |
| 堂食模式 · 到店付款 · 已排位、未收錢 | `sent_to_kitchen` | 未結帳（橙） | 枱名 |
| 快餐模式 · `dine_in` 線上單 | `paid`（已付）／`sent_to_kitchen`（到店付款） | 已結帳／未結帳 | **出餐口自取（無枱）** |
| 外賣自取 / 外送 | 同上 | 同上 | 自取／外賣 |

派生判斷收喺零依賴純函式（建議 `src/lib/pos/online-dinein-labels.ts`，跟 `quick-labels.ts` 先例 → 可 `node --test`）。

## 8.4 落地模組清單（待你批准後開工）

1. `src/lib/pos/online-order-labels.ts`（新，零依賴）：`isOnlineDineInAwaitingTable()` / `onlinePaymentBadge()` / 前端語義
2. `src/lib/ledger/ledger-pos-bridge.ts`：
   - 新增 `assignLedgerOrderToTable(order, tableId, tableName)` → upsert 本地 `PosOrder`（`ledger-<id>`）＋ `saveOrders()` ＋ 推 `ORDER_CREATED`/`ORDER_UPDATED`
   - ⚠️ 同時修返上兩輪查到嘅 P0：`printKitchenForLedgerOrder()` 補寫 `bridgedOrders`
3. `src/components/online-orders.tsx` ＋ `quick-online-orders-panel.tsx`：`assignDineInTable()` 改成**獨立於接單**（先接單（如需）→ 再排位）；四個入口加「排位」掣
4. 共用 `TableAssignModal`（樓層分組＋枱名＋已被佔用標示）；`pos-app` 兩處 render 補傳 `tables`
5. `src/components/local-orders-panel.tsx` / `pos-app.tsx`：快餐 counter 化（§8.2 三處）
6. 測試：`pos-order-filters.test.ts` 加線上 counter 單案例；新 labels 模組加單元測試
7. docs：`docs/113` 補「線上堂食單排位」一節；契約 M3/M8 修訂文字

## 8.5 分期

| 期 | 內容 |
|---|---|
| **P1** | 堂食模式：排位四入口 ＋ 寫入 orders（`paid` + `prepaidAmount`）＋ 桌台佔用 ＋ 派生標籤（已結帳／待安排座位）＋ 補印廚房單 |
| **P2** | 快餐模式 counter 化（§8.2）＋ 取消/完成時釋放枱 ＋ 加菜（結帳只收差額）驗收 |
| **P3** | 返結保護（見 §9）＋（可選）Ledger 落枱號 |

---

# 9. 一個必須處理嘅風險：**返結 vs 線上已付金額**

`prepaidAmount` 令「結帳只收差額」完全正確，但 **返結（`reopenOrder()`，`pos-orders.ts:150-209`）冇任何 `onlineOrderId` 守門**：

- 返結 = 把 `settled` 打返 `reopened` 再修正金額 → 但**線上已付嗰筆錢喺 Ledger，POS 冇 RPC 可以沖正**
  （只有客人取消／改單走 `merchant_resolve_order_change`）。
- 如果照樣返結，可能出現「POS 帳面話未收，但客人已經畀咗錢」→ 交班／報表口徑混亂。

**我嘅建議（三選一，請你定）**：
- **(甲) 一期唔准返結**：帶 `onlineOrderId` 嘅單隱藏「返結」掣，文案引導去 Ledger 側處理取消／改單。← 最安全，我推薦
- **(乙) 准返結但只准改本地加菜部分**：`prepaidAmount` 鎖死唔可改，單據大字標「線上已付 MOP xx 不會沖正」。
- **(丙) 照准返結**：接受帳面與 Ledger 可能唔一致（要明文寫入 docs/113 做已知限制）。

---

# 10. 實作記錄（2026-09-12 · 已完成並通過 typecheck / test）

商家定案：**D1 = L2 寫入 orders／pos_orders**、**D2 = (c) 全單轉本地管理**、
**返結 = (乙) 准返結但 `prepaidAmount` 鎖死 + 單據標明**、
**枱衝突 = 已佔用嘅枱唔可以揀（彈窗）**、**快餐模式 = 要行可取餐→完成（下一批）**。

## 10.1 已落地

| # | 檔案 | 內容 |
|---|---|---|
| 1 | `src/lib/pos/online-dinein-labels.ts`（新） | 零依賴純函式：`needsTableAssignment()`（快餐模式永遠 false）、`onlineTableBadge()`（待安排座位／枱名／出餐口自取／自取／外賣）、`onlinePaymentBadge()`（已結帳綠／未結帳）、`onlineTableAssignLabel()`（排位／改枱）、`isTableSelectable()` |
| 2 | `src/lib/pos/online-dinein-labels.test.ts`（新） | 12 個回歸測試（**189 pass**，原 177） |
| 3 | `src/components/table-assign-modal.tsx`（新） | 排位彈窗：樓層分組、**已佔用枱 disable + 「使用中」**、觸控 ≥40px |
| 4 | `src/lib/ledger/ledger-pos-bridge.ts` | ① **`assignLedgerOrderToTable()`**：upsert 本地單（`ledger-<id>`、`status` 依付款狀態、`prepaidAmount` 已付＝全額）＋ `saveOrders()`（自動廣播）＋ `ORDER_CREATED/UPDATED` 上雲 ＋ 補印帶枱名廚房單；② `registerLedgerProjection()` 統一寫 in-memory ＋ **持久投影快取**（修好「重打整單」永遠失敗）；③ 廚房 job 補 **`content` + `template` 快照** |
| 5 | `src/lib/storage.ts` | 新增 `ledgerOrderCache` key ＋ `loadLedgerOrderCache()` / `cacheLedgerPosOrder()`（上限 50，LRU） |
| 6 | `src/lib/print-jobs.ts` | `findPosOrderForLedger()` 加持久快取層；`KitchenPrintOpts.orderNoteOverride`；**返結單自動加「線上已付 … 不會沖正」** |
| 7 | `src/components/quick-online-orders-panel.tsx` | 卡片（strip / stack）＋ 查看彈窗 加「排位／改枱」掣；雙標籤（已結帳 / 待安排座位）；接單**唔再**被安排桌台攔住；自動接單失敗唔再全靜默；成功 toast 帶「有冇真係送咗廚」 |
| 8 | `src/components/online-orders.tsx` | 列表＋查看彈窗加「排位」；「接單並安排桌台」→「接單」；排位改為獨立動作（走新 bridge）；查看彈窗顯示兩個派生標籤 |
| 9 | `src/components/pos-app.tsx` | 傳 `tables` / `tableAssign`；`assignableTables`（剔除返結 temp 枱）；`onToast` **唔再**把 error 降級；返結彈窗加「線上已付 … 不會沖正」紅字 |
| 10 | `src/components/print-center.tsx` | 狀態欄加「**未上雲**」紅標（`sent` ＋ queue 仍有未 synced `PRINT_JOB_CREATED`）→ 解決「卡住已發送、零紅標、唔會自我修正」 |

驗證：`npm run typecheck` ✅、`npm run test` **189/189** ✅、
`eslint` 對改動檔案 **0 新 error / 0 新 warning**（print-center 本身有 16 個既有 error，已用 `git show HEAD:` 對照確認唔係今次引入）。

## 10.2 第二批：快餐 counter 化（同日完成）

商家確認「快餐模式本地按完成之後，要順手將 Ledger 張單設做 completed」。

| # | 檔案 | 內容 |
|---|---|---|
| 1 | `src/lib/pos-order-filters.ts` | 🔴 **`isQuickCounterOrder()` 移除 `isLocalPosOrder()` 條件** → 線上 counter 單算快餐單（連帶 8 個使用點：strip、標籤、分頁、訂單詳情彈窗全部自動正確）。本地／線上分工仍然由 `isLocalOrTransferredDineIn()` 把關（線上 counter 單返 false → 唔入店內線下訂單） |
| 2 | `src/components/pos-app.tsx` | `actionBarLocalOrders` / `counterKioskOrders` 移除 `!order.onlineOrderId` |
| 3 | `src/lib/ledger/ledger-pos-bridge.ts` | 新增 **`adoptLedgerOrderAsQuickCounter()`**；upsert 邏輯抽成共用 `upsertLedgerLocalOrder()`（排位／採納同一入口，保證永遠只有一張本地單） |
| 4 | `src/lib/pos/online-quick-fulfillment.ts`（新） | **`syncOnlineQuickFulfillment()`**：把 Ledger 狀態推進到 `ready` / `completed`；因為 Ledger 只接受逐級轉換而 POS 冇存 Ledger 當前狀態，所以**由頭爬梯**（preparing → ready → completed），「狀態唔啱」＝已經過咗嗰級就繼續，其餘錯誤即刻回報。冪等 → 重複撳唔會拋錯 |
| 5 | `src/lib/quick-order-fulfillment.ts` / `pos-app.tsx` | 四個「可取餐／完成」寫入點全部掛上背景回寫（失敗 `console.error` + toast，唔靜默） |
| 6 | `src/components/quick-online-orders-panel.tsx` | 新增 **`quickCounter`** prop（快餐模式採納成本地 counter 單）；⚠️ 同時修正一個自查出嚟嘅 bug：枱位標籤原本用 `skipTableAssignment` 做 `quickMode`，但**堂食模式一樣傳 true** → 會令堂食單標籤變成「出餐口自取」。改用獨立旗標 |
| 7 | `src/components/quick-mode-orders-bar.tsx` / `online-orders.tsx` | 快餐 bar 傳 `quickCounter`；訂單頁按 `loadOperatingMode() === "quick"` 一樣採納（唔會因為收銀喺訂單頁接單而漏咗採納） |
| 8 | `src/lib/pos-order-filters.test.ts` | 加 6 個回歸測試（採納後算快餐單、唔入線下訂單、真枱單唔受影響、已結帳標籤、終態唔入 strip） |

驗證：`typecheck` ✅、`npm run test` **195/195** ✅、`eslint` 對全部改動檔案 **0 新 error / 0 新 warning**。

### 已知限制（刻意留低，唔係漏做）

1. **快餐 strip 對「非自助單」唔出「結帳」掣**（`showSplitActions` 要求 `isSelfOrder()`）。
   採納嘅線上單 `source` 係 `pos`（`pos_orders_source_check` 只准 `pos/kiosk/scan`，
   加新值要 migration，唔想冒「code 先上、migration 後跑」嘅風險）→
   到店付款未收錢嘅線上快餐單，收銀要喺點餐介面結帳區收錢（同本地快餐單一致）。
2. **反向同步（Ledger → 本地）未做**：若另一部機／Ledger 側將單設做 `completed`，
   本地採納單仍然係 `paid` + `ready`（收銀可以照撳「完成」，Ledger 會係 idempotent 無變化）。
3. **取消／退款一律唔行 `update_order_status`**：要繼續走 `merchant_resolve_order_change`。
