# Error / Warning 全面複核 + 不必要呼叫削減（2026-09-21，營業中樣本）

> 委託：店已在營運，重新檢查整個專案出現嘅 **error / warning**，定位來源與成因，
> 提出優化（目標減少不必要 call），並保證**不影響任何現有功能**。
>
> 取樣證據：
> - Supabase log `supabase_logs (5).csv` → 視窗 **2026-09-21T09:33:19Z → 09:38:50Z**（= 澳門 17:33–17:38，331 秒，500 行）
> - Vercel function log `macau-pos-system-log-export-2026-09-21T09-38-53.csv` → 視窗 **09:21:45Z 之前**（去重後 141 個請求 / 29.6 分鐘）
> - 線上 bundle 掃描：`tools/verify-deployed-bundle.cjs`
>
> ⚠️ 兩個視窗**唔重疊**（Vercel 早、Supabase 遲），呢點係後面 §3 嘅關鍵。

---

## 0. 一句話結論

| 類別 | 數量 | 狀態 |
|---|---|---|
| Supabase **error** | 11 條，**只有一種**：`42703 column pos_orders.refund_records does not exist` | ✅ **本輪已修**（§1） |
| Supabase **warning** | 11 條，**只有一種**：`GET /rest/v1/pos_orders → 400`（同上一件事，一體兩面） | ✅ 同上 |
| Vercel **error / warning** | **0**（141/141 全部 200，level 只有 info） | ✅ 無事 |
| 其他 status | `204`×24（PATCH 成功無回傳）、`00000`×2（Postgres checkpoint，正常） | ✅ 無事 |

**即係：log 入面「唔應該發生」嘅 error/warning 只有一個根因，而且已經修好。**
真正燒錢嘅唔係 error，而係 §3 嗰個「**每 4.49 秒拉一次 424 KB 全量 state**」嘅客戶端循環。

---

## 1. 唯一嘅 error / warning：退款審計 3 欄幻影欄位

### 1.1 證據（逐條對得上）

```
[1] ×11   warning  400   GET /rest/v1/pos_orders
    ?select=id,status,fulfillment_status,items,updated_at,client_updated_at,
            refund_records,refunded_amount,voided_items
    &store_id=eq.8291f843-…&id=in.(order-092876a8,order-df1f0964)

[2] ×11   error    42703  column pos_orders.refund_records does not exist
```

- 兩者**成對出現、時間戳相差 ~30 毫秒**（例如 09:38:50.079 = error、09:38:50.109 = warning）
  ⇒ 同一次查詢嘅兩個 log 面。
- 節奏 **每 30.05 秒一次**（11 次 / 331 秒），同 `pos_orders [9c]`×11、`pos_orders [6c]`×11、
  `pos_queue_events` POST×12 完全同步 ⇒ **每個 `/api/pos/sync` 就打一次**。

### 1.2 成因

`src/app/api/pos/sync/route.ts` 喺預取現有訂單（為 LWW 守門）時，**每次都**先試 9 欄
（6 個基本欄 + `refund_records, refunded_amount, voided_items`）：

```ts
const baseColumns = "id,status,fulfillment_status,items,updated_at,client_updated_at";
const res = await supabase.from("pos_orders")
  .select(`${baseColumns},refund_records,refunded_amount,voided_items`)
  …
if (existingErr && isMissingColumnError(existingErr)) {   // 42703
  console.warn("[pos/sync] pos_orders 缺退款審計欄（migration 未跑）→ 降級查詢 …");
  … 再查一次 baseColumns（6 欄）…
}
```

但呢 3 欄 **喺 `supabase/migrations/` 全 43 個 migration 都冇定義、全 codebase 亦冇任何地方寫入**
⇒ 現實**永遠**行降級路徑。結果係：

- 每個 sync **白打一個註定失敗嘅查詢**（多一個 PostgREST round-trip）；
- 每次留低 **1 條 `error` 級 Postgres log + 1 條 `warning` 400**（污染告警、燒 DB log 額度）；
- 對商家而言就係「明明冇壞，但日日見到紅字」。

### 1.3 修法（已實作）

改成「**試一次、記住結果**」——per server instance 嘅 in-memory 快取：

```ts
let refundAuditColumnsAvailable: boolean | null = null;
…
const refundColumns =
  refundAuditColumnsAvailable === false ? "" : ",refund_records,refunded_amount,voided_items";
…
if (existingErr && isMissingColumnError(existingErr)) {
  refundAuditColumnsAvailable = false;           // 記住唔存在 → 之後唔再試
  … 降級 6 欄（一字不改）…
} else if (!existingErr && refundColumns) {
  refundAuditColumnsAvailable = true;            // 9 欄查得通 → 之後直接用 9 欄
}
```

### 1.4 為何 100% 不影響功能（逐點論證）

| 風險點 | 論證 |
|---|---|
| 回傳資料會唔會唔同？ | **逐欄一樣**。快取 false 之後查嘅就係原本降級路徑嗰句 `.select(baseColumns)`；成功路徑亦係原本嗰 9 欄。**冇新查詢、冇新欄位推導、冇改 merge 邏輯。** |
| 會唔會「鎖死」咗永遠唔用返 9 欄？ | **唔會**。快取只存在於單一 server instance 嘅記憶體，cold start／新 instance 一定重新探測一次 ⇒ 將來真係跑 migration 加返呢 3 欄，新 instance 會自動用返 9 欄，**唔使改 code**。 |
| 失敗行為有冇變？ | 冇。6 欄查詢失敗照樣有 `if (existingErr) console.error("[pos/sync] 預取現有訂單失敗（LWW 守門降級為無條件寫入）")`；`existingById` 空嗰陣嘅守門降級一字不改。 |
| 有冇因為「唔再每次試」而漏咗某啲單？ | 冇。兩條路徑嘅 `idArr`、`store_id` filter、`in("id", …)` 完全相同；只係欄位清單少 3 個（而嗰 3 個現實根本讀唔到、亦冇人寫）。 |
| 會唔會連 warning 都冇埋，將來冇人知 migration 未跑？ | 仍然有。第一次探測失敗照樣 `console.warn`（訊息保留原文），只係由「每 30 秒吵一次」變成「每個 instance 吵一次」。 |

### 1.5 守護測試

新增 `src/app/api/pos/sync/sync-route-refund-columns.test.ts`（5 條 source 掃描測試），
鎖死兩個相反方向嘅陷阱：

1. 有 per-instance 快取（`refundAuditColumnsAvailable`）；
2. 探測到唔存在之後，select **一定要**退回 6 欄；
3. 42703 分支要設 `false`；
4. 9 欄查得通要設 `true`（保留「將來加欄自動啟用」能力）；
5. **探測段落唔可以被剷走**（降級 warning + 6 欄 fallback 必須仍在）。

```
$ node --test src/app/api/pos/sync/sync-route-refund-columns.test.ts
# tests 5  # pass 5  # fail 0

$ node node_modules/typescript/bin/tsc --noEmit      # exit 0
$ node --test "src/**/*.test.ts"                     # tests 944  # pass 944  # fail 0
```

**預期效果**：Supabase `error` 由 11 條/5.5 分鐘 → **每個 server instance 至多 1 條**；
`warning 400` 同步消失。每個 `/api/pos/sync` 少一個 PostgREST round-trip。

---

## 2. Vercel 側：零 error、零 warning

```
status = {"200":141}          ← 141/141 全部 200
level  = {"info":141}         ← 冇 error / warning
```

應用層 message 只有兩種，都係**刻意嘅正常 log**：

| ×次 | 內容 | 判斷 |
|---|---|---|
| 6 | `[pos/device-config] 中繼機憑證通道（agent=ag-0fa2…, store=8291f843-…）` | 正常（中繼機讀設備設定） |
| 1 | `[egress] pos/state bytes=424181 mode=full orders=200 queue=0 skipQueue=1 printJobs=200 limit=200 ip=182.93.6.133` | 正常（egress 量測 log） |

`skipQueue=1` 出現 ＝ 新版 bundle 生效中 ✅（同時 `tools/verify-deployed-bundle.cjs`
亦搵到 `重連補拉已跳過` 標記，確認線上 bundle 已含本輪改動）。

### 呼叫分佈（141 個去重請求 / 29.6 分鐘）

| 次數 | /min | route | 備註 |
|---:|---:|---|---|
| 59 | 2.00 | `POST /api/pos/print-agent/heartbeat` | 打印中繼心跳 |
| 30 | 1.01 | `POST /api/pos/print-agent/claim` | 中繼領取任務 |
| 14 | 0.47 | `GET /api/pos/shift` | 已由 60s → 180s |
| 12 | 0.41 | `GET /api/online-order-settings` | herd 已合併（5→1） |
| 9 | 0.30 | `POST /api/topup/pending-count` | 平均 **1261 ms**（最貴） |
| 8 | 0.27 | `GET /api/pos/store-status` | herd 已合併（3→1） |
| 6 | 0.20 | `GET /api/pos/device-config` | avg **0 ms**（edge cache hit） |
| 1 | 0.03 | `GET /api/pos/state` | ⚠️ **見 §3** |
| 1 | 0.03 | `GET /api/pos/bootstrap` | |
| 1 | 0.03 | `GET /pos` | |

⇒ **打印中繼（heartbeat + claim）佔 63% 嘅 Vercel invocation**。
呢兩個端點本身已經係「1 個 PATCH / 1 個 RPC」，冇得再瘦；唯一出路係**降低頻率**（見 §4-B）。

---

## 3. 🔴 真正嘅錢坑：每 4.49 秒拉一次 424 KB 全量 state

### 3.1 證據鏈

**(a) 單次成本（實測，唔係估算）**

```
[egress] pos/state bytes=424181 mode=full orders=200 queue=0 skipQueue=1 printJobs=200 limit=200
```

⇒ 一次全量 `/api/pos/state` = **424,181 bytes ≈ 414 KiB**（即使已經 `skipQueue=1`，省咗 ~500 KB queue）。

**(b) 頻率（Supabase 視窗 331 秒）**

| 表 / RPC | 次數 | 間隔中位 | 節奏 |
|---|---:|---:|---|
| `POST rpc/pos_orders_page`（30 欄） | 62 | 4.49 s | 每秒 0.19 次 |
| `GET pos_queue_events`（`select=*`、`limit=0`） | 62 | 4.49 s | 同上 |
| `GET pos_print_jobs` | 62 | 4.49 s | 同上 |
| `GET pos_print_templates`（7 欄） | 62 | 4.48 s | 同上 |
| `GET pos_note_presets`（5 欄） | 62 | 4.48 s | 同上 |
| `GET pos_device_configs` | 63 | 4.46 s | 同上 |

六張表**時間戳完全同步**（偏移 4.3 / 7.6 / 12.3 / 15.5 / 23.5 … 秒，毫秒級對齊）
⇒ **唔係六個獨立請求，係一個請求內嘅六句查詢**。

而 `GET pos_device_configs + pos_queue_events + pos_print_jobs + pos_print_templates(7 欄) + pos_note_presets(5 欄) + orders RPC` 呢個組合，
**全 codebase 只有 `src/app/api/pos/state/route.ts` 一處**（逐句核對：`route.ts:185 / 191 / 194 / 200-203 / 210 / ordersInRangePromise`，欄數 1/1/1/7/5/30 **完全對得上**）。

**(c) 乘出來嘅數**

```
62 次 × 424,181 B = 26,299,222 B ≈ 25.1 MiB / 5.5 分鐘
                  ≈ 287 MiB / 小時
```

若持續 → **約 6.9 GB / 日**（Supabase 免費額度 5 GB）。

### 3.2 呢個唔係新 bug，係「舊 bug 嘅另一條入口」

同一形態 2026-09-21 早已被實測記錄（見 `src/lib/pos/resubscribe-guard.ts` 頂部）：

> Vercel log 實測：連續 9 分鐘、每 4.47 秒一次嘅全量 state 拉取，每次 857 KB…佔該窗口全部 egress 96%。

當時判定入口 = realtime channel 反覆「訂上 → 即斷」→ `onResubscribed()` → `loadRuntimeState()`，
並加了四道閘（`src/lib/pos/resubscribe-guard.ts`）：offline / pending / **分頁隱藏** / **距上次 < 30 秒**。

**但 §2 已證實線上 bundle 含咗呢個守衛**，而 Supabase 視窗（17:33–17:38，即新版上線之後）
仍然見到 11.25 次/分鐘 —— 守衛最多只可以容許 2 次/分鐘（30 秒下限），
**所以必然係另有入口，唔係 resubscribe 嗰條。**

### 3.3 剩下嘅入口：`queue` 依賴造成嘅自激迴圈

`src/components/pos-app.tsx:1130-1151`：

```tsx
useEffect(() => {
  if (offlineMode) return;
  if (queue.some((event) => event.status === "pending")) return;
  void loadRuntimeState();                 // ← 每次 424 KB
}, [offlineMode, runtimeRefreshTick, queue]);   // ← 🔴 queue 係 dependency
```

只要 `queue` 嘅 **array 身分（identity）** 變一次，呢個 effect 就重跑一次 → 又一次全量拉取。
而全 codebase 有 **4 處** 會換走 `queue` 嘅身分：

| 位置 | 有冇守衛 | 說明 |
|---|---|---|
| `pos-app.tsx:1298-1300` `setQueue(mergedQueue)` | ✅ 有 | 已比對 `id:status` 簽名，內容一樣就唔 set（`lastLoadedQueueRef`） |
| `pos-app.tsx:470` `setQueue(loadQueue())`（`POS_SYNC_FAILED_EVENT`） | ❌ **冇** | `loadQueue()` 每次都回**新 array**，就算內容一樣都換身分 |
| `pos-app.tsx:2269` `setQueue(nextQueue)`（落單入隊） | 業務必需 | 正常 |
| `pos-app.tsx:7610 / 7628` `onMutated={() => setQueue(loadQueue())}` | ❌ **冇** | 同上，新 array |

換句話講：**任何一次「重新讀 localStorage 塞返隊列」都會連鎖引發一次 424 KB 全量拉取**，
而該次拉取本身又會 `saveQueue(mergedQueue)`（寫 localStorage）。只要上游有一個
~4.5 秒級嘅事件源（`pos-print-jobs-changed` 由 `PrintFlushWorker` 每 2.5 秒 tick 派發、
`POS_SYNC_QUEUE_CHANGED_EVENT` 每 30 秒、`sync-acks` 每 15 秒 refresh），
就會形成**穩定嘅 4–5 秒循環** —— 同「間隔中位 4.49 秒、103 次之中冇任何兩次喺同一秒」嘅指紋完全一致。

> ⚠️ **誠實聲明**：§3.3 係由「(a) 已證實 424 KB × 62 次、(b) 已證實呼叫者只有 `pos-app.tsx`、
> (c) 已證實 resubscribe 路徑有 30 秒下限」三者推出嚟嘅**最可能機制**，未經即時實測坐實。
> 要一刀切死，只需要一對**同一視窗**嘅 log（見 §5 驗證步驟）。

---

## 4. 優化建議（按「省幾多 / 風險」排序）

### A. 修掉「換 array 身分」嘅無謂 setQueue —— **建議立即做，零語義改動**

**做法**：喺 `pos-app.tsx:470 / 7610 / 7628` 三處，把「重新讀 localStorage」包一層
**內容簽名比對**（同 1298 行一模一樣嘅做法，抽成一支 `replaceQueueFromStorage()`）：

```ts
const replaceQueueFromStorage = () => {
  const next = loadQueue();
  const sig = next.map((e) => `${e.id}:${e.status}`).sort().join("|");
  if (sig === queueSignatureRef.current) return;   // 內容一樣 → 唔換身分
  queueSignatureRef.current = sig;
  setQueue(next);
};
```

**為何不影響功能**：`queue` 係 **React state**，UI 只讀內容（`failedSyncCount`、pending 判斷、
提示卡）。內容一樣就唔換身分 ⇒ **畫面、計算、DOM 結果逐項相同**；只有「無謂 re-render /
無謂 effect 重跑」被省掉。`saveQueue()` 寫 localStorage 嘅行為**完全保留**（磁碟一致性不變）。

**風險**：極低。唯一要注意係「同 id 同 status 但 payload 內容唔同」嘅情況 ——
但呢種情況下 **1298 行既有守衛本身已經有一模一樣嘅盲點**，所以呢個改動**冇引入新盲點**，
只係把同一個既有假設延伸到另外三個呼叫點。
> 如要 100% 保守，可把簽名改成 `id:status:JSON.stringify(payload).length`（更嚴，成本仍係零 DB 呼叫）。

### B. 把 `queue` 由 effect dependency 改為衍生布林值 —— **建議做，但有一處語義差異，需你拍板**

```tsx
const hasPendingEvents = useMemo(
  () => queue.some((e) => e.status === "pending"), [queue]);
useEffect(() => { … }, [offlineMode, runtimeRefreshTick, hasPendingEvents]);
```

**為何安全**：effect 內文**唯一**用到 `queue` 嘅地方就係嗰句 pending 判斷（1133-1148 行），
`hasPendingEvents` 係同一個運算式嘅 memo 化結果 ⇒
「mount／重連／`runtimeRefreshTick`／pending 由有變冇」四個原本需要拉取嘅時機**全部保留**。

**唯一語義差異（請注意）**：舊寫法下「`queue` 身分變咗、但 pending 一直係 false」**都會拉一次**；
新寫法**唔會**。呢啲拉取本身係冗餘（server state 上一輪已經 merge 過），
但嚴格黎講係行為收緊 ⇒ **需要你確認可以接受**。
> 若你要求「一個行為都唔准變」，就**只做 A、唔做 B**。A 已足以打斷循環（因為循環靠嘅就係身分變換）。

### C. 為 `loadRuntimeState()` 加 single-flight（去重）—— **建議做，零行為改動**

已有可重用資產 `src/lib/pos/single-flight.ts`（10 條單測）。
同刻多次呼叫共用同一個 promise ⇒ 並發重複請求合併成一次。
**為何安全**：只合併「同刻」嘅請求；任何一次呼叫都仍然攞到「拉完之後」嘅最新 state
（promise 解完之後所有呼叫者一齊繼續），語義等價。
**風險**：極低。失敗時 `.finally` 只清自己嗰條，唔會誤清別人。

### D. 降低打印中繼心搏頻率 —— 需要 APK 配合（web 側已做完）

- web 側 `/api/pos/print-agent/heartbeat` 回應已加 `nextPollMs: 60_000`。
- **現行 APK 未有讀呢個欄位**，仍然自己行固定間隔 ⇒ Vercel log 見到 heartbeat 2 次/分鐘。
- 呢兩個端點佔 63% 嘅 Vercel invocation。要真正省，就要改 `macau-pos-print-relay`（Kotlin）讀 `nextPollMs` 並用它取代寫死值。
- **為何不影響功能**：心搏／領取只係「拉任務」；`nextPollMs` 只影響「幾時拉下一次」。
  斷線偵測（`last_seen_at` ~30s 窗口）需要同步放寬，否則會誤報離線 —— 呢點要一齊改，**唔可以只改一邊**。

### E. `POST /api/topup/pending-count`（avg 1261 ms、9 次/29.6 分鐘）—— 觀察即可

耗時係其他 route 嘅 5–7 倍，但次數少（0.30/min）。屬「貴但唔頻繁」，暫不建議動。

---

## 5. 每項優化「如何確保現有功能維持正常」

### 5.1 自動化（每次改動都跑）

```bash
# ① 型別
node node_modules/typescript/bin/tsc --noEmit                      # 必須 exit 0
# ② 全量單測（本專案 npm test 即 node --test，唔認 @/ 別名）
node --test "src/**/*.test.ts"                                     # 必須 0 fail
# ③ 本輪新增嘅守護
node --test src/app/api/pos/sync/sync-route-refund-columns.test.ts
# ④ API 契約（唔開瀏覽器，直接打 route）
node tools/verify-pos-api-contract.cjs
# ⑤ 線上 bundle 版本標記
node tools/verify-deployed-bundle.cjs
```

本輪已跑：①`exit 0`、②`tests 944 / pass 944 / fail 0`、③`5 / 5 pass`、⑤`判定：已包含 2026-09-21 改動 ✅`。

### 5.2 真瀏覽器流程（`POS_REQUIRE_DEVICE_AUTH=0`）

```bash
POS_REQUIRE_DEVICE_AUTH=0 node node_modules/next/dist/bin/next dev -p 3017
node tools/verify-pos-flows-live.cjs        # 打印 / 點餐 / 設置 / 報表，含 console error 掃描
node tools/verify-pos-request-count.cjs     # 開頁後請求數，用來坐實 §3 嘅循環有冇斷
```

⚠️ 注意（已踩過兩次）：
- 一定要用 `localhost`，**唔可以用 `127.0.0.1`**（next dev 會 reject）；
- 掃 console 要**先過 `KNOWN_PREEXISTING` 既有 React 警告**，否則會誤報成回歸；
- 殺 dev server 之後要刪 `.next/dev/types/validator.ts`，否則會出現假 tsc error。

### 5.3 唯一 root cause（refund 欄）嘅針對性驗證

改完部署之後，重睇 Supabase log：

```sql
-- 應該由「每 30 秒 1 條」變成「每個 instance 至多 1 條」
select date_trunc('minute', timestamp) m, count(*)
from postgres_logs
where event_message like '%refund_records does not exist%'
  and timestamp > now() - interval '1 hour'
group by 1 order by 1;
```

驗收標準：**`42703` 條數 = 0 或 ≈ server instance 冷啟次數**，
而 `/rest/v1/pos_orders?select=…9cols` 嘅 `400` **完全歸零**。

### 5.4 坐實 §3.3 嘅一對 log（**呢個係我最需要你幫手嘅一步**）

問題核心係：Vercel 導出視窗（≤09:21Z）同 Supabase 視窗（09:33–09:38Z）**唔重疊**，
所以我睇到「Vercel 只有 1 次 `/api/pos/state`」同時「Supabase 有 62 組 state 查詢」，
兩者唔可以互相對質。請幫我導出：

1. Vercel function log：**同一段**澳門時間 17:30–17:40（UTC 09:30–09:40）；
2. Supabase log：同一段。

然後我會用 `tools/_reqdist-20260921.cjs` + `tools/_sb-timeline-20260921.cjs` 直接對質：

- 若 Vercel 見到 `/api/pos/state` **62 次**另有 `[egress] pos/state` 62 行 → §3.3 機制成立，照 A（＋可選 B/C）改；
- 若 Vercel 只見到 1–2 次，但 Supabase 見到 62 組 → 代表有**另一支不經 Vercel 嘅呼叫者**
  （例如舊 bundle 嘅殘留 tab、或另一部裝置），方向完全唔同，要另查。

同時，因為我已喺 `/api/pos/state` 加咗 `jsonWithEgressLog`（每行都帶 `bytes=` 同 `ip=`），
**新 log 會直接指出係邊個 IP／邊部機在拉**，唔使再靠推論。

---

## 6. 待你拍板

| # | 項目 | 我的建議 | 需要你決定嘅事 |
|---|---|---|---|
| 1 | refund 3 欄探測一次 | ✅ **已做**（tsc + 944 測試全綠） | 冇，可直接 commit |
| 2 | A：`setQueue` 內容簽名（3 處） | ✅ 建議做 | 冇（零語義改動） |
| 3 | B：`queue` dep → `hasPendingEvents` | ⚠️ 建議做 | 「pending=false 但 queue 身分變」時**唔再拉取**，可否接受 |
| 4 | C：`loadRuntimeState` single-flight | ✅ 建議做 | 冇 |
| 5 | D：APK 讀 `nextPollMs` | 建議排期 | 要一齊改斷線偵測窗口，否則會誤報離線 |
| 6 | E：`topup/pending-count` | 暫不動 | 冇 |

---

*工具（本輪新增，全部唯讀）：*
`tools/_errwarn-recheck-20260921.cjs`（error/warning 歸類）、
`tools/_reqdist-20260921.cjs`（Vercel / Supabase 請求分佈）、
`tools/_sb-timeline-20260921.cjs`（逐表節奏指紋）、
`tools/_vc-messages-20260921.cjs`（應用層 message 清單）。

---

# 附錄 A：20:19 覆核（部署後實測）— 🔴 循環未停

> 樣本：`supabase_logs (6).csv` = **11:59:32Z → 12:19:13Z**（澳門 19:59:32–20:19:13，1174 秒、1000 行）
> 對照：`macau-pos-system-log-export-2026-09-21T12-19-30.csv`

## A.0 ⚠️ 先講一件要即刻處理嘅事：Vercel 匯出檔係舊嘅

```
3b127f881ac041cf  84346  macau-pos-system-log-export-2026-09-21T09-38-53.csv
3b127f881ac041cf  84346  macau-pos-system-log-export-2026-09-21T12-19-30.csv
content identical = true
```

**兩份檔 SHA-256 完全相同**（連時間戳都係 09:20:57 / 09:21:22）。
即係 12:19 嗰次匯出**冇刷新到**，仍然係舊窗口（08:52–09:21Z）。
⇒ **Vercel 側今次冇任何新資訊**；要做 Vercel 對質，請重新匯出
**UTC 11:55 → 12:25（澳門 19:55 → 20:25）** 嘅 function log。

## A.1 ✅ 已確認生效嘅改動

| 項目 | 改前 | 今次實測（19.7 分鐘） | 判定 |
|---|---|---|---|
| 退款幻影欄位 `42703` ＋ `400` | 每 30 秒 1 條（2/min） | **3 條**（＝每個 server instance 各 1 次探測） | ✅ 修復生效 |
| `GET pos_print_agents`（驗證用嘅 SELECT） | 70 次 / 24 min ≈ 2.9/min | **5 次 / 19.7 min ≈ 0.25/min** | ✅ `recordActivity` 生效 |
| `PATCH pos_print_agents`（蓋章） | 44 次 / 24 min | **60 次 / 19.7 min ＝ 2.0/min** | ✅ 心跳 30s ＋ claim 60s（1 部中繼機） |
| `rpc/pos_claim_print_jobs` | 每 65 秒 | **每 60.26 秒**（極穩定） | ✅ 符合 `TICK_MS = 60_000` |
| 三條時間腿（`select` 三腿查詢） | 有 | **完全冇再出現** | ✅ 0046 生效 |

驗 `GET pos_orders?select=6cols` **39 次**（＝每個 sync 都行到預取 ⇒ `orderIds.size > 0`），
而 `select=9cols`（退款 3 欄）**只有 3 次** ⇒ 若冇修復，呢 3 欄會被試 **39 次**。
**3 次＝冷啟次數**，即「試一次、記住結果」完全按設計運作。

## A.2 🔴 全量拉取循環**仍然存在**（而且比「平均數」睇落更嚴重）

```
全量 state 次數=101   span=1174s   全窗口平均 = 5.16 次/分鐘

--- 爆發段（gap > 20s 就切）---
  🔴 循環  起 +0s     長 20s    次數 5   ≈12.0/min  間隔中位 4.78s
  🔴 循環  起 +739s   長 435s   次數 96  ≈13.1/min  間隔中位 4.45s
活躍總時長 ≈ 455s（佔窗口 39%）
```

六張表（`pos_device_configs` 104 ／ `rpc/pos_orders_page` 101 ／ `pos_print_jobs` 100 ／
`pos_print_templates` 100 ／ `pos_note_presets` 99 ／ `pos_queue_events` 99）
**時間戳仍然毫秒級對齊** ⇒ 仍然係同一個請求內六句查詢。

### 兩點必須講清楚

1. **「平均由 11.24/min 跌到 5.16/min」係假象**。跌嘅原因係**循環只佔窗口 39% 時間**，
   唔係修好了。**活躍段頻率反而由 11.2 升到 13.1 次/分鐘**。
   以後睇呢類數，一定要用 §A.2 嘅**分段（burst）**口徑，唔可以睇全窗口平均。
2. **`d16c644`（19:30 已 commit ＋ push，含 `queueSignatureRef` / `replaceQueueFromStorage`
   / single-flight）已經部署，而爆發由 20:11:54 開始、一路持續到 log 尾（20:19:13）**
   ⇒ **今輪嘅「array 身分」守衛未足以令循環停**。

### 爆發起點嘅現場（`tools/_sb-window-20260921.cjs`）

```
+742.2s  20:11:54  GET  pos_shifts?closed_at=is.null
+748.3s  20:12:00  101  GET  /realtime/v1/websocket          ← Realtime 重新連上
+752.9s  20:12:05  GET  pos_online_order_settings
+753.0s  20:12:05  GET  pos_store_status
+758.9s  20:12:11  POST rpc/pos_claim_print_jobs
```

「12 分鐘完全冇全量拉取（19:59–20:11）→ 20:11:54 突然開始連續 435 秒」＋
同一刻有 **WebSocket 重連 ＋ 兩支設定讀取**，形態上最似
**分頁由背景返前景（`visibilitychange` → `subscribe()` → `SUBSCRIBED`）**。

## A.3 成本（以今次窗口實測）

| 假設 | 全窗口（19.6 min） | 每小時 | 開 10 小時 |
|---|---:|---:|---:|
| `skipQueue=1`（424,181 B/次） | 40.9 MB | 125 MB | **1.22 GB** |
| 無 `skipQueue`（857 KB/次） | 82.5 MB | 253 MB | **2.47 GB** |

⇒ 單單呢一個循環，仍然可以食掉 5 GB 免費額度嘅 1/4 至 1/2。

## A.4 本輪新增：`x-pos-state-src` 呼叫來源標記（**待部署**）

循環已經證明「唔可以靠推論定位」——`/api/pos/state` 四個入口
（mount／`queue` 依賴／realtime 重連補拉／手動更新）喺 log 上**一模一樣**。
所以加咗一個純診斷標記：

- Client（`pos-app.tsx`）：`loadRuntimeState(src)` → fetch 時帶
  `x-pos-state-src: mount | queue-dep | resubscribe | manual`。
- Server（`state/route.ts`）：讀入、`.slice(0, 24)` 截斷，寫落 egress log：
  ```
  [egress] pos/state bytes=424181 mode=full src=queue-dep orders=200 queue=0 skipQueue=1 …
  ```
- **零行為影響嘅證明**：有／冇標頭／超長標頭，三次回應**都係 39 bytes、
  `keys=ok,source,orders` 完全一致**（實測）。標頭唔參與查詢、授權或回應內容。
- 守衛：`src/app/api/pos/state/state-egress-src.test.ts`（4 條）。

⚠️ 本機 `next dev` 嘅 stdout 睇唔到 app 層 `console.info`（Next 16 + Turbopack），
所以 `src=` 只可以喺**生產 Vercel log** 驗。

## A.5 下一步（按優先次序）

1. **部署 §A.4 嘅標記** → 再開一次收銀台，令循環重現。
2. 匯出**同一段時間**（±10 分鐘）嘅 Vercel function log。
3. 睇 `[egress] pos/state … src=<邊個>`：
   - 若為 `queue-dep` ⇒ 循環由 effect 重跑驅動，要連 `queue` 依賴一齊改（報告 §4-B）。
   - 若為 `resubscribe` ⇒ 30 秒下限守衛有漏洞（例如 `lastFullStatePullAtRef` 被其他路徑重置）。
   - 若為 `mount` ⇒ 有元件**反覆重新 mount**（要查 `key` / 條件渲染 / HMR 之外嘅原因）。
   - 若 `ip=` 出現**多過一個** ⇒ 係多部裝置／多個分頁各自循環（`GET /realtime/v1/websocket` 有 3 條）。
4. 同時用 `pos-app-queue-identity.test.ts` 守住，確保守衛唔會被「順手清理」。

---

# 附錄 B：22:30 覆核 — 🎯 兇手鎖定（一部 Mac 嘅**舊分頁**）

> 樣本：`macau-pos-system-log-export-2026-09-21T14-29-12.csv`（**787,061 B，新 hash** ✅ 真係刷新咗）
> ＋ `supabase_logs (7).csv`（13:21:44Z–14:29:35Z ＝ 澳門 21:21–22:29，67.8 分鐘）

## B.0 ⚠️ 先修正附錄 A 嘅推論

附錄 A §A.2 我推「20:11:54 有一次全新 mount（有 WebSocket ＋ 兩支設定讀取）⇒
所以守衛部署咗都擋唔到 ⇒ 守衛不足」。**呢個推論係錯嘅。**
真相係「**背景分頁返前景**」（`visibilitychange` 一樣會重建 WebSocket 同刷新設定），
而嗰個分頁跑嘅係**舊 bundle**。守衛從來冇失效 —— 見下面。

## B.1 🎯 鐵證：`[egress]` 加總 ＋ IP／User-Agent 反查

```
[egress] 行數=167
總 egress = 126.53 MB / 29.6 min = 256.8 MB/小時 = 開 10 小時 ≈ 2.51 GB

--- 按 (tag / mode / ip / src) 分組 ---
  149 次  123.05 MB (97.2%)  平均 865,924 B
      pos/state full ip=60.246.53.111
      樣本: {"mode":"full","orders":"200","queue":"300","skipQueue":"0","printJobs":"200","limit":"200"}

   17 次    3.40 MB ( 2.7%)  平均 209,832 B   pos/state ordersOnly
    1 次    0.09 MB ( 0.1%)  平均  90,080 B   pos/state full ip=60.246.45.220
```

再用 User-Agent 反查（`tools/_egress-who-20260921.cjs`）：

```
×147  122.23 MB  12:54:36 → 13:20:46
     60.246.53.111  skipQueue=0  queue=300
     Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Version/17.14 Safari/605.1.15

×17    3.40 MB  12:52:38 → 13:17:23   （Mac Safari，ordersOnly）
×2     0.81 MB  13:12:38 / 13:17:57
     60.246.53.111  skipQueue=1  queue=0    ← 🔴 同一個 IP！
×1     0.09 MB  13:20:59
     60.246.45.220  skipQueue=1  queue=0    Android 16 WebView（自助機 / 店員機）
```

### 結論（三句）

1. **一部 Mac（Macintosh / Safari 17.14，IP `60.246.53.111`）嘅一個分頁跑住舊 bundle**：
   `skipQueue=0` ⇒ 冇跳過 300 條 queue，每次 **846 KB**（正常新版係 424 KB，**貴一倍**）。
   26 分鐘內拉 **147 次、122.23 MB ＝ 全窗口 egress 96.6%**。
2. **同一部 Mac 另一個分頁係新版**（`skipQueue=1`，2 次、0.81 MB）。
   ⇒ 唔係「呢部機舊」，係「呢個**分頁**舊（開咗冇 reload）」。
3. **Android 自助機／店員機（`60.246.45.220`）完全正常**：29.6 分鐘只拉 **1 次、90 KB**。

### 為何可以斷定「真係舊 bundle」而唔係「flag 被設成 0」

`skipQueue` 只在 `isOutboxV2Enabled()` 為 true 時才傳，而該 flag 係
`localStorage["macau-pos/sync-outbox-v2"] !== "0"`（預設 true，**同源分頁共用**）。
同一部機嘅新分頁傳 `skipQueue=1` ⇒ 該機嘅 flag **唔係 `"0"`**
⇒ 舊分頁只可能係**跑住 17:18 之前嘅 JS**（嗰時根本冇 `skipQueue` 呢個參數）。

### 仍未停

`supabase_logs (7).csv`：**13:26:53Z–13:37:11Z 連續 498 秒、12.8 次/分鐘、間隔中位 4.60 秒**，
一路到 22:29 都仲喺度。以 846 KB × 12.8/min 計 ⇒ **≈650 MB/小時 ⇒ 開 10 小時 ≈ 6.5 GB**
（單一裝置就可以食爆 5 GB 免費額度）。

## B.2 本輪新增：令呢種事自己報警（**待部署**）

兩個都係**零行為改動**（只加 log／只讀標頭）：

| 項目 | 內容 |
|---|---|
| `x-pos-state-src` | client 每次報上呼叫來源（`mount` / `queue-dep` / `resubscribe` / `manual`）→ 寫落 `[egress]` |
| 🔴 **舊版 bundle 偵測** | `isLegacyFullState = !ordersOnly && !skipQueue` ⇒ `console.warn("[pos/state] 🔴 偵測到疑似舊版 bundle …")`，**每 IP 每分鐘最多 1 條**（`rateLimit(key,1,60_000)`），並喺 egress log 加 `legacy=1` |

**判準為何要咁窄**：`ordersOnly=1`（報表／交班／對賬守護／本機訂單面板）**本身唔傳**
`skipQueue` ⇒ 一定要排除，否則每次開報表都出假警報。
「非 ordersOnly ＋ 冇 skipQueue」嘅唯一呼叫者就係 `pos-app` 嘅全量拉取。

**實測驗證（本機 dev，四種參數組合）**：

```
A 全量（冇 skipQueue）＝舊版   → 200  bytes=16271  keys=ok,source,orders,queue,printJobs,…
B 全量 + skipQueue=1（新版）   → 200  bytes=16271  keys=（完全一樣）
C ordersOnly（冇 skipQueue）   → 200  bytes=39     keys=ok,source,orders
D ordersOnly + skipQueue=1     → 200  bytes=39     keys=（完全一樣）

[warn] 只出 1 條： [pos/state] 🔴 偵測到疑似舊版 bundle 嘅全量拉取（冇 skipQueue）ip=::1 …
```

⇒ 回應**逐位元不變**、警報**只在應該出嗰時出、而且有節流**。
（順帶發現：本機 `next dev` 見到 `console.warn`，但 app 層 `console.info` 唔會出 stdout
⇒ `[egress]` 只可以喺生產 Vercel log 睇。）

## B.3 建議行動

### 🔴 即刻（唔需要改任何 code）

1. 去嗰部 **Mac（Safari 17.14）**：**全部 POS 分頁都閂掉**，再開新分頁入 POS。
   最好係 `Cmd + Shift + R` 硬重新載入（或直接閂 Safari 重開）。
2. 之後睇 Vercel log：
   `[egress] pos/state … skipQueue=1` 應該 100% 出現，
   而 `… 偵測到疑似舊版 bundle …` 應該歸零。
3. 預期 egress：**256 MB/小時 → ~1 MB/小時**。

### 🟠 短期（建議排期）

- **加「有新版本」提示**：`/api/pos/state` 回應標頭帶一個 build id，
  client 發現同自己載入時唔同 → 出提示條叫收銀「重新載入」。
  ⚠️ **強烈建議唔好自動 reload** —— 收銀落單／結帳中途 reload 會出事。
  要自動，最多只可以喺「無 pending 事件 ＋ 分頁可見 ＋ 冇開啟中嘅結帳畫面」時做，並且要提示。

### 🟡 中期

- 檢視 `public/sw.js` 對 `/_next/static/**` 嘅 **cache-first** 策略。
  Next 嘅 immutable chunk 係內容雜湊命名 ⇒ cache-first 本身安全；
  但 `CACHE_NAME = "macau-pos-v20-7-31"` 係**寫死版本字串**，
  建議改成由建置注入，避免日後有人以為 bump 咗其實冇 bump。
