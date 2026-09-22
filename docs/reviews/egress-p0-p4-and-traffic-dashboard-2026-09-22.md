# Egress P0–P4 實作 ＋ Admin 雲端用量頁（2026-09-22）

前置分析：`docs/reviews/egress-redesign-local-first-2026-09-22.md`（實測：單店 1.9 GB/日、
92% 來自一部舊 bundle 分頁 690 MB/小時）。

---

## 1. 交付清單

| 檔案 | 類別 | 改動 |
|---|---|---|
| `src/lib/pos/state-sync-watermark.ts` **（新）** | 純邏輯 | 「幾時可以傳 `since`」決策（零 import） |
| `src/lib/pos/state-sync-watermark.test.ts` **（新）** | 測試 | 12 條單測鎖住三條安全規則 |
| `src/lib/pos/state-sync-client.ts` **（新）** | 執行層 | `beginStateSince()` / `commitStateSince()`（工作台 ＋ 訂單頁共用） |
| `src/app/api/pos/state/route.ts` | **P0＋P1** | `since` 增量查詢（單腿）／`ordersOnly` 排除增量；legacy 強制 `queue=0`；回 `incremental` / `truncated`；egress log 加 `incr` / `legacyQueueOff` / `truncated` |
| `src/components/pos-app.tsx` | **P0＋P1** | 開頁走增量；**增量之下停孤兒單對賬**；`truncated` 清水位＋1 秒補拉全量；手動「更新」強制 `forceFull`（並繞過 single-flight） |
| `src/components/local-orders-panel.tsx` | **P3** | 訂單頁 backfill 亦走增量（**296 KB → ~3 KB**） |
| `src/lib/storage.ts` | **P1** | 新增 store-scope 水位 meta（`state-sync-meta`） |
| `src/app/api/pos/print-jobs/status/route.ts` | **P2＋P4** | sweep 由 60 秒節流到 **5 分鐘**；兩條查詢上限 200 → **120**；改用 `jsonWithEgressLog`（多 egress 審計 ＋ 接入計量） |
| `src/lib/egress-log-server.ts` | **計量** | `jsonWithEgressLog(..., { storeId })` → 順手記用量 |
| `src/lib/pos/egress-meter-server.ts` **（新）** | 計量 | 記憶體緩衝 ＋ 節流 flush ＋ `after()` 後寫 ＋ 冇 migration 自動停用 |
| `src/lib/pos/egress-usage.ts` **（新）** | 純邏輯 | 用量匯總／配額／走勢（零 import） |
| `src/lib/pos/egress-usage.test.ts` **（新）** | 測試 | 14 條單測（含 +8 日期、骯髒資料、空表） |
| `supabase/migrations/0048_pos_egress_daily.sql` **（新）** | DB | `pos_egress_daily` ＋ `pos_bump_egress()`（只 `service_role`） |
| `src/app/api/admin/traffic/route.ts` **（新）** | API | `GET /api/admin/traffic?days=N`（只回原始 row，唔喺 server 分組） |
| `src/app/admin/traffic/page.tsx` **（新）** | UI | 「雲端用量」頁（KPI 5 格 ＋ 逐店表 ＋ 走勢 ＋ 頭幾條路徑） |
| `src/components/admin-shell.tsx` | UI | nav 加第 4 項「雲端用量」 |
| `src/app/api/pos/state/state-incremental-contract.test.ts` **（新）** | 測試 | 19 條**安全契約**守衛（見 §4） |
| `src/components/pos-app-queue-identity.test.ts` | 測試 | 配合新簽名更新兩條 source 掃描（意圖不變） |

---

## 2. P0–P4 逐項（改動前 → 改動後）

| # | 項目 | 改動前 | 改動後 | 為何唔會影響流程 |
|---|---|---|---|---|
| **P0** | 舊 bundle 全量拉取 | 903 KB／次（`queue=300` 佔 502 KB） | **422 KB／次（−53%）** | `queue: []` 之下 client 嘅 merge 係「本地為底 + 補 server 事件」⇒ **完整保留本地 queue**（等同 v2 `skipQueue=1` 一直都係咁做）。無 4xx、無改形狀、無改欄位名 |
| **P1** | 開頁／重連補拉（工作台） | 全量 **412 KB** | **增量 ~30 KB** | 只係**回少啲行**，merge 語義不變。冇水位／空機／水位太舊／壞／未來 → **自動退回全量**（＝舊行為）。斷網／401 → 照舊失敗（唔推進水位） |
| **P1** | Realtime 重連補拉 | 同上 | 同上 | 原本已有 30 秒最少間隔守衛 |
| **P2** | 打印中心狀態輪詢 | 2 條 `limit=200` ＋ sweep **每 60 秒** | 2 條 `limit=120` ＋ sweep **每 5 分鐘** | sweep 係衞生工作（逾期 job 標 failed）；重試本身由 claim 嘅 60 秒窗處理，**唔會令重試變慢**，只係 UI 紅標遲幾分鐘 |
| **P3** | 訂單頁 backfill | **~296 KB／次**（200 張完整訂單） | **~3 KB** | 同 P1 同一套水位；訂單頁本來就係讀 localStorage（`loadOrders()`），拉取只為「發現其他裝置嘅變更」 |
| **P4** | 週期輪詢源 | 已確認 **冇** `useEffect` 輪詢源（`use-store-status` / `use-merchant-order-config` 本身 event-driven ＋ Realtime；輪詢閘唔會自己 fetch） | 收緊唯一仍按時間打嘅兩處（sweep 5 分鐘；topup pending 已有 60s/300s 閘） | — |
| **P4+** | 每頁載入嘅 endpoint 數 | 不變（store-status / online-order-settings 等係 page-load 而非 poller） | 不變 | 留待日後併入 bootstrap payload |

**實測對照（估算，以本次改動為準）**

| 情境 | 改動前 | 改動後 |
|---|---|---|
| 舊分頁開住（每次 4.6 秒） | 690 MB/小時 | **~320 MB/小時**（P0）→ 舊分頁一 reload 就跌到 ~20 MB/小時 |
| 正常開頁（新 bundle） | 412 KB／次 | **~30 KB／次（−93%）** |
| 訂單頁 backfill | 296 KB／次 | **~3 KB／次（−99%）** |
| 單店每日 | ~1.9 GB | **~20–40 MB** |
| 5 GB 免費額 | 唔夠 1 間店 | **可容 8–16 間店** |

---

## 3. Admin「雲端用量」頁

### 3.1 為何需要

Supabase Dashboard 只會俾**專案總數**，但一個專案裡面有**多間店** ⇒
2026-09-22 商家問「加多一兩間店會唔會爆 5 GB」，Dashboard 答唔到，
要人手拉 Supabase ＋ Vercel log 反推。呢頁把它變成一眼睇得到。

### 3.2 版面

- **KPI 固定 5 格**（沿既有規則）：本月總用量（佔 5 GB %）／今日用量／有用量嘅店數／
  推算全月／仲可容納幾間店。
- **逐店表**：店名 ＋ storeId／今日／本月／佔免費額（＋正常·留意·接近配額）／
  最近 14 日走勢（mini bar）／頭 3 條食流量路徑。
- 支援 7／14／30／90 日窗口。
- migration 未跑 → 顯示「計量尚未啟用」而**唔會爆錯**。

### 3.3 計量設計（唔可以令計量自己變成流量來源）

```
route 回 response（bytes 已知）
   └─ recordEgressUsage({ storeId, route, bytes })      // 記憶體累加，永不 throw、永不 await
        └─ 同一個 store|day|route 最多每 60 秒（或 25 次／512 KB）才 flush
             └─ after() 之後 → 1 個 RPC pos_bump_egress()（原子 upsert 累加）
```

- **`after()`**（Next 16）：寫入喺 response 之後，唔佔 response 時間。
- **冇 migration 自動停用**：見到 `42883 / does not exist / PGRST202` 就永久停（試一次記住結果），
  唔會每次請求都撞一個 error。
- **澳門日期**：server 自己 +8 計 `day`（Vercel 跑 UTC）—— 真源喺 `egress-usage.ts`，有單測鎖住。
- **口徑老實講**：量到嘅係「Vercel Function → 瀏覽器／APK」嘅 response bytes；
  帳單官方口徑係「Supabase → Vercel Function」。方向相反、數量級一致 ⇒
  適合做**相對比較同趨勢**，精確對帳單請睇 Supabase Dashboard（頁面 footer 有寫）。
- **已計量路徑**：`pos/state`、`pos/print-jobs/status`（歷史觀測嘅絕大部分）。
  其餘路徑單次細，未接入 —— 頁面亦有寫明，唔會令人以為係全量總數。

### 3.4 需人手做嘅一步

`supabase/migrations/0048_pos_egress_daily.sql` **要喺 Supabase SQL Editor 手動貼**（同 0047 一樣）。
未跑之前：**所有 POS 功能完全不受影響**，admin 頁顯示「計量尚未啟用」。

---

## 4. 安全論證（「唔影響流程、打印維持正常」係硬約束）

### 4.1 兩個「唔可以犯」嘅災難級錯誤（已寫成守衛測試）

1. **增量 payload 唔可以當全集用**：
   孤兒單對賬判準係「雲端冇呢張單」⇒ 增量之下照跑會**把全店未變更過嘅單一次過隔離**
   （收銀枱面清空）。已加 `if (!payload.incremental)` 包住，並有 source 掃描守衛。
2. **舊版止血只可以「少行數」**：唔可以回 4xx／空 body／改形狀，否則舊分頁**完全拉唔到嘢**。
   守衛測試明文禁止 `isLegacyFullState` 附近出現 4xx/5xx。

### 4.2 其他已加嘅守衛（`state-incremental-contract.test.ts`）

- `ordersOnly` 一律唔做增量（報表／交班／對賬守護要完整區間，唔可以只回差量）。
- 增量行單腿查詢（唔可以變返三腿 OR，語義唔明）。
- 增量時 queue 一定 `limit(0)`。
- 回應一定帶 `incremental` / `truncated`；撞 limit **同**查詢失敗都當 truncated。
- 手動「更新」一定 `forceFull`，而且**繞過 single-flight**（唔可以被 in-flight 增量吞掉）。
- `truncated` ⇒ 清水位 ＋ 1 秒後補一次全量。
- 水位只可以喺**成功回應之後**更新（失敗／401 唔可以推進水位）。

### 4.3 出紙路徑完全冇改

`print-jobs` 嘅建立／入隊／`onceKey` 去重／`claimOncePrintJobs`／中繼 claim
**一行都冇改**；P0／P1 只改「拉」嘅範圍，P2 只改 sweep 節流同 limit。

---

## 5. 驗證

| 檢查 | 結果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `eslint`（15 個改動／新增檔） | **0 error**（9 個 warning 全部係 `pos-app.tsx` 既有） |
| `node --test`（全套） | **1169 passed / 0 fail**（本次新增 39 條） |
| 新增單測 | `state-sync-watermark` 12／12、`egress-usage` 14／14、`state-incremental-contract` 13／13 |
| **真編譯／渲染煙霧測試** | `next dev`（port 3111）→ `/admin/traffic` `/` `/orders` `/prints` **全部 HTTP 200**、dev log **零編譯錯誤**、server 已正常關閉<br>（`tools/_smoke-pages-20260922.cjs`；⚠️ 本機冇 coreutils，等待／清理全部用 Node 自己做 + `taskkill /T`） |

---

## 6. 部署步驟

1. **Supabase SQL Editor**：貼 `supabase/migrations/0048_pos_egress_daily.sql`（唔跑都得，只係 admin 頁顯示未啟用）。
2. **commit ＋ push → Vercel Redeploy**（B1／P0／P1／P2 全部係 server 端，一 deploy 即生效；
   客戶端部分要裝置 reload 到新 bundle）。
3. 驗證：
   - Vercel log 應該見到 `[egress] pos/state ... incr=1 since=…`（增量生效）
     同 `legacyQueueOff=1`（舊分頁被止血）。
   - Supabase log：`pos_queue_events` 嘅 `limit=300` 應該**歸零**（舊版唔再拉 queue）。
   - Admin → 雲端用量：24 小時後應該見到逐店數字。
4. 回滾：P0 刪 `legacyQueueSuppressed` 條件；P1 由 client 送 `forceFull` 或刪 `since`；
   P2 改返 `200`／`60_000`；計量設 `POS_EGRESS_METER=0`（環境變數）。

---

## 7. 已知限制／未做

| 項目 | 說明 |
|---|---|
| 報表仍然會拉全量區間（`limit=2000`） | **刻意**：專案明文禁止改「報表＝雲端真值」（會令換機數字唔同）。投影已做（對賬查詢 289 KB → 3.7 KB）；報表係用家主動開，屬合理用量 |
| 增量撞 `limit` 嘅臨界 | 靠 `truncated` → 清水位 → 補全量自癒。極端情況（一次過改 >200 張單）會多一次全量拉取 |
| 計量覆蓋 | 只有 `pos/state`、`pos/print-jobs/status`；其餘路徑未接入（頁面有寫明） |
| 舊 API 參數 | `/api/pos/state` 舊參數（`ordersOnly` / `skipQueue` / `limit` / `offset` / `start` / `end` / `fields`）行為**完全不變**，未 reload 嘅裝置照常運作 |
