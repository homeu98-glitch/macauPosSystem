# 155 · Ledger offline report 需求盤點與補回方案（2026-10-08）

> **狀態：P0 已完成並上線**（commit `20952f3`，Vercel 部署 `success`）。
> 其餘等 J 確認後先動 code。

## 0.5 🆕 2026-10-08 更新（J 已回覆部分問題）

| 問題 | J 嘅答覆 | 結論 |
|---|---|---|
| Q2：0066 係咪已重跑 | 「我直接一整條跑了」 | ✅ 確認已跑（含兩條 CTE 漏欄 fix） |
| Q4：平台單算唔算 Ledger 線上營收 | **「算」** | 🔴 已寫入對外契約：Ledger **唔可以**再把 `kpi.onlinePlatform` 加落自己嘅平台數（會雙重計） |
| Q5：grabber 單有冇未投影 | 「反正 pos_orders 的單子都放上去」 | ✅ 唔使改，0066 只讀 `pos_orders` 就夠 |
| Q3：Ledger 讀新 key 嘅進度 | 「不確定」 | 🔴 **呢個就係「未見到新數據」最可能嘅原因**（見 §0.6） |
| Q1：`kpiByChannel` 形狀 | **未答** | 🔴 因為 code 已上線，呢條而家變得**緊急** |

### 0.6 點解 push 咗都「未見到尋日嘅數」

已排查，我哋呢邊**全部正常**：

| 檢查 | 結果 |
|---|---|
| commit `20952f3` 已 push | ✅ HEAD 有 39 處 `dishesByChannel` |
| Vercel 部署 | ✅ `success` |
| 兩個 route 活着 | ✅ `/api/integration/ledger/offline-report` → 401（無簽名，正確） |
| **尋日（2026-10-07）有冇單** | ✅ **36 張 / MOP 2,823**（線下 23＋投影 11＋平台 2） |
| 今日（2026-10-08） | ⚠️ **0 張** |

⇒ 所以「冇見到」只可能係以下其中一個，要你確認：

1. **Ledger 嗰邊未開發讀新 key**（Q3 不確定）—— additive 設計下，
   我哋出咗新 key 佢哋 UI 都唔會顯示。呢個係**最可能**。
2. **報表預設睇「今日」** —— 今日 0 單，所以空白。要手動揀 10-07。
3. 真係有 bug —— 要你畀截圖／實際日期我先可以再查。

**逐日實測**（事件時間四腿 + Asia/Macau）：

```text
2026-10-05   30 張（29 settled）  線下 20 / 投影 6 / 平台 4   MOP 1,781
2026-10-06   28 張（28 settled）  線下 23 / 投影 2 / 平台 3   MOP 2,064
2026-10-07   36 張（36 settled）  線下 23 / 投影 11 / 平台 2  MOP 2,823
```

### 0.7 🔴 關鍵澄清：**我哋 push 唔會令 Ledger 畫面變**

兩個係**各自獨立**嘅系統：

| 系統 | 部署方式 | 狀態 |
|---|---|---|
| **macauPosSystem**（我哋） | 我哋 commit/push → Vercel 自動部署 | ✅ 已完成（`20952f3` success） |
| **Ledger**（另一個系統） | **佢哋自己** commit/push → 佢哋自己部署 | ❌ 未做（Q3 不確定） |

我哋嘅 push **只會**令我哋嘅 API 多回六個新 key；
Ledger 嘅畫面係佢哋自己嘅 code 砌嘅，**唔會因為我哋 push 而變**。

**而且 —— 舊卡數字「冇更新」係啱嘅**，呢個正正係方案 A 嘅鐵律
「舊欄一個數字都唔可以變」。線上數據全部去咗新 key。

#### 尋日（2026-10-07）我哋實際會出嘅數（`tools/probe-offline-report-day.cjs` 實跑）

**舊欄（Ledger 現有嗰張卡讀呢組 —— 應該同事故前一模一樣）**：

```text
kpi.orderCount      25 張
kpi.revenueAvos     MOP 2,161.00
byPayment           Mpay MOP 1,553 ＋ 會員餘額 MOP 484 ＋ 外賣平台 MOP 124
orders[]            25 張 ｜ dishes[]  30 款
```

👉 **如果 Ledger 顯示嘅係呢組數，即係一切正常**，唔使做任何嘢。

**新 key（要 Ledger 自己寫 code 讀先會顯示）**：

```text
kpiByChannel.offline         23 張   MOP 2,037
kpiByChannel.online          11 張   MOP   662
kpiByChannel.onlinePlatform   2 張   MOP   124      （23 + 2 = 25 ✓ 對返舊 kpi）
ordersByChannel[]            36 張 ｜ dishesByChannel[]  31 款
paymentBreakdown[]            7 行
```

#### 所以要見到線上／線下拆分，要做嘅係：

1. 交 `docs/integration/pos-offline-report-channel-addendum-2026-10-07.md`（v2 契約）畀 Ledger
2. 佢哋讀 **`x-pos-offline-report-caps`** 標頭；見到
   `kpiByChannel` / `paymentBreakdown` / `ordersByChannel` / `dishesByChannel` 就用新 key
3. **佢哋**開發 ＋ 部署，畫面先會變
4. ⚠️ 按 Q4 拍板：平台單歸佢哋線上營收 ⇒ 唔好再把 `kpi.onlinePlatform` 加落自己嘅平台數

---

## 0. 一句話結論

**你見到「畫面正常顯示」＝ 舊欄還原成功，但六個新 key 一個都未出。**

原因：SQL（0066）已經喺 production 跑咗，但 **code 完全未 commit** ——
`git show HEAD:src/lib/pos/offline-report.ts | grep -c dishesByChannel` = **0**，
而工作區檔案有 **39** 處。即係 Vercel 上跑嘅仲係舊 code，只識讀五個舊欄。

所以需求 **1／2／3／4／5 嘅程式碼全部寫好咗、亦本地驗證通過，但未交付**。

---

## 1. 原始需求清單 × 目前狀態

原始需求（你嘅第一則訊息）：

> 擴充現有 ledger 的 offline report，讓它同時涵蓋線上與線下資料：
> 1. 菜品統計：目前 report 只統計線下菜品，需把線上訂單的菜品也納入，
>    並明確標示或分開呈現線上/線下的區別。
> 2. 訂單統計：目前只顯示線下訂單，需補上線上訂單資料，
>    並新增一個欄位（column）用來標示該筆訂單來源為線上或線下。
> 3. 支付的分類也跟我們 macau-pos 的一樣補上。

其後補充嘅拍板：三種全包（KPI 拆三邊）、每款菜加線上/線下數量同金額欄、
支付方式要係 **macau-pos 嗰張「支付方式分項（店內 POS 線下）」卡**、
照舊 additive ＋ caps 標頭探測、包埋最新 grabber 訂單、事故後拍板 **方案 A**。

| # | 需求 | 預期行為 | 驗收標準 | 程式碼 | 已上線 |
|---|---|---|---|---|---|
| 1 | 菜品統計納入線上＋分開呈現 | 新 key `dishesByChannel[]`，七欄（總數＋四個拆欄） | 63 款 / Σqty 225 / Σrev 667,600；每行 `offlineQty+onlineQty === qty`；金額同理 | ✅ 完成 | ❌ **未** |
| 2 | 訂單統計補線上＋來源欄位 | 新 key `ordersByChannel[]`，每列帶 `channel`；舊 `orders[]` 加 `channel` | 93 張；`ordersByChannelTotal − ordersTotal = 19`（線上投影） | ✅ 完成 | ❌ **未** |
| 3 | 支付方式分類同 macau-pos | 新 key `breakdown.paymentBreakdown[]` | 欄位係 POS `PaymentMethodBucket{receivable,paid,count}` 嘅**超集**；`ΣpaidAvos`（排除 `online_projection`）= 547,100 | ✅ 完成 | ❌ **未** |
| 4 | additive ＋ caps 標頭探測 | `v` 維持 1；`x-pos-offline-report-caps` 宣告新能力 | 新 key 全有／全無；部分有 ⇒ 503 | ✅ 完成 | ❌ **未** |
| 5 | 三種全包（offline / online_projection / online_platform） | KPI 拆三邊 | offline 66/477,200、online 19/119,700、platform 8/69,900；`offline+platform = 舊 kpi 547,100` | ⚠️ **形狀有爭議**（見 §3 Q1） | ❌ **未** |
| 6 | 包埋最新 grabber 訂單 | `source ∈ (aomi, mfood)` 要計入 | 平台單 settled 8/69,900 已喺數入面 | ✅ 完成 | ✅ **已生效** |
| 7 | 舊欄一個數字都唔可以變（方案 A 鐵律） | `kpi`／`byPayment`／`orders[]`／`dishes[]` 全部還原 0060 口徑 | 74 / 547,100 / 74 / 58 / 198 / 549,900 | ✅ 完成 | ✅ **已生效** |

**已完成但未上線嘅技術驗證**（本地 PGlite 落真實 production 94 行實跑）：
`tools/verify-offline-report-rpc.cjs` → **30 條恆等式全綠**，數字同獨立取證探針逐位相同。

---

## 2. 遺漏／待補清單

| 項目 | 原本預期 | 而家嘅實際 | 驗收標準 |
|---|---|---|---|
| **A. code 未交付** | push 後 Vercel 部署，六個新 key 出現 | HEAD 完全冇新 key | `curl` 回應有 `paymentBreakdown`／`ordersByChannel`／`dishesByChannel`；`caps` 標頭含四項 |
| **B. `kpiByChannel` 形狀不一致** | 對外契約＋caps 標頭寫嘅係**頂層** `kpiByChannel` | code 實際出嘅係**嵌套** `kpi.offline / kpi.online / kpi.onlinePlatform`，**冇頂層 `kpiByChannel`** | Ledger 按 caps 去搵 `kpiByChannel` 會搵唔到 ⇒ 要二選一並統一文件 |
| **C. production 驗收未跑** | `supabase/verify/0066_verify_production_20261007.sql` 14 條 | 之前跑嗰次係**函數壞咗**（CTE 漏欄），結果作廢 | 14 條全部符合期望（尤其第 ⑧ 條單向包含四個值） |
| **D. 對外契約未交付 Ledger** | 交 v2 增補，佢哋先可以開發讀新 key | contract 只喺我哋 repo | Ledger 確認收到並開始／已完成開發 |
| **E. `byPayment` 冇 label 翻譯**（可選） | 支付 bar 唔應該出現英文 | v1 `byPayment` 只用 raw `payment_method` | 視乎 Ledger 需要；改 array element 形狀有鐵律風險 |

---

## 3. 🔴 需要你補充說明嘅問題（有衝突／唔完整）

### Q1（必須答）`kpiByChannel` 要頂層定嵌套？

兩邊文件**自相矛盾**：

- `docs/integration/pos-offline-report-channel-addendum-2026-10-07.md`：
  「六個 key」入面列咗 **`kpiByChannel`**（頂層）
- 同一份文件另一段又寫：「渠道總覽 → `kpi.offline` / `kpi.online` / `kpi.onlinePlatform`」（嵌套）
- `docs/154`：`kpiByChannel` 出現 7 次、`kpi.offline` 出現 9 次 —— 同樣兩邊都寫
- `OFFLINE_REPORT_CAPS_CHANNEL`（`offline-report.ts:135`）宣告嘅係 **`kpiByChannel`**
- 實際 response（`offline-report.ts:804-806, 918`）出嘅係 **`kpi.offline/online/onlinePlatform`**，
  `OfflineReportResponse` 型別**冇**頂層 `kpiByChannel`

👉 即係 **caps 宣告咗一樣冇俾嘅嘢**。要揀一個：
- **(a) 維持嵌套**：改 caps 標頭（唔宣告 `kpiByChannel`）、改對外契約，Ledger 讀 `kpi.offline`。
  優點：唔使改 response 形狀；缺點：要改已寫好嘅 contract。
- **(b) 加返頂層 `kpiByChannel`**：response 多一個 key（additive，零風險），caps 同名不用改。
  缺點：同一份數據出現兩次（`kpi.offline` 同 `kpiByChannel.offline`）。

我偏向 **(b) 加返頂層**：成本最低、contract 唔使改、對舊 Ledger 零影響。
但如果你覺得「一份數據兩個地方」會令日後維護混亂，就揀 (a)。

### Q2 0066（含兩條 CTE 漏欄 fix）係咪已經重跑？

你話「畫面已經能正常顯示」—— 我推測係跑咗，但想確認。
（未跑嘅話現在跑嘅仲係壞函數，而畫面正常只可能係 Ledger 降級顯示。）

### Q3 Ledger 嗰邊讀新 key 嘅 code 寫成點？

- 佢哋**已開發完**？→ 我一 push 佢哋就見到新欄，要一齊驗。
- 定係**等我交 contract 先開發**？→ 咁 push 落去佢哋暫時冇影響（additive 安全），
  但要排期交 `docs/integration/pos-offline-report-channel-addendum-2026-10-07.md`。

### Q4 平台單（`online_platform`）算唔算 Ledger 嘅「線上營業額」？

⚠️ 記憶 §1 有個已知陷阱：**Ledger 自己嘅 `public.orders` 已經有平台單**。
如果佢哋把 `kpi.onlinePlatform` 當「線上」加落自己嘅線上營收，會**重複計算**。
呢點喺 contract 有冇講清楚要再確認（`flags.ledgerOwnsOnlineRevenue` 就係為咗提示呢個）。

### Q5 grabber 單有冇「未投影」嘅情況？

0064 起咗 `pos_grabber_inbox`（原始落地表），註解寫「入 `pos_orders` 由 worker / 後續步驟做」。
而 0066 **只讀 `pos_orders`**（`from public.` 只有 `pos_orders`）。
如果 grabber 收單後投影有延遲，報表會**暫時睇唔到最新嗰批**。
👉 要唔要納入 inbox 未投影嘅單？（我估唔使，但要你確認投影係即時定延後）

### Q6 `byPayment` 要唔要補 `label` 翻譯欄？（可選）

v1 `byPayment` 用 raw `payment_method`。因為 `byPayment` 排除咗 `online_order_id`，
Ledger enum（`in_store`/`balance`）基本上唔會出現，所以而家冇事。
但要加 `label` 亦係 additive —— 只不過會改 array element 形狀，同「舊欄唔郁」有張力。
建議**唔加**（維持鐵律），除非 Ledger 投訴見到英文。

---

## 4. 建議補回步驟（按優先序）

### P0 · commit ＋ push（解鎖需求 1–5）

程式碼已經本地驗證通過（184/184 tests、tsc 0、30 條恆等式、SQL 語法全過），
而且**純 additive**，對現有 Ledger 零影響。

```
涉及檔案（只 commit 呢啲，唔好帶埋臨時探針）：
  src/lib/pos/offline-report.ts
  src/lib/pos/offline-report.test.ts
  src/lib/pos/offline-report-guard.test.ts
  src/app/api/integration/ledger/offline-report/route.ts
  supabase/migrations/0066_pos_offline_report_channel.sql
  supabase/verify/0066_verify_production_20261007.sql
  tools/verify-offline-report-rpc.cjs
  tools/check-offline-sql.py
  tools/_probe-offlinereport-truth-20261007.{cjs,json,out.txt}
  docs/154-*.md、docs/integration/*.md
```

⚠️ push 前用記憶入面嘅 **PortableGit PATH ＋ 內聯憑證助手**做法（`git push` 會無聲掛住）。

### P1 · 解決 `kpiByChannel` 形狀衝突（等 Q1 答案）

- 揀 (b)：`OfflineReportResponse` 加 `kpiByChannel?`；`buildOfflineReportResponse` 輸出；
  route 傳 `validated` 入面嘅渠道 KPI；加**行為測試**（唔係守代碼字串）。
- 揀 (a)：改 `OFFLINE_REPORT_CAPS_CHANNEL` 唔宣告 `kpiByChannel`；改兩份 contract 文件。

### P2 · 跑 production 驗收 SQL ✅ **已完成（本地真跑）**

`supabase/verify/0066_verify_production_20261007.sql` —— **16 條語句全部執行成功**
（14 條實質檢查 + 2 條 `set role` 本地跳過，要喺 Supabase 驗）。

🔴🔴 **第一次交畀你跑係坏嘅**（`42703: column "p" does not exist`），
原因同 0066 嗰兩條 CTE 漏欄一模一樣：**我只跑咗語法檢查，冇真正執行過**。
而家加咗 `tools/verify-offline-report-sql-runtime.cjs`（PGlite 落 production 94 行逐條跑），
一捉就捉到**三個**語法檢查睇唔到嘅 bug：

| # | 語句 | bug | 修法 |
|---|---|---|---|
| 1 | ⑥ | `jsonb_array_elements(...)` **漏咗 `as p`** | 補 alias |
| 2 | ⑫ | `bool_and(... lag(...) over () ...)` ＝ **aggregate 包 window function**，Postgres 直接拒 | `with ordinality` 記次序，先 window 後 aggregate（分兩層） |
| 3 | ⑫ | `lag(...) over ()` **冇 ORDER BY** ⇒ 次序未定義，驗咗等於冇驗 | `lag(rev) over (partition by which order by ord)` |
| 4 | ⑫ | 比較方向**寫反咗**：註解話「單調不升」，代碼寫 `rev >= lag(rev)`（＝升序） | 改 `rev <= prev` |
| 5 | ⑧ | `platform_only_dishes` 計反方向（58−63 = **−5**） | 改 `ch − legacy`，改名 `online_only_dishes`（實測 5） |

本地實跑結果（production 94 行）：

```text
② kpi_n=74  kpi_rev=547,100  byPayment_sum=547,100  orders=74  dishes=58/198/549,900
⑤ 六個 key 全 true；obc_len=93=obc_total；dbc_len=63=dbc_total
⑥ legacy=74  all=93  online_only=19  n_projection=19
⑦ rows=63  qty_mismatch=0  rev_mismatch=0  complete=63
⑧ legacy_rows=58  ch_rows=63  missing_in_new=0  new_only_with_offline=0
   legacy_smaller=0  online_only_dishes=5
⑨ offline 66/477,200  online 19/119,700  platform 8/69,900  legacy_kpi_n=74
⑩ pb_paid_sum=666,800  kpi_rev=547,100
⑪ 兩行 diffAvos<0（in_store −1,800 / balance −200）
⑫ legacy ok=true、byChannel ok=true
⑬ top-level 20 個 key（含 kpiByChannel）
```

👉 你喺 Supabase 跑嗰陣，對上面呢組數字就得。

### P3 · 交付對外契約畀 Ledger

交 `docs/integration/pos-offline-report-channel-addendum-2026-10-07.md`（v2），
並明確 Q4 嘅重複計算警告。

### P4 ·（可選）`byPayment` label

等 Q6 答案。

---

## 5. 需要調整嘅檔案／模組 ＋ 風險副作用

| 檔案／模組 | 改動 | 風險／副作用 |
|---|---|---|
| `src/lib/pos/offline-report.ts` | P1：加 `kpiByChannel` 輸出（若揀 b） | 低。純 additive，舊欄唔郁。🔴 但**唔可以**順手改任何舊欄數值（方案 A 鐵律） |
| `src/app/api/integration/ledger/offline-report/route.ts` | P1：傳 `kpiByChannel` 落 builder | 低。🔴 唔好加 `posRouteAuthGuard()`（會即 401，成張卡變「暫時無法取得」） |
| `offline-report.test.ts` / `-guard.test.ts` | P1 加行為測試 | 低。要守**行為**唔好守代碼字串（記憶 §6.1） |
| `supabase/migrations/0066_*.sql` | 已修好（兩條 CTE 漏欄），**唔好再改邏輯** | 🔴🔴 任何改動都要重新跑 `tools/verify-offline-report-rpc.cjs` —— `create or replace` 只驗語法，語法過 ≠ 可以跑 |
| `docs/integration/*.md` | P1/P3 統一 `kpiByChannel` 寫法 | 低。但要確保兩份文件講同一件事 |
| `supabase/verify/*.sql` | 唔改 | 🔴 唔可以搬返落 `migrations/`（會被 `db push` 用 postgres role 執行而失敗） |

**全域風險**：
1. 🔴 **任何 SQL 改動都要本地真跑** —— 今次兩條 CTE 漏欄就係「SQL Editor 報 Success 但函數係壞嘅」。
2. 🔴 **commit 前必須 `git status --porcelain` 分清楚 `??` 同 ` M`／` D`** ——
   上輪清理臨時檔誤刪咗 3 支已 commit 嘅歷史 probe。
3. ⚠️ push 後 Vercel 自動部署；若 Q1 未定，建議 P0 同 P1 一齊做，避免部署兩次。

---

## 6. 完成後嘅驗證方式

| 層面 | 點驗 | 通過條件 |
|---|---|---|
| 單元 | `node --test src/lib/pos/offline-report.test.ts src/lib/pos/offline-report-guard.test.ts` | 全綠（現 184；P1 後應更多） |
| 型別 | `node node_modules/typescript/bin/tsc --noEmit` | 0 error |
| SQL 語法 | `python tools/check-offline-sql.py` | 全 OK（**只係語法，唔係「可以跑」**） |
| 🔴 SQL 行為 | `NODE_PATH=<ws>/node_modules node tools/verify-offline-report-rpc.cjs` | 30 條恆等式全綠 |
| production | 跑 `supabase/verify/0066_verify_production_20261007.sql` | 14 條符合 |
| 上線後 | 打 Ledger 嗰條 API（或叫佢哋報） | 回應有六個新 key；`caps` 標頭含四項；**舊欄數字同而家一樣** |

🔴 **最重要嗰條**：上線後要對一次
`kpi.orderCount=74`、`revenueAvos=547,100`、`dishesTotal=58` ——
**呢三個數一變就即係又踩咗鐵律，要即刻 rollback。**
