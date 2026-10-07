# 154 · Ledger 報表：offline-report 擴充為「線上＋線下」

> 2026-10-07 · 承 [153](./153-ledger-offline-report-orders-dishes.md)  
> 現行程式：`supabase/migrations/0066_pos_offline_report_channel.sql`（**現行權威**）  
> 基準：`supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql`（舊欄數值基準）
>
> ⚠️ **22:30 修訂**：J 指出「Ledger 自己已經有線上訂單數據」⇒ 原方案
> 「`kpi` 由 4,772 改 6,668」會令 Ledger **雙重計算**，已推翻。見 §1.2 ＋ §3.3。
>
> 🔴🔴🔴 **當日事故 ＋ 最終方案（下方 §0.0 必讀）**：本文檔 §3.1／§3.2／§3.4／§3.5
> 原本建議「把 `orders[]`／`dishes[]` 改成全渠道」。**咁做已經喺 production 試過，
> 結果打爛咗 Ledger 嗰張已對數嘅卡**，J 拍板**方案 A：還原舊欄，線上另開新 key**。
> §0.0 係現行權威，**同 §3.1／3.2／3.4／3.5 矛盾時以 §0.0 為準**。

---

## 0.0 🔴🔴🔴 最終方案（方案 A · J 拍板 · 已實作）

### 事故經過

| 階段 | 發生咗咩事 |
|---|---|
| v1 稿 | 建議把 `orders[]`／`dishes[]` 由淨線下改成全渠道 |
| 0066 v1 實作 | 照 v1 稿寫，舊欄 `ordersTotal` 74 → **93**、舊 `dishes[]` 加拆欄令 `qty`／`revenueAvos` 由「淨線下」變成全渠道 |
| 部署 | Ledger 顯示「**店內 POS 線下資料暫時無法取得，線上報表不受影響。**」 |
| 診斷 | 舊 code 收到新 payload **唔會 503**（照送 200）⇒ Ledger 照 render 一份**架構相符但數值被改**嘅 JSON |
| 根本教訓 | J 嘅鐵律要守**三樣**，唔係一樣：① 欄位名 ② 型別／層級 ③ **數值**。只守 ①② 會漏掉「加咗欄位但順手改咗舊欄口徑」 |

> ℹ️ **2026-10-07 產勘更正**：呢個事故記錄（連同 §3／§4／§6）早前引用過一組
> 具體基數「`dishes[].qty` 42 → 54、`revenueAvos` 84,000 → 108,000、`ordersTotal` 75」。
> 經生產資料重算（PostgREST 逐字照 0060 SQL 口徑，全店 94 張單、164 行 items、無日期上限），
> **該組數字係文檔虛構值**，已全部改成「相對口徑」描述。真實實測值係：
> `kpi` 74 張 / 547,100 avos、`ordersTotal` **74**、`dishesTotal` **58**（Σqty 198 / Σrev 549,900）、
> `ordersByChannelTotal` **93**、`dishesByChannelTotal` **63**（Σqty 225 / Σrev 667,600）。
> 關鍵係 `ordersTotal` 一直係 **74**（唔係 75）：`kpi`（74）同 `ordersTotal`（74）
> 之所以啱啱好一樣，係因為呢間店嗰 3 日全部單都係 `settled`，
> `cancelled` 嗰張係平台單、**喺 `orders[]` 之間被剔咗**（`orders[]` 剔 `cancelled`，
> 而 74 張可計銷售單亦全部 `settled`）。
> **呢個更正唔影響方案 A 嘅結論** —— 「舊欄一個數字都唔改」係靠**對數**判定
> （`Σ byPayment = kpi.revenueAvos`、舊 `dishes[]` 每個名都喺 `dishesByChannel[]` 出現
> 且 `dishes[].qty ≥ dishesByChannel[].offlineQty`），
> **唔係**靠對死一個會隨日期滾動嘅絕對值。
>
> 🔴 **為咗 `dishesTotal` 曾經報過 59／`dishesByChannelTotal` 報過 64**：
> 唔係日期窗口、唔係聚合 key、唔係漏行（`Content-Range` 94 == 抓到 94），
> 而係**取證工具自己有 bug** —— 用 `d += chunk` 逐 chunk 拼字串，
> 跨 chunk 邊界嘅中文（3 bytes UTF-8）被切爛成 `�` ⇒ 菜名變另一個字串 ⇒ 聚合多一行。
> 修正（`Buffer.concat` 後先 `toString("utf8")`）後 **15 輪連跑全部穩定 58／63**。
> 教訓見 §10。

### 拍板結果：方案 A

> **舊 `orders[]`／`dishes[]` 一個數字都唔改，線上數據全部搬去新 key。**

| | 內容 | 狀態 |
|---|---|---|
| 舊 `kpi` 五欄 | 逐字還原 0058 口徑 | ✅ 一個數字都冇改 |
| 舊 `byPayment` | 逐字還原 0060 口徑 | ✅ 一個數字都冇改 |
| 舊 `orders[]` / `ordersTotal` | **還原 0060**（`online_order_id is null`） | ✅ 主店 90 日 74 張 |
| 舊 `dishes[]` / `dishesTotal` | **還原 0060**（三欄、金額倒序） | ✅ 主店 90 日 58 款 |
| 舊 `orders[]` 每列 `channel` | **保留**（純 additive，唔改數字） | ✅ 見下 |
| 🆕 `ordersByChannel` + Total | 全渠道訂單 | ✅ 主店 90 日 93 張；線上單淨係喺呢度 |
| 🆕 `dishesByChannel` + Total | 全渠道菜品 ＋ 四拆欄 | ✅ 主店 90 日 63 款 |
| 🆕 `kpi.offline/online/onlinePlatform` | 精確三路拆分 | ✅ 66 / 19 / 8 |
| 🆕 `breakdown.paymentBreakdown` | 全渠道 `method × channel` 七欄 | ✅ |
| `flags.onlineIncluded` → `channelBreakdownAvailable` | **改名**（舊名語意已錯） | ✅ 對外從未被消費 ⇒ 零風險 |

⚠️ **點解舊 `orders[]` 保留 `channel` 但舊 `dishes[]` 唔加拆欄？**

因為 `orders[]` 同 `dishes[]` 嘅**數量口徑**都係 0060 定義，兩者都唔准郁。
`channel` 係**純新增一個 key**，一個舊數字都冇改 —— 而且佢係**誠實嘅**：
外賣平台單冇 `online_order_id` ⇒ 舊 `orders[]` 一直包埋平台單，標示出嚟先係真。
`dishes[]` 加拆欄就**必然**要改 `qty` 語意（淨線下 → 全渠道）⇒ 拆欄只可以放新 key。

### 三道防線（防止再犯）

| 層 | 做法 |
|---|---|
| SQL 守衛 | 0066 嘅舊欄 SQL 段同 **0060 基準逐字比對**（`offline-report-guard.test.ts`） |
| 驗證層 | 舊 `dishes[]` 出現任何拆欄 ⇒ **503**（`rpc-dish-split-on-legacy`） |
| 降級閥 | 六個渠道 key **要麼全有、要麼全無**（部分缺 = SQL 有 bug ⇒ 503） |

### 🔴🔴 驗收必須用「對數」，唔可以用絕對值

呢個係 2026-10-07 產勘嘅第三個教訓。三個唔同來源嘅錯誤基數（`ordersTotal` 75、
`dishes` 42/42/84,000、線上 `qty` 54）都係**同一個病根**：
我哋寫咗一批**冇實測過**嘅數字落驗收註解。

| 病 | 症狀 |
|---|---|
| ① 寫死會滾動嘅值 | 每日新單入窗就變 ⇒ 驗收必然過唔到 |
| ② 寫死冇對過嘅值 | 一旦錯，會令人**以為修好咗但實際冇**（今次就係咁） |
| ③ 驗收寫「兩欄相等」但範圍唔同 | `Σ paymentBreakdown[].paidAvos` = **666,800**（全渠道 93 張），
但 `kpi.revenueAvos` = **547,100**（v1 口徑 74 張）⇒ 條等式**根本唔可能成立** |

⇒ 權威驗收檔：**`supabase/verify/0066_verify_production_20261007.sql`**（14 條，pglast 驗過語法；
⚠️ 放喺 `verify/` 唔係 `migrations/` —— 佢係唯讀 SELECT、要 service role，
   留喺 `migrations/` 會被 `db push` 用 postgres role 跑而失敗），
全部係自我一致／對數檢查。權威等式：

```text
Σ byPayment[].amountAvos                                        === kpi.revenueAvos
kpi.offline + kpi.onlinePlatform                                === kpi（v1 口徑）
kpi.offline + kpi.online + kpi.onlinePlatform                   === 全渠道
Σ paymentBreakdown[].paidAvos where channel <> 'online_projection'  === kpi.revenueAvos
ordersByChannelTotal − ordersTotal                              === count(ordersByChannel where channel = 'online_projection')
dishesByChannel[i].offlineQty + onlineQty                       === dishesByChannel[i].qty
dishesByChannel[i].offlineRevenueAvos + onlineRevenueAvos        === dishesByChannel[i].revenueAvos
舊 dishes[] 每個 name 都喺 dishesByChannel[] 出現                （舊 ⊂ 新）
dishesByChannel[] 多出嘅名嘅 offlineQty / offlineRevenueAvos     === 0（純線上菜）
同名行 dishes[].qty      >= dishesByChannel[].offlineQty
同名行 dishes[].revenueAvos >= dishesByChannel[].offlineRevenueAvos
ordersTotal === length(orders)｜dishesTotal === length(dishes)
舊 dishes[] 出現任何拆欄欄位                                    === 0
```

🔴 **注意上面冇「`dishesByChannel[].offline*` === `dishes[]`」呢一條 ——
因為佢**永遠唔成立**（舊 `dishes[]` base 係 `online_order_id is null` ＝ offline **＋平台單**）。
詳見 §4.2.1。

### ⚠️ Production 部署注意

**0066 已經喺 production 跑過 v1（錯誤）版本。必須重跑同一個檔案**（`create or replace`，可重跑）。
重跑之後跑 `0066_verify_production_20261007.sql` 全部 14 條，全部綠燈即係還原成功。
**唔好對任何絕對值** —— 只睇恆等式。

---

## 0. 一句話（v1 稿原意，已被 §0.0 取代）

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
⇒ **v1 `orders[]` 實際輸出 = 74 張 / MOP 5,471**（`orders[]` **會剔 `cancelled`**，
所以嗰張 65 平台單**唔喺** `orders[]` 入面 ⇒ 張數同 `kpi` 一樣都係 74；
v2 全渠道 `ordersByChannel[]` 剔 `cancelled` 但**唔剔**線上投影 ⇒ **93 張**）

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

離線 58 款（Σqty 198／Σrev 549,900）/ 線上聯集 63 款（Σqty 225／Σrev 667,600）。
（⚠️ 呢個「離線」含平台單 —— 舊 `dishes[]` 嘅 base 係 `online_order_id is null`；
  純 offline 只有 49 款。詳見 §4.2.1。）
線上單 `items` 欄位完整（38 行全部有 `name`／`price`／`quantity`／`menuItemId`，0 缺），
聚合 key 可以同線下一樣用 `menuItemId|名稱`。`selectedSpecs` 只有 23 行有 —— **唔需要讀**。

### 1.4 容量（用戶已拍板照舊 additive）

| 項目         |    現時上限 |         90 日實測 | 結論              |
| ---------- | ------: | -------------: | --------------- |
| `orders[]` | 3,000 張 |     74 張（舊）／93 張（全渠道） | 唔會截斷            |
| `dishes[]` |   300 款 |  58 款（舊）／63 款（全渠道） | 唔會截斷            |
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

### 3.1 ~~移除排除條件（4 處 → 0 處）~~ 🔴 **已被 §0.0 取代：5 處全部保留**

> **⚠️ v1 稿建議「整句刪走」—— 已廢棄。** 刪走咗就會改動舊欄數值（生產事故）。
> **現行：0066 內 `online_order_id is null` 仍然出現 5 處**（KPI／byPayment／refunded／
> 舊 `orders[]`／舊 `dishes[]`），全部**逐字等於 0060 基準**，並由守衛測試逐字比對。
> 全渠道嘅另外 5 段（新 `kpiByChannel`／`paymentBreakdown`／`ordersByChannel`／
> `dishesByChannel` 嘅基礎）**冇**呢個條件。

<details>
<summary>（v1 稿原文，已廢棄）</summary>

```sql
-- 0060 現時（KPI / byPayment / refunded / orders / dishes 各一處）
  and o.online_order_id is null
-- 0066：整句刪走，唔係改成別的條件
```

</details>

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

### 3.4 ~~`orders[]`：全量 + 每列加 `channel`~~ 🔴 **已被 §0.0 取代**

> **⚠️ 以下係 v1 稿，已廢棄。** 「列表由 74 張變 93 張（長 19 行）」呢個後果**唔可以發生** ——
> 佢正係令 Ledger 張卡報錯嘅原因。**現行做法：舊 `orders[]` 還原 74 張（只加 `channel` 標示），
> 93 張嘅全渠道版本放喺新 key `ordersByChannel[]`。**

```json
{ "orderNo": "訂單27", "totalAvos": 3800, "status": "draft", "channel": "offline" }
{ "orderNo": null,     "totalAvos": 6200, "status": "paid",  "channel": "online_platform" }
```

- 狀態口徑**完全唔變**（全部狀態，只剔除 `cancelled`）
- 排序、上限 3,000、事件時間四條腿、Asia/Macau —— 全部唔變
- 🔴 舊 `orders[]` **維持 0060 口徑**（`online_order_id is null`）⇒ **主店 90 日 74 張，一個數字都冇改**
- 舊 `orders[]` **唔會**出現 `online_projection`（`online_order_id` 條件擋咗）
- 但會出現 `online_platform` —— 因為平台單冇 `online_order_id`，**一直**喺舊 array 入面
- 🆕 全渠道 93 張喺 `ordersByChannel[]`（欄位完全一樣，同一個 renderer 可以讀兩個 key）
- 🔴 **恆等式**：`ordersByChannelTotal − ordersTotal` ＝ `ordersByChannel` 入面
  `channel = 'online_projection'` 嘅張數（實測 93 − 74 = 19）⇒ 任何日子都成立

### 3.5 ~~`dishes[]`：每列加線上／線下拆欄~~ 🔴 **已被 §0.0 取代**

> **⚠️ 以下係 v1 稿，已廢棄 —— 呢個正係生產事故嘅直接原因。**
> 保留 `qty` 做「總數」會令佢由「淨線下」變成全渠道，`revenueAvos` 同樣被改。
> Ledger 舊 parser 唔識新欄位，但**照樣 render `qty`** ⇒ 舊卡跳數。
> **現行做法：舊 `dishes[]` 淨返三欄，拆欄只喺新 key `dishesByChannel[]`。**

<details>
<summary>（v1 稿原文，已廢棄）</summary>

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

</details>

✅ **現行（方案 A）**：

| key | 欄位 | 實測 90 日（2026-10-07） |
|---|---|---|
| `dishes[]`（舊） | `name` / `qty` / `revenueAvos` **三欄** | 58 款／Σqty 198／Σrev 549,900 |
| `dishesByChannel[]`（新） | 七欄（總數 ＋ 四拆欄） | 63 款／Σqty 225／Σrev 667,600 |

四拆欄喺新 key **必填**，server 驗 `offlineQty + onlineQty === qty`，唔符就 503。
🔴 舊 `dishes[]` **三欄，一個都唔准加** ⇒ server 見到拆欄就 503（`rpc-dish-split-on-legacy`）。
🔴 **恆等式**：`dishesByChannel[]` 每行嘅 `{offlineQty, offlineRevenueAvos}`
**完全等於** `dishes[]` 每行嘅 `{qty, revenueAvos}`（以 `name` 做 key）——
呢條先係「舊欄冇因為加新欄而順手改口徑」嘅直接證據。

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

## 4. 最終 report 欄位結構變化（方案 A）

### 4.1 逐節對照

| 節 | 欄位 | 變化 |
|---|---|---|
| `v` | `1` | ➡️ **唔升**（升咗 Ledger `v === 1` 檢查會整包丟棄） |
| `kpi` 五欄 | `orderCount,revenueAvos,refundedAvos,discountAvos,covers` | ✅ **完全唔改**（名、型別、**SQL 舊邏輯逐字保留**，主店 90 日 = 74 張 / 547,100 avos） |
| `kpi.offline` / `kpi.online` / `kpi.onlinePlatform` | 各 5 個欄 | 🆕 精確拆分（66 / 19 / 8） |
| `breakdown.byPayment` | `[{method, amountAvos}]` | ✅ **完全唔改**（同樣保留 0060 邏輯，一個數字都唔郁）。🔴 ΣamountAvos ＝ `kpi.revenueAvos`（恆等式） |
| `breakdown.paymentBreakdown` | `[{method,label,channel,orderCount,receivableAvos,paidAvos,diffAvos}]` | 🆕 全渠道支付分類（macau-pos「支付方式分項」同款）。🔴 **ΣpaidAvos ≠ `kpi.revenueAvos`**（全渠道 666,800 vs v1 口徑 547,100）—— 對數要 `where channel <> 'online_projection'` |
| `orders[]` | `{orderNo,totalAvos,status}` | ➕ 每列加 **`channel`**（純 additive）；🔴 **張數一個數字都冇改**（主店 90 日 74 張） |
| `ordersTotal` | int | ✅ **完全唔改**（主店 90 日 = 74） |
| `dishes[]` | `{name,qty,revenueAvos}` | ✅ **完全唔改**（三欄、主店 90 日 58 款 / Σqty 198 / Σrev 549,900）—— 🔴 v1 稿加拆欄嘅方案已廢棄 |
| `dishesTotal` | int | ✅ **完全唔改**（主店 90 日 = 58） |
| 🆕 `ordersByChannel` + `ordersByChannelTotal` | `[{orderNo,totalAvos,status,channel}]` | 🆕 **全渠道（主店 90 日 93 張）**（線上投影單淨係喺呢度出現） |
| 🆕 `dishesByChannel` + `dishesByChannelTotal` | `[{name,qty,revenueAvos,offlineQty,offlineRevenueAvos,onlineQty,onlineRevenueAvos}]` | 🆕 **全渠道（主店 90 日 63 款）** ＋ 四拆欄（七欄全部必填） |
| `flags.ordersTruncated` / `dishesTruncated` | bool | 不變 |
| 🆕 `flags.ordersByChannelTruncated` / `dishesByChannelTruncated` | bool | 新 key 各自獨立，唔會牽動舊 key |
| ~~`flags.onlineIncluded`~~ → `flags.channelBreakdownAvailable` | `true` | 🆕 **已改名**（舊名語意錯：舊欄已還原，唔再含線上單）。0066 從未成功交付 ⇒ 對外未被消費 ⇒ 改名零風險 |
| `flags.ledgerOwnsOnlineRevenue` | `true` | 🆕 **誠實揭露：線上營業額以 Ledger 自己數據源為準**，唔好同 `kpi` 相加 |

🔴 **一句話總結**：舊 key **零改動**（只加咗 `orders[].channel` 一個 key），
線上數據全部喺四個新 key。`ordersTotal` 74 vs `ordersByChannelTotal` 93 嘅差異
就係「舊欄一個數字都冇改」嘅證明。

⚠️ 上表括號內嘅**絕對值只係 2026-10-07 嘅實測快照，會隨日期滾動** ——
驗收請用 §0.0 嘅恆等式，唔好對死數字。

### 4.2 完整 JSON 形狀（現行）

```json
{
  "v": 1,
  "storeId": "8291f843-…",
  "from": "2026-07-10",
  "to": "2026-10-07",
  "generatedAt": "2026-10-07T14:02:00.000Z",

  "kpi": {
    "orderCount": 74, "revenueAvos": 547100, "refundedAvos": 0,
    "discountAvos": 0, "covers": 74,
    "offline":         { "orderCount": 66, "revenueAvos": 477200, "refundedAvos": 0, "discountAvos": 0, "covers": 66 },
    "online":          { "orderCount": 19, "revenueAvos": 119700, "refundedAvos": 0, "discountAvos": 0, "covers": 19 },
    "onlinePlatform":  { "orderCount": 8,  "revenueAvos": 69900,  "refundedAvos": 0, "discountAvos": 0, "covers": 8 }
  },

  "breakdown": {
    "byPayment": [
      { "method": "Mpay", "amountAvos": 360500 },
      { "method": "會員餘額", "amountAvos": 84400 },
      { "method": "外賣平台", "amountAvos": 69900 },
      { "method": "現金", "amountAvos": 22700 },
      { "method": "會員餘額 + Mpay", "amountAvos": 9600 }
    ],
    "paymentBreakdown": [
      { "method": "Mpay",      "label": "Mpay",      "channel": "offline",
        "orderCount": 46, "receivableAvos": 360500, "paidAvos": 360500, "diffAvos": 0 },
      { "method": "會員餘額",   "label": "會員餘額",   "channel": "offline",
        "orderCount": 16, "receivableAvos": 84400, "paidAvos": 84400, "diffAvos": 0 },
      { "method": "外賣平台",   "label": "外賣平台",   "channel": "online_platform",
        "orderCount": 8,  "receivableAvos": 72700, "paidAvos": 69900, "diffAvos": 2800 },
      { "method": "線上已支付", "label": "線上已支付", "channel": "online_projection",
        "orderCount": 9,  "receivableAvos": 57600, "paidAvos": 57600, "diffAvos": 0 },
      { "method": "in_store",  "label": "到店付款",   "channel": "online_projection",
        "orderCount": 8,  "receivableAvos": 50800, "paidAvos": 52600, "diffAvos": -1800 },
      { "method": "balance",   "label": "餘額扣點",   "channel": "online_projection",
        "orderCount": 1,  "receivableAvos": 4400,  "paidAvos": 4600,  "diffAvos": -200 }
    ]
  },

  "ordersTotal": 74,
  "orders": [
    { "orderNo": "訂單12", "totalAvos": 21000, "status": "settled", "channel": "offline" },
    { "orderNo": "澳覓#1", "totalAvos": 6200,  "status": "settled", "channel": "online_platform" }
  ],

  "dishesTotal": 59,
  "dishes": [
    { "name": "表嫂肉餅飯", "qty": 11, "revenueAvos": 55600 },
    { "name": "酸菜魚飯套餐（海鱸魚）", "qty": 6, "revenueAvos": 36500 }
  ],

  "ordersByChannelTotal": 93,
  "ordersByChannel": [
    { "orderNo": "訂單12", "totalAvos": 21000, "status": "settled", "channel": "offline" },
    { "orderNo": "澳覓#1", "totalAvos": 6200,  "status": "settled", "channel": "online_platform" },
    { "orderNo": "011",    "totalAvos": 6300,  "status": "settled", "channel": "online_projection" }
  ],

  "dishesByChannelTotal": 63,
  "dishesByChannel": [
    { "name": "表嫂肉餅飯", "qty": 11, "revenueAvos": 55600,
      "offlineQty": 11, "offlineRevenueAvos": 55600, "onlineQty": 0, "onlineRevenueAvos": 0 },
    { "name": "快閃餐（金不换炒蝦仁饭）", "qty": 11, "revenueAvos": 53400,
      "offlineQty": 6, "offlineRevenueAvos": 28900, "onlineQty": 5, "onlineRevenueAvos": 24500 }
  ],

  "flags": {
    "refundsNetted": false,
    "clamped": false,
    "ordersTruncated": false,
    "dishesTruncated": false,
    "ordersByChannelTruncated": false,
    "dishesByChannelTruncated": false,
    "channelBreakdownAvailable": true,
    "ledgerOwnsOnlineRevenue": true
  }
}
```

<details>
<summary>（v1 稿嘅 JSON，已廢棄 —— 舊欄被改咗，Ledger 就係喺呢版報錯）</summary>

<details>
<summary>展開</summary>

```json
{
  "ordersTotal": 93,
  "orders": [
    { "orderNo": "訂單27", "totalAvos": 3800, "status": "draft",    "channel": "offline" },
    { "orderNo": null,     "totalAvos": 6200, "status": "paid",     "channel": "online_projection" }
  ],
  "dishesTotal": 64,
  "dishes": [
    { "name": "表嫂肉餅飯", "qty": 11, "revenueAvos": 55600,
      "offlineQty": 11, "offlineRevenueAvos": 55600, "onlineQty": 0, "onlineRevenueAvos": 0 }
  ],
  "flags": { "onlineIncluded": true }
}
```

🔴 錯喺：`ordersTotal` 74 → 93、舊 `dishes[]` 加咗拆欄而數值由「淨線下」變成全渠道。
舊 Ledger 唔識拆欄，但**照樣 render `qty`** ⇒ 舊卡跳數。

ℹ️ 上面 `dishesTotal: 64` 同 `{offlineQty: 11, onlineQty: 0}`（`offlineQty === qty`）
就係**壞版嘅機械特徵** —— 驗收時見到 `offlineQty === qty && onlineQty === 0` 就可以
100% 確定舊欄被改咗，唔使再對任何絕對值。

### 4.2.1 🔴🔴 `dishes[]` 與 `dishesByChannel[].offline*` **唔可能**逐行相等（常見誤解）

好多人（包括我）第一反應係寫驗證式：

```text
dishesByChannel[i].{offlineQty, offlineRevenueAvos}  ===  dishes[] 中同名嗰行
```

🔴 **呢條式係錯嘅，永遠唔會成立。** 原因係兩者嘅 base 唔同：

| | base 條件 | 涵蓋渠道 |
|---|---|---|
| 舊 `dishes[]` | `online_order_id is null` | `offline` **＋ `online_platform`** |
| `dishesByChannel[].offline*` | `channel = 'offline'` | 只有 `offline` |

平台單（`source IN ('aomi','mfood')`）**冇 `online_order_id`**
⇒ 佢哋一直喺舊 `dishes[]` 入面，但**唔會**被計入 `dishesByChannel[].offline*`。

**生產實測（2026-10-07，94 張單）**：

```text
Σ dishes[].qty                     = 198
Σ dishesByChannel[].offlineQty     = 184      （198 − 184 = 14 ＝ 平台單菜品 qty）
Σ dishes[].revenueAvos             = 549,900
Σ dishesByChannel[].offlineRevenue = 477,200  （差 72,700 ＝ 平台單菜品 rev）

實例：{ "name": "表嫂手打肉餅", "qty": 3, "revenueAvos": 19,200 }   ← 舊 dishes[]
      同一道菜喺 dishesByChannel 係 offlineQty=0 / onlineQty=3
      （全部來自 online_platform 渠道）
```

⇒ 正確驗證式係**單向包含**（見 §8.3）：舊 `dishes[]` 每個名都喺新 key 出現，
且 `dishes[].qty ≥ dishesByChannel[].offlineQty`。
另外新 key 會**多出**純線上菜品（實測 5 款：`Y14 表嫂肉碎生菜包`、`M5 椒鹽豆腐`、
`冬菇紅棗蒸滑雞飯`、`B3 香腸雞蛋炒飯`、`鱼皮`，全部 `offlineQty = 0`）—— 呢個係設計意圖，唔係 bug。

</details>
</details>

### 4.3 caps 標頭

```text
x-pos-offline-report-caps: kpi,byPayment,orders,dishes,kpiByChannel,paymentBreakdown,ordersByChannel,dishesByChannel
```

- 有 `kpiByChannel` ⇒ 六個渠道 key 一齊存在（`kpiByChannel` / `paymentBreakdown` /
  `ordersByChannel` / `ordersByChannelTotal` / `dishesByChannel` / `dishesByChannelTotal`）
- 冇 `kpiByChannel` ⇒ 舊版 ⇒ Ledger 照舊 render，**零影響**
- 渠道 key **全缺** → 優雅降級；**只缺一部分** → 503（SQL 有 bug，失敗得響）
- `hasChannel` 依賴 `hasDetail`：冇明細就唔宣告渠道（冇嘢可標示來源）
- ⚠️ caps **冇`channel` 呢個 token**（v1 稿有，已改）—— 因為舊 `orders[]` 嘅 `channel`
  喺 0060 之前就冇，而 caps 係用嚟探測**新能力**嘅

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

## 6. 🔴 守衛測試設計（已修，並因為事故升級）

### 6.1 原始盲點

`offline-report-guard.test.ts` 原本**寫死讀 0058 / 0059 兩個檔**：

```js
const MIGRATION = "supabase/migrations/0058_pos_offline_report_rpc.sql";
const MIGRATION_DETAIL = "supabase/migrations/0059_pos_offline_report_detail.sql";
```

所以鐵律只守住一份歷史檔案，唔係現行權威 ⇒ 即使 0066 寫錯，測試全部照綠。

### 6.2 🔴🔴 事故揭示嘅更深盲點：「字串存在」守唔到數值

原設計守嘅係「排除條件**出現**喺 SQL 裏面」。但生產事故嘅真實樣板係：

> 舊 `dishes[]` **加咗四個拆欄**（每個都係合法字串，guard 完全通過），
> 而 `qty` **同時**由「淨線下」變成全渠道 —— 舊條件一句都冇改。

⇒ 🔴 **守「條件／字串存在」係守唔到「數值」**。
同 [記憶 §6.1](./113-agent-gotchas.md) 一致：**守行為不變量，唔守代碼字串**。

### 6.2.1 🔴🔴🔴 產勘再發現：守衛守住咗 SQL，驗收註解仍然會騙人

2026-10-07 產勘（重跑 0066 之後）發現**第三層盲點**，比 §6.2 更陰險：

| 層 | 守住咩 | 狀態 |
|---|---|---|
| SQL guard（§6.3） | 0066 舊欄 SQL ≡ 0060 逐字 | ✅ SQL 冇問題（確實成立） |
| 驗證層（§6.4） | 舊欄出現拆欄 / 六 key 半套 ⇒ 503 | ✅ 正常 |
| 🔴 **migration 檔尾驗收註解** | 「→ 74 / 547100 / **75 / 42 / 42 / 84000**（實測 0060 基數）」 | ❌ **呢三個數係虛構** |

⇒ 前兩層全部綠燈，SQL 完全正確，但**照住驗收註解跑就會得出正確值（74 / 59 / 198 / 549,900）
而以為仲未修好** —— 因為註解寫住另一組數。

**教訓（三病同源）**：

| 病 | 症狀 |
|---|---|
| ① 守「代碼字串」而非行為 | §6.2 已經講咗 |
| ② 🔴 守 SQL 但唔守**驗收註解** | 註解入面嘅數字同 SQL 一樣「唔可以被 guard 捉到」，因為 guard 唔讀註解 |
| ③ 🔴 驗收寫**絕對值** | 滾動窗口 ⇒ 必然過唔到；寫錯 ⇒ 令人以為壞咗 |

⇒ **驗收必須全部用恆等式**（§0.0 權威清單）。SQL guard 守嘅係「有冇改口徑」，
但「改咗之後啱唔啱」只有對數可以答。

### 6.3 ✅ 現行守衛（`offline-report-guard.test.ts`）

**核心手法：把 0066 嘅舊欄 SQL 段抽出，同 0060 基準逐字比對。**

```js
const MIGRATION_V1_BASELINE = "supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql";
```

`normalizeLegacySegment()` 只剝走 0066 新增嘅三樣（`case … end as channel,`、
`'channel', p.channel`、懸空逗號），其餘**逐字比對**：

| 守衛 | 守住咩 |
|---|---|
| 舊 `orders[]` 段 ≡ 0060 | 舊口徑唔會變全渠道 |
| 舊 `dishes[]` 段 ≡ 0060 | 舊口徑唔會吸水、唔會加拆欄 |
| v1 `kpi`／`byPayment`／`refunded` 三段 ≡ 0060 | 舊五欄唔會靜靜變 |
| 0060 基準自身不可退化 | 反證工具唔會污染基準 |
| `onlineIncluded` 唔准再出現 | 改名後唔會有人加返舊名 |
| `channel` 三值 CASE block × 5 | 平台單唔會漏、掃碼單唔會當線下 |
| `online_order_id is null` 出現 5 處 | 舊欄口徑冇被刪走 |
| 舊 `OfflineReportDishRow` **唔准**有拆欄欄位 | 類型層都封死（反證捉到過：runtime 有閘但 type 冇） |
| 新 `OfflineReportDishByChannelRow` **必須**有四拆欄 | 唔會有人「優化」走 |
| 新 SQL 冇 `order_note`／`raw_json`／`platform_fees` | 紅線 |

**反證（counter-proof）**：20 個 mutation 逐個注入 → 跑守衛 → 必須變紅 → 還原。
（有 1 個 mutation 因字串不匹配被跳過，唔計入分母。）

### 6.4 驗證層第二道防線（`offline-report.ts`）

| 情況 | 行為 |
|---|---|
| 舊 `dishes[]` 出現任何拆欄 | **503** `rpc-dish-split-on-legacy` |
| 六個渠道 key 只缺一部分 | **503** `rpc-partial-channel-keys` |
| `dishesByChannel[]` 四拆欄只缺一部分 | **503** `rpc-partial-dishch-split` |
| `offlineQty + onlineQty ≠ qty` | **503** `rpc-dishch-split-qty-mismatch` |
| `offlineRevenueAvos + onlineRevenueAvos ≠ revenueAvos` | **503** `rpc-dishch-split-rev-mismatch`（2026-10-07 補） |

🔴🔴 兩條守恆都係對**同一行嘅自己總數**：`offline* + online* === qty / revenueAvos`。
**唔可以**誤寫成 `offline*` 要同舊 `dishes[]` 同名行相等 —— 舊 `dishes[]` 包埋
`online_platform`（見 §4.2.1），咁守會喺正常生產資料上誤報 503。
反證已做：拎走 `rev-mismatch` 守衛 → `offline-report.test.ts` 即紅燈。

⇒ 就算 SQL 寫錯，**都唔會靜靜送出被改咗嘅舊數字**。

---

## 7. 風險登記（方案 A 更新）

| # | 風險 | 嚴重度 | 處理 |
|---|---|---|---|
| 1 | 🔴 **`kpi` 舊五欄**（74 / 547,100）**其實包埋平台單**，Ledger 自己嗰份已有 ⇒ 重複計算 69,900 | 已存在 | **唔改舊欄**。改用 `kpi.offline/online/onlinePlatform` 精確拆分 + 契約寫明舊欄語意 + `flags.ledgerOwnsOnlineRevenue` 誠實揭露 |
| 2 | 🔴🔴 **舊欄數值被靜靜改動**（已發生：`ordersTotal` 74→93、舊 `dishes[]` 加拆欄令數值由「淨線下」變成全渠道） | **已發生** | ✅ 已修：方案 A 還原舊欄 ＋ 三道防線（§6.3 SQL 逐字比對／§6.4 驗證層 503／反證測試） |
| 3 | 🔴 舊 `dishes[]` 殘留拆欄（0066 v1 已喺 production 跑過） | **高** | ✅ 驗證層 503；**必須重跑 0066**（§8） |
| 4 | 🔴 `dishesByChannel[].onlineRevenueAvos` 同 Ledger 自己嘅線上營業額重疊 | 中 | 契約明寫「線上菜品只係**菜品維度**分析，唔好再加落營業額」；`flags.ledgerOwnsOnlineRevenue` |
| 5 | 中 部署次序（push 先過 migration） | 中 | 沿用 0059 驗過嘅閥：新 key 全缺＝降級、部分缺＝503 |
| 6 | 中 `diffAvos` 語意隨 channel 變（線下＝折扣／平台＝平台抽成，可負） | 中 | 契約逐 channel 講明；SQL **唔夾非負**；`diffAvos` 唔入「非負整數」白名單。實測**兩行為負**（`in_store` −1,800／`balance` −200），一行為正（`外賣平台` +2,800） |
| 7 | 低 payload 增大（新 key 令 payload 由 ~12 KB 升到 ~22 KB） | 低 | 離 3 秒 timeout 極遠；上限唔使改 |
| 8 | 低 `dishesByChannel` 菜品聯集可能撞 300 上限 | 低 | 實測 63 款；`dishesByChannelTotal` 仍然係真實總數 |
| 9 | 🔴🔴 **驗收註解寫死虛構基數**（已發生：`75 / 42 / 42 / 84000` 係虛構，令**正確**結果似錯誤） | **已發生** | ✅ 已修：驗收全改恆等式；權威檔 `0066_verify_production_20261007.sql`（14 條，pglast 驗語法） |
| 10 | 🔴 `paymentBreakdown` ΣpaidAvos ≠ `kpi.revenueAvos`（範圍唔同：666,800 全渠道 vs 547,100 v1 口徑） | 中 | 契約寫明對數要 `where channel <> 'online_projection'`；**唔係 bug** |
| 11 | 🔴🔴 **取證工具本身有 bug**（`d += chunk` 逐 chunk 拼字串，跨 chunk 嘅中文被切爛成 `�`）⇒ 同一份數據報過 `dishesTotal` 58/59、`dishesByChannelTotal` 63/64 | **已發生** | ✅ 已修：權威探針改 `Buffer.concat` 後再 `toString("utf8")`；15 輪連跑穩定。**同源教訓寫入 §10** |
| 12 | 🔴🔴 **契約寫咗一條永遠唔成立嘅恒等式**（`dishesByChannel[].offline*` ≡ `dishes[]`），會令正確結果被誤判為 bug | 中 | ✅ 已修：改成單向包含 + 差額等於平台單菜品（§4.2.1、§8.3） |

---

## 8. 部署次序

### 8.1 🔴🔴🔴 應急：0066 曾經「Success 但實際係壞嘅」，必須**再重跑一次**

**現況（2026-10-08 更新）**：0066 v1（錯誤版）曾喺 production 跑咗，舊欄數值被改，
Ledger 顯示「店內 POS 線下資料暫時無法取得」。J 之後重跑過方案 A 版，SQL Editor 回
`Success. No rows returned` —— **但函數其實仍然係壞嘅**。

#### 🔴🔴 事故二：`create or replace function` 只驗語法、唔驗欄位

Postgres 嘅 `check_function_bodies` 只對 PL/pgSQL 做 **parse**，**唔做**欄位／型別解析。
SQL 語句要等到**第一次執行**嗰陣先 plan。所以：

```text
SQL Editor：  Success. No rows returned      ← 睇落完全正常
第一次執行：  ERROR 42703: column "status" does not exist
```

J 跑驗收 SQL 嗰陣先爆，而**呢個正正就係 Ledger 一直報錯嘅真正原因**（唔係舊 code 拒收）。

**呢次一共兩條 CTE 漏欄**（都要執行先爆）：

| # | 位置 | 漏咗乜 | 邊度用 |
|---|---|---|---|
| 1 | `kpiByChannel` 嘅 `base` CTE | `o.status` | 下面 `sale`（`where status in ('settled','paid')`）同 `ref`（`where status in ('refunded','partially_refunded')`） |
| 2 | `dishesByChannel` 嘅 `per_channel` CTE | `min(dname) as dname` | 下面 `agg` 用 `min(dname)` 還原菜名 |

✅ 兩處都已補，並喺 migration 入面加註釋講明「點解呢欄一定要喺 select list」。
🔴 **第 2 條係肉眼掃漏嘅** —— 第 1 條我睇得出，第 2 條要本地真跑先捉到。

#### ✅ 解法：本地真跑（PGlite），唔使 service role

新增 `tools/verify-offline-report-rpc.cjs`：由已部署 bundle 抽 anon key →
PostgREST 抓主店全部行（`count=exact` + `Content-Range` 驗證）→ 落 PGlite 建表建函數 →
**實際執行** → 對 30 條恆等式。

```bash
NODE_PATH=<node workspace>/node_modules node tools/verify-offline-report-rpc.cjs
```

**呢個先至係真正嘅驗證**：修好嘅 SQL 用真實 production 94 行跑出嚟嘅數字，
同 `_probe-offlinereport-truth` 支**獨立**取證探針（自己用 PostgREST 重算）**逐位相同**：

```text
74 / 547,100 ／ 93 ／ 58 / 198 / 549,900 ／ 63 / 225 / 667,600
offline 66/477,200　online 19/119,700　platform 8/69,900
paymentBreakdown 全渠道 666,800；排除 online_projection = 547,100
```

反證已做：拎走 `o.status` → 工具即印
`[3] execute FAIL >>> column "status" does not exist`（exit 1）。

| 步驟 | 動作 | 狀態 |
|---|---|---|
| **1** | **再重跑** `0066_pos_offline_report_channel.sql`（含兩條 CTE 漏欄 fix） | ⏳ **待跑** |
| 2 | 跑 `supabase/verify/0066_verify_production_20261007.sql` 全部 14 條 | ⏳ 待跑（SQL Editor，service role） |
| 3 | push → Vercel 部署新 code | ⏳ 待做（**唔急**，舊 code 收到正常 payload 完全正常） |

⚠️ **步驟 1 唔需要等 code 部署** —— 正常嘅 payload 對舊 code 而言完全正常。
（即係話：**SQL 先行係安全嘅，唔使倒轉。**）

⚠️ **步驟 2 唔可以對絕對值。** 呢個係 2026-10-07 產勘嘅重點：
舊版驗收註解寫住嘅 `75 / 42 / 42 / 84,000` 係**虛構值**
（生產重算證實 `dishes[]` 實為 58 款／Σqty 198／Σrev 549,900，
且全店冇任何一行 `qty === 42` 或 `revenueAvos === 84,000`），
照住對會得出**正確**值卻以為仲未修好。

### 8.2 正常次序（首次安裝）

1. 商家跑 `0066_pos_offline_report_channel.sql`
2. push → Vercel 部署（**任一先後都安全**，見 §4.3）
3. 發增補契約俾 Ledger，請佢讀 `x-pos-offline-report-caps` 嘅 `kpiByChannel` token
   （⚠️ **唔係** `channel` token —— 見 §4.3）

### 8.3 🔴 對數守則：全部用恆等式（唔可以用絕對值、唔可以用「差額合理」）

| 檢查（恆等式，任何日子都成立） | 期望 |
|---|---|
| `Σ byPayment[].amountAvos` | **＝ `kpi.revenueAvos`** |
| `ordersTotal` | **＝ `length(orders)`** |
| `dishesTotal` | **＝ `length(dishes)`** |
| 舊 `dishes[]` 有拆欄嘅行數 | **0** |
| 舊 `orders[]` 出現 `online_projection` 嘅行數 | **0** |
| 舊 `dishes[]` 每個 `name` 都喺 `dishesByChannel[]` 出現 | **100%**（舊 ⊂ 新） |
| `dishesByChannel[]` 多出嘅名（舊冇）嘅 `offlineQty`／`offlineRevenueAvos` | **兩者都係 0**（純線上菜） |
| 同名行：`dishes[].qty` | **≥ `dishesByChannel[].offlineQty`** |
| 同名行：`dishes[].revenueAvos` | **≥ `dishesByChannel[].offlineRevenueAvos`** |
| `Σ dishes[].qty − Σ dishesByChannel[].offlineQty` | **＝ 平台單菜品 qty**（實測 14） |
| `Σ dishes[].revenueAvos − Σ dishesByChannel[].offlineRevenueAvos` | **＝ 平台單菜品 rev**（實測 72,700） |
| `dishesByChannel[i].offlineQty + onlineQty` | **＝ `dishesByChannel[i].qty`** |
| `kpi.offline + kpi.onlinePlatform` | **＝ 舊 `kpi`（v1 口徑）** |
| `kpi.offline + kpi.online + kpi.onlinePlatform` | **＝ 全渠道總數** |
| `ordersByChannelTotal − ordersTotal` | **＝ `ordersByChannel` 入面 `online_projection` 張數** |
| `ordersByChannelTotal` | **＝ `length(ordersByChannel)`** |
| `dishesByChannelTotal` | **＝ `length(dishesByChannel)`** |
| `Σ paymentBreakdown[].paidAvos` **where `channel <> 'online_projection'`** | **＝ `kpi.revenueAvos`** |
| `Σ paymentBreakdown[].paidAvos`（全體） | **＝ `kpi.offline + online + onlinePlatform` 嘅 revenueAvos**（**唔等於** `kpi.revenueAvos`） |
| `diffAvos < 0` 嘅行數 | **≥ 1**（零行 = 你啱啱夾咗非負，唔啱） |
| 舊／新 `dishes[]` 金額排序 | 單調不升 |
| 六個渠道 key | 全部存在（唔會半套） |

📌 2026-10-07 實測快照（**僅供理解量級，唔好做回歸斷言**）：
`kpi` 74 張／547,100、`ordersTotal` 74、`dishesTotal` **58**（Σqty 198／Σrev 549,900）、
`ordersByChannelTotal` 93、`dishesByChannelTotal` **63**（Σqty 225／Σrev 667,600）、
`paymentBreakdown` 全體 ΣpaidAvos 666,800、排除線上投影後 547,100。

---

## 9. 已驗證 / 未驗證

**已用生產唯讀數據驗實**（PostgREST 逐字重算 0060 口徑，全店 94 張單／無日期上限；
`Content-Range` 斷言抓齊 94 行，`id.asc` 全序避免並列排序漂移；
`Buffer.concat` 後先 decode 避免中文跨 chunk 被切爛）：
三種來源嘅張數同金額、平台單被誤算入 v1 口徑、raw Ledger 支付值、
`paymentBreakdown` 九行真實值（**兩行 `diffAvos < 0`**）、三路 `kpi` 拆分、
舊欄 74／547,100／74／**58**／198／549,900、新欄 93／**63**／225／667,600、
5 款純線上菜品、`dishes[]` 與 `dishesByChannel[].offline*` 嘅單向包含關係。
權威腳本 `tools/_probe-offlinereport-truth-20261007.cjs`（**31 條恒等式全綠**，
輸出 `tools/_probe-offlinereport-truth-20261007.json`）。

**已驗（守衛）**：`offline-report.test.ts` + `offline-report-guard.test.ts` 合共 **184 條**全綠；
`tsc --noEmit` 0 error；反證有效；`tools/check-offline-sql.py` 全部 migration 語法通過
（0066 驗 4 個 body、驗收檔 14 個 body）。

**✅ 已驗（本地真跑 · 2026-10-08）**：`tools/verify-offline-report-rpc.cjs` 用 PGlite
落真實 production 94 行**實際執行** 0066 函數，**30 條恆等式全綠**，
輸出數字同上面獨立取證探針**逐位相同**。反證：拎走 `o.status` 即紅燈。

**未驗（要上 production 驗）**：Supabase 側執行時間、Ledger 側 render、
service role 下嘅實際回應（本地係 invoker 直跑，權限路徑未覆蓋）。

## 10. 修訂記錄

| 時間 | 改動 |
|---|---|
| 22:30 | **J 澄清「Ledger 自己有線上訂單數據」** ⇒ 推翻「`kpi` 改全渠道 6,668」（會雙重計算）。`kpi`／`byPayment` 舊欄改為**零改動**，精確拆分另開 `kpi.offline/online/onlinePlatform`；`orders[]` 改為**全量＋最新 Grabber** |
| 22:35 | 第三次探測逐 `(channel × status)` 點算，得出 v1 `kpi` = **74 張／547,100** |
| 🔴 **事故** | 0066 v1 上線後 Ledger 報「店內 POS 線下資料暫時無法取得」。根因：`ordersTotal` 74→93、舊 `dishes[]` 加拆欄令數值由「淨線下」變全渠道。**舊 code 唔會 503**（照送 200）⇒ Ledger 照 render 被改咗嘅舊數字 |
| 🔴 **教訓 1** | J 嘅鐵律要守**三樣**：① 欄位名 ② 型別／層級 ③ **數值**。v1 只守 ①②。守「條件字串存在」守唔到數值 |
| ✅ **方案 A** | J 拍板：**還原舊欄，線上另開新 key**。`ordersByChannel[]`／`dishesByChannel[]`（六個渠道 key）＋ `flags.onlineIncluded` → `channelBreakdownAvailable`。驗證層加 `rpc-dish-split-on-legacy`。守衛改為**同 0060 基準逐字比對** |
| ✅ **文件** | 增補契約升 v2；本方案書加 §0.0 事故記錄，§3.1／3.4／3.5／4 標記為已取代 |
| 🔴 **教訓 2** | **驗收註解嘅基數係虛構值**：`ordersTotal 75`／`dishes 42 / Σqty 42 / Σrev 84,000` 三個數從未對過生產。照住對會得出**正確**結果卻以為未修好。⇒ 驗收全改**恒等式**；新權威檔 `0066_verify_production_20261007.sql`（14 條） |
| 🔴🔴 **教訓 3** | **取證工具自己嘅 bug 會偽造「數據在變」**：`d += chunk` 逐 chunk 拼字串，中文（3 bytes UTF-8）跨 chunk 邊界被切爛成 `�` ⇒ 同一份 production 數據報過 `dishesTotal` **58 同 59**、`dishesByChannelTotal` **63 同 64**，逼我以為有並列排序漂移／分頁漏行／窗口差異，浪費大量時間。⇒ **正解：`Buffer.concat(chunks)` 後先 `toString("utf8")`**；另外 `Prefer: count=exact` ＋ `Content-Range` 斷言抓齊、`order=id`（唯一鍵全序）避免 `created_at` 並列漂移。**呢兩樣係「量度可信」嘅最低門檻** |
| 🔴🔴 **教訓 4** | **契約恒等式要自己用生產數據驗一次**：我寫落契約同 0066 驗收 SQL 嘅 `dishesByChannel[].offline*` ≡ `dishes[]` **永遠唔成立**（舊 `dishes[]` base 係 `online_order_id is null` ＝ offline **＋平台單**）。用生產 31 條恒等式跑先捉到。⇒ 任何「A 恆等於 B」嘅式，寫落契約之前**必須**先喺生產跑一次並且**連跑數輪確認穩定** |
| ✅ **產勘** | J 重跑 0066（`Success. No rows returned` ＝ 成功） |
| 🔴🔴 **教訓 2（本輪）** | **驗收註解嘅基數係虛構值**：`ordersTotal 75`／`dishes 42 / Σqty 42 / Σrev 84,000` 三個數從未對過生產。導致照住驗收會得出**正確**結果卻以為未修好。⇒ 驗收全部改**恆等式**；新權威檔 `0066_verify_production_20261007.sql`（14 條） |
| 🔴 **教訓 3（本輪）** | **`paymentBreakdown` 係全渠道** ⇒ `ΣpaidAvos = 666,800`，而 `kpi.revenueAvos = 547,100`。舊驗收寫「兩欄相等」**根本唔可能成立**。正確對數要 `where channel <> 'online_projection'` |
| 🔴 🔴 🔴 **教訓 5（2026-10-08）** | **`create or replace function` 只驗語法、唔驗欄位** ⇒ SQL Editor 回 `Success. No rows returned`，但函數**執行**先爆 `42703 column "status" does not exist`。今次**兩條 CTE 漏欄**（`base` 漏 `o.status`；`per_channel` 漏 `min(dname)`），第 2 條肉眼掃唔到。🔴 **呢個就係 Ledger 一直報錯嘅真正原因**（我一直以為係舊 code 拒收 v1 payload）。⇒ **正解：本地用 PGlite 真跑一次**（`tools/verify-offline-report-rpc.cjs`）；`check-offline-sql.py` 呢類純語法 checker **唔可以**當做「SQL 已驗」。**任何 plpgsql 改動，語法通過 ≠ 可以跑** |
| 🔴 **教訓 6（2026-10-08）** | **「文檔聲稱有」≠「代碼真係有」**：文檔一直寫「拆欄守恆會驗」，實際 `offline-report.ts` **只守數量、冇守金額**（`offlineQty+onlineQty===qty` 有，`offlineRevenueAvos+onlineRevenueAvos===revenueAvos` 冇）⇒ 金額欄 merge 漏分支會靜靜通過。已補 `rpc-dishch-split-rev-mismatch` ＋ 2 條行為測試。⇒ **驗收前要逐條對文檔 ↔ 代碼**，唔好淨係讀文檔 |

## 11. 相關

- [153 · orders\[\] + dishes\[\]](./153-ledger-offline-report-orders-dishes.md)
- [150 · 線下營業摘要 route](./150-ledger-offline-report-route.md)
- [`integration/pos-offline-report-v1-addendum-2026-09-26.md`](./integration/pos-offline-report-v1-addendum-2026-09-26.md)
- [`integration/pos-offline-report-channel-addendum-2026-10-07.md`](./integration/pos-offline-report-channel-addendum-2026-10-07.md)（**俾 Ledger 嘅正式契約 · v2**）
- [113 · agent gotchas](./113-agent-gotchas.md) §對外整合 route、§守衛測試設計

