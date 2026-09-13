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
| **顧客會員登入 API** | `/api/ledger/login` 係**店員專用**（查 `merchant_staff`、簽 `posDeviceToken`、`loadMerchantGrants`）；`members.ts` 全走**店員單例 session**；`storage.ts` 無任何會員 session | **必須新建**（見 §3.2） |
| `pos_orders` member 欄 | 只有 `memberDeductionAvos` / `ledgerMemberPhone`（返結回滾用），**冇** `member_customer_id` / `member_deduct_txn_id` | 線 A 可**暫時唔落庫**（只 UI 顯示）；線 B 必須補 migration |
| `/api/pos/sync` 白名單 | 未收任何 `member_*` 欄 | 同上 |
| `scan-debit` client | 全 repo 零檔案 | 線 B |

---

## 2. 線 A：店員代扣（Kiosk 全流程 + 掃碼前台付）

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

**驗證機制（需要 J 拍板，見 §5 內1）**：

| 選項 | 做法 | 評價 |
|---|---|---|
| A-1（建議） | 打 Ledger RPC 驗（若 v3.4 §4.5 有提供） | 最乾淨，但要 Ledger 先俾 |
| A-2 | 複用 `deriveLedgerAuthPassword(account, pin, pepper)` 概念，POS 自己存 hash | **唔可行** —— POS 冇顧客密碼 hash |
| A-3 | 用 Ledger Auth：`signInWithPassword(ledgerAuthEmail(account), deriveLedgerAuthPassword(account, pin, pepper))` | ✅ **可行且推薦** —— 見下 |

**A-3 詳解**（推薦）：

```ts
// Ledger 顧客嘅 auth email = ledgerAuthEmail(phone) = `${normalizePhone(phone)}@phone.macau-ledger.app`
// 密碼 = deriveLedgerAuthPassword(phone, pin, pepper)
// → POS 直接用匿名 supabase client（**唔係店員 session**）signInWithPassword
// → 成功 = 顧客身份確認，並順手拿到顧客 access_token（線 B 將來要用！）
```

呢個做法**完全唔需要新 API**，只係要：
- 一個**獨立**嘅 supabase client（`persistSession: false`），唔可以污染店員 session（`getLedgerSupabaseClient()` 係單例 → 要另開）；
- `AUTH_PIN_PEPPER` env（`pin.server.ts` 已用呢個名；確認 POS 同 Ledger 用同一 pepper）。

> ⚠️ **風險**：`AUTH_PIN_PEPPER` 若 POS / Ledger 兩邊唔一致 → 100% 登入失敗。需 J 確認 env 同值（見 §5 內-新）。

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

| # | 問題 | 選項 |
|---|---|---|
| 內1 | **顧客會員登入驗證走邊條路**？ | (a) 用 Ledger Auth `signInWithPassword`（A-3，推薦，順手拿顧客 token）／(b) 等 Ledger 出 §4.5 專用 API |
| 內2 | `AUTH_PIN_PEPPER` 喺 POS 同 Ledger 係咪**同一個值**？ | 影響 A-3 可行性 |
| 內3 | 線 A 階段扣款結果**唔落庫**（只 UI 顯示）可否接受？ | 要落庫就即刻要 P4 migration |
| 內4 | Kiosk 成功頁倒數 5s → **15s** 確認？ | S11T 寫 13s→0 |
| 內5 | 會員扣款後，Kiosk 訂單狀態 = ? | 對齊 docs/122（維持 draft）／定 Q13（轉 paid） |

---

## 6. 實作備忘（踩坑）

- 🔴 **雙 client 鐵則**（docs/129 §6.2）：顧客驗證用嘅 supabase client **必須** `persistSession: false` 且**獨立實例**，否則會覆蓋店員 session → 整個 POS 壞掉。
- 🔴 **`posOrderId` 格式**：`kiosk-xxxxxxxx`（14 字）符合 Ledger 要求 `[A-Za-z0-9._:-]{8,128}` ✅。
- 🔴 **`posOrderId` 重用陷阱**（docs/129 §6.4）：取消後**唔可以**重用同一 id commit；已 commit 必須換新 id。
- 🔴 **`/api/pos/sync` 業務拒絕** 4xx `retryable:false`；基建 500 `retryable:true`。
- 🔴 新 code 唔應該直接叫 `useOrderingCore` → 一律 `useKioskOrder()` / `useScanOrder()`。
- ⚠️ `npm` 唔可以經 git-bash 跑 → `node node_modules/typescript/bin/tsc --noEmit`。
- ⚠️ 已有 ~34 個既有 lint error（非回歸）。
- ⚠️ 本機冇 `.env.local` → 新 env（`POS_MEMBER_PIN_PEPPER` 等）要人手喺 Vercel + Supabase 設定。
