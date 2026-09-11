# 給 macauPosSystem 的 v3.4 顧客登入交接（可直接轉貼）

> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem)  
> **日期**：2026-09-11  
> **權威契約**：[pos-ledger-client-api.md](pos-ledger-client-api.md) **§4.5、§5.11**（以該檔為準；本文是實作清單）  
> **用途**：掃碼／Kiosk 等**顧客端**頁面——用戶輸入電話 + PIN 登入，並讀取**本店**餘額／積分／卡包。  
> **不是**：店員收銀台登入（仍看契約 §4、v3.2／v3.3 交接）。**不是**：顧客 JWT 自助扣費／核銷。**不是**：顧客在 POS 網域 `create_order`（仍契約外）。  
> **回覆**：[macauPosSystem docs/120](https://github.com/homeu98-glitch/macauPosSystem/blob/main/docs/120-self-order-member-login-deduct-feasibility.md)／[docs/121](https://github.com/homeu98-glitch/macauPosSystem/blob/main/docs/121-ledger-request-scan-login-deduct.md) — 見下方「入口身份」與「對 docs/121 的回覆」。

請把本檔交給 POS Agent。規格細節、錯誤字串、禁止項以契約 §4.5／§5.11 為準。本檔 + 契約全文須一併給對方（對方 9/1 本地契約只到 §4.4）。

---

## 一句話

顧客登入**沒有** `login` RPC。重用你們已有的 HMAC／`signInWithPassword`（同一顆 `AUTH_PIN_PEPPER`）。若現有 `/api/ledger/login` **硬查** `merchant_staff` 並 403，**不要改那支**——另開顧客 route。登入後用**顧客 JWT** 讀本店餘額／積分／卡包。

**扣費／扣券只看「這次操作有沒有店員 Ledger session」，與掃碼或 Kiosk 無關。** 客人手機掃桌上碼＝沒有店員 session＝不能自助扣。Kiosk 平板綁機時已是店員登入＝可走現有 `merchant_apply_pos_txn`／核銷（顧客 JWT 必須另建 client，不可 `setSession` 頂走店員）。

---

## 0. 入口身份（掃碼 vs Kiosk）

與 [macauPosSystem docs/120 §9](https://github.com/homeu98-glitch/macauPosSystem/blob/main/docs/120-self-order-member-login-deduct-feasibility.md) 對齊。Ledger **同意**該節判斷。

| 項目 | 掃碼（客人自己的手機） | Kiosk（店內綁定平板） |
|------|------------------------|------------------------|
| **誰持有店員 session** | 無 | 有（`/login?mode=kiosk` 店員帳號） |
| **登入（電話 + PIN）** | ✅ §4.5 顧客 JWT | ✅ **同一套** §4.5 |
| **讀餘額／積分／卡包** | ✅ §5.11 顧客 JWT | ✅ §5.11（**另建** member client） |
| **自助扣費** | ❌ 顧客 JWT 打 `merchant_apply_pos_txn` 會被拒 | ⚠️ 用**店員** session 走既有 §5.7（v3.2 已有） |
| **自助扣券** | ❌ 同上 | ⚠️ 技術可，券**無沖正**；建議 P2、v1 收銀代核 |
| **建議 v1 扣費** | 顧客揀「用餘額」→ **收銀台代做**（現有 `checkout-member`） | 店員 session 代扣；server 重算金額；專用低權限 `staff` 較佳 |

**禁止（掃碼）**：為了讓客人手機扣到錢，把店員 token 塞進掃碼頁、或 POS 伺服器長期託管店員 session 代客扣（docs/121 方案 S1）。Phase 1 **不做**顧客自助扣款 RPC（方案 S2）。

**Kiosk 鐵則**：顧客 `setSession` **不得**打在店員用的 `getLedgerSupabaseClient()` 單例上。

---

## 請 Agent 先讀契約這兩節

| 要做的事 | 契約 |
|----------|------|
| 電話 + PIN 怎麼換成 Auth session | **§4.5** |
| 餘額／積分／卡包怎麼讀 | **§5.11** |
| 店員登入（對照，勿套用「必須是店員」） | §4.1–§4.4 |
| 店員查別人餘額（收銀台，不是本需求） | §5.6.1 `merchant_lookup_customer_wallet` |

---

## 環境（與店員登入相同，不要再索取）

| 變數 | 誰持有 |
|------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Ledger 專案（不是 POS 自己的 Supabase） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Ledger anon |
| `AUTH_PIN_PEPPER` | **僅 POS 伺服器**（已私下提供；與店員登入同一顆） |

UAT：`https://membership-uat.macau-tech.com` 對應的 Ledger URL／anon／pepper。  
正式：`https://membership.macau-tech.com` 對應的另一套。不可混用。

**不要**再要 `SUPABASE_SERVICE_ROLE_KEY`。

---

## 1. 顧客登入（POS 自有後端）

沒有 Postgres RPC。流程與店員 §4.2 相同，差別只在登入後**不要**查 `merchant_staff`。

```text
email    = normalizePhone(phone) + "@phone.macau-ledger.app"
password = HMAC-SHA256(
             key     = AUTH_PIN_PEPPER,          // 字串本身，不要 hex-decode
             message = normalizePhone(phone) + ":" + pin
           ).digest("hex")                       // 64 字元小寫 hex
```

- 電話：去掉非數字後必須 8 位（`/^\d{8}$/`）
- PIN：必須 4 位數字（`/^\d{4}$/`）

POS 伺服器（**可重用 HMAC helper**；若現有 `/api/ledger/login` 登入後硬查 `merchant_staff` 並簽發 `posDeviceToken`，請**另開**例如 `POST /api/self-order/member/login`，不要加 `mode` 改壞店員 route）：

```ts
const { data, error } = await ledgerServer.auth.signInWithPassword({
  email: `${phone}@phone.macau-ledger.app`,
  password: hmacHex, // 見上
});
// 回傳 data.session（access_token + refresh_token）給前端
```

前端用 **Ledger** supabase-js `setSession`。之後 RPC／`from("wallets")` 都走這個 client。

**顧客模式禁止**：因「沒有 `merchant_staff`」就 `signOut`（一般會員會全部登失敗）。  
店員本人用掃碼頁登入是合法的（同一支 Auth）。

**登不進去**：未在會員通設過 PIN（含 `ensure-customer` 代建、`pin_set=false`）→ 請顧客先到會員通 `/wallet/login` 自設 PIN。POS 不能代設 PIN。

錯 PIN／未註冊：對使用者統一「密碼錯誤」，不要區分「沒有此帳號」。

完整演算法與 REST 等價呼叫見契約 **§4.5**。

---

## 2. 登入後可讀什麼（本店、按需一次）

`user.id` = `session.user.id`。`merchantId` = 掃碼那間店的 Ledger 店 UUID。  
金額單位一律 **avos 整數**（`1 MOP = 100 avos`）。禁止 float。禁止 `update`／`insert` `wallets`。

### 2.1 儲值餘額 — 直查 `wallets`

```ts
const { data } = await ledger
  .from("wallets")
  .select("id, balance_avos, paid_balance_avos, gift_balance_avos, points_balance, currency")
  .eq("customer_id", user.id)   // 必填：店員 JWT 的 RLS 能看到全店錢包
  .eq("merchant_id", merchantId)
  .maybeSingle();

const balanceAvos = data?.balance_avos ?? 0; // 沒有列 = 沒來過這店 = 0
```

| 欄位 | 顯示 |
|------|------|
| `balance_avos` | 可用總額（paid + gift）。`1500` → `MOP 15.00` |
| `paid_balance_avos` | 實際充值 |
| `gift_balance_avos` | 贈送池 |
| `points_balance` | 積分快取（**不是錢**，不要加進 MOP） |

**不要**用 `merchant_lookup_customer_wallet`（那是店員查別人，顧客 JWT 會失敗）。

### 2.2 本店積分 — `get_my_merchant_points`

```ts
const { data } = await ledger.rpc("get_my_merchant_points", {
  p_merchant_id: merchantId,
});
// { merchant_id, points_enabled, points_balance, updated_at }
```

- `points_enabled === false`：會員通不畫積分；POS 建議同樣隱藏（RPC 仍回餘額）。
- 顯示：整數、**不要**加 `MOP`（與會員通顧客端一致）。`points_balance` 仍是 avos。
- 流水可選：`list_my_point_ledger({ p_merchant_id, p_limit })` — 僅使用者打開紀錄時再拉。

積分不可折現、不可當現金扣款、不可跨店。兌換積分 P2 未開放。

### 2.3 卡包 — `list_my_rewards`

```ts
const { data } = await ledger.rpc("list_my_rewards", {
  p_merchant_id: merchantId, // 省略 = 全部店；掃碼頁請傳本店
});
```

陣列；常用欄位：`grant_id`、`title`、`prize_type`（`money_voucher`／`text_gift`）、`reward_amount_avos`、`expires_at`、`status`、`source_type`（如積分兌換）、`image_url`。

單張詳情：`get_my_reward_grant({ p_grant_id })`。  
**核銷**仍是店員 RPC（`redeem_reward`／`redeem_reward_grants`），顧客 JWT 不能自己核銷。

---

## 3. 禁止

- `AUTH_PIN_PEPPER` 或 PIN 進前端／PWA／POS Supabase／log／git
- 打 Ledger 公開網域 `/wallet/login`、Server Action、登出（店員代建 `ensure-customer` 除外）
- 找 `rpc('login')`／`rpc('verify_pin')`／`rpc('check_phone')`
- 顧客 session 打店員寫入：`merchant_apply_pos_txn`、`list_merchant_customers` 等
- `setInterval` 拉餘額／積分／卡包；訂閱 `wallets` Realtime
- 把電話、PIN、token、卡包寫進 POS DB 或 `localStorage` 當長期檔（session 用 memory／`sessionStorage`，登出清空）
- 本版實作 `create_order`（顧客下單仍契約外，另約）

---

## 4. 聯測（UAT）

| 帳號 | 電話 | 預期 |
|------|------|------|
| 示範店主 | `60000001`／PIN `1111` | 顧客模式也應能拿到 session（他同時是店員，不要踢） |
| 示範會員 | `60000003`（已註冊，PIN 以實際為準） | 顧客模式成功；`wallets` 可讀該店餘額（無列則 0） |
| 錯 PIN | 任意已註冊號 | 「密碼錯誤」 |
| 未設 PIN 的代建號 | 夥伴自備 | 失敗；引導去會員通設 PIN |

驗收清單見契約 §9（v3.4 項）與 §5.11。

---

## 問題怎麼問

請引用 **§4.5／§5.11**，並附：環境（UAT／正式）、Auth 錯誤原文或 RPC `error`、是否已 `setSession`、查的 `merchant_id`。

---

## 5. 對 docs/121 的回覆（可轉貼回 Ledger 欄）

權威仍是契約；本節回答 [docs/121](https://github.com/homeu98-glitch/macauPosSystem/blob/main/docs/121-ledger-request-scan-login-deduct.md) §7。

```
【§3 扣費路徑決策】  ☑ S3 掃碼降級（顧客揀、收銀台代扣）
   Kiosk 扣費：走既有店員 §5.7（裝置上已有 staff session），不是新 RPC。
   □ S2 顧客端 RPC — Phase 1 不做
   □ S1 POS 託管店員憑證代客扣 — Phase 1 不認可（掃碼場景）
   理由：扣費／核銷硬前提是 is_merchant_staff。客人手機沒有店員 session。
   排期：S2 未排；P0 先做登入+自讀。

【L1–L2 規格】 §4.5 已提供：☑是    §5.11 已提供：☑是
   連結：Macau-Ledger docs/integration/pos-ledger-client-api.md（v3.4）
   請整份覆蓋你們 9/1 的 ledger-client-api.md（本地只到 §4.4 是過期副本）

【L3–L7 授權】 命名空間共用：☑確認（店員與顧客同一 @phone.macau-ledger.app + 同一 pepper）
   未設 PIN 錯誤碼：Auth 無法穩定區分「沒帳號／未設 PIN／PIN 錯」→ 統一「密碼錯誤」
   引導文案可寫「若從未在會員通設定 PIN，請先到 /wallet/login」
   有效期：Supabase access 約 1h，用 refresh_token 續；續失敗當登出
   wallets RLS：顧客 SELECT 本人列；必帶 customer_id = auth.uid() 與 merchant_id
   無列 = 未在本店建過錢包 = 餘額 0（平台會員掃別店碼仍可登入，不要 403「非本店會員」）
   店員用掃碼頁登入：Auth 成功合法；POS 勿當成收銀台 session

【L8–L11 金鑰】 沿用已提供的 UAT／正式三件套，不可混。S2 不做故無新冪等規格。
   店員扣款冪等仍用既有 merchant_apply_pos_txn 的 p_idempotency_key。

【L12–L15 綁定】 customer_id = auth.uid()：☑是
   ?store= = merchants.id：☑確認（Ledger merchants UUID）
   display_name：profiles.display_name（登入後 select 本人 profiles）
   跨店：可登入；該店餘額 0／卡包可能空

【L16–L21 扣費】 掃碼自助：不開放。錯扣補救：店員／Admin 走 Ledger Web 沖正（POS 禁 p_type=add）
   部分扣款：不在本契約新增；店員 deduct 為指定金額全額一筆
   Webhook：Phase 1 不做（L22 同意同步 RPC 即可）

【L25–L27 合規】 pos_orders 只許落 Ledger customer_id（uuid），禁止落電話／PIN
   顯示名僅當次畫面；條款已涵蓋掃碼頁登入自讀（無需再改條文）
   禁止項：不得打 Ledger /wallet/login、不得 wallets Realtime、不得 polling 餘額

【L28–L29 聯測】 店主 60000001／1111；會員 60000003（已註冊）
   餘額／未設 PIN 樣本請用 UAT 自備號，測完告知清理
```
