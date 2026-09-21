# 用量優化：已落實改動 ＋ 驗證報告

> 日期：2026-09-21 ｜ 範圍：第 1+2+3 層（純內部 ＋ 頻率調整 ＋ 查詢層重構）
> 配套：`project-wide-optimization-scope-2026-09-21.md`（範圍確認稿）、`egress-optimization-plan-2026-09-21.md`（逐項 diff）
> **狀態：程式碼已改完並通過全部本機驗證；未 commit、未部署。migration 待你執行。**

---

## 0. 驗證結果（改動前 → 改動後）

| 檢查 | 改動前基準 | 改動後 | 判定 |
|---|---|---|---|
| `tsc --noEmit` | 0 error | **0 error** | ✅ 無回歸 |
| `node --test "src/**/*.test.ts"` | 866 passed / 0 failed | **892 passed / 0 failed** | ✅ 866 條舊測試全部照舊，+26 條新增 |
| eslint（17 個改動檔） | — | **0 新 error / 0 新 warning** | ✅ 已逐條對比 HEAD 版本確認（`print-center.tsx` 嗰 16 個 error 係**既有**問題，HEAD 一模一樣） |
| API 契約 | — | 所有新 query param **一律 optional，唔傳 ＝ 舊行為** | ✅ 見 §2 |
| Migration | 43 條（0044/0045 未跑） | +1 條（0046，未跑） | ⏳ 待你執行 |

新增測試（26 條）：
- `src/lib/pos-order-row.test.ts`（6）— 「投影欄位 ↔ mapper」雙向焊死 + 投影等價性
- `src/lib/egress-log.test.ts`（6）— bytes 量度正確性 + body 逐位元一致 + 靜音開關
- `src/lib/pos-orders-range.test.ts`（14）— 三層降級鏈決策 + 三腿去重排序

---

## 0.1 ✅ 真瀏覽器流程驗證（2026-09-21，17 條路由 + API 契約）

用本機 `next dev`（port 3017）＋ Chrome headless ＋ localStorage 種子（唔需要 Supabase／Ledger 後端），
逐頁巡「點餐 / 打印 / 設置 / 報表 / 其他」。**工具已保留**：`tools/verify-pos-flows-live.cjs`、
`tools/verify-pos-api-contract.cjs`（commit 前可以直接再跑一次）。

### 結果：17 / 17 全部 ✅

| 頁面 | http | pageerror | 卡死標記 | 畫面 |
|---|---|---|---|---|
| 收銀台（點餐入口，桌台總覽） | 200 | 0 | 無 | 桌台總覽 A01/A02/A03、開工閘、線上/線下接單總掣、快捷操作 ✅ |
| 設置 `/settings` | 200 | 0 | 無 | 打印機、菜品… ✅ |
| 報表 `/reports` | 200 | 0 | 無 | 11 張 KPI 卡、退款拆解、訂單明細、菜品排行、食材消耗 ✅ |
| 打印中心 `/prints` | 200 | 0 | 無 | 6 個模板 tab、篩選列、空狀態 ✅ |
| 訂單 `/orders` | 200 | 0 | 無 | ✅ |
| 會員 `/members`、沽清 `/soldout`、交班 `/shift`、庫存 `/inventory` | 200 | 0 | 無 | ✅ |
| 線上菜單 `/menu`、客人點餐 `/order`、快餐 `/quick` | 200 | 0 | 無 | 正確顯示「請掃 QR」/「此裝置尚未綁定店鋪」 ✅ |
| 後廚屏 `/kitchen`、出餐台屏 `/expo` | 200 | 0 | 無 | 正確顯示「未經授權：需要 POS 終端憑證」＋重試 ✅ |
| 會員充值 `/topup`、登入 `/login` | 200 | 0 | 無 | ✅ |

- **`pageerror` 總數 ＝ 0**；所有 `console.error` 都係 mock 模式下預期嘅網絡錯誤（已逐條分類過濾）。
- 冇任何頁面出現「正在載入頁面…」/「正在載入門店設定…」卡死標記。
- 伺服器 log 亦確認：**冇任何 500**，Turbopack 冇 compile error（`✓ Ready in 11.4s`）。

### 兩項改動經伺服器 log 直接證實已生效

```
GET /api/pos/state?storeId=66123456&skipQueue=1                      401 ← A5 client 已傳 skipQueue ✅
GET /api/pos/state?storeId=66123456&ordersOnly=1                     401 ← A6 訂單頁已補 ordersOnly ✅
```

### API 契約驗證（8 / 8 ✅，以 `POS_REQUIRE_DEVICE_AUTH=0` 走 mock 分支）

| 檢查 | 結果 |
|---|---|
| 全量 state 帶 `fields` → 回應 keys 同 bytes **完全不變**（fields 只准 ordersOnly 生效） | ✅ 8 keys / 16,271 B 一致 |
| `ordersOnly` 帶 `fields`／垃圾 values → keys 唔可以少 | ✅ 3 keys 一致 |
| 垃圾 `fields` 值（`;,DROP,xyz`）→ 唔可以 500（白名單靜默過濾） | ✅ 200 |
| `skipQueue=1` → 唔可以 500；keys 唔可以變（`queue` 仍然存在為 `[]`） | ✅ |
| 冇 `storeId` → 仍然 fail-safe 回答 | ✅ 200 |
| `limit=99999` / `offset=-1` → **仍然 400**（既有驗證冇被繞過，訊息一字不差） | ✅ |
| `/api/pos/orders`、`print-jobs/status`、`online-order-settings`、`store-status`、`print-templates` | ✅ 全部 200，key 集合不變 |
| 🔒 鑑權閘：**未停用之前，帶新 param 嘅請求一樣 401**（即係新 param 冇繞過閘） | ✅ |

### 🔴 驗證過程中發現並修正嘅真問題（文案同行為不符）

巡 `/reports` 時發現標題仍然寫「**每 3 分鐘自動更新**」，但實際已改成 10 分鐘
⇒ 商家會見到假資訊。已修正 3 處：
- `restaurant-daily-report.tsx:2276` — 改為**由 `AUTO_REFRESH_INTERVAL_MS` 推導**（`每 {N} 分鐘自動更新`），
  日後再改頻率文案都會自動跟，唔會再漂移；重驗已顯示「每 10 分鐘自動更新」✅
- `restaurant-daily-report.tsx:844`、`pos-app.tsx:702`、`print-center.tsx:413` — 更新過時註釋（3 分鐘 → 常數、60 秒 → 180 秒、8 秒 → 30 秒）

### 未能涵蓋嘅部分（誠實說明）

`pos_orders_page` RPC 同三層降級鏈**只由單元測試覆蓋，未經真 DB 驗證** ——
因為本機冇 `.env.local`（無 Supabase 憑證），route 會走 mock 分支，唔會真正查 DB。
⇒ **跑完 migration 0046 之後，請照 `0046` 檔尾嘅「② 語義等價」SQL 核對一次**
（三腿計數 vs RPC 計數必須完全相同）。

---

## 1. 🔴 你提供嘅 Supabase log CSV：完全證實診斷（附實測數字）

樣本：`2026-09-21 03:34:16 → 04:00:38 UTC`（＝**澳門 11:34 → 12:00，午市高峰**），1,000 筆。

### 1.1 按表排名

| 次數 | 佔比 | 每分鐘 | 表 |
|---|---|---|---|
| **218** | 21.8% | 8.26 | `pos_orders` |
| 149 | 14.9% | 5.65 | `pos_print_agents`（打印中繼心跳，1 行／次） |
| 138 | 13.8% | 5.23 | `pos_queue_events`（94 寫 + 44 讀） |
| 135 | 13.5% | 5.12 | `pos_print_jobs` |
| 109 | 10.9% | 4.13 | `pos_online_order_settings`（1 行／次，兩段式查詢） |
| 51 / 45 / 44 | 5.1/4.5/4.4% | — | `pos_device_configs` / `pos_print_templates` / `pos_note_presets`（每次全量 state 都陪拉） |
| 33 / 33 | 3.3% | 1.25 | `pos_store_status` / `pos_shifts` |

### 1.2 `pos_orders` 查詢形狀（**關鍵證據**）

| 次數 | 形狀 |
|---|---|
| **30** | 🔴 **`select=*&order=created_at|updated_at|reopened_at.desc&limit=5000`**（三條一組 × 10 組）<br>→ 即 `fetchServerOrders(storeId, **null**)`：**冇日期下限**、每次最多 5,000 行 ×3 腿 |
| **132** | 🔴 `select=*&order=…&limit=200`（三條一組 × 44 組）<br>→ 即 `/api/pos/state` 全量拉取（`loadRuntimeState` / 訂單頁），**每 36 秒一次** |
| 31 | `select:6欄/9欄 & id=in.()` ← 打印中繼逐張拎單（已投影，良好） |
| 6 | `limit=2000` 三腿（報表頁，樣本期內只出現 2 組） |

### 1.3 由 CSV 反推嘅用量歸因（26.4 分鐘窗口）

| 來源 | 請求數 | 每次行數 | 換算 bytes（實測 per-row） | 佔比 |
|---|---|---|---|---|
| ① 守護 `limit=5000` 三腿 | 30 | 3 × min(S, 5000) | **44 ~ 88 MB** | **38 ~ 55%** |
| ② 全量 state 訂單三腿（limit 200） | 132 | 3 × 200 | 39 MB | 24 ~ 34% |
| ③ `pos_queue_events` limit 300 | 44 | 300 | 22 MB | 14 ~ 19% |
| ④ `pos_print_jobs` limit 200 | 44 | 200 | 10 MB | 6 ~ 9% |
| ⑤ 其他（設定／agents／心跳） | ~300 | 1 ~ 數行 | < 1 MB | < 2% |

（S ＝ 該店 `pos_orders` 總行數；`pos_orders` 1,469 B/行、queue 1,668 B、print_job 1,165 B — 見 `tools/_egen-estimate-20260921.cjs`）

### 1.4 交叉校準（兩個獨立來源互相印證）

- Supabase log：**37.9 PostgREST 請求／分鐘** ＝ 約 54,600／日
- Vercel Usage：**6,238 Function Invocations／日**
- ⇒ **每個 invocation ≈ 8.7 個 PostgREST 查詢** —— 完全對得上「一次全量 state ＝ 7~8 條查詢」
  （3 腿 orders + queue + printJobs + device_configs + print_templates + note_presets）。
- ⇒ 兩邊數字自洽，**診斷坐實**；亦解釋咗「invocations 唔算多但 egress 爆」嘅表面矛盾。

### 1.5 一個先前漏咗嘅發現（順帶，唔關 egress 事）

`pos_online_order_settings` 每次係 **2 條查詢**：先試 5 欄（含 `merchant_enabled`）→ 撞 42703 → 再試 4 欄。
CSV 兩個形狀各 54/55 次 ⇒ **fallback 100% 命中**，即 **migration 0036 未跑**。
👉 **跑 0036 就會自動由 2 條變 1 條**（零程式碼改動）—— 建議同 0044/0045/0046 一齊跑。
同一模式亦出現喺 `pos_note_presets`（0034 未跑）。

---

## 2. 已落實改動清單（逐項：檔案 / 原因 / 驗證）

### 批次 1 — 雲端用量（純內部，行為零改變）

| # | 檔案 | 改動 | 為咩 | 點驗證 |
|---|---|---|---|---|
| A1 | `src/lib/pos-order-row.ts`（新常數）<br>`src/app/api/pos/state/route.ts`<br>`src/lib/pos-orders-range.ts`<br>`src/lib/pos/sync-reconcile.ts`<br>`src/lib/pos/sync-reconcile-daemon.ts` | 加 `?fields=` 白名單（由 `POS_ORDER_DB_COLUMNS` 派生）＋ 守護改傳 `POS_ORDER_VERIFY_SELECT`（`id,status,updated_at,client_updated_at`） | 守護**只**比對 `server.status === order.status`，但舊版每次拉齊 30 欄（1,469 B/行）→ 投影後 **91 B/行（16×）** | 純函式等價性測試（`pos-order-row.test.ts`：額外欄位唔影響 mapper 輸出）＋ 白名單只可含真實欄 |
| A2 | `sync-reconcile-daemon.ts` | `fetchServerOrders(storeId, **null**)` → `computeServerRangeStart(all)` | `null` ＝ 冇日期下限 ＝ 拉全店歷史（峰值 7 MB）。同目錄早有呢個助手（`sync-health-modal` 一直有用），守護漏用。新下限係**工作集嘅超集**（最舊單 −12h） | 推理：每個工作集單嘅 `updated_at ≥ min − 12h`；純函式 `computeServerRangeStart` 邏輯不變 |
| A4 | `sync-reconcile-daemon.ts` | 加 `MAX_PULLS_PER_DAY = 120` 硬閘（Macau 日界） | 堵死「永遠對唔上 ⇒ 每 60 秒拉一世」病態路徑 | 到頂只停拉取＋warn，**唔改任何訂單狀態**（守護本身只補推） |
| A5 | `pos/state/route.ts`<br>`pos-app.tsx` | 加 optional `?skipQueue=1`；v2 outbox 時 client 傳 | v2 之下 client `完全唔 merge` server queue（`:1209`），但 server 照查 300 條（每條 payload ＝整張訂單快照 ≈500 KB） | 唔傳 ＝ 舊行為；沿用既有 `limit(0)` 寫法（同「冇 storeId」同一條 fail-safe 路） |
| A6 | `local-orders-panel.tsx` | 補 `&ordersOnly=1` | 個 panel 只用 `payload.orders`，原本拉足 orders+queue+printJobs（0.98 MB） | 行為等價（該檔只用 orders） |
| C1 | `src/lib/egress-log.ts`（新）<br>`src/lib/egress-log-server.ts`（新）<br>`pos/state/route.ts` | `[egress] pos/state bytes=… orders=… queue=… limit=…` | 令 Vercel log 變成 egress 帳單鏡像，下次唔使再靠推測 | `egress-log.test.ts`：body 必須同 `JSON.stringify` 逐位元一致（header 亦對齊 `NextResponse.json`） |
| C2 | 3 個新測試檔（26 條） | — | 令新邏輯有回歸保護 | 全部通過 |

> 🔴 A1 嘅投影有一個**靜默**失效模式（漏欄 → 唔報錯、只係數字細咗，本專案中過兩次）。
> 所以 `POS_ORDER_DB_COLUMNS` 同 `PosOrderDbRow` 由測試**雙向焊死**：任何人加欄唔加清單（或反之）即刻紅。
> 「多一欄」就會 42703 → 已有**自動降級** `select("*")`（三層降級鏈，見 B1）。

### 批次 2 — 頻率調整（你已同意「全部接受」）

| # | 檔案 | 舊 → 新 | 可感知影響 |
|---|---|---|---|
| A3 | `src/lib/pos/sync-acks.ts` | 對賬 TTL 10 分 → **60 分** | 雲端被回水嘅自動偵測延遲 ≤10 分 → ≤60 分（人手開「同步健康」唔受限制） |
| A7 | `restaurant-daily-report.tsx` | 自動刷新 3 分 → **10 分** | 報表自動更新慢咗；切返分頁／手動刷新照即時 |
| A8 | `print-center.tsx` | 8 秒 → **30 秒** | 雲端打印結果顯示最多遲 30 秒；**出紙完全唔經呢條輪詢**（由 2.5 秒本機 tick 驅動） |
| A9 | `lib/topup/pending-count-store.ts` | 30 秒 → **5 分**（fast 12 秒 → 60 秒）＋**回到前景即時補拉** | 充值待審紅點最多遲 5 分鐘；回到前台即時更新 |
| A10 | `pos-app.tsx` | 班次同步 60 秒 → **180 秒** | 另一部機開工／收工最遲 3 分鐘反映；`focus`／`online` 照即時 |
| A11 | 同上（常數已覆蓋） | members 頁 fast 12 秒 → 60 秒 | 同上 |

**全部保留原常數數值於註釋**，要回滾只需改一個數字。

### 批次 3 — 查詢層重構

| # | 檔案 | 改動 | 為咩 | 驗證 |
|---|---|---|---|---|
| B1 | `supabase/migrations/0046_pos_orders_page_rpc.sql`（新） | 新增 `pos_orders_page()`：**一條 SQL 做 OR + 去重 + 排序 + 分頁**，語義逐項對齊舊三腿（含 null 邊界） | 舊三腿每頁回 3 份、client 再去重 ⇒ 付 3 倍 bytes。CSV 實測 30 次 `limit=5000` 三腿 ＝ 最大單一來源 | migration 內附 5 條唯讀驗證 SQL（含「三腿 vs RPC 計數必須相同」） |
| B1 | `src/lib/pos-orders-range.ts` | 首選 RPC；**三層降級**：① RPC 唔存在（PGRST202/42883）→ 三腿 ② 投影撞未跑 migration 嘅欄（42703/PGRST204）→ `select("*")` ③ 真 DB 錯誤 → **唔降級**，如實上報 | 未跑 0046 都唔會壞；但真錯誤唔可以被靜默吞成「今日冇單」 | `pos-orders-range.test.ts`（14 條）：降級方向、唔可以撈埋欄位/函數錯誤、真錯誤必須上報、三腿去重排序 |
| B1 | `src/lib/pos/orders-range-shared.ts`（新，零 import） | 抽出純決策邏輯（`mergeOrderLegs` / `classifyOrdersRangeFailure` / `decideReopenedLegOutcome`） | 專案規則：可測模組必須零 import（`server-only` 令 `node --test` 載入唔到 I/O 檔）⇒ 唔抽就完全冇回歸保護 | 14 條測試直接覆蓋 |
| B2 | `pos-orders-range.ts` 預設投影 | `select("*")` → `POS_ORDER_DB_SELECT` | 一次改動覆蓋 `/api/pos/state`（ordersOnly）、報表、`/api/admin/orders` **三條路徑** | 等價性已由 `pos-order-row.test.ts` 證明；兩個呼叫端都係用 `mapOrderRow`（已核對） |
| B4 | 未跑嘅 migration | 建議你跑 **0036 / 0044 / 0045 / 0046** | 0036 令 `online-order-settings` 由 2 查詢變 1；0044 為三腿/RPC 加索引；0045 令出紙去重生效 | 各 migration 檔內已有驗證 SQL |

### 🔴 B2 嘅**刻意收窄**（同你講清楚）

範圍稿寫住「全域 `select("*")`」，我**只做咗 `pos_orders` 路徑**（＝成本 99% 集中喺嗰度），
其餘 **唔改**，理由係風險／回報比：
- `pos/orders` GET（`pos_orders`）— CSV 未見任何呼叫（註釋亦寫明倉內冇 in-app GET），省唔到流量但同樣有漏欄風險；
- `kds-server`（KDS 已停用）／`salon/state`（未使用）／`admin_*`／`inventory_*` — 量極低。

**呢個係刻意的取捨，唔係漏做。** 如果你要「真・全域」，我可以再開一批（每個檔都要逐欄核對 mapper）。

---

## 3. 改動檔案清單（17 個改 + 5 個新）

**新增**：`src/lib/egress-log.ts`、`src/lib/egress-log-server.ts`、`src/lib/pos/orders-range-shared.ts`、
`src/lib/pos-order-row.test.ts`、`src/lib/egress-log.test.ts`、`src/lib/pos-orders-range.test.ts`、
`supabase/migrations/0046_pos_orders_page_rpc.sql`、`tools/_analyze-supabase-logs-20260921.cjs`

**修改**：`src/lib/pos-order-row.ts`、`src/lib/pos-orders-range.ts`、`src/lib/supabase-errors.ts`、
`src/lib/pos/sync-reconcile.ts`、`src/lib/pos/sync-reconcile-daemon.ts`、`src/lib/pos/sync-acks.ts`、
`src/lib/topup/pending-count-store.ts`、`src/app/api/pos/state/route.ts`、`src/components/pos-app.tsx`、
`src/components/local-orders-panel.tsx`、`src/components/print-center.tsx`、`src/components/restaurant-daily-report.tsx`

---

## 4. 預期降幅（改動前 → 改動後）

| 路徑 | 改動前（CSV 實測推算） | 改動後 | 機制 |
|---|---|---|---|
| 守護全店拉取 | 44 ~ 88 MB／26 分 | **< 0.1 MB／26 分** | 日期下限 ＋ 投影 16× ＋ TTL 1/6 |
| 全量 state 訂單三腿 | 39 MB／26 分 | ~9 MB／26 分 | 1 條 RPC（省 2/3）＋ 投影 |
| queue 300 條 | 22 MB／26 分 | **0** | `skipQueue=1` |
| printJobs 200 條 | 10 MB／26 分 | 10 MB（本批未動） | — |
| 充值 badge 輪詢 | ~1,440 invocations／日 | ~290／日 | 30 秒 → 5 分（＋回前景補拉） |
| 打印中心（開頁時） | 450 輪／小時 | 120 輪／小時 | 8 秒 → 30 秒 |
| 報表（開頁時） | 20 輪／小時 | 6 輪／小時 | 3 分 → 10 分 |
| **合計** | **最高 ~1.47 GB／日（實測）** | **估 < 0.15 GB／日** | |

> ⚠️ 呢個係**推算**。真正嘅驗收要睇改動部署後 24 小時嘅 Supabase Egress 曲線
> ＋ Vercel Usage 對比；另外 `[egress]` log 會令你之後可以直接加總。

---

## 5. 未做 / 待你決定

1. **跑 migration（只有你可以做）**：0036 → 0044 → 0045 → 0046。
   全部 idempotent，每個檔尾都有唯讀驗證 SQL（特別係 0046 嘅「三腿 vs RPC 計數必須相同」）。
2. **`printJobs` 200 條嘅投影／增量**（每次全量 state 陪拉 234 KB）— 本批刻意未動
   （投影只省到 ~10%，因為 mapper 真係要 `items`；要再省就要改「增量拉」語義，屬行為改動）。
3. **全量 state 拉取次數**（CSV：每 36 秒一次，因為`每張單 enqueue` 都觸發）
   — 加 30 秒去抖可以再省 ~40%，但屬「新鮮度取捨」，未經你確認，未做。
4. **真・全域 `select("*")` 投影**（見 §2 末）。
5. **`pos_print_agents` 心跳**（149 次／26 分）— payload 只有 1 行（~200 B），
   係**請求數**而唔係 bytes 問題；要省就要改中繼 APK 心跳頻率（超出 POS 前端範圍）。

---

## 6. 回滾方法

| 想還原 | 做法 |
|---|---|
| 全部 | `git revert` 呢批 commit（未 commit，可 `git checkout -- .` 丟棄） |
| 只還原 RPC | `src/lib/pos-orders-range.ts` 註釋 `runRpc()` 呼叫；或 `drop function public.pos_orders_page(...)` |
| 只還原守護 | `localStorage['macau-pos/sync-reconcile-daemon'] = '0'`（終端即停） |
| 只還原頻率 | 改返各檔註釋標明嘅原值（TTL `10*60*1000`、報表 `3*60*1000`、打印中心 `8000`、badge `12_000/30_000`、班次 `60_000`） |
| 只還原投影 | `fetchOrdersInRange({ columns: "*" })`，或 terminal 傳 `columns: "*"` |
| 只還原 egress log | 環境變數 `POS_EGRESS_LOG=0` |

---

## 7. 部署後 24 小時驗收清單

☐ Supabase → Usage（filter＝macauPos）→ PostgREST 日曲線應跌 80%+
☐ Vercel → Usage → Function Invocations 應跌 ~40%（6,238 → ~3,700／日）
☐ Vercel Logs 搜 `[egress]` → 加總 bytes，逐條對上榜
☐ Vercel Logs 搜 `migration 0046 未跑` → 跑完 0046 之後呢句應該消失
☐ Vercel Logs 搜 `欄位投影失敗` → 若出現即代表有欄未跑 migration（會自動降級，唔會壞）
☐ 功能煙霧：收銀開機 → 落單 → 廚房單 → 結帳 → 收據 → 加菜 → 退菜 → 免單 → 返結（「已返結 ×N」）
  → 交班數字 vs 報表數字 → 訂單頁見另一部機嘅單 → 打印中心狀態 → 充值紅點
