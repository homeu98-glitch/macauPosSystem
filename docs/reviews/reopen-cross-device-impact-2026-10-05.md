# 返結跨機修復 — 影響範圍調查 + 實作完成報告（2026-10-05）

> 狀態：✅ **已實作完成並通過全套驗證**（tsc 零錯誤 / 1083 測試全綠 / eslint 0 error / build 成功）。
> §1-§5 為動工前嘅調查原文（保留作決策依據）；**§6 為最終實作、§7 衝突檢查、§8 風險與驗收**。
> 拍板結果：採 (a) 做齊 1+2+3、採**獨立第二次 update** 緩解 R-1、區塊放樓層 chips 之下。

---

## 1 方案範圍確認

### 方案 1：桌台總覽加「返結帳（N）」區塊
- **落點**：`pos-app.tsx` 桌台總覽，樓層 chips（`ALL_FLOOR_ID` 那行，L5452-5476）**之下**、枱格 grid（L5478）**之上**。
- **資料來源**：`openOrders`（已含 `status === "reopened"`，L2422-2432）—— **零新增 API、零新增 DB 查詢**。
- **與現有 temp 枱機制共存**：不動 `createReopenTempTable`／`stripReopenTempTables`／`buildDisplayFloors`。
  下單機既有「返結 A01」枱照樣顯示；區塊只補跨機時缺失的入口，兩者指向同一張單。

### 方案 2：`reopen_original_table_id` / `_name` 上雲
- **需改四條讀取路徑**（記憶 §2 鐵律④）＋1 條寫入路徑。
- **需新 migration**：`0063_pos_orders_reopen_original_table.sql`（現有最新 = 0062）。

### ⚠️ 假設不符，需你確認（見 §5 D-1）
我原先講「方案 2 唔做就單會卡住」，**呢個講法過度簡化**。實際查證後：
即使 `reopenOriginalTableId` 上咗雲，跨機重結時該欄會是 `undefined`（因為 temp 枱係**另一部機**建立，
`table_id` 傳上雲嘅係 `temp-reopen-xxx`，而原枱 id 只存在下單機本機）。
⇒ **要真正修好跨機還原原枱，必須同時上雲「原枱 id」**——即 `createReopenTempTable` 產生嘅
`reopenOriginalTableId` 要經 `ORDER_UPDATED` push 上去。呢個係方案 2 嘅核心，唔只係加欄位。

---

## 2 將被修改的檔案（完整清單）

| # | 檔案 | 變更內容 | 方案 | 風險 |
|---|---|---|---|---|
| 1 | `supabase/migrations/0063_pos_orders_reopen_original_table.sql` | **新增**：`reopen_original_table_id text` + `reopen_original_table_name text`（皆 nullable，`add column if not exists`） | 2 | 🟢 低（純新增欄） |
| 2 | `src/lib/types.ts` L1380-1382 | 欄位**已存在**，零改動 | — | 🟢 無 |
| 3 | `src/app/api/pos/sync/route.ts` L1322-1382 `baseRecord` | 加 `reopen_original_table_id` / `_name`（**「有值才寫」語義**，同 `settledAtRecord` 一致） | 2 | 🟡 中 |
| 4 | `src/app/api/pos/sync/route.ts` L1405-1417 `legacyRecord` | 加 `delete legacyRecord.reopen_original_table_id` / `_name`（42703 降級） | 2 | 🔴 **高（見 R-1）** |
| 5 | `src/lib/pos-order-row.ts` `PosOrderDbRow` + `POS_ORDER_DB_COLUMNS` | 加兩個欄位（型別 + 投影清單） | 2 | 🟡 中 |
| 6 | `src/lib/pos-order-row.ts` `mapOrderRow()` | map 出 `reopenOriginalTableId` / `Name`（`?? undefined`） | 2 | 🟢 低 |
| 7 | `src/lib/pos/pos-order-mapper.ts` `PosOrderRow` + `mapPosOrderRow()` | 同上（realtime 路徑） | 2 | 🟢 低 |
| 8 | `src/app/api/pos/orders/route.ts` L57-84 內聯 mapper | 加兩行映射 | 2 | 🟢 低 |
| 9 | `src/app/api/pos/state/route.ts` | 檢查是否用 `mapOrderRow`／共用投影（待實作時確認） | 2 | 🟡 中 |
| 10 | `src/components/pos-app.tsx` | 「返結帳（N）」區塊（**整卡條件 render**） | 1 | 🟡 中 |
| 11 | `src/lib/pos/reopen-badge.ts` | 零改動（只提供 `isReopenedOrder`） | — | 🟢 無 |

**共用元件影響**：`table-order-badge.ts`、`display-floors.ts`、`table-scope.ts`、`pos-orders.ts` —
**全部零改動**。方案 1 完全唔掂枱面渲染鏈。

---

## 3 API 契約變更

| 端點 | 方向 | 變更 | 相容性 |
|---|---|---|---|
| `POST /api/pos/sync` | client→server | `ORDER_UPDATED` payload 多兩個**可選** key | ✅ 向後相容：舊 client 唔帶 → server 唔寫（保留雲端值） |
| `GET /api/pos/state` | server→client | 回應 `orders[]` 多兩個**可選** key | ✅ 舊 client 忽略未知欄位 |
| `GET /api/pos/orders` | server→client | 同上 | ✅ 同上 |

**無破壞性變更**：無欄位刪除、無型別收窄、無 enum 改動、無 HTTP 狀態碼改動。

---

## 4 資料結構與設定

- **DB**：`pos_orders` 加 2 個 nullable text 欄。**唔加 NOT NULL、唔加 DEFAULT、唔加 index**
  （查詢靠 `store_id` 已有索引，reopen 單數量極少）。
- **RLS**：**唔改**。新欄隨行政策自動繼承現有 anon 時間窗 RLS。
- **localStorage**：**唔改**任何 key / 結構（方案 1 只讀 `openOrders`）。
- **環境變數**：**零新增**。

---

## 5 🔴 風險與決策點

### R-1（🔴 高，會影響 production）42703 降級機制會「一次過拔走全部新欄」

`pos/sync` L1394-1418：若 `baseRecord` 寫入遇 42703（新欄未跑 migration），現行做法係
**刪掉一批欄位後重試一次**。我新加嘅兩個欄若未跑 migration 就會觸發呢條路徑。

**風險**：`delete legacyRecord.reopen_original_table_id` 只拔我嗰兩欄係正確嘅，但——
萬一將來有其他新欄，**呢個降級清單係硬編碼手寫嘅**，容易再漏。
更關鍵：`isMissingColumnError` 一旦觸發，代表**至少一欄**缺失；此時重試仍然會帶住
其他未刪乾淨嘅欄 → **再失敗** → `failInfra` → 整張單上唔到雲（落單主流程被拖冧）。

**緩解（我建議）**：唔靠「事後刪欄」，改為**喺降級時用動態逐欄重試**——
或者更穩陣：將新欄寫入改為**獨立嘅第二次 update**（baseRecord 保持不變），
咁樣新欄失敗**完全唔會**影響 baseRecord 寫入。呢個做法更符合「唔可以為新功能拖冧主流程」呢條鐵律。

### D-1（🧠 需你決策）方案 2 嘅範圍

我發現原方案 2 講得唔夠：真正修好跨機還原原枱，需要**三件事**：
1. 加 DB 欄位（0063 migration）
2. 四條讀取路徑 map 返
3. 🔴 **`createReopenTempTable` 產生嘅 `reopenOriginalTableId` 要經 `ORDER_UPDATED` push 上雲**
   （`pos-orders.ts:206` 已經有寫入本機 order，但 sync `baseRecord` 冇帶呢欄）

第 3 點係我原本漏講嘅。冇佢，方案 2 只做「讀取」係無效嘅。

**請確認**：
- (a) 方案 2 做齊 1+2+3（我建議，範圍如上）
- (b) 只做 1+2（欄位舖好待後用，跨機重結問題**未修好**）
- (c) 方案 2 暫緩，先做方案 1

### D-2（🧠 小決策）方案 1 區塊喺邊度顯示
- (a) 樓層 chips 之下、枱格之上，一行 amber 色橫幅（我建議）
- (b) 做成一個可展開嘅 chip，撳先展開

---

## 6 最終實作（已落地）

### 6.1 方案 1 —「返結帳（N）」區塊

| 檔案 | 變更 |
|---|---|
| `src/lib/pos/reopen-account-rows.ts` | **新增**純函式（零 import、structural typing ⇒ 可被 `node --test` 直接 import）。導出 `reopenAccountRows()` / `reopenAccountCount()`。只認 `status === "reopened"`；`tableLabel` 優先序 `reopenOriginalTableName` → `reopenOriginalTableId` → `tableName` → `tableId` → `"—"`；排序 `reopenedAt` 降序，時間相同用 `orderNo` 做穩定全序 |
| `src/lib/pos/reopen-account-rows.test.ts` | **新增** 16 條測試（原枱優先、排序穩定性、金額 round2/字串/null、`reopenCount` 邊界 0/負/NaN、trim、壞資料不 crash） |
| `src/components/pos-app.tsx` L204-205 / L2445 / L5506+ | 加 import、加 `reopenAccountList` memo、枱格 grid 之上插入區塊（**整卡條件 render**，`length > 0`） |

**關鍵設計決定**
- 資料源係現成 `openOrders`（L2423-2432 已含 `reopened`）⇒ **零新增 API、零新增 DB 查詢，egress 完全唔受影響**。
- **點擊時刻意唔鎖 floor**：跨機時 temp 枱唔在本機 `floors`，鎖咗會令枱 grid 變空。
- **唔過濾「本機有 temp 枱」嘅單**：咁做會令下單機嘅返結單喺區塊消失，反而製造跨機不一致。下單機見到兩張卡（枱 + 區塊）指向同一張單，屬可接受。

### 6.2 方案 2 — 原枱快照上雲（0063）

| 檔案 | 變更 | 讀寫 |
|---|---|---|
| `supabase/migrations/0063_pos_orders_reopen_original_table.sql` | **新增**：`reopen_original_table_id text` / `reopen_original_table_name text`，皆 nullable、`add column if not exists`、**唔加 NOT NULL/DEFAULT/index、唔用 `begin;…commit;`** | DB |
| `src/lib/pos-order-row.ts` | `PosOrderDbRow` + `POS_ORDER_DB_COLUMNS`（L201-202）+ `mapOrderRow()`（L278-279） | 讀 ① |
| `src/lib/pos/pos-order-mapper.ts` | `PosOrderRow` + `mapPosOrderRow()`（L170-171） | 讀 ② |
| `src/app/api/pos/orders/route.ts` | 內聯 mapper L83-84 | 讀 ③ |
| `src/app/api/pos/state/route.ts` | **零改動** — 用共用 `mapOrderRow` + `ORDER_FIELD_WHITELIST`（由 `POS_ORDER_DB_COLUMNS` 派生）＋既有 42703 自動 `select("*")` 降級 ⇒ **物理上自動支援新欄** | 讀 ④ |
| `src/app/api/pos/sync/route.ts` L1343-1350 / L1479-1493 | `writesReopenOriginalTable` + `reopenOriginalTableRecord`（有值才寫）＋ **`ack(true)` 前獨立第二次 `.update()`** | 寫 |
| `src/lib/pos-order-row.test.ts` | 新增 `describe("reopen_original_table_id（0063 跨機重結還原原枱）唔可以漏抄")` 3 條（投影必有兩欄／有值必 map／NULL 或未跑 migration → undefined）。19 tests 全綠 | 測試 |

### 6.3 D-1 第 3 點 —「零改動已滿足」

`pos-orders.ts:241-253` 嘅 `reopenEvent.payload = { order: updated, ... }`，`updated` 係**整張單**，
而 `reopenOriginalTableId/Name` 喺 L206-207 已寫入 ⇒ **原枱 id 自然隨 payload 上雲**，
唔需要額外改 `pos-orders.ts`。已逐行核實。

---

## 7 衝突檢查（新增內容 vs 現有模組／API／資料結構）

| 檢查項 | 結果 |
|---|---|
| 新欄位名與既有 `pos_orders` 欄撞名？ | ✅ 無撞（grep 全 repo 確認，`reopen_original_table_*` 係全新名） |
| `PosOrder` 既有欄位被我改型別／收窄？ | ✅ 零改動（`types.ts` L1380-1382 早已存在 `string?`） |
| `mergeOrderLists()` 跨機合併會唔會漏抄新欄？ | ✅ 唔會。L273-314 全部用**整單 LWW 覆寫**（`{...order, localOrderNo}`），唔係逐欄挑選 ⇒ 新欄自動跟 winning snapshot 走 |
| `state` 嘅 `ORDER_FIELD_WHITELIST` 會唔會漏新欄？ | ✅ 唔會，`new Set(POS_ORDER_DB_COLUMNS)` 自動派生（有測試 `pos-order-row.test.ts:92-98` 守衛兩者一致） |
| 區塊 UI 撞到既有 `tableOrderBadge`／`table-scope`／`display-floors`？ | ✅ 零改動、完全唔掂枱面渲染鏈；`isReopenTempTable` 原本就已 import（用於 `assignableTables`），我沿用同一 import |
| `openOrders` 會唔會重覆計數？ | ✅ `reopenAccountRows` 另開陣列，唔改 `openOrders` 本身（memo 依賴 `[openOrders]`） |
| JSX 結構平衡（歷史教訓：2026-09-11 grid 中間誤刪 `</div>`，typecheck/build 全綠捉不到） | ✅ `div` open 294 / close 294，diff = 0；另已核對區塊 JSX 閉合 |
| 新欄寫入失敗會唔會拖冧落單主流程？ | ✅ 唔會（見 §8 R-1 緩解） |
| 舊 client（未刷新 bundle）會唔會誤清新欄？ | ✅ 唔會 —— 「有值才寫」，舊 client payload 冇呢個 key ⇒ server 完全唔碰 |
| env／RLS／localStorage 有冇改？ | ✅ 零新增 env、零改 RLS、零改 localStorage key |

**「重結後雲端殘留舊值」邊界（已分析，安全）**：`pos-app.tsx` L4759-4760 重結時把
`reopenOriginalTableId/Name` 設為 `undefined`，但 sync 係「有值才寫」⇒ 雲端會留住上一次的值。
**唔構成 bug**：同一張單第二次返結時 `pos-orders.ts:206` 必然覆寫
（`tempTable ? order.tableId : order.reopenOriginalTableId`），而 `createReopenTempTable()`
（L94-136）對 `isReopenable` 通過嘅單**必定回傳非 null temp 枱** ⇒ 恆行 `tempTable` 分支。

---

## 8 風險點與驗收方式

| # | 風險 | 級別 | 緩解 | 驗收方式 |
|---|---|---|---|---|
| R-1 | 0063 未跑時新欄寫入 42703 | 🔴 原高 → 🟢 已緩解 | 新欄**獨立第二次 update**，`baseRecord` 零改動；失敗只 `console.warn`，唔 `failInfra`、唔影響 `ack(true)`。最差 = 功能靜默停用（＝現時行為），落單／結帳／金額／items 全部照寫 | 唔跑 0063 直接落單 → 應正常上雲、Vercel log 出 `[pos/sync] 0063 … 寫入失敗` warning 而非 `訂單寫入失敗` |
| R-2 | 0063 未跑時 `POS_ORDER_DB_COLUMNS` 撞 42703 | 🟡 中 | `state` 路徑既有 `runOrderQueryWithColumnFallback()` 自動 `select("*")` 重試；realtime mapper 冇投影（讀 `*`）⇒ 天然immune | 唔跑 0063 開 `/pos` → 桌台／單照樣載入，log 出 `投影撞 42703 → 降級 select("*")` |
| R-3 | 區塊出現下單機已見到嘅單（重複卡） | 🟢 低（刻意） | 唔過濾 temp 枱單 —— 過濾咗反而製造「呢部機見到、嗰部機唔見」嘅跨機不一致 | 下單機：區塊 1 張 + temp 枱 1 個，兩者指向同一 `order.id`，重結後都係同一張單 |
| R-4 | 區塊喺流動版太闊 | 🟢 低 | `flex-wrap` + `truncate`（原因 `max-w-[220px]`）；卡片本身 `min-h-[40px]` 符合觸控規範 | iPad 與桌面各截圖一次，確認無橫向溢出、點擊目標 ≥40px |
| R-5 | 舊版 `pos-app.tsx` bundle 唔識區塊但識 temp 枱 | 🟢 無影響 | 區塊純新增 render 分支，舊 bundle 照行 temp 枱路徑 | 唔需處理（向下相容） |
| R-6 | 報表口徑被改壞 | 🟢 **零改動** | 完全冇碰 `restaurant-daily-report.tsx` 嘅 `isSaleCountable()`／`posOrderToDetailRow()` | 報表重跑：營業額、訂單明細、已重開張數 三者數字與改動前完全一致 |

### 手動驗收清單（跨機，需兩部機）

1. **部 A（下單機）**：A01 落單 → 送廚房 → 結帳 → 反結，記低**原枱 = A01**。
2. **部 A 截圖**：枱格出現「返結 A01」temp 枱；區塊亦出現同一張單（原枱標籤 = `A01`，非 `返結 A01`）。
3. **部 B（另一部機）截圖**：枱格**冇**「返結」枱（temp 枱唔上雲，屬設計），但**區塊出現同一張單** ⇒ 核心修復生效。
4. 部 B 撳區塊卡片 → 應入點餐介面、items 完整、枱面不鎖死。
5. 部 B 結帳 → 核實 **`tableId` 還原成 A01**（`isReopenRestore` 靠 0063 新欄）⇒ 落單機／部 B 都見到張單返咗 A01。
6. 查 DB：`select reopen_original_table_id, reopen_original_table_name, status from pos_orders where …` 應見 `A01` + `settled`。
7. **報表**（部 B 或 `/reports`）：重結前該單**唔計**營業額 ✅；重結後**計入** ✅；訂單明細只有重結後一筆。
8. **區塊消失**：重結完成後兩部機都唔再見到區塊（`status` 已非 `reopened`）⇒ 整卡條件 render 生效。

### 部署備忘

⚠️ **`0063_pos_orders_reopen_original_table.sql` 必須人手喺 Supabase SQL Editor 執行**
（assistant 無法代跑）。未跑之前：區塊照可見（方案 1 唔靠新欄），但跨機重結唔會還原原枱（＝現時行為，其餘功能正常）。
