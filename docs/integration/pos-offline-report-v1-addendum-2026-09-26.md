# 線下營業摘要 API —— 契約 v1 增補（訂單明細 + 菜品排名）

> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem) ⇄ Ledger
> **日期**：2026-09-26
> **方向**：不變（**Ledger 伺服器 → POS**，POS 仍然係被呼叫方；同一支 route、同一把 secret）
> **關係**：**additive 增補** —— [v1 原件](./pos-offline-report-api.md) 全部條款**繼續有效**，
> 本檔只係新增兩節資料。`v` **仍然係 `1`**。
> **本檔可以直接轉貼畀 Ledger。**

---

## 一句話

同一支 `GET /api/integration/ledger/offline-report`（**一次呼叫、唔加參數**）而家會多回兩節：

* `orders[]` —— 該區間嘅**線下訂單明細**（訂單號、金額、狀態）
* `dishes[]` —— 該區間嘅**線下菜品排名**（名稱、銷量、金額）

---

## 回應 200（新增部分）

原有欄位（`v` / `storeId` / `from` / `to` / `generatedAt` / `kpi` / `breakdown` / `flags.refundsNetted` / `flags.clamped`）**完全冇改**。
新增：

```json
{
  "v": 1,
  "storeId": "8291f843-9def-4956-9d0b-1cfef2598306",
  "from": "2026-09-01",
  "to": "2026-09-24",
  "generatedAt": "2026-09-26T02:10:00.000Z",

  "ordersTotal": 27,
  "orders": [
    { "orderNo": "訂單27", "totalAvos": 3800, "status": "draft" },
    { "orderNo": "訂單26", "totalAvos": 184700, "status": "settled" },
    { "orderNo": null,     "totalAvos": 6200,   "status": "paid" }
  ],

  "dishesTotal": 12,
  "dishes": [
    { "name": "凍檸茶", "qty": 42, "revenueAvos": 84000 },
    { "name": "豬扒飯", "qty": 7,  "revenueAvos": 49000 }
  ],

  "flags": {
    "refundsNetted": false,
    "clamped": false,
    "ordersTruncated": false,
    "dishesTruncated": false
  }
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `ordersTotal` | ✅ | 符合條件嘅線下單**總數**（未截斷前）。`ordersTotal > orders.length` ⇒ 有截斷 |
| `orders[]` | ✅ | `{orderNo, totalAvos, status}`。**事件時間倒序**（最新喺最前） |
| `orders[].orderNo` | ⚠️ | 本地單號，**可以係 `null`**（部分由外賣平台推入嘅單冇本地單號）—— 請用 `null`-safe 顯示 |
| `orders[].totalAvos` | ✅ | 該單金額（avos 整數、非負）。未結帳單 ＝ 當前應收 |
| `orders[].status` | ✅ | 原始 POS 狀態（**封閉值域**，見下表） |
| `dishesTotal` | ✅ | 不同菜品款數（未截斷前） |
| `dishes[]` | ✅ | `{name, qty, revenueAvos}`。**銷量倒序**（並列時按名稱） |
| `flags.ordersTruncated` | ✅ | `orders[]` 是否被 3000 筆上限截斷 |
| `flags.dishesTruncated` | ✅ | `dishes[]` 是否被 300 款上限截斷 |

金額一律 avos 整數（`Number.isSafeInteger`）、非負。型別不符一樣係整包丟棄，**唔會**渲染假零。

---

## 🔴 兩節係**唔同批次**（最容易搞錯嘅一點）

| | `orders[]` | `dishes[]` |
|---|---|---|
| 包含狀態 | **全部**線下單：`draft` / `sent_to_kitchen` / `reopened` / `paid` / `settled` / `partially_refunded` / `refunded` | **只** `settled` / `paid` |
| 唯一剔除 | `cancelled`（作廢單） | 已退菜（`voided`） |
| 同 `kpi` 關係 | `ordersTotal` **≥** `kpi.orderCount` | 金額加總 ≈ `kpi.revenueAvos`（差額 = 服務費／稅／全單折扣／抹零） |
| 點解 | 商家要睇「邊張未埋單」 | 同 POS `/reports` 菜品排行口徑一致 |

⇒ **`orders.length` 唔等於 `kpi.orderCount`，請分開顯示**，唔好互相驗證。
兩節都排除 `online_order_id IS NOT NULL`（線上投影單）—— 同 KPI 一致。

### `status` 封閉值域

| 值 | 中文 | 已結帳？ | 計入 `kpi`？ |
|---|---|---|---|
| `draft` | 未送單 | ✗ | ✗ |
| `sent_to_kitchen` | 已送廚房（未結帳） | ✗ | ✗ |
| `reopened` | 已重開（返結後未再結） | ✗ | ✗ |
| `paid` | 已付款 | ✗ | ✅ |
| `settled` | 已結帳 | ✅ | ✅ |
| `partially_refunded` | 部分退款 | ✅ | ✗ |
| `refunded` | 已退款 | ✅ | ✗ |
| `unknown` | 狀態缺失（POS 舊資料） | — | ✗ |

⚠️ 我哋**刻意冇**回一個 `settled: boolean` —— 任何單一 boolean 對 `refunded`（曾結帳、已退）
同 `paid`（未結帳但已收錢）都會講錯嘢。權威係原始 `status`，文案由你哋 map。

---

## 能力探測：請讀 `x-pos-offline-report-caps`

`v` 按契纈 1 寫死**唔會升**（升咗你哋既有可能 `v === 1` 嘅檢查會令整包被丟棄）。
改用回應標頭宣告能力：

```text
x-pos-offline-report-caps: kpi,byPayment,orders,dishes
```

* 有 `orders` / `dishes` ⇒ 回應一定有 `orders[]` / `dishes[]`，可以照 render。
* 只有 `kpi,byPayment` ⇒ 我哋未完成升級，回應**連 `orders` 呢個 key 都唔會有**。
  **請當「暫時未能提供」，唔好當「今日冇單」**（缺席 ≠ 空陣列）。

---

## 截斷（上限）

| 節 | 上限 | 保留策略 |
|---|---|---|
| `orders[]` | **3 000 筆** | **最新優先**（按事件時間倒序取頭 3000） |
| `dishes[]` | **300 款** | 銷量最高優先 |

超出時對應 `flags.*Truncated = true`，而 `ordersTotal` / `dishesTotal` 仍然係**真實總數**。
（實測：主店約 32 張線下單/日 ⇒ 90 日約 2 880 張，正常唔會觸及上限。）

---

## 🔴 逐張單**唔提供**日期／時間（2026-09-27 拍板，唔係漏做）

`orders[]` 一列**只有** `orderNo` / `totalAvos` / `status`。**冇** 時間戳、**冇** 日期字串。

請注意呢個係**刻意決定**，唔係未做：

| 你哋**一定知** | 你哋**一定唔知** |
|---|---|
| 每張單都落喺你哋傳入嘅 `from` ～ `to` 之間 | 逐張單係邊一日 |
| 最新嗰張排最前（**事件時間遞減序**） | 逐張單係幾點鐘 |
| 實際用嘅區間（回應 echo `from` / `to`；`clamped` 時 `from` 已推後） | 區間內再分日／分時段 |
| 有冇被截斷（`ordersTruncated`） | 逐日菜品排名 |

**所以請唔好嘗試喺本地對 `orders[]` 分日 group** —— 你做唔到，而且唔需要：

* 想要「某一日」⇒ 用 `from = to = 該日` 叫一次；
* 想要「逐日趨勢」⇒ **逐日各叫一次**（Ledger 側有 session cache，POS 側限流係每店每分鐘 30 次）。

**歸屬口徑**（我哋計嘅「日」）：`coalesce(settled_at, reopened_at, updated_at, created_at)` 轉
`Asia/Macau` 嘅日曆日 —— 同 POS `/reports`、交班頁完全同一套（＝結帳嗰刻，唔係「API 幾時叫」）。

⚠️ 一個已知邊界：未結帳單（`draft` / `sent_to_kitchen` / `reopened`）冇 `settled_at`／`reopened_at`
⇒ 日歸屬落到 `updated_at`。所以**進行中嘅枱**會一直出現喺最近嘅區間（合理），
而**久未觸碰嘅草稿**會停喺最後一次動作嗰日。

---

## 我方**唔會**回嘅嘢（紅線，唔會因需求而改）

* ❌ **任何自由文字**：訂單備註、單品備註、折扣原因、免單原因。
  （店員手打，可能寫咗顧客姓名／電話 ⇒ 屬個資，違反 v1「不是訂單明細／顧客個資」嘅原意。）
* ❌ 顧客姓名、電話、會員 id、地址。
* ❌ 收銀員／員工姓名。（順帶一提：POS 雲端 DB 本身亦冇存員工姓名。）
* ❌ 逐項菜品明細（每張單嘅 item 清單）—— 如果日後真有需要，**另議**，
  因為 90 日 × 2 880 張單會令 payload 由 ~300 KB 升到 ~1.6 MB，
  而 v1 寫明你哋嗰邊 timeout 係 3 秒。

---

## 部署次序（重要）

1. POS 側跑 migration **`0059_pos_offline_report_detail.sql`**（商家喺 Supabase SQL Editor 貼，無 transaction、可重跑）；
2. POS 側部署新 code（**任一先後都安全**，見下）。

**次序安全閥**：如果 code 比 migration 先上線，舊函數會回一份冇 `orders` / `dishes` 嘅 payload，
我哋**唔會**當錯誤，而係優雅降級（兩節整節缺席 + caps 只宣告 `kpi,byPayment`）。
⇒ 你哋現有嗰張已對數嘅卡**零影響**，可以放心先做好解析度再等新欄位出現。

---

## 要你哋確認

1. `orders[].orderNo = null` 嘅顯示方式（建議顯示「（無單號）」或改用 `status` + 金額）。
2. 未結帳單喺你哋報表頁嘅呈現方式（建議另開一區「店內未結帳」，唔好混入營業額區）。
3. 能力探測：請以 `x-pos-offline-report-caps` 為準，唔好 assert `v === 2` 或硬性要求 `orders` 一定存在。
4. 90 日以內嘅任何區間都可以照打；超過 90 日會照舊 `clamped=true`。
5. **`orders[]` 冇時間欄位**（見上一節）⇒ 分日要靠另叫，唔可以本地拆。如果呢點對你哋嘅
   報表 UI 做唔到，請提出，我哋再議（加 `at` / `day` 係 additive，唔會影響現有）。
