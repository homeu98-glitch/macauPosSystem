# Session / 寫入閘 / 關店後對數 —— 機制設計（2026-09-21）

> 委託：① 店已關仍可下單 → 應立即阻止；② 設計「active session + idle」判斷邏輯並評估 heartbeat 是否適用；
> ③ 界定「關店後可對數」嘅範圍（只准一次查詢，唔准持續呼叫）。
>
> 本文＝**設計與取捨**（未實作）。所有「現況」描述都有 `檔案:行號` 證據。

---

## 0. 現況取證（先講清楚而家實際擋到咩）

### 0.1 現有嘅三道閘

| 閘 | 位置 | 真源 | 擋邊個 |
|---|---|---|---|
| 店內營業 | `src/app/api/pos/sync/route.ts:519-534`（2.55） | POS DB `pos_store_status.is_open` | **只擋匿名**（`!authorized`） |
| 班次 | `src/app/api/pos/sync/route.ts:558-572`（2.56） | `pos_shifts` 有冇 `closed_at IS NULL` | **只擋匿名**（`!authorized`） |
| 開工 | `src/components/pos-app.tsx:949-953` `ensureShiftOpened()` | **本機** `shift.openedAt` | 收銀台自己嘅落單動作 |

`pos-app.tsx:944-947` 已經有一份**過閘／唔過閘清單**（呢個係本專案既有嘅正確模式）：

```
過閘（會產生／推進銷售）：開枱、加菜、下單／加單、結帳
唔過閘（對數要用）      ：睇枱／睇單、報表、補打帳單、取消單、同步健康、手動更新
```

### 0.2 🔴 四個缺口

| # | 缺口 | 證據 | 後果 |
|---|---|---|---|
| **A** | **收銀台（帶 POS 憑證）完全冇「店已關」閘** | `sync/route.ts:869` `if (!authorized && storeClosed)`；`useStoreStatus()` **冇被 pos-app 用過**（只用於 `app-sidebar`／`online-open-pill`／`shift-page`／`use-store-open-toggle`） | 老闆撳「暫停營業」之後，收銀員照樣開枱落單 |
| **B** | 收銀台嘅開工閘只讀**本機** `shift.openedAt` | `pos-app.tsx:950` | 另一部機交班後，本機最長 **180 秒**（`pos-app.tsx:852`）先同步到；**舊分頁可以一直用過時狀態落單**，而 server 因為 `authorized` 而**接受**（收銀員以為落咗單） |
| **C** | **全系統冇任何 idle／active session 偵測** | grep `idleTimer\|IDLE_MS\|lastActivity\|lastInteraction` → **0 命中** | 掛機 24 小時照跑（實測佔 62% 請求） |
| **D** | 兩道 server 閘都係 **fail-open** | `sync/route.ts:528-530`、`566-568` | 斷網／表缺失 ⇒ 全店放行（**刻意**，見 §1.4） |

---

## 1. 問題一：店已關仍可下單

### 1.1 判斷條件（三層，由權威到體驗）

```
G1（server，權威，唯一可靠）
   寫入類事件（ORDER_CREATED / ORDER_UPDATED）一律要求：
        storeOpen === true   AND   shiftOpen === true
   —— 無論 authorized 與否。
   ⚠️ 但「唔可以完全冇逃生門」，見 §1.2。

G2（client，體驗層）
   把 ensureShiftOpened() 擴充成 ensureWritable()：
       sessionAlive AND shiftOpen(本機) AND storeOpenStatus !== false AND !idleLocked
   唔過閘就**即時**出 toast（唔好等 server reject 咗先講）。

G3（自我修正）
   server 回 shop-closed / shift-closed 時，client 要**即刻**把本機 shift／店狀態
   更正 + 出全屏提示，而唔係當一般網絡錯誤靜靜重試。
   ⇒ 呢個係「舊分頁自我修正」嘅唯一途徑（舊 bundle 冇 G2）。
```

### 1.2 逃生門（最關鍵嘅取捨）

「店已關之後仲要唔要落得到單」有兩個相反需求：

| 需求 | 想要 | 唔可以 |
|---|---|---|
| 客人仲喺度食緊 → 要埋數 | 結帳、取消、補打帳單、出紙 | — |
| 唔應該再開新生意 | — | 開枱、加菜、新單 |

**建議：唔用「一刀切全擋」，而係沿用 `pos-app.tsx:944-947` 嗰份既有清單，逐 event type 判：**

| 事件 | 店已關時 | 理由 |
|---|---|---|
| `ORDER_CREATED` | ❌ 拒 | 新生意 |
| `ORDER_UPDATED`（帶 `addedItems`） | ❌ 拒 | 加菜＝新生意 |
| `ORDER_UPDATED`（純狀態推進：`sent_to_kitchen` / `paid`） | ✅ 准 | 埋尾 |
| `ORDER_SETTLED` | ✅ 准 | **客人走唔到更嚴重** |
| `ORDER_ITEM_VOIDED`、`ORDER_CANCELLED` | ✅ 准 | 更正 |
| `PRINT_JOB_*`、`TEST_PRINT` | ✅ 准 | 出紙 |
| `DEVICE_CONFIG_UPDATED`、`QUEUE_*` | ✅ 准 | 基建 |

⚠️ 難點：`ORDER_UPDATED` 要分辨「加菜」定「推進狀態」——**收銀台已經帶 `addedItems`**（
`sync/route.ts:842-843`），所以判得到；舊 client 冇帶 ⇒ **fail-open（准）**。

**逃生門本身**：真要喺關店後補單 → **重新開工（開新班次）**，
令「補單」成為一個**有記錄、有意圖**嘅動作，而唔係靜默允許。

### 1.3 落點

| 改動 | 檔案 |
|---|---|
| G1 閘擴展到 authorized | `src/app/api/pos/sync/route.ts`（2.55／2.56 兩段＋`if (!authorized && …)` 逐處檢視） |
| 純決策抽出（可單測） | 新檔 `src/lib/pos/write-gate.ts`（**零 import**，仿 `close-gate.ts`） |
| G2 | `pos-app.tsx`：`ensureShiftOpened()` → `ensureWritable()`；`pos-app` 引入 `useStoreStatus()` |
| G3 | `pos-app` 處理 `ack.reason` 分支時更新本地狀態 |

### 1.4 取捨（一定要知）

| 選擇 | 好 | 壞 |
|---|---|---|
| **fail-open 保留**（查唔到就放行） | 斷網唔會令全店停單 | 表缺失／網絡問題時「關店」形同虛設 |
| 改 fail-closed | 真正擋得住 | **一斷網全店落唔到單**，對一間實體店係災難 |
| ⇒ 建議 | **保留 fail-open**，但加**補償**：① G2 client 層擋（本地已知 `isOpen=false` 就唔畀開單）② 每次 fail-open 都 `console.warn` ＋ 喺側欄出黃色警示（「營業狀態讀唔到，暫時無法確認是否已關店」） | |

---

## 2. 問題二：active session 與 idle

### 2.1 四條**正交**軸（唔可以壓成一條）

| 軸 | 真源 | 可能值 | 擋咩 | 停唔停輪詢 |
|---|---|---|---|---|
| **營業** | `pos_store_status.is_open` | `true` / `false` / `null` | 客人落單、收銀開新單 | 停（`false` 時） |
| **班次** | `pos_shifts` open row | `open` / `closed` / `unknown` | 收銀開枱落單 | 停（`closed` 時） |
| **登入** | `auth-session`（localStorage）＋ POS 終端 token（**TTL 12h**，`pos-device-token.ts:31`） | `valid` / `expired` / `none` | 一切讀寫 | 停（`none` / `expired` 時） |
| **活動** | 🆕 最後一次**真人互動**時間 | `active` / `idle` | — | **停（`idle` 時）** |

⚠️ 一定要四條分開，理由：

- 「關店」唔等於「冇 session」（對數要 session）。
- 「有 session」唔等於「有人用」（長期掛機就係呢個）。
- `pos_store_status` 冇 row ＝ **營業中**；`pos_shifts` 冇 open row ＝ **未開工**（**方向相反**，唔可以撈埋）。

### 2.2 決策：`shouldKeepPolling()`

```
poll = sessionAlive
   AND !idleLocked
   AND 分頁可見（document.visibilityState === "visible"）
   AND NOT (storeOpen === false AND onlineChannel === false)   ← 兩條通路都關
   AND NOT (shiftClosed AND 冇 pending 事件)

idleLocked = 距最後一次真人互動 > IDLE_MS
```

**`IDLE_MS` 建議值**

| 場景 | 建議 | 理由 |
|---|---|---|
| 收銀台（有人用） | **30 分鐘** | 一輪忙碌之間唔會靜 30 分鐘；太短會喺靜市時誤停 |
| 已關店／已交班 | **5 分鐘** | 已經冇業務活動，冇需要密 |
| 冇 session | **即停** | 冇嘢可以操作 |

**恢復（三條，全部零延遲）**

1. **任何 `pointerdown` / `keydown` / 掃碼** → 解除 `idleLocked` ＋ 即時拉一次。
2. `visibilitychange` → 返前景即拉（現成 listener 已有）。
3. **Realtime 事件**（新單／`pos_store_status` 變更）→ 解除鎖定 ＋ 拉一次。
   ⚠️ **Realtime WebSocket 唔可以停** —— 佢係「靜咗都會知」嘅唯一保證，
   而且只佔 Supabase egress **0.7~1.2%**（實測）。

**兜底慢輪詢**：即使 idle 都保留**每 10 分鐘一次**嘅輕量探測
（本專案有「WS 靜默失效」前科：`use-store-status.ts:38-43` 講明訂錯專案會 `SUBSCRIBED` 但永遠收唔到事件）。

### 2.3 落點

| 改動 | 檔案 |
|---|---|
| 純決策 | 新檔 `src/lib/pos/poll-gate.ts`（**零 import**，仿 `close-gate.ts`／`resubscribe-guard.ts`） |
| 活動追蹤 | 新檔 `src/lib/pos/activity-tracker.ts`（module singleton，單一 `pointerdown`/`keydown`/`visibilitychange` listener；refCount） |
| 套用 | `pos-app`（180s tick、全量拉取）、`pending-count-store`、`sync-acks`（15s）、`restaurant-daily-report`（10min） |

### 2.4 🔴 Heartbeat 評估（你明確要求）

**現況**：APK **每 30 秒** POST `/api/pos/print-agent/heartbeat`，唯一效果係蓋 `last_seen_at`。

**逐項檢視**

| 問題 | 實情 |
|---|---|
| 佢係咩模式？ | **推送式**（client 主動）⇒ **關店、掛機、冇 session 都照打**，冇得暫停 |
| 有咩人用？ | 只有 `print-center` **顯示**「中繼機在線」；**冇任何 server 邏輯靠佢**（grep 全 repo） |
| 成本 | 實測 **1.86 次/分鐘**＝關店時段全部請求嘅 **12%**，係**單一最大 invocation 來源** |
| 係咪冗餘？ | ✅ **係**。`claim`（每 60 秒、**無條件**打）已經會蓋**同一個** `last_seen_at`（`claim/route.ts` 傳 `recordActivity: true`） |
| 送嘅資料有冇用？ | ❌ `ipAddress` / `ipAddresses` **server 由頭到尾冇讀過**（全 repo 冇 IP 欄位） |

### ⇒ **判斷：heartbeat 唔適用**（以「每 30 秒一個 HTTP」做在線偵測，成本係 60 秒方案嘅 2 倍，而精度冇人需要）

**替代方案比較**

| 方案 | 做法 | 優 | 劣 | 省幾多 |
|---|---|---|---|---|
| **A** 現行 | APK 30s 心跳 | 簡單即時 | 最大 invocation 源、關店照打、冗餘 | — |
| **B** 兼任（**推薦**） | **刪獨立心跳迴圈**，靠本來就要打嘅 `claim`（60s）蓋章 | 零新基建、零 APK 風險（只刪一個 loop） | 在線精度 30s→60s | **−100% 心跳請求**（13% → 0） |
| C 伺服器建議值 | 回應帶 `nextPollMs`（**已上線**），APK 跟住 | 可遠端調參 | 仍係推送式、仍關店照打 | −50% |
| D Realtime 在線 | APK 開 WS，斷線即知 | 即時、零輪詢 | APK 改動大；WS 靜默失效有前科 | −100% 但風險高 |
| E Server 主動探測 | ❌ 唔可行 | — | APK 喺 NAT 後，打唔入 | — |

**推薦：B（＋保留 C 作為遠端調節旋鈕）**
- `last_seen_at` **只用於顯示**，而 UI 嘅「疑似離線」門檻係 **5 分鐘**（`print-center.tsx`）
  ⇒ 60 秒精度**遠遠夠**。
- 順帶要修：`print-center` 嘅門檻唔應該寫死，應由常數推導（本專案已有「改咗間隔但文案寫死」前科）。
- 交 Ledger 同事：見 `docs/integration/apk-optimization-handover-2026-09-21.md` §A-1／§A-3。

### 2.5 取捨

| 選擇 | 好 | 壞 |
|---|---|---|
| idle 30 分鐘就停輪詢 | 省最多 | 靜市時萬一 WS 靜默失效，最多 10 分鐘（兜底）先發現新單 |
| idle 唔停、只放慢 | 風險最低 | 掛機仍然燒（但比 4.5 秒循環好得多） |
| ⇒ 建議 | **停 + 10 分鐘兜底 + 手勢即時喚醒** | 呢個組合令「靜態成本」由 15.2 次/分鐘 → **< 1 次/分鐘**，而「有單要即時見」嘅保證完全由 Realtime 保留 |

---

## 3. 問題三：關店後「一次性對數」

### 3.1 操作範圍界定（明確）

| 允許 ✅ | 禁止 ❌ |
|---|---|
| 進入報表頁（`/reports`）／交班頁（`/shift`） | 任何寫入（開枱／加菜／結帳／改價） |
| **撳一次「查詢／更新」→ 打一次 API** | `setInterval` 自動刷新 |
| 由**使用者手勢**觸發（`pointerdown` / 入頁 navigation） | `visibilitychange` / `focus` 自動觸發 |
| 列印／匯出／補打帳單 | 全量 state 拉取（`/api/pos/state` 非 ordersOnly） |
| 睇單、睇枱 | 任何背景輪詢 |

### 3.2 判斷條件（機器可判定）

```
允許一次查詢 ⇔  (1) HTTP method 係 GET
                 AND (2) 端點屬「讀取白名單」（/api/pos/state?ordersOnly=1、/api/admin/orders、報表相關）
                 AND (3) 由使用者手勢觸發（帶 `x-pos-state-src: manual` 之類標記）
                 AND (4) 同一分頁同一種報表，每個「對數 session」最多 3 次
                 AND (5) 兩次之間最少隔 5 秒（防連點）

唔允許 ⇔ 由計時器 / visibilitychange / focus / realtime 觸發嘅任何呼叫
```

> 💡 條件 (3) 唔需要新基建：**本輪已經加咗 `x-pos-state-src` 標頭**（待部署），
> 只要多加一個 `manual` 值，server 就分得出「手勢觸發」同「自動輪詢」。

### 3.3 落點

| 改動 | 檔案 |
|---|---|
| 報表自動刷新喺關店後停 | `src/components/restaurant-daily-report.tsx:895-899`（`AUTO_REFRESH_INTERVAL_MS` timer 加 `storeOpen !== false` 條件） |
| 交班頁自動刷新同理 | `src/components/shift-page.tsx:431-468`（已有入頁／focus／網絡恢復觸發 → 關店後只保留入頁同手動） |
| 手勢喚醒 | `activity-tracker`（同 §2.3 共用） |
| 次數上限 | `poll-gate.ts`（同一真源，唔另立一套） |

### 3.4 取捨

- **好**：完全符合你嘅要求（可以對數、但唔會持續打）；亦順手解決報表頁 10 分鐘一次嘅背景成本。
- **壞**：關店後報表數字**唔會自動更新** —— 老闆要自己撳一下。
  ⇒ 建議 UI 加一句「已關店：自動更新已停用，撳『更新』睇最新」（同本專案「改常數要改文案」嘅紀律一致）。
- **風險**：低。報表本身**冇寫入**，而且手動路徑完全保留。

---

## 4. 實作分期（建議）

| 期 | 內容 | 風險 | 前置 |
|---|---|---|---|
| **P0** | 部署已寫好嘅 `x-pos-state-src` ＋ 舊版 bundle 偵測 | 零（只加 log） | 無 |
| **P1** | `poll-gate.ts` ＋ `activity-tracker.ts`（純決策＋單測）＋ 只套用到**純顯示**項（`topup` badge、`pos/shift` 180s、報表自動刷新） | 低 | 定 §3.1 清單 |
| **P2** | G1：server 寫入閘擴展到 `authorized`（逐 event type，見 §1.2）＋ G2／G3 | **中高**（會改變收銀台行為） | 你確認 §1.2 清單 |
| **P3** | APK：刪獨立心跳（方案 B） | 低（Ledger 側） | 交 Ledger 同事 |
| **P4** | `pos_shifts` 加 Realtime 訂閱（令跨機交班可以即時知，P1 就可以停得更徹底） | 低 | 無 |

---

## 5. 待你拍板嘅 5 條

| # | 問題 | 我嘅建議 |
|---|---|---|
| 1 | 店已關時，`ORDER_SETTLED`（結帳）准唔准？ | **准** —— 客人走唔到比「收到單」嚴重 |
| 2 | 店已關時加菜（`ORDER_UPDATED` 帶 `addedItems`）准唔准？ | **唔准**（加菜＝新生意）；舊 client 冇帶 `addedItems` ⇒ fail-open |
| 3 | 逃生門要唔要？ | **要**，但只可以經「重新開工」呢個有記錄嘅動作 |
| 4 | idle 門檻 | 收銀台 **30 分鐘**；已關店／已交班 **5 分鐘**；兜底慢輪詢 **10 分鐘** |
| 5 | 關店後一次性查詢上限 | ~~同一報表每 session 3 次、最小間隔 5 秒~~ → **J 拍板：唔需要次數上限**，「入到報表就 call 一次」 |

---

# 6. 拍板結果與實作（2026-09-21 23:30）

## 6.1 J 嘅答覆

| # | 答覆 | 落實 |
|---|---|---|
| 1 | 關店時**結帳准** | `write-gate.ts`：`ORDER_SETTLED` 一律放行（有單測） |
| 2 | 關店時**加菜不准** | `ORDER_UPDATED` **帶 `addedItems`** → 拒（舊 client 冇帶 → fail-open） |
| 3 | 逃生門**可以** | 逃生門＝「重新開工」；文件 + 拒收文案都指向呢一步 |
| 4 | idle **5 分鐘** | `POLL_IDLE_MS = 5 * 60_000` |
| 5 | **唔需要**次數上限 | 只保留「關店後停自動刷新」；入頁／手動照打 |

## 6.2 更根本嘅一句：**唔應該不停 polling**

> J：「不應該不停的 polling，這個完全錯。我明白打印機和中繼有可能需要，但我相信有更好的方法。」

**你嘅判斷係對嘅，而且「更好嘅方法」你嘅系統已經有 8 成 —— 唔需要新基建。**

| 對象 | 已有嘅 push | 實作位置 |
|---|---|---|
| POS 網頁 | Realtime 4 條 channel：`pos_orders` / `pos_print_jobs` / `pos_soldout` / `pos_store_status` | `use-pos-realtime.ts`、`use-store-status.ts:184-207` |
| **打印中繼 APK** | `PosRealtimeSubscriber.kt`：訂 `pos_print_jobs` **INSERT**（filter `store_id`）→ `onWake()` → `PosJobRunner.onRealtimeWake()` → claim → 出紙 | `_ref-macau-ledger-merchant/…/posrelay/PosRealtimeSubscriber.kt:84-120` |

⇒ **中繼機嘅 `claim`（每 60 秒）同 `heartbeat`（每 30 秒）本來就係「兜底」，唔係主力。**
問題只係兜底跑到太密。

### 實作：`poll-gate.ts` 由「idle 閘」升級成「push 優先閘」

```
Realtime 通   → 兜底最短間隔 = 5 分鐘（POLL_INTERVAL_PUSHED_MS）
Realtime 唔通 → 回落現行節奏 = 60 秒（POLL_INTERVAL_DEGRADED_MS）
Realtime 未知 → 當「唔通」（fail-open，唔會因為未知而少拉）
```

🔴 **為何唔可以真係「零輪詢」**：本專案有「Realtime **靜默失效**」前科 ——
`use-store-status.ts:38-43` 明確記錄：訂錯 Supabase 專案會照樣 `SUBSCRIBED` 但
**永遠收唔到事件**，而且 Supabase 唔會報錯。零輪詢＝將「全日收唔到單」呢個
災難級風險押上。5 分鐘兜底將最壞情況由「全日」壓到「5 分鐘」。
要真零輪詢：把 `POLL_INTERVAL_PUSHED_MS` 設成 `Infinity`（一行）。

### APK 側建議（交 Ledger 同事）

| 常數 | 而家 | 建議 | 理由 |
|---|---|---|---|
| `HEARTBEAT_MS` | 30_000 | **整個心跳迴圈刪除** | 唯一效果係蓋 `last_seen_at`，而 `claim`（本身就要打）已經蓋同一個欄；送嘅 `ipAddress(s)` server 從未讀過 |
| `TICK_MS`（claim）| 60_000 | **300_000** | 已有 `PosRealtimeSubscriber` 即時叫醒；60 秒係兜底，唔需要咁密 |
| `DEVICE_CONFIG_EVERY_TICKS` | 5（300s） | 維持 | 打印機改 IP 後生效延遲嘅上界 |

預期：中繼機 **3.0 次/分鐘 → 0.2 次/分鐘（−93%）**。

## 6.3 已實作清單（2026-09-21，全部有單測）

| 檔案 | 內容 |
|---|---|
| 🆕 `src/lib/pos/poll-gate.ts` | 純決策（零 import）：session／可見／idle／營業／班次／push 間隔／`urgent`／`kind` |
| 🆕 `src/lib/pos/poll-gate.test.ts` | 24 條（含兩方向守護 + 邊界 + 時鐘倒退） |
| 🆕 `src/lib/pos/activity-tracker.ts` | 真人互動追蹤（module singleton、單一 listener、refCount、零網絡） |
| 🆕 `src/lib/pos/poll-gate-client.ts` | 執行層（讀 session／store／shift／pending／realtime → 餵純函式）；`subscribeIdleRecovery()` |
| 🆕 `src/lib/pos/write-gate.ts` | 純決策（零 import）：只擋「開新生意」、`ledger-` 鏡像放行 |
| 🆕 `src/lib/pos/write-gate.test.ts` | 15 條（含「結帳一定要准」「線上鏡像一定要准」） |
| ✅ `src/app/api/pos/sync/route.ts` | 兩道閘由「只查匿名」擴展到「含 ORDER 寫入事件就查」＋ 授權通道寫入閘 |
| 🆕 `sync-route-write-gate.test.ts` | 5 條 source 掃描（守住唔會改返 `!authorized`、守住 `ledger-` 放行） |
| ✅ `pos-app.tsx` | 180s tick 加閘；mount backfill 用 `kind:"triggered"`；`onStatusChange` 報告 realtime 健康（**同時驗 `source === "pos"`**） |
| ✅ `pending-count-store.ts` | 紅點輪詢加閘 |
| ✅ `restaurant-daily-report.tsx` | 自動刷新加閘（關店／收工／閒置就停，入頁同手動照打） |
| ✅ `use-store-status.ts` / `use-merchant-order-config.ts` | 加唯讀 snapshot getter（純讀，唔發請求） |

### 為何 `kind: "triggered"` 係必須（唔可以一刀切）

mount backfill、realtime 重連補拉、手勢 —— 呢啲係**事件驅動**，自帶頻率上界。
如果用週期閘去擋，會出現「**未開工嘅收銀台連今日訂單都拉唔到**」呢種嚴重倒退。
所以閘門分 `periodic`（受全部限制）同 `triggered`（只受「冇 session」「分頁隱藏」限制）。

## 6.4 驗證

```
tsc --noEmit                                    → 0 error
node --test "src/**/*.test.ts"                  → 1014 pass / 0 fail（972 → 1014）
tools/verify-pos-flows-live.cjs                 → 17/17 路由、0 問題、0 pageError
tools/verify-pos-api-contract.cjs               → 12/12 通過
```

## 6.5 未做（下一輪）

| 項 | 內容 | 為何未做 |
|---|---|---|
| G2／G3 | client 收到 `store-closed` / `shift-closed` 時**即刻**更正本地狀態 + 出提示 | 要改 pos-app 嘅同步失敗處理（會動到 UI），值得獨立一輪 |
| `pos_shifts` Realtime | 令跨機「開工」可以即時知（今日靠 180s 同步） | 低風險但要新 channel |
| 報表頁「自動更新已停用」文案 | 同常數一致（本專案紀律：改常數要改文案） | 等 G2 一齊做 |
| APK `TICK_MS` / 刪心跳 | 交 Ledger 同事 | 見 §6.2 |
