# 全專案優化 — 範圍確認稿（動手前必讀）

> 日期：2026-09-21 ｜ 原則：**只優化「成本／效率／可觀測性」，一律唔改行為、介面、資料格式、相依性**
> 狀態：**待你核准範圍**。未改任何生產程式碼。

---

## 0. 驗證基準（改動前已實測，作為回歸對照）

| 檢查 | 改動前基準 | 改動後必須 |
|---|---|---|
| `tsc --noEmit` | **0 error** | 仍然 0 error |
| `node --test "src/**/*.test.ts"` | **866 passed / 0 failed** | 仍然全綠（新增測試只可加，不可改舊斷言） |
| Migration 現況 | 43 條，最新 0045；**未跑：0042、0044、0045** | 新 migration 只加不刪 |
| 基準指令（本機這樣跑） | `C:/Users/.../node/versions/22.22.2-3/node.exe node_modules/typescript/bin/tsc --noEmit`<br>`.../node.exe --test "src/**/*.test.ts"` | 同左 |

---

## 1. 現況審計（唯讀掃描結果）

### 1.1 常駐計時器（root layout／主畫面，開機就跑）

| 位置 | 頻率 | 打咩 | 問題 |
|---|---|---|---|
| `sync-reconcile-daemon.ts:327` | 60s 掃描；每 10min 一輪全店拉取 | `pos_orders` **全店歷史**（limit 5000） | 🔴 **egress 主因** |
| `pos-app.tsx:745` 班次同步 | 60s | `/api/pos/shift` | 🟠 頻率過高 |
| `app-sidebar.tsx:113` 充值 badge | 30s | `/api/topup/pending-count`（5~6 個上游） | 🔴 **invocations 主因** |
| `sync-flush.ts:159` flush | 30s | `POST /api/pos/sync`（只在有 pending 時） | ✅ 合理 |
| `print-flush-worker.tsx:49` | 2.5s | **只讀 localStorage**（relay 時才 flush） | ✅ 已正確 |
| `sync-acks.ts:295` | 15s | **只讀 localStorage** | ✅ 已正確 |

### 1.2 開頁才跑的計時器

| 位置 | 頻率 | 備註 |
|---|---|---|
| `restaurant-daily-report.tsx:887` | 3 分鐘 | PAGE 2000 × 3 腿 |
| `print-center.tsx:441` | **8 秒** | 兩條 select limit 200（投影過） |
| `members-page.tsx:109` | 12 秒（fast） | 同上 topup |
| `use-kds-board.ts:377` | 15s tick／60s 實拉 | **KDS 已停用 ⇒ 成本 0** |
| `salon/online/page.tsx:367` | 5 秒 | salon 模組（未使用） |

### 1.3 設計良好、**唔需要動**嘅模組（避免過度改動）

- `pos/store-status.ts`：明文「全專案禁 polling」，只 mount / Realtime / visibility 三個觸發點 ✅
- `pos/sync-acks.ts`、`print-dedupe.ts`、`close-gate.ts`、`order-event-time.ts`：純邏輯、零 import、有單測 ✅
- `print-bridge` 通道鏈、`queue-outbox` 合併鍵邏輯 ✅

### 1.4 放大因子

- `.select("*")` 共 **43 處**（其中 `pos_orders` 相關 4 處最貴）
- `pos-orders-range.ts:85-96`：每個「一頁」並行 **3 條** query，回傳再 client 去重 ⇒ **DB→function 照俾 3 份**
- `pos/state/route.ts:140`：每次拉 300 條 `pos_queue_events`（每條 payload ＝完整訂單快照），**v2 之下 client 完全唔用**

---

## 2. 優化項目（分三級，全部零行為改動）

### A 級 — 雲端用量（最高 ROI，先做）

| 編號 | 改動 | **原因** | 行為影響 |
|---|---|---|---|
| **A1** | 對賬守護：`fields=id,status,updated_at` 投影 | 守護只需要「狀態」做核實，卻拉咗每張單嘅 `items`（1 469 B → 91 B，**16×**） | 無。只少拉欄位，核實邏輯不變 |
| **A2** | 守護改用 `computeServerRangeStart()`（取代 `null`） | `null` ＝ 冇日期下限 ＝ 拉**全店歷史**；同檔案早有現成助手，只係守護漏用 | 無。核實範圍仍覆蓋 7 日窗口全部終態單（helper 已含 −12h buffer） |
| **A3** | `RECONCILE_ACK_TTL_MS` 10 分鐘 → 60 分鐘 | 每 10 分鐘回執全部過期 ⇒ 全店重新拉一次（乘數放大器） | **可感知**：雲端被回水嘅偵測延遲由 ≤10 分鐘變 ≤60 分鐘。**呢個係唯一需要你拍板嘅語義變更**，我會寫入註釋 + 保留常數方便回滾 |
| **A4** | 每日拉取預算硬閘（24 次） | 堵死「永遠對唔上 ⇒ 每 60 秒拉一世」病態路徑 | 無（正常日遠低於 24 次；超限只寫告警，唔影響 flush） |
| **A5** | `pos/state` 加 `?skipQueue=1`（v2 時傳） | client 已經唔 merge server queue（`pos-app.tsx:1209`）⇒ 白拉 500 KB／次 | 無。唔傳 ＝ 舊行為；v1 回溯仍然照查 |
| **A6** | `local-orders-panel.tsx:239` 補 `&ordersOnly=1` | 個 panel 只用 orders，原本拉足 orders+queue+printJobs（0.98 MB） | 無 |
| **A7** | 報表 3 分鐘 → **10 分鐘**、`PAGE` 2000 → 500 | 報表係對數用途 | **可感知**：自動刷新由每 3 分鐘變每 10 分鐘（手動刷新不受影響） |
| **A8** | 打印中心 8 秒 → **30 秒** | 8 秒 × 長開一晚 ≈ 0.4 GB／10 800 次 | **可感知**：打印狀態更新延遲 ≤30 秒（出紙本身唔受影響） |
| **A9** | 充值 badge 30 秒 → **5 分鐘**（＋回前景即拉） | 為一個紅點每 30 秒打 5~6 個上游 | **可感知**：紅點最多遲 5 分鐘出現（回到前景會即時更新） |
| **A10** | 班次同步 60 秒 → **180 秒** | 班次狀態唔需要分鐘級新鮮度 | **可感知**：另一部機開工／收工最遲 3 分鐘後反映（focus／online 仍即時對齊） |
| **A11** | `members-page` topup 12 秒 → 60 秒 | 同上 | 可感知（該頁紅點延遲） |

> 💡 A3／A7／A8／A9／A10／A11 屬「新鮮度取捨」，並非純內部改動 —— **這幾項我會逐項問你，可以只做純內部那幾項（A1/A2/A4/A5/A6）。**

### B 級 — 查詢層（payload 投影）

| 編號 | 改動 | **原因** | 行為影響 |
|---|---|---|---|
| **B1** | 三條時間腿 → 單一 SQL RPC `pos_orders_page` | 每頁 3 條 query ⇒ 成本 ×3；改用 DB 內 OR + distinct ⇒ **1×** | 無。回傳型別不變；`reopened` 腿失敗時嘅「降級為 0 命中」語義要保留 |
| **B2** | `select("*")` → 明確欄位（優先 `pos_orders` 4 處） | 43 處全欄位；投影可省 30~70% bytes | 無（**要逐個核對 mapper 實際讀邊幾欄**，漏一欄會靜默唔出 —— 見 docs/113「四條讀取路徑」鐵律） |
| **B3** | 跑 migration **0044**（三個範圍索引） | 三腿查詢冇對應索引會拖慢 DB、拉長鎖 | 無（純索引） |
| **B4** | 跑 migration **0045**（`once_key` 唯一索引） | 代碼已做好 42703 降級；跑咗就得跨終端去重 | 無（已保護） |

### C 級 — 可觀測性（令下次唔會再「查唔到原因」）

| 編號 | 改動 | **原因** | 行為影響 |
|---|---|---|---|
| **C1** | `pos/state`／`kds/board` 加 `console.info('[xxx] bytes=…')` | 令 Vercel log 直接變成 egress 帳單鏡像 | 無（只多一行 log） |
| **C2** | 新增純函式單測（欄位白名單、預算閘） | 令新邏輯有回歸保護 | 無（只加測試檔） |

---

## 3. 明確**唔做**嘅事（保護現有功能）

1. ❌ 唔改任何 UI／文案／觸控尺寸／版面
2. ❌ 唔改任何 API 契約（新 query param **一律 optional，唔傳 ＝ 舊行為**）
3. ❌ 唔刪任何功能模組（包括已停用嘅 KDS、salon）
4. ❌ 唔改 Realtime 訂閱（只佔 1%，且係即時性命脈）
5. ❌ 唔改資料寫入路徑（`/api/pos/sync`、打印、返結、交班）
6. ❌ 唔改 localStorage key／資料結構（避免舊裝置資料讀唔返）
7. ❌ 唔升級／降級任何 npm 相依
8. ❌ 唔重構、唔改名、唔移動檔案（減少 diff 面積）

---

## 4. 每批改動嘅驗證流程（同一套，不容許跳步）

```
① 改動前：tsc 0 error ✅ / 866 tests pass ✅            ← 已完成，數字已記錄
② 改動：一次只碰 ≤3 個檔案，逐個改動單獨可回滾
③ 靜態驗證：tsc --noEmit 必須仍然 0 error
④ 單元驗證：node --test "src/**/*.test.ts" 必須仍然 866+/0
   （新增純函式測試：欄位白名單、預算閘、TTL 常數）
⑤ 契約檢查：grep 全部舊呼叫點，確認「新參數都有 default ＝ 舊行為」
⑥ 行為等價檢查（逐項）：
   · A1/A2/A5/A6 → 對同一份 fixture，核實結果同改動前一致（可寫成單測）
   · A3 → 只改常數，核實沒有任何邏輯分支依賴 10 分鐘這個具體值
   · B1 → 用同一組訂單 fixture 比對 RPC 前後回傳集合完全相同（含重複 id 去重結果）
   · B2 → 逐個 mapper 核對欄位清單（漏欄 ＝ 靜默唔出，最易出事 ⇒ 單獨一批做）
⑦ 手動煙霧測試（我用本機 dev server 跑一次，你亦可以照單行）：
   ☐ 收銀台開機／開工
   ☐ 落單 → 廚房單出紙 → 結帳 → 收據出紙
   ☐ 加菜、退菜、免單、返結（含「已返結 ×N」標籤）
   ☐ 交班頁數字 vs 報表數字一致（呢個係歷史重災區）
   ☐ 訂單頁見到另一部機落嘅單
   ☐ 打印中心狀態、同步健康燈
   ☐ 充值待審紅點仍然出得到
⑧ 用量回歸（改後 24 小時）：Supabase Egress 日曲線 + Vercel Usage 對比改前
```

**回滾方案**：每批改動對應一個 git commit；出現任何異常即 `git revert` 單一 commit（唔會影響其他批）。

---

## 5. 預期成果

| 指標 | 現況 | 完成 A＋B 後 |
|---|---|---|
| Supabase PostgREST（20 日） | 6.07 GB（峰值 1.47 GB／日） | **< 0.6 GB** |
| Vercel Function Invocations | 131,010 | **~55,000** |
| Vercel 費用 | ≈ $1.45 | **< $0.6** |
| 超額 | 6.13 / 5 GB（超 1.13 GB） | 回到額度內、有餘量 |
| 行為／介面／相依性 | — | **完全不變**（除 §2 標示嘅「新鮮度」項目外） |

---

## 6. 執行次序建議

| 批次 | 內容 | 風險 | 需唔需要你跑 migration |
|---|---|---|---|
| **第 1 批** | A1 A2 A4 A5 A6（純內部）＋ C1 C2 | 極低 | 唔需要 |
| **第 2 批** | A3 A7 A8 A9 A10 A11（新鮮度取捨） | 低（可感知） | 唔需要 |
| **第 3 批** | B1 ＋ 跑 0044／0045 | 中（要 migration） | ✅ 需要（我出 SQL，你執行） |
| **第 4 批** | B2 全域 `select("*")` 投影 | 中（漏欄＝靜默） | 唔需要 |
