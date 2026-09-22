# 「隔離」停用 ＋ 111 張異常隔離單根因 ＋ offline sync 加固（2026-09-22 21:10）

> 商家原話：「不應存在『隔離』的概念，即使是 offline 狀態，訂單也應一直保留在本機內，
> 直到連網成功後才 sync 上去。不要影響現有的功能，我要的是優化！不是弄壞！
> 還有，確保這些改動也不會增加任何的流量！」
>
> 本輪所有改動都按呢三條約束做，最後一節逐項核對流量。

---

## 0 結論（一眼睇完）

| 問題 | 結論 |
|---|---|
| 點解有 **111 張**被隔離 | 🔴 佢哋**根本唔係訂單** —— 係 **`PrintJob` 物件漏入 `orders` store**（`print-xxxxxxxx`、`MOP 0.00`、枱名係打印 job 自己嘅 `table_name`）。孤兒對賬見佢「唔屬終態訂單狀態」＋「雲端夾唔到」⇒ 逐張當孤兒隔離。 |
| 「隔離」概念 | ✅ **已整組停用**（商家拍板）。本機訂單**一律保留**，offline 都保留，直到 sync 上雲。舊隔離區開頁時**自動全部還原**。 |
| offline mode 有冇被弄壞 | 收單／補推路徑**冇壞**；但發現一個**會永久漏單**嘅隱患：增量水位之前**無條件推進**（連失敗／降級回應都推）→ **已修**。 |
| 流量 | ✅ **淨減少**：刪走上一輪加嘅一條增量查詢；其餘改動全部係 localStorage 本機操作，**零新請求**。 |

---

## 1 111 張係咩？（證據鏈）

截圖每一行都長成：`print-8d940feb | MFOOD1 | MOP 0.00 | 自動隔離（手動更新） · 17/9/2026 上午11:16:04`

| 畫面欄位 | 真身 | 來源 |
|---|---|---|
| `print-8d940feb` | **`PrintJob.id`**（`uid("print")`） | 經 `mapPosOrderRow()` 嘅 `localOrderNo: row.local_order_no ?? row.id` **fallback** 變成單號 |
| `MFOOD1` | `PrintJob.table_name` | 打印 job 本身有枱名 |
| `MOP 0.00` | PrintJob 冇 `total` | `Number(row.total ?? 0)` |
| 被判「孤兒」 | `PrintJob.status` = `pending` / `sent` / `printed` | **唔屬**終態訂單狀態（settled/cancelled/refunded）⇒ 孤兒判準當佢係「未結帳單」 |

**點解會累積到 111 張？三個因素疊加：**

1. **上游污染（17/9 開始）**：唔知邊條路徑令 PrintJob 物件寫入 `orders` store。
   今日 17/9 嘅記錄顯示分三批被隔離（11:16 ×2、12:06、13:05 …），之後一直冇清。
   ⚠️ **呢個源頭我未定位到**（現行原始碼冇一條路徑會咁樣寫；屬 17/9 之前嘅版本行為）。
   ⇒ 風險由下面第 1 項新守衛兜住（同類污染以後唔會再入到 UI／queue／隔離）。
2. **孤兒判準誤判**：判準係「本機非終態 ＋ 今次 payload 冇 ＋ outbox 冇 pending ＋ 齡 ≥10 分鐘」。
   PrintJob 漏入嚟嘅假訂單永遠上唔到雲（`pos_orders` 根本冇呢個 id）⇒ **每次全量拉取都重新被判孤兒一次**。
3. **隔離區冇 TTL、冇自動清理**（只有 `MAX_QUARANTINED_ORDERS = 200` 上限）⇒ 只會累積。

> 🔎 所以「111 張」唔代表有 111 張未同步訂單；真實未結帳單今日只有 **3 張**
> （訂單19 A01/99、訂單25 A03/41、訂單29 A01/98）。

### 關於「訂單過咗結數時間就應該清」
商家講得對，但要分清兩件事：
* **真訂單**：本機保留係**有意**嘅 —— 返結（反結賬）、補打、對數都要本機歷史快照；
  雲端 `pos_orders` 才是永久真源。所以**唔應該**自動清真訂單（清咗就冇得返結）。
* **垃圾**（PrintJob 漏入）：冇任何價值 ⇒ 今次已加守衛**永久擋喺 storage 之外**。

---

## 2 修正方案（6 項，全部已實作）

| # | 改動 | 檔案 | 作用 |
|---|---|---|---|
| 1 | **id 命名空間守衛**（黑名單 `print-` / `evt-` / `q-`） | 新 `src/lib/pos/order-id-guard.ts` | orders 只准放訂單 id；非訂單實體**永遠唔會**上 UI／queue／隔離 |
| 2 | **`loadOrders()` 自我修復** | `src/lib/storage.ts` | 一讀到垃圾即過濾 + 寫返乾淨版本（一次過，之後讀到已乾淨） |
| 3 | **停用自動隔離** | `src/components/pos-app.tsx` | 刪走 `quarantineOrders()` 呼叫；本機訂單一律保留 |
| 4 | **一次性還原舊隔離區** | `src/lib/pos/sync-reconcile.ts`（`restoreAllQuarantinedOrders`）＋ pos-app mount effect | 開頁自動把真訂單還原返本機、垃圾直接丟棄、清空隔離區（**唔需要逐張撳**） |
| 5 | **增量水位守門** | `src/components/pos-app.tsx` | 只喺真係收到 `orders` 陣列時才推進水位（防「半死網絡之後永久漏單」） |
| 6 | **文案 + 契約測試** | `sync-health-modal.tsx` / 3 個 test 檔 | 隔離區字眼改為「本機保留嘅訂單（舊隔離區）」；新增 9 條守衛斷言 |

**刻意保留（冇改）**：`filterResurrectedOrders()` 嘅 tombstone 過濾、終態單「唔可以由雲端單邊復活」
（docs/52）、realtime 唔復活已刪單 —— 呢啲係**防復活**而唔係刪本機資料，行為不變。

---

## 3 對 offline sync 嘅影響

### 之前（有問題）
* Offline 收單本身正常（寫 localStorage + outbox `pending`），重連後 flush 補推。
* 🔴 **但只要某一次 `/api/pos/state` 回應係 partial／空**（空骨架、增量差量、投影子集），
  本機**未結帳單就會被移出 `orders`** —— 之後即使補推成功、雲端有單，
  **本機／枱面都再睇唔到**，收銀亦結唔到帳（實案：A03 閃一下消失）。

### 之後（現在）
| 場景 | 行為 |
|---|---|
| Offline 落單 / 加菜 / 結帳 | **完全不變**（本地寫入 + outbox 排隊） |
| Offline 期間拉取 | 唔會發生（`offlineMode` 已 return）；更重要係**唔會再有「刪本機單」呢一步** |
| 重連補推 | 不變（退避、`skipped/server-newer` 終態、`onceKey` 去重全部保留） |
| 舊隔離單 | 開頁**自動還原**（唔使商家逐張撳「還原」） |
| 增量水位 | 🔴 修好：`orders` 唔係陣列（失敗／降級回應）⇒ **唔推進水位** ⇒ 下次照樣拉得返 |

> 一句話：**offline 路徑完全冇改動，只係把「刪本機資料」呢個動作移除**，
> 所以係**風險下降**而唔係行為改變。

---

## 4 流量影響（逐項核對，商家硬要求）

| 改動 | 請求／bytes 影響 |
|---|---|
| `loadOrders()` id 守衛 | **0**（純 localStorage，首次讀到垃圾時多一次本機寫入） |
| 停用自動隔離 | **0**（本來就冇網絡請求） |
| 一次性還原隔離區 | **0**（純本機；只喺 mount 跑一次，冇隔離記錄時係 no-op） |
| 增量水位守門 | **0**（只係「唔推進」，唔會多拉） |
| 同步健康文案 | **0** |
| 🔽 **移除上一輪加嘅「增量未結帳兜底腿」** | **−1 條 PostgREST 查詢／每條增量拉取** |

**為何可以安全移除兜底腿**（重要）：
`incremental` 係 P1 新參數，**只有新 bundle 會傳**（舊 bundle 永遠唔傳）——
而需要兜底嘅**正正係舊 bundle**（佢唔識 `incremental`，會誤跑孤兒對賬）。
舊 bundle 走嘅係 `legacyThrottled` 骨架路徑，嗰邊已經改為**回未結帳單**（真正有用嘅修法）。
新 bundle 尊重 `incremental` 旗標、唔會跑孤兒對賬，而且水位已收緊 ⇒ 唔需要兜底腿。

⇒ **淨流量：減少**（增量拉取回到「單腿零額外查詢」）。

---

## 5 驗證

```bash
node node_modules/typescript/bin/tsc --noEmit    # 0 error
node node_modules/eslint/bin/eslint.js <改動檔>   # 0 error（10 個 warning 全部係改動前已存在）
node --test                                     # 1204 pass / 0 fail
```

新增守衛（會令同類 bug 第三次發生時即刻紅燈）：
* `order-id-guard.test.ts`：9 條（命名空間、邊界、唔准誤判真訂單、黑名單唔可以撞訂單前綴）
* `pos-app-queue-base.test.ts`：`pos-app` 唔准再有任何自動隔離呼叫、必須一次性還原舊隔離區、
  增量水位只可以喺收到 `orders` 陣列時推進、`loadOrders` 必須過守衛
* `state-incremental-contract.test.ts`：契約升級（原本「增量之下唔准跑孤兒對賬」
  → 現在「**任何情況都唔准自動移走本機訂單**」）

### 現場驗證步驟
1. iPad 重新載入 → 開「設定 → 同步健康」→ 隔離區應該係 **0 張**（自動還原）。
2. 落一張單（唔好結帳）→ 桌台應該一直顯示「已下單」，**唔會再閃走**。
3. 開飛航模式 → 落單／結帳照做 → 關飛航 → 幾秒內雲端見到（`pos_orders`）。
4. 睇 Vercel log：`[egress] pos/state` 唔應該再見 `mode=legacyThrottled orders=0`（若仍見 = 有機仲跑舊 bundle，叫佢 reload）。

---

## 6 待辦（未做，已記錄）

| 優先 | 項目 | 備註 |
|---|---|---|
| P1 | **定位 PrintJob 漏入 `orders` 嘅源頭** | 17/9 之前嘅版本行為；現行源碼冇可疑路徑。已加守衛兜住，但源頭要查清楚 |
| P1 | 清走隔離機制剩餘死碼 | `loadQuarantinedOrders()` 仍被 3 處引用（realtime 復活守門、merge 剔除、modal 顯示）—— 為零風險先保留 |
| P1 | 「未結帳單」可見性 | 今日 3 張未結帳單（19/25/29）仍然冇人識別 ⇒ 建議日結／交班頁加「今日未結帳」清單（唔加請求，用已拉嘅資料） |
| P2 | 舊 bundle 強制升級提示 | `legacyThrottled` 由 log 升級為可見警告（上一輪已記） |
| P2 | 同日重複單號（訂單27 ×2）、`pos_print_jobs.kind` | 另一條獨立線 |

---

## 7 改動檔案一覽

| 檔案 | 類型 |
|---|---|
| `src/lib/pos/order-id-guard.ts` | 🆕 純函式守衛（零 import，可 `node --test`） |
| `src/lib/pos/order-id-guard.test.ts` | 🆕 9 條單測 |
| `src/lib/storage.ts` | `loadOrders()` 過守衛 + 自我修復 |
| `src/lib/pos/sync-reconcile.ts` | 🆕 `restoreAllQuarantinedOrders()`（停用隔離 + 舊資料一次性還原） |
| `src/components/pos-app.tsx` | 停用自動隔離、mount 一次性還原、增量水位守門 |
| `src/components/sync-health-modal.tsx` | 文案（隔離 → 本機保留） |
| `src/lib/pos/pos-app-queue-base.test.ts` | 契約測試更新 + 新增 |
| `src/app/api/pos/state/state-incremental-contract.test.ts` | 契約升級（任何情況都唔准自動移走本機訂單） |
| `src/app/api/pos/state/route.ts` | 移除增量兜底腿（減 1 條查詢） |
