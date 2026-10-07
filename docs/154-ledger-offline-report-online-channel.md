# 154 · Ledger 報表：offline-report 擴充為「線上＋線下」

> 2026-10-07 · 承 [153](./153-ledger-offline-report-orders-dishes.md)  
> 現行程式：`supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql`（權威版本）  
> 本檔係**方案書**，未動代碼 —— 等 J 拍板先做。
> ⚠️ **22:30 修訂**：J 指出「Ledger 自己已經有線上訂單數據」⇒ 原方案
> 「`kpi` 由 4,772 改 6,668」會令 Ledger **雙重計算**，已推翻。見 §1.2 ＋ §3.3。

---

## 0. 一句話

同一支 RPC 擴充：每張單標 `channel`、菜品同支付分類按線上／線下拆開。
**`v` 維持 1**、**現有欄位名／型別／數值全部唔改**、**新資料一律新 key** ⇒
Ledger 舊 UI 唔會壞。而實際補上嘅係**菜品、支付方式分項、訂單來源標示**。

---

## 1. 現狀診斷（生產唯讀實測，主店，2026-10-07）

工具：`tools/_probe-offlinereport-online-20261007.cjs`、`tools/_probe-offlinereport-paybreak-20261007.cjs`、`tools/_probe-offlinereport-v1base-20261007.cjs`

### 1.1 三種來源（`pos_orders` 裡面其實有三種，唔係兩種）

| channel             | 判定條件                                                    | 90 日總行 | 可計銷售 | 可計銷售金額 |
| ------------------- | ------------------------------------------------------- | -----: | ----: | ------: |
| `offline`           | `online_order_id IS NULL` 且 `source ∉ ('aomi','mfood')` |     66 |    66 | 4,772 |
| `online_projection` | `online_order_id IS NOT NULL`（掃碼／排位／快餐採納）               |     19 |    19 | 1,197 |
| `online_platform`   | `source IN ('aomi','mfood')`（Grabber 推入）                |      9 |     8 |   699 |
| **合計**              |                                                         | **94** | **93** | **6,668** |

（「可計銷售」＝ `status in ('settled','paid')`；平台 9 張入面有 1 張 `cancelled`，見 §1.2）

🔴 **線上佔 1,896 / 6,668 ＝ 28.4% 金額、27 張 / 93 ＝ 29% 張數**。唔係小數字。

### 1.2 🔴 現時 kpi 其實已經包埋平台單（我哋嘅 bug，唔係 Ledger 嘅）

**① 平台單被誤算成「線下」** —— 0058/0059/0060 全部用 `online_order_id IS NULL` 排除線上，
但平台單**冇** `online_order_id`（佢有 `external_order_id` + `source`）。

🔴 **後果（22:35 實測更正）**：我哋現時報畀 Ledger 嘅「線下」**已經包含平台單 699**：

逐 `(channel | status)` 實測（94 行，90 日）：

| channel \| status | 張數 | 金額 |
|---|---:|---:|
| `offline` \| `settled` | 66 | 4,772 |
| `online_platform` \| `settled` | 8 | 699 |
| `online_platform` \| **`cancelled`** | 1 | 65（kpi 唔計、`orders[]` 現時**唔剔**） |
| `online_projection` \| `settled` | 19 | 1,197 |

⇒ **v1 `kpi` 實際輸出 = 74 張 / MOP 5,471**（66 線下 + 8 平台，兩者都 `settled`）
⇒ **v1 `orders[]` 實際輸出 = 75 張 / MOP 5,536**（包埋嗰張 `cancelled` 平台單，v2 唔剔 `cancelled` ⇒ **93 張**）

而 Ledger **自己嘅 `public.orders` 已經有平台單**（J 22:30 確認）⇒ **佢哋今日重複計算緊呢 699**。
呢個係 POS 側嘅 bug；`v:1` 已經喺 Ledger 行緊，**唔可以靜靜哋改**（§3.3 採「舊欄零改動 +
新欄給精確拆分」）。

**② 線上單嘅 `payment_method` 漏咗 raw Ledger 值** —— 實測 19 張線上投影單裡：

| payment_method | 張數 | POS 報表頁顯示                  |
| -------------- | -: | -------------------------- |
| `線上已支付`        |  9 | 線上已支付                      |
| `in_store`     |  8 | 🔴 **`in_store`**（raw，冇翻譯） |
| `balance`      |  1 | 🔴 **`balance`**（raw，冇翻譯）  |
| `Mpay`         |  1 | Mpay                       |

POS 報表頁靠 `paymentModeLabel()` 翻譯（`balance → 餘額扣點`、`in_store → 到店付款`，  
見 `src/lib/ledger/order-mapper.ts:218`）。**SQL 側冇做呢層** ⇒ Ledger 會見到英文 raw 值。  
「支付分類同 macau-pos 一樣」嘅核心就係喺度。

### 1.3 菜品現況

離線 49 款 / 線上 25 款 / **聯集 64 款**（10 款兩邊都有）。  
線上單 `items` 欄位完整（38 行全部有 `name`／`price`／`quantity`／`menuItemId`，0 缺），  
聚合 key 可以同線下一樣用 `menuItemId|名稱`。`selectedSpecs` 只有 23 行有 —— **唔需要讀**。

### 1.4 容量（用戶已拍板照舊 additive）

| 項目         |    現時上限 |         90 日實測 | 結論              |
| ---------- | ------: | -------------: | --------------- |
| `orders[]` | 3,000 張 |     93 張（加線上後） | 唔會截斷            |
| `dishes[]` |   300 款 |        聯集 64 款 | 唔會截斷            |
| payload    |       — | ≈ 22 KB + 4 KB | 遠低於 3 秒 timeout |

---

## 2. 要修改／新增嘅檔案

### 2.1 新增（3 個）

| 檔                                                                    | 內容                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `supabase/migrations/0066_pos_offline_report_channel.sql`            | **`create or replace` 同一簽名** `(text, date, date)`；`0060` 已上線，改檔唔會令商家重跑 |
| `docs/integration/pos-offline-report-channel-addendum-2026-10-07.md` | 俾 Ledger 嘅增補契約（可直接轉貼）                                                  |
| （本檔）                                                                 | 方案書                                                                    |

### 2.2 修改（5 個）

| 檔                                                        | 改乜                                  |
| -------------------------------------------------------- | ----------------------------------- |
| `src/lib/pos/offline-report.ts`                          | 新增 4 個型別、4 個常數、驗證邏輯、回應組裝、caps token |
| `src/app/api/integration/ledger/offline-report/route.ts` | pass through 新欄 + caps 標頭（其餘邏輯唔郁）   |
| `src/lib/pos/offline-report.test.ts`                     | ＋新欄驗證、降級、截斷測試                       |
| `src/lib/pos/offline-report-guard.test.ts`               | 🔴 **改指向 0066**（見 §6 盲點）            |
| `tools/check-pos-offline-report-sql.py`                  | 加 0066 入 `SQL_PATHS` + 補新變數 literal |

---

## 3. 資料查詢改動（SQL 0066）

### 3.1 移除排除條件（4 處 → 0 處）

```sql
-- 0060 現時（KPI / byPayment / refunded / orders / dishes 各一處）
  and o.online_order_id is null
-- 0066：整句刪走，唔係改成別的條件
```

### 3.2 新增 channel 判定（單一真源，5 段 SQL 共用同一個 CASE）

```sql
case
  when o.source in ('aomi', 'mfood')            then 'online_platform'
  when o.online_order_id is not null            then 'online_projection'
  else 'offline'
end as channel
```

🔴 **唔可以用 `online_order_id is null` 當線下**（會漏平台單）；亦**唔可以**淨係靠  
`source`（會將掃碼單當線下）。

### 3.3 KPI：🔴 舊五欄**一個數字都唔改**，精確拆分另開新 key

J 22:30 拍板：**Ledger 自己已經有線上訂單數據**（佢哋嘅營業額卡用自己數據源）。
若果我哋把 `kpi.revenueAvos` 由 5,471 改成 6,668（包埋線上）⇒ **Ledger 雙重計算**。

⇒ 設計原則改成「**零風險 additive**」：

```
kpi: {
  orderCount, revenueAvos, refundedAvos, discountAvos, covers
      ↑ 現有五欄：名、型別、值全部唔改（維持 74 張 / 5,471）
      ⚠️ 語意係「v1 歷史口徑」＝ 線下 settled + 平台 settled，唔係純線下
        —— 增補契約必須寫明「唔好再同 Ledger 自己嘅線上營業額相加」

  🆕 offline:         { orderCount, revenueAvos, refundedAvos, discountAvos, covers }  ← 66 / 4,772
  🆕 online:          { orderCount, revenueAvos, refundedAvos, discountAvos, covers }  ← 19 / 1,197
  🆕 onlinePlatform:  { orderCount, revenueAvos, refundedAvos, discountAvos, covers }  ←  8 /   699
}
```

- `kpi` 五欄 = **SQL 舊邏輯逐字保留**（`status in ('settled','paid')` + `online_order_id is null`）
- 三個新 key 用**同一套聚合**各跑一次，加 `channel` 條件（`refunded` / `partially_refunded` 同樣剔除）
- 對數（22:35 實測）：`offline 66 + online 19 + onlinePlatform 8 = 93` 張 ／ 6,668
  （三個新 key 加總**大過**舊 `kpi` 74 張，差額 19 張 ＝ 線上投影單，佢哋喺 v1 口徑下係被排除嘅）
- 🔴 **唔可以**將舊五欄偷偷改成 4,772 —— Ledger 舊 UI 已經照住 5,471 render，
  改咗佢張卡即刻跳數

### 3.4 `orders[]`：全量 + 每列加 `channel`（J 22:30 拍板）

```json
{ "orderNo": "訂單27", "totalAvos": 3800, "status": "draft", "channel": "offline" }
{ "orderNo": null,     "totalAvos": 6200, "status": "paid",  "channel": "online_projection" }
{ "orderNo": "mfood-…", "totalAvos": 6200, "status": "paid",  "channel": "online_platform" }
```

- 狀態口徑**完全唔變**（全部狀態，只剔除 `cancelled`）
- 排序、上限 3,000、事件時間四條腿、Asia/Macau —— 全部唔變
- 淨效果：線下 + 線上 + **最新 Grabber 訂單** 合併成一個時序流
- 🔴 張數 **75 → 93**（22:35 實測：v1 75 張包埋嗰張 `cancelled` 平台單，v2 剔 `cancelled`）
  Ledger 舊 UI 唔讀 `channel` ⇒ 會照舊 render，但**列表會長 18 行**。
  增補契約要寫明：若果佢哋想要「淨線下訂單」，用
  `orders[]` + `channel == 'offline'` 自行過濾（⚠️ `online_order_id IS NULL` 唔夠，
  因為會漏平台單）。

### 3.5 `dishes[]`：每列加線上／線下拆欄（唔加兩節）

```sql
-- 聚合 key 唔變（menuItemId|名稱），加 channel 做第二維度
select dkey, min(dname), channel,
       sum(qty), sum(price*qty)
group by dkey, channel
-- 再喺外層 merge 成一行：
jsonb_build_object(
  'name', r.dname,
  'qty',              r.qty_total,             -- 總數 = 線下 + 線上（保留舊欄位）
  'revenueAvos',      r.revenue_total,         -- 總額
  'offlineQty',       r.qty_offline,
  'offlineRevenueAvos', r.rev_offline,
  'onlineQty',        r.qty_online,
  'onlineRevenueAvos', r.rev_online
)
order by r.revenue_total desc, r.dname asc      -- 0060 嘅金額倒序，唔准改返
```

🔴 `qty` / `revenueAvos` **保留做總數** ⇒ 舊 Ledger 讀唔到新欄位都照樣 render 到。  
菜品上限 300、只計 `settled`/`paid`、排除 `voided` —— 全部唔變。

### 3.6 `byPayment`：補分類 + channel 維度

**兩件事，同時做**：

**(a) 補齊 POS「支付方式分項（店內收款）」嗰張表嘅欄位**  
（`restaurant-daily-report.tsx`：支付方式／訂單數／應收／實收／差額；🔴 卡片名已於 2026-10-07
由「店內 POS 線下」改名為「**店內收款**」，因為實際入帳三類單 —— 見 memory 22:2x 段）

```sql
select
  left(coalesce(nullif(btrim(payment_method),''), '未記錄'), 32) as method,
  -- 🔴 新增：翻譯層，必須同 src/lib/pos/payment-method-label.ts 逐字對齊
  case
    when btrim(coalesce(payment_method,'')) = ''                        then '未記錄'
    when lower(btrim(payment_method)) = 'in_store'
      or lower(btrim(payment_method)) = 'online_in_store'               then '到店付款'
    when lower(btrim(payment_method)) = 'balance'
      or lower(btrim(payment_method)) = 'online_balance'                then '餘額扣點'
    when lower(btrim(payment_method)) = 'member_balance'                then '會員餘額'
    when lower(btrim(payment_method)) in ('online_paid', 'prepaid')     then '線上已支付'
    else left(btrim(payment_method), 32)   -- 🔴 store 自訂名原樣返回，唔可以改寫
  end as method_label,
  channel,
  count(*)::bigint as order_count,
  -- 應收 = Σ(item.price × qty) + 服務費 + 稅（同 POS aggregate() 逐字一致）
  coalesce(round(sum(
    (select coalesce(sum(
       case when (it->>'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'quantity')::numeric else 0 end
     * case when (it->>'price')    ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'price')::numeric    else 0 end
    ), 0) from jsonb_array_elements(
      case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) it
  ) + coalesce(o.service_charge_amount,0) + coalesce(o.tax_amount,0)
  ) * 100)::bigint, 0) as receivable_avos,
  coalesce(round(sum(coalesce(o.total,0)) * 100)::bigint, 0) as paid_avos
from public.pos_orders o ...
group by 1, 2, 3
```

🔴 **翻譯表係「雙份維護」風險**：`posPaymentMethodLabel()`（`src/lib/pos/payment-method-label.ts`）
係全系統唯一真源，SQL 冇 import 佢 ⇒ 兩邊會漂。守衛測試要逐個 key 對照
（`knownLedgerPaymentModes()` 每個 key 都要喺 SQL 出現）。
⚠️ 收窄任何一邊都唔可以靜靜做 —— store 可能自己叫「現金」，加 `cash` 會撞名。

**(b) 加 `channel` 做第三維度** —— 令 Ledger 可以分「線下 Mpay／線下現金／線上外賣平台／線上到店付款」。

回應結構（`byPayment` 舊欄位全部保留）：

```json
"byPayment": [
  { "method": "Mpay", "amountAvos": 360500 }              ← 舊欄位，保留
],
"paymentBreakdown": [
  { "method": "Mpay", "label": "Mpay", "channel": "offline",
    "orderCount": 46, "receivableAvos": 360700, "paidAvos": 360500 },
  { "method": "外賣平台", "label": "外賣平台", "channel": "online_platform",
    "orderCount": 8, "receivableAvos": 75600, "paidAvos": 69900 }
]
```

🔴 **`byPayment` 舊欄位唔可以改成「全渠道總數」** —— 咁樣 Ledger 會以為「線下只得 Mpay」，
而家佢哋 bar 上嘅「外賣平台」條會突然消失。
舊 `byPayment` **逐字保留 SQL 舊邏輯**（同 `kpi` 一樣＝線下 + 平台單，一個數字都唔變），
新 `paymentBreakdown` 先係全渠道明細。

### 3.7 🔴 差額欄嘅語意陷阱（實測發現，一定要講明）

| 單          |     實收 | 應收（Σitems+費+稅） |         差額 | 來源                | 真實成因                          |
| ---------- | -----: | -------------: | ---------: | ----------------- | ----------------------------- |
| mfood 單    | 232.00 |         259.00 | **+27.00** | online_platform   | 平台費／抽成（`platform_fees` 4-5 條） |
| ledger 投影單 |  63.00 |          61.00 |      −2.00 | online_projection | 抹零／平台補貼                       |
| ledger 投影單 | 180.00 |         172.00 |      −8.00 | online_projection | 同上                            |
| 線下單        |      — |              — |          0 | offline           | 線下單真係冇服務費／稅                   |

- 線下單：差額 ＝ **折扣**（全單優惠、抹零）
- 平台單：差額 ＝ **平台抽成 + 餐盒費**（`platform_fees`，可能實收 **>** 應收，方向相反）

⇒ 差額欄唔可以叫「折扣」。契約用中性名 **`diffAvos`**，並喺 Ledger 側按 `channel` 換文案  
（線下＝「折扣差額」、平台＝「平台費差額」）。🔴 **唔可以喺 SQL 夾非負** ——  
平台單嘅 +27 係真資料，夾咗就變成假零。

### 3.8 權限／範圍／截斷 — 全部不變

`stable`、`security invoker`、只 `grant service_role`、90 日 clamp、`count(*) over ()` 喺 `LIMIT` 之前、  
上限 3,000／300、**唔包 transaction**、同款菜品截斷保留策略一致。

---

## 4. 最終 report 欄位結構變化

### 4.1 逐節對照

| 節                                           | 欄位                                                                     | 變化                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `v`                                         | `1`                                                                    | ➡️ **唔升**（升咗 Ledger `v === 1` 檢查會整包丟棄）                                                                |
| `kpi` 五欄                                   | `orderCount,revenueAvos,refundedAvos,discountAvos,covers`             | ✅ **完全唔改**（名、型別、**值 74 / 5,471 全部維持**，SQL 舊邏輯逐字保留）                                       |
| `kpi.offline` / `kpi.online` / `kpi.onlinePlatform` | 各 5 個欄                                                      | 🆕 精確拆分（66 / 19 / 8）                                                                                     |
| `breakdown.byPayment`                       | `[{method, amountAvos}]`                                               | ✅ **完全唔改**（同樣保留 0060 邏輯，一個數字都唔郁）                                                            |
| `breakdown.paymentBreakdown`                | `[{method,label,channel,orderCount,receivableAvos,paidAvos,diffAvos}]` | 🆕 全渠道支付分類（macau-pos「支付方式分項」同款）                                                                  |
| `orders[]`                                  | `{orderNo,totalAvos,status}`                                           | ➕ 每列加 **`channel`**；張數 75 → 93（全量＋最新 Grabber）                                                       |
| `ordersTotal` / `dishesTotal`               | int                                                                    | ⚠️ 值變大（`ordersTotal` 75→93；`dishesTotal` 49→64）                                                               |
| `dishes[]`                                  | `{name,qty,revenueAvos}`                                               | ➕ 每列加 **`offlineQty`／`offlineRevenueAvos`／`onlineQty`／`onlineRevenueAvos`**；`qty`／`revenueAvos` 保留做總數 |
| `flags.ordersTruncated` / `dishesTruncated` | bool                                                                   | 不變                                                                                                    |
| `flags.onlineIncluded`                      | `true`                                                                 | 🆕 明確講「已含線上」                                                                                          |
| `flags.ledgerOwnsOnlineRevenue`             | `true`                                                                 | 🆕 **誠實揭露：線上營業額以 Ledger 自己數據源為準**，唔好同 `kpi` 相加                                                 |
| `flags.platformRefundsIncluded`             | `false`                                                                | 🆕 平台退款未入帳（誠實揭露，唔渲染假零）                                                                                |

### 4.2 完整 JSON 形狀

```json
{
  "v": 1,
  "storeId": "8291f843-…",
  "from": "2026-07-10",
  "to": "2026-10-07",
  "generatedAt": "2026-10-07T14:02:00.000Z",

  "kpi": {
    "orderCount": 74, "revenueAvos": 547100, "refundedAvos": 0,
    "discountAvos": 0, "covers": 175,
    "offline":         { "orderCount": 66, "revenueAvos": 477200, "refundedAvos": 0, "discountAvos": 0, "covers": 150 },
    "online":          { "orderCount": 19, "revenueAvos": 119700, "refundedAvos": 0, "discountAvos": 0, "covers": 40 },
    "onlinePlatform":  { "orderCount": 8,  "revenueAvos": 69900,  "refundedAvos": 0, "discountAvos": 0, "covers": 25 }
  },

  "breakdown": {
    "byPayment": [
      { "method": "Mpay", "amountAvos": 360500 },
      { "method": "會員餘額", "amountAvos": 84400 }
    ],
    "paymentBreakdown": [
      { "method": "Mpay",          "label": "Mpay",      "channel": "offline",
        "orderCount": 46, "receivableAvos": 360700, "paidAvos": 360500, "diffAvos": 200 },
      { "method": "in_store",      "label": "到店付款",  "channel": "online_projection",
        "orderCount": 8,  "receivableAvos": 51300,  "paidAvos": 52600,  "diffAvos": -1300 },
      { "method": "外賣平台",       "label": "外賣平台",  "channel": "online_platform",
        "orderCount": 8,  "receivableAvos": 75600,  "paidAvos": 69900,  "diffAvos": 5700 }
    ]
  },

  "ordersTotal": 93,
  "orders": [
    { "orderNo": "訂單27", "totalAvos": 3800, "status": "draft",           "channel": "offline" },
    { "orderNo": null,     "totalAvos": 6200, "status": "paid",            "channel": "online_projection" },
    { "orderNo": "mfood-…", "totalAvos": 6200, "status": "settled",         "channel": "online_platform" }
  ],

  "dishesTotal": 64,
  "dishes": [
    { "name": "表嫂肉餅飯", "qty": 11, "revenueAvos": 55600,
      "offlineQty": 11, "offlineRevenueAvos": 55600, "onlineQty": 0,  "onlineRevenueAvos": 0 },
    { "name": "快閃餐(腐乳肉碎蒸茄子饭)", "qty": 7, "revenueAvos": 30200,
      "offlineQty": 0, "offlineRevenueAvos": 0,      "onlineQty": 7,  "onlineRevenueAvos": 30200 }
  ],

  "flags": {
    "refundsNetted": false,
    "clamped": false,
    "ordersTruncated": false,
    "dishesTruncated": false,
    "onlineIncluded": true,
    "ledgerOwnsOnlineRevenue": true,
    "platformRefundsIncluded": false
  }
}
```

### 4.3 caps 標頭

```
x-pos-offline-report-caps: kpi,byPayment,orders,dishes,channel,paymentBreakdown
```

- 有 `channel` ⇒ `orders[]` 每列一定有 `channel`
- 冇 `channel` ⇒ 舊版 0060 ⇒ Ledger 照舊淨線下 render，**零影響**
- 新 key **全缺** → 優雅降級；**只缺一部分** → 503（SQL 有 bug，失敗得響）

---

## 5. 個人資料紅線（守住 v1 原意）

擴充唔會放寬任何一條：

- ❌ `order_note`、item `note`、`discount_note`、`comp_note`、`voided_reason`
- ❌ 顧客姓名／電話／會員 id
- ❌ `raw_json`（平台單原始 payload，入面有 `customer.remark`）
- ❌ `platform_fees` 嘅逐項 label
- ✅ `items` 白名單維持：`name` / `menuItemId` / `quantity` / `price` / `voided`  
  （`selectedSpecs` **唔讀** —— 實測得 23/38 行有值，讀咗只係加大 payload）

🔴 收銀員姓名依然唔會出現（`pos_orders` 本身冇呢欄）。

---

## 6. 🔴 守衛測試嘅一個盲點（必須一併修）

`offline-report-guard.test.ts` 而家**寫死讀 0058 / 0059 兩個檔**：

```js
const MIGRATION = "supabase/migrations/0058_pos_offline_report_rpc.sql";
const MIGRATION_DETAIL = "supabase/migrations/0059_pos_offline_report_detail.sql";
```

所以呢幾條鐵律**會守住一份歷史檔案，而唔係守住現行權威**：

- L205「🔴 排除線上投影單」
- L339「orders 要包未結帳單」
- L345「排除線上投影單 ＋ 四條時間腿」
- L365 附近「只計 settled／paid」「排除已退菜」「items 白名單」

⇒ 即使 0066 寫錯，呢啲測試**全部照綠**。必須改指向 `0066`。  
（同 [記憶 §6.1](./113-agent-gotchas.md)：守行為不變量，唔守代碼字串。  
今次要守嘅行為係「channel 三值分類正確」＋「四條時間腿」＋「只讀 settled/paid」。）

新增守衛（逐行為，唔寫死整句 code）：

1. `channel` 判定包含 `source in ('aomi','mfood')` 分支（守**平台單唔可以漏**）
2. `channel` 判定包含 `online_order_id is not null` 分支
3. `orders[]` 一列**至少**有 `orderNo`/`totalAvos`/`status`/`channel`
4. `dishes[]` 一列**至少**有 `name`/`qty`/`revenueAvos`/`offlineQty`/`onlineQty`
5. `paymentBreakdown` 每個 bucket 三個數都係非負整數（**`diffAvos` 唔喺呢個白名單**，因為可以負）
6. `dishes[]` 兩處 `order by` 都係 `revenue_avos desc`（截斷用嘅同排序用嘅必須一致）
7. 新 SQL **冇** `order_note` / `discount_note` / `comp_note` / `raw_json` / `platform_fees`
8. 🔴 **舊 `kpi` 五欄嘅 SQL 邏輯同 0060 逐字一致**（守「v1 已上線嘅值唔可以靜靜哋變」）
9. 🔴 **舊 `byPayment` 同樣保留 0060 邏輯**（守「bar 唔會突然少咗外賣平台」）
10. 🔴 **翻譯表對齊**：`knownLedgerPaymentModes()` 每個 key 都喺 SQL 嘅 CASE 出現
    （守 `payment-method-label.ts` 同 SQL 唔會漂）；反向亦要檢查 SQL 冇多出
    唔喺真源入面嘅 key（會撞 store 自訂名）

---

## 7. 風險登記

| #   | 風險                                                                 | 嚴重度 | 處理                                                                                             |
| --- | ------------------------------------------------------------------ | --- | ---------------------------------------------------------------------------------------------- |
| 1   | 🔴 **`kpi` 舊五欄**（74 / 5,471）**其實包埋平台單**，Ledger 自己嗰份已有 ⇒ 重複計算 699 | 已存在 | **唔改舊欄**（改咗佢張卡即刻跳數）。改用 `kpi.offline/online/onlinePlatform` 精確拆分 + 契約寫明舊欄語意 + `flags.ledgerOwnsOnlineRevenue` 誠實揭露 |
| 2   | 🔴 `orders[]` 張數 75 → 93（新增線上＋Grabber、剔走 1 張 `cancelled` 平台單）| 高   | 每列有 `channel`；契約教佢哋用 `channel == 'offline'` 過濾（⚠️ `online_order_id IS NULL` 唔夠，會漏平台單）|
| 3   | 🔴 `dishes[]` 菜品由 49 款變 64 款，排序亦變（金額倒序）              | 高   | `qty`／`revenueAvos` 保留做總數；新欄係 additive；`dishesTotal` 仍係真實總數                          |
| 4   | 🔴 `dishes[].onlineRevenueAvos` 同 Ledger 自己嘅線上營業額重疊         | 中   | 契約明寫「線上菜品只係**菜品維度**分析，唔好再加落營業額」；`flags.onlineIncluded`                  |
| 5   | 中 部署次序（push 先過 migration）                                | 中   | 沿用 0059 驗過嘅閥：新 key 全缺＝降級、部分缺＝503                                                   |
| 6   | 中 `diffAvos` 語意隨 channel 變（線下＝折扣／平台＝平台抽成，可負）        | 中   | 契約逐 channel 講明；SQL **唔夾非負**；`diffAvos` 唔入「非負整數」白名單                             |
| 7   | 低 payload 增大                                                    | 低   | 實測 22 KB，離 3 秒 timeout 極遠；上限唔使改                                                        |
| 8   | 低 菜品聯集可能撞 300 上限                                              | 低   | 實測 64 款；且 `dishesTotal` 仍然係真實總數                                                          |

---

## 8. 部署次序

1. 商家跑 **`0066_pos_offline_report_channel.sql`**（SQL Editor，無 transaction、可重跑）
2. push → Vercel 部署（**任一先後都安全**，見 §4.3）
3. 發增補契約俾 Ledger，請佢讀 `x-pos-offline-report-caps` 嘅 `channel` token
4. 🔴 **對數守則（唔可以用「差額合理」落結論）**：
   - `kpi`（舊五欄）**必須維持 74 張 / 5,471** —— 變咗即係 SQL 有 bug，唔係「正常更新」
   - `kpi.offline + kpi.online + kpi.onlinePlatform` = 66+19+8 = **93 張 ／ 6,668**
   - `kpi.offline + kpi.onlinePlatform` = 66+8 = **74 張 ／ 5,471 ＝ 舊 `kpi`**
     （因為 v1 口徑包埋平台 settled 單）
   - `ordersTotal` = **93**；`94 − 1` ＝ 唯一被剔嘅 `online_platform / cancelled`
   - `Σ paymentBreakdown[channel=offline].paidAvos = kpi.offline.revenueAvos`
   - `Σ dishes[].offlineRevenueAvos ≈ kpi.offline.revenueAvos`（差額＝服務費／稅／折扣／抹零）
   - `Σ paymentBreakdown[].paidAvos = kpi.revenueAvos`（舊欄位總和）—— 用嚟捉漏 bucket

---

## 9. 已驗證 / 未驗證

**已用生產唯讀數據驗實**：三種來源嘅張數同金額、平台單被誤算入 v1 口徑、raw Ledger 支付值、
菜品聯集款數、應收 vs 實收差額分佈、`items` 欄位完整性、payload 容量。

**未驗（要上線後驗）**：0066 plpgsql 執行期行為（`tools/check-pos-offline-report-sql.py` 只驗語法）、
Supabase 側執行時間、Ledger 側 render。

## 10. 修訂記錄

| 時間   | 改動                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 22:30 | **J 澄清「Ledger 自己有線上訂單數據」** ⇒ 推翻「`kpi` 改全渠道 6,668」（會雙重計算）。`kpi`／`byPayment` 舊欄改為**零改動**，精確拆分另開 `kpi.offline/online/onlinePlatform`；`orders[]` 改為**全量＋最新 Grabber** |
| 22:35 | 第三次探測（`tools/_probe-offlinereport-v1base-20261007.cjs`）逐 `(channel\|status)` 點算，更正兩個基數：v1 `kpi` = **74 張**（淨 75 − 1 張未計 sales 嘅 cancelled 平台單，唔係 75）；`ordersTotal` v1 = **75** → v2 = **93**（剔 `cancelled`） |

## 11. 相關

- [153 · orders\[\] + dishes\[\]](./153-ledger-offline-report-orders-dishes.md)
- [150 · 線下營業摘要 route](./150-ledger-offline-report-route.md)
- [`integration/pos-offline-report-v1-addendum-2026-09-26.md`](./integration/pos-offline-report-v1-addendum-2026-09-26.md)
- [113 · agent gotchas](./113-agent-gotchas.md) §對外整合 route、§守衛測試設計
