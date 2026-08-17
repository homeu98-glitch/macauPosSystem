# 27. Salon → POS DB 接入

> 狀態：已實作（待用家本地 `npm run build` 驗證 + 喺 Supabase 跑 SQL seed）
> 決策：與餐飲共用同一個 POS Supabase 專案（`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`），加 `salon_*` 表；只搞 salon；SQL 建表 + 一次性灌入 mock。

## 1. 背景 / 診斷

Salon 縱向原本 **100% localStorage mock**，完全冇接任何 DB。`src/lib/salon/storage.ts` 全部 `load*/save*` 寫 localStorage + IndexedDB 鏡像；首次啟動由 `ensureSalonBootstrap()` 種入 `buildDefaultSalonBootstrap()`。

而「我們 POS 的 DB」其實已經存在 —— 就係餐飲側用緊嗰個 Supabase 專案（`.env` 的 `SUPABASE_*`，server-only），餐飲已經接好一套完整模式：

- 客戶端 localStorage 優先 → `fetch('/api/pos/*')` → 服務端 `getSupabaseServerClient()`（service role）→ 寫 `pos_*` 表
- 每個 route 都做「冇配 Supabase 就 fallback mock」優雅降級
- Salon 原本留咗 `pushSalonMutation()` seam（`src/lib/salon/idb.ts`），但係空 stub

所以本任務 = 按餐飲同一套模式，將 salon 接去同一個 POS Supabase。

## 2. 架構（mirror 餐飲）

```
Salon 頁面
  └─ src/app/salon/layout.tsx  (client, 開機 fire 一次)
       └─ hydrateSalonFromPosDb()  ── GET /api/salon/bootstrap + /api/salon/state
                                        └─ 寫入 localStorage（下游 load* 唔使改）

Salon 數據變更（save*）
  └─ writeJson(localStorage + idb kv 鏡像)
  └─ idbEnqueue({entity, refId, payload=整個陣列})  → sync-queue
       └─ flushSalonSyncQueue()（online / 頁面可見觸發）
            └─ pushSalonMutation()  ── POST /api/salon/sync
                                        └─ 服務端 getSupabaseServerClient() → upsert salon_* 表
```

離線優先策略不變：localStorage 係熱路徑，DB 係雲端鏡像。冇網照用，有網自動上雲。

## 3. 資料表（`supabase/migrations/0005_salon_tables.sql`）

同一個 POS Supabase，加 `salon_*` 命名空間（與餐飲 `pos_*` 分隔）：

| 表 | 對應客戶端型別 | 備註 |
|----|--------------|------|
| `salon_bootstrap_config` | `SalonBootstrap` | jsonb 裝 service_categories / service_items / staff / stations |
| `salon_bookings` | `SalonBooking` | status 機 + services jsonb |
| `salon_orders` | `SalonPosOrder` | items / tips / payments jsonb |
| `salon_customers` | `SalonCustomerProfile` | ledger_* 欄位（read-only，由 Ledger 而家係 mock） |
| `salon_print_jobs` | `PrintJob` | 收據列印佇列 |
| `salon_queue_events` | — | 同步審計 / 重放 |

RLS：開啟 + 一條 permissive `using(true)` policy（POS 金鑰 server-only，service role 本就繞過 RLS，此處純防禦）。

**Seed**：SQL 檔已 `INSERT` 現有 mock 主數據 —— `salon_bootstrap_config`（8 類目 / 10 服務項 / 3 員工 / 4 房型）+ 5 個示範客戶。**預約/訂單**為運營數據，開機由 `seedMockBookingsIfEmpty()` 種入後經 `/api/salon/sync` 自動上雲，唔在 SQL 預先灌（避免硬編日期）。

## 4. API 路由契約

### `GET/POST /api/salon/bootstrap`
- `GET ?storeId=` → 讀 `salon_bootstrap_config`；冇配 Supabase / 表空 → 返 `buildDefaultSalonBootstrap()` + `source:"mock"`
- `POST` → upsert（body: `SalonBootstrap` 各欄）

### `GET /api/salon/state?storeId=`
- 讀 bookings / orders / customers / printJobs，map 返 client shape
- 冇配 Supabase → `{source:"mock", bookings:[], orders:[], customers:[], printJobs:[]}`

### `POST /api/salon/sync`
- body：`{ storeId, events: [{ type, entityId, payload }] }`
- `payload` = 該 entity 整個陣列（客戶端 `save*` 一併放入 sync-queue）
- 按 type upsert：`BOOKING_*`→`salon_bookings`、`ORDER_*`→`salon_orders`、`PRINT_JOB_CREATED`→`salon_print_jobs`、`CUSTOMER_UPDATED`→`salon_customers`，並寫 `salon_queue_events` 審計
- 冇配 Supabase → 直接 `ok`（優雅降級，同餐飲 `/api/pos/sync`）

## 5. 客戶端接線（零改下游組件）

- `src/lib/salon/idb.ts`
  - `SalonSyncQueueItem` 加 `payload` + `customers` entity
  - `pushSalonMutation()` 由 stub 改為 `fetch('/api/salon/sync')`（payload 由 queue 帶，唔使 localStorage 還原 → 避免循環 import）
  - `flushSalonSyncQueue()` 按 entity 去重，只 push 最新一份
- `src/lib/salon/storage.ts`
  - `saveBookings / saveSalonOrders / saveSalonPrintJobs / saveCustomers` → `idbEnqueue` 帶整個陣列 payload
  - 新增 `hydrateSalonFromPosDb(storeId?)`：GET bootstrap+state，`source==="supabase"` 才寫 localStorage（用 `writeJson` 唔 enqueue，避免 hydrate→save→enqueue→flush→回寫 DB 嘅 loop）
- `src/app/salon/layout.tsx`（新增）：client layout，開機 fire `hydrateSalonFromPosDb()` 一次（module-level 冪等 guard），包住所有 `/salon/*` 頁，唔改現有頁結構

## 6. 用家要做嘅步驟

1. **跑 SQL**：喺 POS Supabase 專案嘅 SQL Editor 貼上 `supabase/migrations/0005_salon_tables.sql` 執行一次（建表 + seed 主數據）。
2. **確認 env**：`.env.local` 已經有 `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`（餐飲側用緊嘅同一套；如未設就補）。
3. **本地驗證 build**（沙盒 EPERM 跑唔到）：
   ```
   npm install && npm run lint && npm run build
   ```
4. **部署**：`git add -A && git commit && git push` → Vercel。
5. 開 app（salon），有網就會由 DB hydrate；之後booking/order/customer 變更自動上雲。

## 7. 降級行為

- `SUPABASE_*` 未配置 → 所有 salon route 返 mock/空，app 照用 localStorage，零 regression。
- 網絡失敗 → `flushSalonSyncQueue` 標 `failed`，下次 online/可見再試；localStorage 永遠可用。

## 8. 開放項目 / 後續

- 預約/訂單嘅建立目前經 `seedMockBookingsIfEmpty` + live sync 上雲；如想 DB 一開波就有示範預約，可喺 SQL 加 `salon_bookings` INSERT（注意 `start_at/end_at` 要用動態日期，建議用腳本而唔係硬 SQL）。
- 餐飲側 `pos_*` 表嘅 RLS 策略未喺 repo 內（疑似 dashboard 手動建）；salon 已一併喺 SQL 處理。
- 真實 Ledger 到位後，`salon_customers.ledger_*` 改由 Ledger RPC 讀（POS 永不寫）。
