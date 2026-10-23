# 156 · Ledger 營業額 ＝ macau-pos 交班營業額：對齊方案（2026-10-21）

> 狀態：**待 J 拍板 §3 三個定義**，未改任何 code／migration。
> 背景：表嫂美食 2026-10-20（store `8291f843-9def-4956-9d0b-1cfef2598306`）。
> 相關：`docs/155`（渠道增補）、`docs/integration/pos-offline-report-api.md`、ADR-040。

## 0. 一句話

商家心目中嘅「營業額」＝ POS 交班「實收金額合計」＝ **店內 ＋ 平台 ＋ 線上投影**（10-20 ＝ 969＋44＋372 ＝ 1385）。
Ledger 報表**從來冇一個數等於 1385**：四格 KPI 只有 `kpi`（店內＋平台 ＝ 1013），投影單雖然已經傳過去（`kpi.online` ＝ 372），但只放喺底部分拆，冇入任何合計。
所以呢件事**唔係「兩邊計錯」，係 Ledger 缺一個「合計」概念**。

## 1. 現況：Ledger 有 2 個「線下」、3 個「線上」

| 畫面位置 | 數字（10-20） | 實際口徑 | 程式／契約 |
|---|---|---|---|
| Ledger 四格「線下營業額」 | 1013 | POS 單 `online_order_id IS NULL` 且 `status ∈ {settled, paid}` ＝ 店內 969 ＋ 平台 44 | `0066_pos_offline_report_channel.sql:174-189` |
| Ledger 底部「店內」 | 17／969 | `source ∉ (aomi,mfood)` 且無投影 | `offline-report.ts:97` |
| Ledger 底部「平台」 | 1／44 | `source ∈ (aomi,mfood)` | 同上 |
| Ledger 底部「線上」 | 4／372 | `online_order_id IS NOT NULL`（投影單） | 同上 |
| Ledger 標題「會員通（線上）」 | 充值 1330／扣點 709／訂單 106 | **錢包記帳 ＋ Ledger `orders`**，唔係營業額 | Ledger `get_merchant_report_summary` |
| POS 交班「線下」 | 1013 | 本機 `loadOrders()`，`!onlineOrderId`（**包埋平台**） | `shift-page.tsx:590-603`；`pos-order-filters.ts:6` |
| POS 交班「線上」 | 372 | 本地投影 ∪ Ledger 純線上（按 id 去重） | `shift-page.tsx:686` |
| **POS 交班「實收合計」** | **1385** | **線下 ＋ 線上（毛）** | `shift-page.tsx:1979` |

⇒ Ledger 差嘅就係最後一行。**POS 側數據已經齊，唔需要新增統計**（`kpi.online` 2026-10-07 已上線）。

## 2. 根因（三條，唔止一個）

**R1｜Ledger 冇「POS 合計」呢個概念。** 四格 KPI 沿用 v1 `kpi`（歷史原因：改咗 Ledger 已對數嘅卡會跳數）。渠道增補只係「加拆欄」，冇加合計，於是商家見到 1013 但 POS 見到 1385。

**R2｜兩邊都叫「線上」，指三件唔同嘅事。**
① 錢包流水（1330／709）；② Ledger `orders` 已付款（106）；③ POS 投影單實收（372）。
106 vs 372 係同一批 4 張單嘅**兩個口徑**（Ledger `total_avos` vs POS `order.total`，投影單加菜／改價只反映喺 POS）。

**R3｜POS 自己內部先唔一致（今日未爆，遲早爆）。**
- 交班：`settled | partially_refunded | refunded`（**唔含 `paid`**）→ `shift-page.tsx:596-598`
- 報表頁：`settled | paid` → `restaurant-daily-report.tsx:616`
- offline-report RPC：`status in ('settled','paid')` → `0066:179`

平台單建立時 status 就係 `paid`（`grabber-order.ts:580`）。**只要有一張平台單／預付快餐單停留喺 `paid` 未轉 `settled`，Ledger 會計、POS 交班唔會計。** 呢個係「Ledger 大過 POS」嘅潛在來源，同 Ledger 無關。

## 3. 要 J 拍板嘅三個定義

| # | 問題 | 選項 | 我建議 |
|---|---|---|---|
| D1 | 「營業額」真源 | (a) POS（店內收款事實）(b) Ledger 自己加總 | **(a)**。106 vs 372 已證明 Ledger `orders` 金額滯後；錢喺店內收，投影單改價只有 POS 知 |
| D2 | 主數字用毛定淨 | (a) 毛（＝交班大字）＋下面一行淨 (b) 直接顯示淨 | **(a)**。同交班逐分對得上，先解決「對唔上」；退款缺口（Ledger 純線上退款無源）繼續用黃字 |
| D3 | Ledger「會員通（線上）」嗰塊點處理 | (a) 改名「會員錢包流水（不計入營業額）」 (b) 搬去另一個 tab (c) 照舊 | **(a) 先做**，(b) 之後再考慮。唔改名的話，永遠有人攞 1330 對 1385 |

## 4. 方案比較

| | A｜Ledger 自己加 | B｜POS 出 `posTotals`（推薦） | C｜重構 Ledger 報表頁 |
|---|---|---|---|
| POS 改動 | 零 | 一個 additive key ＋ migration 0068 ＋ test | 同 B |
| Ledger 改動 | 一行 `kpi.revenue + kpi.online.revenue` | 讀新 key，唔自己計 | 整個報表頁重排（營業額／錢包分家） |
| 幾時對得上 | 即刻 | 0068 上線後 | B 之後 1–2 日 |
| 風險 | 將來 POS 加渠道（例如新平台），Ledger 漏加 ⇒ 靜默少計，冇人知 | 低（合計只喺 POS 一處計） | 中（UI 大改，要重做確認稿） |
| 結論 | **可以今日頂住**（Ledger 一行） | **正解，做** | 下一步 |

## 5. 推薦：B（POS 出合計）＋ A 做過渡

### 5.1 POS 側：`pos_offline_report` 新增 top-level `posTotals`（migration 0068）

```ts
posTotals?: {
  revenueAvos: number;      // = kpi.revenue + kpi.online.revenue（毛，＝交班「實收金額合計」）
  refundedAvos: number;     // = kpi.refunded + kpi.online.refunded（只含 POS 側退款）
  netRevenueAvos: number;   // = revenueAvos − refundedAvos
  receivableAvos: number;   // = Σ paymentBreakdown[].receivableAvos（全渠道）
  orderCount: number;       // = kpi.orderCount + kpi.online.orderCount
  orderCountOffline: number;
  orderCountOnline: number;
}
```

鐵律（要寫入契約 ＋ guard test 鎖死）：

1. **`kpi` 五欄一個數字都唔准改**（改咗 Ledger 已對數嘅卡即刻跳數）。
2. `posTotals.revenueAvos` 必須等於 `kpi.revenue + kpi.online.revenue`，route 收到唔對 ⇒ **唔出 `posTotals`**（缺席 ≠ 0），caps 亦唔宣告。
3. `posTotals` 係 additive：缺席時 Ledger 自動降級去方案 A。
4. 唔准喺 `posTotals` 混入 `kpi.onlinePlatform`——佢**已經喺 `kpi` 入面**（呢個就係最易雙計嘅位）。

caps 加一個值：`x-pos-offline-report-caps: ...,posTotals`。

### 5.2 Ledger 側（另一個 repo，要佢哋改）

1. 四格 KPI 改成四行（或 2×2＋合計卡）：

```text
店內（POS 線下）        17 張   MOP 969
外賣平台（澳覓／mFood）   1 張    MOP 44
線上（掃碼／排位投影）    4 張    MOP 372
────────────────────────────────────
POS 營業額合計          22 張   MOP 1,385
   ＝ macau-pos 交班「實收金額合計」
```

2. 合計卡只讀 `posTotals`，**禁止任何 Ledger 本地加總**（包括唔准用 `public.orders` 補數）。
3. 合計卡顯示 `generatedAt`（見 R4 時滯），並寫明「澳門日曆日 00:00–23:59」。
4. 「會員通（線上）」→「會員錢包流水（不計入營業額）」，加一句「充值／扣點係錢包進出，唔等於當日賣出」。
5. 黃字保留原意（純線上退款無源），但改成「退款只含 POS 線下」。

### 5.3 驗收（用 10-20 做 regression fixture）

```text
posTotals.revenueAvos   ＝ 1385.00
        ＝ kpi.revenueAvos(1013) ＋ kpi.online.revenueAvos(372)
        ＝ offline(969) ＋ onlinePlatform(44) ＋ online(372)
posTotals.orderCount    ＝ 22（18 ＋ 4）
Ledger 畫面合計          ＝ 1385 ＝ POS 交班「實收金額合計」
Ledger「店內＋平台」      ＝ 1013 ＝ POS 交班「線下」
```

## 6. 陷阱（實作前必讀）

| # | 陷阱 | 後果 | 對策 |
|---|---|---|---|
| T1 | 有人順手把 `kpi` 改成含投影 | Ledger 已對數嘅卡跳數，商家第二次投訴 | guard test 對 `kpi` 逐欄鎖死（已有 4 段 SQL 斷言，加一條 `posTotals` 關係式） |
| T2 | 平台 44 被同時算入 `kpi` 同 `onlinePlatform` | 合計多 44 | `posTotals` 只加 `kpi` ＋ `kpi.online`；`onlinePlatform` **只做顯示分解** |
| T3 | Ledger 把「錢包扣點 709」加落營業額 | 數字大幾倍 | 錢包區塊永遠唔參與任何合計（D3） |
| T4 | **時滯**：交班讀本機 `loadOrders()`，Ledger 讀雲端 RPC | POS 未 sync 上雲時 Ledger 少數（最常見「明明一樣但差幾十」） | 合計卡顯示 `generatedAt`；兩邊都寫「截至 HH:MM」 |
| T5 | 日界：POS `coalesce(settled_at, reopened_at, updated_at, created_at)` vs Ledger `macauTodayDate()` | 跨午夜／返結單歸錯日 | 統一澳門日曆日；返結單要明確講「歸 reopened_at」 |
| T6 | 狀態集合（§2 R3 根因） | Ledger 計 `paid`、交班唔計 | **先統一 `posTotals` 嘅狀態集合 = `settled, paid`**，並喺交班頁加註「含已付款未結帳」；或改交班一齊計 `paid`（要 J 拍板，會令歷史交班數變） |
| T7 | 交班「淨實收」算式同 `summarizeClosedOrders().netPaidTotal` 唔一致（`shift-page.tsx:2007` 用 `paidTotal − refundAmount`，但退款單已被剔出 `paidTotal`） | **有退款嘅日子淨實收會少計**（全退 100 元單 ⇒ 顯示 −100） | 獨立 bug，今日退款 0 所以未爆；建議一併修（改用 `netPaidTotal`） |

## 7. 落地順序

| 階段 | 內容 | 影響範圍 | 可獨立上線 |
|---|---|---|---|
| P0 | Ledger 加一行「POS 營業額合計 ＝ kpi.revenue ＋ kpi.online.revenue」（方案 A） | 只 Ledger UI | ✅ 即刻 |
| P1 | POS migration 0068 ＋ `posTotals` ＋ route 驗證 ＋ guard test | POS API（additive） | ✅ |
| P2 | Ledger 改讀 `posTotals`，四行 ＋ 合計卡；錢包區塊改名 | Ledger UI | ✅ |
| P3 | 統一狀態集合（T6）＋ 修淨實收算式（T7） | POS 交班／報表 | 要 J 拍板 |
| P4（可選） | 逐單對帳：`ordersByChannel[]` 加 `onlineOrderId`（additive），Ledger 對 `orders.id` | 兩邊 | 之後 |

> P3 會令**歷史交班數字改變**，所以一定要獨立一次上線、並且事先同商家講清楚邊日開始變。

## 8. 附：10-20 逐格對照（截圖已證實）

```text
POS 交班  線下 應收 1011 / 實收 1013    Ledger 四格「線下營業額」 1013（18 單）
POS 交班  線上 應收  370 / 實收  372    Ledger 底部「線上」         372（4 單）
POS 交班  實收合計 1385                 Ledger ✗ 冇呢個數
Ledger 底部：店內 969（17）｜平台 44（1）｜線上 372（4）
1013 ＝ 969 ＋ 44          1385 ＝ 969 ＋ 44 ＋ 372
Ledger「會員通（線上）」：充值 1330／贈送 100／扣點 709／訂單已收款 106 ⇒ 全部唔參與營業額
```

4 元（應收 1381 vs 實收 1385）已可解釋：**非菜品費用（餐盒／膠袋／平台服務費）只存在於 `platformFeeLines()`，冇寫入 items**，所以「應收」天生少過「實收」。`offline-report.ts:361-365` 生產實測有 +27 嘅單，同一成因。呢個唔係誤差，係口徑定義，Ledger 顯示時應該標「應收／實收差額可為負」。
