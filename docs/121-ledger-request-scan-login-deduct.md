# 121 · 掃碼顧客登入 + 扣費 — 對 Ledger 的需求確認單

> **文件版本**：v1.0
> **日期**：2026-09-11
> **提出方**：macauPosSystem（POS）
> **對象**：Ledger 團隊
> **配套**：`docs/120-self-order-member-login-deduct-feasibility.md`（可行性評估）、`docs/110`（原方案）、`docs/integration/ledger-client-api.md`（現行契約）
> **回覆方式**：請直接在 §7 表格的「Ledger 回覆」欄填寫
> **一句話**：登入與讀取我方已知道怎麼做；**「顧客自己扣款」目前無合法路徑**，本單核心是請 Ledger 拍板扣費路徑（§3）並補齊規格（§4）。

---

## 0.1 ✅ 已回覆（2026-09-11 17:28）

Ledger 已提供 v3.4 契約正本（`docs/integration/ledger-client-api.md`，1271 行），並在交接文檔
`docs/integration/pos-v3.4-partner-handover-customer-login.md` **§5「對 docs/121 的回覆」**逐條作答。
以下為摘要（權威仍以契約為準）：

| 本單項 | Ledger 回覆 |
|--------|------------|
| **§3 扣費路徑** | **S3**：掃碼 = 顧客揀、**收銀台店員代扣**（顧客 JWT 不可自助扣）。**Kiosk** = 用裝置現成**店員 session** 走既有 §5.7（**唔係**新 RPC）。**S2** Phase 1 不做；**S1**（掃碼場景託管店員 token）Phase 1 不認可 |
| **L1–L2 規格** | ✅ §4.5／§5.11 已提供；請整份覆蓋本地 9/1 過期副本（**已完成**） |
| **L3–L7 授權** | ✅ 共用 `@phone.macau-ledger.app` + 同一 pepper；**未設 PIN 無獨立錯誤碼**（Auth 無法穩定區分，統一「密碼錯誤」，靠文案引導）；access token ~1h + refresh；`wallets` 顧客只能 SELECT 本人列，**必帶** `customer_id` 與 `merchant_id`；**無列 = 餘額 0**（**唔應該 403「非本店會員」**）；店員用掃碼頁登入**合法** |
| **L8–L11 金鑰** | ✅ 沿用已提供之 UAT／正式三件套，不可混；S2 不做故**無新冪等規格**；店員扣款沿用既有 `p_idempotency_key` |
| **L12–L15 綁定** | ✅ `customer_id = auth.uid()`；**`?store=` = `merchants.id`（確認）**；`display_name` = `profiles.display_name`（登入後 select 本人 profiles）；跨店**可登入**，該店餘額 0／卡包可能空 |
| **L16–L21 扣費** | ✅ 掃碼自助**不開放**；錯扣補救 = 店員／Admin 走 Ledger Web 沖正（POS 禁 `p_type=add`）；**不加部分扣款**；**Webhook Phase 1 不做**（L22 同意同步 RPC 即可） |
| **L25–L27 合規** | ✅ `pos_orders` **只許落 Ledger `customer_id`（uuid）**，**禁止落電話／PIN**；顯示名僅當次畫面；條款已涵蓋掃碼頁登入自讀（**無需改條文**） |
| **L28–L29 聯測** | 店主 `60000001`／`1111`；會員 `60000003`（已註冊）。餘額／未設 PIN 樣本用 UAT 自備號 |

**由此產生嘅設計修正**：① 唔應該 403「非本店會員」；② `pos_orders` 欄位由 `member_phone` 改為 **`member_customer_id`**；
③ 未設 PIN 只能靠文案引導；④ Kiosk 雙 client 係硬性（§7.3）。
（詳見 `docs/120` §6.1。）

---

## 0. 背景

掃碼點餐（`/menu?tableId=&store=<merchantId>`、`/quick?store=<merchantId>`）目前**完全沒有會員概念**：客人只能落單，一律「請往收銀付款」。

要讓客人在**自己手機**上登入 Ledger 並**直接扣儲值餘額付款**，缺的不是 UI，而是三件事：
1. 契約 §4.5／§5.11 的規格（我方手上冇，見 §4.1）；
2. **誰有權扣錢**的授權路徑（見 §3，最大阻塞）；
3. 一批實作細節（錯誤碼、冪等、限流、對帳口徑，見 §4）。

---

## 1. 目標流程

```
① 客人掃 QR
     /menu?tableId=A3&store=<merchantId>   或   /quick?store=<merchantId>
        └─ <merchantId> = Ledger merchants UUID（與 pos_orders.store_id 同一命名空間）

② 客人輸入 8 位手機號 + 4 位 PIN（POS 頁面，HTTPS）

③ POS 伺服器換 Auth session
     email    = normalizePhone(phone) + "@phone.macau-ledger.app"
     password = HMAC-SHA256(key = AUTH_PIN_PEPPER, msg = phone + ":" + pin).hex
     → Ledger Auth: signInWithPassword()

④ POS 伺服器讀本店會員資料（用「顧客 JWT」）
     ├─ wallets（本店餘額）
     ├─ get_my_merchant_points（本店積分）
     └─ list_my_rewards（本店卡包）

⑤ 客人選餐 → 落單 → POS 寫 pos_orders（帶會員身份）

⑥ 【核心】客人選「用會員餘額付款」→ 扣減儲值餘額
     ⚠️ 目前無路：契約 §3 明文禁止顧客 session 打 merchant_apply_pos_txn；
        而掃碼係客人自己手機，冇任何店員憑證 → 見 §3

⑦ 扣款成功 → 更新訂單狀態（掃碼單建議維持待收銀確認）→（可選）通知收銀台

⑧ （可選）Ledger → POS 回調通知（見 §4.6）
```

---

## 2. 現況盤點

| 元件 | 現況 | 位置 |
|------|------|------|
| PIN → Auth 密碼派生 | ✅ 已有，可重用 | `src/lib/ledger/pin.server.ts` |
| Ledger Auth email 組裝 | ✅ 已有 | `src/lib/ledger/phone.ts` |
| 帶 JWT 查 Ledger 的 server client | ✅ 已有 | `src/lib/ledger/supabase-server-auth.ts` |
| 會員錢包／券型別 | ✅ 已有 | `src/lib/ledger/member-types.ts` |
| 店員端扣費／核銷編排 | ✅ 已有（**前提：店員 session**） | `src/lib/ledger/checkout-member.ts` |
| 落單入庫 | ✅ 已有 | `src/lib/kiosk-order.ts` → `/api/pos/sync` |
| 顧客登入 route | ❌ 缺（現有 `/api/ledger/login` 係店員專用，會 403） | — |
| 顧客 JWT 讀取通道 | ❌ 缺（`get_my_*` 全無） | — |
| **顧客自助扣費路徑** | ❌ **缺（本單核心）** | — |
| `pos_orders` 會員欄 | ❌ 缺 | — |
| server 端核價 | ❌ 缺（`/api/pos/sync` 直接信 client `total`） | — |

---

## 3. 🔴 核心決策：扣費走哪條路（請 Ledger 拍板）

`merchant_apply_pos_txn`（扣款）需要 `is_merchant_staff` 身份。掃碼係客人自己手機，**冇店員憑證**。三條路：

### 方案 S2 · Ledger 新增顧客端扣款 RPC（**我方首選**）

請 Ledger 提供一支在**顧客 auth 下自我授權**的扣款 RPC，例如：

```sql
customer_self_deduct(
  p_merchant_id     uuid,      -- 本店
  p_amount_avos     integer,   -- 金額（avos 整數，1 MOP = 100）
  p_idempotency_key text,      -- 冪等鍵（server 生成）
  p_order_ref       text       -- POS 訂單號（對帳用）
) → jsonb { txn_id, amount_avos, balance_after, ... }
```

| 為何首選 | 風險 |
|---------|------|
| 零商戶憑證外洩；語義最乾淨；掃碼與 Kiosk 共用同一條路 | 需要 Ledger 排期開發 |

**需 Ledger 提供**：RPC 簽章、回傳欄位、錯誤碼清單、冪等語義、金額上限／風控規則、限流配額。

### 方案 S1 · POS 伺服器託管店員憑證（備選）

由 POS 後台為**每店**設定一個「自助點餐專用」低權限 `staff` 帳號，一次性換 token，加密存我方 DB；server 復活後代打 `merchant_apply_pos_txn`。

| 為何接受 | 風險 |
|---------|------|
| 唔使等 Ledger 開發 | 商戶憑證託管喺 POS server；要處理輪換、撤銷、失效告警 |

**需 Ledger 提供／確認**：
- 書面認可「POS 伺服器代持店員 session 並代客扣款」**不違反契約**（現行契約 §7.1／§7.3 對 token 落地有嚴格限制）；
- 專用帳號的權限邊界（可否只給 `staff`、可否限制只能扣款）；
- token 有效期、refresh 輪換方式、被撤銷時的行為與可觀察訊號。

### 方案 S3 · 降級：顧客揀、店員代核銷（**零新依賴，即可開工**）

客人喺掃碼頁揀「用餘額／用券」，但**實際扣款由收銀台店員**在確認訂單時執行（沿用既有 `executeLedgerMemberCheckout`）。

- 優點：**完全唔需要 Ledger 提供任何新東西**，可以即刻做。
- 缺點：唔滿足「顧客自助完成扣費」，客人仍要等店員確認。

> **請 Ledger 就 §3 三選一給出結論。** 未拍板前，我方只能做 S3 與 §4 嘅「登入 + 讀取」。

---

## 4. 需 Ledger 提供的項目清單

> 每項標明：**在流程中的角色**、**必要條件**、**若缺少的後果**。P0 = 唔解決就無法開工。

### 4.1 規格文件（P0）

| # | 項目 | 在流程中的角色 | 必要條件 | 若缺少 | Ledger 回覆 |
|---|------|--------------|---------|-------|------------|
| L1 | **契約 §4.5 全文**（顧客登入） | 步驟 ③ 的唯一權威依據 | 含完整演算法、REST 等價呼叫、錯誤字串、禁止項 | 交接文檔自稱「以 §4.5 為準」，但**我方手上冇此節**（本地契約只到 §4.4），無法核對 | |
| L2 | **契約 §5.11 全文**（顧客讀取）+ §9 v3.4 驗收清單 | 步驟 ④ 與上線驗收 | 含 RPC 簽章、回傳、RLS 說明 | 同上，無從對接與自測 | |

### 4.2 授權機制（P0）

| # | 項目 | 角色 | 必要條件 | 若缺少 | Ledger 回覆 |
|---|------|------|---------|-------|------------|
| L3 | 確認**店員與顧客共用** `@phone.macau-ledger.app` Auth 命名空間 | 步驟 ③ 派生正確性 | 確認同一 `AUTH_PIN_PEPPER`；確認顧客 PIN 由會員通 `/wallet/login` 設定，POS 不得代設 | 派生錯誤 → 全員登入失敗 | |
| L4 | 顧客 session 的**有效期與 refresh 規則** | 步驟 ③④ 之間維持 session | access_token TTL、可否用 refresh_token 續期、續期失敗的錯誤碼 | 客人做到一半被登出 | |
| L5 | 顧客端**讀取授權**：`wallets` 對顧客 JWT 的 RLS 條件 | 步驟 ④ 讀餘額 | 確認 `select` 可用 `.eq("customer_id", auth.uid()).eq("merchant_id", X)`；列出可讀欄位；確認「無列 = 未成為本店會員 = 餘額 0」 | 讀唔到餘額，整個功能無意義 | |
| L6 | **「是否本店會員」的顧客側判定方式** | 步驟 ④ 的閘 | 顧客 JWT 打唔到 `merchant_lookup_customer_wallet`（店員 RPC）。請提供顧客側判定，例如 `get_my_membership(p_merchant_id)` 或確認「靠 `wallets` 有無列 + `merchant_id` 是否公開可查」 | 無法區分「未註冊」與「未去過本店」 | |
| L7 | 未設 PIN 的**錯誤碼** | 步驟 ③ 錯誤處理 | 需區分「密碼錯誤」vs「此帳號未設 PIN」，讓 POS 引導客人去會員通 | 客人只見到「密碼錯誤」，永遠試唔到入 | |

### 4.3 金鑰與簽章（P0／P1）

| # | 項目 | 角色 | 現況 | 缺口 | Ledger 回覆 |
|---|------|------|------|------|------------|
| L8 | `AUTH_PIN_PEPPER` | 步驟 ③ 派生 Auth 密碼 | ✅ 已私下提供，只在 POS server | 需確認「與正式環境配對嘅係邊一支」（UAT／正式唔可混） | |
| L9 | 環境三件套配對 | 步驟 ③④ | 已知 UAT `membership-uat.macau-tech.com` / 正式 `membership.macau-tech.com` | 請列出**每套環境**對應的 `SUPABASE_URL` + `anon key` + `pepper`，並確認不可跨環境混用 | |
| L10 | 扣款**簽章／冪等鍵規範**（若走 S2） | 步驟 ⑥ 防重複扣款 | 契約 §5.8 只講「有金額必填 `p_idempotency_key`」 | 需：格式（8–128 字元）、重用時的回傳／錯誤碼、有效窗口 | |
| L11 | （若走 S1）**代持憑證的簽章或長期憑證** | 步驟 ⑥ 授權 | 無 | 有無 service account／長期 token？否則要自行處理 refresh 輪換 | |

### 4.4 帳戶綁定資訊（P0）

| # | 項目 | 角色 | 必要條件 | Ledger 回覆 |
|---|------|------|---------|------------|
| L12 | `customer_id` 定義 | 步驟 ④⑤ 對應會員 | 確認 `customer_id` 是否直接等於 `auth.uid()`（session.user.id） | |
| L13 | `display_name` 權威來源 | 步驟 ④ 顯示「王先生」 | 從 `wallets` 定 `customers` 讀？可否遮罩後落 POS 訂單 | |
| L14 | **`merchant_id` ↔ 我方 `store` 參數的映射** | 全流程 | 我方掃碼 URL 的 `?store=` 傳的是 Ledger `merchants.id`（UUID），與 `pos_orders.store_id` 同值。**請確認此假設成立**，並提供校驗方式（例如一支「merchant 是否存在／是否開放」的公開查詢） | |
| L15 | 跨店行為 | 步驟 ④ | A 店會員掃 B 店碼：應 403「尚未成為本店會員」。請確認 Ledger 端語義一致 | |

### 4.5 扣費授權（P0，核心）

| # | 項目 | 角色 | 必要條件 | Ledger 回覆 |
|---|------|------|---------|------------|
| L16 | **§3 路徑決策（S2／S1／S3）** | 步驟 ⑥ 全部 | — | |
| L17 | 扣款 RPC 的**簽章、回傳、錯誤碼清單** | 步驟 ⑥ | 餘額不足／帳號凍結／超限額／冪等命中／未註冊／merchant 不匹配，各要明確錯誤碼 | |
| L18 | **是否允許部分扣款** | 步驟 ⑥ | 我方 v1 建議**只做全額抵扣**；請確認 RPC 是否強制／可否部分 | |
| L19 | **錯扣的補救流程** | 步驟 ⑥ 例外 | 契約已禁 `p_type="add"`（POS 不得沖正）。請提供官方補救路徑（會員通 Web 退回？誰可操作？時效？） | |
| L20 | 扣款的**限流／風控** | 步驟 ⑥ | 顧客端扣款有無自己的 throttle？4 位 PIN 試錯會否誤傷？單筆／單日上限？ | |
| L21 | 扣款**交易流水命名空間** | 對帳 | 與線上單 `accept_order_with_deduct` 是否同一流水表？如何區分「掃碼自助扣款」？ | |

### 4.6 回調／通知（P1）

| # | 項目 | 我方判斷 | 需要 Ledger 確認 | Ledger 回覆 |
|---|------|---------|-----------------|------------|
| L22 | 是否需要 **Ledger → POS 回調** | **我方認為不需要**：步驟 ⑥ 用同步 RPC，回傳即結果 | 若 Ledger 存在**非同步場景**（風控人工審核、批量清算、扣款後撤銷），則需要回調 | |
| L23 | 若需要回調，其規格 | 契約 §8 已提及「Phase 1 明確不做 Webhook」 | 需：endpoint、**per-merchant `webhook_secret`**、簽章演算法、`event_id` 冪等、重試策略、payload 個資最小化 | |
| L24 | 反向通知（Ledger → POS 訂單）現況 | ✅ 我方已有 | 我方現用 `/api/integration/ledger/auto-accept` + `LEDGER_WEBHOOK_SECRET`（HMAC-SHA256，`X-Pos-Timestamp + "." + raw_body`），**可作 Ledger 出站回調的對照藍本** | |

### 4.7 合規與環境（P0）

| # | 項目 | 角色 | 必要條件 | Ledger 回覆 |
|---|------|------|---------|------------|
| L25 | **PII 落地豁免** | 步驟 ⑤ 寫 `pos_orders` | 契約 §7.2 禁止顧客電話入 POS DB；但我方需喺訂單記錄「邊個落單」。請決定：(a) 書面豁免＋留存期；(b) 只存 `customer_id`；(c) 只存 hash | |
| L26 | 條款更新 | 若 (a) | 需同步更新我方 `src/lib/terms-content.ts` 商家版 §6／§11，請提供需加入的條文文字 | |
| L27 | 禁止項複核 | 全流程 | 請確認我方流程不觸及 §3 各項禁止（尤其「不得打 Ledger 公開網域 `/wallet/login`」、「不得訂閱 `wallets` Realtime」、「不得 `setInterval` 拉餘額」） | |

### 4.8 聯測資源（P0）

| # | 項目 | 角色 | Ledger 回覆 |
|---|------|------|------------|
| L28 | UAT 測試帳號 | 聯測 | 已知：店主 `60000001`／PIN `1111`、會員 `60000003`。請補充：**餘額足夠**樣本、**餘額不足**樣本、**未設 PIN** 樣本、**非本店會員** 樣本 | |
| L29 | 聯測窗口與聯絡人 | 排期 | |

---

## 5. 我方自理（唔需要 Ledger）

| 項目 | 說明 |
|------|------|
| 顧客登入 route | 新開 `POST /api/self-order/member/login`，**不改動**現有店員登入 route |
| 第二個 Supabase client | 另建，避免顧客 `setSession` 頂走店員 session |
| Session 生命週期 | sessionStorage + 記憶體，禁 localStorage；逾時／落單完成即清 |
| 限流 | 顧客 PIN 加「電話號碼」維度限流（5 次／15 分鐘，跨 IP） |
| Server 端核價 | 扣費前由 `pos_orders` 讀回重算金額（現時 `/api/pos/sync` 直接信 client `total`） |
| 鎖單 | 已扣款單不得再加單／改單（Ledger 無沖正） |
| 冪等鍵生成 | 由 server 生成，不信 client 傳 |
| 訂單會員欄 | migration + sync 白名單 + mapper 同步改（**待 L25 結論**） |

---

## 6. 驗收條件

| # | 場景 | 預期 |
|---|------|------|
| 1 | 未登入直接點餐 | 照落單，行為不變 |
| 2 | 已註冊會員、餘額足夠、走 §3 路徑 | 扣款成功；餘額正確遞減；交易流水可查 |
| 3 | 餘額不足 | 提示去收銀台；單維持原狀；**未扣款** |
| 4 | 錯 PIN 第 5 次 | 鎖 15 分鐘（跨 IP 亦鎖） |
| 5 | 未設 PIN 帳號 | 明確提示「請先去會員通設定 PIN」 |
| 6 | 網絡逾時重試 | **只扣一次**（冪等命中） |
| 7 | A 店會員掃 B 店碼 | 拒絕，提示非本店會員 |
| 8 | 跨環境 | UAT 憑證不得用於正式（反之亦然） |
| 9 | 對帳 | 扣款交易與訂單可一對一勾稽 |
| 10 | 報表 | 扣款單營業額口徑不變（扣款係收款方式，非折扣） |

---

## 7. 回覆模板（請 Ledger 填）

```
【§3 扣費路徑決策】  □ S2 顧客端 RPC   □ S1 POS 託管憑證   □ S3 僅降級
   理由／排期：

【L1–L2 規格】 §4.5 已提供：□是 □否    §5.11 已提供：□是 □否
   連結／附件：

【L3–L7 授權】 命名空間共用：□確認 □否    未設 PIN 錯誤碼：
   若走 S2，RPC 名稱與簽章：

【L8–L11 金鑰簽章】 正式環境三件套：□提供 □否   冪等鍵規範：

【L12–L15 綁定】 customer_id = auth.uid()：□是 □否    ?store= = merchants.id：□確認 □否

【L16–L21 扣費】 錯誤碼清單：□提供   部分扣款：□允許 □不允許   錯扣補救路徑：
   單筆／單日上限：   交易流水命名空間：

【L22–L24 回調】 需要回調：□是 □否   若需要，secret 名稱與簽章演算法：

【L25–L27 合規】 PII 落地：□豁免 □只存 customer_id □只存 hash   留存期：
   需更新條款文字：□提供

【L28–L29 聯測】 測試帳號補充：   窗口：
```

---

## 附：與現行契約的差異（請一併確認）

| 現行契約（9/1 版） | 本單需要 |
|------------------|---------|
| 只到 §4.4（店員登入）、§5.9（ensure-customer） | §4.5（顧客登入）、§5.11（顧客讀取） |
| §5.6 `merchant_lookup_customer_wallet` 係**店員** RPC | 需要**顧客側**等價能力（L6） |
| §5.8 `merchant_apply_pos_txn` 限店員 | 需要顧客側扣款能力（L16／S2）或託管授權（S1） |
| §7.2 禁 PII 落 POS DB | 需要對 `pos_orders` 會員欄的明確裁決（L25） |
| §8 Webhook「Phase 1 明確不做」 | 若扣費有非同步場景，需重新開案（L23） |
