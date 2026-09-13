# 129 · Ledger v3.5 掃碼扣餘額 — 回覆解讀與落地計劃

> **文件版本**：v1.0（解讀稿，**未落任何 code**）
> **日期**：2026-09-13
> **輸入**：Ledger 對 `docs/126` 的逐條回覆（Q1–Q15，見 §1 逐條表）
> **權威契約**：`docs/integration/pos-v3.5-partner-handover-scan-debit.md`（已入庫）＋ 契約 **§5.12**
> **相關**：`docs/120`（可行性）、`docs/121`（v3.4 需求單）、`docs/122`（P2 提案）、`docs/113`（坑總表）
> **一句話**：**回答係「可以開工」**，但有一條**自相矛盾**（Q2）同一個**本地缺口**（§5.12 未入庫）
> 必須先處理；另外 Q15 揭示一個**先前冇發現嘅硬衝突**（POS 禁止 `p_type=add` vs 沖正走 Ledger Web）。

---

## 0. 先講三個「唔係答案」嘅答案（最重要）

### 0.1 🔴 Ledger 指嘅 §5.12 根本未入庫

| 檢查項 | 結果 |
|--------|------|
| Ledger 回覆 Q8/Q12 都寫「見契約 **§5.12**（quote／commit 共用錯誤碼表）」 | — |
| 本地 `docs/integration/ledger-client-api.md` | **1272 行，mtime 2026-09-11 09:31**，版本仍係 **v3.4** |
| 搜 `5.12` / `scan-debit` / `scan_debit` / `POS_SCAN_DEBIT_SECRET` / `quoteSig` | **全部零命中** |
| `docs/pos-ledger-client-api.md`（舊路徑） | 只有 14 行搬遷指針，同樣冇 §5.12 |
| Q12 回覆寫「☑ 已提供」 | ⚠️ **只提供咗 §5.12 呢條短清單本身**（`pos-v3.5-partner-handover-scan-debit.md`），**權威契約冇更新** |

**後果**：現時手上唯一嘅 v3.5 規格係**103 行嘅實作清單**。而該清單自己第一句就寫：

> 「**權威契約**：`pos-ledger-client-api.md` **§5.12**（**以該檔為準**；本文是實作清單）」

→ **權威文件缺席**，而錯誤碼、守衛細節、回傳欄位全部話「見 §5.12」。**Q8 實際未答。**
→ **必須向 Ledger 追一次**：請提供更新後嘅 `ledger-client-api.md`（v3.5，含 §5.12 全文）。

### 0.2 🔴 Q2 係自相矛盾（Ledger 自己答咗兩次唔同答案）

Ledger 對本單最重要嘅阻塞問題（「會唔會扣錯錢」）**同一個框入面答咗兩個唔同結論**：

```text
【Q2 防雙扣】        ☑ POS 自己負責（Ledger 只擋 scan-debit 同一冪等鍵）
   守衛範圍：☑ 只計 scan-debit 內部
   建議：店員 merchant_apply_pos_txn 若用同一 p_idempotency_key
        = scan-debit:{merchantId}:{posOrderId}，現有 apply_transaction 就會擋雙扣，不必改 Ledger。
```

| 讀法 | 意思 |
|------|------|
| 第一句 | Ledger **唔會**跨路徑守衛 → POS 自己負責 |
| 第三句 | 只要 POS 傳**同一條** `p_idempotency_key`，`apply_transaction` **就會擋** → 不用改 Ledger |

兩者**唔完全矛盾，但要 POS 自己砌橋**：即 **Ledger 端從來冇被改過**，
守衛之所以成立，係因為 `apply_transaction` 對「同一條冪等鍵」嘅既有行為 ——
**前提係 POS 要主動把店員代扣嘅 `p_idempotency_key` 設成同 scan-debit 一樣。**

**我方現況（反面證據）**：`merchant_apply_pos_txn` 嘅冪等鍵由 `src/lib/ledger/checkout-member.ts` 產生，
**唔會**用 `scan-debit:{merchantId}:{posOrderId}` 格式。→ **照現狀實作 = 真·雙扣。**
→ 呢條係 §2.1 攔截點 **P1**，開工前必須先改。

### 0.3 🔴 本地契約 §7.2 個資紅線（Ledger 冇回答，但 Q2 令佢更嚴格）

v3.5 全部流程都係「POS 伺服器帶**顧客 access_token** 打 Ledger」。而本地契約 §7.2 明文：

> 「**禁止**…完整券／餘額 payload 至 POS Supabase、`localStorage`／`IndexedDB` 長期快取、
> 夥伴 analytics、**console.log／error reporting 上報完整 payload**」

→ 顧客 JWT、`quoteSig`、`balanceAfter`、電話一律**唔可以落庫、唔可以 log**。
呢條冇喺 Ledger 今次回覆入面被提及，但**冇被放寬**，所以照舊生效。
**唯一允許落庫嘅會員識別仍然係 `customer_id`（uuid）**（Q14 再次確認同類口徑）。

---

## 1. Q1–Q15 逐條解讀（哪些係「已答」、哪些係「假答」）

| # | Ledger 回覆 | 我方解讀 | 落地影響 |
|---|------------|---------|---------|
| **Q1** | ☑ Ledger 網域<br>UAT `membership-uat.macau-tech.com`<br>正式 `membership.macau-tech.com` | ✅ **確認**。POS 伺服器 = caller，URL = `{LEDGER}/api/integration/pos/scan-debit/quote|commit` | 新增 env `LEDGER_SCAN_DEBIT_BASE_URL`（或沿用 `LEDGER_INTEGRATION_BASE_URL`）；**UAT／正式必須成對**（同 pepper 一樣，Q9） |
| **Q2** | ☑ POS 自己負責（Ledger 只擋 scan-debit 同一冪等鍵）<br>守衛範圍：☑ 只計 scan-debit 內部<br>＋建議 POS 傳同一 key 令 `apply_transaction` 擋 | ⚠️ **自相矛盾（見 §0.2）**。實質 = 「Ledger 冇改，要 POS 自己對齊冪等鍵」 | 🔴 **P1 攔截點**：`merchant_apply_pos_txn` 嘅 key 要改成同 scan-debit 一致，否則**雙扣真錢** |
| **Q3** | 金額由 POS 話事：☑ 確認<br>單筆上限：**無（v1）**　單日上限：**無（v1）**<br>風控：關店／休息中拒絕；餘額不足全額失敗；quote 限流 30 次／15 分／每店每客 | ⚠️ **接受但要知道後果**：Ledger **完全唔核價**，POS 係唯一防線 | 🔴 **P2 攔截點**：`/api/pos/sync` 現時**直接信 client `total`**（`docs/121 §2`、`docs/120 §2.5`）→ **必須先做伺服器端核價**，否則改 JS 就扣少／扣多 |
| **Q4** | 未 commit 可同 `posOrderId` 重 quote 新金額；**已 commit 須新 `posOrderId`**<br>未 commit 嘅 quote：☑ **唔佔冪等鍵**<br>quote 自動失效：☑ **180s** | ✅ **清楚**。堂食加菜 = 新 `posOrderId`（新單）；改單只要未 commit 可以重 quote | 訂單狀態機要記住「commit 後鎖死金額」；`quoteId` 有效期 180s → **UI 必須顯示倒數或超時自動重 quote** |
| **Q5** | 3 分鐘：☑ **建議**（非強制）<br>起計點：☑ **登入成功**<br>範圍：☑ **時間內全部免**<br>Ledger 端再驗 PIN：☑ **不會**<br>refresh token **不可**延長視窗 | ⚠️ **Ledger 完全唔驗 PIN** → POS 判錯 = 等於冇二次確認 | 🔴 **P3 攔截點**：POS 必須自己實作「登入 +180s」窗口；**唔可以**用 refresh token 順延；**每次付款獨立計**（唔可以「上次 PIN 之後永久免」）。手機被盜 = 180s 內可扣錢 |
| **Q6** | lookup 接口：☑ **不提供**<br>commit 重試冇 TTL：☑ **否**（須在 `quoteSig` 有效期內重試；成功後 POS 本地存 `txnId`） | ⚠️ **有缺口**：冇 lookup → 「quote 過期 + commit 可能已成功」**只能靠重試猜** | 對帳設計：`pos_orders` 存 `member_deduct_txn_id`；**唯一補救 = 重試回同一 `txnId`**。因冇 lookup，**唔可以**把「query 唔到」當「未扣款」→ 必須紅標交人 |
| **Q7** | 退路：☑ **即場轉到店付款（同一張單）** | ✅ **確認**（= docs/126 我方建議獲採納） | `insufficient_balance` → 單維持「待收銀付款」（v3.4 現狀），**客人唔使重新落單** |
| **Q8** | ☑ 見契約 §5.12（quote／commit 共用表；另有 401 HMAC/JWT、503 未設密鑰、429 限流、409 金額衝突） | 🔴 **假答**（見 §0.1）—— §5.12 未入庫 | **要追**：`already_debited` 有冇 code？409 金額衝突語義？retryable 邊個 true？ |
| **Q9** | secret：UAT／正式各一，**私下交，勿進前端／repo**<br>`X-Pos-Timestamp` unix 秒：☑ **接受**（亦接受毫秒或 ISO；容差 5 分鐘） | ✅ 確認。**POS 現有驗簽邏輯**（`webhook-signature.ts`）用 unix 秒 → **可以直接沿用** | 新增 `POS_SCAN_DEBIT_SECRET` ×2（UAT／正式）；⚠️ **唔可以**用 `AUTH_PIN_PEPPER` 簽（Q9＋交接文檔明文） |
| **Q10** | 保留期：☑ **跟交易列（永久）**<br>取消後可否重用同一 `posOrderId`：☑ **不可** | ✅ 確認 | **取消單不可復用 id** → POS 現時 `buildKioskOrder` 係 `input.id ?? uid("kiosk")`，**resume 會重用同一 id** → 若已 commit 過又被取消，**再加單會撞冪等鍵**。要確認 `newKioskOrderId()` 嘅重生時機（見 §6.4） |
| **Q11** | 掃碼扣餘額一樣賺分：☑ **確認**　POS 只顯示：☑ 確認 | ✅ 確認 | 沿用 v3.3 積分口徑（`pointsEarned` avos，POS **只顯示唔加減**） |
| **Q12** | ☑ 已提供 → `docs/integration/pos-ledger-client-api.md` §5.12 / `pos-v3.5-partner-handover-scan-debit.md` | ⚠️ **一半正確**：交接清單已入庫，**權威契約 §5.12 未有**（見 §0.1） | **要追** |
| **Q13** | 扣款成功即可出廚（唔需店員再確認）：☑ **可以** | ✅ **大幅簡化**：掃碼單 commit 成功 → `sent_to_kitchen`（甚至 `paid`），**唔使等收銀台** | ⚠️ **但同我方既有口徑衝突**：`docs/122 §4.4` 建議掃碼單**維持 draft／待收銀確認**。要拍板改為「直接出廚」→ 影響 `isSaleCountable` 收入認列 |
| **Q14** | `posOrderId` 純對帳、**桌號唔會入 Ledger**：☑ 確認<br>`posOrderId` 限 `[A-Za-z0-9._:-]+`（**內部 `order.id`，勿用「堂食01」**） | ✅ 確認（同 docs/126 §5 我方預判一致） | ✅ **我方現時已合規**：`uid("kiosk")` = `kiosk-xxxxxxxx`，符合 `[A-Za-z0-9._:-]+` 且 ≠ 中文單號。**唔可以**改成傳 `local_order_no` |
| **Q15** | 正式路徑：店員／Admin 走**會員通 Web 沖正**；掃碼頁 v1 不做退款；**POS 禁 `p_type=add`** | ✅ 確認 | 🔴 **見 §3 嘅硬衝突**：若沖正只可以走 Ledger Web，POS 要有**明文指引文案**（店員要知去邊度沖） |

---

## 2. 攔截點（開工前必須處理，按嚴重度）

### P1 🔴 冪等鍵對齊（防雙扣）— 來自 Q2／Q10

**現況**：`merchant_apply_pos_txn` 嘅 `p_idempotency_key` 由 POS 自行產生，**格式同 scan-debit 唔同**。

**要求**：
- scan-debit `commit` 用 Ledger 固定嘅 `scan-debit:{merchantId}:{posOrderId}`（**Ledger 產生，我方唔傳**）；
- 店員代扣（收銀台／Kiosk）**要主動傳同一條字串**，`apply_transaction` 才會擋。

**未答清楚嘅位**（要追 Ledger）：
1. 店員代扣傳 `scan-debit:...` 呢條 key，**會唔會**因為「前綴語義唔對」而被拒？
   （`docs/121 §6` 曾確認：`merchant_apply_pos_txn` 係**直接**傳 key，
   **唔會**加 `'order-deduct:' || key` 前綴；而線上單 `accept_order_with_deduct` **有**前綴。）
2. `p_idempotency_key` 格式限制（8–128 字元）—— `scan-debit:{uuid}:{kiosk-xxxxxxxx}` 長度要核。

### P2 🔴 伺服器端核價 — 來自 Q3

`/api/pos/sync` **現時直接信 client `total`**（`src/app/api/pos/sync/route.ts` L745–749）。
Q3 已明講「金額由 POS 話事」＋「單筆／單日上限：**無**」→

> **POS 係唯一防線**。冇伺服器端核價 = 改一行 JS 就可以扣 $0.01 或扣 $9999。

**要求**：`quote` 之前，由 `pos_orders` 讀回訂單 → **用菜單重算** → 與 client `total` 不符即拒 + audit。

### P3 🔴 免 PIN 窗口要 POS 自己實作 — 來自 Q5

Ledger **完全唔驗 PIN**。要實作：
- 起計點 = **登入成功**（唔係「上次 PIN 確認」）；
- 窗口 = **180 秒**；`refresh` **唔可以**延長；
- 範圍 = 「時間內**全部**免」（唔係每單一次）；
- 超窗 → 要求重輸 PIN。

⚠️ 呢個係**安全紅線**：4 位 PIN + 無店員在場 + 無金額上限（Q3）= POS 判錯就係「冇二次確認」。

### P4 ⚠️ `/api/pos/sync` 白名單未收會員欄 — 來自 Q14／§7.2

`baseRecord`（`sync/route.ts` L735–776）**冇任何 `member_*` 欄位**。
`pos_orders` 也**未有** `member_customer_id` 欄（同 `docs/120 §2.5` 一致）。

**要求**：migration 加 `member_customer_id`（uuid，**唯一允許落庫嘅會員識別**）
＋ `member_deduct_avos` ＋ `member_deduct_txn_id`；
`sync` 白名單、mapper **同步改**（漏一邊 = 靜靜唔同步）。

---

## 3. 🔴 新發現嘅硬衝突：POS 禁 `p_type=add` vs 沖正走 Ledger Web

### 事實

| 來源 | 內容 |
|------|------|
| Q15 | 沖正正式路徑 = 店員／Admin 走**會員通 Web**；**POS 禁 `p_type=add`** |
| 契約 §5.7.1（v3.4） | `p_type` 非 `deduct`／`topup` → `invalid txn type`（**禁止**自創 `add`） |
| 契約 §5.7.2 | **禁止**把 topup 當返結／退款（gift／paid 唔會按原交易還原，報表會算成新充值）；返結另案 `revert_transaction`，本版**不開放** POS 沖正 RPC |

### 衝突點

我方**現有**功能「返結」（`reopenOrder`）對會員扣款單嘅處理係
**反向回滾 `memberDeductionAvos`**（`src/lib/types.ts` L1191–1195 嘅註解明寫
「供返結反向回滾 / 重結用」）。

若 v3.5 掃碼單**真扣咗 Ledger 餘額**，而客人要返結／退單：

| 路徑 | 可行性 |
|------|--------|
| POS 自己沖正 | ❌ **禁止**（Q15＋§5.7.2） |
| POS 反向回滾本地快照 | ❌ **冇用** —— Ledger 錢已經郁咗，本地回滾只係自欺 |
| 走會員通 Web 沖正 | ✅ 但係**人手**、**冇 API**、**冇 POS 通知** → POS 端餘額顯示會同 Ledger **不一致**，直到下次查 |

→ **v3.5 掃碼單必須「鎖單」**：commit 成功後**唔准**返結、唔准改金額、唔准退單。
要退 = 店員去會員通 Web 沖正 + **POS 記 audit + 收銀台紅標**（人工跟）。
呢個同 `docs/122 §5`「無沖正 = 高風險」嘅判斷一致，但今次係**確認**而唔係**風險評估**。

### 需要拍板

- 掃碼預付單**要唔要**在 POS UI 上**完全移除**「返結」掣？
- 若客人要求退款，POS 要唔要提供「一鍵複製 `posOrderId` / `txnId`」方便店員去會員通對帳？

---

## 4. 同現行文件嘅衝突（要一併更新）

| 文件 | 現行講法 | v3.5 之後 |
|------|---------|----------|
| `docs/120` §3.3／§9 | 掃碼扣費 **❌ 不可行** | ❌ → ✅ **可行**（走 POS 伺服器簽名代打） |
| `docs/121` §3 | 拍板 **S3 降級**（顧客揀、店員代扣） | → **S3.5**：掃碼自助；店員 session 只留 Kiosk |
| `docs/122` | 「唯一出路係 Ledger 開 S2 `customer_self_deduct`」 | ⚠️ **Ledger 用另一形態實現**：唔係新 RPC，而係**兩支 HTTP endpoint**（quote／commit）＋ HMAC。**S2 提案作廢** |
| 契約 §4.5.0 | 「Phase 1 **不**提供 `customer_self_deduct`」 | 技術上**仍然**冇 `customer_self_deduct`（佢係 RPC）；但有 HTTP 等價路徑。**契約要更新措辭** |
| 契約 §1.2／§5.5.3 | 「禁止呼叫非白名單」（除 §5.7.7 外冇 HTTP） | 新增 §5.12 兩支 HTTP endpoint |
| `docs/122 §4.4` | 掃碼單**維持 draft／待收銀確認** | ⚠️ Q13 話**可以**直接出廚 → **要拍板** |
| `docs/113` §「掃碼點餐授權」 | 「掃碼自助扣費**未接通**」 | 要更新 |
| 契約 §4.4 | session 生命週期完全由 POS 自理 | 不變，但**免 PIN 窗口**加入（Q5） |

---

## 5. 分期建議

| 階段 | 內容 | 前置 |
|------|------|------|
| **P0** | **補文件**：追 §5.12 全文；更新 §4 各文件嘅舊結論 | 無 |
| **P0.5** | **地基**（可即刻做，零 Ledger 依賴）：<br>① 伺服器端核價（P2）<br>② `pos_orders` 會員欄 migration（P4）<br>③ 冪等鍵對齊（P1）<br>④ 免 PIN 窗口（P3） | 我方內部 |
| **P1** | **v3.4 前置**（`docs/120` §7 原 P0／P0.5）—— 顧客登入 route、`getMemberSupabaseClient`、`pos_orders` 會員欄 | 契約 §4.5／§5.11（**已有**） |
| **P2** | **v3.5 scan-debit**：quote／commit client、HMAC 簽名、`quoteSig` 180s 倒數、錯誤碼映射、鎖單 | `POS_SCAN_DEBIT_SECRET` ×2 |
| **P3** | 掃碼預付單狀態機（Q13 拍板後）、沖正指引文案（§3）、對帳紅標 | P2 |

---

## 6. 實作細節備忘（避免重複踩坑）

### 6.1 HMAC 簽名（沿用現有樣板）

```text
X-Pos-Timestamp: <unix 秒>
X-Pos-Signature: HMAC-SHA256(POS_SCAN_DEBIT_SECRET, timestamp + "." + rawBody).hex
Authorization: Bearer <顧客 access_token>
```

- **簽原始 body 字串**，**唔可以**先 parse 再 `stringify`（key 順序／空白會變 → 簽名對唔上）。
- POS 現有 `src/lib/ledger/webhook-signature.ts` 已經係同一形態（unix 秒 + `timestamp + "." + rawBody`）→ **可重用**。
- ⚠️ **唔可以**用 `AUTH_PIN_PEPPER` 簽（Q9）。

### 6.2 顧客 JWT 通道

- 用 `createLedgerServerClient(accessToken)`（`src/lib/ledger/supabase-server-auth.ts`）**或**直接 fetch。
- **雙 client 鐵則**（契約 §7.3）：顧客 JWT **唔可以** `setSession` 落店員單例。
- 顧客 JWT **唔可以**落 localStorage / POS DB / log（§7.2）。

### 6.3 `posOrderId` 格式

- ✅ 現況合規：`kiosk-xxxxxxxx`（`uid("kiosk")`）符合 `[A-Za-z0-9._:-]+`。
- ❌ **唔可以**傳 `local_order_no`（可能係「堂食01」/「A01」/「自取02」）。
- ⚠️ 長度要 8–128 字 —— `kiosk-` + 8 = 14 字 ✅。

### 6.4 ⚠️ `posOrderId` 重用陷阱 — 來自 Q10

Q10 明講 **取消後不可重用同一 `posOrderId`**。而 `buildKioskOrder` 係
`id: input.id ?? uid("kiosk")` —— **resume 會重用同一 id**（`src/lib/kiosk-order.ts` L314）。

→ 掃碼單一旦 **commit 過又被取消**，再用同一 id 落單**會撞冪等鍵**。
**要檢查**：`newKioskOrderId()` 嘅重生時機（現時註解話「直到落單成功先重新產生下一個」）——
**「落單成功」唔等於「扣款成功」**，呢兩個時機要分清。

### 6.5 對帳

| 需要 | 做法 |
|------|------|
| 一對一勾稽 | `pos_orders.member_deduct_txn_id` ↔ Ledger 交易列 |
| 冇 lookup（Q6） | **只能**靠重試回同一 `txnId`；**絕對唔可以**把「唔知」當「未扣款」 |
| 沖正（Q15） | 走會員通 Web，**人手**；POS 記 audit ＋ 紅標 |
| 報表口徑 | **不變**：扣款係「預付收款方式」而非折扣，營業額照計 `total` |

### 6.6 限流

- Ledger 側：每店／每顧客 **15 分鐘 30 次 quote**（commit 不另計）。
- POS 側：**只喺按「確認付款」時打一次 quote** —— 唔可以預先 quote / 重試風暴。

---

## 7. 要追 Ledger 嘅 4 條

| # | 問題 | 為何阻塞 |
|---|------|---------|
| **追1** | 請提供**更新後嘅契約 `ledger-client-api.md`（v3.5，含 §5.12 全文）** | Q8 錯誤碼、守衛細節、回傳欄位全部指向 §5.12，而本地冇 |
| **追2** | Q2 矛盾：`merchant_apply_pos_txn` 傳 `scan-debit:{merchantId}:{posOrderId}` 會唔會被拒？（前綴語義）→ 有冇官方建議做法 | 直接關係**會唔會雙扣** |
| **追3** | §5.12 有冇 `already_debited` 之類嘅 code？409 金額衝突 vs 冪等命中點分？各 code 嘅 retryable？ | 冇 lookup（Q6）之下，錯誤碼係**唯一**分辨「已扣／未扣」嘅手段 |
| **追4** | Q13「扣款成功即可出廚」—— 具體係轉 `paid` 定 `sent_to_kitchen`？同 `accept_order_with_deduct` 嘅狀態機有冇對齊？ | 影響收入認列（`isSaleCountable`） |

---

## 8. 我方仍要拍板嘅 3 條（內部）

| # | 決策 | 選項 |
|---|------|------|
| **內1** | 掃碼預付單 commit 成功後嘅狀態 | (a) 直接 `sent_to_kitchen`（Q13 允許，體驗最好）(b) 維持 draft 待確認（`docs/122` 原建議，最保守） |
| **內2** | 掃碼預付單要唔要**完全移除**「返結」掣（§3） | (a) 移除 (b) 保留但二次確認 + 警告「Ledger 端唔會回滾」 |
| **內3** | `POS_SCAN_DEBIT_SECRET` 嘅 env 命名 | `LEDGER_SCAN_DEBIT_SECRET`（對齊 `LEDGER_*` 前綴）vs 照抄 Ledger 叫法 `POS_SCAN_DEBIT_SECRET` |

---

## 附：一句話總結

> **方向接受，可以開工，但唔係「照做」**：
> ① 先追 **§5.12 全文**（Q8 實際未答）；
> ② **P1 冪等鍵對齊**係防雙扣嘅唯一手段，而且係**我方要改**，唔係 Ledger；
> ③ **P2 伺服器端核價**因為 Q3「無上限」而由「應該做」升級為「必須做」；
> ④ **P3 免 PIN 窗口**Ledger 完全唔管，出錯等於冇二次確認；
> ⑤ 新發現：**沖正只能走 Ledger Web** → 掃碼預付單必須鎖單（唔准返結）。
