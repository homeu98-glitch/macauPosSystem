# 110 · 自助點餐（掃碼 / Kiosk）會員登入與點數抵扣 — 實作方案

> **文件版本**：v1.0（設計方案，未開工）
> **日期**：2026-09-08
> **範圍**：`src/app/order`（Kiosk 自助點餐機）、`src/app/menu`（客人掃碼自點）
> **相關**：docs/86 §需求 3、docs/87（自助點餐落地）、docs/77（Ledger v3.2）、
>          docs/integration/ledger-client-api.md（Ledger 契約）
> **狀態**：⚠️ 本文係**方案**，含 3 個必須同 Ledger 團隊確認嘅契約缺口（見 §11），
>          未確認前唔好落 code。

---

## 0. TL;DR

| 問題 | 結論 |
|---|---|
| 會員點餐流程點 login？ | 電話（8 位）+ 4 位 PIN，複用現有 `deriveLedgerAuthPassword` 派生演算法，**但走新 route**（現有 `/api/ledger/login` 係店員專用，會 403 非員工） |
| 憑證放邊？ | PIN 只經 HTTPS 去 POS server，pepper 唔出 server；客人 session 落 **sessionStorage + 記憶體**，**禁 localStorage** |
| 扣點用咩身份打 RPC？ | 現有 `merchant_apply_pos_txn` 需要**店員** session（`is_merchant_staff`）。Kiosk 用「設備店員通道」（S1）；掃碼用手機必須經 **POS server 代扣**（S1）或等 Ledger 出顧客端 RPC（S2）。**v1 走 S1，S2 係終局** |
| 唔用點數會點？ | 照落單，單維持原有狀態，只寫會員身份 → 收銀台結帳時 prefill 會員電話，正常收錢 |
| 商家點認到下單會員？ | `pos_orders` 加 `member_phone` / `member_name` / `member_customer_id` / `member_deduct_avos` / `member_deduct_txn_id`，realtime 落收銀台即見。**目前呢啲欄位一律冇落雲**，係本次要補嘅核心缺口 |
| 錢先扣定單先落？ | **一定係「先落單 → 拎 order.id → 扣款 → 成功先標 paid」**。倒轉做會「扣咗錢冇單」 |
| 部分抵扣做唔做？ | **v1 唔做**。只做「全額抵扣」或「唔抵扣」，避免混合支付 + 沖正泥沼 |

---

## 1. 現狀盤點（開工前必讀的三個硬約束）

### 1.1 認證模型：同一個 Auth 命名空間，兩類人

`src/lib/ledger/phone.ts` + `pin.server.ts`：

```text
email    = normalizePhone(phone) + "@phone.macau-ledger.app"   // 8 位澳門手機
password = HMAC-SHA256(key = AUTH_PIN_PEPPER, msg = phone + ":" + pin).hex   // PIN 4 位
```

呢套演算法係 Ledger Web / Android / 會員通 **共用**嘅。所以：

- **店員**同**顧客**都係同一個 Supabase Auth 專案嘅 user，只係顧客冇 `merchant_staff` row。
- 顧客嘅 PIN 係佢自己去會員通 `/wallet/login` 設（POS **唔幫設**，契約 §5.9 明文）。
- 派生要用 `AUTH_PIN_PEPPER`，**server-only**（`pin.server.ts` 有 `import "server-only"`）。

✅ 好消息：登入演算法**唔使改**，只需一支新 route。

### 1.2 現有 `/api/ledger/login` 唔可以復用

`src/app/api/ledger/login/route.ts` L93-111：signIn 成功後硬查 `merchant_staff`，
查唔到就 `signOut` + 403「非本店 Ledger 帳號」。顧客登入**必定**撞呢條。

→ 必須新開一支 **member login route**（或加 `type=member` 分支），**唔好**改舊 route
（舊 route 係收銀台 / admin 嘅生命線，改壞全店入唔到）。

### 1.3 扣款 RPC 係「店員權限」，顧客 token 打唔到

`src/lib/ledger/members.ts` 嘅 `merchant_lookup_customer_wallet` / `merchant_apply_pos_txn`
全部喺 `authenticated + is_merchant_staff(p_merchant_id)` 守衛下。顧客自己嘅 access token
**call 唔到**。

呢個係成個方案最大嘅架構約束，直接決定 §3 嘅「商戶通道」設計。

### 1.4 商家端「認唔到會員」嘅根因

`src/components/pos-app.tsx` L3125 結帳時有 `memberPhone: ledgerMember?.customerPhone ?? null`，
但佢只存在 **ORDER_SETTLED event payload**；`/api/pos/sync/route.ts` 嘅 `pos_orders` upsert
白名單**冇呢個欄**（全 repo 搵 `member_phone` 只見到 salon 表）。

→ **收銀台結完帳，雲端都唔知呢張單係邊個會員。** 換機 / 清 cache reload 之後會員身份就冇咗。
本次一併補：落單時寫、結帳時寫、mapper 讀返。

---

## 2. 目標與非目標

### 目標（In scope）

| # | 目標 |
|---|---|
| G1 | 點餐流程**首頁**（landing）提供會員登入：電話 + PIN；可 skip 直接點餐 |
| G2 | 登入後見到可用餘額；結帳時可選「用會員點數抵扣」 |
| G3 | 唔用點數（或餘額唔夠 / 扣款失敗）→ 照落單，去收銀台付款 |
| G4 | 商家端（收銀台 realtime + 雲端 `pos_orders`）**識別並記錄**下單會員身份與扣款金額 |
| G5 | Kiosk 共用裝置 → 會員 session 必須可登出 / 逾時自動清 |

### 非目標（Out of scope）

| # | 原因 |
|---|---|
| N1 | **POS 幫顧客設 / 改 PIN** — 契約 §5.9 明禁，顧客自己去 `/wallet/login` |
| N2 | **部分抵扣 / 混合支付** — v1 唔做（§7.3） |
| N3 | **優惠券（grant）自助核銷** — 券核銷冇沖正，風險高過餘額，留 P2 |
| N4 | **自助沖正 / 退款** — Ledger 禁 `p_type:"add"`，POS 一律唔做（§7.4） |
| N5 | **積分（points）** — 只做錢包餘額（avos）。積分語義待 Ledger 定義 |
| N6 | 會員註冊 / 首充 — 已有 `ensure-customer`，自助點餐唔開呢個口 |

---

## 3. 系統架構

### 3.1 分層

```
┌─────────────────────────────────────────────────────────────────┐
│  L1 介面層（client）                                              │
│  src/app/order  (Kiosk)      src/app/menu  (掃碼)                 │
│   └ MemberLoginSheet（共用）  └ MemberBadge / DeductToggle        │
│   └ useSelfOrderMember()                                          │
├─────────────────────────────────────────────────────────────────┤
│  L2 編排層（client，src/lib/self-order/）                         │
│   member-session.ts   會員 session 生命週期（sessionStorage+記憶體）│
│   member-client.ts    打 self-order member API                     │
│   member-checkout.ts  落單 → 扣款 → 更新單（狀態機，§8）           │
├─────────────────────────────────────────────────────────────────┤
│  L3 POS 自有 API（server，Next Route Handler）                     │
│   POST /api/self-order/member/login    PIN→Auth，派 member token   │
│   GET  /api/self-order/member/wallet   查餘額（代打 lookup RPC）   │
│   POST /api/self-order/member/deduct   落單後代扣（含 server 核價） │
│   ⚠️ 全部持有 AUTH_PIN_PEPPER；係唯一有權碰 PIN 嘅地方              │
├─────────────────────────────────────────────────────────────────┤
│  L4 商戶通道（server-only，src/lib/ledger/merchant-channel.server）│
│   方案 S1（v1）：每店一條「自助點餐專用店員 session」，               │
│                  token 加密存 macau-pos 自有 DB，server 復活黎打 RPC│
│   方案 S2（v2）：Ledger 出顧客端 RPC，零商戶憑證（§11 待確認）       │
├─────────────────────────────────────────────────────────────────┤
│  L5 Ledger Supabase（Auth + RPC）  │  L6 macau-pos Supabase（pos_*）│
│   merchant_lookup_customer_wallet  │   pos_orders（+ 會員欄，§6）    │
│   merchant_apply_pos_txn           │   realtime → 收銀台             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 兩個 Supabase client 必須分開

`src/lib/ledger/supabase-client.ts` 係 **單例**，而家淨服務店員 session。
若會員 session 用同一個 `setSession()`，**會頂走收銀台嘅店員 session**。

→ 新增 `getMemberSupabaseClient()`：第二個 `createClient` 實例，
`persistSession: false`、`autoRefreshToken: false`、獨立 module-level 變數。
兩者**永遠唔好互相 setSession**。

（Kiosk 部機本身冇店員 session，但 `/order` 同 `/` 喺同一 SPA 內可切換，
而 `pos-app.tsx` 亦持有 Ledger client —— 分開係必要防護。）

---

## 4. 模組職責

| 檔案 | 職責 | 狀態 |
|---|---|---|
| `src/app/api/self-order/member/login/route.ts` | 收 `{phone, pin, storeId}` → `deriveLedgerAuthPassword` → `signInWithPassword` → 校驗「係唔係呢間店嘅顧客」→ 回 `memberToken`（**短命，15 min**）+ 遮罩名 + 餘額 | 新增 |
| `src/app/api/self-order/member/wallet/route.ts` | 用 member token 換餘額（server 經商戶通道打 `merchant_lookup_customer_wallet`） | 新增 |
| `src/app/api/self-order/member/deduct/route.ts` | 收 `{orderId, memberToken}` → **server 重算 total**（§7.6）→ 冪等扣款 → 回 txn id | 新增 |
| `src/lib/ledger/merchant-channel.server.ts` | 商戶通道：由 storeId 攞 / refresh 店員 session，出一個可打 `merchant_*` RPC 嘅 client | 新增 |
| `src/lib/ledger/member-auth.server.ts` | member token 簽發 / 驗簽（HMAC，server secret）+「呢個顧客屬唔屬呢間店」校驗 | 新增 |
| `src/lib/self-order/member-session.ts` | client：sessionStorage 存 member token、`expiresAt`、遮罩名、餘額；逾時 / 登出清除 | 新增 |
| `src/lib/self-order/member-checkout.ts` | client：落單 → 扣款 → 更新單狀態機（§8），含重試與失敗降級 | 新增 |
| `src/components/self-order/member-login-sheet.tsx` | 共用 UI：數字鍵盤（PIN 打散防肩窺）+ 電話輸入 + 錯誤提示 + 餘額顯示 | 新增 |
| `src/components/self-order/member-deduct-bar.tsx` | 購物車底部：餘額 / 「用點數抵扣」開關 / 差額提示 | 新增 |
| `src/lib/kiosk-order.ts` | `buildKioskOrder()` 接收並寫入會員欄位（`memberPhone` / `memberName` / `memberDeductAvos`…） | 改 |
| `src/lib/use-kiosk-order.ts` | 加 `member` state（`useSelfOrderMember()`）、`placeOrder()` 改行 `member-checkout` 編排 | 改 |
| `src/app/order/page.tsx` / `src/app/menu/page.tsx` | landing 加「會員登入」入口；閒置逾時一齊清會員 session | 改 |
| `src/lib/types.ts` | `PosOrder` 加 5 個會員欄位（§6.1） | 改 |
| `src/app/api/pos/sync/route.ts` | `pos_orders` upsert 白名單 + ORDER_SETTLED 補寫會員欄 | 改 |
| `src/lib/pos/pos-order-mapper.ts` | DB row → `PosOrder` 讀回會員欄 | 改 |
| `supabase/migrations/0026_pos_orders_member.sql` | 加欄 + index（`store_id, member_phone`） | 新增 |
| 收銀台（pos-app / orders-hub） | 單卡顯示會員徽章 + 名 + 已扣金額；結帳 prefill 會員電話 | 改（P1） |

---

## 5. 資料流程

### 5.1 登入（G1）

```
[Kiosk/手機 landing]
  使用者撳「會員登入」
    → MemberLoginSheet：電話 8 位（NumericKeypad）→ PIN 4 位（打散鍵盤）
    → POST /api/self-order/member/login { phone, pin, storeId }
         ├─ server：rate-limit（phone + IP）→ validate 格式
         ├─ server：password = HMAC(pepper, phone:pin)
         ├─ Ledger Auth：signInWithPassword(email, password)
         │     └ fail → 401「電話或 PIN 不正確」（唔分邊樣錯）
         ├─ server：確認呢個 user **係** storeId 嘅顧客、且 **唔係** 店員（§7.7）
         │     └ 唔係 → signOut(local) → 403
         ├─ server：經商戶通道 lookup wallet → 攞 balanceAvos / displayName
         └─ 200 { memberToken, expiresAt, phoneMasked, displayName, balanceAvos }
    → client：member-session.ts 存 sessionStorage（**唔存 PIN、唔存 phone 明文**）
    → landing 變「已登入」狀態，顯示 ****1234 王先生 · 餘額 MOP 120.00
```

### 5.2 查餘額（G2）

落單前 / 加單後 / 手动刷新 → `GET /api/self-order/member/wallet`。
**唔好輪詢**（項目鐵則：Realtime 為主，禁 setInterval polling）。
餘額會喺 login、每次扣款後、以及進入結帳頁時各取一次就夠。

### 5.3 落單 + 扣款（G2 / G3 / G4）

```
placeOrder()
 1. buildKioskOrder({ ..., memberPhone, memberName, memberCustomerId })   ← 先帶身份
 2. submitKioskOrder(storeId, order, ORDER_CREATED)                       ← 單先落雲
      └ 失敗 → 中止，唔好扣錢（錢未郁）
 3. 若使用者選「用點數抵扣」：
      POST /api/self-order/member/deduct { orderId, memberToken }
        server：
          a. 驗 memberToken + 綁定 storeId
          b. 由 pos_orders 讀返張單，**用 DB 餐牌重算 total**（§7.6）
          c. balanceAvos >= totalAvos ?  : 409「餘額不足，請到收銀台付款」
          d. idempotencyKey = `self-deduct:{orderId}:{totalAvos}`（§7.5）
          e. 商戶通道打 merchant_apply_pos_txn(p_type:"deduct")
          f. 寫 pos_orders：member_deduct_avos / member_deduct_txn_id /
                            prepaid_amount / payment_method="會員餘額" /
                            status="paid"（Kiosk）/ 維持原狀（掃碼，§7.8）
      client：
          ✔ 成功 → 顯示「已用會員點數 MOP xx」，**鎖單**（§7.4）
          ✘ 失敗 → 顯示「請到收銀台付款」，單維持原狀、會員身份照寫
 4. 未登入 / 唔用點數 → 直接跳第 4 步尾：顯示「請往收銀台付款」
```

---

## 6. 資料模型變更

### 6.1 `PosOrder`（`src/lib/types.ts`）

```ts
// ── 自助點餐會員（會員身份於落單時寫，唔等結帳）──
/** 下單會員電話（Ledger 8 位）。未登入則 undefined。 */
memberPhone?: string;
/** 下單會員顯示名（快照，改名唔影響舊單）。 */
memberName?: string;
/** Ledger customer_id（對帳用；可空）。 */
memberCustomerId?: string;
/** 自助點餐當下已扣嘅會員餘額（avos）。 */
memberDeductAvos?: number;
/** Ledger 扣款交易 id（對帳 / 追數用）。 */
memberDeductTxnId?: string;
```

命名刻意**重用**現有 `ledgerMemberPhone` / `memberDeductionAvos`（結帳快照）嘅語義但分開欄：
前者係「**邊個落單**」，後者係「**結帳扣咗幾多**」。自助扣款會兩邊都寫，對帳時要一致。

### 6.2 migration `0026_pos_orders_member.sql`

```sql
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS member_phone         text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS member_name          text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS member_customer_id   text;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS member_deduct_avos   integer;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS member_deduct_txn_id text;
CREATE INDEX IF NOT EXISTS idx_pos_orders_member_phone
  ON pos_orders (store_id, member_phone);
```

冇 `NOT NULL`、冇 default，舊列全 NULL，唔使 backfill（跟 0015 / 0017 慣例）。

### 6.3 三處要同步改（漏一處就「本地有、雲端冇」）

1. `/api/pos/sync/route.ts` → `pos_orders` upsert 白名單加 5 欄（用 `text()` / `money()` 幫手）
2. `/api/pos/sync/route.ts` → ORDER_SETTLED 分支補寫 `member_phone` / `member_deduct_avos`
3. `src/lib/pos/pos-order-mapper.ts` → row → `PosOrder` 讀回

---

## 7. 關鍵設計要點

### 7.1 【最重要】扣款順序：單先落，錢後扣

**「先扣錢、後落單」係錯嘅**：扣款成功但落單失敗（網絡斷 / sync 400）→ 錢扣咗、冇單、
POS 又冇沖正權限（`p_type:"add"` 被禁）→ 錢就咁飛咗，只能叫客搵會員通 Web 退。

所以鐵則：**order.id 係扣款嘅前提**，冇單唔准扣。

### 7.2 商戶通道（S1 / S2）— 成個方案嘅樞紐

`merchant_apply_pos_txn` 要店員身份。客人手機能有三條路：

| 方案 | 做法 | 優點 | 風險 |
|---|---|---|---|
| **S1 · 店員 session 代理**（v1） | 後台為每店設定一個「自助點餐專用」店員帳號（低權限 `staff`），一次性用 phone+PIN 換 token，**加密存 macau-pos 自有 DB**；server 用 `setSession()` 復活黎打 RPC，refresh 後寫回 | 唔使等 Ledger，即刻做得 | 商戶憑證託管喺 POS server；要處理 refresh 輪換、撤銷、輪換失敗告警 |
| **S2 · Ledger 顧客端 RPC**（v2 終局） | `customer_self_deduct(p_merchant_id, p_amount_avos, p_idempotency_key, p_order_ref)`，顧客 auth 下自我授權 | 零商戶憑證外洩；語義最乾淨 | 要 Ledger 開發 + 上線，排期唔喺我手 |
| S3 · 顧客 token 直打現有 RPC | 唔可行 | — | RLS 直接拒 |

**v1 採用 S1**，並預留 S2 介面：`merchant-channel.server.ts` 出同一個
`deductMemberBalance()` 簽名，S2 上線時只換底層實作，上層零改動。

S1 嘅三條安全底線：
1. 專用帳號**只**配 `staff`（唔好 `owner`），且喺 POS 後台可一鍵撤銷。
2. token 一定要 **加密**（`pgcrypto` 或 app-level AES-GCM，key 放 Vercel env），**唔好**明文入 DB。
3. channel 打 RPC 時**只**用固定白名單（`merchant_lookup_customer_wallet` / `merchant_apply_pos_txn`），
   唔好整通用 proxy（會變權限提升漏洞）。

### 7.3 v1 淨做「全額抵扣」，唔做部分抵扣

部分抵扣會即刻引入「收銀台收幾多」+「加單點計」+「沖正點做」三條死線。
v1 規則：**`balanceAvos >= totalAvos` 先准扣**；唔夠就提示「餘額不足，請到收銀台付款」，
張單照落、會員身份照寫，收銀台結帳時可以繼續用 `executeLedgerMemberCheckout`（已有）扣。

等 S2 同券核銷一齊上，先開部分抵扣。

### 7.4 扣款成功 = 張單鎖死

Ledger 唔畀 POS 沖正（`p_type:"add"` 禁用）。所以：

- 自助扣款成功嘅單 **唔准再加單 / 改單**（前端鎖「加單」按鈕 + server 拒 `ORDER_UPDATED` 改 items）。
  類比 `docs/84 ordered-note-lock` 嘅鎖定思路。
- Kiosk 嘅 `placeOrder` 若 `resumedOrder` 已有 `memberDeductAvos > 0` → 直接拒，要開新單。
- 客人真係要加嘢 → 落第二張單，或去收銀台。

### 7.5 冪等鍵設計

```text
idempotencyKey = `self-deduct:{orderId}:{totalAvos}`
```

- server 生成（**唔信 client 傳**），防偽造重用。
- 帶 `totalAvos`：若張單金額變過（理論上鎖死後唔會），key 唔同名 → Ledger 當新交易 → 會雙扣。
  所以**必須**配合 §7.4 嘅鎖單，兩者係同一個保險嘅兩半。
- 網絡逾時重試：client 用**同一個** orderId 重打，server 靠 key 命中返舊 txn，唔會雙扣。

### 7.6 金額必須 server 重算

而家 `submitKioskOrder` 係直接信 client 計嘅 `total`。平日係自己蝕底，
但牽涉會員扣款就係**可以畀人改 JS 扣少啲錢、或者扣多啲**。

`deduct` route 要做：
1. 由 `pos_orders` 讀返張單（server 係 service_role，讀得到）。
2. 由 `pos_bootstrap_config` 拎餐牌價，**重算** `subtotal / tax / service / total`。
3. 同 DB 入面嗰個 `total` 對唔到 → 拒扣 + 記 audit log（代表 client 出貓或餐牌改過）。

### 7.7 「係唔係呢間店嘅會員」點驗

server 攞到顧客 auth uid 之後，需要一個判斷：「呢個 user 係咪 storeId 嘅顧客」。
**現有 RPC 全部要店員身份**，所以只能經 §7.2 嘅商戶通道打
`merchant_lookup_customer_wallet(p_merchant_id, p_phone)`：
`registered === true` → 係；`false` → 403「尚未成為本店會員」。

同時要 **反向檢查**：若 `merchant_staff` 有 row（即係店員），
自助點餐介面應拒絕佢用顧客身份 login（避免權限混淆），提示「請用收銀台」。

### 7.8 Kiosk 同掃碼嘅落單後狀態要分流

| | Kiosk（綁定設備，可信） | 掃碼（客人手機） |
|---|---|---|
| 自助扣款成功 | `status = "paid"`、`prepaid_amount = total`、`payment_method = "會員餘額"` → **直接出單**（等於客人已付款） | **維持 `draft`**，等收銀台確認（沿用現有 `selfOrderAutoAccept` 開關），因為手機端付款成功唔等於商戶確認 |
| 唔用點數 | 維持現有（autoAccept ? `sent_to_kitchen` : `draft`） | 同左 |

理由：Kiosk 喺店內、設備可信、有紙單；掃碼單冇實體憑證，一律要收銀台過一手。

### 7.9 Session 生命週期與 PII

| 項目 | 決定 |
|---|---|
| 存邊 | **sessionStorage + 模組級記憶體**。禁 localStorage（Kiosk 係共用機，下個客人會見到上個嘅名） |
| 存乜 | `memberToken`（server 簽發，15 min）、`expiresAt`、遮罩電話（`****1234`）、`displayName`、`balanceAvos` |
| 唔存乜 | **PIN（任何形式）**、完整電話（除非商戶端要）、access/refresh token（留 server 側對照） |
| 逾時 | Kiosk：沿用現有 landing 閒置 1 分鐘 → 一齊清會員 session；登入後 15 分鐘亦強制過期 |
| 登出 | 提供「唔係我 / 登出」掣；落單完成（Kiosk `returnToHome`）必清 |
| Ledger Auth | server 側 `signOut({scope:"local"})`（跟契約 §4.4：POS 自理，禁打 Ledger Web） |

### 7.10 限流與防暴破

- 現有 `/api/ledger/login` 係 10 次 / 60s / IP。會員 login 要**再加一層**：
  **5 次 / 15 分鐘 / 電話號碼**，連錯 5 次鎖 15 分鐘（跨 IP 都鎖，因為 PIN 得 4 位 = 1 萬分之一）。
- 錯誤訊息統一「電話或 PIN 不正確」，**唔好**分「冇呢個電話」/「PIN 錯」（會變號碼枚舉）。
- PIN 输入錯誤唔好 echo 返個 PIN 出嚟。

### 7.11 報表口徑（唔好改動！）

自助扣款**唔係折扣**，係**預付收款方式**：

- 營業額照計 `total`（全額），**唔好**減 `memberDeductAvos`。
- 收款方式記 `payment_method = "會員餘額"`，`prepaid_amount = total`。
- 與 `docs/76` 既有「收入認列口徑」一致：單已 `paid`（Kiosk）即入營業額；
  掃碼單未 `settled` 前照舊唔入（`isSaleCountable` 口徑**一個字都唔好改**）。

---

## 8. 狀態機（自助扣款）

```
                    ┌──────────────────┐
   落單（帶會員身份） │  created (draft  │
   ────────────────▶│  / sent_to_kitchen)│
                    └────────┬─────────┘
                             │ 使用者選「用點數抵扣」
                             ▼
                    ┌──────────────────┐
                    │  deduct_pending  │  (client 本地態，唔落 DB)
                    └────────┬─────────┘
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
       ✔ 成功           ✘ 餘額不足      ✘ 扣款失敗 / 逾時
   member_deduct_avos   （單唔郁）      （單唔郁）
   + txn_id
   status=paid(Kiosk)   → 提示「請到收銀台付款」
   🔒 鎖單               會員身份照寫     可重試一次（同 idempotencyKey）
              │             │
              └──────┬──────┘
                     ▼
            收銀台結帳（差額 / 全額）
                     │
                     ▼
              settled / paid  ← ORDER_SETTLED 補寫 member_phone
```

**任何一步錢郁咗但狀態冇更新** → 一定要出 audit log + 收銀台紅色提示，等人工跟。

---

## 9. 分期交付

| 階段 | 內容 | 依賴 |
|---|---|---|
| **P0（先做，唔使等 Ledger）** | migration 0026 + `PosOrder` 欄位 + sync 白名單 + mapper 讀回 + 收銀台單卡顯示會員徽章。**先解決「商家認唔到下單會員」**（亦係 G4 嘅八成工作量） | 無 |
| **P1（主功能）** | 三支 self-order member API + 商戶通道 S1 + `MemberLoginSheet` + session 管理 + 全額抵扣 + 鎖單 + server 核價 + 限流 | 要一個「自助點餐專用」店員帳號 + token 加密存放方案 |
| **P2（之後）** | 部分抵扣 / 混合支付、優惠券自助核銷、切去 S2 顧客端 RPC、會員價（member price） | Ledger 新 RPC（§11） |

**建議 P0 先上**：佢零外部依賴、即刻解決資料缺口，P1 出事都唔會影響 P0 嘅資料完整性。

---

## 10. 測試清單（UAT 用）

| # | 場景 | 預期 |
|---|---|---|
| T1 | 未登入直接點餐 | 照落單；`member_phone` 為 NULL；收銀台正常收到 |
| T2 | 電話唔存在 / 未註冊 | login 403「尚未成為本店會員」，可 skip 續點餐 |
| T3 | PIN 錯 1-4 次 | 401，計數遞增 |
| T4 | PIN 錯第 5 次 | 鎖 15 分鐘，換 IP 都鎖 |
| T5 | 已註冊、餘額 **足夠** | 可選抵扣 → 扣款成功 → Kiosk 單 `paid`、鎖單、`member_deduct_txn_id` 有值 |
| T6 | 已註冊、餘額 **唔夠** | 提示「請到收銀台付款」；單維持原狀、`member_phone` 已寫 |
| T7 | 扣款時網絡斷 → 重試 | **只扣一次**（idempotency 命中） |
| T8 | 落單成功但扣款失敗 | 單喺到、冇扣錢、提示去收銀台 |
| T9 | 已扣款單撳「加單」 | 被拒，提示開新單 / 去收銀台 |
| T10 | Kiosk 落單完成後 | 會員 session 已清，下個客人見唔到上個名 |
| T11 | Kiosk 閒置 1 分鐘 | landing 重置 + 會員 session 清空 |
| T12 | 換機 / 清 cache reload | 收銀台由 `pos_orders` 讀返 `member_phone` / 扣款金額，冇甩 |
| T13 | 店員帳號嘗試會員 login | 拒絕，提示用收銀台 |
| T14 | 報表 | 自助扣款單嘅營業額 = `total`（**冇**被 `memberDeductAvos` 扣減） |
| T15 | 跨店 | A 店會員 login 去 B 店二維碼 → 403（storeId 唔夾） |

---

## 11. ⚠️ 待 Ledger 確認（契約缺口，落 code 前要有答案）

| # | 問題 | 點解重要 | 冇答案嘅後備 |
|---|---|---|---|
| Q1 | 係咪有（或肯加）**顧客端** RPC：喺顧客 auth 下查自己錢包 + 自我授權扣款（S2）？簽名、冪等、`p_order_ref`？ | 決定能否唔使託管商戶憑證 | 行 S1（要額外接受託管風險） |
| Q2 | `pos_orders` 落 `member_phone` / `member_name` 係咪抵觸契約 §7.2「PII 禁止寫入 POS DB」？可否書面豁免 + 定留存期？ | 直接決定 G4 做唔做到 | 只存 `member_customer_id` + phone hash（收銀台要即時改名對數就麻煩） |
| Q3 | 顧客同店員係咪真係共用 `@phone.macau-ledger.app` namespace？會唔會撞號？ | 撞號 = 用顧客 PIN 登入到收銀台 | login 時加「有 `merchant_staff` row 就拒」嘅反向檢查（已列 §7.7） |
| Q4 | 自助扣款嘅交易流水，同線上單 `accept_order_with_deduct` 係咪同一命名空間？對帳點分？ | 報表與對帳 | POS 側自行用 `p_order_ref` 前綴 `self:` 區分 |
| Q5 | 冪等鍵重用時，會唔會返「已處理」以外嘅嘢？有冪等命中嘅明確 error code？ | T7 重試語義 | 視為成功（樂觀），但要 log |

---

## 12. 主要風險

| 風險 | 等級 | 緩解 |
|---|---|---|
| 商戶 refresh token 託管（S1） | 高 | 專用低權限帳號 + 加密 + 可一鍵撤銷 + 輪換失敗告警；盡快切 S2 |
| 扣咗錢但狀態冇更新 | 高 | 單先落、鎖單、server 核價、audit log、收銀台紅色提示 |
| PII 落 DB 合規 | 中 | 等 Q2 書面豁免；加留存期清理 job；RLS 收緊 |
| 共用機 session 殘留 | 中 | sessionStorage + 雙重逾時 + 落單完成必清 + T10/T11 |
| 4 位 PIN 暴破 | 中 | 5 次 / 15 分鐘 / 電話號碼限流（跨 IP） |
| 鎖單惹客訴（唔准加單） | 低 | UI 落單前講清楚「用點數抵扣後唔可以再加單」 |

---

## 13. 與既有文件嘅關係

- **docs/86 §需求 3**：原本設計係「落單**後**彈會員號彈窗」；本文改為「**首頁**先登入 + 落單時抵扣」。
  理由：落單後先問會員號，客人已經撳完「落單」，中途插 PIN 彈窗轉化率極低；
  而且落單後先扣款會撞 §7.4 嘅鎖單問題。首頁登入亦較接近一般會員 App 嘅心智模型。
- **docs/86 §方案 A**（Kiosk 綁店員帳號）：本文嘅 S1 係佢嘅 server 版 —— token 唔落 Kiosk
  localStorage（會畀人由 WebView 摷出嚟），而係落 POS server。
- **docs/87 §3.1**：Kiosk 唔建廚房單、唔推 `PRINT_JOB_CREATED` — 本方案**唔改**呢條。
