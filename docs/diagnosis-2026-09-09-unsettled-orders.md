# 診斷：13 張「未結帳」訂單（表嫂美食 2026-09-09）

> 來源：`pos_orders` CSV 匯出（含 3 間店資料）+ 當日營業報表截圖。
> 涉事店：`8291f843-9def-4956-9d0b-1cfef2598306`（表嫂美食，export 內含「表嫂雞飯」菜式）。
> 時間一律以澳門時間（UTC+8）標示；DB 存 UTC，換算無誤。

## 一、結論（一句講完）

**報表冇錯，錯喺資料本身：呢 13 張單喺雲端 `pos_orders` 入面嘅 status 仍係 `sent_to_kitchen`（已送廚房），結帳寫入從來冇落過 DB。**
「未結帳」係報表對「非 settled/paid、非 cancelled/refunded」訂單嘅正確分類——13 張全部屬「已送廚房（未結帳）」分組，金額加埋 = MOP 762，同截圖 KPI 完全脗合。

## 二、數據核對（點解肯定係呢 13 張）

涉事店當日（澳門 09-09 = UTC 09-08 16:00 → 09-09 15:59）共 17 張有效單：

| 結算狀態 | 張數 | 金額 | 單號 |
|---|---|---|---|
| ✅ settled（已結帳） | 4 | MOP 141 | 訂單01 / 訂單05 / 訂單08 / 訂單15 |
| ⚠️ sent_to_kitchen（未結帳） | **13** | **MOP 762** | 訂單02,03,04,06,07,09,10,11,12,13,14,16,17 |
| 🚫 cancelled | 0 | — | （本日冇；cancelled 單全部喺 09-08） |

**關鍵指紋（一條 rule 篩出晒 13 張）：`status = sent_to_kitchen` AND `updated_at = created_at` AND `payment_method = ''` AND `served_at = NULL`。**
即：呢批單由建立到而家，DB 一行 update 都冇收過——冇結帳、冇 serve、冇付款方式。
對照 4 張成功結帳單，全部 `updated_at > created_at`、`served_at` 有值、`payment_method` = Mpay／現金。

另外 CSV 內其他兩間店（`d564b932`=牛腩麵店、`f6ec837a`=叉燒飯店）嘅單並冇混入，報表 store 隔離正常運作，排除「跨店污染造成誤報」。

## 三、重點檢查清單（13 張全列 + 標記）

| 訂單 | 桌/渠道 | 總額 | 下單(澳門) | 異常特徵 |
|---|---|---|---|---|
| 🔴 訂單02 `7014e2a6` | A02 | 43 | 10:30 | 全店最早未結；同行 訂單01(10:26) 已喺 13:52 結帳，隔成 3.5h |
| 🔴 訂單03 `6ef2d50b` | A03 | 53 | 11:18 | 單上有備註「待定时间五谷飯」 |
| 🔴 訂單04 `4a5ed329` | MFOOD1（收銀/外賣機） | **156** | 11:28 | 全日最大額未結（4 餸 156） |
| 🔴 訂單06 `89b271c5` | 外賣自取2 | 48 | 11:35 | 外賣單應即時結帳；對比 2 分鐘前嘅 外賣自取1(`bad206c1`) 已結 |
| 訂單07 `42b3eaa2` | A04 | 43 | 11:46 | 備註「1250五谷」 |
| 🔴 訂單09 `0c0110fe` | A02 | **120** | 12:47 | 第二最大額；備註「叉燒蛋五谷飯1330」（1330 先出餐） |
| 訂單10 `d36927fd` | A03 | 60 | 12:56 | — |
| 訂單11 `f96da08c` | A05 | 54 | 13:02 | — |
| 訂單12 `d20181d0` | A06 | 45 | 13:09 | — |
| 訂單13 `fd5cfa6d` | A02 | 38 | 13:31 | — |
| 訂單14 `c9b33e5b` | A03 | 42 | 13:39 | — |
| 訂單16 `e41076f1` | A01 | 55 | 14:08 | — |
| 訂單17 `7fd34d01` | A01 | 5 | 14:09 | 單價 5（例湯） |

共性：**成功結帳單同未結帳單喺時間線上互相穿插**（10:26 ✅ → 10:30 ❌ → 11:28 ❌ → 11:33 ✅ → 11:35 ❌ → 12:08 ✅ → …），
唔似「某一時段成部機離線」，而似「逐張單嘅結帳事件冇上雲 / 被吞」。

## 四、可能成因（按機率排序，逐項驗證）

1. **結帳流程根本未行完**（付款方式冇揀／確認框冇完成／MPay 彈窗冇確認）→ `payment_method` 全空係最大疑點。
   驗證：開返部收銀機睇呢啲單而家顯示係「已送廚房」定「已結帳」。
2. **結帳 ORDER_UPDATED 事件留喺本機 queue 未上雲**（離線結帳 → reconnect 冇推成功；attempts≥5 標 failed 後**永久唔重試**；或事件冇 storeId 被 classify 做 `skipped`）。
   驗證：每部機「設備設置→同步」睇 pending/failed 數；開 devtools 睇 `[pos-sync-flush]` 同 `POS_SYNC_FAILED_EVENT`（試過會 console 有 log）。有 failed 就按「重試失敗同步」。
3. **事件上咗雲但 server 套用 0 行、靜默失敗**（`ORDER_UPDATED` 比 `ORDER_CREATED` 更早被套／storeId 唔 match 被拒）——codebase 已記錄呢個 pitfall（server `.update()` 命中 0 列唔會報錯）。
   驗證：查 `/api/pos/sync` server log，睇呢啲 order id 有冇 200 但冇 update。
4. **喺另一部機做結帳**（嗰部機 snapshot 冇呢張單，結帳事件唔生成／生成咗都打唔中）。

## 五之二、現場核對結果（15:2x，用戶補圖）——「本機已完成、雲端未完成」

用戶喺 iPad「訂單」頁（/orders）截圖，右欄「店內線下訂單 共17張」，可見 訂單15/16/17 全部標綠色「已完成」，每張附橙色「返結帳」掣。

**程式碼佐證（呢個 combo 唔可能出錯）：**
- `pos-order-filters.ts getOrderStatusBadge()`：`settled` → 綠色「已完成」；`sent_to_kitchen` → 琥珀「製作中」。
- `local-orders-panel.tsx` L470：「返結帳」掣只喺 `order.status === "settled" && isReopenable(order)` 先 render。

即係話：**喺嗰部 iPad 本機（localStorage）層面，員工真係結咗帳（status=settled）——員工冇講錯。**
但雲端 `pos_orders`（15:07 匯出）對 訂單16/17（及其他 11 張）仍然係 `sent_to_kitchen`、`updated_at=created_at`、無付款方式、`served_at=NULL`。

→ 結論：**結帳動作喺本機成功，但 ORDER_UPDATED(settled) 事件從未成功到達／套用喺雲端 DB。**「本機已完成」與「雲端未完成」並存，日報／後台以雲端 DB 為準，所以仍然顯示 13 張未結帳。

**「在線」綠標代表乜：**`app-sidebar.tsx` L133-147 —— 綠「在線」= `networkOnline`（瀏覽器網絡已連接），**唔係**同步隊列健康度。部機在線 +「自動同步」開，但雲端冇收到嗰啲結帳更新，正正反證：**在線 ≠ 已同步**。`sync-flush.ts` 只會推 `attempts<5` 且屬當前店嘅 pending 事件；status=failed（attempts≥5）或 skipped（無 storeId／GC 分類）嘅事件**永久唔會再自動重試**（L209、L322-338），要人手「重試失敗同步」（`retryFailedSyncEvents`）先救得返。

## 五、建議修復動作

1. **即刻對帳**（read-only SQL，唔好改嘢）：
   ```sql
   SELECT id, local_order_no, table_name, status, payment_method, total,
          created_at, updated_at, sent_to_kitchen_at, served_at
   FROM pos_orders
   WHERE store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
     AND created_at >= '2026-09-08T16:00:00Z' AND created_at < '2026-09-09T16:00:00Z'
     AND status <> 'cancelled'
   ORDER BY created_at;
   ```
2. **逐部收銀機核對** 訂單02~17 而家 UI 顯示狀態：
   - 顯示「已結帳」→ 事件未上雲 → 行「重試失敗同步」／重新整理再同步，然後重跑查詢。
   - 顯示「已送廚房」→ 當刻真係未結帳（成因 1／4）→ 攞返單、揀付款方式補結帳。
3. **查 sync 隊列**：`localStorage['pos_sync_queue']` 內有冇呢啲 order id 嘅 pending/failed event。
4. 修復後再入報表確認「未結帳」KPI 歸零先收工。
