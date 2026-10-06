# macau-pos 側改動說明 — 抓單（grabber）三個端點

> **日期**：2026-10-06　**改動方**：APK 開發方（J）
> **目標 Repo**：`macauPosSystem`（`C:\dev\macauPos\macauPosSystem`）
> **一句話總結**：三個端點**必須由 macau-pos 實作**，APK 端已全部就緒，只欠 POS 側上線。

---

## 0. 結論：為什麼是 macau-pos 負責（不是 APK、不是會員通）

| 選項 | 判定 | 理由 |
|---|---|---|
| **macau-pos 實作** | ✅ **採納** | 抓單落地表、去重、投影 `PosOrder`、對帳**本來就喺 POS 職責內**；Joe 已有成熟嘅 `lib/grabber/grabber-order.ts` 投影邏輯同 `pos_orders` 寫入路徑 |
| APK 實作 | ❌ | APK 只識得 WebView 抓單，唔識 `pos_orders` schema；而且**多間店共機**時會令「邊個店」變成本機狀態，無法跨裝置去重 |
| 會員通（Ledger）實作 | ❌❌ | **架構紅線**。Ledger 方三份獨立審查一致判決：會員通**零表、零 RPC、零抓單資料**。原始 JSON 含**顧客電話、地址**個資，留喺會員通係資安問題 |

### 最關鍵的一點：Joe 其實**已經有**投影邏輯

Repo 內已存在（**本次唔需要重寫**）：

| 檔案 | 內容 |
|---|---|
| `src/lib/grabber/grabber-order.ts` | `projectGrabberOrder()` — payload → `pos_orders` 一列，純函式、有 `node --test` 覆蓋 |
| `src/lib/grabber/grabber-secret.ts` | 共享密鑰驗證（**只畀插件路線用**） |
| `src/app/api/integration/grabber/{orders,settlement,store}/route.ts` | **插件路線**（Chrome extension），照舊運作 |
| `supabase/migrations/0062_pos_grabber_push_log.sql` | 推送稽核表（已存在） |

⇒ 本次改動係**加一條新路線**，**沿用同一份投影函式**。零重寫、零規則分歧。

---

## 1. 三個端點的呼叫方與實作位置

### 呼叫鏈（APK → POS）

```
APK grabber/GrabberIngest.kt
  └→ posrelay/RelayApi.kt
       ├→ POST /api/pos/grabber/ingest     （推單）
       ├→ GET  /api/pos/grabber/count      （查已送幾多）
       └→ GET  /api/pos/grabber/capability （問入口可唔可見）
              ↓  header: x-agent-id / x-agent-token
       macau-pos Next.js route（✅ 本次已實作）
              ↓
       Supabase（POS 自有專案）
         • pos_grabber_inbox        （新，原始落地 + 冪等）
         • pos_grabber_capability   （新，每店旗標）
         • pos_grabber_push_log     （既有 0062，稽核）
         • pos_orders               （既有，最終投影）
```

### 本次新增檔案（全部**新增**，零修改既有檔案）

| # | 檔案 | 行數 | 說明 |
|---|---|---|---|
| 1 | `supabase/migrations/0064_pos_grabber_inbox_and_capability.sql` | ~230 | 2 張表 + 索引 + RLS（service_role only） |
| 2 | `src/app/api/pos/grabber/ingest/route.ts` | ~350 | POST：解析 → 落地 inbox → 投影 `pos_orders` |
| 3 | `src/app/api/pos/grabber/count/route.ts` | ~70 | GET：已落地筆數 |
| 4 | `src/app/api/pos/grabber/capability/route.ts` | ~85 | GET：第 1 層旗標（fail-closed） |

**`tsc --noEmit` 全專案 0 錯誤**（已驗證）。

---

## 2. API 契約

### 2.1 `POST /api/pos/grabber/ingest`

**認證**：`x-agent-id` + `x-agent-token`（沿用現有堂食 POS 配對憑證，`EncryptedSharedPreferences`）
**綁店**：body 嘅 `storeId` **必須**等於 token 對應嘅 `storeId`，否則 **403**。⚠️ 唔可以信任 body — 否則任何一部已配對嘅機都可以寫入其他店。

**請求**
```json
{
  "storeId": "<POS store uuid>",
  "platform": "mfood | aomi | mpay",
  "kind": "order | settlement | finance",
  "rows": [ { /* 最多 200 列，APK 每批 50 */ } ]
}
```

**`rows[]` 每列欄位**（`kind=order`）
```json
{
  "dedup_key": "mfood:202609291313345883658",
  "source_id": "202609291313345883658",
  "trade_no": "…",
  "store_name": "…",
  "amount_mop": 118.0,
  "business_amount_mop": 118.0,
  "status_text": "completed",
  "placed_at_ms": 1791278267394,
  "raw": { /* 平台原始回應（會存落 inbox） */ }
}
```

**`rows[]` 每列欄位**（`kind=settlement`）
```json
{
  "dedup_key": "mfood:2026W42:trade-no",
  "source_id": "…",
  "begin_date": "2026-10-01", "end_date": "2026-10-07", "bill_date": "2026-10-08",
  "gross_amount_mop": 1200.0, "net_amount_mop": 950.0,
  "is_settled": false,
  "placed_at_ms": 1791278267394,
  "raw": { }
}
```

**回應 200**
```json
{
  "ok": true,
  "received": 50,
  "inserted": 12,          // 真正新投影入 pos_orders 嘅筆數
  "updated": 35,           // 冪等擋走（重送重複單）
  "projected": 12,
  "rejectedCount": 3,      // 髒資料筆數（單列隔離，唔會令成批失敗）
  "rejected": 3,           // ← APK 讀呢個欄
  "rejectedDetail": [ { "dedupKey": "…", "reason": "缺少 amount_mop" } ],
  "warnings": [],
  "auditLogged": true
}
```

**其他狀態碼**

| 碼 | 原因 | APK 行為 |
|---|---|---|
| 401 | agent 驗證失敗 | 顯示「請重新配對」 |
| 403 | `storeId` 不符 | 顯示錯誤（跨店保護） |
| 400 | 參數／單批超上限 | 顯示錯誤 |
| 413 | payload > 1 MB | 顯示錯誤 |
| 503 | **0064 未跑** | 顯示「POS 側 grabber 未初始化」 |
| 500 | 投影失敗（已落地 inbox） | 顯示失敗 + `landed` 數 |

### 2.2 `GET /api/pos/grabber/count?storeId=&platform=`
認證同上。回 `{ ok, count, storeId, platform }`。
🔴 **404/503 → APK 顯示「未知」，絕不當 0**（回 0 會令店員以為漏單）。

### 2.3 `GET /api/pos/grabber/capability?storeId=`
認證同上（**純讀，不寫 `last_seen_at`**）。回 `{ grabberEnabled: bool, note, updatedAt }`。
🔴 **fail-closed**：row 唔存在／未初始化／Supabase 未配置 → 一律 `false`。

---

## 3. 影響面

| 服務 | 影響 |
|---|---|
| **macau-pos** | ✅ 新增 4 檔。**既有 route／元件／`pos_orders` schema 零改動**。列印中繼（`print-agent/*`）完全不受影響 |
| **插件路線**（`/api/integration/grabber/*`） | ✅ **零改動**，照舊運作。兩條路線並存 |
| **會員通 APK（本 repo）** | ✅ 已就緒。三個 client function 寫好，等端點上線即通 |
| **會員通 Ledger DB** | ✅ **零 migration、零表、零 RPC**（紅線守住） |
| **print-agent / 堂食對賬** | ✅ 零影響（不同 auth、不同表、不同路徑） |

### 路由註冊
Next.js **App Router 自動註冊**，檔案放落 `src/app/api/pos/grabber/<name>/route.ts` 即生效，**唔需要**手動註冊或 middleware。

### 權限
- RLS 已開，`anon` / `authenticated` **一律 revoke**（`0064` 檔內）。
- `service_role` bypass RLS —— route 用 `getSupabaseWriteClient()`。
- 🔴 **資料隔離靠 route 層綁店**（`storeId !== agent.storeId` → 403），**唔靠 RLS**（service_role 會 bypass）。

---

## 4. macau-pos 需要異動的檔案（Joe 側待辦）

| # | 動作 | 檔案 | 狀態 |
|---|---|---|---|
| 1 | **執行 migration** | `0064_pos_grabber_inbox_and_capability.sql` | ⬜ 需 Joe 執行 |
| 2 | **部署** 4 個新檔案 | 上表 | ✅ 已寫好，待 deploy |
| 3 | 設定 `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Vercel env | ⬜ 確認已存在（`print-agent` 已在用） |
| 4 | **開放首批試點店**旗標 | `pos_grabber_capability` | ⬜ 見下 SQL |
| 5 | （可選）Dashboard 加開關 UI | — | ⬜ 非阻塞 |

### 開放某間店（大店）
```sql
insert into public.pos_grabber_capability (store_id, grabber_enabled, note, updated_by)
values ('<STORE_UUID>', true, '首批試點', 'manual-sql')
on conflict (store_id) do update
  set grabber_enabled = true, updated_at = now();
```
未 insert 嘅店 → APK **完全見唔到**平台入口（判決「小店預設完全隱藏」）。

---

## 5. 相容性處理

| 情境 | 行為 |
|---|---|
| **0064 未執行** | `ingest` → **503**「未初始化」；`count` → 503；`capability` → 200 + `grabberEnabled:false`。**列印／出單完全不受影響** |
| **舊 APK**（未改嘅） | 唔識叫呢三條端點 → 零影響 |
| **插件路線** | 零改動，繼續可用 |
| **新 APK + 舊 POS**（未 deploy） | `capability` → **404** → APK fail-closed（隱藏入口，已驗證正確行為）；`count` → 404 → 顯示「未知」；`ingest` → 404 → 顯示連線失敗 |
| **版本旗標** | **唔需要**。已用 fail-closed + 404/503 語義達到向后兼容；加版本旗標反而會製造兩套分支 |
| **冪等** | `(store_id, platform, kind, dedup_key)` 唯一鍵 + `ON CONFLICT DO NOTHING`。APK 每次重查都會重送同一單 ⇒ **冇呢個就會炸出幾百張重複單** |
| **覆蓋風險** | 一律 `DO NOTHING`，**絕不 upsert 覆蓋** — 否則店員已推進嘅狀態（已接受／製作中／完成）會被打返「待確認」 |

---

## 6. 驗證方式

### 6.1 Joe 側（POS）
```bash
cd macauPosSystem
# 1) 型別檢查（本次已通過：0 錯誤）
node node_modules/typescript/bin/tsc --noEmit

# 2) 起 dev server
node node_modules/next/dist/bin/next dev

# 3) 確認 0064 已跑（Supabase SQL Editor）
select tablename from pg_tables
 where tablename in ('pos_grabber_inbox','pos_grabber_capability');
-- 期望：2 行

# 4) 未配對 → 401（fail-closed）
curl -i http://localhost:3000/api/pos/grabber/capability?storeId=x
# 期望：401
```

### 6.2 端到端（APK + POS）
```
1. 部署 POS 4 個檔案 + 跑 migration 0064
2. SQL 開放測試店 pos_grabber_capability
3. 驗證關閉態：APK 卸載 debug 開關 → 底欄「平台」消失
4. 驗證開啟態：重新開 debug 開關 → 底欄 5 格
5. 設定 → 抓單卡 → 啟用抓單 + 揀 mfood
6. 平台頁 → 自動登入 + 抓單
7. POS 側查：
   select created_at, platform, kind, parse_ok, reject_reason
     from pos_grabber_inbox
    where store_id = '<UUID>' order by created_at desc limit 20;
   -- 期望：有入帳、parse_ok 大部分 true
8. POS web 應該見到新訂單（status=draft，待確認）
9. 重複送同一單（撳兩次）→ inserted 應該係 0、updated 增加 ⇒ 冇重複單
```

### 6.3 針對性測試
| 測試 | 期望 |
|---|---|
| 送一列缺 `amount_mop` | 該列 `rejected`，**其餘列照入** |
| 送空 `rows` | 200，`inserted:0` |
| body 嘅 `storeId` 改成另一店 | **403** |
| 重送同一 `dedup_key` 10 次 | 只有 1 個 `pos_orders` 列 |
| 未跑 0064 就打 ingest | 503 + 明確訊息 |

---

## 7. 潛在風險

| # | 風險 | 級別 | 緩解 |
|---|---|---|---|
| 1 | **migration 未跑**功能開不了 | 中 | 503 明確報錯；APK 顯示「未初始化」而非靜靜失敗 |
| 2 | `raw` JSON 無上限留存會**食容量** | 中 | 故意唔自動清理（破壞性行為唔應該靜靜發生）。TTL 待 Joe 拍板，`0064` 檔尾已留 pg_cron 範例 |
| 3 | `autoAccept` 硬寫 `false` | 低 | 保守方向（寧願店員撳一下）。要支援自動接單需 Joe 決定（會與「線上單共用嗰個掣」交互影響） |
| 4 | 對帳（`settlement`）**只落 inbox，未投影** | 低 | 符合判決分工（對帳喺 POS 側後續處理）。但**未來**要補 projection worker |
| 5 | `GrabberOrder` 有索引簽章 `[key: string]: unknown` | 中 | ⚠️ 傳錯欄位名 **TypeScript 唔會報錯**，只會靜靜讀 `order.amount ?? {}` → 營業額 0。**改呢個檔時務必開啟嚴格型別檢查或加 runtime assert** |
| 6 | in-memory 單平台無冪等鎖 | 低 | DB 唯一鍵已保證冪等；重入只會多一次 `DO NOTHING` |
| 7 | APK 離線重試堆積 | 低 | 批次 50、單批上限 200、payload 1 MB 上限；超出回 400/413 |

---

## 8. 一句話交收

> 三個端點**必須**由 macau-pos 實作。改動已全部寫好並通過型別檢查，
> Joe 只需 **① 跑 `0064` migration ② deploy 4 個檔案 ③ 開放試點店旗標**，
> 即可用。
