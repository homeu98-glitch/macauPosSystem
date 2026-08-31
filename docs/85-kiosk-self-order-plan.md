# 83 · 線下自助點餐（Kiosk + 店內掃碼自點）：確認後實作計劃

> 狀態：**待你確認**（盤點完成，未改任何代碼）
> 日期：2026-08-31　範圍：Kiosk mode + 店內掃碼自點（走 `pos_orders`、**無** `onlineOrderId`）
> **唔包**：Ledger 線上訂單（已有 `onlineOrderSettings.autoAccept`）
> 相關舊文檔：`docs/40-customer-self-order-kiosk.md`（設計）、`docs/41-kiosk-p1-implementation.md`（P1 實作記錄）

---

## 0 · 我嘅理解（逐條對照你嘅確認結果）

| # | 你嘅確認 | 我嘅理解 |
|---|---|---|
| 1 | 範圍係 (a) 掃碼自點 + Kiosk，唔係 (b) 線上訂單 | 只改 `pos_orders` 路線（`kiosk-order.ts` / `use-kiosk-order.ts`）。`onlineOrderSettings.autoAccept`、`online-orders.tsx`、`ledger-pos-bridge.ts` **一律唔郁** |
| 2 | 唔使新增「接單前顯示訂單明細／預覽」 | **唔做**確認彈窗。需要確認時，單落 `status: "draft"`，收銀喺**現有**面板（快餐候單 `counterKioskOrders`／枱位圖）直接撳現有嘅「落單」掣完成確認 |
| 3 | Kiosk 旁有打印機，落單即時印小票（編號／品項明細／價格） | 新增**獨立**票種 `kiosk`，用全新嘅「自助點餐機模版」，**喺 Kiosk 本機出紙**（唔經收銀機） |
| 4 | 模版喺 POS「打印」頁新增，名叫「自助點餐機模版」，Kiosk 由 POS 取得，內容一律 DB level | 模版**唔再放 localStorage**（現有 `printTemplates` 係 client-only，見 `pos-app.tsx:662-664`），改為**存 DB、按店讀取** |
| 5 | 唔好複用或改用商家廚房模版 | 新票種 `kiosk` 有自己的 `KioskTemplate` / section / 預設值，**完全獨立**於 `kitchen` |
| 6 | 唔好改由收銀端建 print job | 保持而家做法：**Kiosk 端建曬兩個 job**（客人小票 + 廚房單），只係改佢哋嘅 `status` 去控制出紙時機 |
| 7 | Kiosk 只針對快餐 | Kiosk（`/order` 平板）固定 **quick mode**（自取／外賣），唔做堂食；堂食交畀掃碼（`/menu`） |
| 8 | 溝通唔好用編號代稱 | 下面所有提問改用完整句子 |

---

## 1 · 完整流程（目標狀態）

### 1.1 Kiosk（快餐）

```
客人在 Kiosk 落單
  → ① Kiosk 打印機即時印「自助點餐機小票」（下單編號 / 品項明細 / 價格）
     　　↑ 本地出紙：appendPrintJobs 寫 Kiosk 本機 localStorage
     　　→ PrintFlushWorker（已掛喺 root layout）經 native bridge / companion / relay 出紙
  → ② 寫入 pos_orders：
     　　免確認 → status = "sent_to_kitchen"，廚房 print job = "pending"
     　　需確認 → status = "draft"，        廚房 print job = "held"（暫扣，唔出紙）
  → ③ 收銀 Realtime 見單
     　　免確認 → 廚房單 2.5 秒內出紙
     　　需確認 → 收銀喺快餐候單面板撳「落單」→ 扣起嘅 job 轉 "pending" → 出紙
  → ④ 商家出餐、標記 ready（通知客人取餐）
  → ⑤ 客人取餐並支付 → status = "settled"
```

### 1.2 店內掃碼自點（堂食）

```
客人掃碼落單
  → 寫入 pos_orders：
     　免確認 → status = "sent_to_kitchen"，廚房 job = "pending"
     　需確認 → status = "draft"，        廚房 job = "held"
  → 收銀 Realtime 見單（同上，需要確認就撳「落單」）
  → 打印廚房單 → 堂食出餐 → 客人用餐後賣單 → status = "settled"
```

> **客人小票只喺 Kiosk（快餐）出。** 掃碼自點係客人自己部手機，冇打印機，唔出小票。

---

## 2 · DB 改動

### 2.1 新表 `pos_kiosk_settings`（**按店**，自助點餐設定唯一真源）

```sql
create table if not exists pos_kiosk_settings (
  store_id text primary key,
  require_confirm boolean not null default false,
  kiosk_template jsonb,
  printer jsonb,
  updated_at timestamptz not null default now()
);
alter table pos_kiosk_settings enable row level security;
-- anon 要讀（Kiosk 落單前攞模版）；寫入只經 service_role（/api/pos/kiosk-settings）
create policy "pos_kiosk_settings anon read" on pos_kiosk_settings for select to anon using (true);
grant select on pos_kiosk_settings to anon;
```

| 欄位 | 用途 | 備註 |
|---|---|---|
| `store_id` | 店 ID，PK | 按店隔離，避開 `pos_device_configs` 嗰個「全店最新一條」陷阱 |
| `require_confirm` | 係咪要收銀確認先落廚房 | 取代而家嘅 `PosLocalSettings.kioskKitchenMode` |
| `kiosk_template` | 「自助點餐機模版」完整定義（blocks / order / footerText） | jsonb，直接存 `KioskTemplate` |
| `printer` | Kiosk 打印機設定（**視 §5 第 1 題答案決定係咪要**） | jsonb |
| `updated_at` | 版本時間 | Kiosk 用嚟判斷要唔要重新拉 |

> **點解唔用 `pos_device_configs`？** 嗰張表 GET 係 `.order(updated_at desc).limit(1)` = **全店最新一條（任何 terminal）**，而且冇 store filter（`/api/pos/device-config/route.ts:17-21`）。用嚟存 Kiosk 設定一定會中「A 機改完 B 機讀到錯嘢」嘅 bug（同 `autoAccept` 嗰個一模一樣）。**必須新表。**
>
> **替代方案（可選）**：將 `kiosk_template` / `require_confirm` 直接加落現有 `pos_bootstrap_config`（已經係按店、Kiosk 已經會 `GET /api/pos/bootstrap?storeId=` 並 cache 落 localStorage）。少一張表、少一次 API call、離線都有 fallback；缺點係 bootstrap 語義上係「餐牌／規則」，撈埋打印模版有啲雜。**我傾向新表**，但呢個可以你揀。

### 2.2 `pos_print_jobs` 加 3 個欄位

```sql
alter table pos_print_jobs add column if not exists printer_id text;
alter table pos_print_jobs add column if not exists template jsonb;
alter table pos_print_jobs add column if not exists content jsonb;
```

> 用途：等 Kiosk 建嘅**廚房單**可以帶埋模版快照（現況完全冇 → 出紙走硬編 fallback）。見 §5 第 6 題。
> 客人小票唔經 DB（本地出紙），唔需要呢三欄。

### 2.3 唔使 DDL 嘅部分

| 項目 | 點解唔使 |
|---|---|
| `pos_print_jobs.status = "held"` | `status` 係 `text` 欄，加個值唔使改表 |
| `pos_print_jobs.items` 加 `unitPrice` / `amount` | `items` 係 `jsonb`，加欄位唔使改表 |
| `pos_orders` 加 `source` 之類 | 若要加就要 DDL（見 §5 第 5 題） |

---

## 3 · 檔案改動清單

### 3.1 型別與常數

| 檔案 | 改動 |
|---|---|
| `src/lib/types.ts` | ① `PrintTemplateKind` 加 `"kiosk"`；② `PrintTemplates` 加 `kiosk: KioskTemplate`；③ 新增 `KioskTemplate` / `KioskSectionId`；④ `PrintKind` 加 `"kiosk"`；⑤ `PrintJob.status` 加 `"held"`；⑥ `PrintJob.items[]` 加 `unitPrice?` / `amount?`；⑦ `PrintJob` 加 `printerId?`（已有） |
| `src/lib/escpos-template.ts` | 新增 `KIOSK_SECTION_META`、`KIOSK_BLOCK_DEFAULTS`、`DEFAULT_KIOSK_TEMPLATE`、`buildKioskContent(order, opts)` |
| `src/lib/escpos-render.ts` | `TITLE` 加 `kiosk: ""`（客人小票唔印「＊＊＊ 收據 ＊＊＊」抬頭，靠 `store_name` 區塊做 header） |
| `src/lib/mock-data.ts` | `defaultPosLocalSettings.printTemplates` 加 `kiosk` 預設值 |
| `src/lib/storage.ts` | `normalizePosLocalSettings` 加 `printTemplates.kiosk` merge（**只做本地 fallback，真源喺 DB**） |

### 3.2 「自助點餐機模版」區塊建議（對應你要求嘅三項內容）

| section id | 中文標籤 | 預設 | 說明 |
|---|---|---|---|
| `store_name` | 門店名 | 顯示 / 中 / 粗 / 置中 | 小票抬頭 |
| `order_no` | 下單編號 | 顯示 / 中 / 粗 / 靠左 | **你要求嘅「下單編號」**，即 `localOrderNo`（同時係取餐號） |
| `order_type` | 類型 | 顯示 / 細 / 靠左 | 自取 / 外賣 |
| `time` | 落單時間 | 顯示 / 細 / 靠左 | |
| `items` | 菜品明細 | 顯示 / 中 / 粗 / 靠左 | **你要求嘅「品項明細 + 價格」**，每行＝品名 / 規格 / 備註 / 數量 / **單價** / **小計** |
| `subtotal` | 小計 | 顯示 / 細 / 靠右 | |
| `service_charge` | 服務費 | 顯示 / 細 / 靠右 | 跟 `bootstrap.rules.serviceChargeRate` |
| `tax` | 稅 | 隱藏 / 細 / 靠右 | 澳門冇銷售稅，預設收埋 |
| `total` | 總計 | 顯示 / 大 / 粗 / 靠右 | |
| `pickup_hint` | 取餐提示 | 顯示 / 細 / 置中 | 例如「請留意叫號，憑此單取餐」 |
| `footer` | 頁尾文案 | 顯示 / 細 / 置中 | |

> **`items` 要印價格 → 要改 3 個 repo**，見 §4。

### 3.3 打印中心（「打印」頁）加新分頁

| 檔案 | 改動 |
|---|---|
| `src/components/print-center.tsx` | ① `TemplateKindState` 加 `"kiosk"`；② `SECTION_META` 加 `kiosk: KIOSK_SECTION_META`；③ tab 加「自助點餐機模版」；④ `buildPreviewLines` 加 kiosk 分支；⑤ 標題文案（:382）加 kiosk；⑥ **儲存時 POST 去 DB**（`/api/pos/kiosk-settings`）而唔係淨寫 localStorage |
| `src/components/escpos-preview.tsx` | items 行渲染加單價 / 小計 |

### 3.4 新 API

| 檔案 | 改動 |
|---|---|
| `src/app/api/pos/kiosk-settings/route.ts`（**新增**） | `GET ?storeId=` → 返 `{ requireConfirm, kioskTemplate, printer }`（冇 Supabase 時返 null，Kiosk fallback 去內建預設）；`POST` → upsert（service_role） |

### 3.5 Kiosk 落單邏輯

| 檔案 | 改動 |
|---|---|
| `src/lib/kiosk-order.ts` | ① 新增 `buildKioskReceiptPrintJob(order, template)` — 建**客人小票** job（`printerGroup: "receipt"`、`template` = DB 模版快照、`content` = `buildKioskContent`、items 含價格）；② `buildKioskKitchenPrintJobs` 加參數控制 job status（`held` / `pending`）；③ `buildKioskOrder` 嘅 status 改由 `requireConfirm` 決定（堂食 + 快餐都適用，唔再淨堂食） |
| `src/lib/use-kiosk-order.ts` | ① mount 時 `GET /api/pos/kiosk-settings?storeId=` 攞設定（唔再讀 `loadPosLocalSettings().kioskKitchenMode`）；② `placeOrder()` 先 `appendPrintJobs([receiptJob])` **本地出紙**，再 `submitKioskOrder()` 推單 + 廚房 job 去 server |
| `src/app/order/page.tsx` | Kiosk 固定 quick mode（關掉堂食選擇） |
| `src/app/menu/page.tsx` | 維持（掃碼可堂食／自取） |

### 3.6 收銀端

| 檔案 | 改動 |
|---|---|
| `src/lib/print-bridge/dispatch.ts` | `flushPendingPrintJobs` 嘅 `pending` filter 維持（`"held"` 自然被 skip，**冇嘢要改**）；只需確認 `resolveJobPrinter` 對 kiosk 廚房 job 嘅解析唔變 |
| `src/components/pos-app.tsx` | 確認動作（現有「落單」）時，將該單對應嘅 `held` job 轉 `pending` + 推 `PRINT_JOB_UPDATED` 去 server；`loadRuntimeState` 同步時**唔好用** `payload.localSettings.kioskKitchenMode`（改讀新表） |
| `src/components/local-orders-panel.tsx` | 快餐候單面板：`draft` 單要有明顯「待確認」標記（現況只係同員工 draft 單混埋一齊） |

### 3.7 同步層

| 檔案 | 改動 |
|---|---|
| `src/app/api/pos/sync/route.ts` | ① `PRINT_JOB_CREATED` 補寫 `printer_id` / `template` / `content`；② 新增 `PRINT_JOB_UPDATED` 事件（held → pending，供其他機同步） |
| `src/lib/pos/pos-order-mapper.ts` | 讀回 `printer_id` / `template` / `content` |

### 3.8 設定 UI（確認開關）

| 檔案 | 改動 |
|---|---|
| `src/components/device-settings.tsx` | 「掃碼點餐」tab（:646）加「自助點餐需要收銀確認」開關，改寫 DB（經 `/api/pos/kiosk-settings`）而唔係 `localSettings` |
| `src/lib/types.ts` | `PosLocalSettings.kioskKitchenMode` **標記 deprecated**（保留讀取做過渡，新 UI 唔再寫） |

---

## 4 · 跨 repo 改動（**重要，唔可以漏**）

「品項要印價格」唔係淨改本 repo——三家渲染器各自實作同一套 line model：

| Repo | 檔案 | 改動 |
|---|---|---|
| 本 repo | `src/lib/escpos-render.ts` | `PrintItemLine` 加 `unitPrice?: number` / `amount?: number` |
| 本 repo | `src/components/escpos-preview.tsx` | 螢幕預覽 items 行加單價 / 小計 |
| **`C:\dev\desktop-companion`** | `companion-server.mjs`(:355-366) | items 渲染加價錢；`TITLE` 映射加 `kiosk`（現係 `receipt`→收據 / `kitchen`→廚房 / 其他→空） |
| **`C:\dev\print-agent-android`** | `app/.../model/PrintDtos.kt`(:26-29) | `PrintItemDto` 加 `unitPrice` / `amount` + JSON 解析 |
| **`C:\dev\print-agent-android`** | `app/.../net/EscPosRenderer.kt`(:249) | items 行渲染加價錢 |

> 已確認現況：Android `PrintItemDto` 得 `name / quantity / specs / note` 四個欄，**冇價錢**；`EscPosRenderer.kt:249` 係 `"${i+1}. ${it.name}  x$qty"`。desktop companion `companion-server.mjs:355-366` 同樣冇價錢。
> → **呢三處唔改，Kiosk 小票就印唔到價格。**需要你確認係咪三個 repo 一齊改，定先做桌面 companion（Kiosk 通常係 Windows 電腦／Android 平板）。

---

## 5 · 仲要你拍板嘅問題（完整句子）

1. **Kiosk 部打印機嘅設定要放喺邊？** 方案甲：Kiosk 部機自己開 `/settings` 配打印機（用現有 `loadDeviceConfig()` localStorage，唔使新欄位，但要 physically 去部機度設）；方案乙：打印機設定一齊存落 `pos_kiosk_settings.printer`（按店，喺 POS 度集中設，但如果一店多部 Kiosk、每部機唔同打印機就要再加 device 維度）。

2. **「商家完成出餐後更改狀態並通知客人取餐」——「通知客人」用咩機制？** 現有系統**完全冇**呢個功能。Kiosk 落單成功頁 5 秒倒數後會 reset（等下一位客人），客人亦唔會企喺部機前面等。你嘅想法係：加一個「取餐看板」頁（大堂電視／平板顯示邊啲取餐號 ready）、定係客人用手機掃小票上嘅 QR 睇自己張單狀態、定係純人手叫號（系統只標記 ready，唔負責通知）？

3. **Kiosk 快餐單「未付款就出餐」要放寬現有限制？** 而家 `updateQuickFulfillmentInStore`（`src/lib/quick-order-fulfillment.ts:33`）硬性要求 `status === "paid"` 先准標記 preparing / ready，即係現有快餐流程係**先付款後出餐**。你嘅流程係「出餐 → 通知取餐 → 客人取餐**並支付**」，要先放寬呢個 gate（容許 `sent_to_kitchen` 狀態都可以標記 ready），定係其實 Kiosk 落單時已經線上付款？

4. **掃碼自點（堂食）係咪真係完全唔印客人小票？** 客人部手機冇打印機，我理解係唔印；但如果係「自取」嘅掃碼單（冇枱號）你要唔要照出一張小票落收銀／Kiosk 部機？

5. **Kiosk 係咪徹底鎖死淨做快餐？** 即係 `/order` 唔再提供堂食（揀枱）選項；定係保留堂食能力、只係唔印小票？另外需唔需要喺 `pos_orders` 加個欄位（例如 `source`）去分辨「呢張單係 Kiosk 落定掃碼落定員工開」？（而家 `draft` 單喺枱位圖一律顯示「未下單」，收銀分唔到邊張係等緊佢確認）

6. **Kiosk 嗰張廚房單，要唔要一併用返商家設定嘅「廚房單模版」？** 現況 Kiosk 建嘅廚房 job **完全冇** `template` / `content`，出紙係走硬編 fallback（無店名、無時間、無單據類型、無頁尾，字體亦唔跟你喺「打印」頁較嘅設定）。你話「唔好改用商家廚房模版」我理解係指**客人小票**唔好用廚房模版；但廚房單本身應唔應該跟返廚房模版，想你確認。（要嘅話就要做 §2.2 嗰三個欄位）

7. **「需要確認」呢個開關係一個開關同時管堂食同快餐，定係分開兩個？** 你嘅流程兩條線都寫「依商家 setting 決定」，我傾向**一個開關管晒**（簡單），但如果你想自取外賣要確認、堂食唔使（或者相反），就要拆兩個。

8. **客人小票印幾多份？** 跟打印機設定嘅 `printer.copies`（現有機制，固定 1 份），定係自助點餐機可以另外設份數？

---

## 6 · 分階段計劃

### Phase 1 — DB + 設定基建（無 UI 改動，先落底）
1. 新 migration `0013_kiosk_settings.sql`：建 `pos_kiosk_settings`；`pos_print_jobs` 加 `printer_id` / `template` / `content`
2. 新增 `src/app/api/pos/kiosk-settings/route.ts`（GET 按 storeId、POST upsert）
3. 型別層：`PrintTemplateKind` / `PrintKind` 加 `"kiosk"`、`PrintJob.status` 加 `"held"`、`items` 加 `unitPrice` / `amount`

### Phase 2 — 「自助點餐機模版」
4. `escpos-template.ts`：加 `KIOSK_SECTION_META` / `KIOSK_BLOCK_DEFAULTS` / `DEFAULT_KIOSK_TEMPLATE` / `buildKioskContent`
5. `mock-data.ts` + `storage.ts`：加 kiosk 預設值與 normalize
6. `print-center.tsx`：加「自助點餐機模版」分頁 + 預覽 + **儲存寫入 DB**
7. `escpos-render.ts` + `escpos-preview.tsx`：kiosk 抬頭（空）+ 預覽 items 加價錢

### Phase 3 — Kiosk 落單與出紙
8. `kiosk-order.ts`：`buildKioskReceiptPrintJob()`；`buildKioskKitchenPrintJobs()` 支援 `held`；`buildKioskOrder()` status 由 `requireConfirm` 決定（堂食 + 快餐）
9. `use-kiosk-order.ts`：改讀 DB 設定；`placeOrder()` 先本地出客人小票，再推單
10. `order/page.tsx`：Kiosk 鎖快餐 mode
11. `sync/route.ts` + `pos-order-mapper.ts`：補寫 / 讀回 `printer_id` / `template` / `content`；新增 `PRINT_JOB_UPDATED`

### Phase 4 — 收銀端確認
12. `pos-app.tsx`：確認時將 `held` job 轉 `pending` + 推更新；移除對 `localSettings.kioskKitchenMode` 嘅依賴
13. `local-orders-panel.tsx`：`draft` 單加「待確認」標記
14. `device-settings.tsx`：掃碼點餐 tab 加確認開關（寫 DB）

### Phase 5 — 跨 repo（視第 3 節答案）
15. `desktop-companion` `companion-server.mjs`：items 加價錢 + kiosk 抬頭
16. `print-agent-android` `PrintDtos.kt` + `EscPosRenderer.kt`：items 加價錢

### Phase 6 — 出餐 / 取餐通知（視第 2、3 題答案）
17. 放寬 `updateQuickFulfillmentInStore` 嘅 `paid` gate（如需要）
18. 取餐通知機制（取餐看板 / 手機查單 / 純人手叫號）

### Phase 7 — 驗證與文檔
19. dev box 跑 `npx tsc --noEmit` + `npm run lint` + `npm run build`
20. 實機：Kiosk 落單 → 小票出紙 → 收銀見單 → 確認 → 廚房單出紙
21. 更新 `docs/40`、`docs/41`；本檔案標記為完成

---

## 7 · 風險與注意

1. **`printTemplates` 由 client-only 改為部分落 DB，係架構變動。** 收銀端 `loadRuntimeState()`（`pos-app.tsx:653-676`）同步時刻意保留本地 `printTemplates` 唔畀 server 蓋（docs/71 §8）。新嘅 kiosk 模版唔會受影響（獨立鍵），但要確保 `normalizePosLocalSettings` 唔會因為 DB 冇 `kiosk` 而每次彈返預設。

2. **`pos_kiosk_settings` 係新表，要喺 Macau-Ledger 嗰邊確認唔會衝突**（生態系共用 Supabase，見 `docs/README.md`「相關 Repo」）。

3. **`held` 係新嘅 job status。** 舊版 desktop companion / Android APK 如果直接讀 `status` 嘅話要確認唔會誤判；不過 `held` job 根本唔會派發出去（`dispatch.ts:32` 淨揀 `pending`），所以舊 client 頂多係「無視」，唔會出錯。

4. **客人小票係本地出紙，Kiosk 一定要配到打印通道**（Android APK 嘅 native bridge、或 Windows 嘅 desktop companion）。兩樣都冇嘅話 job 會一直 `pending`，要喺 Kiosk 落單成功頁提示「單據未能打印」。

5. **Phase 6 嘅「通知客人取餐」係全新功能，現有系統零基建**，工作量可能唔細，建議獨立排期。
