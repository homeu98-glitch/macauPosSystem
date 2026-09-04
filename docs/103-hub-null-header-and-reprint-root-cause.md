# 103 · Hub 打印 header="null" + 重開誤印舊單：雙問題根因定位

> **一句講晒**：兩個問題同源——`PRINT_JOB_CREATED` 寫入端（`/api/pos/sync`）只填咗 0020 schema 嘅一部分欄位（`store_name`/`kind`/`payment_method`/`total`/`ttl` 全部從不寫入），加上 org.json `optString` 對 JSON null 會回**字面字串 `"null"`** 嘅地雷，令 header 印出 "null"；而重印係舊版非冪等 upsert（docs/101 已修但**未 deploy web**）把 `sent` 打返 `pending`，Hub 重開 claim 到舊單。

> **性質**：**診斷 + 修復方案已應用**。2026-09-04 用戶確認後動手改 code；web 端要 deploy 先生效，APK 已 build。

---

## 1. 問題一：header 顯示 "null"

### 1.1 症狀

廚房單第一行（應為店名）印出字面 `null`，跟住只見 `【廚房單】`。

### 1.2 根因鏈（四步，全部實證）

1. **Server 從不寫 `store_name`**：`src/app/api/pos/sync/route.ts` 嘅 `PRINT_JOB_CREATED` 處理（contentPatch + insert）欄位清單入面**冇 `store_name`**（亦冇 `kind`、`payment_method`、`total`、`copies`、`ttl`、`printer` jsonb——呢啲全部係 0020 migration 加畀 Hub 用嘅欄，寫入端一直冇填）→ 雲端 `pos_print_jobs.store_name` **恆為 NULL**。
2. **claim 回傳整行**：`pos_claim_print_jobs` RPC `returning j.*`（0020:101）→ Hub 收到 `"store_name": null`（JSON null，唔係冇 key）。
3. **org.json 地雷**：`JobRunner.kt:126`
   ```kotlin
   val storeName = row.optString("store_name").takeIf { it.isNotBlank() } ?: prefs.storeName
   ```
   Android org.json 嘅 `optString` 對 **JSON null 值**回**字面字串 `"null"`**（只有 key 唔存在先回 `""`）。`"null".isNotBlank() == true` → `.takeIf` 擋唔住 → `storeName = "null"`，連 `prefs.storeName` fallback 都永遠行唔到。
4. **fallback 渲染器直接印**：冇 template 嘅 job（例：`shift-page.tsx:213` 交班單重打——個 PrintJob 冇 `template` 冇 `content`）行 `EscPosRenderer.renderKitchenTicket`（`JobRunner.kt:158`）→ 第一行 `buf.line(storeName)` 印出 `null`、第二行 `ticketTypeLabel` 印 `【廚房單】`——**同症狀逐字吻合**。

### 1.3 同類地雷（順手要修，唔修運早再中）

| 位置                                | 問題                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrintDtos.kt:120` `parseContent` | `map[k] = c.optString(k)` — content 值係 JSON null 時變 `"null"` 印出（模板路徑嘅 header block）                                                           |
| `pos-app.tsx:2136, 2242, 2247`    | `bootstrap.storeName` **未設防**（冇 `?? "門店"`；752/863 同 print-center:472 都有設防）→ bootstrap.storeName 為 null 時 content.store_name = null → 印 "null" |
| `JobRunner.kt:123,127`            | `kind` / `payment_method` 同樣從不寫入 → optString 變 `"null"`（kind 無害但錯；fallback 收據會印「支付: null」）                                                    |

### 1.4 已應用嘅修復

1. **Server 補欄**（治本）：`sync/route.ts` `PRINT_JOB_CREATED` 寫入 `store_name`：優先用 `eventPayload.storeName`，冇就用 `eventPayload.content.store_name`。
2. **Hub 防禦**（治標但必須）：`JobRunner.kt` 加 `optCleanString()` —— 先 `isNull(key)`，再擋 `"null"` 字面 → 避免 org.json 地雷；`storeName` 再加 `job.content["store_name"]` fallback。
3. **Web 設防**：`pos-app.tsx:2136/2242/2247` 加 `?? "門店"`（同 print-center:472 對齊）。
4. **同類地雷順修**：`payment_method` 改用 `optCleanString()`；`kind` 擋 `"null"` 字面。

## 2. 問題二：開關 print-relay 誤印舊單

### 2.1 先排除：Hub 冇本地快取

- `HubService` 出紙只有一條路：`drainNow()` → `api.claim()` → server RPC（啟動即刻一次 + 30s 對賬 tick + Realtime 叫醒）。
- `HubHttpServer`（:8787）係**被動** HTTP 端點，收到 POST 先印，冇任何 outbox／重發緩衝。  
  → 重印素材 100% 來自**雲端 `status='pending'/'failed'` 嘅舊行**（RPC 0020:85 只揀呢兩個 status，`sent`/`printing` 永遠唔會被再 claim）。

### 2.2 根因：舊版 upsert 把 `sent` 打返 `pending`（docs/101 已修，未 deploy）

完整流程（呢個先係「重開就重印」嘅機器）：

```
落單 → PRINT_JOB_CREATED 入本地 sync queue
  → flush 推上雲（若呢下失敗：短暫離線 / relay-transport 假 ok 但 fetch 其實失敗）
  → 事件留喺本地 queue 一直 pending
Hub claim → 印 → report sent → 雲端 status='sent' ✅
（之後任何時刻）web 端 online / visibilitychange / 30s 定時 → 重推同一個事件
  → 舊版 server upsert(onConflict id) 無條件寫 status=payload.status（"pending"）
  → 雲端張單 sent → pending ❌（中毒）
Hub 重開 → drainNow → claim 到呢批 pending → 重印 💥
```

「**有時候**」先中：只有「初次 flush 失敗過、事件留喺本地 queue」嘅單先會被重推——所以係間歇性，同網絡狀態掛鉤。

### 2.3 點解上次修咗仲有

docs/101 嘅冪等修法（update 唔動 status → 冇命中先 insert）**只改咗本機 repo**；你其後只 rebuild 咗 print-relay APK，**web 服務端從未 deploy**——APK 唔含 server 代碼，所以重印照舊。

### 2.4 額外發現：`ttl` 防線從未啟用

0020 特登設計 `ttl` 欄（「過期就唔再印，避免隔夜單突然出紙」，RPC 0020:87 有檢查），但 sync route **從不寫 `ttl`** → 恆為 null → 永不過期。中毒行唔會自然死亡。

### 2.5 已應用嘅修復

1. **冪等寫入**：`sync/route.ts` + `salon/sync/route.ts` 已改成「update 唔動 status → 冇命中先 insert 寫 status」（docs/101），重推唔會把 `sent/printed` 打回 `pending`。
2. **終態 `printed`**：`print-agent/result` 成功後寫 `status='printed'`；`print-jobs/status` 輪詢 `printed` 並對網頁映射為 `sent`；`types.ts` / `print-jobs.ts` / `print-center.tsx` / `salon/prints-content.tsx` 都識 `printed`。
3. **清中毒行**（一次性 SQL，deploy 後跑）：
   ```sql
   update pos_print_jobs
      set status = 'failed', last_error = 'docs/103 清理：舊 upsert 中毒行'
    where status in ('pending', 'failed')
      and created_at < now() - interval '1 hour';
   ```
   （唔好標 `sent`——嗰啟單未必真係印過；標 `failed` 保守啲，重印靠 reprint 動作。）
4. **冇做 TTL**：今次冇加 `ttl`，因為 `printed` 終態已足夠防 re-claim；如需防「隔夜單」可另案補。

## 3. 驗收 SQL

```sql
-- 問題一：確認 null header 嗰張單係咪冇 template、store_name 係咪 NULL
select id, ticket_type, template is null as no_template,
       store_name, content->>'store_name' as content_store_name,
       created_at
  from pos_print_jobs
 order by created_at desc limit 20;

-- 問題二：deploy 後觀察——同一 id 唔應該再出現 sent 之後 updated_at 跳、status 變 pending
select id, status, attempts, claimed_by, updated_at
  from pos_print_jobs
 where status in ('pending', 'failed')
 order by created_at;
```

## 4. 相關文檔

- [docs/101](./101-print-job-reprint-idempotent-fix.md) — PRINT_JOB_CREATED 冪等修法（已改本機，待 deploy）
- [docs/102](./102-printed-terminal-state-plan.md) — `printed` 終態方案（Plan，未動手）
- [docs/96](./96-cloud-print-relay-design.md) — 雲端中繼設計（claim/result 合約）
