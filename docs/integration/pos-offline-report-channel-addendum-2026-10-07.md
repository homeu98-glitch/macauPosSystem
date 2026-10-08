# 線下營業摘要 API —— 契約 v1 渠道增補（菜品分渠道 + 支付分項 + 訂單來源）

> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem) ⇄ Ledger
> **日期**：2026-10-07（**v2 · 同日修訂**）
> **方向**：不變（**Ledger 伺服器 → POS**，同一支 route、同一把 secret、同一個簽名方式）
> **關係**：**additive 增補** —— [v1 原件](./pos-offline-report-api.md) ＋
> [2026-09-26 增補](./pos-offline-report-v1-addendum-2026-09-26.md) 全部條款**繼續有效**。
> `v` **仍然係 `1`**。**現有欄位名／型別／層級／數值一個都唔改。**
> **本檔可以直接轉貼畀 Ledger。**

---

## 🔴🔴🔴 v2 修訂聲明（睇呢段先）

v1 稿曾經建議「把 `orders[]`／`dishes[]` 由淨線下改成全渠道」。
**咁做會改動你哋已對數嘅舊數字** —— 你哋嗰張卡嘅 `orders` 張數會由 74 變 93 張，
而 `dishes[]` 嘅 `qty`／`revenueAvos` 會由「淨線下」變成「全渠道」。
你哋現有 UI 照 `v:1` 架構 render，**唔識新欄位但會照 render 被改咗嘅舊數字**。

⇒ **v2 改為：舊 `orders[]`／`dishes[]` 完全還原 09-26／0060 定義，一個數字都同原來一樣；
線上數據全部搬去四個新 key。**

| | v1 稿（已廢棄，**唔好照做**） | v2（現行） |
|---|---|---|
| `orders[]` | 改成全渠道（74 → 93 張） | **還原 74 張**（同 09-26 一致） |
| `dishes[]` | 改成全渠道（`qty`／`revenueAvos` 吸水） | **還原淨線下**（`online_order_id is null`） |
| `dishes[]` 拆欄 | 四欄加喺舊 array | **舊 array 淨返三欄**；拆欄喺 `dishesByChannel[]` |
| 線上單喺邊 | `orders[]` | **`ordersByChannel[]`** |

**如果已經照 v1 稿接咗** —— 請即刻停用 `orders[]`／`dishes[]` 嘅新欄位讀取，
改讀新 key。你哋舊卡**唔需要**做任何 rollback（舊數值會自己回來）。

> ℹ️ **2026-10-07 補充**：v2 稿早前版本曾喺呢個段落寫過
> 「`dishes[].qty` 42 → 54、`revenueAvos` 84,000 → 108,000」呢組**具體基數**。
> 經生產資料重算（PostgREST 逐字照 0060 SQL 口徑，全店 94 張單、164 行 items、無日期上限），
> 該組數字係**文檔虛構值**，已刪除：全店冇任何一行 `qty === 42`、亦冇 `revenueAvos === 84,000`
> 或 `108,000`，`dishes[]` 實算為 **58 款／Σqty 198／Σrev 549,900**。
> **呢個更正唔影響本增補嘅設計** —— 「舊欄一個數字都唔改」係靠**對數**判定
> （`Σ byPayment = kpi.revenueAvos`、舊 `dishes[]` = 新 `dishesByChannel[]` 嘅線下子集），
> **唔係**靠對死一個會隨日期滾動嘅絕對值。

---

## 一句話

同一支 `GET /api/integration/ledger/offline-report`（**一次呼叫、唔加參數**）會多回**四個新 key**，
而**所有舊 key 一個數字都唔改**：

| 你哋想要 | 邊個 key |
|---|---|
| ① 菜品分渠道（同一款菜，線上／線下各幾多） | 🆕 `dishesByChannel[]`（七欄：總數 ＋ 四個拆欄） |
| ② 訂單來源標示（線上定線下） | 🆕 `ordersByChannel[]`（每列帶 `channel`） |
| ③ 支付方式分項（同 POS 報表頁嗰張卡） | 🆕 `breakdown.paymentBreakdown` |
| ④ 渠道總覽（張數／營業額分三邊） | 🆕 `kpi.offline` / `kpi.online` / `kpi.onlinePlatform` |

另外兩個輔助 flag：`flags.channelBreakdownAvailable` / `flags.ledgerOwnsOnlineRevenue`。

### ⚠️ 關於 ④ 嘅**實際 JSON 形狀**（2026-10-08 更新，請以呢段為準）

我哋嘅 **RPC 層**確實回一個頂層 key `kpiByChannel`，但 **API 回應層**會把它攤平
放入 `kpi` 入面。即係你哋實際收到嘅係：

```json
"kpi": {
  "orderCount": 25, "revenueAvos": 216100, "...": "（五個舊欄，完全不變）",
  "offline":        { "orderCount": 23, "revenueAvos": 203700, "covers": 23, "...": "" },
  "online":         { "orderCount": 11, "revenueAvos": 66200,  "covers": 11, "...": "" },
  "onlinePlatform": { "orderCount": 2,  "revenueAvos": 12400,  "covers": 2,  "...": "" }
}
```

🔴 **請讀 `kpi.offline` / `kpi.online` / `kpi.onlinePlatform`（嵌套），
唔好讀頂層 `kpiByChannel`** —— API 回應**冇**呢個頂層 key。
（我哋 `x-pos-offline-report-caps` 標頭入面嗰個 `kpiByChannel` 係**能力名稱**，
指「渠道 KPI 可用」，唔係 JSON key 名；呢點我哋會喺下一版標頭厘清。）

⚠️ 第三個渠道 `onlinePlatform` ＝ 外賣平台單（澳覓／mfood）。
按雙方 2026-10-08 確認：**平台單歸你哋嘅線上營收** ⇒
你哋**唔好**再把 `kpi.onlinePlatform` 加落自己嘅平台數（會雙重計）。見下面 §第二件事。

---

## 🔴🔴 第一件事：你哋**唔好**改現有 UI 嘅任何一行

本次**冇任何一個現有欄位改名、改型別、改層級、改數值**。
`v` 亦都**冇升**（你哋如果 assert `v === 1`，照樣過）。

* `kpi.orderCount` / `kpi.revenueAvos` / `kpi.refundedAvos` / `kpi.discountAvos` / `kpi.covers`
  —— **數值完全唔變**（連計算口徑都係逐字保留）。
* `breakdown.byPayment` —— **完全唔變**。
* `orders` / `ordersTotal` / `dishes` / `dishesTotal` —— **完全唔變**（連排序都係 0060 定案嗰個）。
* `flags.refundsNetted` / `flags.clamped` / `flags.ordersTruncated` / `flags.dishesTruncated`
  —— 完全唔變。

⇒ **你哋嗰張已對數嘅卡，零影響。** 新資料全部喺新 key，唔讀就當睇唔到。

⚠️ **一個例外，請留意**：`orders[]` 每列會多一個 `channel` 欄。
呢個係**純新增欄位**，一個舊數字都冇改（你哋舊 parser 唔識就自然忽略）。
保留佢係因為：外賣平台單（Grabber 推入）冇 `online_order_id`，所以**舊 `orders[]` 其實一直包埋平台單**
—— 標示出嚟先係誠實，唔標先係講大話。
`dishes[]` 就**冇**任何新欄（拆欄只喺新 key）。

---

## 🔴🔴 第二件事：線上營業額**唔可以**同 `kpi` 相加

呢個係最容易踩嘅坑，請務必留意。

`kpi` 五欄嘅口徑係「`online_order_id IS NULL`」，而**外賣平台單（Grabber 推入）冇呢個欄位**
⇒ **平台單現時已經被包埋喺 `kpi` 入面**。

主店 90 日實測：

| | 張數 | 營業額 |
|---|---|---|
| `kpi`（v1 口徑，**含**平台單） | **74** | **MOP 5,471** |
| 其中：線下 settled | 66 | MOP 4,772 |
| 其中：平台 settled | 8 | MOP 699 |
| 線上投影（掃碼／排位／快餐採納） | 19 | MOP 1,197 |

你哋自己嘅 `public.orders` 已經有平台單 ⇒ **如果再把 `kpi` 同你哋嘅線上數相加，平台嗰 699 會重複計兩次。**

所以我哋加咗一個 flag 明確講呢件事：

```json
"flags": {
  "ledgerOwnsOnlineRevenue": true
}
```

**請照佋行：線上營業額以你哋自己嘅數據源為準，我哋 `kpi` 唔好再加落去。**
要睇 POS 側嘅渠道拆分，請讀下面嘅 `kpi.offline` / `kpi.online` / `kpi.onlinePlatform`。

### 🔴🔴 2026-10-08 追加（J 拍板：**平台單算你哋嘅線上營收**）

呢個拍板令上面嗰條規則**更具體**，請一齊睇：

| 渠道 | 歸邊 | 你哋應該點用 |
|---|---|---|
| `kpi.offline`（線下 POS） | 我哋獨有 | ✅ 直接用 |
| `kpi.online`（線上投影：掃碼／排位／快餐採納） | 我哋獨有 | ✅ 直接用 |
| `kpi.onlinePlatform`（外賣平台：澳覓／mfood） | **算你哋嘅線上營收** | 🔴 **唔可以再加落你哋自己嘅平台數** |

即係話：

```text
你哋嘅「線上營業額」＝ 你自己 public.orders 嘅數（已含平台單）
                   ＋ kpi.online（我哋嘅線上投影單）
                   ⛔ 唔好加 kpi.onlinePlatform   ← 呢筆你哋已經有，加就雙重計
```

⚠️ `kpi.onlinePlatform` 嘅用途係**對數／稽核**（例如核對平台抽成），
**唔係**畀你哋加落營業額。實測 90 日呢筆係 8 張 / MOP 699。

---

## 回應 200（新增部分）

原有欄位全部唔變。新增如下（**註意所有舊 array 嘅數值都係 09-26 嗰版嘅值**）：

```json
{
  "v": 1,
  "storeId": "8291f843-9def-4956-9d0b-1cfef2598306",
  "from": "2026-07-10",
  "to": "2026-10-07",
  "generatedAt": "2026-10-07T14:00:00.000Z",

  "kpi": {
    "orderCount": 74,
    "revenueAvos": 547100,
    "refundedAvos": 0,
    "discountAvos": 0,
    "covers": 74,

    "offline":         { "orderCount": 66, "revenueAvos": 477200, "refundedAvos": 0, "discountAvos": 0, "covers": 66 },
    "online":          { "orderCount": 19, "revenueAvos": 119700, "refundedAvos": 0, "discountAvos": 0, "covers": 19 },
    "onlinePlatform":  { "orderCount": 8,  "revenueAvos": 69900,  "refundedAvos": 0, "discountAvos": 0, "covers": 8 }
  },

  "breakdown": {
    "byPayment": [
      { "method": "Mpay",             "amountAvos": 360500 },
      { "method": "會員餘額",          "amountAvos": 84400 },
      { "method": "外賣平台",          "amountAvos": 69900 },
      { "method": "現金",              "amountAvos": 22700 },
      { "method": "會員餘額 + Mpay",   "amountAvos": 9600 }
    ],

    "paymentBreakdown": [
      { "method": "Mpay",       "label": "Mpay",       "channel": "offline",          "orderCount": 46, "receivableAvos": 360500, "paidAvos": 360500, "diffAvos": 0 },
      { "method": "會員餘額",    "label": "會員餘額",    "channel": "offline",          "orderCount": 16, "receivableAvos": 84400,  "paidAvos": 84400,  "diffAvos": 0 },
      { "method": "外賣平台",    "label": "外賣平台",    "channel": "online_platform",  "orderCount": 8,  "receivableAvos": 72700,  "paidAvos": 69900,  "diffAvos": 2800 },
      { "method": "線上已支付",  "label": "線上已支付",  "channel": "online_projection", "orderCount": 9,  "receivableAvos": 57600,  "paidAvos": 57600,  "diffAvos": 0 },
      { "method": "in_store",   "label": "到店付款",    "channel": "online_projection", "orderCount": 8,  "receivableAvos": 50800,  "paidAvos": 52600,  "diffAvos": -1800 },
      { "method": "現金",        "label": "現金",        "channel": "offline",          "orderCount": 3,  "receivableAvos": 22700,  "paidAvos": 22700,  "diffAvos": 0 },
      { "method": "會員餘額 + Mpay", "label": "會員餘額 + Mpay", "channel": "offline",   "orderCount": 1,  "receivableAvos": 9600,   "paidAvos": 9600,   "diffAvos": 0 },
      { "method": "Mpay",       "label": "Mpay",       "channel": "online_projection", "orderCount": 1,  "receivableAvos": 4900,   "paidAvos": 4900,   "diffAvos": 0 },
      { "method": "balance",    "label": "餘額扣點",    "channel": "online_projection", "orderCount": 1,  "receivableAvos": 4400,   "paidAvos": 4600,   "diffAvos": -200 }
    ]
  },

  "ordersTotal": 74,
  "orders": [
    { "orderNo": "訂單12", "totalAvos": 21000, "status": "settled", "channel": "offline" },
    { "orderNo": "訂單20", "totalAvos": 15100, "status": "settled", "channel": "offline" },
    { "orderNo": "澳覓#1", "totalAvos": 6200,  "status": "settled", "channel": "online_platform" }
  ],

  "dishesTotal": 58,
  "dishes": [
    { "name": "表嫂肉餅飯",         "qty": 11, "revenueAvos": 55600 },
    { "name": "酸菜魚飯套餐（海鱸魚）", "qty": 6,  "revenueAvos": 36500 },
    { "name": "快閃餐(湿炒豉椒猪杂河粉)", "qty": 8, "revenueAvos": 32700 }
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
      "offlineQty": 11, "offlineRevenueAvos": 55600,
      "onlineQty": 0,   "onlineRevenueAvos": 0 },
    { "name": "快閃餐（金不换炒蝦仁饭）", "qty": 11, "revenueAvos": 53400,
      "offlineQty": 6,  "offlineRevenueAvos": 28900,
      "onlineQty": 5,   "onlineRevenueAvos": 24500 },
    { "name": "表嫂手打肉餅", "qty": 3, "revenueAvos": 19200,
      "offlineQty": 0,  "offlineRevenueAvos": 0,
      "onlineQty": 3,   "onlineRevenueAvos": 19200 }
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

🔴 **`ordersTotal` 74 vs `ordersByChannelTotal` 93 —— 呢個差異就係「舊欄一個數字都冇改」嘅證明。**
`dishes[]` vs `dishesByChannel[]` 同理：`58 款／Σqty 198／Σrev 549,900`
對 `63 款／Σqty 225／Σrev 667,600`。

⚠️ **上面所有數值都係 2026-10-07 對 `2026-07-10 → 2026-10-07` 嘅生產實測值，
但佢哋會隨日期滾動** —— 每日新單入窗就會變。**請唔好用任何絕對值做回歸斷言**，
改用下面呢啲**恆等式**（任何日子都成立）：

```text
Σ byPayment[].amountAvos                                === kpi.revenueAvos
kpi.offline + kpi.online + kpi.onlinePlatform           === 全渠道總數
kpi.offline + kpi.onlinePlatform                        === kpi（v1 口徑）
ordersByChannelTotal − ordersTotal                      === count(ordersByChannel where channel = 'online_projection')
dishesByChannel[i].offlineQty + onlineQty               === dishesByChannel[i].qty
dishesByChannel[i].offlineRevenueAvos + onlineRevenueAvos === dishesByChannel[i].revenueAvos
ordersTotal === length(orders)｜dishesTotal === length(dishes)
Σ paymentBreakdown[].paidAvos（全渠道）                  !== kpi.revenueAvos（範圍唔同）
Σ paymentBreakdown[].paidAvos where channel <> 'online_projection' === kpi.revenueAvos
```

### 🔴🔴 `dishes[]` **唔會**逐行等於 `dishesByChannel[]` 嘅 `offline*`（常見誤解）

⚠️ **唔好寫呢條對數**（本契約早期版本寫錯咗，會令正確結果被誤判為 bug）：

```text
❌ { offlineQty, offlineRevenueAvos } of dishesByChannel === dishes[] 每行
```

**原因：兩者 base 唔同。**

| | base 條件 | 涵蓋渠道 |
|---|---|---|
| 舊 `dishes[]` | `online_order_id is null` | `offline` **＋ `online_platform`** |
| `dishesByChannel[].offline*` | `channel = 'offline'` | 只有 `offline` |

平台單（`source IN ('aomi','mfood')`，例如澳覓／mfood）**冇 `online_order_id`**
⇒ 佢哋一直喺舊 `dishes[]` 入面，但**唔會**被計入 `dishesByChannel[].offline*`。

**生產實測（2026-10-07，94 張單）**：

```text
Σ dishes[].qty                     =  198
Σ dishesByChannel[].offlineQty     =  184     （198 − 184 = 14     ＝ 平台單菜品 qty）
Σ dishes[].revenueAvos             =  549,900
Σ dishesByChannel[].offlineRevenue =  477,200 （差 72,700           ＝ 平台單菜品 rev）

實例：{ "name": "表嫂手打肉餅", "qty": 3, "revenueAvos": 19200 }  ← 舊 dishes[]
      同一道菜喺 dishesByChannel 係 offlineQty = 0 / onlineQty = 3（全部 online_platform）
```

**✅ 正確對數（單向包含）：**

```text
舊 dishes[] 每個 name 都喺 dishesByChannel[] 出現                    （舊 ⊂ 新）
dishesByChannel[] 多出嘅名（舊冇）嘅 offlineQty / offlineRevenueAvos === 0
同名行：dishes[].qty         >= dishesByChannel[].offlineQty
同名行：dishes[].revenueAvos >= dishesByChannel[].offlineRevenueAvos
Σ dishes[].qty         − Σ dishesByChannel[].offlineQty === 平台單菜品 qty
Σ dishes[].revenueAvos − Σ dishesByChannel[].offlineRevenueAvos === 平台單菜品 rev
```

ℹ️ `dishesByChannel[]` 會**多出**純線上菜品 —— 2026-10-07 實測 5 款，
全部 `offlineQty = 0`：`Y14 表嫂肉碎生菜包`、`M5 椒鹽豆腐`、`冬菇紅棗蒸滑雞飯`、
`B3 香腸雞蛋炒飯`、`鱼皮`。呢個係設計意圖（線上菜第一次出現喺呢個 key），**唔係 bug**。

---

## `channel` 三值（封閉值域，唔會再加第四個）

| 值 | 判定條件 | 意思 | 錢喺邊度收 |
|---|---|---|---|
| `offline` | `source ∉ ('aomi','mfood')` **且** `online_order_id IS NULL` | 純店內 POS 單 | 店內 |
| `online_projection` | `online_order_id IS NOT NULL` | 掃碼／排位／快餐**採納**入店 | **店內**（同一張枱） |
| `online_platform` | `source IN ('aomi','mfood')` | Grabber 推入嘅外賣平台單 | 平台／上門 |

⚠️ **收唔到第四個值。** 唔好寫 `else → 線下` 咁嘅假設去處理未知值 —— 遇到未知值請當作資料錯誤。
（我哋 server 側亦都會先把唔合法值擋走，寧願 503 都唔會送錯值俾你哋。）

⚠️ `online_projection` 嘅錢**係喺店內收嘅**，只係「來源係線上菜單」。
如果按 `channel !== 'offline'` 去判斷「錢有冇入店」會判錯 —— 要按 `channel === 'online_platform'`。

---

## ① 舊 `dishes[]`：🔴 **三欄，一個都冇加**（還原 0060）

```json
{ "name": "表嫂肉餅飯", "qty": 11, "revenueAvos": 55600 }
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | string | 菜品名（`menuItemId\|名稱` 快照聚合，同 09-26 增補一致） |
| `qty` | number | **淨線下**數量（同 09-26 一致） |
| `revenueAvos` | number | **淨線下**金額，**金額倒序**（0060 定案） |

⚠️ **唔好再喺呢個 array 搵 `offlineQty` 呢類欄位** —— v1 稿咁做過，會令 `qty` 由「淨線下」吸水變成全渠道。
我哋 server 側而家**見到拆欄就 503**（唔會靜靜送錯數俾你哋）。

⚠️ `revenueAvos`（Σ(price×qty)）**唔會**等於 `kpi.revenueAvos`（Σ(total)）——
後者含服務費／稅，前者只係菜品錢。主店 90 日實測 549,900 vs 547,100（比值 1.005）。

## ① 替代：`dishesByChannel[]`：全渠道 ＋ 四個拆欄

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | string | 菜品名（同上） |
| `qty` | number | **總數**（線下 + 線上） |
| `revenueAvos` | number | **總金額**（線下 + 線上），**金額倒序** |
| `offlineQty` | number | 線下數量 |
| `offlineRevenueAvos` | number | 線下金額 |
| `onlineQty` | number | 線上數量（`online_projection` + `online_platform` 合計） |
| `onlineRevenueAvos` | number | 線上金額 |

🔴 **不變量（我哋 server 側會驗，唔符就 503）**：

```text
offlineQty + onlineQty               === qty
offlineRevenueAvos + onlineRevenueAvos === revenueAvos
```

🔴 **兩條都係對同一行嘅自己總數**（2026-10-07 補上金額條，之前淨守數量）。
⚠️ **唔好**誤寫成「`offline*` 要同舊 `dishes[]` 同名行相等」—— 舊 `dishes[]` 包埋
`online_platform`，咁守會喺正常生產資料上誤報 503。正確關係見上面「舊 `dishes[]` vs
新 `offline*`」嘅單向包含段落（主店實測：舊 58 行 ⊂ 新 63 行，多出 5 款純線上菜）。

**七個欄位全部必填** —— 收唔到就當資料錯誤（我哋唔會送半套欄位出嚟）。
主店 90 日實測（2026-10-07）：`dishesByChannelTotal` = 63 行，Σqty = 225、Σrev = 667,600；
其中 58 行有線下部分，5 行係純線上（`offlineQty = 0`）。

🔴 `dishesByChannel[]` 依然**只計 `settled` / `paid`**，已退菜（`voided`）唔計。
🔴 依然上限 **300 款**，用 `flags.dishesByChannelTruncated` 判斷截斷。

---

## ② 舊 `orders[]`：🔴 **還原 09-26 口徑，但每列多一個 `channel`**

| 欄位 | 型別 | 說明 |
|---|---|---|
| `orderNo` | string \| null | 本地單號，**可以係 `null`**（平台推入嘅單冇本地單號） |
| `totalAvos` | number | 該單金額（avos 整數、非負）。未結帳單 ＝ 當前應收 |
| `status` | string | 原始 POS 狀態（封閉值域，**同 09-26 增補一致**） |
| `channel` | string | 🆕 渠道三值（**純新增欄位，舊數字一個都冇改**） |

🔴 **`orders[]` 範圍同 09-26 一致：排除 `online_order_id`（即唔含線上投影單）。**
主店 90 日 = **74 張**（線下 66 ＋ 平台 8），同 09-26 嗰版一模一樣。

⚠️ 但佢**包埋平台單**（平台單冇 `online_order_id`）—— 呢個一直係咁，唔係今次改嘅。
所以 `channel` 會出現 `offline` 同 `online_platform` 兩個值，**唔會**出現 `online_projection`。

⚠️ 喺 0066 部署**之前**，舊版 `orders[]` **冇 `channel` 欄**。
我哋**唔會**回填 `"offline"` ⇒ 收到冇 `channel` 就當「未知」處理，**唔好**當成「全部線下」。

## ② 替代：`ordersByChannel[]`：全渠道訂單

欄位同 `orders[]` **完全一樣**（你可以用同一個 renderer 讀兩個 key），
但**範圍係全渠道** —— **線上投影單淨係喺呢度出現**。

主店 90 日 = **93 張**（`ordersTotal` 74 ＋ 19 張線上投影）。
⚠️ 呢個 key 嘅每列**必定**有 `channel`（冇 = 資料錯誤，我哋會 503）。
其餘語意同 `orders[]` 一致：事件時間倒序、只剔除 `cancelled`、上限 3000 筆。

🔴 **`ordersByChannelTotal − ordersTotal` ＝ 線上投影單張數，恆等式，任何日子都成立。**
（實測 93 − 74 = 19，而 `ordersByChannel` 入面 `online_projection` 亦係 19 張。）

---

## ③ `breakdown.paymentBreakdown`：支付方式分項

同 POS 報表頁「支付方式分項（店內收款）」嗰張卡**同款欄位**，但**係全渠道**。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `method` | string | `pos_orders.payment_method` **原值**（截 32 字）。查唔到原樣返回 |
| `label` | string | 翻譯後標籤（截 32 字）。查唔到映射就**原樣返回 `method`** |
| `channel` | string | 渠道三值 |
| `orderCount` | number | 該 (支付方式 × 渠道) 組合嘅單數 |
| `receivableAvos` | number | **應收** ＝ Σ(單品 `price` × `qty`) + 服務費 + 稅 |
| `paidAvos` | number | **實收** ＝ Σ(`pos_orders.total`) |
| `diffAvos` | number | `receivableAvos − paidAvos`，🔴 **可以為負** |

### `label` 翻譯表（只有呢幾個 key）

| `method` 原值 | `label` |
|---|---|
| `in_store` / `online_in_store` | 到店付款 |
| `balance` / `online_balance` | 餘額扣點 |
| `member_balance` | 會員餘額 |
| `online_paid` / `prepaid` | 線上已支付 |
| （其他） | **原樣返回 `method`** |

⚠️ 我哋**刻意唔會**加 `cash → 現金` 呢類映射：好多店自己嘅支付方式就叫「現金」，
硬映射會令佢哋見到自己改名後嘅嘢。`method` 欄永遠保留原值，所以你自己 map 都得。

### 🔴🔴 `diffAvos` 可以為負 —— 唔可以夾非負

| `channel` | `diffAvos` 嘅語意 |
|---|---|
| `offline` | 折扣／抹零（實收 **≤** 應收） |
| `online_platform` | **平台抽成** + 餐盒費（實收可能 **>** 應收 ⇒ **負數**） |
| `online_projection` | 通常 0；但**都可以為負**（同一張枱，錢喺店內收，實收可以高過菜品錢） |

主店 90 日實測**三行 `diffAvos < 0`**：

| `method` | `channel` | 應收 | 實收 | `diffAvos` |
|---|---|---|---|---|
| `外賣平台` | `online_platform` | 72,700 | 69,900 | **+2,800**（平台抽成） |
| `in_store` | `online_projection` | 50,800 | 52,600 | **−1,800** |
| `balance` | `online_projection` | 4,400 | 4,600 | **−200** |

⇒ 如果你哋喺顯示層夾非負，會見到一堆「差額 0」，以為對數啱咗 —— 其實係假零。
**請原樣顯示負數。**

⚠️ 另外兩個 `*Avos` 欄（`receivableAvos` / `paidAvos`）**唔會**為負；`orderCount` 唔會為負。
只有 `diffAvos` 會。

### 🔴🔴 `paymentBreakdown` 嘅 Σ **唔等於** `kpi.revenueAvos` —— 呢個係設計，唔係 bug

| | 範圍 | Σ（主店 90 日實測） |
|---|---|---|
| `kpi.revenueAvos` | **v1 口徑**（`online_order_id is null`，含平台、排除線上投影） | **547,100** |
| Σ `paymentBreakdown[].paidAvos` | **全渠道**（93 張，含線上投影） | **666,800** |

差額 119,700 = 19 張線上投影單 ⇔ `kpi.online`。
🔴 **如果你哋要對數，請用呢個式（唔好用 ΣpaymentBreakdown = kpi.revenueAvos）：**

```text
Σ paymentBreakdown[].paidAvos where channel != 'online_projection'  ===  kpi.revenueAvos
```

實測：666,800 − 119,700 = 547,100 ✅

### 🔴 `byPayment` 照舊 —— 唔會被 `paymentBreakdown` 取代

`breakdown.byPayment`（v1 口徑）**完全保留**。你哋嗰條 bar 上嘅「外賣平台」條
唔會因為加咗新資料而消失。

兩個嘅分別：

| | `byPayment` | `paymentBreakdown` |
|---|---|---|
| 範圍 | v1 口徑（含平台、排除線上投影） | **全渠道** |
| 粒度 | 淨係 `method` | `method` × `channel` |
| 欄位 | `method` + `amountAvos` | 七個欄（見上） |
| 用途 | 現有 bar（唔好郁） | 新卡：分渠道睇支付 |

---

## `kpi.offline` / `kpi.online` / `kpi.onlinePlatform`（精確拆分，掛喺 `kpi` 入面）

**唔係新嘅頂層 key** —— 係 `kpi` object 入面多三個 key，咁樣舊 parser 唔識就自然忽略。

| key | 內容 | 實測 90 日（2026-10-07） |
|---|---|---|
| `kpi.offline` | 純店內單 | 66 張 / 477,200 avos |
| `kpi.online` | 線上投影（掃碼／排位／快餐採納） | 19 張 / 119,700 avos |
| `kpi.onlinePlatform` | Grabber 外賣平台 | 8 張 / 69,900 avos |

每組都係同樣五欄：`orderCount` / `revenueAvos` / `refundedAvos` / `discountAvos` / `covers`。

**對數關係**（我哋 server 側會守，任何日子都成立）：

```text
kpi.offline + kpi.onlinePlatform                            ===  kpi（v1 口徑）
kpi.offline + kpi.online + kpi.onlinePlatform               ===  全渠道總數
Σ paymentBreakdown[].paidAvos where channel != 'online_projection'  ===  kpi.revenueAvos
```

⚠️ 上表嘅**絕對值會隨日期滾動**（每日新單入窗就變）⇒ 請只用恆等式做回歸斷言。

第一條成立係因為 v1 口徑包埋平台、排除線上投影。
⚠️ 三組嘅 `refundedAvos` 係**各自渠道自己嘅退款單**，所以第一條只喺 `orderCount` /
`revenueAvos` / `discountAvos` / `covers` 成立（退款單唔喺 `settled`/`paid` 批內）。

**用途建議**：`kpi` 繼續做「店內總覽」（含平台，維持現時對數），
三個新 key 用嚟畫渠道分佈餅圖。

---

## 能力探測：請讀 `x-pos-offline-report-caps`

`v` 唔會升，所以**必須**靠呢個標頭。

```text
# 0058（最舊）
x-pos-offline-report-caps: kpi,byPayment

# 0059/0060 已跑、0066 未跑
x-pos-offline-report-caps: kpi,byPayment,orders,dishes

# 0066 已跑（最新）
x-pos-offline-report-caps: kpi,byPayment,orders,dishes,kpiByChannel,paymentBreakdown,ordersByChannel,dishesByChannel
```

| 標頭內容 | 你哋應該點做 |
|---|---|
| 冇 `orders` / `dishes` | 當「暫時未能提供」—— 回應**連 `orders` 呢個 key 都冇**。❌ 唔好當「今日冇單」 |
| 有 `orders` / `dishes`、冇 `kpiByChannel` | 明細啱睇，但 `orders[].channel` / 全部新 key **會缺席** ⇒ 用 `in` / `hasOwnProperty` 判斷 |
| 有 `kpiByChannel` | 全部齊備（六個渠道 key 一齊出現），可以照 render |

🔴 **渠道能力係「六個 key 要麼全有、要麼全無」** ——
`kpiByChannel` / `paymentBreakdown` / `ordersByChannel` / `ordersByChannelTotal` /
`dishesByChannel` / `dishesByChannelTotal`。
如果我哋只俾你哋一部分，你哋就會畫到有洞但唔會報錯 ⇒ 我哋會直接 503，唔會咁做。

🔴 **缺席 ≠ 空陣列。** 收到冇 `paymentBreakdown` 係「未提供」，唔係「該區間零筆交易」。
顯示成「0 筆」就係渲染假零。

---

## 截斷（上限）

| 節 | 上限 | 保留策略 | 對應 flag |
|---|---|---|---|
| `orders[]` | **3 000 筆** | 最新優先（事件時間倒序） | `flags.ordersTruncated` |
| `dishes[]` | **300 款** | **金額最高優先**（0060 定案） | `flags.dishesTruncated` |
| `ordersByChannel[]` | **3 000 筆** | 最新優先 | `flags.ordersByChannelTruncated` |
| `dishesByChannel[]` | **300 款** | 金額最高優先 | `flags.dishesByChannelTruncated` |

主店 90 日實測（2026-10-07）：`orders` 74 張、`ordersByChannel` 93 張 —— 離 3000 仲好遠，正常唔會觸及上限。

---

## 🔴 我方**唔會**回嘅嘢（紅線不變，唔會因需求而改）

* ❌ **任何自由文字**：訂單備註、單品備註、折扣原因、免單原因。
* ❌ 顧客姓名、電話、會員 id、地址。
* ❌ 收銀員／員工姓名。
* ❌ 逐張單嘅 item 清單（每張單逐項）。
* ❌ 逐張單嘅日期／時間（09-27 拍板；想分日要逐日各叫一次）。
* ❌ 平台訂單原文／收件人／地址（`raw_json` / `external_order_id` 一律唔出）。
* ❌ 平台抽成明細（`platform_fees`）—— `diffAvos` 已經反映咗淨效果。

---

## 部署次序（重要）

1. POS 側**重跑** migration **`0066_pos_offline_report_channel.sql`**
   （商家喺 Supabase SQL Editor 貼，無 transaction、可重跑、`create or replace` 同一簽名）。
2. POS 側部署新 code（**任一先後都安全**）。

🔴🔴 **如果之前已經跑過 0066（任何版本）**：**必須重跑**（步驟 1）。

原因有兩個，一個比一個陰：
1. v1 稿會令舊 `orders[]` / `dishes[]` 嘅數值跳數。
2. 🔴🔴 **2026-10-08：方案 A 版曾經「跑成功但實際係壞嘅」** —— Postgres 嘅
   `create or replace function` **只驗語法、唔驗欄位**，所以 SQL Editor 會回
   `Success. No rows returned`，但函數一到執行就爆
   `42703: column "status" does not exist`。今次有**兩條 CTE 漏欄**（已修好）。
   ⇒ **見到 `Success` 唔等於函數可以跑。** 我哋而家落咗本地真跑驗證
   （`tools/verify-offline-report-rpc.cjs`，PGlite 實際執行 + 30 條恆等式）。

**五道安全閥**（我哋寫咗守衛測試逐條驗）：

| 情況 | 我哋嘅行為 |
|---|---|
| code 比 0066 先上線 | 舊 SQL 回嘅 payload 冇新 key ⇒ 優雅降級，**唔 503** |
| 0066 跑咗但 0059 未跑（中間狀態） | 冇明細就唔宣告渠道能力，**唔 503** |
| 舊 `dishes[]` 出現拆欄（v1 稿殘留） | **503** —— 寧願你哋見到錯，唔好見到假零 |
| 0066 只回一部分新 key（SQL 有 bug） | **503 失敗得響** |
| `dishesByChannel[]` 拆欄數量／金額唔守恆 | **503** —— 防止只錯一個渠道分支而靜靜送出加埋埋總數 |

⇒ 你哋**現有嗰張已對數嘅卡零影響**，可以放心先做好解析度再等新欄位出現。

---

## 驗收（POS 側貼完 migration 之後逐條跑，全部唯讀）

> 📄 **權威版本**：`supabase/verify/0066_verify_production_20261007.sql`（14 條，已用 pglast 驗過語法）。
> 下面呢份係**濃縮版**，覆蓋最易錯嗰幾條。
>
> ⚠️ 權威檔**唔喺** `supabase/migrations/` —— 佢係唯讀 SELECT、要 service role 先跑到；
> 留喺 `migrations/` 會被 `db push` 用 postgres role 執行而失敗。
>
> 🔴🔴 **驗收一律用「恆等式」判定，唔好用絕對值。**
> 舊版呢份曾寫死「74 / 547100 / 75 / 42 / 42 / 84000」，其中 **`75 / 42 / 42 / 84000`
> 係文檔虛構值**（生產重算證實：`dishes[]` 實為 **74 / 58 / Σqty 198 / Σrev 549,900**，
> 且全店冇任何一行 `qty === 42` 或 `revenueAvos === 84,000`）⇒ 照住對死數會得出正確值
> 卻以為仲未修好。而 `dishesTotal`／`Σqty`／`Σrev` **本身就會隨日期滾動**，
> 寫死基數等於寫一個必然過期嘅鬧鐘。
>
> 🔴🔴🔴 **連「實測基線」都唔可以信 —— 要信工具嘅穩定性。**
> 2026-10-07 同一份 production 數據，取證腳本報過 `dishesTotal` **58 同 59**、
> `dishesByChannelTotal` **63 同 64**（但 Σqty／Σrev 每次一樣）。
> 根因**唔係**數據變、**唔係**日期窗口、**唔係**聚合 key、**唔係**分頁漏行，
> 而係工具用 `d += chunk` 逐 chunk 拼字串 ⇒ 跨 chunk 嘅中文（3 bytes UTF-8）
> 被切爛成 `�` ⇒ 菜名變另一個字串 ⇒ 聚合多一行。
> ✅ 正解 `Buffer.concat(chunks)` 後先 `toString("utf8")`；修正後 15 輪連跑全部穩定 58 / 63。
> ⇒ **任何取證工具嘅絕對值都要連跑數輪確認穩定之後先可以寫入契約。**

```sql
-- ① 🔴 舊欄 14 個 key 必須齊全（0060 逐字）
select (r ? 'orderCount') as a, (r ? 'revenueAvos') as b, (r ? 'byPayment') as c,
       (r ? 'ordersTotal') as d, (r ? 'orders') as e,
       (r ? 'dishesTotal') as f, (r ? 'dishes') as g
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- 七個全部 true

-- ② 🔴🔴 舊欄「對數」＝唯一可靠判據（任何日子都成立）
select (r ->> 'revenueAvos')::bigint as kpi_rev,
       (select coalesce(sum((b ->> 'amountAvos')::bigint), 0)
          from jsonb_array_elements(r -> 'byPayment') b)                as byPayment_sum,
       (r ->> 'ordersTotal')::bigint - jsonb_array_length(r -> 'orders')  as orders_gap,
       (r ->> 'dishesTotal')::bigint - jsonb_array_length(r -> 'dishes')  as dishes_gap
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- ✅ byPayment_sum = kpi_rev、orders_gap = 0、dishes_gap = 0
-- ⚠️ 唔好對 kpi_rev 嘅絕對值（滾動窗口）；唔好假設 kpi_n = orders_total
--    （orders[] 連未結帳／reopened 都包）；唔好假設 Σdishes.revenueAvos = kpi_rev
--    （實測比值 1.005，差額 = 服務費／抹零）

-- ③ 🔴🔴🔴 舊 dishes[] 絕對唔可以有拆欄（v1 稿殘留嘅捉狗點）
select count(*) as rows_with_split
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
    cross join lateral jsonb_array_elements(r -> 'dishes') d
 where d ?| array['offlineQty','offlineRevenueAvos','onlineQty','onlineRevenueAvos'];
-- 必須係 0

-- ④ 🔴🔴 舊 dishes[] vs 新 dishesByChannel[].offline*：**單向包含**（唔係逐行相等！）
--    🔴 呢條嘢早期版本寫成 `except` 雙向 0，係**錯嘅**、永遠唔會成立：
--       舊 dishes[] base = `online_order_id is null` = offline **＋ online_platform**
--       新 offline*  base = `channel = 'offline'`     = 只有 offline
--       平台單冇 online_order_id ⇒ 喺舊 dishes[] 但唔喺新 offline*。
--       實測：Σqty 198 vs 184（差 14）、Σrev 549,900 vs 477,200（差 72,700）。
with r as (select public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') j),
legacy as (
  select (d ->> 'name') as n, (d ->> 'qty')::bigint as q, (d ->> 'revenueAvos')::bigint as v
    from r, jsonb_array_elements(j -> 'dishes') d),
ch as (
  select (d ->> 'name') as n, (d ->> 'offlineQty')::bigint as q,
         (d ->> 'offlineRevenueAvos')::bigint as v
    from r, jsonb_array_elements(j -> 'dishesByChannel') d)
select
  -- 🔴 必須 0：舊每個名都喺新 key 出現
  (select count(*) from legacy l where not exists (select 1 from ch c where c.n = l.n))
      as legacy_missing_in_new,
  -- 🔴 必須 0：新 key 多出嘅名（純線上菜）唔可以帶到 offline 數量
  (select count(*) from ch c
     where not exists (select 1 from legacy l where l.n = c.n) and (c.q <> 0 or c.v <> 0))
      as new_only_with_offline_amount,
  -- 🔴 必須 0：冇一行「舊 < 純 offline」（方向反咗 = 舊欄被改窄咗）
  (select count(*) from legacy l join ch c on c.n = l.n where l.q < c.q or l.v < c.v)
      as legacy_smaller_than_offline,
  -- ℹ️ 平台單獨有嘅菜品數（>= 0，唔好斷言 0）
  (select count(*) from legacy) - (select count(*) from ch) as platform_only_dishes;
-- ✅ legacy_missing_in_new = 0、new_only_with_offline_amount = 0、legacy_smaller_than_offline = 0

-- ⑤ 舊 orders[] 唔會有 online_projection（還原咗 online_order_id is null）
select p ->> 'channel' as channel, count(*) as n
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
    cross join lateral jsonb_array_elements(r -> 'orders') p
  group by 1 order by 1;
-- 只會出現 offline / online_platform，冇 online_projection

-- ⑥ 🔴 kpiByChannel 拆分 ＋ 對數
select (r -> 'kpiByChannel' -> 'offline'        ->> 'orderCount')::bigint as off_n,
       (r -> 'kpiByChannel' -> 'online'         ->> 'orderCount')::bigint as on_n,
       (r -> 'kpiByChannel' -> 'onlinePlatform' ->> 'orderCount')::bigint as pf_n,
       (r ->> 'orderCount')::bigint as legacy_kpi_n
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- ✅ off_n + pf_n = legacy_kpi_n

-- ⑦ 🔴 新 ordersByChannel 三個渠道都有，而且差額完全由線上投影單構成
select (r ->> 'ordersTotal')::bigint as legacy_total,
       (r ->> 'ordersByChannelTotal')::bigint as all_total,
       (r ->> 'ordersByChannelTotal')::bigint - (r ->> 'ordersTotal')::bigint as online_only,
       -- 🔴 `as p` 唔可以漏（2026-10-08 實案：漏咗報 42703 column "p" does not exist）
       (select count(*) from jsonb_array_elements(r -> 'ordersByChannel') p
         where p ->> 'channel' = 'online_projection') as n_projection
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- ✅ online_only = n_projection

-- ⑧ dishesByChannel[] 拆欄加埋等於總數（兩欄相等）
select sum((d ->> 'offlineQty')::bigint + (d ->> 'onlineQty')::bigint) as qty_sum,
       sum((d ->> 'qty')::bigint) as qty_total
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
    cross join lateral jsonb_array_elements(r -> 'dishesByChannel') d;

-- ⑨ 🔴🔴 paymentBreakdown 對數：排除線上投影之後 == kpi.revenueAvos
--    （Σ 全體 = 666,800 ≠ kpi.revenueAvos = 547,100，**唔係** bug，係範圍唔同）
select (select coalesce(sum((b ->> 'paidAvos')::bigint), 0)
          from jsonb_array_elements(r -> 'paymentBreakdown') b) as pb_all,
       (select coalesce(sum((b ->> 'paidAvos')::bigint), 0)
          from jsonb_array_elements(r -> 'paymentBreakdown') b
         where b ->> 'channel' <> 'online_projection')            as pb_no_projection,
       (r ->> 'revenueAvos')::bigint as kpi_rev
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- ✅ pb_no_projection = kpi_rev

-- ⑩ 🔴 六個渠道 key 一齊出現（唔會半套）
select r ? 'kpiByChannel'         as a,
       r ? 'paymentBreakdown'     as b,
       r ? 'ordersByChannel'      as c,
       r ? 'ordersByChannelTotal' as d,
       r ? 'dishesByChannel'      as e,
       r ? 'dishesByChannelTotal' as f
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r;
-- 六個全部 true

-- ⑪ 🔴 diffAvos 真的可以為負（零行 = 你啱啱夾咗非負，唔啱）
select b ->> 'method' as method, b ->> 'channel' as channel,
       (b ->> 'receivableAvos')::bigint - (b ->> 'paidAvos')::bigint as diff
  from public.pos_offline_report('<STORE>', '2026-07-10', '2026-10-07') r
    cross join lateral jsonb_array_elements(r -> 'paymentBreakdown') b
 where (b ->> 'paidAvos')::bigint > (b ->> 'receivableAvos')::bigint;
```

---

## 要你哋確認

1. **`ledgerOwnsOnlineRevenue`**：確認你哋會照佋行（線上營業額以你哋自己嘅數據源為準，
   **唔好**再同 `kpi` 相加）。呢個係防止平台單重複計算嘅唯一保護。
2. **`diffAvos` 負數顯示**：建議喺 `online_platform` 嗰行改名做「平台抽成」，
   而唔係「折扣」—— 兩者方向相反。
3. **`channel` 未知值**：如果收到第四個值，請當資料錯誤並通知我哋（唔好默默當線下）。
4. **`online_projection` 嘅歸屬**：錢喺店內收，會唔會應該計入「店內收款」卡？
   我哋而家照實標示，唔自己判斷。
5. **逐日趨勢**：`orders[]`／`dishes[]` 依然冇日期欄位（同 09-27 拍板），
   分日要逐日各叫一次。如果呢點做唔到，請提出。
6. **v1 稿嘅舊渲染**：如果你哋已經照 v1 稿接咗 `orders[]`／`dishes[]` 嘅新欄位，
   請確認已停用（改讀 `ordersByChannel[]`／`dishesByChannel[]`）。舊卡唔使 rollback。
