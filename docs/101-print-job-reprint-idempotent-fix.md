# 101 · 打印工作重推冪等修復（根治 hub 重開重印）

> **一句講晒**：`PRINT_JOB_CREATED` 上雲嗰陣用 `upsert(onConflict:"id")` 會把已 `sent`/`failed` 嘅單打回 `pending`；web 離線補推 / 重連重推就會令 hub 一重開就 claim 晒啲舊單重印。改做「先 update 內容（唔動 status）→ 冇命中先 insert（首次先寫 status）」就根治。

> **性質**：**根治性修復**（服務端 Next.js API route，唔喺 print-relay APK 入面）。關聯 `docs/99`（hub 打印格式變形，係 APK 端）同 `docs/80`（ESC/POS 字型放大 B2）。

---

## 1. 現象
- 每次關閉並重新打開 macau print hub → 之前印過嘅 request 全部重印一次。
- log 入面啲 request 時間戳係「重新打開時嘅新時間」（hub 永遠 `System.currentTimeMillis()` 印，唔能分辨 re-claim vs re-send）。

## 2. 根因（decision）
`supabase/migrations/0020_print_relay.sql:85` 個 `pos_claim_print_jobs` RPC 只揀 `status IN ('pending','failed')`：
```sql
where j.status in ('pending', 'failed')
  and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
```
` sent` 同 `printing` **永遠唔會被 re-claim**。所以「重開就重印」必然係啲單喺 reopen 嗰刻係 `pending`/`failed` —— 唔係 (a) hub 印咗冇報 sent（嗰個會卡死做 `printing` 失蹤單，唔係重印），而係 (b) **web 重推咗 `PRINT_JOB_CREATED` 事件，把雲端 `sent` 張單 status 打回 `pending`**。

舊碼（`src/app/api/pos/sync/route.ts` 舊版）：
```ts
await supabase.from("pos_print_jobs").upsert(
  { id, store_id, ... , status: text(eventPayload.status,64) ?? "pending", ... },
  { onConflict: "id" },
)
```
`upsert` = `ON CONFLICT(id) DO UPDATE SET ...` 全部欄照寫 → 重推就無條件把 `status` 覆寫做 `pending`。

## 3. 修復
### 3.1 pos 端（「一句講晒」版）
`src/app/api/pos/sync/route.ts` 嘅 `PRINT_JOB_CREATED` 分支，由 `upsert` 拆做兩步：
1. `update(contentPatch)` 只寫內容欄（order_no / items / template / content / printer_* 等），**filter `id`+`store_id`，唔碰 `status`**；
2. 若 `select("id")` 返空（`upd.length === 0`）→ 首次建立，`insert` 先寫 `status`（payload 值，通常 `pending`）+ `created_at`。

已存在嘅行（無論 `sent`/`failed`/`printing`）永遠唔會被重推重置 status → hub 重開唔會再 claim 到佢哋。

### 3.2 salon 端（同源）
`src/app/api/salon/sync/route.ts` 個 `upsertPrintJob()` 抽起嘅 `salon_print_jobs` upsert 有完全一樣嘅 bug，用同一招修（`.update().select("id")` → 空先 `.insert()`）。salon 同用 print-relay hub，唔修會同樣重印。

### 3.3 唔動嘅部分
- `pos_claim_print_jobs` RPC：唔使改，佢揀 `pending`/`failed` 係啱嘅。
- hub（`print-relay` APK）：唔使改，re-claim 行為正常。
- `result` route（`sent`/`failed` 回報）：唔使改。

## 4. 變更清單
| 檔 | 改動 |
|---|---|
| `src/app/api/pos/sync/route.ts` | `PRINT_JOB_CREATED` upsert → update-then-insert 冪等 |
| `src/app/api/salon/sync/route.ts` | `upsertPrintJob()` 同上 |

## 5. 部署 & 驗收
### 5.1 部署
呢個修復喺 **macau-pos web 服務端**，要 deploy 個 Next.js 先生效；print-relay APK 唔使重 build。

### 5.2 驗收 SQL（部署後做）
搵一張你確定印過又重印過嘅 order，確認佢嘅 job **唔會再出現 `sent → pending` 倒退**：
```sql
select id, status, created_at, claimed_by, attempts, updated_at
from pos_print_jobs
where order_id = '<嗰張單 order_id>'
order by created_at;
```
- 預期：同 `id` 張單 `status` 只會 `pending → printing → sent`，唔會返轉頭 `pending`。
- 重開 hub 後：唔會再爆印一批 `pending` 舊單。

### 5.3 邊沿
- 首次建立（insert）先寫 `status`，所以「真正新單」行為唔變。
- 失敗重試：server `result` route 已經把 `failed → pending`（attempts<5），web 唔使靠重推 `PRINT_JOB_CREATED` 嚟重試，所以唔影響。
- 跨 store 同 id 嘅極端碰撞（實際唔會發生）：新碼唔會再把 `store_id` 無條件改寫，比舊 upsert 更安全。
