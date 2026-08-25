# 37 · 收銀端 printJobs backfill 靜默清單 / 重印 根因調查與處理計劃

> 狀態：**✅ P0–P3 全數完成（2026-08-25）** — `tsc --noEmit` 零新 error（僅 layout.tsx 已知 LayoutProps 誤報）；print job merge 回歸測試 4/4 pass
> 範圍：餐飲收銀 `src/components/pos-app.tsx` 的 `loadRuntimeState` backfill 機制
> 觸發：用戶要求「鎖定一項問題 → 深挖根因 → 梳理所有相關問題 → 出完整計劃，確認前不動手」→ 用家 confirm 後開工

---

## 1. 鎖定的問題

**收銀端 `loadRuntimeState()` 在 backfill（重連 / realtime 重新訂閱）時，對 `printJobs` 做「整份硬覆寫」而非「合併」，導致：**

1. 離線期間建立、尚未成功同步到後台的「新打印單（廚房單 / 收銀單）」在重連 backfill 時被靜默清走；
2. 本地已演化的打印狀態（`sent` / `failed`，由 flush worker 寫入 localStorage）被後台較舊的 `pending` 覆寫，造成**重複打印**（重開 2026-08-25 修復過的無限重印洞）；
3. 跨店打印單互串（後台 `printJobs` 查詢未過濾 `store_id`）。

> 用戶原假設：「`loadRuntimeState` 喺 offline 下返 `printJobs:[]` 清走新單」。
> **核實結果（修正機制）**：`loadRuntimeState` 在 offline 下**不會執行**（見下 `offlineMode` guard），真正觸發點是 **offline → online 重連時的 backfill**；其破壞性結果與用戶擔心的一致，只是觸發時機在「重連」而非「離線中」。

---

## 2. 根因深挖（逐條證據）

### 2.1 核心：`printJobs` 是整份硬覆寫，沒有合併、沒有保留本地狀態

`src/components/pos-app.tsx:569-572`
```ts
if (Array.isArray(payload.printJobs)) {
  setPrintJobs(payload.printJobs);   // ← 直接取代本地整份，無 merge
  savePrintJobs(payload.printJobs); // ← 連 localStorage 都一併覆寫
}
```
對比同函式對 `orders` 的處理（line 557-564）用 `mergeOrderLists(loadOrders(), current, payload.orders!)` 以 localStorage 為底做合併，**`printJobs` 是唯一被整份取代的欄位**。

而 `persistPrintJobs()`（line 965-984）當初就是為了**防止無限重印**而在 2026-08-25 專門寫的：以 localStorage 為真源合併、保留 `sent`/`failed` 狀態（line 966-968 註解明言）。`loadRuntimeState` **繞過了 `persistPrintJobs`**，直接用 raw `setPrintJobs`，等於另開一條會清單 / 重印的路徑。

### 2.2 觸發點 A：realtime 重新訂閱時無 queue 同步保護（重連競態）

- `useEffect` 版 backfill（line 532-538）有保護：
  ```ts
  if (offlineMode) return;
  if (queue.some((e) => e.status !== "synced")) return; // ← 有 pending 就唔 pull
  void loadRuntimeState();
  ```
- 但 `usePosRealtime` 的 `onResubscribed`（line 611-613）**直接 call `loadRuntimeState()`，無呢個 queue 保護**：
  ```ts
  onResubscribed: () => { void loadRuntimeState(); }
  ```
- 重連時（offline→online）：queue flush（`syncNow`）與 realtime 重訂閱同時發生，**競態**。`onResubscribed` 可能先於 queue 把離線建立的 `PRINT_JOB_CREATED` 事件 flush 入 `pos_print_jobs` 就 call 咗 `loadRuntimeState`；此時後台 `pos_print_jobs` 仲未包含呢批離線新單 → `setPrintJobs(serverList)` 把本地離線新單清走。

### 2.3 觸發點 B：`offlineMode` guard 令「離線中」不會跑，但重連會跑

`offlineMode = !networkOnline`（line 143-144）；`usePosRealtime(kioskStoreId, !offlineMode, ...)`（line 590）在 offline 時 disable realtime，所以 `onResubscribed` 唔會喺離線中觸發。證實用戶字面假設「offline 下返 printJobs:[]」**唔成立**；真正危險窗口係**重連瞬間**（`offlineMode` 翻 false 後）。

### 2.4 相關 bug：`/api/pos/state` 的 `printJobs` 查詢未過濾 `store_id`

`src/app/api/pos/state/route.ts:28-32`
```ts
const printJobsQuery = supabase
  .from("pos_print_jobs")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(200);
// ⚠️ 無 .eq("store_id", storeId) —— 而 orders（line 24-26）同 deviceConfig（line 33-35）都有過濾
```
後果：
- 每間店收銀 backfill 時會拿**全店所有分店的打印單** → 跨店互串；
- 與 2.1 硬覆寫疊加：本地單可能被「別店單」排擠，且自己未同步嘅離線單更易被清走。

### 2.5 狀態演化被丟棄 → 重印風險

打印單建立時 `status: resolvePrintJobStatus(networkOnline)`（`companion.ts:363-366`：有 native/companion 即 `"sent"`，否則 `"pending"`）。flush worker 本機派發後會將 localStorage 狀態轉 `sent`/`failed`，但**冇重新同步狀態去 `pos_print_jobs`**（sync route 只 insert `PRINT_JOB_CREATED` 一次，payload 係建立當刻嘅 status）。所以後台 `pos_print_jobs` 嘅 status 往往落後本地。`loadRuntimeState` 硬覆寫會用落後嘅 `pending` 覆寫本地 `sent` → flush worker 當佢未印 → 再印一次。

---

## 3. 相關問題全面梳理（cluster）

| # | 問題 | 位置 | 嚴重度 | 與核心關係 |
|---|------|------|--------|-----------|
| R1 | `printJobs` backfill 整份硬覆寫（無 merge / 無保留本地狀態） | `pos-app.tsx:569-572` | 🔴 高 | **核心根因** |
| R2 | `onResubscribed` call `loadRuntimeState` 缺 queue 同步保護 → 重連競態清單 | `pos-app.tsx:611-613` vs `532-535` | 🔴 高 | 核心觸發點 |
| R3 | `/api/pos/state` `printJobs` 未過濾 `store_id` → 跨店互串 | `state/route.ts:28-32` | 🟠 中 | 放大破壞面 |
| R4 | backfill 策略不一致：`orders` 用 merge，`queue`/`printJobs` 用 raw 覆寫 | `pos-app.tsx:557-572` | 🟠 中 | 同類隱患 |
| R5 | 本地打印狀態演化被後台落後 status 覆寫 → 重印 | `pos-app.tsx:570` + `companion.ts:363` | 🔴 高 | 核心副作用（重開 2026-08-25 洞） |
| R6 | salon 模組有冇類似 backfill 硬覆寫？（salon 用 idb + sync-queue，架構唔同，**需 parity 核查**） | `src/lib/salon/*` | ❓ 待查 | 潛在同源 |

---

## 4. 處理計劃（待確認，確認前不執行）

### P0 — 消滅清單 / 重印（必做）
1. **`loadRuntimeState` 改用合併語義處理 `printJobs`**：以 localStorage 為底（同 `persistPrintJobs` 的 merge 規則：保留本地 `sent`/`failed`，只補回本地冇、server 有嘅單，絕不刪本地單）。
   - 落點：`pos-app.tsx:569-572` 改 call `persistPrintJobs(mergePrintJobs(loadPrintJobs(), payload.printJobs))` 或抽出共用 merge helper。
2. **`onResubscribed` 加回 queue 同步保護**：改為 `if (queue.some(e => e.status !== "synced")) return; void loadRuntimeState();`，或抽一個 `maybeLoadRuntimeState()` 俾兩處共用，消除重連競態。

### P1 — 收窄破壞面
3. **`state/route.ts` `printJobsQuery` 加 `.eq("store_id", storeId)`**，與 orders / deviceConfig 一致，杜絕跨店互串。
4. **統一 backfill 契約**：`orders` / `queue` / `printJobs` 三欄都用「localStorage 為底 + server 為增補」嘅 merge；`queue` 現時 raw `setQueue(payload.queue)`（line 565-567）亦建議改 merge，避免本地未同步事件被覆寫。

### P2 — 狀態主權與回歸
5. **明確狀態主權**：server `pos_print_jobs` 係「存在性」真源；本機 localStorage 係「派發狀態（sent/failed）」真源。backfill 唔可以後台 `pending` 覆寫本地 `sent`。
6. **加離線→重連 print job 存活嘅回歸測試 / 模擬**（offline 建 N 單 → 重連 → 斷言本地 `printJobs` 不減、不重印）。

### P3 — 跨模組 parity
7. **核查 salon 模組**：確認 `src/lib/salon/*` 冇類似 backfill 硬覆寫（初步看 salon 用 idb mirror + sync-queue，架構不同，大概率無此 bug，但需確認）。

---

## 5. 驗證方案（計劃獲確認後執行）
- `npx tsc --noEmit`（已知 `layout.tsx` LayoutProps 誤報可忽略）。
- 手動 / 模擬：收銀離線開 3 張單並打印 → 切 online → 斷言 `printJobs` 數量不減、無重複打印、冇別店單混入。
- `state/route.ts` 改動後：用 `?storeId=` 驗證只回該店 `printJobs`。

---

## 6. 結論（回應用戶假設）
- ✅ 用戶擔心嘅「重連時新打印單被清走 / 重印」**屬實，且已鎖定根因**：`loadRuntimeState` 對 `printJobs` 嘅整份硬覆寫（R1）+ `onResubscribed` 缺 queue 保護嘅重連競態（R2）。
- 🔧 機制修正：唔係「offline 下返 `printJobs:[]`」（offline 有 guard 唔會跑），而係「**重連瞬間 backfill 用未含離線新單嘅後台列表整份取代本地**」。

## 7. 實施記錄（2026-08-25 下午，已開工）

### 改動清單
| 項 | 檔案 | 改動 |
|----|------|------|
| P0-1 | `src/components/pos-app.tsx:583-587` | `printJobs` backfill 由 `setPrintJobs(payload.printJobs)` 改 `persistPrintJobs(payload.printJobs)`（localStorage 為底 merge，留本地 sent/failed、唔刪本地單） |
| P0-2 | `src/components/pos-app.tsx:onResubscribed` | 加 `if (offlineMode) return; if (queue.some(e=>e.status!=="synced")) return;` 再 `loadRuntimeState()`，消除重連競態 |
| P0 (R5 rt) | `src/components/pos-app.tsx:onPrintJobUpsert` | 本地已有該 job 就保留本地版本（唔用後台落後 status 覆寫）→ 防 realtime 路徑重印 |
| P1-3 | `src/app/api/pos/state/route.ts:28-32` | `printJobsQuery` 加 `.eq("store_id", storeId)`（無 storeId 時維持不過濾，兼容 mock），與 orders/deviceConfig 一致 |
| P1-4 | `src/components/pos-app.tsx:565-582` | `queue` backfill 改 localStorage 為底 merge（保留本地 pending、去重、補 server 冇嘅） |

### 驗證
- `npx tsc --noEmit`：零新 error（僅 `layout.tsx` LayoutProps 已知誤報，Vercel build 無礙）。
- 邏輯自檢：R1/R5 經 merge 修復；R2 經 onResubscribed guard 修復；R3 經 store_id 過濾修復；R4 queue 改 merge。

### P3 salon parity 核查（結論：唔使改）
- salon `src/app/api/salon/state/route.ts:166` 嘅 `salon_print_jobs` 查詢**本來就過濾 `store_id`**（無 R3）。
- salon 客戶端（`src/components/salon`、`src/lib/salon`）**無 `loadRuntimeState` / 無 `printJobs` backfill 硬覆寫**，改用 idb mirror + sync-queue，架構不同，不受此 bug 影響。

### 已知 follow-up（非今次範圍，待排期）
- `pos_queue_events` 表**無 `store_id` 欄**，所以 `queue` backfill 仍會拉到跨店 queue 事件（本地優先 + 去重已避免本地事件被覆寫，但 `queue` state 仍含其他店 synced 事件）。要徹底解決需 DB schema 加 `store_id` + sync route 寫入 + state route 過濾，屬 schema 變更，另開 task。

## 8. P2 / P3 實施記錄（2026-08-25，續 P0/P1 之後）

用家 push P0/P1 成功後，續做 P2 / P3：

### P2-5 狀態主權（契約落實，已透過 P0 代碼強制）
- `server pos_print_jobs` = 存在性真源；`localStorage` = 派發狀態（sent/failed）真源。
- 已由 P0-1（`printJobs` merge 留本地 sent/failed）+ `onPrintJobUpsert` 留本地版本 強制落實；`loadRuntimeState` / `persistPrintJobs` 都唔會用後台 `pending` 覆寫本地 `sent`。

### P2-6 回歸測試（已加，4/4 pass）
- 抽出純函式 `mergePrintJobs(local, incoming)` → `src/lib/pos/print-job-merge.ts`，`persistPrintJobs` 改用佢（DRY，行為不變）。
- 加 `src/lib/pos/print-job-merge.test.ts`，用 Node built-in `node:test`（**唔引入新依賴**，合乎「不引入新依賴」約定）。
- 指令：`node --experimental-strip-types --test src/lib/pos/print-job-merge.test.ts`（Node 22 需 `--experimental-strip-types`；Node 23.6+ 預設開啟）。
- 覆蓋 4 個不變量：本地 sent 唔被 pending 覆寫（防重印）/ 本地有 server 冇→保留（離線新單唔清走）/ server 有本地冇→補入（跨終端見單）/ 離線→重連模擬（3 張離線新單 + 舊單 → 唔減唔重印唔漏）。
- `tsconfig.json` 加 `allowImportingTsExtensions: true`（已有 `noEmit: true`，條件滿足），令 `.ts` 測試 import 過 tsc，`next build` 唔會喪。

### P3 salon parity（核查結論：唔使改）
- `src/app/api/salon/state/route.ts:166` 嘅 `salon_print_jobs` 查詢本來就過濾 `store_id`。
- salon 客戶端（`src/components/salon`、`src/lib/salon`）無 `loadRuntimeState` / 無 `printJobs` backfill 硬覆寫（用 idb mirror + sync-queue），架構不同，不受此 bug 影響。
- **P3 無代碼改動。**

### P0–P3 總結
| 階段 | 項 | 狀態 |
|------|----|------|
| P0 | printJobs merge / onResubscribed guard / onPrintJobUpsert 留本地 | ✅ |
| P1 | state route store_id 過濾 / queue merge | ✅ |
| P2 | 狀態主權落實 + 回歸測試 | ✅ |
| P3 | salon parity 核查（無改動） | ✅ |

剩餘唯一 follow-up：`pos_queue_events` 缺 `store_id`（跨店 queue 污染，schema 變更，另排）。
