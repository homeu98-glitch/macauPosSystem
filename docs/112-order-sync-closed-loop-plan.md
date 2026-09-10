# 112 · 訂單狀態上雲「自動閉環」方案

> 目標：**店內 iPad 標記完成（settled）之後，後台狀態必須最終一致；商家唔需要做任何手動同步。**
>
> 現象（2026-09-10 表嫂美食，反覆發生）：
> - iPad「訂單」頁 店內線下訂單 顯示「已完成」（= `settled`）——員工確實做咗。
> - 後台報表仍然顯示「未結帳訂單 2 張 · MOP 95 · 已送廚房（未結帳）」——即雲端 `pos_orders.status` 仍係 `sent_to_kitchen`。
> - 已知指紋：`status='sent_to_kitchen' AND updated_at = created_at AND payment_method = '' AND served_at IS NULL`
>   （見 `docs/diagnosis-2026-09-09-unsettled-orders.md`）→ 即**建單事件到咗，結帳事件由始至終冇套用過**。
>
> 相關程式碼：`src/lib/pos/sync-flush.ts`、`src/lib/pos/sync-reconcile.ts`、
> `src/lib/pos/pos-sync-auth.ts`、`src/lib/pos/pos-device-token.ts`、
> `src/app/api/pos/sync/route.ts`、`src/app/api/pos/state/route.ts`、`src/components/pos-app.tsx`

---

## 0. 一句話結論

現行架構係 **「本地寫入 → 事件單向推送 → HTTP 200 就當成功」**：
冇訂單級確認、冇任何自動對賬、失敗會**永久放棄**，而且「成功」嘅定義包含「server 其實冇寫入」。

所以要將一致性由「**靠事件送達**」改為「**靠狀態收斂**」——
引入五層閉環：**全量快照 + 單調修訂號 → 精確回執 → 常駐對賬守護 → 上傳證據 → 雲端巡檢兜底**。

---

## 1. 現狀鏈路（附行號）

**寫入（本地 → 雲端）**

```
結帳 handler（pos-app.tsx:3494 / 3696 / 3825）
  → 改本地 order.status = "settled" + saveOrders()          // 本地即刻係終態
  → pushEvents([ORDER_SETTLED])                              // 入 outbox（queue-outbox.ts enqueueEvents）
  → notifyQueueChanged()                                     // 即時觸發 flush
  → flushPosSyncQueue → doFlush（sync-flush.ts:352）
      · refreshPosDeviceTokenIfNeeded()   ← 只有呢度有續期
      · filterEventsForCurrentStore()     ← 只推 storeId === 當前店
      · POST /api/pos/sync
  → 成功（HTTP 200）→ v2：**由 queue 剷走事件**（sync-flush.ts:533）
```

**讀取（雲端 → 本地／報表）**

```
loadRuntimeState()（pos-app.tsx:899）→ GET /api/pos/state
  → mergeOrderLists()（pos-order-filters.ts:93，終態優先 LWW）
  → UI / 報表（admin 報表以雲端 pos_orders 為準）
```

**關鍵：本地同雲端之間只有「單向事件推送」一條橋，冇任何迴路去檢查橋係唔係真係通。**

---

## 2. 七個會造成「本地已完成、後台未完成」嘅機制（附程式碼證據）

按「能否完全無網絡問題都發生」排序——M3/M4 最符合「又發生了」。

| # | 機制 | 證據 | 後果 |
|---|---|---|---|
| **M1** | **憑證閘拒收結帳事件**：`ORDER_SETTLED` 屬「必須 POS 終端憑證」事件，匿名通道只准 `ORDER_CREATED/UPDATED`。而 `syncNow()` **冇**先續期（`pos-app.tsx:2543` 直接帶 `posDeviceAuthHeaders()`），只有 flush worker 有（`sync-flush.ts:362`）。憑證 TTL 12h，若 `ledgerAccessToken` 缺失／過期 → 所有結帳事件被拒。 | `sync/route.ts:258, 386`；`pos-app.tsx:2543` vs `sync-flush.ts:362` | 建單可以成功（舊 token 仍有效時），結帳全部失敗 |
| **M2** | **永久放棄**：`MAX_SYNC_ATTEMPTS=5`，`selectFlippable` 只揀 `attempts < 5`。到頂 → `failed` → **冇任何自動路徑會再揀佢**（程式碼註解自己承認：「呢啲 event 之後會俾上面第 209 行 continue 跳過，永遠唔會再重試」）。 | `sync-flush.ts:65, 335, 507-509` | 一次連續 5 次失敗 = 嗰張單永遠唔上雲 |
| **M3** | **假成功**：server 對「stale（incoming 較舊）」同「終態降級」兩個 case **回 `ack(true)`**，client 收到 200 就**剷走事件**。 | `sync/route.ts:493-502` + `sync-flush.ts:458` | 雲端停喺舊狀態，而本地已經冇副本可以重試 |
| **M4** | **用裝置牆鐘做 LWW 主導**：`client_updated_at` 由 client 時鐘 stamp（`updatedAt`），server 比較 `incomingTs < existingTs` 就判 stale。iPad 冇 NTP／中途被 NTP 回撥 → 結帳事件時間**比建單更舊** → 判 stale → 併入 M3。 | `sync/route.ts:443, 482-488, 547` | **完全冇網絡問題都會發生**，最符合「反覆發生」 |
| **M5** | **零自動驗證**：`computeReconcileDrift` / `pushOrderSnapshotForReconcile`（補錄）只喺商家手動開「同步健康」Modal 先跑。 | `sync-health-modal.tsx:134-142`；`sync-reconcile.ts:104` | 後台分叉可以無限持續，冇人知 |
| **M6** | **單副本**：終態訂單只存在嗰部 iPad 嘅 localStorage。清 cache／換機／Safari ITP 清理 = 冇得救。 | `storage.ts` `loadOrders/saveOrders` | 事件一旦被剷（M3）＋ localStorage 被清 = 資料永久消失 |
| **M7** | **「即時同步」其實係死路**：`syncNow([...queue, paymentEvent])` 用 stale React state，且新建嘅 `paymentEvent` **未經 `withStoreScope()` stamp storeId** → 入到 `filterEventsForCurrentStore` 就被剔走。真正推上去嘅係 `notifyQueueChanged()` 觸發嘅 flush worker。兩條並行路徑、其中一條係死路 → 容易誤判「已即時同步」。 | `pos-app.tsx:3524, 2535, 2617` | 診斷時會被誤導；亦造成重複推送 |

> 另外：`在線` 綠標 = `networkOnline`（瀏覽器在線），**唔等於**同步隊列健康（已喺診斷文檔記錄）。

---

## 3. 目標不變量（可測、可驗收）

- **I1 收斂性**：任何本地終態單（`settled` / `cancelled` / `refunded` / `partially_refunded`），最終雲端 `status` 必等於本地終態；唯一例外係雲端有更新嘅合法反轉（`reopened`）。
- **I2 可證性**：任何時刻都可以答「呢張單上咗雲未」——用**訂單級回執**判斷，唔係用「request 有冇 200」。
- **I3 零操作**：修復全部自動進行。需要人知嘅只有一種：「已自動重試 N 次仍然失敗」。
- **I4 冪等**：重複推送無副作用——唔會降級、唔會重複計數、唔會重複打印。

---

## 4. 設計：五層閉環

### L0 · 寫入模型：全量快照 + 單調修訂號（根治 M3 / M4）

1. `PosOrder` 加 `clientRev: number`：**每次本地狀態改動 +1**（`sendToKitchen` / 出餐 / 結帳 / 返結 / 取消），隨 order 一齊 persist。
2. 事件 payload 一律帶 `clientRev` + **完整 order 快照**。
   - `ORDER_UPDATED` / `ORDER_CREATED`：已經是完整快照 → 補 `clientRev`。
   - `ORDER_SETTLED`：**payload 補齊完整 `order`**（現時只有 partial patch，見 `sync/route.ts:590-601`），server 統一走 `upsert(onConflict:"id")`。
   - 效果：`ORDER_SETTLED` 命中 0 列嘅兜底分支（`sync/route.ts:628-659`）變成唔需要存在。
3. Migration `0031_pos_orders_client_rev.sql`：

```sql
alter table pos_orders add column if not exists client_rev bigint not null default 0;
create index if not exists pos_orders_store_status_updated_idx
  on pos_orders (store_id, status, updated_at desc);
```

4. Server 守門改為 **rev 優先、時間為輔**：

```
terminalRank(s) = settled/cancelled/refunded/partially_refunded → 2
                  reopened                                     → 1
                  其他                                          → 0

if incoming.client_rev > existing.client_rev  → 寫入
if incoming.client_rev < existing.client_rev  → 拒絕（applied:false, reason:"stale"）
if 相等 → 比較 terminalRank；rank 大者勝；rank 相等先比時間
```

   → 時鐘偏移、離線重排、NTP 回撥全部失效；「回退做未結帳」結構性消失。

### L1 · 回執語義精確化（根治 M3）

`/api/pos/sync` 回應嘅 `results[]` 由 `{id, ok}` 升級為：

```ts
{ id: string; ok: boolean; applied: boolean; rev?: number;
  status?: string; updatedAt?: string;
  reason?: "stale" | "downgrade" | "unauthorized" | "not-found" | "db-error" }
```

Client 行為（`sync-flush.ts` / `syncNow`）：

| 回執 | Client 動作 |
|---|---|
| `applied: true` | 剷走事件 + 寫 `syncAck{rev, status, ackedAt}` |
| `applied: false, reason: "stale"/"downgrade"` | **唔准剷**，投入「待校驗」集合（交 L2 處理） |
| `applied: false, reason: "unauthorized"` | 強制續期憑證後重推；續期失敗 3 次 → `blocked` |
| `ok: false`（DB 錯誤等） | 退避重試，attempts+1 |

> 向後兼容：舊 client 只讀 `ok`，行為不變（`stale` 一樣當成功剷走——所以 L2 對賬守護係必須嘅第二道保險）。

### L2 · 常駐對賬守護 Auto-Reconcile Daemon（填 M5，**本方案核心**）

新增 `src/lib/pos/sync-reconcile-daemon.ts`，由 `pos-app` mount 時 `installSyncReconcileDaemon()`（同 flush worker 一樣 idempotent、`listenersInstalled` guard）。

**觸發點**：mount ／ 每次 flush 完成 ／ `online` ／ `visibilitychange` ／ 每 60s 心跳 ／ 每次結帳後 20s（帶 ±5s jitter）

**一輪邏輯**：

1. 揀出「**本地係終態** 且 `syncAck.rev < order.clientRev`」嘅單（＝未取得雲端確認）。
2. `POST /api/pos/orders/verify`（新端點，輕量）
   body：`{ storeId, ids: [{ id, rev, status }] }`（上限 100）
   回：`[{ id, status, client_rev, updated_at } | null]`
3. 判定：
   - 雲端終態 == 本地終態 → 寫 `syncAck`，**結案**。
   - 雲端非終態（或根本冇 row）→ **自動補推完整快照**（重用 `pushOrderSnapshotForReconcile`，`sync-reconcile.ts:104`，由手動改為自動）。
   - 雲端終態 ≠ 本地終態（例如雲端 `cancelled`、本地 `settled`）→ **唔自動覆蓋**，標 `conflict` 交人睇（避免自動化製造新錯誤）。
4. 節流與退避：每張單獨立 backoff `15s → 30s → 60s → 5m → 15m → 1h`；連續失敗 3 輪 → `blocked`。
5. 硬上限：每輪最多 100 張、每分鐘最多 1 輪（避免打爆 API 同 Realtime）。

> 呢層係把「出事之後要商家開 Modal 撳掣」變成「系統自己每分鐘檢查一次」——
> 直接回應你嘅核心要求：**唔需要教商家手動同步**。

### L3 · 上傳證據持久化（對應 I2）

- store-scope 新 key `macau-pos/stores/{storeId}/sync-acks`：`{ [orderId]: { rev, status, ackedAt, serverUpdatedAt } }`。
- **可驗證式**：`acked.rev >= order.clientRev && acked.status === order.status` ⇒ 已上傳。
- UI 呈現：
  - 訂單列／詳情頁：`✓ 已同步 14:52:31` ／ `⏳ 待上傳（重試 2）` ／ `⛔ 同步受阻`（可撳查看原因）
  - 頂欄健康燈：由單純「在線」改為 **`同步正常` / `N 張待上傳` / `同步受阻`**
  - 交班頁：現有「N 筆未同步」旁邊加 `blocked` 數 + 「立即補推」

### L4 · 兜底（填 M6）+ 雲端巡檢

- **IndexedDB 持久化**：outbox 同「終態單鏡像」寫入 IndexedDB（localStorage 屬 best-effort，Safari ITP 會清）。localStorage 保留做快取。
- **交班閘**：`closeShift` 前強制跑一輪對賬；仍有未確認終態單 → 明確二次確認（唔好靜默通過）。
- **心跳**：`POST /api/pos/sync-heartbeat` 每 60s 報 `{deviceId, pending, failed, blocked, lastAckAt}` → 新表 `pos_device_heartbeats`（migration 0032）→ 後台「設備同步健康」頁。
- **雲端巡檢（唔靠 iPad，server 側定時跑）**：

```sql
-- 建單後從未被更新過嘅非終態單（＝最可疑嘅「未落地結帳」）
select store_id, id, local_order_no, total, created_at
from pos_orders
where status in ('draft','sent_to_kitchen','paid')
  and updated_at = created_at
  and created_at < now() - interval '2 hours';
```

  → 寫入 `pos_sync_alerts`，後台「同步告警」頁可見；可一鍵通知商戶核對。
  ⚠️ 注意：呢條 SQL 只能生成「疑似清單」，**唔可以**自動把雲端改成 `settled`——收款事實只能由收銀端確認（見 §9）。

### L5 · 加固（消除 M1 / M2 / M7）

| 項目 | 改動 |
|---|---|
| M1 | `syncNow()` 開頭加 `await refreshPosDeviceTokenIfNeeded()`；所有 `/api/pos/**` 呼叫點統一走一個 `posAuthorizedFetch()` wrapper |
| M1 | 憑證狀態可見：`AuthSession` 加 `posTokenExpiredAt`；UI 顯示「終端憑證過期，請重新登入」（而唔係靜默失敗） |
| M2 | `attempts >= MAX_SYNC_ATTEMPTS` 嘅語義由「**永久放棄**」改為「**降到 15 分鐘一次嘅慢速重試**」；真正嘅終態係 `blocked`（要 UI 出聲），`failed` 只係退避狀態 |
| M7 | `syncNow` 由 `loadQueue()` 讀最新 queue（唔用 stale React state），並對新事件先 `withStoreScope()` stamp |
| — | `pushEvents` 已經會 `notifyQueueChanged()` 觸發 flush；`syncNow` 改為只喺「flush 失敗」時做 fallback，避免雙路徑重複推送 |

---

## 5. 失敗偵測與自動重試（一覽）

| # | 失敗類型 | 偵測方式 | 自動處理 | 升級條件 |
|---|---|---|---|---|
| 1 | 網絡斷 | fetch throw / `navigator.onLine=false` | 保留 pending；`online` 事件 + 30s interval 重試 | > 10 分鐘 → 琥珀橫幅 |
| 2 | 憑證過期 | HTTP 401/403 或 `reason:"unauthorized"` | 先續期再推（force） | 續期連續 3 次失敗 → 要求重新登入 |
| 3 | Server 5xx | HTTP 5xx | 指數退避 15s→15min | > 30 分鐘或連續 8 次 → `blocked` |
| 4 | 版本落後 | `applied:false, reason:"stale"` | L2 拉雲端校驗；雲端非終態 → 提高 `clientRev` 重推 | 3 輪仍分叉 → `conflict` 告警 |
| 5 | attempts 到頂 | `attempts >= 5` | 轉慢速重試（15 分鐘）+ L2 守護用快照補推 | `blocked` → 紅色橫幅 + `pos_sync_alerts` |
| 6 | storeId 無主 | `classifyQueueEvent` → `skipped` | 提示重新登入／綁定店舖 | 保持 |
| 7 | 雲端孤兒（iPad 已清／換機） | 巡檢 SQL（§4 L4） | 生成「疑似未結帳」清單 | **人工核對**（唯一需要人嘅 case） |

---

## 6. 如何驗證「數據確實上傳成功」（四層）

| 層級 | 驗證方式 | 權威性 |
|---|---|---|
| **V1 事件層** | HTTP 200 **且** `results[].applied === true` | 弱（只證明 server 收咗） |
| **V2 訂單層** | `POST /api/pos/orders/verify` 回 `status === 本地終態 && client_rev >= 本地 clientRev` | **權威**（直接讀 `pos_orders`） |
| **V3 本地帳本** | 每張單嘅 `syncAck` 可查（UI 顯示「已同步 14:52:31」） | 中（俾收銀自我核對） |
| **V4 業務層** | 後台報表「未結帳」KPI 歸零；巡檢 SQL 命中 0（除真正未付款） | 權威（客戶可見） |

**自檢入口**：現有「同步健康」Modal 由「手動查」升級為「持續自檢結果顯示」——
逐張終態單列出：`本地 status / 本地 rev / 雲端 status / 雲端 rev / 最後確認時間 / 重試次數`。
每次對賬守護跑完都更新，商家一開就見到真相，唔需要自己判斷。

---

## 7. 分期落地

| 期 | 內容 | 改動範圍 |
|---|---|---|
| **P0**（唔改 schema，可即日上） | L5 全部；L1 嘅 `applied/reason` 欄位（server 先加，舊 client 不受影響）；L2 常駐化（先用現有 `/api/pos/state?ordersOnly=1&limit=…` 做校驗通道，之後換輕量端點）；L3 UI 顯示 | `sync-flush.ts`、`sync-reconcile.ts`(新 daemon)、`pos-app.tsx`、`sync/route.ts` |
| **P1**（migration 0031） | `clientRev` + `pos_orders.client_rev` + 全量快照推送 + `/api/pos/orders/verify` 端點 + rev 守門 | 上述 + `types.ts`、`pos-order-mapper.ts`、新 route |
| **P2** | IndexedDB 持久化；`/api/pos/sync-heartbeat` + 0032 + 後台「設備同步健康」頁；雲端巡檢 job + `pos_sync_alerts` + 後台「同步告警」頁 | 新 migration、admin 頁 |

---

## 8. 回滾

- **L0/L1**：`client_rev = 0`（舊 row／舊 client）時自動 fallback 現行時間 LWW → 新舊並存安全。
- **L2**：`localStorage["macau-pos/sync-reconcile-daemon"] = "0"` 即關閉，唔會影響 flush。
- **L5**：純 client 行為，直接 revert 即可。

---

## 9. 明確邊界（唔做嘅事）

1. **唔改收入認列口徑**：未結帳單照樣唔計入營業額（`isSaleCountable` 不變），唔用「計埋佢」嚟遮掩問題。
2. **唔會自動把雲端 open 單改成 settled**：自動化只負責「**把商家已經做咗嘅事忠實推上雲**」，唔會無中生有地創造收款事實。
3. **唔會靜默覆蓋衝突**：雲端同本地都係終態但唔一致（例如一方 cancelled）→ 只標 `conflict` 交人，唔自動揀邊個贏。
