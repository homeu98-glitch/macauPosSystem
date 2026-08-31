# 83 · 掃碼 / Kiosk 下單：打印流程 + 人工確認設定（需求盤點與實作 Plan）

> 狀態：**待決策**（需求盤點完成，未動代碼）。
> 提出日期：2026-08-31。相關設計：`docs/40-customer-self-order-kiosk.md`、實作記錄 `docs/41-kiosk-p1-implementation.md`。

---

## 0 · 一句結論

| 需求 | 結論 |
|------|------|
| **1 · 打印流程** | **部分已定義，但缺 6 項關鍵規格**。最嚴重：Kiosk 廚房單**完全繞過商家打印模板系統**（無 `template` / `content` 快照），出紙格式同店內落單唔一致；而且 DB 表根本冇欄位裝呢啲資料。 |
| **2 · 人工確認 Setting** | **資料模型已存在**（`PosLocalSettings.kioskKitchenMode`），但 **3 處斷鏈令功能等於未上線**：① 無設定 UI；② 設定讀錯部機（讀 Kiosk 自己 localStorage 而唔係收銀設定）；③ 確認得一個 2.6 秒 toast，冇彈窗冇明細。**另外需求描述本身有 8 處模糊，需先定案。** |

> 附帶發現（P0 級）：即使開咗「需要確認」，**廚房單會喺確認之前就印咗出嚟**，而且確認之後會**再印多一次**（一式兩份）。見 §2.1 / §3.4。

---

## 1 · 現況盤點（代碼事實，全部有檔有行號）

### 1.1 落單路徑（手機掃碼 / 平板 Kiosk 係同一條）

```
客人 手機掃枱 QR → /menu?store=..&tableId=A01    ┐
客人 店內平板   → /order?tableId=A01             ┴→ 共用 useKioskOrder()
   （src/lib/use-kiosk-order.ts，含 landing gate / 餐牌 / 購物車 / 規格 / resume）
   ↓ placeOrder()            （use-kiosk-order.ts:329-393）
   ├ POST /api/pos/sequence   攞店內同日序號（堂食→pos / 自取→pickup / 外賣→delivery）
   ├ buildKioskOrder()        （kiosk-order.ts:81）
   ├ buildKioskKitchenPrintJobs()  （kiosk-order.ts:166）← ⚠️ 無條件呼叫
   └ submitKioskOrder()       （kiosk-order.ts:196）
        → POST /api/pos/sync  事件：ORDER_CREATED（或 ORDER_UPDATED）+ N× PRINT_JOB_CREATED
        → server service_role 寫 pos_orders + pos_print_jobs
```

收銀端接收（`src/components/pos-app.tsx`）：

- `usePosRealtime(kioskStoreId, …)`（:691）
- `onOrderUpsert`（:692）→ 合併入 `orders`；若 `status === "draft"` 且係堂食枱 → `setToast`（:702-703）
- `onPrintJobUpsert`（:706）→ 合併入本地 `printJobs`（localStorage）
- `PrintFlushWorker`（`src/components/print-flush-worker.tsx`，**每 2.5 秒**，掛喺 `src/app/layout.tsx:55`）
  → `flushPendingPrintJobs()`（`print-bridge/dispatch.ts:25`）→ **所有 `status === "pending"` 嘅 job 一律送出，無任何訂單狀態判斷**

### 1.2 打印：收銀落單 vs Kiosk 落單（對照表）

| 項目 | 收銀 `buildKitchenPrintJobs`<br>`print-jobs.ts:95-142` | Kiosk `buildKioskKitchenPrintJobs`<br>`kiosk-order.ts:166-188` |
|---|---|---|
| 目標打印機來源 | `loadDeviceConfig().printers` filter `enabled && role==="zone"`，寫入 `printerId` | 淨用 `order.items` 嘅 `printerGroup`，**無 `printerId`** |
| 打印機名 `printerName` | 真機名（`printer.name`） | `zoneNames[group] ?? group`（原始 zone id，如 `kitchen`） |
| **模板快照 `template`** | ✅ `buildSnapshot("kitchen", kitchenTemplate)` | ❌ **完全冇** → 通道 fallback 硬編渲染 |
| **靜態內容 `content`** | ✅ store_name / order_no / table_name / **order_type** / **time** / order_note / footer | ❌ **完全冇** |
| 禁用打印機 | ✅ filter `enabled` | ❌ 唔理，一律出 job |
| 空分區跳過 | ✅ `matched.length === 0 → continue` | ❌ 每個 group 都出 |
| 加單 / 重打標記 | ✅ `ticketType: "addon"`、`orderNoSuffix " (重打)"` | ❌ 一律 `ticketType: "normal"` |
| 單價 / 金額 | 唔印（同 Kiosk） | 唔印 |
| `storeId` / `ttl`（relay 用） | 由 persist 層補 | ❌ 冇 |

**加劇因素（跨機同步會丟模板）**：
`/api/pos/sync` 嘅 `PRINT_JOB_CREATED` 分支（`src/app/api/pos/sync/route.ts:93-111`）只寫 11 個欄位：
`id / store_id / order_id / order_no / table_name / ticket_type / printer_group / printer_name / items / status / created_at`。
**`template`、`content`、`printerId` 三個欄位全部冇寫入 DB**；而 `pos_print_jobs` 表本身（`supabase/migrations/0011_pos_core_tables.sql:61` + `0012_pos_schema_reconcile.sql:34-43`）**亦無呢啲欄位**。

→ 後果：
1. Kiosk 單 100% 冇模板、冇店名、冇時間、冇落單類型、冇結尾語。
2. 就算係收銀自己建嘅單，**換另一部收銀經 realtime 拉返嚟都一樣冇模板**。

### 1.3 打印份數（現況唯一機制）

- 份數唯一來源 = `DevicePrinterConfig.copies`（`src/lib/types.ts:201`，可選，預設 1）
- `dispatch.ts:117`：`copies = Math.max(1, Math.floor(printer.copies ?? 1))`，之後 native / companion / relay 各自 `for (i=0;i<copies;i++)` 逐份送
- **冇「每張單印 N 份」嘅訂單級設定**
- **冇客人收據 / 取餐號單**（`docs/40` §8 有設計，P1 未做，見 `docs/41` 範圍）

### 1.4 確認設定 `kioskKitchenMode` 現況

已存在：

| 位置 | 內容 |
|---|---|
| `src/lib/types.ts:334-339` | `kioskKitchenMode: "auto" \| "dine_in_confirm"`（註解：堂食單落 `draft` 等收銀確認） |
| `src/lib/mock-data.ts:485` | 預設 `"auto"` |
| `src/lib/storage.ts:288-289` | `normalizePosLocalSettings` 有 normalize |
| `src/lib/kiosk-order.ts:105-125` | `dine_in` + `dine_in_confirm` → `status:"draft"`、`fulfillmentStatus: undefined`；**quick（自取/外賣）永遠 `sent_to_kitchen`** |
| `src/lib/use-kiosk-order.ts:161` | `const kitchenMode = loadPosLocalSettings().kioskKitchenMode;` |
| `src/components/pos-app.tsx:701-704` | `draft` 堂食單到達 → `setToast({ tone:"info", message: "X 枱已落單，請確認" })` |

**斷鏈清單**：

| # | 斷鏈 | 證據 |
|---|---|---|
| **A** | **無設定 UI**——商家無辦法改 | 全 repo grep `kioskKitchenMode` 只得 7 處（type / default / normalize / builder / hook），**settings 頁零 toggle**。`device-settings.tsx:646` 嘅「掃碼點餐」tab 只 render `<KioskQrPanel />`（QR 生成）。另外 `activeTab` union 有 `"online-orders"`（:56）但**根本冇對應 render block**，該 tab 已被移除 |
| **B** | **讀錯部機**——設定落喺收銀，讀喺 Kiosk | `use-kiosk-order.ts:161` 讀 `loadPosLocalSettings()` = **Kiosk / 客人手機自己嘅 localStorage**（永遠係 default `"auto"`）。Kiosk 唔會 call `loadRuntimeState()`（嗰個係 `pos-app.tsx` 專用），所以 server 份都唔會讀 → **dead code** |
| **C** | **確認得一個 toast**——冇彈窗冇明細 | `Toast` 型別（`pos-app.tsx:75-78`）得 `tone` + `message`，**無 action button**；`pos-app.tsx:564` 2.6 秒自動消失。冇待確認佇列、冇持久化、`draft` 單喺枱圖只顯示「未下單」（:2936），**同員工自己開嘅 draft 單無從分辨** |
| **D** | **確認前已經出咗單** | `use-kiosk-order.ts:377` 無條件 `buildKioskKitchenPrintJobs()`，唔理 `kitchenMode`；print job 經 `/api/pos/sync` 落 DB → 收銀 realtime 收到 → `PrintFlushWorker` 2.5 秒內出紙。**「等確認先落廚房」嘅語意完全冇實現** |
| **E** | **確認後再印多次** | 收銀去枱度撳「落單」→ `pos-app.tsx:2033` `buildKitchenPrintJobs()` 再建一批**新 uuid** 嘅 job → 連同 Kiosk 嗰批 = **一式兩份** |

---

## 2 · 需求 1（打印流程）完整性檢查

### 2.1 打印觸發時機 —— ⚠️ 有定義但與需求 2 衝突

**現況**：客人撳「落單」即刻建 N 個 print job（N = 該單涉及嘅 `printerGroup` 數）→ 收銀 2.5 秒內出紙。**無任何 gating，唔理 `kitchenMode`。**

**缺口**：
- 觸發點淨得一個，但若需求 2 落地就要拆成兩個（確認前 or 確認後）
- 加單（`ORDER_UPDATED`）同新單用同一個 builder，出嘅係 `ticketType:"normal"`，**廚房分唔出係加單**（收銀端有 `addon` 可用）
- 離線 / sync 失敗時冇 retry 語義（kiosk `submitKioskOrder` 失敗淨彈 error，無本地 queue）

### 2.2 打印內容格式 —— ⚠️ 最大缺口，基本等於未定義

**現況**：Kiosk 廚房單只有 `orderNo` / `tableName` / `printerGroup` / `printerName` / `items[{name, quantity, specs[], note}]`。
**冇**：店名、時間、落單類型（堂食/自取/外賣）、人數、結尾語、單價、小計、總計。
**亦冇** `template` / `content` → **商家喺設定頁較嘅廚房單模板（字體大小、顯示區塊、對齊）對 Kiosk 單完全無效**。

對照收銀端廚房單（`print-jobs.ts:117-122` + `mock-data.ts:459-470`）有齊：`store_name` / `order_no` / `table_name` / `order_type` / `time` / `server`（預設隱藏）/ `items` / `customer_count`（預設隱藏）/ `order_note` / `footer`。

**需要你決定**：
- Q1-1：Kiosk / 掃碼單**要唔要跟商家設定嘅廚房模板**？（我建議：要，否則「格式」冇得管。但要加 DB 欄位，見 §5 Phase 3）
- Q1-2：廚房單**要唔要印價錢 / 金額**？（現兩條路都唔印；外賣單通常要印畀客人）
- Q1-3：要唔要**客人收據 / 取餐號單**？（`docs/40` §8 設計咗，P1 未做）
- Q1-4：欄位排列係「跟模板系統」定「Kiosk 單用一套固定格式」？

### 2.3 打印份數 / 分單 —— ⚠️ 部分定義

**現況**：
- 分單：按 `printerGroup` 一分區一張（Kiosk 端）；收銀端按 `printer.zoneId` 對 `printerGroup` 配對
- 份數：跟 `printer.copies`（打印機級），**冇訂單級 override**
- **Kiosk 端唔讀 `deviceConfig` → 唔知邊部機 enabled / disabled、唔知 copies、唔知 printerId**，只靠收銀端 `resolveJobPrinter()`（`print-bridge/hub.ts:52-70`）用 `printerGroup` 反查

**需要你決定**：
- Q1-5：份數繼續跟 `printer.copies`，定要加「Kiosk 單特別印多一份」之類嘅 override？
- Q1-6：分單維度淨 `printerGroup` 夠唔夠？（定要埋「每個品項一張」嘅 label 單——收銀端有 `buildLabelPrintJobs`，Kiosk 端**冇**）
- Q1-7：**Kiosk 端冇 device config**，點知目標打印機？建議改由**收銀端**建 print job（見 §5 Phase 3C）

### 2.4 其他未定義
- 打印失敗處理：現有 print-center 可以手動重印（`retryFailedPrintJob`），但 Kiosk 單喺 print-center 顯示嘅 `printerName` 係 zone id 唔係真機名，難認
- 退菜 / 作廢單：Kiosk 路徑**完全冇** void print job（收銀端有 `buildVoidPrintJobsForOrder`）

---

## 3 · 需求 2（人工確認 Setting）完整性檢查

### 3.1 配置項名稱與預設值 —— 資料模型已有，但要改

| 你的需求 | 現況 | 建議 |
|---|---|---|
| 配置項名稱 | 已有 `kioskKitchenMode: "auto" \| "dine_in_confirm"` | 建議改名為語意清晰嘅 `kioskOrderConfirm`（值：`"auto" \| "require_confirm"`）或直接沿用 `kioskKitchenMode` 減少改動。**要你定（Q2-1）** |
| 預設值 | `"auto"`（唔使確認） | **需要你定（Q2-2）**：考慮到「確認流程」係新增阻塞環節，我建議**保持 `"auto"` 做預設**（現有上線店唔會因為升級而突然多一步），但要喺設定頁講清楚 |

### 3.2 作用範圍 —— ⚠️ 需求描述有歧義

**你的原文**：「僅適用於掃碼下單、Kiosk下單，或兩者皆適用」

**需要先澄清（Q2-3）**：本 repo 有**兩條唔同嘅落單線**，兩者都叫得做「掃碼」：

| 線 | 入口 | 落邊張表 | 現有設定 |
|---|---|---|---|
| **(a) 店內掃碼自點 + Kiosk** | `/menu`（手機掃枱 QR）、`/order`（平板 Kiosk） | `pos_orders`（**無** `onlineOrderId`） | `kioskKitchenMode` |
| **(b) Ledger 線上訂單** | 外部平台 / 線上點餐系統 | Ledger orders → bridge 落 `pos_orders`（**有** `onlineOrderId`），顯示喺「線上」面板 | `onlineOrderSettings.autoAccept`（已有 UI，見 `online-orders.tsx:654`、`quick-online-orders-panel.tsx:557`） |

`docs/40` 開篇已明確：「**「線上訂單」= 外部平台…；Kiosk 自點 = 店內自點，唔係線上單**」。
→ **我假設你講嘅係 (a)**，但請確認。若 (b) 都要，（b）已經有 `autoAccept` 機制，做法唔同。

**第二層範圍問題（Q2-4）**：現設計 `dine_in_confirm` **只對堂食生效**，自取 / 外賣永遠 `auto`（`kiosk-order.ts:116-125`，同 `docs/40` §7「快餐／外賣永遠 auto」一致）。
但你嘅需求係「掃碼下單與 Kiosk 下單」——**掃碼自取 / 掃碼外賣要唔要都可以設成需要確認？**
（我觀察：自取外賣單反而**更**需要確認，因為要核對備註、確認有冇貨、確認取餐時間。）

### 3.3 確認流程細節 —— ⚠️ 需求寫咗「彈窗 + 完整明細 + 確認後成立並觸發打印」，但下面 8 點未定義

**Q2-5 · 彈窗定佇列？**
「每筆新訂單進來後彈出彈窗」——若同時 3 張單進嚟點處理？
建議：**持久化「待確認佇列」+ 彈窗**（彈窗顯示最舊一張，確認完自動彈下一張；右上角顯示輪候數）。淨用 toast 一定漏單（現況 2.6 秒就消失）。

**Q2-6 · 完整明細要包乜？**
建議欄位（你原文有提嘅用 ✅ 標）：
- ✅ 單號 `localOrderNo`、落單時間
- ✅ 枱號 / 自取 / 外賣 + 取餐號
- ✅ 每個品項：名稱、數量、規格（specs）、備註（note）
- ✅ 單價、小計
- 加埋：**總計**（subtotal / 服務費 / 稅 / total）、**整單備註** `orderNote`、**落單渠道標記**（掃碼 / Kiosk，方便員工知唔使收錢）、**客人加單次數**（resume 過即係加單）

**Q2-7 · 可唔可以改？**
商家確認前可唔可以**改單**（減項 / 改規格 / 改價 / 改備註）？
- 方案 A（淨確認 / 拒絕）：彈窗得「確認落單」+「拒絕並作廢」兩個掣，簡單
- 方案 B（可編輯）：彈窗內可改數量 / 刪除品項，改完先確認，複雜但貼近實際（客人落錯規格好常見）
**要你定。**

**Q2-8 · 權限**：邊個可以撳確認？要唔要接現有 `showPermissionDenied()` 權限機制？

**Q2-9 · 超時**：客人落完單一直冇人確認點算？要唔要 N 分鐘後彈第二次提醒 / 升級提示？（客人係現場等緊，唔似線上單有平台 SLA）

**Q2-10 · 多收銀機同步**：彈窗淨彈一部定全部彈？A 機確認咗 B 機要即刻消失（靠現有 realtime `onOrderUpsert` 已可做到，但要明確）。

**Q2-11 · 拒絕之後**：客人部機顯示乜？（現況 kiosk 落完單即刻顯示「落單成功！請往收銀付款」，其實單仲未成立——**呢個 UI 已經係錯嘅**，要唔要配合加「等待店員確認」狀態？）

**Q2-12 · 加單（resume）要唔要重新確認？**
客人重複掃碼加單 → `ORDER_UPDATED` 重用同一 `order.id`（`kiosk-order.ts:140-143` 保留原有 status）。若張單已係 `sent_to_kitchen`（已確認過），加單要唔要再確認一次？要唔要出 `ticketType:"addon"` 加單紙？

---

## 4 · 待你決定（決策清單）

| 編號 | 問題 | 我嘅建議 |
|---|---|---|
| **Q1-1** | Kiosk 單要唔要跟商家廚房模板？ | **要**（加 DB 欄位） |
| **Q1-2** | 廚房單印唔印價錢 / 總計？ | 廚房單唔印；外賣 / 自取單印 |
| **Q1-3** | 要唔要客人收據 / 取餐號單？ | 要（補返 `docs/40` §8 未做部分） |
| **Q1-4** | Kiosk 單格式跟模板定固定？ | 跟模板（同 Q1-1） |
| **Q1-5** | 份數機制 | 沿用 `printer.copies`，暫不加訂單級 override |
| **Q1-6** | 要唔要 label（杯標籤）單？ | 飲品類要（Kiosk 端補 `buildLabelPrintJobs`） |
| **Q1-7** | 邊度建 print job？ | **改由收銀端建**（Kiosk 冇 device config） |
| **Q2-1** | 配置項改名定沿用？ | 沿用 `kioskKitchenMode`，只加值域（少改動） |
| **Q2-2** | 預設值 | **`"auto"`**（唔使確認），唔影響已上線店 |
| **Q2-3** | 範圍係 (a) 店內掃碼+Kiosk 定包埋 (b) 線上訂單？ | **淨做 (a)**（(b) 已有 `autoAccept`） |
| **Q2-4** | 自取 / 外賣要唔要都可以確認？ | **要**（拆成獨立開關或同一開關覆蓋全部） |
| **Q2-5** | 彈窗定佇列 | **持久化佇列 + 彈窗** |
| **Q2-6** | 明細欄位 | 見 §3.3 Q2-6 建議清單 |
| **Q2-7** | 可唔可以改單 | **方案 A 先做**（淨確認 / 拒絕），改單留 P2 |
| **Q2-8** | 權限 | 沿用現有機制，暫不加新權限位 |
| **Q2-9** | 超時提醒 | 5 分鐘未確認 → 重新彈窗 + 聲音提示 |
| **Q2-10** | 多機同步 | 全部機彈，任一機確認後靠 realtime 全部消失 |
| **Q2-11** | 客人端等待 UI | 要（加「等待店員確認」） |
| **Q2-12** | 加單重新確認？ | 已確認過嘅單加單 → **唔使再確認**，但要出加單紙 |

---

## 5 · 建議 Plan（分 Phase，按依賴排序）

### Phase 0 · 決策定案（你）
- 拍板 §4 嘅 Q1-1 ~ Q2-12，我按答案收窄範圍寫最終設計

### Phase 1 · P0 修正（阻塞上線，建議第一個做）
1. **1A · 確認前唔好出單**
   `use-kiosk-order.ts:377` 改為：當需要確認時**唔建 print job**；確認後由收銀端用 `buildKitchenPrintJobs()`（含模板 + content）統一出單
2. **1B · 設定真源搬去 server**
   新增/擴充 store 級設定 API（參考 `/api/online-order-settings` 嘅 store 隔離做法），Kiosk 落單前 `GET` 攞；localStorage 只做離線 fallback
   ⚠️ 吸取 `autoAccept` 嘅教訓：server GET 必須按 `store_id` filter，**唔可以再出現「全店最新一條」蓋走 per-terminal 設定**（見 `.workbuddy-ai/memory/MEMORY.md`「設定真源規律」）
3. **1C · 剔除重覆打印**
   確認時唔好再建一批新 job；或若 kiosk 已建，就喺確認時用同一批（唔好兩邊都建）

### Phase 2 · 確認 UI（需求 2 主體）
4. **2A · 待確認佇列**：`pos-app.tsx` 加 `pendingConfirmOrderIds` 狀態（來源 = `orders.filter(o => o.status === "draft" && isKioskOrder(o))`，realtime 驅動），取代 `setToast`
5. **2B · 確認彈窗**（复用 `ResponsiveModal`）：完整明細（單號 / 時間 / 枱號或自取外賣 / 品項 + 數量 + 規格 + 備註 + 單價 + 小計 / 服務費 / 稅 / 總計 / 整單備註 / 落單渠道）
6. **2C · 確認 / 拒絕動作**：確認 → `status: "sent_to_kitchen"` + `fulfillmentStatus: "preparing"` + 出廚房單；拒絕 → `status: "cancelled"` + `cancelledReason`
7. **2D · 客人端等待 UI**：Kiosk 落單成功頁改為「等待店員確認」（需要確認模式時）
8. **2E · Kiosk 訂單標記**：`PosOrder` 加 `source?: "pos" | "kiosk" | "scan"` 之類欄位（**`items` 係 JSONB 整條存，新 field 唔使 migration，但 order 層新欄位要加 column**），用嚟分辨 draft 係員工開定客人落

### Phase 3 · 打印格式一致（需求 1 主體）
9. **3A · DB migration**：`pos_print_jobs` 加 `template jsonb`、`content jsonb`、`printer_id text`（新 `0013_*.sql`）
10. **3B · sync 層**：`/api/pos/sync` `PRINT_JOB_CREATED` 補寫呢三欄；`src/lib/pos/pos-order-mapper.ts` 讀回
11. **3C · Kiosk print job 改由收銀端建**：
    方案：Kiosk 落單**只推 order**，收銀端 `onOrderUpsert` 時若 `status === "sent_to_kitchen"`（或確認後）先 `buildKitchenPrintJobs()` / `buildLabelPrintJobs()`
    → 好處：自動有 `deviceConfig` 打印機、模板快照、content、copies、addon 標記，同店內單格式 100% 一致
    → 代價：收銀機必須在線先出到單（要評估：離線時點處理？建議 fallback 去 Kiosk 端建無模板 job + print-center 提示）

### Phase 4 · 份數 / 分單 / 客人單
12. **4A · label 單**：Kiosk 單補 `buildLabelPrintJobs()`
13. **4B · 客人收據 / 取餐號單**：收銀端確認後出（或由 Kiosk 端出，視 Q1-3 答案）
14. **4C · void 單**：Kiosk 單退菜 / 作廢補 `buildVoidPrintJobsForOrder()`

### Phase 5 · 設定 UI + 文檔
15. **5A · `device-settings.tsx` 「掃碼點餐」tab** 加確認模式開關（堂食 / 自取外賣分別或合併，視 Q2-4）
16. **5B · 更新 `docs/40`、`docs/41`**，新增本 Plan 嘅實作記錄

### 預計改動檔案（初步）

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` | `kioskKitchenMode` 值域 / `PrintJob` 補欄位 / `PosOrder` 加 source |
| `src/lib/kiosk-order.ts` | `buildKioskOrder` 加 source；`buildKioskKitchenPrintJobs` 條件化或移除 |
| `src/lib/use-kiosk-order.ts` | 讀 server 設定；條件建 print job |
| `src/components/pos-app.tsx` | 待確認佇列 + 確認彈窗 + 確認時建 print job |
| `src/app/api/pos/sync/route.ts` | 補寫 `template` / `content` / `printer_id` |
| `src/lib/pos/pos-order-mapper.ts` | 讀回新欄位 |
| `src/components/device-settings.tsx` | 掃碼點餐 tab 加開關 |
| `supabase/migrations/0013_*.sql` | `pos_print_jobs` 加欄位 |
| `src/app/menu/page.tsx` / `src/app/order/page.tsx` | 等待確認 UI |

---

## 6 · 風險提示

1. **Phase 3C 係架構改動**：將 print job 由「Kiosk 端建」改為「收銀端建」，會改變 `docs/41` 記錄嘅資料流，亦影響離線場景。**建議先用一部測試機驗證**，唔好直接上生產。
2. **`pos_print_jobs` 加欄位**要喺 Macau-Ledger 嗰邊確認會唔會衝突（生態系共用 Supabase，見 `docs/README.md`「相關 Repo」）。
3. **沿用 `kioskKitchenMode` 名字**可以少改動，但呢個名語意上淨講「廚房」，若 Q2-4 決定自取外賣都要確認，個名會誤導——改名要一併改埋 `storage.ts` normalize 同所有讀取點。
