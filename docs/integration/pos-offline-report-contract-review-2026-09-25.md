# 契約審視：Ledger「線下營業摘要 API」v1（POS 側立場）

> **日期**：2026-09-25
> **審視對象**：`pos-offline-report-api.md`（Ledger 2026-09-24 發出，ADR-040）
> **狀態**：✅ **2026-09-25 已拍板並實作完**（RPC `0058` ＋ route ＋ 測試；`dineIn/quick` 唔出、線下 `paid` 要計）
> → 實作記錄：[`docs/150-ledger-offline-report-route.md`](../150-ledger-offline-report-route.md)｜回覆 Ledger：[`pos-offline-report-reply-2026-09-25.md`](./pos-offline-report-reply-2026-09-25.md)
> **立場**：方向同意（Ledger 按需拉、POS 被呼叫、不落地不快取），但**契約有 5 處同 POS 現實唔一致，照抄會出錯數**，要先改契約再落碼。
> **現狀**：POS 側**一行都未做**（`src/app/api/integration/ledger/offline-report/` 唔存在、`.env.example` 冇 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`、冇任何測試）。
> **生產數據**：全部由唯讀探測實取（`tools/_probe-offlinereport-20260925.cjs`、`_probe-offlinereport2-20260925.cjs`，同日 `.out.txt`）。

---

## 1. 一句話結論

契約要求嘅係「**一支唯讀 GET route**」，POS 做得到，而且唔需要新依賴、唔需要新 Supabase 連線、唔需要出任何 DB 憑證。
但有兩件事要 Ledger 先修契約：**① 口徑要照 POS 唯一真源寫（唔可以另立一套）② `build_full_report()` 呢條路在正式環境唔成立**。

---

## 2. 契約 vs POS 現實：5 個出入（必須修）

| # | 契約寫法 | POS 現實（已驗證） | 影響 | 建議 |
|---|---|---|---|---|
| 1 | 時間歸屬 = `settled_at`，缺則 `updated_at` | 唯一真源 = `orderEventInstant()`：`settled_at → reopened_at → updated_at → created_at`（`src/lib/pos/order-event-time.ts:80`，0057 落地） | 漏 `reopened_at` 腿 ⇒ 有返結紀錄但 `settled_at` 為 NULL 嘅單（舊 client／未 backfill 嘅店）會歸錯日 | 契約改寫成四腿；POS 側照 `orderEventInstant()` 實作 |
| 2 | 計入 `status ∈ {settled, paid}`，排除 `refunded / partially_refunded` | 同 | 但 `docs/113 §報表` 寫「只計 `settled`（線下）／帶 `onlineOrderId` 嘅 `paid`」，而 code 係 `paid` **一律**計（`restaurant-daily-report.tsx:399-403`） | POS 內部先確認一次；實作跟 code（＝同 `/reports` 一致，滿足驗收條款） |
| 3 | `breakdown.dineIn / quick` | **POS `/reports` 冇呢個維度**。POS 只拆「線上／線下」；「堂食／快餐」只用於出餐時長同人流 | 新發明嘅口徑 ⇒ 第一次對數一定對唔上 | 要麼 v1 唔出呢個 breakdown，要麼明確定義：`table_id === 'counter'` → quick，其餘 → dineIn |
| 4 | `kpi.covers` = `party_size` 加總 + 快餐每單 1 | 同（`restaurant-footfall.ts:118-131`：counter 一單 1 人、堂食 `max(1, party_size ?? 1)`） | ⚠️ 唔可以用報表 `Agg.covers`（`Σ party_size`，快餐一律 0） | 契約補一句「＝ POS『當日人流』卡口徑，且**只計線下單**」 |
| 5 | `byPayment[].method` = 1–32 字字串 | 實際值域係**開放字串**，實測：`現金`、`Mpay`、`中銀`、`會員餘額`、`外賣平台`，仲有**組合值** `"會員餘額 + Mpay"`（同一張單兩種付款） | Ledger 若 map 成固定清單 → 組合值／新付款方式會顯示唔到或顯示錯 | Ledger **照原字串顯示**；POS 側長度上限放寬或截斷要寫清楚 |

### 2.1 一定要排除線上投影（實測證明）

主店 `8291f843-…`，澳門 2026-09-24：

| 口徑 | 張數 | 金額 |
|---|---|---|
| `settled\|paid` 全部 | 35 | MOP 2,239 |
| 其中 `online_order_id` 非空（線上投影） | 8 | MOP 392 |
| **線下（契約要嘅數）** | **27** | **MOP 1,847** |

唔排除就會同 Ledger 自己嘅線上數**重複計 392 MOP**。同日 `byPayment`（線下）：`Mpay 1,532`、`現金 231`、`會員餘額 84`。

---

## 3. 契約 §口徑「用 `docs/sql/94` 嘅 `build_full_report()`」—— 呢條路**跑唔到**

- `report_ro.build_full_report()` 全部聚合都係由 **83 號嗰 22 個 `report_ro.v_*` view** 砌出嚟（`docs/sql/94-ledger-report-api.sql` Part A）。
- 但 83 號嘅角色 + `report_ro` schema **從未在 production 建立**（2026-09-04 回覆 §0，已雙方確認）。
- ⇒ 冇跑 83 就 `create` 唔到呢個 function，所以「改用 `security definer` + `service_role` 呼叫就得」**實際上唔成立**——問題唔在權限，在 **view 唔存在**。

**建議**：唔要為呢支 route 拉 83 落嚟（等於把 2026-09-04 否決嘅整套唯讀角色重新引入）。另寫一支**只算契約需要嘅 KPI** 嘅聚合 function（見 §5），body 直接讀 `public.pos_orders`，唔經任何 view。

---

## 4. 安全設計（照契約，但補 4 點）

| 項目 | 做法 |
|---|---|
| Secret | `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（POS 側），**唔可以** fallback 落 `LEDGER_WEBHOOK_SECRET`（唔同方向、唔同用途，2026-09-04 Q3 已拍板分開）。未設 → **500 fail-closed**（唔放行無簽名請求） |
| 驗簽 | `X-Ledger-Timestamp` 5 分鐘窗（秒／毫秒都收）＋ `HMAC-SHA256(secret, ts + ".GET" + "." + pathname+search)`；**先用 `/^[0-9a-f]{64}$/i` 擋長度**（`Buffer.from(hex)` 會靜默截斷壞尾碼），再 `timingSafeEqual` |
| 組字串 | **唔可以重排 query、唔可以 decode 再 encode**：直接 `request.nextUrl.pathname + request.nextUrl.search` |
| 授權閘 | 🔴 呢條 route **刻意唔行 `posRouteAuthGuard()`**（server-to-server，冇 POS 終端憑證）。要喺鑑權清單／文檔標明呢個例外，否則日後審計會當佢係漏網端點 |
| 限流 | 每 `storeId` 30 次／分鐘（in-memory Map，本專案既有做法：`auto-accept/route.ts:24-39`）。Vercel 多實例下係 best-effort，但 Ledger 有 session cache，正常一次進頁一次 |
| 404 | `storeId` 從未出現在 `pos_orders` → `404 store_not_found`（存在性檢查**唔加**線上單過濾） |
| 唔會渲染假零 | 任何欄位型別唔對 → 整包丟棄；**RPC 未部署／查詢失敗要回 5xx，唔可以回 200 空數**（Ledger 側「非 200 一律顯示暫時無法取得」） |

---

## 5. POS 側實作方案（等拍板）

**範圍**：1 支 route ＋ 1 支 migration ＋ env ＋ 守衛測試。**無新依賴**（唔引入 `pg`）、**唔用 Ledger 憑證**。

| 檔案 | 內容 |
|---|---|
| `supabase/migrations/0058_pos_offline_report_rpc.sql` | `pos_offline_report(p_store_id uuid, p_from date, p_to date) returns jsonb`：**DB 內加總**（近零 egress，一次請求）。`security definer` ＋ `revoke execute from public/anon/authenticated` ＋ 只 `grant execute to service_role`。已寫好 clamp（`from = to − 89` 日）、`flags.clamped`、`flags.refundsNetted=false` |
| `src/app/api/integration/ledger/offline-report/route.ts` | 驗簽 → 參數校驗 → `rpc('pos_offline_report', …)` → 回應；`generatedAt` 用 RFC 3339 帶 `Z`；錯誤碼 401／400／404／429／503 |
| `.env.example` | 加 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（附「唔可以同 webhook secret 共用」注釋） |
| 測試 | `node --test`：驗簽 6 條（錯 secret／過期／毫秒／壞 hex／重排 query／缺 header）＋ clamp 邊界 ＋ avos 轉換 ＋ 排除線上投影嘅來源掃描守衛 |

**替代方案（若想唔等 migration 就上線）**：route 內直接用 PostgREST 拉、TS 加總。
代價：每張報表多 1–9 次請求、90 日窗口約 1–2 MB egress、要處理分頁同 1000 行上限。**我建議行 RPC**（專案已有 `pos_orders_page` RPC 慣例，同 egress 紀律一致）。

**部署次序**：① 商家喺 SQL Editor 貼 0058（無 transaction，即時生效）→ ② push code → ③ UAT 設 3 個 env 對數。

---

## 6. 回覆 Joe 嘅三條（其中兩條已經有生產實據）

### ① 正式測試店 `store_id`

| store_id | 性質 | 2026-09-24（澳門日）線下 |
|---|---|---|
| `8291f843-9def-4956-9d0b-1cfef2598306` | **建議測試店**（source=pos 純店內單，有 8 張線上投影單可驗排除） | 27 張 / MOP 1,847 / covers 27 |
| `d564b932-0c91-45e9-86fd-0ec8e2711f13` | 外賣平台單為主 | 14 張 / MOP 2,504 / covers 17 |

> ⚠️ POS 嘅 `store_id` 係由 Ledger 登入回應嘅 `merchant_id` 直接寫入（`/api/ledger/login` → `pos_orders.store_id`），理論上等於 Ledger `merchants.id`；但請你哋**用自己 DB 核對一次**呢兩個 UUID 是否真係你哋嘅 `merchants.id`，再定 UAT 對照表。
> 2026-09-22～09-24 每日逐日數字見 `tools/_probe-offlinereport2-20260925.out.txt`（可直接做驗收基準）。

### ② `pos_orders.total` 單位

**MOP 十進位小數（`numeric`，migration 0011 定義），唔係 avos。** 實測值多為整數 MOP（139、68、61、39…）。
⇒ 回傳時必須轉 avos 整數：**先加總 MOP、再整包 `Math.round(sum × 100)`**（逐張 ×100 再加容易被浮點尾數污染，例如 `0.1×100 = 10.000000000000002`）。

### ③ Secret 交換

Ledger 產生 ≥32 hex（唔可以同 `LEDGER_WEBHOOK_SECRET`、`POS_SCAN_DEBIT_SECRET`、`AUTH_PIN_PEPPER` 共用），**私訊**交換，唔進 git／issue。POS 側已經預留 env 位；收到之後要**重新部署** Vercel 才生效。

---

## 7. 現狀清單（已用生產數據核實）

- ✅ 0057 已生效：`pos_orders.settled_at` 欄位存在，主店 93 行中 91 行有值 ⇒ 跨日漂移保護在線。
- ✅ 兩個正式店都有單、`online_order_id` 投影單確實存在（必須排除）。
- ✅ anon 唯讀窗口約 72 小時 ⇒ 呢份底稿只覆蓋 09-22～09-25，更早日期要商家喺 SQL Editor 跑（或等 RPC 上線後用 API 驗）。
