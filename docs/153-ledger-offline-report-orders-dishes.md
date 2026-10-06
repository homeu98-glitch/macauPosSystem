# 153 · Ledger 線下報表增補：`orders[]` + `dishes[]`

> 2026-09-26 · 承 [150](./150-ledger-offline-report-route.md)（線下營業摘要 route）
> 契約增補（可直接轉貼畀 Ledger）：[`integration/pos-offline-report-v1-addendum-2026-09-26.md`](./integration/pos-offline-report-v1-addendum-2026-09-26.md)

## 1. 需求

用戶（J）：「在現有的 offline-report 中加入 ① 我們訂單的詳細內容，包含訂單價格與狀態；
② 我們菜品的排名列表。請將這些資料整合進同一個 API 回應中，
使對方單次呼叫即可取得全部資訊。」

拍板過程（AskUserQuestion，兩輪）：

| 問題 | 決定 |
|---|---|
| 明細深度 | 🔴 **只回訂單號、金額、狀態三個欄位**（用戶原話：「沒必要回傳所有訊息」） |
| 明細範圍 | 🔴 **連未結帳嘅單一齊回**（唔止已收錢嗰批） |
| 回應版本 | 保持 `v: 1`，純加可選欄位 |
| 菜品排名口徑 | 只線下（唔併線上投影） |
| 上限策略 | 設上限 + `truncated` 旗標 |

## 2. 交付（7 個檔）

| 檔 | 內容 |
|---|---|
| `supabase/migrations/0059_pos_offline_report_detail.sql`（新） | **同一簽名** `create or replace` 0058 ⇒ 多回四個 key |
| `src/lib/pos/offline-report.ts`（改） | 新常數／型別／嚴格驗證／回應組裝／caps 標頭 |
| `src/app/api/integration/ledger/offline-report/route.ts`（改） | `hasDetail` pass through ＋ `x-pos-offline-report-caps` |
| `src/lib/pos/offline-report.test.ts`（改） | ＋18 條（40 條）：orders／dishes 驗證、截斷、降級 |
| `src/lib/pos/offline-report-guard.test.ts`（改） | ＋24 條（51 條）：0059 口徑、個資紅線、caps、唔准自截 |
| `tools/check-pos-offline-report-sql.py`（改） | 支援多檔（0058 ＋ 0059） |
| `docs/integration/pos-offline-report-v1-addendum-2026-09-26.md`（新） | 回覆 Ledger 嘅增補契約 |

## 3. 回應新增（全部 additive，`v` 仍係 1）

```text
ordersTotal : int     符合條件嘅線下單總數（未截斷前）
orders[]    : { orderNo: string|null, totalAvos: int, status: string }   事件時間倒序
dishesTotal : int     菜品款數（未截斷前）
dishes[]    : { name: string, qty: int, revenueAvos: int }               金額倒序
flags.ordersTruncated / flags.dishesTruncated : bool
```

## 4. 口徑表（🔴 `orders[]` 同 `dishes[]` **唔同批次**）

| 項目 | `orders[]` | `dishes[]` | KPI |
|---|---|---|---|
| status | **全部**（只剔除 `cancelled`） | `settled` / `paid` | `settled` / `paid` |
| 排除線上投影 `online_order_id` | ✅ | ✅ | ✅ |
| 排除已退菜 `voided` | — | ✅ | （KPI 唔涉 item） |
| 日歸屬 | 四條時間腿 + `Asia/Macau` | 同左 | 同左 |
| 金額 | `greatest(0, round(total*100))` | `greatest(0, round(Σ(price×qty)*100))` | `round(Σtotal*100)` |
| 排序 | 事件時間倒序 | 金額倒序（`revenueAvos` 由大至小，並列按名稱）🔁 2026-10-05 由銷量倒序改 | — |
| 上限 | 3 000（保留最新） | 300 | — |
| 聚合 key（dishes） | — | `menuItemId｜名稱`（下單當時快照） | — |

⇒ `ordersTotal ≥ kpi.orderCount`，兩者**唔應該互相驗證**。

### `status` 封閉值域
`draft` / `sent_to_kitchen` / `reopened` / `paid` / `settled` / `partially_refunded` / `refunded` / `unknown`
（＝ `restaurant-daily-report.tsx POS_ORDER_STATUS_LABELS` ＋ SQL 嘅 `coalesce(…, 'unknown')`）。

**刻意唔回 `settled: boolean`**：任何單一 boolean 對 `refunded`（曾結帳、已退）同
`paid`（未結帳、已收錢）都會講錯。權威係原始 `status`。

## 5. 三個設計決定（都係「可以出錯」嘅位）

### ① `v` 唔升 ⇒ 用 caps 標頭探測能力
契約寫死「`v` 固定 1」，而 Ledger 已經對數成功（live）。升 `v` 有機會令對方
`v === 1` 嘅檢查失敗 ⇒ **整包丟棄**。所以維持 `v: 1`，改用
`x-pos-offline-report-caps: kpi,byPayment,orders,dishes` 宣告能力。

### ② 🔴 部署次序安全閥（最重要）
Vercel `push` 即自動部署，route 好可能比 migration 先上線。若嚴格要求四個 key 齊全，
舊 `0058` 會回一份冇 `orders` 嘅 payload ⇒ 驗值失敗 ⇒ **503** ⇒
**Ledger 現有嗰張已對數嘅卡即刻死**（人為故障）。

⇒ 分三種情況：
| RPC 回值 | 判定 | 行為 |
|---|---|---|
| 四個 key **全缺** | 舊版 0058（0059 未跑） | ✅ **優雅降級**：回應 omit 呢兩節、caps 只宣告 `kpi,byPayment` |
| **只出現一部分** | SQL 有 bug | ❌ 503 `upstream_unavailable`（失敗得響） |
| 四個齊全 | 正常 | ✅ 全量回 |

降級時**唔回空陣列** —— `orders: []` 會被 Ledger 讀成「今日冇單」（假零）。
「缺席」同「空」係兩件事。

### ③ 截斷權威在 SQL（同 90 日 clamp 同一原則）
route **唔准**自己 `slice()`。SQL 用 `count(*) over ()`（喺 `LIMIT` 之前計算）
一次過拎到「未截斷總數」同「首 N 筆」，route 只依 `ordersTotal > orders.length`
推導 `flags.ordersTruncated`。

> 呢個係 [0058 教訓](./113-agent-gotchas.md)（route 先截斷 ⇒ SQL 回 `clamped=false`
> ⇒ 長區間全 503）嘅**同一條病根**：凡上游會回 flag／總數，呼叫端只准核對，唔准預先處理。

## 6. 個資紅線（守住 v1「不是訂單明細／顧客個資」）

* ❌ `order_note`、item `note`、`discount_note`、`comp_note`、`voided_reason` —— 店員手打，可能藏姓名／電話
* ❌ 顧客姓名／電話／會員 id
* ❌ 收銀員姓名（順帶：`pos_orders` 本身冇呢欄 —— `settledBy` / `settledByName` 只喺本機 `types.ts`，唔喺 `POS_ORDER_DB_COLUMNS`）
* ❌ 逐項菜品明細（會令 payload 由 ~300 KB → ~1.6 MB，撞 Ledger 3 秒 timeout）

守衛測試會掃 `0059` body：`order_note` / `discount_note` / `comp_note` / `raw_json` / `'note'`
出現即 fail；並用白名單限定 `items` 只准讀
`name` / `menuItemId` / `quantity` / `price` / `voided`。

## 7. Payload 實測（唯讀探測）

`tools/_probe-offlinereport-size-20260926.cjs`（＋ `.out.txt`）；anon 72h 窗，主店：

| 指標 | 實測 |
|---|---|
| 線下可計銷售單 | 平均 **32 張/日**、**2.28 行菜品/張** |
| 明細單頭（＝今次方案） | 平均 **230 B/張** |
| 90 日外推（≈2 880 張） | **≈ 300 KB**（明細 3 欄） |
| 菜品排名 | 40 款 → **≈ 2 KB** |
| （若連逐項菜品） | ≈ 1.6 MB ⇒ 已否決 |

## 8. 驗證

```
node --test（全套）           # tests 1695  # pass 1695  # fail 0
offline-report 兩檔           # tests 91    # pass 91
tsc --noEmit                  0 error
eslint 改動檔                 0 error
tools/check-pos-offline-report-sql.py（0058 + 0059）  全部 OK
next build                    ✓ Compiled successfully；route 仍係 ƒ Dynamic
```

## 9. 部署次序

1. 商家跑 **`0059`**（SQL Editor，無 transaction、可重跑；`create or replace` 同一簽名，唔影響 0058 嘅 grants）
2. push → Vercel 部署（**任一先後都安全**，見 §5-②）
3. 請 Ledger 讀 `x-pos-offline-report-caps` 決定要唔要 render 新兩節
4. 對數：`ordersTotal ≥ kpi.orderCount`；`dishes[]` 金額加總 ≈ `kpi.revenueAvos`（差額＝服務費／稅／折扣／抹零）

## 10. 已知邊界

* 🔴 **`orders[]` 冇時間欄位（2026-09-27 J 拍板，刻意唔加）。**
  ⇒ Ledger **唔可以**本地對 `orders[]` 分日 group。要「某一日」就 `from = to = 該日` 另叫一次。
  已寫入增補契約（專節「逐張單唔提供日期／時間」），避免對方當成漏做而報 bug。
  * 反面代價：若日後要加，正確做法係回 **`at`（RFC3339 +08:00）＋ `day`（YYYY-MM-DD）**，
    而且時間一定要用 **SQL 篩選用嘅同一個 event instant** —— 唔可以另回 `created_at`，
    否則會出現「顯示 09-25、被算入 09-24」嘅鬼故事。只回 `at` 亦危險
    （對方用 UTC 切片 ⇒ 00:00–08:00 嘅單歸錯日）⇒ 所以 `day` 由 POS 講明。
* `orders[].orderNo` 可以係 `null`（外賣平台推入嘅單冇本地單號）
* **未結帳單嘅日歸屬靠 `updated_at`**（`settled_at`／`reopened_at` 都係 NULL）：
  進行中嘅枱會一直出現喺最近區間（合理），久未觸碰嘅草稿會停喺最後動作嗰日
* 菜品排名唔會按當前餐牌改名重組（刻意：改名／改價各自一行，歷史唔會失蹤）
* `dishes[]` 只計 `settled`/`paid` ⇒ 未結帳單嘅菜**唔會**出現喺排名（同 POS 報表一致）
* 上限截斷時 `ordersTotal` / `dishesTotal` 仍然係真實總數（唔會被截）

## 11. 相關

* [150 · 線下營業摘要 route 實作](./150-ledger-offline-report-route.md)
* [`integration/pos-offline-report-api.md`](./integration/pos-offline-report-api.md)（v1 原件）
* [`integration/pos-offline-report-v1-addendum-2026-09-26.md`](./integration/pos-offline-report-v1-addendum-2026-09-26.md)（本增補回覆）
* [113 · agent gotchas](./113-agent-gotchas.md) §對外整合 route
