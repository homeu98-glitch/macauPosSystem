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

---

# 附錄 C：Supabase Dashboard 對帳（2026-09-22 00:15 截圖）

> 樣本：Supabase Dashboard → Usage → Egress。

```
Included in Free Plan   5 GB
Used in period          6.89 GB      ← 已超額
Average in period       1.89 GB
Egress per day：
  PostgREST Egress  904.333 MB (98.6%)   ← 21 Sep
  Realtime Egress    12.789 MB ( 1.4%)   ← 21 Sep
```

## C.1 兩個數字都對得上我哋嘅實測

**① PostgREST 904 MB ＝ 嗰個舊分頁循環**

```
904 MB ÷ 846 KB（單次全量，skipQueue=0）≈ 1 070 次全量拉取
1 070 次 ÷ 12.8 次/分鐘（實測活躍段頻率）≈ 84 分鐘全速循環
```
⇒ 完全落喺「650 MB/小時」嘅實測速率之內（分幾個 burst 跑，唔需要連續 24 小時）。

**② Realtime 12.8 MB（1.4%）＝ 正常，唔需要動**

同 2026-09-21 早前實測嘅 **0.7~1.2%** 一致 ⇒ 再次確認
「**唔可以為省流量關 Realtime**」（關咗即時性全失，而只省 1.4%）。

## C.2 對照歷史（同一張圖）

| 日期 | Egress | 解讀 |
|---|---:|---|
| 13–14 Sep | ≈ 0~40 MB | 未開始大量用 |
| 15 Sep | ≈ 200 MB | 開始有營運流量 |
| 17–19 Sep | ≈ 150 MB/日 | **優化前嘅「正常日」基線** |
| **21 Sep** | **904 MB** | 🔴 **＋750 MB ＝ 舊分頁循環**（基線 × 6）|

⇒ 我哋嘅優化處理嘅係「150 MB 基線」；而 **21 Sep 爆到 904 MB 嘅原因係一個新出現嘅循環**，
兩件事唔可以混為一談。

## C.3 部署時間軸（解讀 904 MB 嘅關鍵）

| 時間（澳門）| Commit | 內容 |
|---|---|---|
| 17:18 | `c5db7a0` | `?skipQueue=1`、`pos_orders_page` RPC、`[egress]` log |
| 19:30 | `d16c644` | `queue` 身分守衛、退款欄探測、single-flight |
| **23:54** | **`f25af2f`** | **輪詢閘、寫入閘、G2／G3、`x-pos-state-src`、舊版 bundle 偵測** |

⇒ **21 Sep 嗰 904 MB 之中，絕大部分係喺 17:18 之前嘅舊 bundle 造成**
（舊分頁連 `skipQueue` 都唔識傳，每次 846 KB 而唔係 424 KB）。

## C.4 驗證 `f25af2f` 生效（要一份新 Vercel log）

由 23:56 之後嘅 Vercel function log 應該見到兩樣**以前冇**嘅嘢：

1. `[egress] pos/state bytes=… mode=full **src=queue-dep** …` ← 呼叫來源（`mount`／`queue-dep`／`resubscribe`／`manual`）
2. 如果仲有舊分頁：`[pos/state] 🔴 偵測到疑似舊版 bundle 嘅全量拉取（冇 skipQueue）ip=…`
   ＋ egress log 出現 **`legacy=1`**

⇒ 有 `legacy=1` ＝ 嗰部機／嗰個分頁**未 reload**；冇 ＋ `src=` 全部係 `mount`／`manual`
＝ 已收口。**收口後預期：≈ 17 MB/日**（按 0.45 MB / 38.8 分鐘實測推算）。

---

# 附錄 D：設置頁「版本號」顯示（2026-09-22）

## D.1 一句話

設置頁頂部會顯示 **`版本 1a2b3c4（2026-09-21 23:54 · 正式）`**，
右邊細字顯示 **`線上最新：9f8e7d6`**，兩者唔一致時出黃色警示
「此裝置仍運行舊版本，請完全閂掉此視窗再重新打開」。

## D.2 🔴 版本號顯示 **vs** `CACHE_NAME` 建置注入 —— **唔係同一個概念**

兩者處理嘅都係「版本／新鮮度」，但係**唔同層、唔同目的**：

| | **版本號顯示**（今次已做） | **`CACHE_NAME` 建置注入**（附錄 B §B.3 中期項，**未做**）|
|---|---|---|
| **解決嘅問題** | **「我唔知商家實際跑緊邊個版本」** —— **觀測／診斷** | **「就算 reload 都可能拎到舊 code」** —— **快取正確性** |
| **層級** | **應用層**：React 元件 ＋ build metadata | **Service Worker 層**：`caches` 嘅分區鍵 |
| **機制** | 建置時把 commit sha **內聯入 JS bundle**（`next.config` `env`），設置頁顯示 | `CACHE_NAME` 由寫死字串改成**每次建置自動變** ⇒ SW `activate` 時**刪走舊 cache** |
| **影響行為？** | **完全冇** —— 純顯示 | **有** —— 第一次載入會重新下載所有資源（一次性） |
| **目前有冇必要** | **有**：冇佢就只可以睇 log（商家唔會開 devtools）| **未有**：Next 嘅 chunk 係**內容雜湊命名** ⇒ cache-first 本身安全 |
| **風險** | 極低（顯示錯都只係顯示錯） | **中** —— 寫錯會令 PWA 離線失效 |

**一句記法**：版本號 ＝ 「**門口門牌**」（睇得到係邊次建置）；
`CACHE_NAME` ＝ 「**清走舊倉存**」（管得住快取會唔會 serve 舊貨）。
**今次做完門牌，但倉存清理仍然未做**（而目前未做都安全，見 §B.3）。

## D.3 位置、格式、對應關係

### 位置

- **設置頁（`/settings`）→ 頁面頂部**，**`status` 訊息條下面**，**跨 tab 常駐**
  （唔需要切去「打印機」或其他 tab 就見到）。
- 揀呢個位嘅理由：J 嘅目的係「**一睇就知**商家用邊個版本」⇒ 唔可以藏喺某個 tab 入面。

### 格式

```
版本  1a2b3c4（2026-09-21 23:54 · 正式）      線上最新：1a2b3c4
```

| 欄位 | 例子 | 來源 |
|---|---|---|
| 版本號（**主角**）| `1a2b3c4` | `VERCEL_GIT_COMMIT_SHA` 前 7 位，**建置時內聯入 JS** |
| 括號內時間 | `2026-09-21 23:54` | 建置開始時間，**澳門 +8** |
| 括號內環境 | `正式` | `VERCEL_ENV`（`production`→正式／`preview`→預覽／`development`→本機）|
| 線上最新 | `1a2b3c4` | `/api/pos/state` 回應標頭 `x-pos-build`（**零額外請求**）|
| ⚠ 黃色警示 | 兩者唔同時出現 | 由上面兩者算出 |

### 對應到「實際部署」嘅方法

| 顯示值 | 去邊度核對 |
|---|---|
| `1a2b3c4`（7 位 sha）| `git log --oneline` ／ GitHub commit 列表 ／ **Vercel → Deployments → 該 deployment 嘅 Source** |
| 12 位（冇 sha 時 fallback）| Vercel → Deployments 搜 `VERCEL_DEPLOYMENT_ID` |
| `dev` | **本機開發**（或者未注入）—— 唔代表任何部署 |
| `未知（未注入）` | 🔴 **代表內聯機制冇生效**，要即刻查 `next.config.ts` |

### 為何「本機版本」一定要**內聯**（唔可以由 server 攞）

如果個數字由 server 提供（例如新開一支 `/api/version`），
一個**跑住舊 JS 嘅分頁**一樣會顯示「最新版本」⇒
**完全失去**「確認商家實際用邊個版本」嘅作用。
內聯入 bundle ⇒ 呢串字**跟住嗰份 JS 一齊**：跑舊 JS 就顯示舊版本 ✓

### 為何只有提示、**冇**自動 reload

收銀落單／結帳中途 reload 會出事（本專案明確禁用）⇒ 只可以叫用戶
**完全閂掉視窗再開**（注意：唔可以只切去背景，見 §B.3／`sw.js` 相關說明）。

### 零成本保證

- 冇新 endpoint、冇新請求：`x-pos-build` 係搭 POS 本身每次都會打嘅 `/api/pos/state` 回應標頭。
- 標頭係純**附加**：唔改 body、唔改 status，舊 client 完全唔理。

## D.4 實作落點

| 檔案 | 內容 |
|---|---|
| `next.config.ts` | `env: { NEXT_PUBLIC_BUILD_ID / _TIME / _ENV }`，由 Vercel **自動**系統變數算出 ⇒ **J 唔需要設任何 env** |
| `src/lib/build-info.ts` | 零 import 純模組：`buildLabel()` / `formatMacauStamp()`（澳門 +8）/ `describeBuildMismatch()` / 觀測伺服器版本嘅 module store |
| `src/components/build-version-row.tsx` | 顯示元件（自成一體，唔攞大檔 `device-settings.tsx` 嘅空間）|
| `src/components/device-settings.tsx` | 喺 `status` 條下面 render `<BuildVersionRow />` |
| `src/app/api/pos/state/route.ts` | 回應加 `x-pos-build` 標頭 |
| `src/components/pos-app.tsx` | 由 state 回應讀 `x-pos-build` → 寫入 module store（**唔加任何請求**）|
| `src/lib/build-info.test.ts` | 18 條單測（含「本機 dev 唔可以亂提示」「任一未知唔可以當一致」）|

### 刻意嘅保守決定

1. **任一未知 → 唔提示**（本機 `dev`／標頭讀唔到）—— 唔可以喺開發環境嘈。
2. **`env` 嘅值一律會入 JS bundle**（Next 官方限制）⇒ 呢度只放**公開** build metadata，
   **絕對唔可以**擺任何機密入 `next.config` 嘅 `env`。
3. **唔可以 destructure `process.env`** —— Next 用 DefinePlugin 做**字面替換**，
   `const { X } = process.env` 會變 `undefined`。讀嘅時候一定逐個字面寫
   `process.env.NEXT_PUBLIC_BUILD_ID`。

---

# 附錄 E：2026-09-22 早上複核（商家已重啟網頁 ＋ Sunmi 已優化）

> 樣本：`supabase_logs (9).csv`（`01:25:49Z → 02:25:34Z` ＝ 澳門 **09:25 → 10:25**，59.75 分鐘，403 行）
> ＋ `macau-pos-system-log-export-2026-09-22T02-25-27.csv`
> 🔴 兩份窗口**唔重疊**（Vercel 實際內容 ＝ `00:24:04Z → 00:53:35Z` ＝ 澳門 **08:24 → 08:53**，
> 檔案名 `02-25-27` 但內容落後 ~2 小時，同 §A.0 一樣嘅陷阱）。

## E.1 ✅ 兩項確認成功

### ① Sunmi 中繼 APK 優化**已生效**（P1 ＋ P2 都做咗）

`PATCH pos_print_agents`（＝驗證＋蓋章）**22 次、間隔中位 180.5 秒**，而且係極穩定嘅
180.3 / 180.8 / 181.1 / 181.5 / 181.6 秒：

```
# 11  + 1883s  09:57:11  Δ241.1s
# 12  + 2064s  10:00:12  Δ180.8s
# 13  + 2245s  10:03:14  Δ181.6s
# 14  + 2426s  10:06:15  Δ180.7s
…（一路到 #22  10:24:18  Δ180.3s）
```

配合 `rpc/pos_claim_print_jobs` **21 次、間隔中位 180.9 秒** ⇒

- **claim 由 60 秒 → 180 秒** ＝ 讀到伺服器回傳嘅 `nextPollMs` ✓（P2 生效）
- **每 180 秒只有一個來源**（如果獨立心跳 30 秒仍在，就會夾雜每 30 秒嘅 PATCH）
  ⇒ **獨立心跳已刪** ✓（P1 生效）

⇒ **3.0 次/分鐘 → 0.33 次/分鐘（−89%）已達到。**

### ② POS 網頁側絕大部分時間**零拉取**

Vercel 窗口（08:24–08:53）**94 個請求全部係中繼 APK**：

| 次數 | /分鐘 | route | 來源 |
|---:|---:|---|---|
| 57 | 1.93 | `print-agent/heartbeat` | APK（**該窗口係 APK 更新前**）|
| 29 | 0.98 | `print-agent/claim` | APK（同上，仍係 60 秒）|
| 7 | 0.24 | `pos/device-config` | APK |
| 1 | 0.03 | `print-agent/pair` | APK |

👉 **`/api/pos/state` ／ `/api/pos/sync` ／ `pos/shift` ／ `store-status` ／ `topup` 全部 0 次**
⇒ 瀏覽器側完全乾淨（亦因此冇任何 `[egress]` 行，屬預期）。

**APK 更新時間點**：Vercel 窗口（08:24–08:53）仍然見到 30 秒心跳；
Supabase 窗口（09:25–10:25）已經變 180 秒 ⇒ **更新大約發生喺 09:00–09:30 之間**。

## E.2 🔴 仍未處理：**一次 2.7 分鐘嘅全量拉取循環**（10:15–10:20）

`tools/_fullstate-bursts-20260921.cjs`（以 `rpc/pos_orders_page` 為代表）：

```
全量 state 次數=40  窗口=02:15:00.217Z → 02:20:49.895Z  span=350s
🔴 循環 起 +51s  長 162s  次數 38  ≈13.7/min  間隔中位 4.28s
```

- 六張表（`pos_orders_page` / `pos_device_configs` / `pos_print_templates` /
  `pos_note_presets` / `pos_print_jobs` / `pos_queue_events`）**時間戳對齊**
  ⇒ 仍然係 `loadRuntimeState()`（**唔係** `ordersOnly`，報表／交班唔會拉 templates）。
- **間隔中位 4.28 秒** ＝ **舊版 bundle 嘅指紋**（新版會被輪詢閘擋住：
  `queue-dep` 路徑雖然係 `triggered` 唔受 idle 限制，但 `queue` 身分守衛已令佢唔可能自激）。
- **除咗呢 2.7 分鐘，其餘 57 分鐘係 0 次** ⇒ 唔係 24 小時持續，係「開頁就爆幾分鐘」。
- 成本：38 × 424 KB（新版）≈ **16 MB**；若係舊 bundle（846 KB）≈ **33 MB**。
  ⚠️ 若每小時都發生一次 ⇒ 一日 **0.4–0.8 GB**，所以仍然要處理。

**成因（最可能）**：某部裝置／某個分頁**仍然跑緊舊 bundle**（`skipQueue` 都唔識傳）。
👉 **決定性證據要靠 Vercel log 嘅 `src=` / `legacy=1`**（見 E.4）。

## E.3 其他殘留（逐項分類）

| # | 現象 | 次數 | 來源 | 判斷 |
|---|---|---:|---|---|
| 1 | `error 23505 duplicate key … "pos_print_jobs_once_key_uniq"`<br>＋ `warning 409 POST /rest/v1/pos_print_jobs`（同一件事，相差 44ms）| 各 1 | **我方系統** | **預期行為** —— 內容唯一鍵成功攔截重複出紙（`sync/route.ts:1600-1606` **刻意** `ack(true)` 唔重試）。**功能正確**，但**log 級別過高**（污染告警）⇒ 可優化：改用 `upsert(..., { onConflict: "once_key", ignoreDuplicates: true })` ⇒ 唔會再產生 23505／409 |
| 2 | `DELETE pos_print_jobs` 10 次、間隔中位 **0.03 秒**、8 對 <0.5s | 10 | **商家端操作** | **正常** —— 打印中心「清除已發送／已失敗」一次過刪 10 筆。**唔使處理**（⚠️ 但每次刪除 ＝ 1 個請求；批量清除 200 筆 ＝ 200 個請求，屬既有設計）|
| 3 | `GET pos_shifts` 16 次，但最大間隔 **2942 秒**（49 分鐘）| 16 | POS 網頁 | **正常** —— 180 秒 tick ＋ 開頁／focus 觸發；49 分鐘空檔 ＝ 嗰段冇人用（輪詢閘生效）|
| 4 | `GET /realtime/v1/websocket` 13 次（101 Switching Protocols）| 13 | POS 網頁 | **正常** —— 每次開頁／返前景重訂。⚠️ 每條 WS 都係一個 Realtime 連線；13 次/小時唔算多 |
| 5 | `00000` 25 次 | 25 | Supabase 內部 | **可忽略** —— Postgres checkpoint，唔關我哋事 |
| 6 | `HEAD 1` 次 | 1 | 唔明 | **可忽略** —— 單次，可能係探測／preflight |
| 7 | 退款 `42703` | **0** | — | ✅ **修復保持生效**（修前係每 30 秒 1 條）|

## E.4 🔴 決定性證據：用 **Supabase log 側面判定舊 vs 新版**（唔需要 Vercel log）

J 再畀嘅 `…T02-33-23.csv` 同上一份**逐位元相同**（`sha256 22bd76d99bf5c810`, 44,593 B）
⇒ 又係舊窗口，冇新資訊。**但唔需要等 Vercel log 都證明得到**：

### 指紋原理（新發現，值得記落嚟）

`skipQueue=1` 係**由 client 傳**嘅 query param，而 server 收唔到時會查 `limit=300`、
收到時查 `limit=0`（`state/route.ts:184-186`）：

```ts
const queueQuery = !skipQueue && storeId
  ? supabase.from("pos_queue_events").select("*").eq(...).limit(300)
  : supabase.from("pos_queue_events").select("*").limit(0);   // ← skipQueue=1 / 冇 storeId
```

⇒ **Supabase log 嘅 `pos_queue_events` URL 一定帶 `limit=300` 或 `limit=0`**
⇒ **`limit=300` ＝ 舊 bundle**（唔識傳 skipQueue）、**`limit=0` ＝ 新 bundle** ✓✓
（呢個係 Supabase log 側唯一可靠嘅 client-bundle 指紋 —— 唔需要 Vercel log 嘅 IP。）

### 實測結果（09:25–10:25 窗口）

```
舊 bundle（limit=300）  34 次   10:16:03 → 10:20:49（澳門）  跨度 286s
                                間隔中位 4.49s  最小 3.02s  最大 136.8s
新 bundle（limit=0）     1 次   10:15:57（澳門）
```

### ⇒ 結論：**係兩部唔同嘅裝置（或同一部機兩個分頁）**

| 裝置 | 行為 | 判斷 |
|---|---|---|
| **新 bundle** | **10:15:57 拉一次，之後完全冇再拉** | ✅ **完全正常** —— 修正生效（mount 一次就停）|
| **舊 bundle** | **10:16:03 → 10:20:49 循環 34 次（4.49 秒間隔）** | 🔴 **仍然跑舊 JS** —— 就係附錄 B 嗰部 Mac 嘅同類問題 |

⇒ **商家今早重啟咗嘅係「一部」裝置；仲有另一部未重啟。**

成本：34 × **846 KB**（舊 bundle 冇 skipQueue）≈ **28.8 MB / 4.8 分鐘**
⇒ 如果每小時都發生一次 ⇒ **0.7 GB/日**。

## E.5 搵出係邊部機（兩個方法）

1. ⭐ **用啱啱做好嘅「設置頁版本號」**（附錄 D）——
   叫商家**逐部機開設置頁**，睇 `版本` 一行：
   - 顯示舊日期／舊 sha ⇒ 嗰部就係元兇
   - 而且**頁面會自動出黃色警示**「此裝置仍運行舊版本…」⇒ 唔需要 J 逐個對
2. Vercel function log（要**新窗口**）睇 `[pos/state] 🔴 偵測到疑似舊版 bundle … ip=…`
   ⇒ 直接印 IP。

⚠️ Vercel 匯出要：① 喺 Logs 頁**先揀明確時間範圍並等佢載完**再 Export
（連續三次匯出都係同一個舊窗口，估計係匯出咗「頁面已載入嘅範圍」）
② 匯出後**比 SHA-256** 確認唔係舊檔。

## E.6 唔建議做嘅事（記錄理由）

| 方案 | 為何唔做 |
|---|---|
| 收緊 `/api/pos/state` 嘅 rate limit（現時 240/分鐘/IP）令舊 bundle 撞 429 | 舊 bundle 係 13/分鐘，要設到 ~10/分鐘才咬得到；而同一 IP（NAT）可能有多部終端，正常 burst 會被誤殺 ⇒ **POS 收到 429 比多打幾個請求嚴重** |
| server 主動叫舊 client 停 | 做唔到 —— 迴圈係 client-side，server 只可以回應 |
| 自動 reload | 收銀落單／結帳中途 reload 會出事（本專案明確禁用）|

⇒ **唯一安全做法：搵到嗰部機、完全閂掉視窗再開。**
（可選：把「版本過期」警示**由設置頁擴展到收銀台 `／pos` 頁面頂部**，
令商家自己即刻見到 —— 但會改動收銀台 UI，要 J 拍板。）

---

# 附錄 F：收銀台「版本過期」橫幅 ＋「按版本硬擋」可行性評估（2026-09-22）

## F.1 已實作：收銀台橫幅 ＋ 一鍵重新載入

> 🔗 **2026-09-23 跟進**：橫幅本身冇改，但**偵測時機**有問題 ——
> `x-pos-build` 原本只喺 `/api/pos/state`（事件驅動、冇週期輪詢）出現，
> 實測一部開住嘅收銀機可能幾個鐘都唔會再拉 state ⇒ 橫幅唔出。
> 已改為搭既有週期請求（`/api/pos/sync` 30 秒、`/api/pos/shift` 180 秒），
> **零新增請求**。詳見 **`docs/147-build-stale-detection-coverage.md`**。

| 項目 | 決定 |
|---|---|
| **位置** | `/pos` **頁面最頂**（`pos-app` flex-col 容器嘅第一個 child）——**in-flow，會推低內容，唔會蓋住任何控制項** |
| **顯示條件** | 只喺「**本機版本 ≠ 線上最新**」出現；其餘時間 `return null`（零佔位、零干擾）|
| **內容** | `⚠ 此裝置運行舊版本（本機 xxx，線上最新 yyy）` ＋ 一句「功能仍可用，但請盡快更新」＋ **`立即重新載入`** 掣 |
| **按鈕** | ✅ **需要，已加**。`min-h-[40px]`（守觸控準則），文案「立即重新載入」 |
| **確認保護** | 冇未完成工作 → **直接 reload**（一按即好，唔想多一步）；**有購物車／結帳畫面 → 先確認**，並講清楚「會清空 N 項菜品／結帳畫面」**＋**「已落單／未上雲嘅 N 筆紀錄會保留」 |
| **唔自動 reload** | 🔴 收銀落單／結帳中途 reload ＝ 災難（本專案明確禁用）。只可以提示 + 交人手撳 |
| **唔用 fixed overlay** | fixed 會**蓋住**「開工／線上接單／線下接單」控制項；in-flow 最安全 |

### 配套排版改動（唔改就會爛）

```
外層容器：flex → flex + flex-col（橫幅做第一個 child）
兩個分支嘅根：h-[100dvh] → min-h-0 flex-1
```
🔴 唔改嘅話，內容仍然係 `100dvh` 高 ⇒ 加咗橫幅之後**底部會被 `overflow-hidden` 裁切**
（收銀台底部按鈕會消失）。

### 驗證
- `tsc` 0 error；**1067 tests / 0 fail**；`build-info.test.ts` 24 條（含 6 條 `describeReloadRisk`）；
  `pos-app-stale-banner.test.ts` 6 條（守住「一定要掛上去」＋「唔可以自動 reload」＋「40px」）。
- 🔬 **真瀏覽器視覺驗證**（臨時強制顯示橫幅）：`/` 收銀台文字 424 → **512**，
  開頭文字見到「⚠ 此裝置運行舊版本（」；**17/17 路由、0 問題、0 pageError**；
  **截圖確認底部無裁切**（枱卡、快捷操作欄、底部按鈕全部完整）。
  ⚠️ 臨時改動已**還原**（`grep TEMP_FORCE` = 0 命中）。
  ⚠️ 注意：因為版本比對要 client／server 兩邊值唔同，**本機 dev 好難自然觸發**
  （兩邊都係同一個 dev server 產生嘅值）⇒ 所以要用「臨時強制」嚟驗視覺。

## F.2 ❌「版本唔正確就 block 請求」——可行性評估

**技術上做得到**（例如 `/api/pos/state` 檢查 client 送嘅 build id，唔符就回 426／409），
但**強烈唔建議**，理由如下：

| # | 問題 | 為何致命 |
|---|---|---|
| 1 | **分唔到「舊 client」同「唔係我哋嘅 client」** | 硬擋要靠 client **主動送** build id，而**舊 bundle 根本唔會送** ⇒ 唯一可行做法係「冇送就當舊」⇒ **一改就令所有舊裝置即刻死**（包括 kiosk、店員手機、admin 報表頁）|
| 2 | **版本 ≠ 相容性** | build id 每次 deploy 都變，但**大部分改動同 API 契約無關**（改文案、改 UI、改 log）。用 build id 做硬閘 ＝ **將每個 deploy 當 breaking change** ⇒ 逼商家每次部署都即刻重啟全部裝置，否則**停業** |
| 3 | **被擋嘅正正係你想救嘅畫面** | 舊分頁 `loadRuntimeState` 一失敗 ⇒ 訂單／枱況／打印全部停 ⇒ **收銀做唔到嘢**。**冇單比多打幾個請求嚴重得多** |
| 4 | **部署／快取過渡期** | Vercel 切 deployment 時新舊 instance 可能並存；CDN／`304` 亦可能令部分裝置遲一步拎到新 HTML ⇒ 會出現「**啱啱開頁就被擋**」呢種最難解釋嘅故障 |
| 5 | **唔係安全機制** | 只靠 header ⇒ 改個 header 就過。擋唔到惡意者，只係擋到自己人 |
| 6 | **運維成本轉嫁客人** | 每次 deploy 都要通知所有商家重啟 ＝ **長期營運負擔**，唔係一次性成本 |

⇒ **一句話：呢個方案係「用停業風險換 egress」，唔值。**

## F.3 建議做法（由安全到進取）

| 層 | 做法 | 風險 | 狀態 |
|---|---|---|---|
| **L1** | 設置頁版本顯示（本機 vs 線上最新） | 零 | ✅ 已做（附錄 D）|
| **L2** | 收銀台頂部橫幅 ＋ 一鍵重載（有確認保護） | 極低 | ✅ 今次做 |
| **L3（建議下一步）** | **偵測同一部機開咗多個 POS 視窗**（`localStorage`／`BroadcastChannel` 心跳）→ 提示「此裝置有另一個視窗，可能係舊版本」 | 低 | 建議做 |
| **L4（可選）** | 舊版**只讀降級**：讀照准，**只拒寫入**（落單被拒） | 中高 | 唔建議（同樣令收銀做唔到嘢，但至少睇得到單）|
| **L5** | 按版本**硬擋全部請求** | 高（等同停業）| ❌ 唔建議 |

### 🔑 為何 L3 係更好嘅路徑

問題嘅**真正根源**唔係「舊版本存在」，而係「**同一個終端同時開住新舊兩個視窗，商家以為已更新**」
（今次實測正好係咁：10:15:57 一部新 bundle 拉一次、10:16:03 另一部舊 bundle 開始循環）。

L3 直接針對根源：**開多過一個 POS 視窗就提示**（唔擋、唔影響運作），商家即知要閂邊個。
比「按版本硬擋」精準，而且**零停業風險**。

---

# 附錄 G：2026-09-22 11:20 最終複核 —— **全清** ✅

> 樣本：`macau-pos-system-log-export-2026-09-22T03-17-44.csv`（新檔，sha `6701e77a0f915468`）
> 內容窗口 **`02:45:24Z → 03:13:31Z`** ＝ 澳門 **10:45 → 11:13**（28.1 分鐘）
> ＋ `supabase_logs (11).csv`（窗口 `02:50:21Z → 03:16:34Z` ＝ 澳門 **10:50 → 11:16**）
> 背景：**商家已經完全閂掉 Safari**。

## G.1 請求：15.2 → **0.7 次/分鐘（−95%）**

Vercel 側 **20 個請求 / 28.1 分鐘，全部 200、零 error／warning**：

| 次數 | /分鐘 | route | 來源 |
|---:|---:|---|---|
| 10 | 0.36 | `POST print-agent/claim` | APK（180s ✓）|
| 5 | 0.18 | `GET pos/device-config` | APK（360s ✓）|
| 3 | 0.11 | `GET /login` | 有人開登入頁 |
| 1 | 0.04 | `/icon` | 瀏覽器 |
| 1 | 0.04 | `/apple-icon` | 瀏覽器 |

```
🔴 POST /api/pos/print-agent/heartbeat   =  0 次   ← 心跳完全消失 ✅
✅ GET  /api/pos/state                    =  0 次   ← 網頁側零全量拉取 ✅
✅ GET  /api/pos/sync                     =  0 次
```

## G.2 Supabase 側：**零網頁流量、零 POS 相關錯誤**

| 操作 | 次數 | 間隔中位 | 判斷 |
|---|---:|---:|---|
| `PATCH pos_print_agents` | 9 | **181.29s** | ✅ claim 蓋章（**冇 30 秒心跳**）|
| `rpc/pos_claim_print_jobs` | 9 | **180.97s** | ✅ |
| `GET pos_print_agents` | 5 | 361.90s | ✅ device-config |
| `GET pos_device_configs` | 5 | 361.96s | ✅ |

🔑 **最有力嘅一個比例**：`PATCH pos_print_agents` 9 次 vs `claim` 9 次 ＝ **1:1**
⇒ 即係**每一個蓋章都係 claim 造成** ⇒ **獨立心跳真係冇咗**
（若心跳仍在，會係 52:9）。

**完全 0 次**（＝瀏覽器側真係停咗）：

```
pos_queue_events（舊 limit=300 / 新 limit=0 都係 0）
pos_orders_page（RPC）／pos_print_templates／pos_note_presets／pos_print_jobs
pos_orders／pos_shifts／pos_store_status／pos_online_order_settings
```

✅ **亦零 409、零 `once_key` 重複**（附錄 E.3 嗰條都冇再出現）。

## G.3 兩點仍要注意

### ① ⚠️ 未能確認「POS 頁面開住時」嘅行為（誠實講）
呢個窗口 **`/login` 3 次、POS 主頁 0 次** ⇒ **嗰段時間根本冇開 POS 頁面**。
所以「零」有兩重意思：**（a）循環冇咗**、**（b）冇人開頁**。兩者未能分開。

⇒ 要**最後確認**，需要一個「**營業中、POS 開住**」嘅窗口：如果連續幾個鐘都
**冇** `limit=300`（舊 bundle 指紋）出現 ⇒ 就真正收口。

（已知嘅正面證據仍然有效：11:15 前一次實測，新 bundle 拉一次就停；
舊 bundle 嗰部喺商家閂 Safari 之後亦冇再出現。）

### ② 🔴 `schema_migrations_pkey` 重複鍵（唔關 POS，要你確認）
```
error 23505  duplicate key value violates unique constraint "schema_migrations_pkey"
時間 2026-09-22T03:15:48.531Z ＝ 澳門 11:15:48
```
`schema_migrations` 係 **Supabase CLI 嘅遷移記錄表** ⇒ 呢條代表
**喺 11:15:48 有人重複執行一個已經套用過嘅 migration**。

- 如果係你（或者我哋）手動跑 migration ⇒ **無害**（CLI 會冚返，唔會改到資料）。
- 如果係**自動化流程重跑** ⇒ 就要查（唔應該發生）。

⚠️ 呢條唔係「殘留問題」，係一個**獨立事件**，但值得知悉。

## G.4 總結：由 21 Sep 嘅 904 MB/日 → 現在估計 **10~20 MB/日（−98%）**

| 指標 | 21 Sep（最差）| 22 Sep 08:24–08:53 | **22 Sep 10:45–11:13** |
|---|---:|---:|---:|
| 請求／分鐘 | 15.2 | 3.2 | **0.7** |
| 中繼心跳 | 2.00/min | 1.93/min（未更新）| **0** |
| 網頁全量拉取 | 5.65/min（循環）| 0 | **0** |
| error／warning | 有 | 0 | **0** |
| 每日 egress | **904 MB** | — | **≈10~20 MB** |

### 三件事嘅貢獻（追溯）
| 改動 | 效果 |
|---|---|
| APK 刪心跳 ＋ claim 180s | 3.0 → 0.33 次/分鐘 |
| 輪詢閘（`poll-gate.ts`）＋ 手勢喚醒 | 網頁週期拉取 → 0 |
| **商家完全閂掉舊 Safari 分頁** | **循環 → 0（今次最後一塊）** |

⇒ **即係話：程式改動處理咗「系統會自己產生嘅流量」；但最後嗰 27 MB/小時 係一部
跑住舊 JS 嘅分頁，只有「閂掉」先解決得到** —— 呢點同附錄 B／D／F 嘅結論完全一致。



