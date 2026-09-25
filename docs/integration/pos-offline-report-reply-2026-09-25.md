# 回覆：Ledger「線下營業摘要 API」契約 v1（POS 側立場 ＋ 實作完成）

> **對象**：澳門會員通（Macau-Ledger）
> **日期**：2026-09-25
> **回覆**：`pos-offline-report-api.md`（2026-09-24）
> **我方實作**：`docs/150-ledger-offline-report-route.md`（route ＋ `0058` RPC ＋ 測試已齊，**未部署**）
> **審視依據**：`docs/integration/pos-offline-report-contract-review-2026-09-25.md`（含生產數據對數底稿）

---

## 0. 一句話

**方向同意、我方已按契約實作完**（一支唯讀 GET ＋ DB 內聚合），但**契約有 5 處要你哋改**（下面 §1）——
照原文字面實作會出錯數。§2 係我哋**實際會回**嘅 payload；§3 係要你哋回嘅三件事（其中兩件我哋已經用生產數據答咗）。

---

## 1. 要你哋改嘅 5 處（連理由）

| # | 契約原文 | 問題 | 建議改法（我方已照呢個實作） |
|---|---|---|---|
| 1 | 時間歸屬「`settled_at`，缺則 `updated_at`」 | **漏咗 `reopened_at`**：有返結紀錄但 `settled_at` 為 NULL 嘅單（舊 client／未 backfill 嘅店）會歸錯日 | 四條腿：`coalesce(settled_at, reopened_at, updated_at, created_at)` 轉 `Asia/Macau`（＝ POS 唯一真源 `orderEventInstant()`） |
| 2 | `breakdown.dineIn` / `quick` | POS `/reports` **冇呢個維度**（只拆線上／線下）；「堂食／快餐」只用於出餐時長同人流 ⇒ 新發明口徑，第一次對數一定對唔上 | v1 **唔出**呢兩格（契約本身寫「無則省略」）。日後若要，定義為 `table_id = 'counter'` → quick |
| 3 | `kpi.covers` | 必須對齊「當日人流」卡（counter 一單 1 人、堂食 `max(1, party_size)`）；**唔可以**用報表 `Agg.covers`（Σ `party_size`，快餐一律 0） | 補一句「＝ POS『當日人流』口徑」＋**只計線下單**（線上單唔入呢張卡） |
| 4 | `byPayment[].method` 1–32 字 | 值域係**開放字串**，而且會有**組合值**（實測 `"會員餘額 + Mpay"`）⇒ 唔可以 map 成固定清單 | 照原字串顯示（POS 側已 `left(…, 32)` 截斷避免觸發你哋整包拒收） |
| 5 | §口徑建議「用 `docs/sql/94` 嘅 `build_full_report()`」 | 🔴 呢條路**跑唔到**：該函數 body 引用 83 號嘅 22 個 `report_ro.v_*` view，而 **83 從未在 production 建立**（2026-09-04 已雙方確認）⇒ 唔係權限問題（`security definer` 救唔到），係 **view 唔存在**，`create` 都 create 唔到 | 我方另寫一支輕量聚合 `public.pos_offline_report()`（直接讀 `public.pos_orders`，零依賴 83／94） |

另有一項**確認**（唔需要改）：`status ∈ {settled, paid}` 同你哋寫法一致 —— 線下 `paid` 單**要計**
（2026-09-25 我方內部拍板：以 `/reports` 為準；我哋 docs/113 有一段舊註釋寫「線下只計 settled」係過時）。

**排除線上投影單（`online_order_id is not null`）我哋照做**，而且實測證明必須做：
主店 `8291f843-…` 2026-09-24 `settled|paid` 共 35 張 / MOP 2,239，其中 **8 張 / MOP 392 係線上投影單**
⇒ 線下 **27 張 / MOP 1,847**。唔排除就會同你哋自己嘅線上數重複計 392。

---

## 2. 我方實際回應（200）

```json
{
  "v": 1,
  "storeId": "8291f843-9def-4956-9d0b-1cfef2598306",
  "from": "2026-09-01",
  "to": "2026-09-24",
  "generatedAt": "2026-09-25T01:52:00.000Z",
  "kpi": {
    "orderCount": 27,
    "revenueAvos": 184700,
    "refundedAvos": 0,
    "discountAvos": 0,
    "covers": 27
  },
  "breakdown": {
    "byPayment": [
      { "method": "Mpay", "amountAvos": 153200 },
      { "method": "現金", "amountAvos": 23100 },
      { "method": "會員餘額", "amountAvos": 8400 }
    ]
  },
  "flags": { "refundsNetted": false, "clamped": false }
}
```

對比契約原稿嘅差異（**全部係「省略 optional 格」或者「同一把口徑」**）：

1. `breakdown` **只有 `byPayment`**（無 `dineIn` / `quick`，理由見 §1.2）。
2. `byPayment[]` 每一格**只有 `method` / `amountAvos`**（冇 `orderCount`，唔好加料令你哋 validator 要改）。
3. `Σ byPayment[].amountAvos === kpi.revenueAvos`（同一批單、同一口徑；`amountAvos` 用實收 `total`，
   唔係「應收＝Σ item 原價＋服務費＋稅」—— 後者係另一個數，POS 報表有分開顯示）。
4. `flags.refundsNetted` 一律 `false`（毛額口徑，同 POS 報表一致）；`refundedAvos` 係揭露值。
5. `generatedAt` 一律 RFC 3339 帶 `Z`（UTC），你哋顯示澳門時間時自己 +08:00。

錯誤碼（**唔會回 200 空數**，任何一項失敗你哋都可以直接顯示「暫時無法取得」）：

| 情境 | HTTP | body |
|---|---|---|
| 簽名／時戳唔對 | 401 | `{"error":"unauthorized"}` |
| 參數格式錯（缺 `storeId`、非 UUID、日期非法、`from > to`） | 400 | `{"error":"bad_store_id"}` / `{"error":"bad_range"}` |
| 查詢過密（>30 次/分鐘/store） | 429 | `{"error":"too_many_requests"}` |
| 未知店（從未出現在 `pos_orders`） | 404 | `{"error":"store_not_found"}` |
| 我方 0058 未部署／上游失敗 | 503 | `{"error":"rpc_not_deployed"}` / `{"error":"upstream_unavailable"}` |
| 我方 secret 未設（環境問題） | 500 | `{"error":"server_misconfigured"}` |

**Clamp 行為同你哋 validator 完全對齊**：保留 `to`、`from = to − 89 日`、`clamped = true`。
驗收例子：`from=2026-01-01&to=2026-09-24` ⇒ `from=2026-06-27`、`to` 不變、`clamped=true`。

---

## 3. 要你哋回嘅三件事（我方已有兩件嘅答案）

### ① 正式測試店 `store_id`

| store_id | 性質 | 2026-09-24（澳門日）**線下** |
|---|---|---|
| `8291f843-9def-4956-9d0b-1cfef2598306` | **建議 UAT 基準店**（source=pos 純店內單；同日有 8 張線上投影單可驗「排除」） | 27 張 / MOP 1,847 / covers 27 |
| `d564b932-0c91-45e9-86fd-0ec8e2711f13` | 外賣平台單為主 | 14 張 / MOP 2,504 / covers 17 |

> ⚠️ 請你哋**用自己 DB 核對**呢兩個 UUID 是否等於 `merchants.id`（我哋 `store_id` 係由 Ledger 登入回嘅
> `merchant_id` 直接寫入，理論上相等，但呢個要你哋確認）。
> 逐日底稿（09-22～09-24，含 byPayment）見 `tools/_probe-offlinereport2-20260925.out.txt`。

### ② `pos_orders.total` 單位

**MOP 十進位小數（`numeric`），唔係 avos。** 實測值多為整數 MOP（139、68、61、39…）。
⇒ 我方回傳前已 `round(total × 100)` 轉 avos 整數（先加總 MOP、再整包轉，避免浮點尾數）。

### ③ Secret 交換方式

請你哋產生 `LEDGER_OFFLINE_REPORT_HMAC_SECRET`（≥32 hex，**唔可以**同 `LEDGER_WEBHOOK_SECRET` /
`POS_SCAN_DEBIT_SECRET` / `AUTH_PIN_PEPPER` 共用）並**私訊**交換（唔進 git、唔進 issue）。
你哋嗰邊同時要設 `POS_OFFLINE_REPORT_BASE_URL=https://macau-pos-system.vercel.app`。
我方收到後設 Vercel env 並重新部署。

---

## 4. 上線次序（雙方）

1. **我方**：商家喺 POS Supabase SQL Editor 跑 `0058_pos_offline_report_rpc.sql`（idempotent、無 transaction）→ push 部署。
2. **你哋**：設 2 個 env ＋ UAT storeId 對照表（只 UAT 生效）→ 打 route 對數。
3. 對數通過後，喺 UAT 開卡；正式環境嘅對照表按你哋原本設計（整體關閉 + `check:env` 失敗）處理。

⚠️ 次序 1 未完成時，route 會回 `503 rpc_not_deployed`（降級一行），**唔會**出 0 元假數。

---

## 5. 我方唔會做嘅事（請放心）

- ❌ 唔會連你哋 DB、唔會要你哋嘅 DB 密碼／`service_role`；唔會出任何 POS 憑證。
- ❌ 唔會推資料入你哋（純 pull；冇 timer、冇 cron、冇 webhook）。
- ❌ 唔會回訂單明細／單號／顧客／菜品（只有聚合數字）。
- ❌ 唔會加 polling（你哋一次進頁打一次；我方亦有 30 次/分鐘/store 限流）。
