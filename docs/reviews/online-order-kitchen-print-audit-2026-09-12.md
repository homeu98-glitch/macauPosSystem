# 線上訂單「顧客已付款、廚房冇出單」排查報告

- 日期：2026-09-12
- 症狀（用戶實案）：顧客完成下單並付款後，廚房端**冇收到任何廚房單**（打印中心亦冇該張廚房 job）。
- 現場證據（兩張截圖）：
  1. 打印中心（今天）**只有一張 job**：訂單號 `001`、餐台 `堂食`、打印機 `小票機：通用 80mm`、票種 `正常`、時間 `12/09 11:55`、狀態 **打印成功**。→ **冇任何 zone/label（廚房/標籤）job**。
  2. 訂單頁：線上訂單 `取餐號 001`、堂食、`12/09 11:03`、`MOP 38`、**已完成**、**已支付（餘額扣點）**；下面店內線下訂單 `訂單01`、澳真3、`12/09 10:06`、`MOP 103`、已完成、商家下單 —— 該單同樣**冇廚房 job**。

## 0. 先講最關鍵嘅一個推論

**「小票機打印成功」呢件事本身就排除咗一大半嫌疑。**

出紙真通道係「本機入隊 → `PRINT_JOB_CREATED` 經 `/api/pos/sync` 寫雲端 `pos_print_jobs` → 中繼 APK claim → 出紙」。
`打印成功` 係雲端回寫嘅**終態**（`print-center.tsx` 嘅 `syncCloudPrintOutcomes()`），即代表：

- 本機 → 雲端 → APK → 實體出紙**整條鏈路都通**；
- 所以問題唔在 relay / APK / 雲端權限 / 同步隊列；

**問題在更上游：該張廚房單由頭到尾冇被建立（`buildPrintJobs*()` 回空或拋錯）。**
報告因此集中查「為咩冇 job 產生」同「為咩冇補印」。

---

## 1. 完整鏈路（附代碼位置）

```
① 顧客落單＋付款（Ledger 端，POS 唔參與）
      ↓  Realtime：public.orders  filter merchant_id=eq.<id>
      └─ src/lib/ledger/use-ledger-orders-realtime.ts:48-84   ← 需要 Ledger session
② POS 收到單
      ├─ /orders 頁      → online-orders.tsx:344 handleInsert / :362 handleUpdate
      └─ 快餐模式 POS 內嵌 → quick-online-orders-panel.tsx:189 handleInsert / :204 handleUpdate
③ 接單（本機或另一部機 / 自動接單）
      └─ runAcceptAndBridge  online-orders.tsx:442
         runAccept           quick-online-orders-panel.tsx:302
         → acceptLedgerOrder src/lib/ledger/order-actions.ts:123   （餘額已付 → 純 update_order_status('accepted')）
④ 產生廚房單
      └─ bridgeLedgerOrderToPos  src/lib/ledger/ledger-pos-bridge.ts:401
         └─ buildPrintJobsForItems  ledger-pos-bridge.ts:174      ← ★ 三個「靜默回空」閘門＋一個 throw 都在此
⑤ 落本機＋推上雲（缺一不可）
      └─ appendPrintJobsWithSync  src/lib/pos/print-job-enqueue.ts:99
⑥ 本機 flush / 雲端 claim 出紙
      └─ print-bridge/dispatch.ts:46 (status===pending) → hub.ts resolveJobPrinter → relay
⑦ 兜底補印（只喺 /orders 頁有）
      └─ ensureKitchenPrintForAccepted  online-orders.tsx:227（掃描 :432-440）
```

---

## 2. 斷點清單（按可能性排序）

### 🔴 P0-1 呢部機冇「廚房/分區（zone）」或「標籤（label）」打印機 → 廚房單永遠唔會產生

- 線上單路徑：`ledger-pos-bridge.ts:199-213` —— 只取 `loadDeviceConfig().printers` 中 `enabled && (role==="zone"||role==="label")`；**一個都冇而且有菜品 → 直接 `throw`**
  > `未配任何已啟用嘅廚房/標籤打印機（zone/label role），無法產生廚房單。請去「設置 → 打印機綁定」添加廚房打印機。`
- 本地落單路徑：`print-jobs.ts:201-204` —— 同條件下係**靜默 `return []`**（唔 throw）。
- 兩者共同結果：**打印中心一張廚房 job 都冇**，同截圖完全吻合。
- 反證：`小票機`（role=receipt）成功打印 → 唔係通道問題，係「冇廚房機」。
- **注意**：若真係咁，商家落本地單時應該見過黃色警告（`pos-app.tsx:3415-3423`「未配置廚房（分區/標籤）打印機…」）；若從未見過，就要轉去查 P0-2 / P0-3。

### 🔴 P0-2 三個細粒度開關其中一個被關 → 靜默回空（連 toast 都冇）

`ledger-pos-bridge.ts`：

| 行 | 閘門 | 效果 |
|---|---|---|
| `:186` | `isPrintContentEnabled("online")` | 熄 → `return []`（**完全靜默**，設計如此） |
| `:190-192` | `kitchen` 且 `label` 都熄 | 熄 → `return []` |

- 「線上訂單」（`printContentToggles.online`）係 **2026-09-11 新增**嘅**訂單來源**維度開關（`device-settings.tsx:3965`）。設定說明本身就寫住「若 Sunmi 系統本身已經會印線上單，可熄呢個掣避免重複出紙」→ **呢個掣係最容易被商家或前一位工程師「順手熄咗」嘅一個**，而且熄咗之後廚房單係「安靜地永遠唔出」。
- 默認值全部 true（`storage.ts:404-415` 白名單齊全，唔存在「升級被剷走」問題），所以一旦係 false，就係**人手熄過**。
- **呢個係本案例最可疑嘅一點**：現象係「線上單冇廚房單」，而本地單同樣冇 —— 若 `kitchen` 開關本身被關（或冇 zone 機），兩者一齊死，完全一致。

### 🔴 P0-3 POS 錯過「接單窗口」→ 根本冇機會出單（連補印都唔會做）

呢個係**真·架構缺口**，唔係設定問題：

1. **快餐模式面板冇補印兜底。**
   `quick-online-orders-panel.tsx:189-249` 嘅 `handleInsert` / `handleUpdate` **冇** `ensureKitchenPrintForAccepted`；相比之下 `online-orders.tsx:357` 同 `:411` 兩個 handler 都有。
   → 快餐模式（POS 主介面內嵌嗰個面板）只要「接單唔係由呢部機做」，就**永遠唔會有廚房單**。

2. **兜底窗口太窄。**
   `ensureKitchenPrintForAccepted`（`online-orders.tsx:229-230`）只認 `accepted` / `preparing`：
   ```ts
   const raw = rawLedgerStatus(order.status);
   if (raw !== "accepted" && raw !== "preparing") return;   // ← completed / ready 直接放棄
   ```
   若 POS 離線、Realtime 斷線、或頁面冇開，等佢再見到張單時已經係 `completed`（快餐單流程好短），**就永遠唔補印**。

3. **Realtime 靠 Ledger session，攞唔到 token 時完全靜默。**
   `use-ledger-orders-realtime.ts:48-56`：`ensureLedgerSession()` 返唔到 access token → 只係 `onStatusChange("WAITING_FOR_SESSION")` + 每 1.5s 重試，**UI 零警示**。收銀台會「以為連住」，但新單永遠唔會推入嚟。

4. **時間線旁證（需核實）**：訂單 `11:03` 建立、但收據 `11:55` 先打印。`printReceiptForLedgerOrderOnce` 係由 `completed + paid` 轉換觸發（`online-orders.tsx:397-407`）。
   52 分鐘嘅落差，最合理嘅解釋係**POS 當時唔在 realtime 上**，係後來（手動刷新 / resubscribe backfill）先「見到」呢張已經完成嘅單 → 只印收據、唔補廚房單。
   👉 核實方法：睇 Ledger `orders` 表嘅 `accepted_at / completed_at / updated_at` 時間戳，同 POS 收據 job 嘅 `created_at` 對比。

### 🟠 P1-1 自動接單會靜默吞掉出單錯誤（假成功）

`quick-online-orders-panel.tsx:322-328`：
```ts
try { kitchenJobCount = (await printKitchenForLedgerOrder(order, detail)).length; }
catch { if (!options?.silent) onToast({...}); }     // ← auto-accept 傳 silent:true
```
而 auto-accept 用 `{ silent: true, autoStartPreparing: true }`（`:372`），成功後照彈
`已自動接單：xxx`（`:375`）→ **出單拋錯完全冇提示，收銀員只見到「已自動接單」**，就會完全符合「顧客落咗單、付咗款，廚房乜都冇」嘅描述。
（`online-orders.tsx:470-489` 已經改成「error toast + `return false`」，快餐面板未跟。）

### 🟠 P1-2 線上單嘅廚房 job 冇 `content` / `template` 快照

`ledger-pos-bridge.ts:216-228` 嘅 `makeJob()` 只有 `items / printerId / status`；
而 `print-jobs.ts:232-247` 本地同類 job 一定帶 `content`（ESC/POS 行）＋ `template`（模板＋欄寬快照，58/80mm）。
後果：`dispatch.ts:53-55` 會 warn「冇 template 快照，將用通道 fallback 渲染」——即**依賴 APK 端 fallback**。
唔係「印唔出」嘅必然原因，但一旦 APK 版本 fallback 覆蓋唔到，就會出「job 存在但印空白 / 同設計唔一致」。

### 🟡 P2 `buildPrintJobsForItems` 唔合併 kiosk 打印機（寫法唔一致）

`hub.ts:63-67` 嘅 `resolveJobPrinter()` 已經 `[...deviceConfig.printers, ...loadKioskPrinters()]`（docs/87 §6.2）；`companion.ts:665-667` 同 `ledger-pos-bridge.ts:194` 兩處仍然只讀 `deviceConfig`。
目前 kiosk 機鎖死 `role="receipt"`，所以未直接致命；但**同一類「只讀 deviceConfig」嘅寫法就係曆次靜默唔出紙嘅根源**，建議一併收斂。

---

## 3. 三分鐘自查（照順序做，第二步就能定案）

| # | 動作 | 判讀 |
|---|---|---|
| 1 | 設備設置 → **打印開關設置** | `廚房單`、`飲品標籤單`、`線上訂單` **三個都要開**。任何一個關 = P0-2 定案 |
| 2 | 設備設置 → **打印機綁定** | 至少一台 `role = 廚房（分區）/標籤` 且**已啟用**。「只有小票機」= P0-1 定案 |
| 3 | 打印中心 → 隨便揀一張今日訂單撳 **「重打整單」** | 彈「未配置廚房（分區/標籤）打印機」→ P0-1；彈「菜品分區對唔中打印機」→ 分區設定；**成功入隊** → config OK，係 P0-3 時序問題（`pos-app.tsx:3104-3112` / `:3415-3423`） |
| 4 | POS 瀏覽器 Console 貼 `tools/2026-09-12-diagnose-kitchen-print.js` | 一次列出 toggles / printers roles / 今日 job 分佈 / 未上雲事件數 |
| 5 | Supabase（POS 專案） | `select id, order_id, printer_group, status, created_at from pos_print_jobs where created_at > now() - interval '1 day' order by created_at desc;` → 有冇 `printer_group <> 'receipt'` 嘅行 |
| 6 | Ledger `orders` 表 | 睇該單 `status / payment_status / accepted_at / completed_at / updated_at` 時間線，對比 POS 收據 job 時間 → 判斷 POS 係幾時先「見到」張單 |

---

## 4. 修復建議

### A. 立刻可做（零風險，先讓故障可見）
1. **拔掉「靜默」**：`ledger-pos-bridge.ts:186/192` 嘅 `return []` 改為回傳帶 `reason` 嘅結果（或至少 `console.warn` 一次），並喺接單 UI 顯示「按打印設定未出廚房單（線上訂單開關已關）」。
   —— 現時 `online-orders.tsx:501-503` 已有文案，但**快餐面板冇**。
2. **auto-accept 唔可以吞 print 錯誤**：`quick-online-orders-panel.tsx:324-328` 嘅 `catch` 至少 `console.error` + 一次性 error toast（同 `online-orders.tsx:470-489` 對齊）。

### B. 補結構缺口（核心修復）
3. **快餐模式面板加兜底**：將 `ensureKitchenPrintForAccepted`（`online-orders.tsx:227-259`）抽成共用 hook / 純函式，`quick-online-orders-panel.tsx` 嘅 `handleInsert` / `handleUpdate` 一齊掛上。
4. **擴闊兜底窗口**：`ensureKitchenPrintForAccepted` 由「只認 accepted/preparing」擴到
   **「本機冇該單嘅廚房 job 且狀態非 cancelled」**（含 `ready` / `completed`），
   配「本機一次性簽名集合」做冪等（避免重複補印），即「本機見過一次 → 一定補一次」。
5. **Realtime 健康可見化**：`use-ledger-orders-realtime.ts` 嘅 `WAITING_FOR_SESSION / CHANNEL_ERROR / TIMED_OUT` 要有 UI 警示（現時只寫入 state / console）。

### C. 一致性收尾
6. **Ledger 廚房 job 補齊 `content` + `template`**：用 `escpos-template` 嘅 `buildKitchenContent()` + `buildSnapshot("kitchen", …, paperColumnsFromSize(printer.paperSize))`，同 `print-jobs.ts:220-247` 對齊，唔好再靠 APK fallback。
7. **收斂 `resolveJobPrinter` 寫法**：`companion.ts:665` 亦合併 `loadKioskPrinters()`（同 `hub.ts:63` 一致）。
8. （可選，長期）打印中心加「**打印設定自檢**」面板：一鍵列出 toggles、printer roles、最近 24h job 分佈、未上雲事件數 —— 呢類事故以後 10 秒可定位。

---

## 5. 一句總結

> 出紙通道係好嘅（小票機印得成功），死因**唔係 relay，係廚房 job 由頭到尾冇被建立**：
> **（最可能）`線上訂單` / `廚房單` 開關被關，或本機冇 zone/label 打印機（P0-1/P0-2）；
> 其次係 POS 錯過接單窗口而兜底窗口太窄 + 快餐面板完全冇兜底（P0-3）。**

---

## 附錄：相關代碼位置一覽

| 主題 | 位置 |
|---|---|
| 出紙通道（本機→雲端→APK） | `src/lib/pos/print-job-enqueue.ts:1-32, 99-104` |
| 線上單廚房單 builder（3 閘門 + 1 throw） | `src/lib/ledger/ledger-pos-bridge.ts:174-265` |
| 本地廚房單 builder（靜默回空） | `src/lib/print-jobs.ts:199-204, 232-247` |
| 接單 + 出單 | `src/components/online-orders.tsx:442-512` / `quick-online-orders-panel.tsx:302-358` |
| 補印兜底（只喺 /orders 有） | `src/components/online-orders.tsx:227-259, 432-440` |
| 收據（completed+paid 觸發） | `src/components/online-orders.tsx:397-407`；`print-jobs.ts:547-553` |
| 開關白名單 | `src/lib/storage.ts:404-415`；UI `device-settings.tsx:3953-3995` |
| 無廚房機診斷文案 | `src/components/pos-app.tsx:3104-3112, 3415-3423` |
| 線上單 Realtime | `src/lib/ledger/use-ledger-orders-realtime.ts:48-84` |
| 打印機解析（兩份唔一致） | `src/lib/print-bridge/hub.ts:63-84` vs `companion.ts:665-683` |

---

# 專項複查：自動接單路徑（2026-09-12 第二輪）

用戶補充：**「系統自動接單成功後，冇打印動作，打印佇列／打印紀錄都冇任何 job；之前版本印得到，現在唔得。」**
下面係針對自動接單嘅逐環追查結果。

## A. 自動接單實際行邊段代碼

POS **主介面兩處**都係用 `quick-online-orders-panel.tsx`（**唔係** `/orders` 頁嗰個 `online-orders.tsx`）：

| 場景 | 入口 | 參數 |
|---|---|---|
| 快餐模式（快捷 bar） | `quick-mode-orders-bar.tsx:89-96` | `autoAccept` ＋ `skipTableAssignment` |
| 堂食模式（快捷操作面板） | `pos-app.tsx:4589-4601` | `autoAccept` ＋ `skipTableAssignment` |
| 訂單頁（`/orders`） | `orders-hub.tsx:71` → `online-orders.tsx:514-536` | **唔會**接 `dine_in` |

自動接單執行序（`quick-online-orders-panel.tsx:360-382`）：

```
autoAccept && !loading
 → 篩 rawLedgerStatus === "pending" && !processing
 → runAccept(order, { silent: true, autoStartPreparing: true })   ← ★ silent
     ├ acceptLedgerOrder()                        order-actions.ts:123  ✅ 成功
     ├ getOrderDetail(order.id)                   orders.ts:105  ⚠️ 拋錯＝整個接單報「接單失敗」
     ├ printKitchenForLedgerOrder(order, detail)  ledger-pos-bridge.ts:294
     │    └ buildPrintJobsForItems()              ledger-pos-bridge.ts:174
     │         if (!isPrintContentEnabled("online")) return [];        :186   ← 🔴 靜默
     │         kitchen/label 兩個都熄 → return []                       :190-192
     │         冇 enabled zone/label 機 → throw                        :204-213  ← 被 catch 吞
     │    └ appendPrintJobsWithSync()             print-job-enqueue.ts:99   ✅ 有 job 才會有
     └ catch { if (!options?.silent) toast }      :324-328              ← 🔴 silent 時全吞
```

## B. 為何「冇 job」而「完全冇提示」（四層靜默）

1. `ledger-pos-bridge.ts:186` —— 開關熄 → `return []`（設計如此，**唔可以**彈 toast）。
2. `quick-online-orders-panel.tsx:324-328` —— 自動接單 `silent: true` → 拋錯**被吞**。
3. `quick-online-orders-panel.tsx:337-347` —— 成功 toast 喺 `autoStartPreparing` 分支**寫死**
   「已接單並開始製作」，**完全忽略 `kitchenJobCount`** →
   明明 0 張 job 都照講成功。（「按打印設定未出廚房單」嗰句只在**人手**接單（無 `autoStartPreparing`）才出得嚟。）
4. `pos-app.tsx:4594-4599` —— 面板 `onToast` 把 `tone: "error"` **降級成 `info`** → 就算有失敗提示都會被淡化。

## C. 「之前得、現在唔得」——唯一對得上的代碼變更

```
git log -S 'isPrintContentEnabled("online")' --oneline
  → 1e08343 update  (2026-09-11 15:07)   ← 就係呢次加入「線上訂單」閘門
git log -S 'configuredPrinters' --oneline -- src/lib/ledger/ledger-pos-bridge.ts
  → f1fd4d4   (更早，之後冇再郁過)
```

即 `buildPrintJobsForItems()` 內**除咗呢個閘門之外**（printer 解析、分區兜底、無機 throw）
由 `f1fd4d4` 之後**從未改動**。
⇒ 能夠令「有 job → 冇 job」而**完全冇錯誤**嘅，**只有** `printContentToggles.online === false`。

`readToggle(v, true)`（`storage.ts:492`）：只有**顯式 `false`** 才關，舊 localStorage 缺欄＝開。
⇒ 一旦係 `false`，一定係**人手熄過**（設備設置 → 打印開關設置 → 「線上訂單」），
例如跟住嗰句說明「Sunmi 已印可熄」去熄咗，或者被「一鍵全關」連累
（✅ 已核實：`pos-app.tsx:3269-3278` 嘅一鍵全關**只**寫 kitchen/label/receipt，**冇**寫 online）。

## D. 另一個獨立成因（同樣會「零 job、零提示」）

**接單唔係由呢部機做**：若張單已經由另一部機／外部（Sunmi／Ledger 側）接咗，
POS 收到嘅已經係 `accepted`／`completed` → 本機 auto-accept（只認 `pending`）**唔會跑**；
而 `quick-online-orders-panel.tsx` **冇** `ensureKitchenPrintForAccepted` 補印兜底
（只有 `/orders` 頁 `online-orders.tsx:357/:411` 有）→ **永久零 job、零提示**。

## E. 需要確認嘅環節（按能定案嘅速度排序）

| # | 確認乜 | 判讀 |
|---|---|---|
| 1 | 設備設置 → 打印開關設置：**「線上訂單」是否開啟**（順便睇「廚房單」「飲品標籤單」） | 一熄 = C 定案（唯一「由有變冇」嘅閘門） |
| 2 | 設備設置 → 打印機綁定：有冇 enabled 嘅 `zone`／`label` 機 | 冇 = 每次接單都 throw（被 silent 吞） |
| 3 | POS Console 貼 `tools/2026-09-12-diagnose-kitchen-print.js` | 直接讀出 toggles／printers／今日 job 分佈／未上雲事件數 |
| 4 | **人手**接一張新嘅 pending 線上單（唔靠自動） | 人手＝非 silent，必定出 toast：<br>「已接單，但廚房單送出失敗…」→ throw（打印機問題）<br>「已接單（按打印設定未出廚房單）」→ 回空（開關問題）<br>「已接單並已送廚」→ 正常 |
| 5 | Supabase（POS 專案）`pos_print_jobs` 近 24h | 有冇 `printer_group <> 'receipt'` 嘅行；完全冇＝job 從未建立（唔係 relay 問題） |
| 6 | Ledger `orders`：`accepted_at / updated_at` vs POS 收到通知嘅時間 | 判斷係「本機接單」定「外部先接（→ D）」 |
| 7 | 對照 `/orders` 頁 | 若 `/orders` 會補印、POS 主介面唔會 → 證實快餐面板缺兜底（D） |

## F. 建議修復（待批准，未改代碼）

**第一層：即時可見性（低風險，唔改變出紙行為）**
1. 自動接單成功 toast 要帶 `kitchenJobCount`（0 張就講「按打印設定未出廚房單」），
   唔可以喺 `autoStartPreparing` 分支寫死「已接單並開始製作」。
2. 自動接單嘅 `catch` 唔可以全吞：至少 `console.error` ＋一次性 error toast。
3. `pos-app.tsx:4594-4599` 嘅 `onToast` 唔好把 `error` 降級成 `info`。

**第二層：結構（真正修好）**
4. `quick-online-orders-panel.tsx` 加 `ensureKitchenPrintForAccepted` 補印兜底（同 `online-orders.tsx` 一致，抽共用 hook）。
5. 兜底窗口由「只認 `accepted`/`preparing`」擴到「本機冇該單廚房 job 且非 `cancelled`」，配本機簽名冪等。
6. `ledger-pos-bridge.ts:186/192` 回空時記錄原因（例如 `console.warn` 一次），令設定型故障下次可自證。

---

# 現場實測複查（2026-09-12 14:03 · 三症狀）

用戶自測兩張單：**堂食（002）** 與 **外賣自取（003）**，出現三種唔同異常。以下係逐項對照實拍證據嘅結論。

## 症狀 1：堂食單（002）零 print job —— 已定位

**實拍**：訂單頁 002：堂食、13:49、MOP 1、**未支付（到店付款）**、**已取消**。

**關鍵推論（可驗證）**：`online-order-actions.ts:113-118` —— 「拒單」**只喺 `pending` 出現**；
而訂單一旦 `accepted`，secondary actions 係空，**冇任何取消掣**（只能一路 開始製作→待取餐→完成，或「標記已收款」）。
⇒ 002 能夠變成 `cancelled`，代表佢**由頭到尾停留在 `pending`，從來冇被接單**。

**根因**：`online-orders.tsx:517-521`（訂單頁嘅自動接單）**明文排除堂食**：

```ts
const pending = orders.filter((order) =>
  rawLedgerStatus(order.status) === "pending" &&
  order.tabType !== "dine_in" &&          // ← 堂食線上單永遠唔會自動接單
  !autoAcceptProcessingRef.current.has(order.id));
```

對照：POS 主介面嘅 `quick-online-orders-panel.tsx:363-368` **冇**呢個排除（`skipTableAssignment = true`）。
所以「堂食線上單有冇被自動接單」**取決於當時開住邊一頁**：
訂單頁 → 唔接（→ 零 job，本案例）；點餐介面 → 會接。

而外賣自取（pickup）唔受此限 → 13:51 自動接單成功 → 有 job（見症狀 2），完全吻合。

**點解要排除**：堂食要揀桌台，而 `acceptLedgerOrder()` **唔收桌台參數**
（`pos-app.tsx:4582-4584` 明文註釋：嗰兩個 option 由頭到尾冇用過）→ 開咗反而令收銀以為安排咗枱。

## 症狀 2：外賣自取（003）job 卡「已發送」—— 已鎖定範圍

**實拍**：打印中心 `003 · 自取 · printer · kitchen · 正常 · 13:51 · 已發送`（綠色）；
同頁其他 job（訂單02～05，12:46–13:40）全部 **打印成功**。
job 內容預覽正常（`*** 廚房 *** / 門店 / 003 / 自取 / 1. 盒 x1`）。

**「已發送」係樂觀值，唔代表雲端有行**（`relay-transport.ts:25-34`）：

```ts
async send(...) {
  try { await flushPosSyncQueue({ silent: true }); } catch { /* 靜默 */ }
  return { ok: true };          // ← 唔理 flush 成唔成功都回 ok
}
```
`dispatch.ts:66-72`：`result.ok` → 本機 job 即刻標 `"sent"`（＝「已發送」）。
而 `print-center.tsx:966-981` 只會**向上**覆寫（雲端 printed/failed → 本地），
本地有、雲端冇 → `cloudById.get(id) === undefined` → **永遠停留「已發送」，唔會自我修正**。

⇒ 卡住嘅唯一解釋係：**雲端 `pos_print_jobs` 冇呢行（或一直非終態）→ 中繼 APK claim 唔到**。

**為何冇上雲（三個候選，靠下面第 3–5 項定案）**：
1. **網絡／憑證**：image 5 實拍到 pos-app 快捷操作面板顯示 **`TypeError: Load failed`**
   （`quick-online-orders-panel.tsx:700-702` 直接 render raw error）。呢個係 WebKit 嘅 fetch 失敗字串
   → 該部機當時對外請求有問題。`/api/pos/sync` 亦會一齊死。
2. **queue 事件被判死**：`queue-outbox.ts:111-124` `classifyQueueEvent()` ——
   `storeId` 唔等於當前店 → 標 `skipped`（`no-store` / `foreign-store`）→ **永遠唔會再推**。
3. **401（終端憑證）**：`posDeviceToken` TTL 12 小時（docs/113 §401 一節）→ 「讀得到、存唔到」；
   快餐機開過夜必爆。

**⚠️ 另一個只喺線上單廚房 job 出現嘅差異（高風險）**：
今次唯一冇印出嘅 job，正好係**唯一冇 `content` / `template` 快照**嗰張。
`ledger-pos-bridge.ts:216-228` 嘅 `makeJob()` 只帶 `items / printerId / status`；
而所有印得出嘅本地 job（`print-jobs.ts:232-247`）都帶齊 `content` + `template`。
`dispatch.ts:53-55` 亦會 warn「冇 template 快照，將用通道 fallback 渲染」。
⇒ 若中繼 APK 版本已模板驅動，`template` 缺失可能令佢渲染唔到而唔 ack。

## 症狀 3：重打整單報「線上訂單資料已不在本機快取」—— 確定係 bug（設計缺口）

`print-center.tsx:417-424` `findJobSourceOrder()` → 對 `ledger-` 前綴行 `findPosOrderForLedger()`
→ `print-jobs.ts:416-425`：

```ts
const bridged = getBridgedPosOrder(ledgerOrderId);   // in-memory Map，reload 即清空
if (bridged) return bridged;
return loadOrders().find(...) ?? null;               // 線上單唔 mirror 入本機（契約 M3/M8）→ 一定搵唔到
```

而 `bridgedOrders` **只有兩個寫入點**：`resolveLedgerPosOrderForReceipt()`（:397）同
`bridgeLedgerOrderToPos()`（:417）。
**`printKitchenForLedgerOrder()`（:294-318）冇寫** —— 但快餐面板／自動接單正正係叫佢
（`quick-online-orders-panel.tsx:323`）。

⇒ **快餐面板接單產生嘅線上單廚房 job，由建立一刻起就已經「冇得重打」**；
就算係 `/orders` 頁接單（有寫 bridge），一 reload 就冇（in-memory）。
呢個係**必然發生**，唔係偶發。

## 症狀 4：「自動打印」按完、手動更新後消失

**「手動更新」＝ 強制整頁 reload**（`pos-app.tsx:1275-1341`，最後 `window.location.reload()` @ `:1336`）：

```
handleManualUpdate()
 ├ refreshBootstrapFromServer()      // 全量覆蓋菜單/枱/rules
 ├ 併合 Ledger 線上菜單（可選）
 ├ loadRuntimeState() → savePosLocalSettings(merged)   ← :1323 / :1259
 │    merged = { ...payload.localSettings（server device_configs 舊值）, 白名單逐項 override }
 │    白名單包含 printContentToggles（:1257）→ 理論上保留本機
 └ window.location.reload()
```

**兩個可查證嘅成因**：

1. **`setAutoPrint()` 唔檢查寫入是否成功**（`pos-app.tsx:3269-3289`）——
   `savePosLocalSettings()` 回 `false` 都照彈「自動打印已開啟」＋樂觀更新 UI。
   `storage.ts:121-134` `writeJson()` 喺 **quota 滿 / 私隱模式 / WebView 限制**下會回 `false`
   並只 `console.error`。⇒ 「撳完似開咗 → reload 後打回原形」。
2. **`自動打印` 係衍生值，唔係單一欄位**：`autoPrintEnabled = kitchen && label && receipt`
   （`pos-app.tsx:3302-3305`）。任何一個被其他入口（設備設置 `device-settings.tsx:1281-1288`
   亦係「用當下 state 整份覆寫」）改動，掣就會跳。

**同前兩個症狀有冇關？** 機制唔同（打印係 job 未上雲、設定係寫入/reload），但：
- **同一個家族**：全部係「靜默失敗」——寫入失敗唔出聲、樂觀狀態當成功。
- **同一條時間線**：`手動更新` 嘅 reload 會中斷 in-flight flush，亦會清空 `bridgedOrders`
  （＝直接造成症狀 3）。所以「更新一下就跟住唔對路」係合理觀察。
- **值得排除嘅共同嫌疑**：如果 localStorage 寫入真係失敗（quota / 私隱模式），
  **設定寫唔入 ＋ `print-jobs` / `sync-queue` 可能一齊寫唔入** → 兩個症狀同時出現。

## 建議嘅決定性檢查（順序做，10 分鐘內可全部完成）

| # | 做乜 | 判讀 |
|---|---|---|
| 1 | **而家落一張新嘅本地單（或對本地單撳「重打整單」）** | 印得出 → relay／APK／agent／同步全部健康，問題只喺線上單嗰張 job 冇上雲；印唔出 → 通道整體壞（網絡/憑證/APK） |
| 2 | Supabase（POS 專案）`pos_print_jobs` 近 1 小時 | 有冇 003 嗰行？**冇行**＝事件未上雲；**有行但 pending/claimed 且 lastError 空**＝APK 未 claim；**lastError 有值**＝APK 渲染失敗（呼應 template 缺失） |
| 3 | 打印中心 → **待補傳** / 「同步健康」 | 有 pending/failed/skipped（特別 `no-store`／`foreign-store`）嘅 `PRINT_JOB_CREATED` 就係未上雲嘅鐵證 |
| 4 | 設備設置 → 打印開關設置 | 三行（廚房單／飲品標籤單／線上訂單）reload 後實際值 |
| 5 | Console 貼 `tools/2026-09-12-diagnose-kitchen-print.js` | 一次列出 toggles／printers／jobs／**未 synced 事件數** |
| 6 | 訂單頁 vs 點餐介面各下一張**堂食**線上單 | 訂單頁＝唔會自動接單（現狀）；點餐介面＝會接 → 驗證症狀 1 嘅定位 |

## 建議修復（按價值排序，待批准）

| 優先 | 修復 | 位置 |
|---|---|---|
| P0 | **`printKitchenForLedgerOrder()` 亦寫 `bridgedOrders`**（或將線上單明細落一個 store-scope 持久 cache），令「重打整單」唔再必然失敗 | `ledger-pos-bridge.ts:294-318` |
| P0 | 「已發送」唔可以係樂觀值：`RelayTransport.send()` 要睇 `flushPosSyncQueue()` 結果；未上雲就標「待上雲」並喺打印中心出紅標 | `relay-transport.ts:25-34`；`dispatch.ts` |
| P1 | 線上單廚房 job 補 `content` + `template` 快照（同 `print-jobs.ts` 對齊），唔好靠 APK fallback | `ledger-pos-bridge.ts:216-228` |
| P1 | 堂食線上單自動接單：一係跟 quick panel 一樣照接（`skipTableAssignment` 語義），一係喺 UI 明示「堂食單需人手接單」——**要業務決定** | `online-orders.tsx:517-521` |
| P1 | 設定寫入失敗要出聲：`setAutoPrint()` / `device-settings` 檢查 `savePosLocalSettings()` 回傳值，失敗唔好樂觀更新 UI | `pos-app.tsx:3269-3289`；`device-settings.tsx:1281-1288` |
| P2 | `自動打印` 掣唔應該係三合一衍生值（或要顯示「廚房單已關」之類嘅原因） | `pos-app.tsx:3302-3305` |
| P2 | 線上單 Realtime/清單失敗（`Load failed`）要有覆蓋式警示，唔可以只係面板內一行文字 | `quick-online-orders-panel.tsx` |
