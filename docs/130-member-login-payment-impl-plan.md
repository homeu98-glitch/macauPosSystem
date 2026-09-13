# 130 — 會員登入 + 付款流程：實作計劃（v2 確認稿落地）

> 來源確認稿：[`docs/mockups/member-login-payment-flow-2026-09-13.html`](mockups/member-login-payment-flow-2026-09-13.html)（17 tab / 21 screen，J 已 approve）
> 前置分析：[`docs/129-scan-debit-v35-ledger-reply-analysis.md`](129-scan-debit-v35-ledger-reply-analysis.md)
> 日期：2026-09-13 ｜ 狀態：**待 J 拍板分期** → 獲批後落 code

---

## 0. 一句話結論

確認稿可以**拆成兩條完全獨立嘅線**，唔使一次過上：

| | 線 A —— 店員代扣（**可即刻做**） | 線 B —— 掃碼自助 quote/commit（需先解 P1–P4） |
|---|---|---|
| 扣款走邊 | Ledger RPC `merchant_apply_pos_txn`（**已有**） | Ledger HTTP `scan-debit/quote` + `commit`（**未有 client**） |
| Session | 店員單例（已有） | **顧客 access_token**（登入 API **未存在**） |
| 核心風險 | 低（複用已上線能力） | 高（雙扣、核價、個資） |
| 覆蓋確認稿 | S1–S8 / S10 / S11 / **S1T–S12T 全部 Kiosk** | 僅「掃碼版 S6/S7 自助扣餘額」 |
| 阻擋 | 無 | 4 個攔截點 P1–P4 全未解 |

**建議：先做線 A**。線 A 已可交付確認稿 90% 內容（所有 Kiosk 平板頁 + 手機快餐頁 + 會員登入 + 付款選項 + 扣款確認）。線 B 等 Ledger 回覆 §5.12 / Q2 之後再開。

---

## 1. 現況盤點（已核實，非推測）

### 1.1 已經存在、可以直接用

| 能力 | 檔案:行 | 備註 |
|---|---|---|
| 查會員錢包 | `src/lib/ledger/members.ts` → `lookupCustomerWallet()` | 走 `merchant_lookup_customer_wallet`，回 `registered`/`customer_id`/`display_name`/`balance_avos`/`gift_balance_avos` |
| 店員代扣 | 同上 → `applyPosDeduct()` | 走 `merchant_apply_pos_txn(p_type:"deduct")` |
| 錯誤文案映射 | `src/lib/ledger/member-errors.ts` | `insufficient balance` / `customer not registered` / `not authorized` … |
| 金額轉換 | `src/lib/ledger/member-types.ts` → `avosToMop()` / `mopToAvos()` | — |
| Kiosk 60s 閒置重置 | `src/app/order/page.tsx:105-120` | 已有，events 5 種，`reset()` 歸零 → `returnHomeRef.current()` |
| Kiosk 5s 成功頁倒數 | `src/app/order/page.tsx:86-103` | 已有，需按 S11T 改 **15s**（快餐）／保留 5s（堂食？Kiosk 只做快餐 → 統一 15s） |
| 掃碼 20 分鐘閒置 | `src/lib/use-kiosk-order.ts:406-428` | 已有 |
| 快餐留住取餐號 | `src/lib/pos/quick-scan-remembered-order.ts` | sessionStorage，6h TTL |
| 自助接單開關 | `pos_kiosk_settings.selfOrderAutoAccept` | 已接 |
| 落單 builder | `src/lib/kiosk-order.ts` → `buildKioskOrder()` | 需加 member 欄位 |

### 1.2 休眠 / 未實作

| 項目 | 現況 | 處理 |
|---|---|---|
| `PosRules.allowMemberLookup` | `types.ts:203` 有欄位、`bootstrap-normalizer.ts:172` 有讀、`mock-data.ts:301` = `false`；**零 UI 使用** | **直接復用**做「本店是否開放會員扣餘額」開關，唔使新開 DB 欄 |
| **顧客會員登入 route（POS 側）** | `/api/ledger/login` 係**店員專用**（查 `merchant_staff`、簽 `posDeviceToken`、`loadMerchantGrants`）；`members.ts` 全走**店員單例 session**；`storage.ts` 無任何會員 session | **Ledger 側契約 §4.5 已入庫**（2026-09-13 夜補查確認）；**POS 側要另開 route**（見 §2.2） |
| `pos_orders` member 欄 | 只有 `memberDeductionAvos` / `ledgerMemberPhone`（返結回滾用），**冇** `member_customer_id` / `member_deduct_txn_id` | 線 A 可**暫時唔落庫**（只 UI 顯示）；線 B 必須補 migration |
| `/api/pos/sync` 白名單 | 未收任何 `member_*` 欄 | 同上 |
| `scan-debit` client | 全 repo 零檔案 | 線 B |

---

## 2. 線 A：店員代扣（Kiosk 全流程 + 掃碼前台付）

> 🔴 **契約 §4.5.0 範圍限制（2026-09-13 夜補查）** —— 扣費／核銷 RPC 檢查嘅係 **`is_merchant_staff`**，唔係「喺邊種頁面」：
>
> | 入口 | 裝置上嘅 Ledger session | 扣費／核銷 |
> |---|---|---|
> | **掃碼**（客人手機） | 僅顧客 JWT | ❌ 顧客 JWT 會被拒。v1：顧客揀、**收銀台店員**代做（既有 §5.7） |
> | **Kiosk**（綁機平板） | 店員 JWT（可另持顧客 JWT） | ⚠️ 用**店員** JWT 走既有 §5.7 |
>
> 契約**明文否決**兩件事：Phase 1 不提供 `customer_self_deduct`（方案 S2）；Phase 1 **不認可 POS 伺服器為掃碼場景長期託管店員 token 代客扣**（方案 S1）。
> → **線 A 嘅掃碼部分只可以做「會員登入 + 顯示餘額 + 揀『到前台支付』」**；掃碼自助扣餘額 = **線 B**（等 scan-debit）。Kiosk 用當下裝置嘅店員 session **不屬** S1 → 合法。

### 2.1 為何可行

Kiosk 係**店內裝置**，本身帶 `posDeviceToken`，用嘅係店員 Ledger session。所以「會員登入」喺 Kiosk 上其實係：

```text
客人喺平板上打「帳號 8 位 + PIN 4 位」
  → POS server 驗證（新 API）
  → 成功後 server 用**店員 session** 查 wallet（lookupCustomerWallet）
  → 回 { customerId, displayName, balanceAvos }（**唔回電話**）
  → 客人下單後揀「扣餘額」
  → POS server 用**店員 session** 打 applyPosDeduct()
  → 回 txn_id → Kiosk 顯示「✅ 扣款成功」
```

即：**顧客身份由 POS 自己驗，扣款由現有店員 RPC 做** —— 完全唔需要 Ledger 新 endpoint，亦唔需要顧客 token。

> ⚠️ 安全口徑：Kiosk 端嘅「會員登入」本質係「證明你係錢包主人」，而唔係取得任何 Ledger 憑證。Server 端**唔可以**回傳 `access_token` 落瀏覽器。

### 2.2 要改嘅檔案（線 A）

#### (1) 新建 `src/lib/ledger/member-login.server.ts`

```ts
// "server-only"
// 顧客會員登入驗證（POS 側）。
// ⚠️ 唔可以重用 deriveLedgerAuthPassword()：Ledger 否認驗 PIN（docs/129 §1 Q-PIN）。
//     POS 自己驗 → 需要一個獨立 secret，env: POS_MEMBER_PIN_PEPPER
//     驗證對象係 Ledger 顧客帳號（8 位數字），唔係 merchant_staff。
export async function verifyMemberCredentials(
  merchantId: string,
  account: string,   // 8 位
  pin: string,       // 4 位
): Promise<{ ok: true; customerId: string } | { ok: false; reason: "bad_credential" | "locked" | "rate_limited"; retryAfterSec?: number }>
```

**驗證機制 —— 已由契約 §4.5 拍板 ✅**（2026-09-13 夜補查，唔再需要 J 決策）：

| 選項 | 做法 | 結論 |
|---|---|---|
| A-1 | 打 Ledger 專用 RPC 驗 | ❌ **不存在**。契約 §4.5 明文：「**沒有** `login`／`verify_pin`／`check_phone` Postgres RPC」 |
| A-2 | POS 自己存顧客密碼 hash | ❌ **不可行** —— POS 冇顧客密碼 hash，亦冇 `service_role` |
| **A-3** | 同店員登入**同一套** Auth：`signInWithPassword(ledgerAuthEmail(phone), deriveLedgerAuthPassword(phone, pin, AUTH_PIN_PEPPER))` | ✅ **這就是 Ledger 官方指定做法**（契約 §4.5.1／§4.5.2） |

**A-3 詳解**（契約 §4.5 原文對齊）：

```ts
// Ledger 顧客 auth email = normalizePhone(phone) + "@phone.macau-ledger.app"
// 密碼 = HMAC-SHA256(key=AUTH_PIN_PEPPER, msg=normalizePhone(phone)+":"+pin).hex  ← 64 字小寫
// → POS 用**獨立** supabase client（persistSession:false）signInWithPassword
// → 成功 = 顧客身份確認，並拿到顧客 access_token（線 B / §5.11 自讀要用）
```

契約 §4.5.2 逐條對應我哋要做嘅事：

| 步驟 | 契約要求 | 我方落點 |
|---|---|---|
| 1 | 顧客喺掃碼頁／Kiosk 輸入**電話 + PIN**（PIN 只到 POS 後端） | `member-login-sheet.tsx` → `POST /api/ledger/member-login` |
| 2 | POS 後端用 server env 算密碼；**若現有店員 route 硬查 `merchant_staff`，另開顧客 route，勿改壞店員登入** | **另開** `api/ledger/member-login/route.ts`（**唔改** `api/ledger/login`） |
| 3 | Server `auth.signInWithPassword({email, password})`（Ledger URL + anon） | route 內 |
| 4 | 將 `access_token`／`refresh_token` 回前端；`setSession` 到 **Ledger** supabase-js | ⚠️ **Kiosk 需要第二個 supabase client**（契約 §4.5.0 明文） |
| 5 | **跳過** `merchant_staff` 檢查 | 一定唔可以照抄店員 route 嘅 `merchant_staff` 查詢 |
| 6 | 按需讀 §5.11（本店餘額／積分／卡包） | 取代現有 `lookupCustomerWallet()`（後者走**店員** session） |

🔴 **三個必守**：
- **`AUTH_PIN_PEPPER` 必須同 Ledger 同值**（同 UAT／正式環境都要對）。契約 §4.5.3 明列「pepper／UAT↔正式混用 → 失敗」。
- **帳號 = 電話**（`normalizePhone` 去非數字取後 8 位、`/^\d{8}$/`、**不加 `+853`**）。確認稿 S1/S2 寫「帳號」，**UI 文案應改為「手機號碼」**。
- **失敗一律「密碼錯誤」**（帳號唔存在／未設 PIN／PIN 錯 三者唔可分），限流 **15 分鐘 5 次鎖 15 分鐘** → 正好對應確認稿 S3。

#### (2) 新建 `src/app/api/ledger/member-login/route.ts`

```ts
POST /api/ledger/member-login
body: { account: string, pin: string, storeId: string }
resp: {
  ok: true,
  member: { customerId: string; displayName: string; balanceAvos: number; giftBalanceAvos: number }
} | { ok: false, code: "bad_credential"|"locked"|"rate_limited", retryAfterSec?: number, remainingAttempts?: number }
```

要點：
- **限流**：帳號維度 5 次 / 15 分鐘（複用 `src/lib/pos/rate-limit.ts`）→ 超限回 `locked` + `retryAfterSec`（對應 S3 鎖定畫面）；
- **統一錯誤文案**：帳號唔存在 / PIN 錯 **一律回 `bad_credential`**（唔可以分辨，防帳號枚舉）；
- **回傳欄位收窄**：**只回 `customerId` / `displayName` / `balanceAvos`**，**唔可以回電話**（§7.2 個資紅線 + 確認稿 S5 只顯示餘額氣泡）；
- 🔴 **唔可以**回 `access_token` 落瀏覽器（顧客 token 只准 server 側持有，線 B 獨立處理）。

#### (3) `src/lib/use-kiosk-order.ts` —— 加會員 state

新增 state（**全部係 Kiosk + 掃碼共用**，放喺 core）：

```ts
// ── 會員狀態（2026-09-13 會員登入 + 付款流程）──
// 🔴 §7.2 個資紅線：displayName / balance 只准當次 UI 渲染，
//    禁落 POS DB / localStorage / analytics / console。
const [member, setMember] = useState<OrderingMember | null>(null);
const [memberLoginOpen, setMemberLoginOpen] = useState(false);
const [payMethod, setPayMethod] = useState<"balance" | "counter" | null>(null);
// 免 PIN 窗口：登入成功起算 180s（Ledger 完全唔驗 PIN → 只有 POS 實作）
const [pinFreeUntil, setPinFreeUntil] = useState(0);
```

`OrderingMember` 型別（**唔放落 `types.ts`，因為唔可以持久化**）：

```ts
/** 只在記憶體存在嘅會員會話（禁持久化）。 */
export interface OrderingMember {
  customerId: string;
  displayName: string;
  balanceAvos: number;
  giftBalanceAvos: number;
}
```

新增動作：

```ts
loginMember(account, pin): Promise<boolean>   // 打 /api/ledger/member-login
logoutMember(): void                           // 清 member + payMethod + pinFreeUntil
choosePayMethod(m): void                       // "balance" | "counter"
confirmMemberDeduct(): Promise<boolean>        // 打 applyPosDeduct（server 側）
```

`placeOrder()` 改動（L599 `buildKioskOrder()` 前後）：
- 落單物化時**唔寫**任何 member 欄落 order（線 A 階段，避開 P4）；
- 若 `payMethod === "balance"`：落單成功後**再**打扣款（順序 = 先落單後扣款，因為扣款要用 `posOrderId` 做冪等鍵，見 §3.1）；
- 扣款成功 → `setSubmittedOrder` 帶 `memberDeductTxnId`（**只存記憶體**，唔 sync）。

`returnToHome()` 改動（L752）—— **歸零硬重置三件事**（對應 S12T）：
```ts
setMember(null);
setMemberLoginOpen(false);
setPayMethod(null);
setPinFreeUntil(0);
//（原有清 cart / submittedOrder / started / ordering / clearQuickScanLastOrder 保留）
```

#### (4) 新建 `src/components/member-login-sheet.tsx`

- 共用元件，`variant="kiosk" | "mobile"`：
  - `kiosk` → 大觸控鍵盤（S2T），鍵 ≥ 64px（確認稿用 76px）；
  - `mobile` → 系統鍵盤（S2）。
- 帳號 8 位 / PIN 4 位，統一錯誤文案，剩餘次數提示，鎖定倒數。

#### (5) 新建 `src/components/member-pay-sheet.tsx`

- 付款方式（S6 / S6T）：扣餘額 / 到前台支付；
- 餘額不足態：**唔顯示**「先扣餘額差額到櫃檯補」（S6T 明寫 Kiosk 唔支援）→ 只顯示餘額 + 「改為到前台支付」；
- 確認扣款（S7）：需 PIN / 免 PIN（`登入後 180 秒內` + `X 分 Y 秒前` 文案）；
- 結果（S8）+ 異常（S9）。

#### (6) `src/app/order/page.tsx` 改動

- Landing（L177-191）→ 加「你是會員嗎？」＋ 兩顆同等份量掣（是／不是）；
- 倒數由 5s → **15s**（S11T）；確認稿 S1T/S2T 右上角倒數用**現有 60s**；
- 成功頁：會員 + 扣餘額 → 顯示 `txn_*`；否則顯示「請到前台付款」；
- 快餐取餐號大字保留。

#### (7) `src/components/scan-order-page.tsx` 改動

- Landing 加會員問句（S1 手機版）；
- 快餐成功頁（L187-235）加會員扣款結果分支（S11 顯示 `自取07`，**手機端冇倒數** —— 現狀已符合）；
- 堂食（`!quick`）**唔加**倒數（S1 手機不倒數）。

---

## 3. 線 B：掃碼自助 quote/commit（獨立分期）

> **暫不開工**，僅記錄落點，避免將來重複調研。

### 3.1 P1–P4 攔截點

| # | 問題 | 解法 | 前置 |
|---|---|---|---|
| **P1** | 冪等鍵對齊（防雙扣） | Ledger 固定 `scan-debit:{merchantId}:{posOrderId}`；POS 必須**同一 `posOrderId` 只 commit 一次**；未 commit 嘅 quote 唔佔冪等鍵；已 commit 必須換新 `posOrderId`；取消後**唔可重用** | 已有 `draftOrderIdRef`；但要確認**取消路徑**亦換 id |
| **P2** | 伺服器端核價 | Ledger **完全唔核價** → POS `/api/.../commit` 必須由 server 用**自己 DB 嘅 order total** 覆核，唔可以用 client 傳嘅金額 | 需新建 server 端計價 |
| **P3** | 免 PIN 窗口 | Ledger 唔驗 PIN → 180s 窗口**只有 POS 實作**，需 server 側記時（唔可以信 client 時間） | 線 A 已建 `pinFreeUntil`，線 B 要搬去 server |
| **P4** | `pos_orders` / `/api/pos/sync` 無 member 欄 | migration 加 `member_customer_id` / `member_deduct_avos` / `member_deduct_txn_id`；`/api/pos/sync` 白名單要收 | migration 0038 |

### 3.2 Ledger 側待確認（docs/129 §7）

1. 契約 §5.12 全文（`already_debited` 是否存在）
2. Q2 前綴語義自相矛盾
3. `already_debited` 錯誤碼
4. Q13 掃碼預付單 commit 後嘅訂單狀態（與 docs/122 §4.4 衝突）

### 3.3 我方待拍板（docs/129 §8）

1. 掃碼預付單 commit 後狀態
2. 是否移除「返結」掣
3. env 命名（`POS_SCAN_DEBIT_SECRET` / `LEDGER_SCAN_DEBIT_URL`）

---

## 4. 分期交付建議

| 期 | 內容 | 覆蓋確認稿 | 前置 |
|---|---|---|---|
| **A1** | 顧客會員登入（API + sheet）→ Kiosk + 手機 | S1 S1T S2 S2T S3 | Ledger §4.5 或 A-3 方案拍板 |
| **A2** | 下單頁會員氣泡 + 付款方式 + 扣款確認 + 結果 | S4 S5 S6 S6T S7 S8 S9 | A1 |
| **A3** | 快餐全套 + 倒數（Kiosk 15s / 手機無）+ 歸零硬重置 | S10 S11 S10T S11T S12T | A2 |
| **B1** | `scan-debit` client + HMAC + quote 倒數 | （線 B） | Ledger §5.12 / Q2 |
| **B2** | P2 伺服器核價 + P4 migration | （線 B） | B1 |
| **B3** | P1 冪等鍵 + P3 server 免 PIN + 鎖單 | （線 B） | B2 |

---

## 5. 需要 J 拍板（開工前）

| # | 問題 | 狀態 |
|---|---|---|
| ~~內1~~ | ~~顧客會員登入驗證走邊條路~~ | ✅ **已解答** —— 契約 §4.5.1／§4.5.2 指定 = 同店員同一套 Auth（方案 A-3），**另開顧客 route** |
| ~~內2~~ | ~~`AUTH_PIN_PEPPER` 是否同值~~ | ✅ **已解答** —— 契約明文「與 §4.1–§4.2 同一顆 `AUTH_PIN_PEPPER`」；但 **J 仍需確認 Vercel env 實際已配**（契約 §4.5.3：pepper／UAT↔正式混用 = 失敗） |
| **內3** | 扣款結果**唔落庫**（只 UI 顯示）可否接受？ | ⚠️ **我撤回原建議 → 應改為「必須落庫」**（理由見 §7，涉及重複收錢風險）；待 J 確認 |
| **內4** | Kiosk 成功頁倒數秒數 | J 2026-09-13：「**5 秒、15 秒太長**」→ 待定具體值（建議 **3 秒**） |
| ~~內5~~ | ~~會員扣款後，Kiosk 訂單狀態~~ | ✅ **J 拍板：轉 `paid`**（＝採納 Ledger Q13「扣款成功即可出廚」）；⚠️ 副作用見 §7.2 |
| ~~內6~~ | ~~UI 文案「帳號」vs「電話」~~ | ✅ **J 拍板：就用「8 位數字」作為登入電話號，PIN 4 位數字**（UI 保留 8 位數字概念，唔加 `+853`） |

---

## 7. 🔴 2026-09-13 深夜補查：兩個必須記錄嘅事實

### 7.1 「扣款結果落庫」係咩 —— 我上一輪建議錯咗，要撤回

**背景**：Kiosk／掃碼落單會產生一張 `PosOrder`，本機存一份，同時經 `/api/pos/sync` 上雲
（Supabase `pos_orders`）。上雲係**逐欄顯式複製**（`src/app/api/pos/sync/route.ts:763-809`
嘅 `baseRecord`），**目前完全冇任何 member 欄位**。

| | ❌ 唔落庫（我上一輪嘅建議） | ✅ 落庫 |
|---|---|---|
| 放邊 | 只喺瀏覽器記憶體（`submittedOrder` state） | 本機 + 雲端 `pos_orders` |
| 重載頁面 | 消失 | 仍在 |
| **收銀機睇得到？** | 🔴 **睇唔到** | ✅ 睇到「會員已扣款」 |
| 客人到櫃檯 | 🔴 店員見單「未付款」→ **有可能再收一次錢** | ✅ 店員知已付 |
| POS ↔ Ledger 對帳 | 🔴 對唔上 | ✅ 對得上 |

→ **`/api/pos/sync` 唔係「白名單擋住」，而係 `baseRecord` 根本冇抄呢幾欄。**
→ 收銀機嘅返結會員扣款（`memberDeductionAvos`）**同樣冇上雲**（`pos-app.tsx:3867-3869` 只寫本機），
   即現時整個「會員扣款」資訊喺雲端都係空白。
→ **落庫 = 必須，唔係 nice-to-have。** 呢個令 **P4 由「可延後」升為「線 A 必須做」**（見 §3.1）。

### 7.2 J 拍板「轉 `paid`」嘅副作用 —— 要一齊守

`src/components/restaurant-daily-report.tsx:354-358` **實際實作**：

```ts
export function isSaleCountable(o: PosOrder): boolean {
  if (o.status === "refunded" || o.status === "partially_refunded") return false;
  if (o.status === "settled" || o.status === "paid") return true;   // ← 冇檢查 onlineOrderId！
  return false;
}
```

⚠️ **註解（L350-352）寫「線下 POS 單：只統計 settled」，但實作係 `settled || paid` 一律計** ——
**註解同實作唔一致**。即：**任何 `paid` 單都會計入營業額，唔理有冇 `onlineOrderId`**。

→ 所以實作時**必須**：
1. ✅ 會員扣款成功 → 轉 `paid`（錢真係收咗，計收入正確，同 J 拍板一致）
2. 🔴 **非會員（到前台付款）單一定唔可以轉 `paid`** → 否則**虛增營業額**
   （維持現行 `selfOrderAutoAccept` 分流：開 → `sent_to_kitchen`；關 → `draft`）
3. 🔴 轉 `paid` 要同時寫 `prepaidAmount = total`（令收銀機知「全額已預付」）
4. ⚠️ `isSaleCountable` 嘅註解同實作矛盾 —— **建議另開文件追（docs/113）**，
   但**今次唔改**（會影響全站報表口徑，唔屬本計劃範圍）

---

## 6. 實作備忘（踩坑）

- 🔴 **雙 client 鐵則**（docs/129 §6.2）：顧客驗證用嘅 supabase client **必須** `persistSession: false` 且**獨立實例**，否則會覆蓋店員 session → 整個 POS 壞掉。
- 🔴 **`posOrderId` 格式**：`kiosk-xxxxxxxx`（14 字）符合 Ledger 要求 `[A-Za-z0-9._:-]{8,128}` ✅。
- 🔴 **`posOrderId` 重用陷阱**（docs/129 §6.4）：取消後**唔可以**重用同一 id commit；已 commit 必須換新 id。
- 🔴 **`/api/pos/sync` 業務拒絕** 4xx `retryable:false`；基建 500 `retryable:true`。
- 🔴 新 code 唔應該直接叫 `useOrderingCore` → 一律 `useKioskOrder()` / `useScanOrder()`。
- ⚠️ `npm` 唔可以經 git-bash 跑 → `node node_modules/typescript/bin/tsc --noEmit`。
- ⚠️ 已有 ~34 個既有 lint error（非回歸）。
- ⚠️ **線 A 零新 env** —— 只用已有嘅 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
  `AUTH_PIN_PEPPER`（同店員登入共用同一顆 pepper，契約 §4.5 明文）。
  🔴 **`POS_SCAN_DEBIT_SECRET` 唔關線 A 事** —— 嗰個係**線 B**（v3.5 `scan-debit/quote|commit`
  嘅 HMAC secret），線 B 未實作。兩者唔可以混淆：
  | env | 用喺邊 | 線 A 要唔要 |
  |---|---|---|
  | `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Ledger 專案連線 | ✅ 已有 |
  | `AUTH_PIN_PEPPER` | 顧客／店員 PIN 派生密碼（§4.1/§4.5） | ✅ 已有（**要確認 Vercel 已配**） |
  | `POS_SCAN_DEBIT_SECRET` | **線 B** 掃碼自助扣款 HMAC 簽名 | ❌ **唔需要**（未實作） |

---

## 8. ✅ 實作狀態（2026-09-13 深夜完成線 A）

J 最終拍板：**必須落庫** / **Kiosk 成功頁 3 秒** → 條件齊，已落 code。

### 8.1 新增檔案

| 檔案 | 作用 |
|---|---|
| `src/lib/ledger/member-login.server.ts` | 顧客登入核心（§4.5）：HMAC `signInWithPassword` → **跳過 `merchant_staff`** → 讀 §5.11.1 `wallets` |
| `src/lib/ledger/member-login-limit.ts` (+9 test) | 15 分鐘 5 次鎖 15 分鐘，**帶狀態**（剩餘次數 / 解鎖秒數） |
| `src/app/api/ledger/member-login/route.ts` | **另開**顧客 route（唔改店員 `/api/ledger/login`）；雙維度限流 |
| `src/lib/ledger/member-pay.ts` (+13 test) | 純邏輯：冪等鍵 / 免 PIN 180s / `formatElapsed` / `mopToAvos` |
| `src/components/kiosk/member-login-sheet.tsx` | S1T / S2 / S2T / S3a / S3b |
| `src/components/kiosk/member-pay-sheet.tsx` | S6 / S6T / S7a / S7b / S9a / S9b |
| `supabase/migrations/0038_pos_order_member_fields.sql` | ⚠️ **待 J 手動跑** |

### 8.2 改動檔案

`use-kiosk-order.ts`（+12 state / +13 動作 / `placeOrder` 加扣款 / `returnToHome` **歸零硬重置** / i18n +60 詞）、
`use-scan-order.ts`（**只** expose 登入）、`order/page.tsx`（Landing 兩粒掣 / S8a·S8b 分流 / 倒數 5s→**3s**）、
`scan-order-page.tsx`（Landing / 會員氣泡）、`types.ts` + `pos/sync/route.ts` + `pos-order-mapper.ts`（member 三欄上落雲）。

### 8.3 🔴 實作期間捉到嘅真 bug（已修）

1. **限流鎖過期後舊失敗仍累加** → `lockMs < windowMs` 時客人解鎖後第一次失敗即刻再鎖 = 永遠解唔開。
2. `confirmDeduct` 傳錯參數（`customerId` 當電話）。
3. 🔴 **`retryDeduct` 原本重用 `placeOrder()`** → 會落**新單**（新 `order.id`）→ **新冪等鍵** → Ledger 唔會擋 → **真·雙扣**。改為只對 `submittedOrder` 重打。
4. **付款 sheet 開住時成功頁仍倒數** → 客人未撳「重試」就返主頁，扣款結果永遠冇人知（Ledger 冇 lookup API）。

### 8.4 🔴 範圍限制：掃碼（手機）**唔支援**自助扣餘額

契約 §4.5.0：扣費 RPC 檢查 `is_merchant_staff`；掃碼只有**顧客** JWT → **一定被拒**。
v1 = 「顧客揀、**收銀台店員**代扣」。所以手機端只做「登入 + 睇餘額」，付款到前台。
→ **確認稿 S6 嘅手機版扣餘額，實作上做唔到**；「顧客揀 → 收銀台代扣」要另開流程（**未做**）。
`use-scan-order.ts` 刻意唔 expose 付款 API，防止將來有人誤用。

### 8.5 驗證（全綠）

- `tsc --noEmit`：**0 error**
- `node --test "src/**/*.test.ts"`：**690 pass / 0 fail**（+22 新）
- `eslint`（13 個改動檔）：**0 error / 0 warning**

### 8.6 ⚠️ 未做 / 待 J

- **`migration 0038` 未跑**（本機冇 supabase CLI）→ 未跑前 route 會 42703 降級（訂單照上雲，只係冇 member 欄）
- **未做 runtime / 實機驗證**：需真人跑「Kiosk 登入 → 落單 → 扣款 → 睇 Ledger 有 txn → 收銀機見『已扣款』→ 3 秒返主頁」
- **未確認 `AUTH_PIN_PEPPER` 喺 Vercel 已配**（契約 §4.5.3：缺失 / 唔同值 = 100% 登入失敗）
- 掃碼「顧客揀 → 收銀台代扣」未做
