# Macau POS 報表「一次性 API」— `report_ro.build_full_report()`

> **文件編號**：94
> **版本**：v1.0
> **最後更新**：2026-09-01
> **對象**：Ledger 團隊（含對接嘅 AI Agent）
> **目標**：Ledger call **一次**，就攞到餐飲報表（`/reports`）嘅全部可得內容，顯示喺手機端
> **配套 SQL**：[`docs/sql/94-ledger-report-api.sql`](./sql/94-ledger-report-api.sql)
> **前置文件**：`docs/83-ledger-report-db-integration.md`（唯讀角色 + 22 個 View）

---

## 0. 點樣用呢份文件（畀 AI Agent 嘅最短路徑）

1. 確認 **83 號已經跑完**（`ledger_report_ro` 角色 + `report_ro` schema 存在）。未跑 → 先跑 83 號。
2. 由 macau-pos 管理員喺 **Supabase Dashboard → SQL Editor** 貼 [`docs/sql/94-ledger-report-api.sql`](./sql/94-ledger-report-api.sql) 執行一次。
3. 用 **§3** 嘅三行 SQL 試 call，用 **§8** 嘅驗收清單逐條對。
4. 對照 **§4 欄位表** 砌手機 UI。
5. **§6 一定要讀** —— 有 8 項數據唔喺 macau-pos DB，一條 API 都變唔出嚟。
6. **§7 係硬性約束** —— 範圍上限 90 日、禁止 polling、只讀。

⚠️ 本機冇 DB 連線，migration 一定要人手喺 Dashboard 貼（呢點踩過兩次，見 `docs/93`）。
本文件嘅 SQL 已經用 libpg_query（PostgreSQL 真 grammar）驗過語法 —— 改動後可以自己再驗一次：

```bash
pip install pglast
python tools/check-94-sql.py     # 驗外層語句 + 主查詢 + 兩段 dynamic SQL
```

語法過到 **唔等於** 跑得到：欄位名／型別一定要喺 Supabase SQL Editor 實跑（§8）先驗到。

---

## 1. 背景：由「一條 HTTP API」變成「一個 Postgres function」

### 1.1 原提議

> 把報表內容打包成一條 API，Ledger 每一次要睇就 call 一次。

方向正確，對 Ledger 亦係最簡單嘅做法。但實行上有兩個技術現實：

### 1.2 點解唔喺 Vercel 寫 HTTP route

| 問題 | 詳情 |
|---|---|
| **冇 `pg` driver** | `package.json` 得 `@supabase/supabase-js`，行嘅係 PostgREST（HTTPS）。項目約定「不引入新依賴」。 |
| **PostgREST 冇 `GROUP BY`** | 菜品排行／桌台排行／尖峰時段呢三個模組**砌唔出**。要砌就要逐個寫成 Postgres function 再 `.rpc()` call。 |
| **口徑會分叉** | 前端 `restaurant-daily-report.tsx aggregate()` 跑 localStorage 係一套，SQL View 係一套；再喺 TS 寫多次就變三套，數字一定對唔上。 |

既然點都要寫 SQL function，咁不如**只寫一個**。

### 1.3 最後方案

```
Ledger 手機 App
      │ 每次睇報表 call 一次
      ▼
Ledger 後端（建議 cache 5 分鐘）
      │
      │  select report_ro.build_full_report($1, $2, $3);
      │  ← 沿用 83 號嗰條唯讀連線，唔使新 secret、唔使新端口
      ▼
report_ro.build_full_report()  → 一個 jsonb
      │  （內部全部由 83 號嗰 22 個 View 砌出嚟，冇重新計過數）
      ▼
report_ro.v_pos_orders / v_pos_order_items / v_inv_low_stock
      ▼
public.pos_orders / inv_products
```

**「每次睇就 call 一次」嘅需求完全滿足**，只係通道由 HTTP 換咗做 SQL。

之後如果 Ledger 堅持要行 HTTPS，可以加條 `GET /api/v1/report/full`，入面
`supabase.rpc('build_full_report', {...})` 原封不動吐同一個 JSON —— **唔使加依賴、唔使重寫邏輯**。
（本版唔做，等有實際需要先起。）

### 1.4 範圍決定（2026-09-01 拍板）

| 項目 | 決定 |
|---|---|
| 通道 | 淨係 Postgres function（A 方案），暫不加 HTTP route |
| 行業 | **淨係餐飲**，salon 模組（83 號 B8–B15）範圍外 |
| 日期上限 | **90 日**（可調，見 `p_max_days`；超出自動截斷並標明） |

---

## 2. 安裝

```sql
-- 由 macau-pos 管理員喺 Supabase Dashboard → SQL Editor 執行一次
-- 內容：docs/sql/94-ledger-report-api.sql
```

做三件事：

1. **Part A** — 建 `report_ro.build_full_report(text, date, date, int, int)`
2. **Part B** — `grant execute` 畀 `ledger_report_ro`（View 嘅 default privileges **唔包** function，一定要顯式 grant）
3. **Part C/D** — 驗收 SQL + 可選 index（90 日查詢慢先加）

冇 drop 任何嘢，全部 `create or replace` / `if not exists`，可重複執行。

---

## 3. 點樣 call

```sql
-- 今日（最常用）
select report_ro.build_full_report('macau-store-a');

-- 指定區間（澳門日期，前後包晒）
select report_ro.build_full_report('macau-store-a', '2026-08-01', '2026-08-30');

-- 淨係要今日、但調低上限（例如想硬 cap 30 日）
select report_ro.build_full_report('macau-store-a', '2026-07-01', '2026-09-01', 30);

-- 靚印（debug 用）
select jsonb_pretty(report_ro.build_full_report('macau-store-a'));
```

### 參數

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `p_store_id` | `text` | — | **必填**。門店 ID。可查 `select distinct store_id from report_ro.v_pos_orders;` |
| `p_from` | `date` | `p_to` | 起日（澳門日期）。null → 等於 `p_to` |
| `p_to` | `date` | 今日 | 止日（澳門日期）。null → 澳門今日 |
| `p_max_days` | `int` | `90` | 區間日數上限，會夾到 `1..366` |
| `p_top_n` | `int` | `50` | `dishes` / `tables` / `lowStock` 每榜最多幾條，夾到 `1..500` |

### 範圍截斷行為（重要）

超出 `p_max_days` 時**唔會報錯**，而係由 `p_to` 倒推截斷，並喺 `meta` 標明：

```sql
select report_ro.build_full_report('macau-store-a', '2020-01-01', '2026-09-01');
-- meta.clamped         = true
-- meta.range.from      = '2026-06-05'   ← 2026-09-01 倒推 89 日
-- meta.requestedRange  = { from: '2020-01-01', to: '2026-09-01' }
```

手機端見到 `clamped = true` 請顯示提示（例如「已限制為最近 90 日」），
**唔好當成原本嗰個範圍嘅數**。

### 各語言範例

```js
// Node.js（pg）
const { rows } = await pool.query(
  `select report_ro.build_full_report($1, $2, $3) as report`,
  [storeId, from, to]
);
const report = rows[0].report;   // 已經係 object
```

```python
# Python（psycopg3）
cur.execute("select report_ro.build_full_report(%s, %s, %s)", (store_id, d_from, d_to))
report = cur.fetchone()[0]
```

---

## 4. Payload 欄位表

頂層 9 個 key：`meta` · `kpi` · `daily` · `hourly` · `dishes` · `tables` · `serving` · `lowStock` · `baselines` · `suggestions`

### `meta`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `schemaVersion` | string | `"1.0"`。改動輸出格式一定會改呢個，手機端請照住佢解 |
| `industry` | string | 固定 `"restaurant"`（本版唔包 salon） |
| `storeId` / `storeName` / `currency` | string | 門店識別。`storeName` 嚟自 `pos_bootstrap_config` |
| `timezone` | string | 固定 `"Asia/Macau"` |
| `range` | object | `{ from, to, days }` —— **實際**用嘅範圍 |
| `requestedRange` | object | 原本傳入嘅範圍（用嚟同 `range` 對，睇有冇被截斷） |
| `clamped` | bool | 係咪被截斷過 |
| `maxDays` / `topN` | number | 生效中嘅上限 |
| `generatedAt` | string | `YYYY-MM-DDTHH:MM:SS+08` |
| `source` | string | `report_ro.build_full_report v1.0` |
| `gaps` | string[] | **用 DB 計唔到嘅欄位**（見 §6） |
| `unavailableSuggestionRules` | object[] | 前端有、但呢邊計唔到嘅建議規則（連閾值一齊畀，見 §6.2） |

### `kpi`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `revenue` / `orderCount` / `avgTicket` | number / int / number | 營業額、訂單數、客單價 |
| `covers` | int \| **null** | 覆蓋人數。**要 migration 0017**，未跑一律 `null`（同時會列咗喺 `meta.gaps`） |
| `discountAmount` / `discountRatio` | number | 折扣金額 / 佔營業額比（4 位小數） |
| `onlineRevenue` / `offlineRevenue` / `onlineShare` | number | 線上／線下拆分。線上＝`online_order_id is not null` |
| `soldQty` / `voidQty` / `voidAmount` / `voidRate` | number | 售出份數 / 退菜份數 / 退菜金額 / 退菜率 |

### `daily` — 每日趨勢

`[{ bizDate, orderCount, revenue, onlineRevenue, discountAmount, soldQty, voidQty, avgTicket }]`

**零填充**：範圍內冇單嘅日子照出 0，方便直接畫折線圖。（前端報表冇呢個陣列，所以唔存在口徑衝突。）

### `hourly` — 尖峰時段

`[{ hour: 0..23, orderCount, revenue }]`，固定 24 格、零填充。

### `dishes` — 菜品銷售排行

`[{ menuItemId, name, totalQty, offlineQty, onlineQty, revenue, channel }]`
- `channel`: `"mix"` / `"online"` / `"offline"`
- 排序：`totalQty` 降序（同前端一致）；退菜**唔計入**
- 最多 `topN` 條

### `tables` — 桌台排行

`[{ tableId, name, orderCount, revenue, covers }]`
- 排序：`orderCount` 降序
- `covers` 要 0017，未跑係 `null`
- `revenue` 係加碼提供（前端只顯示單數 + 人數），純附加、唔影響既有口徑

### `serving` — 出餐時間（分鐘）

| 欄位 | 說明 |
|---|---|
| `sampleCount` | 樣本單數 |
| `measuredCount` | 當中有完整 `sent_to_kitchen_at` + `served_at`（實測）嘅單數 |
| `estimated` | `true` = 部分樣本缺時間戳，用「落單→結帳」估算 |
| `avgMin` / `medianMin` / `p95Min` | 平均 / 中位數 / P95 |
| `p95Warn` | `p95Min > 15` → 前端會標紅 |

### `lowStock` — 低庫存預警

`[{ productId, name, category, unit, currentQty, reorderLevel, shortfall }]`
- 條件：`reorder_level > 0 AND current_qty <= reorder_level`（同前端一致）
- **即時快照，唔受日期範圍影響**
- 排序：`shortfall` 降序

### `baselines` — 前 7 日基線

`{ baselineFrom, baselineTo, dailyRevenueAvg7d, onlineShare7d }`
- 區間＝ `range.from` 前 7 日（即 `[from-7, from-1]`）
- 用途：跑建議規則，亦方便 Ledger 自己加規則（例如會員充值對比）

### `suggestions` — 自動化優化建議

`[{ level: "r"\|"o"\|"i", title, action }]`，已排好序：立即(r) → 關注(o) → 資訊(i)
- 淨係計 DB 計到嗰幾條，缺嗰幾條見 §6.2

### 完整範例

```jsonc
{
  "meta": {
    "schemaVersion": "1.0", "industry": "restaurant",
    "storeId": "macau-store-a", "storeName": "示範店", "currency": "MOP",
    "timezone": "Asia/Macau",
    "range": { "from": "2026-09-01", "to": "2026-09-01", "days": 1 },
    "requestedRange": { "from": "2026-09-01", "to": "2026-09-01" },
    "clamped": false, "maxDays": 90, "topN": 50,
    "generatedAt": "2026-09-01T16:30:12+08",
    "source": "report_ro.build_full_report v1.0",
    "gaps": ["footfall","soldOut","ingredientConsumption","grossProfit",
             "memberTopup","memberCount","onlineBalancePaid","salon"],
    "unavailableSuggestionRules": [ /* 見 §6.2 */ ]
  },
  "kpi": {
    "revenue": 4820.00, "orderCount": 63, "avgTicket": 76.51, "covers": 141,
    "discountAmount": 210.00, "discountRatio": 0.0436,
    "onlineRevenue": 1180.00, "offlineRevenue": 3640.00, "onlineShare": 0.2448,
    "soldQty": 218, "voidQty": 3, "voidAmount": 84.00, "voidRate": 0.0138
  },
  "daily": [
    { "bizDate": "2026-09-01", "orderCount": 63, "revenue": 4820.00,
      "onlineRevenue": 1180.00, "discountAmount": 210.00,
      "soldQty": 218, "voidQty": 3, "avgTicket": 76.51 }
  ],
  "hourly": [ { "hour": 0, "orderCount": 0, "revenue": 0.00 }, /* …24 格 */ ],
  "dishes": [
    { "menuItemId": "m-001", "name": "招牌炸雞", "totalQty": 42,
      "offlineQty": 30, "onlineQty": 12, "revenue": 1260.00, "channel": "mix" }
  ],
  "tables": [
    { "tableId": "t-03", "name": "A3", "orderCount": 11, "revenue": 980.00, "covers": 27 }
  ],
  "serving": {
    "sampleCount": 63, "measuredCount": 58, "estimated": true,
    "avgMin": 9.4, "medianMin": 8.2, "p95Min": 21.5, "p95Warn": true
  },
  "lowStock": [
    { "productId": "p-017", "name": "雞腿肉", "category": "肉類", "unit": "kg",
      "currentQty": 2, "reorderLevel": 10, "shortfall": 8 }
  ],
  "baselines": {
    "baselineFrom": "2026-08-25", "baselineTo": "2026-08-31",
    "dailyRevenueAvg7d": 5240.71, "onlineShare7d": 0.1980
  },
  "suggestions": [
    { "level": "o", "title": "退菜率 1%（高於 3% 閾值）", "action": "…" }
  ]
}
```

---

## 5. 口徑對照（前端報表 ⇌ function）

**歸屬日**：一律 `coalesce(updated_at, created_at)` 轉澳門日期（同 `report-period.ts`）。
**只計已結帳單**：`status in ('settled','partially_refunded','refunded')`。
**退菜**：`items[].voided = true` 嘅唔計入 `soldQty`，只計入 `voidQty` / `voidAmount`。

| 模組 | 前端 | function | 狀態 |
|---|---|---|---|
| 營業額 / 訂單數 / 客單價 | `aggregate()` | `kpi` | ✅ 一致 |
| 折扣 / 線上線下拆分 / 退菜率 | 同上 | `kpi` | ✅ 一致 |
| 菜品排行 | `offlineQty + onlineQty` 降序 | `totalQty` 降序 | ✅ 一致 |
| 桌台排行 | `orders` 降序 | `orderCount` 降序 | ✅ 一致 |
| 尖峰時段 | `macauHour(createdAt)` | `order_hour` | ✅ 一致 |
| 出餐 中位數 | `medianOf()`（雙數取中間兩條平均） | `percentile_cont(0.5)` | ✅ 一致 |
| 出餐 P95 | `sorted[ceil(0.95n)-1]`（離散） | `arr[ceil(0.95n)]`（離散） | ✅ 一致（**刻意唔用** `percentile_cont(0.95)`，因為佢會插值，同前端差少少） |
| 低庫存 | `reorder_level > 0 && current_qty <= reorder_level` | 同 | ✅ 一致 |
| 覆蓋人數 | `partySize ?? 0` | `coalesce(party_size, 0)` | ✅ 一致（但要 0017） |
| **出餐 fallback** | `servedAt ?? (originalSettledAt ?? updatedAt)` | `coalesce(served_at, updated_at)` | ⚠️ **微差**：`pos_orders` 冇 `original_settled_at` 欄，只能退到 `updated_at`。只影響缺時間戳嘅舊單 |
| **「跌超過 20%」規則**（其一） | 本期**總**營業額 vs 前 7 日日均 | **本期日均** vs 前 7 日日均 | ⚠️ **有意圖嘅推廣**：單日範圍時兩者完全等價；多日範圍時一定要用日均，否則係蘋果撞橙 |
| **「跌超過 20%」規則**（其二） | 前 7 日窗口 = 最近 7 日（**包埋今日**） | 前 7 日窗口 = `[range.from - 7, range.from - 1]`（**唔包本期**） | ⚠️ **有意圖嘅修正**：前端嗰個窗口包埋今日，即係「今日」同時出現喺分子同分母（佔 1/7），會**稀釋**跌幅。呢邊剔除本期，比較乾淨 |

> 改前端 `aggregate()` 或者改 83 號 View，**兩邊都要同步改**，唔好淨係改一邊。

---

## 6. 用 DB 計唔到嘅嘢

### 6.1 `meta.gaps`（永遠冇）

| gap | 原因 | 邊度有 |
|---|---|---|
| `footfall` | 人流係收銀端手動記錄，無門口計數硬件 | 收銀端 localStorage |
| `soldOut` | `pos_soldout` 表程式從未寫入，全空 | 收銀端 localStorage |
| `ingredientConsumption` | BOM 配方未上雲 | 收銀端 localStorage |
| `grossProfit` | 買貨成本喺第三方 expenseRecorder | 未同步 |
| `memberTopup` / `memberCount` / `onlineBalancePaid` | 會員數據喺 **Ledger 自己嘅 DB** | Ledger 自己 merge |
| `salon` | 美容院模組本版範圍外 | 83 號 B8–B15 |

條件性 gap：`covers`（`pos_orders.party_size` 唔存在時會動態加落 `gaps`）。

**UI 建議**：`gaps` 有嘅欄位顯示「—」，**唔好當 0**。

### 6.2 計唔到嘅建議規則（`meta.unavailableSuggestionRules`）

呢幾條前端有，但要靠上面啲 gap 數據，所以 function 唔計。閾值一齊畀咗，Ledger 可以喺自己後端補：

| rule | 缺咩 | 閾值 |
|---|---|---|
| `soldOutCount` | 沽清 | 沽清 ≥ 3 款 → level `r` |
| `memberTopupDrop` | 會員充值（喺 Ledger 自己 DB） | 本期充值 < 前 7 日日均 × 0.7 → level `o` |
| `grossProfit` | 買貨成本 | 毛利 = 營業額 − 買貨成本（已付） |

`baselines` 已經提供咗 `dailyRevenueAvg7d` / `onlineShare7d`，方便對齊計法。

---

## 7. 硬性約束

| 項目 | 規定 |
|---|---|
| **只讀** | function 標 `stable`，入面全部 `select`。冇任何 DML / DDL |
| **權限** | `security invoker` —— 用 `ledger_report_ro` 自己嘅權限行，**讀唔到未授權嘅表**（同 83 號一致，唔開後門） |
| **禁止 polling** | 沿用 83 號 §7。手機每次開報表頁 call 一次就夠；**後端建議 cache 5 分鐘**，唔好做成每 30 秒輪詢 |
| **範圍上限** | 90 日（`p_max_days`，夾到 1..366）。超出自動截斷 + `meta.clamped = true` |
| **`statement_timeout`** | 角色層設咗 30s。90 日查詢如果頂唔順，先加 `docs/sql/94-…sql` Part D 嗰個 index，唔好直接改 timeout |
| **連線數** | 沿用 `connection limit 3` |
| **門店隔離** | 靠 `store_id` 參數過濾。呢個角色本來就讀到全部門店（同 83 號 §4），所以係**約定**而唔係技術強制 —— Ledger 後端要自己確保帶啱 `store_id` |

---

## 8. 驗收

用 `ledger_report_ro` 連線執行（完整 SQL 喺 `docs/sql/94-ledger-report-api.sql` Part C）：

| # | 檢查 | 預期 |
|---|---|---|
| C1 | `select jsonb_pretty(report_ro.build_full_report('macau-store-a'));` | 一個 JSON，9 個頂層 key 齊 |
| C2 | 指定 30 日區間 | `meta.range.days = 30`、`clamped = false` |
| C3 | 由 2020-01-01 查到今日 | `clamped = true`，`range.from` 係今日倒推 89 日，`requestedRange.from` 保留 `'2020-01-01'` |
| C5 | `select count(*) from public.salon_customers;` | **必須報錯** `permission denied`（驗證冇開後門） |
| C6 | `… #>> '{kpi,covers}'` | 數字（0017 已跑）或 `null`（未跑，同時 `gaps` 多一項 `covers`） |
| C7 | 對數：今日 `kpi.revenue` ⇌ `select round(sum(total),2) from report_ro.v_pos_daily_summary where store_id='…' and biz_date = current_date;` | 兩個數**必須相等** |

C7 係最關鍵一條 —— 對唔上即係口徑出咗問題，唔好上線。

---

## 9. 常見問題

**Q：點解 `covers` 係 null？**
A：`pos_orders.party_size` 唔存在，即 migration 0017 未跑。跑完之後**新單先有值**，歷史單無法回溯。

**Q：點解 `suggestions` 少咗幾條？**
A：見 §6.2。要沽清／會員充值／買貨成本嗰三條，數據唔喺 macau-pos。

**Q：想查多過 90 日？**
A：傳 `p_max_days`（上限 366）。但長區間建議改用 `daily` 陣列自己喺 Ledger 後端 roll-up，唔好一下掃幾年。

**Q：想加 HTTP 版？**
A：見 §1.3。加條 `GET /api/v1/report/full`，入面 `supabase.rpc('build_full_report', …)` 就得，
唔使重寫邏輯。要另外傾 auth（獨立 key，**唔好共用 `LEDGER_WEBHOOK_SECRET`**）、rate limit、cache header。

**Q：點升級？**
A：成段 Part A 重新貼一次（`create or replace`）。改動輸出格式時**必須**同步 `meta.schemaVersion` 同本文 §4，
並事先通知 Ledger —— 佢哋係照住 `schemaVersion` 解 JSON 嘅。
