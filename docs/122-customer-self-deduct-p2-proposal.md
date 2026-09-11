# 122 · 顧客自助扣款（掃碼手機端）— P2 開案規格提案

> **文件版本**：v1.0
> **日期**：2026-09-11
> **提出方**：macauPosSystem（POS）
> **對象**：Ledger 團隊
> **性質**：⚠️ **開新案（P2）**，不是補文件 —— 契約 v3.4 §4.5.0 已明文「Phase 1 **不**提供 `customer_self_deduct`」
> **相關**：契約 §4.5.0／§5.7.1／§5.11／§7.2／§7.3／§8、`docs/120`（可行性）、`docs/121`（P0 需求單，已回覆）

---

## 0. 一句話

需求 = **顧客在自己手機上完成點餐後，直接從會員餘額扣款，不經商家任何操作**。

現行契約**做不到**，原因不是技術問題，而是**授權模型**：扣款 RPC `merchant_apply_pos_txn` 檢查 `is_merchant_staff`，
而客人手機上沒有店員 session（契約 §4.5.0 明文）。Ledger 已在 Phase 1 明確否決了兩條替代路（S2／S1）。

**要完成這個功能，Ledger 必須新增一支「顧客自我授權扣款」RPC。** 本檔就是該 RPC 的規格提案。

---

## 1. 為什麼現行契約做不到（三方都試過了）

| 路徑 | 結果 | 契約依據 |
|------|------|---------|
| 顧客 JWT 直打 `merchant_apply_pos_txn` | ❌ 被 RLS 拒（需 `is_merchant_staff(p_merchant_id)`） | §4.5.0：`❌ 顧客 JWT 會被拒` |
| POS 伺服器託管店員 token 代客扣（**S1**） | ❌ Phase 1 **不認可** | §4.5.0：`Phase 1 不認可 POS 伺服器為掃碼場景長期託管店員 token 代客扣`；§7.3 重申禁止 |
| Ledger 出顧客端扣款 RPC（**S2**） | ⏸ Phase 1 **不提供** | §4.5.0：`Phase 1 不提供 customer_self_deduct` |
| 店員在收銀台代扣（**S3**） | ✅ 可行但**違背本需求**（要商家操作） | §4.5.0 指定為 v1 做法 |

→ **本需求只能靠 S2。** 以下是 S2 的完整規格提案。

> **有利先例**：契約 §5.10.4（P2 預告）已計劃新增**顧客發起**嘅 `redeem_loyalty_reward`（帶冪等鍵）。
> 即 Ledger 本就有「P2 開放顧客端寫入 RPC」嘅規劃，`customer_self_deduct` 建議**併入同一波**交付。

---

## 2. ⭐ 要 Ledger 提供什麼（一頁清單）

### 2.1 核心：一支新 RPC

**`customer_self_deduct`** —— 顧客 auth 下自我授權扣款（詳見 §3 完整規格）

### 2.2 四個必須拍板的決策

| # | 決策 | 我方建議 | 為何必須 |
|---|------|---------|---------|
| **D1** | **授權模型**：RPC 以 `auth.uid()` 為付款人本人，**不檢查** `is_merchant_staff`；並**禁止**代扣他人 wallet | 必須 = `auth.uid()` | 呢個係整個功能嘅根。若仍要求 staff，功能不成立 |
| **D2** | **限額與風控**：單筆上限、單日累計上限、是否需要二次驗證（重輸 PIN / 生物辨識） | 建議設**單日累計上限**（例如 MOP 500）＋ 超額走 S3 | 4 位 PIN + 無店員在場 = 風險敞口 |
| **D3** | **沖正／退款**：`p_type="add"` 禁用，POS 無沖正權。顧客自助扣款後若要退，誰能退、走邊條路、時效？ | 建議：顧客／店員皆不可自助；走 Ledger Web「退回」＋ POS 記 audit | 冇呢條，一旦錯扣就係客訴黑洞 |
| **D4** | **對帳與流水**：新 RPC 是否寫入同一 `transactions` 表？`note` 標咩？**可否加 `p_reference` 參數存 POS orderId**（現 §5.7.1 無此參數） | 建議加 `p_reference`＋`note='顧客自助扣款'` | 否則 POS 訂單與 Ledger 流水無法一對一勾稽 |

### 2.3 一個附加接口（否則商家端認唔到人）

| # | 需求 | 為何 |
|---|------|------|
| **A1** | 由 `customer_id` 取回 `display_name` 嘅**店員**查詢能力（例如 `merchant_get_customer_by_id(p_merchant_id, p_customer_id)`） | §7.2 只允許 `pos_orders` 存 `customer_id`（禁電話）。收銀台要顯示「王先生已自助付款」，但現有 `list_merchant_customers` **只接受 `p_search`（電話／姓名）**，無法用 uuid 反查 → **商家端會只見到一串 uuid** |

> 若 A1 不可行，替代：收銀台只顯示「會員已自助付款」＋ uuid 後 6 位；或容許 `pos_orders` 存**遮罩姓名**（需 §7.2 另行豁免）。

### 2.4 契約與環境

- 契約新增 **§5.12 顧客自助扣款**（或 §5.7.8），列明簽章／守衛／錯誤碼／冪等；
- §9 驗收清單加對應項目；
- UAT 先行；`AUTH_PIN_PEPPER`／URL／anon 沿用既有三件套（不新增金鑰）。

---

## 3. RPC 規格提案

### 3.1 簽章

```sql
customer_self_deduct(
  p_merchant_id     uuid,     -- 必填；掃碼 URL 的 store = merchants.id
  p_amount_avos     bigint,   -- 必填；正整數（avos，1 MOP = 100）
  p_idempotency_key text,     -- 必填；8–128 字元
  p_reference       text      -- 建議新增；POS orderId（對帳用，可空）
) → jsonb
```

### 3.2 授權與守衛

| 項目 | 要求 |
|------|------|
| 執行身份 | **顧客 JWT**（`authenticated`） |
| 權限 | `auth.uid()` **本人**；**不**檢查 `is_merchant_staff` |
| 扣款對象 | **僅限** `auth.uid()` 自己在本店嘅 wallet（**不可**傳 `p_phone` 或他人 id）→ 天然防止代扣他人 |
| 前置 | wallet 存在且已註冊；`merchants.status` 非 `suspended` |
| 金額 | `> 0`；不超過 D2 限額 |
| 冪等 | 同一 `p_idempotency_key` 重試 → 回**同一** `txn_id`，不重複扣 |

### 3.3 回傳（建議）

```json
{
  "ok": true,
  "txn_id": "<uuid>",
  "amount_avos": 1500,
  "balance_after": 8500,
  "paid_after": 5000,
  "gift_after": 3500,
  "points_earned": 0,
  "created_at": "2026-09-11T10:22:33Z"
}
```

> `points_earned`／`*_after` 對齊 §5.7.1 既有 additive 風格，方便前端與收銀台顯示。

### 3.4 錯誤碼（建議，供 POS 映射文案）

| 錯誤 | 含義 | POS 文案 |
|------|------|---------|
| `insufficient balance` | 餘額不足 | 餘額不足，請改用其他方式付款 |
| `customer not registered` | 未註冊／無本店 wallet | 請先到會員通開通 |
| `idempotency key required` | 缺冪等鍵 | （內部） |
| `invalid amount` | 金額非正整數 | （內部） |
| `amount exceeds self-deduct limit` | 超單筆／單日上限（D2） | 金額超出自助扣款上限，請到收銀台 |
| `self deduct disabled` | 該店未開啟自助扣款 | 本店未開放自助扣款 |
| `merchant suspended` | 商戶停用 | 商戶暫停服務 |
| `not authorized` | 非本人 / token 無效 | 請重新登入 |

### 3.5 扣款順序

沿用 Ledger 既有規則（§5.7.1）：**先扣 gift 池、再扣 paid 池**。POS 側**不得**自行拆分。

---

## 4. 完整實作方案（POS 側）

### 4.1 元件與分層

```
L1 顧客手機（/menu、/quick）
    ├─ MemberLoginSheet（電話 + PIN）
    ├─ useMemberSession()（sessionStorage + 記憶體，禁 localStorage）
    ├─ MemberBalanceBar（餘額、積分、卡包；**唯讀**）
    └─ 「用會員餘額付款」開關 + 確認頁

L2 POS 伺服器（Next Route Handler）  ⚠️ 全部需要顧客 access_token（不落地）
    ├─ POST /api/self-order/member/login        換 session（HMAC + signInWithPassword）
    ├─ POST /api/self-order/member/deduct       核價 → 打 customer_self_deduct → 寫 pos_orders
    └─ （讀取由 client 用顧客 JWT 直讀 §5.11，不必經 server）

L3 Ledger
    ├─ Auth（§4.5）
    ├─ wallets / get_my_* （§5.11，顧客 JWT）
    └─ customer_self_deduct ★ 本提案新增

L4 POS DB（pos_orders）
    └─ member_customer_id / member_deduct_avos / member_deduct_txn_id
       / prepaid_amount / payment_method / status   → Realtime → 收銀台
```

**雙 client 鐵則**（契約 §7.3）：顧客 JWT 必須用**獨立** supabase client，**不得** `setSession` 在店員單例上。

### 4.2 觸發時機（狀態機）

```
① 進掃碼頁 → 「會員登入」→ 電話 + PIN
② 登入成功 → 讀 §5.11（餘額／積分／卡包）；唔登入亦可繼續點餐
③ 選餐 → 本地計 total
④ 客人撳「用會員餘額付款」
      ├─ 前置檢查：balance >= total（不足 → 提示改用收銀台，流程結束）
      └─ 需要 PIN 再確認？（依 D2 決定）
⑤ **先落單**（POST /api/pos/sync，匿名通道，status = draft / 待確認）
      └─ 失敗 → 中止，**未扣款**
⑥ 呼叫 POST /api/self-order/member/deduct { orderId }（帶顧客 token）
      server：
        a. 驗 token → 得 customer_id
        b. 由 pos_orders 讀回訂單 → **用菜單重算金額**（不可信 client total）
        c. idempotencyKey = `self-deduct:{orderId}:{totalAvos}`（**server 生成**）
        d. 打 customer_self_deduct
        e. 成功 → service_role 寫 pos_orders（見 §4.4）
⑦ 前端顯示「已用會員餘額 MOP xx」→ **鎖單**（不可再加單／改單）
⑧ Realtime 推送 → 收銀台見到「會員已自助付款」
```

**為何一定「先落單、後扣款」**：Ledger **不提供 POS 沖正**（`p_type="add"` 禁用）。
若先扣款而落單失敗 → 錢扣了、單沒有 → 只能叫客人去會員通申請退回。故 `orderId` 係扣款嘅前提。

### 4.3 扣款邏輯

| 項目 | 規則 |
|------|------|
| 金額來源 | **server 端**由 `pos_orders` 讀回後用菜單**重算**，與 client `total` 不符即拒扣（記 audit） |
| 單位 | 一律 **avos 整數**，禁 float |
| 全額 / 部分 | **v1 只做全額**（`balance >= total` 才准）。部分抵扣需引入「收銀台收差額」+ 沖正，風險大，建議 P2.1 |
| 券 | 自助扣款**不處理券**（券核銷為店員 RPC）。若要「自助扣款 + 自助用券」，需另開 `customer_self_redeem`（見 §6） |
| 積分 | **不參與扣款**（不可折現、不可當現金）；`points_earned` 由 Ledger 自動計 |
| 失敗處理 | 餘額不足／超限額 → **單保留**、提示去收銀台；扣款失敗 → 可重試（**重用同一冪等鍵**） |

### 4.4 與商家端的資料同步

**寫入 `pos_orders`（扣款成功後，由 POS server 用 service_role 寫）**

| 欄位 | 值 |
|------|-----|
| `member_customer_id` | Ledger `customer_id`（**uuid；唯一允許落庫嘅會員識別**） |
| `member_deduct_avos` | 本次自助扣款金額 |
| `member_deduct_txn_id` | Ledger `txn_id`（對帳） |
| `prepaid_amount` | = total（全額抵扣） |
| `payment_method` | `"會員餘額"` |
| `status` | 見下 |

**狀態策略（掃碼單）**

| 情況 | 建議 |
|------|------|
| 扣款成功 | 維持 `draft`／待收銀確認；**或**在商戶開啟 `selfOrderAutoAccept` 時轉 `sent_to_kitchen`（但**不建議**直接 `settled`） |
| 理由 | 手機端付款成功 ≠ 商戶已確認出餐；且 `settled` 影響收入認列口徑（`isSaleCountable`） |

> ⚠️ 匿名通道**改不到既有單狀態**（`/api/pos/sync` 有 `writeStatus` 守門：`existing && !authorized` 一律沿用 DB 現值）。
> 故此步必須由 **POS server 用 service_role** 完成，唔可以靠 client 自己改。

**推送與收銀台**

- `pos_orders` 已訂 Realtime → 收銀台即時見到新單 + 會員已付款標記；
- 收銀台顯示：`payment_method = 會員餘額`、已扣金額、`txn_id` 短碼；
- **顯示會員名需要 A1 接口**（否則只有 uuid）；
- **不可**把電話／姓名寫入 POS DB 或 localStorage（§7.2）。

**對帳**

| 需要 | 做法 |
|------|------|
| 一對一勾稽 | `pos_orders.member_deduct_txn_id` ↔ Ledger `transactions.txn_id` |
| 流水標識 | 依 D4：建議 `note='顧客自助扣款'` + `p_reference=orderId` |
| 報表口徑 | **不變**：扣款係「預付收款方式」而非折扣，營業額照計 `total`（docs/110 §7.11） |

### 4.5 時序

```
顧客手機            POS 伺服器                 Ledger
   │                    │                        │
   │──登入(電話+PIN)───▶│──signInWithPassword───▶│ Auth
   │◀───顧客 JWT────────│◀─────session───────────│
   │──讀餘額────────────┼───────────────────────▶│ wallets / get_my_*（§5.11）
   │◀───balance 1500────┼────────────────────────│
   │──落單─────────────▶│──寫 pos_orders(draft)──│（POS DB）
   │──用餘額付款───────▶│                        │
   │                    │──核價（讀回訂單重算）───│
   │                    │──customer_self_deduct─▶│ ★新 RPC
   │                    │◀──txn_id / balance─────│
   │                    │──寫 pos_orders(已扣款)─│（POS service_role）
   │◀──已付款───────────│                        │
   │                    │──Realtime 推收銀台─────│
```

---

## 5. 邊界與風險

| 風險 | 等級 | 對策 |
|------|------|------|
| **無沖正**：扣款成功但餐做不出／客人要退 | 高 | 依 D3：店員／Admin 走 Ledger Web 沖正；POS 記 audit + 收銀台紅標，人工跟 |
| **鎖單**：已扣款單不得再加單 | 中 | 前端鎖 + server 拒 `ORDER_UPDATED` 改 items（類比 docs/84） |
| **改 JS 扣少錢** | 高 | **server 端核價**（§4.3）；client `total` 只作顯示 |
| **網絡斷於扣款後** | 中 | 冪等鍵重用 → 重試命中同一 `txn_id`，不雙扣 |
| **扣款成功但 POS 標記失敗** | 中 | 冪等重試 + audit log + 收銀台告警（錢郁咗必須有人知） |
| **代扣他人** | 高 | RPC 只接受 `auth.uid()` 本人（§3.2），**不設 `p_phone` 參數** |
| **4 位 PIN 暴破** | 中 | 電話維度限流（5 次／15 分鐘）＋ D2 單日限額 |
| **共用裝置殘留 session** | 中 | sessionStorage + 雙逾時 + 落單完成必清（掃碼係客人自己手機，風險低於 Kiosk） |

---

## 6. 需要 Ledger 決策的項目（回填用）

```
【D1 授權】customer_self_deduct 以 auth.uid() 為付款人、不查 merchant_staff：□同意 □否（理由：      ）
【D2 限額】單筆上限：______  單日累計上限：______  超額處理：□拒 □走收銀台
           是否需二次驗證：□否 □重輸 PIN □其他：______
【D3 沖正】自助扣款退款路徑：______________________  誰可執行：______  時效：______
【D4 對帳】寫入 transactions：□是 □否   note 建議值：______
           p_reference 參數：□接受新增 □不接受（替代方案：______）
【A1 認人】merchant_get_customer_by_id：□提供 □不提供（替代：______）
【券】是否需要 customer_self_redeem（自助用券）：□P2.1 一併做 □另案 □不做
【排期】可否併入 §5.10.4 嘅 P2 波（redeem_loyalty_reward）：□可 □另排：______
【契約】新增節號：§______    驗收清單項：______
【環境】UAT 先行：□是   測試帳號補充：______
```

---

## 7. 驗收清單（建議加入契約 §9）

| # | 場景 | 預期 |
|---|------|------|
| 1 | 餘額足夠、正常扣款 | 扣款成功；`balance_after` 正確；Ledger 有流水；`pos_orders` 有 `member_deduct_txn_id` |
| 2 | 餘額不足 | 拒扣；單保留；提示去收銀台；**未扣款** |
| 3 | 重試（同 orderId） | **只扣一次**（冪等命中，回同一 `txn_id`） |
| 4 | 落單成功但扣款失敗 | 錢未郁；單在；提示去收銀台 |
| 5 | 顧客 JWT 打他人 wallet | 被拒（只可扣自己） |
| 6 | 客人改 JS 改細 `total` | server 核價不符 → 拒扣 + audit |
| 7 | 超單日上限 | 拒扣；提示去收銀台 |
| 8 | 已扣款單撳「加單」 | 被拒 |
| 9 | 收銀台 | Realtime 即時見到會員已自助付款；金額／txn 一致 |
| 10 | 報表 | 營業額 = `total`（未被扣款額扣減）；口徑與店員代扣一致 |
| 11 | 沖正（若 D3 提供） | 錢包回復；POS 單標記可追溯 |
| 12 | 無 polling／Realtime | 無 `setInterval`；**無** `wallets` Realtime 訂閱 |

---

## 8. 分期建議

| 階段 | 內容 | 依賴 |
|------|------|------|
| **P2.0** | `customer_self_deduct`（全額）＋ server 核價 ＋ 鎖單 ＋ 冪等 ＋ 限額 ＋ A1 認人接口 | **本提案** |
| **P2.1** | 部分抵扣／混合支付（收銀台收差額）、`customer_self_redeem`（自助用券） | P2.0 + D3 沖正方案 |
| **P2.2** | 自助退款入口、會員價 | P2.1 |

---

## 9. 若 Ledger 不開案：三個替代方案與代價

| 替代 | 做法 | 能否滿足「不經商家」 | 代價 |
|------|------|-------------------|------|
| **S3（現行 v1）** | 顧客揀「用餘額」→ 收銀台店員一鍵代扣 | ❌ 仍有 1 個店員步驟 | 零依賴、即刻可用 |
| **S3＋** | 顧客落單時就預選餘額；收銀台只係「確認」一下（非輸入） | ❌ 名義上仍經商家 | 幾乎零成本，體驗較順 |
| **第三方支付** | 掃碼後直接微信／支付寶／信用卡付款 | ✅ | **唔係扣會員餘額**；要接金流、對帳、退款，且 Ledger 定位「不經手金流」 |

> **結論**：要「顧客手機自助扣**會員餘額**」且「零商家操作」，**唯一出路係 Ledger 開 S2**。
> 其他任何做法都係繞路或者達不到目標。

---

## 附：給 Ledger 的一句話

> 請新增 `customer_self_deduct(p_merchant_id, p_amount_avos, p_idempotency_key, p_reference)`，
> 以**顧客 `auth.uid()`** 為付款人本人（不查 `merchant_staff`，不接受 `p_phone`），
> 先扣 gift 再扣 paid，帶冪等鍵；並回覆 §6 嘅 D1–D4／A1。
> 建議併入 §5.10.4 嘅 P2 波交付。
