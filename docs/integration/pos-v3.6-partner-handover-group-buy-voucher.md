# 給 Macau-Ledger 的 v3.6 團購券掃碼核銷交接（可直接轉貼）

> **對象**：Macau-Ledger 維護者
> **日期**：2026-11-05
> **現行契約**：`docs/integration/pos-ledger-client-api.md` **v3.5**（2026-09-12）；本文是**增量需求**，未確認前以 v3.5 為準
> **POS 端狀態**：會員頁／支付頁「一個掃碼掣認會員＋核銷優惠券（`rc_`）」已完成；掃到 `gb_` 會**明確提示不支援、不嘗試任何 RPC**（fail-closed）
> **不是**：改 `orders` 狀態機、改 `reward_grants`／`group_buy_vouchers` 表結構、加 polling、POS 開 Ledger Web、POS 直讀 Ledger 表

---

## 一句話

Ledger 的 `redeem_group_buy_voucher(p_code text)` 在 DB **已經寫好、已授權 `authenticated`、Web 商戶頁已在使用**，只係**未寫入雙方整合契約白名單**。請 Ledger 出一份 v3.6 契約更新（純文件，零 migration）把這條 RPC 納入白名單；如要讓 POS 在「確認核銷」彈窗顯示券名／金額／到期，請另外補一條**只讀** RPC（需 migration，可後補）。

---

## 0. 現況與證據

| 項目 | 位置 | 內容 |
|---|---|---|
| 團購券核銷 RPC | `supabase/migrations/20261104120000_group_buy_vouchers.sql:195-266` | `public.redeem_group_buy_voucher(p_code text) → jsonb`；`security definer`；`_reward_assert_staff(v_voucher.merchant_id)` 驗本店店員；`revoke all ... from public` ＋ `grant execute ... to authenticated` |
| QR 內容 | 同檔 `:142` ＋ `src/components/wallet/group-buy-voucher-detail.tsx:125` | code = `'gb_' || substr(replace(gen_random_uuid()::text,'-',''),1,20)`；客人 App 用 `RewardCouponQr code={voucher.code}` 直接把**純字串**畫成 QR（不是 URL、不是會員 token） |
| Web 商戶掃碼 | `src/app/merchant/reward-actions.ts:818-847`、`:897-942` | `merchantRedeemCoupon()` 先試 `redeem_reward`；**報錯且 code 以 `gb_` 開頭**才 fallback 到 `redeemGroupBuyVoucher()` → `redeem_group_buy_voucher` |
| 一般優惠券 QR | `20260604210000_reward_redemption_code_no_pgcrypto.sql:10-13` | `reward_grants.redemption_code` = `rc_` + 32 hex；走 §5.7.5 `redeem_reward` |
| 契約白名單 | v3.5 §1.1 寫 RPC 清單 | 只列 `merchant_apply_pos_txn`、`redeem_reward_grants`、「可選 `redeem_reward`（掃券 QR）」；**沒有** `redeem_group_buy_voucher` |
| 契約技術說明 | v3.5 §5.5.3 | 「白名單是**整合契約義務**…**並非** API gateway 強制封鎖。夥伴不得因『能呼叫』而擴張 scope」 |

👉 所以現在的狀態是：**技術上打得通，契約上唔打得**。POS 選擇遵守契約，主動 fail-closed，沒有偷打。

---

## 1. 需要 Ledger 做的事

### A. 必要：把 RPC 寫入 v3.6 白名單（純文件，**零 DB migration**）

RPC 本身不用改、不用重新部署 DB。建議在 `pos-ledger-client-api.md` 做以下 4 處更新，並同步 `docs/integration/` 的短清單（可新增 `pos-v3.6-partner-handover-group-buy-voucher.md`）：

| 位置 | 建議改動 |
|---|---|
| §1.1「寫 RPC（會員／券）」 | 改為：`merchant_apply_pos_txn`、`redeem_reward_grants`；可選 `redeem_reward`（`rc_` 券 QR）、**`redeem_group_buy_voucher`（`gb_` 團購券 QR）** |
| 新增 **§5.7.8 `redeem_group_buy_voucher`（可選）** | 簽章／回傳／錯誤／冪等語義，直接用下面第 2 節文字即可 |
| §9 上線前驗收清單 | 加一筆「團購券核銷｜POS 掃 `gb_` → 確認彈窗 → 本 RPC；`already_redeemed:true` 不重複入帳；電話不落地」 |
| §7.2 個資 | 補一句「本 RPC 回傳之 `customer_phone` 與 §5.7.5 同等級：僅當次 UI，禁寫 POS DB／localStorage／analytics／log」 |

> 同時請把雙方各自持有的契約副本一齊更新：Ledger `docs/integration/pos-ledger-client-api.md`、POS `docs/integration/ledger-client-api.md`。

### B. 建議（可後補，需 migration）：提供「由 code 只讀券資料」的 RPC

**問題**：POS 的核銷是不可逆寫入，所以必須先彈確認。但目前 Ledger **沒有**任何「由 `redemption_code`／`gb_` code 只讀券資料」的 RPC，POS 只能在確認彈窗顯示**遮罩券碼**（`rc_a1b2c3d…`），券名／面額／到期／所屬會員要等核銷成功回傳才看得到 —— 店員等於「唔知張券係乜就撳確定」。

建議新增一條只讀、同時覆蓋兩類券的 RPC（名稱由 Ledger 決定）：

```sql
preview_coupon_by_code(p_code text) → jsonb
```

| 回傳鍵 | 型別 | 說明 |
|---|---|---|
| `ok` / `found` | boolean | 找不到時回 `ok:false, reason:'not_found'`，**不要** raise exception（POS 要區分「冇呢張券」同「RPC 故障」） |
| `kind` | text | `'reward_grant'` \| `'group_buy'` |
| `merchant_id` | uuid | POS 可先比對本店，避免誤核銷 |
| `title` | text | 券名（團購券取 `title_snapshot`） |
| `description` / `image_url` | text \| null | 可選 |
| `amount_avos` | int \| null | 一般券：現金券面額；團購券：`paid_avos`（**客人已付金額，不是入帳**） |
| `prize_type` | text \| null | 一般券用；團購券固定 `'group_buy'` |
| `expires_at` | timestamptz | 到期 |
| `status` | text | `issued`／`active`／`redeemed`／`expired`／`refunded` |
| `customer_phone_masked` | text \| null | 例 `66****88`；**請不要回傳完整電話**給只讀路徑 |
| `usable` | boolean | 與真正核銷 RPC **同一套判定**（`_reward_grant_effective_expiry`／`status='active'`＋`expires_at`） |

**權限**：`_reward_assert_staff(merchant_id)`；`grant execute ... to authenticated`；`security definer`；`select ... for update` **不需要**（只讀）。

> ⚠️ **為何不請 POS 直接 `select public.group_buy_vouchers`**：migration `:48-63` 的 `group_buy_vouchers_staff_read` policy ＋ `grant select to authenticated` 技術上確實讀得到，但這會變成 POS **直讀 Ledger 資料表**（v3.5 §5.6 明確是「讀取 RPC 白名單」），亦要另外 join `profiles` 先有電話，等於把 RLS 細節耦合到 POS。POS 不打算這樣做，請以 RPC 為準。
>
> 若 B 不做：POS 維持現況（確認彈窗顯示遮罩碼），功能仍可上線，只是 UX 較弱。請在回覆中註明取捨。

### C. 可選：錯誤語義統一（不建議改簽章）

`redeem_reward` 對 `gb_` code 會在 `reward_grants` 撳唔到，raise `coupon not found`（`20261008140000_redeem_reward_receipt_fields.sql:33-35`），**沒有任何寫入**，所以 Web 靠報錯再 fallback 係安全的。POS 改用「按 `gb_` 字首直接分流」，結果等價但少一次無謂請求。**不需要**新增 `redeem_any_coupon` 包裝，兩條 RPC 分開反而更易稽核。

---

## 2. §5.7.8 建議契約文字（可直接貼）

```markdown
#### 5.7.8 `redeem_group_buy_voucher`（可選，v3.6）

**用途**：掃描會員 App「團購券詳情」QR 之 `group_buy_vouchers.code`（`gb_` 開頭）單張核銷；
與 Web 商戶頁「掃描優惠券」的 `gb_` fallback 同一條路徑。

**簽章**：

    redeem_group_buy_voucher(p_code text) → jsonb

- **沒有** `p_operator_id`；稽核一律用 `auth.uid()`（與 §5.7.5 `redeem_reward` 不同，後者仍須傳但 DB 已忽略）。
- `security definer`；`_reward_assert_staff(voucher.merchant_id)` 驗本店店員；顧客 JWT 不可呼叫。
- `grant execute ... to authenticated`；`revoke ... from public`。

**首次成功回傳**：

| 鍵 | 說明 |
|---|---|
| `ok` | `true` |
| `already_redeemed` | `false` |
| `voucher_id` | uuid |
| `title` / `description` / `image_url` | `*_snapshot` 欄位 |
| `expires_at` | 到期 |
| `paid_avos` | 客人**購入時已付**金額（avos）。**不是**本次入帳、不是贈送餘額，POS 收據／成功動畫不得顯示「贈送餘額 +MOP …」 |
| `customer_phone` | 完整電話，受 §7.2 個資約束 |
| `redeemed_at` | 核銷時間 |

**已核銷（`status='redeemed'`）**：回 `ok:true, already_redeemed:true`，連同
`voucher_id`、`title`、`redeemed_at`、`customer_phone`；**不含** `description`／`paid_avos`／`image_url`。
Client 必須把 `already_redeemed:true` 當「之前已用、本次沒有再核銷」，**不得**顯示為新成功入帳。

**錯誤（exception message）**

| 訊息 | 店員文案建議 |
|---|---|
| `code required` | 請重新掃碼 |
| `coupon not found` | 找不到這張券 |
| `coupon not usable` | 券已使用、已退款或無效 |
| `coupon expired` | 團購券已過期 |
| `not merchant staff` | 此券不屬於本店或無權限 |

**可否核銷**：`status='active'` 且 `now() <= expires_at`；`for update` 列鎖防止並發重複核銷。
核銷即時不可逆，呼叫端**必須**先彈確認、in-flight 鎖防連撳；禁止 polling 結果。
```

---

## 3. 測試資料怎麼生

| 方式 | 說明 |
|---|---|
| 正式路徑 | 會員用**該店儲值餘額**呼叫 `purchase_group_buy(p_group_buy_id uuid, p_request_id text) → jsonb`（migration `:68-190`），回傳 `code`（即 `gb_...`）；`p_request_id` 是 client 產生的冪等 request id |
| UAT 快速 | 直接 insert 一張 `public.group_buy_vouchers`，`status='active'`、`expires_at` 設未來、`merchant_id` 為測試店、`code='gb_test...'` |
| 前提 | `merchant_group_buys` 要有上架團購；測試帳號要係該店 `merchant_staff`，否則會 `not merchant staff` |

---

## 4. 建議雙方驗收清單

| # | 情境 | 通過標準 |
|---|---|---|
| 1 | 掃有效 `gb_` 券 | 先彈確認 → 確定後 1 次 RPC → 顯示券名／已核銷；DB `status='redeemed'`、`redeemed_by=auth.uid()` |
| 2 | 同一張再掃／連撳兩次 | 第二次 `already_redeemed:true`；UI 顯示黃色「之前已核銷」，**不顯示**綠色成功、不加餘額、不雙重寫入 |
| 3 | 過期券 | `coupon expired`，DB 狀態不變 |
| 4 | 別店券 | `not merchant staff`，DB 狀態不變 |
| 5 | 顧客 JWT（非店員） | 授權失敗，DB 狀態不變 |
| 6 | 亂碼 `gb_xxx` | `coupon not found`，fail-closed，不 fallback 去 `redeem_reward` |
| 7 | 個資 | `customer_phone` 只留在當次 UI 記憶體；Network 以外無 POS DB／`localStorage`／analytics／console log |
| 8 | 收據／成功動畫 | 團購券**不顯示**「贈送餘額」；Ledger Web 亦已有相同註記（`reward-actions.ts:813`「團購券（非 reward_grant），收據不顯示『贈送餘額』」） |
| 9 | 無多餘請求 | 不開 Ledger Web／Server Action；不 polling；不為確認而全量撳券列表 |

---

## 5. POS 端對接點（**我方負責，不需 Ledger 動手**）

白名單確認後，POS 只需改以下檔案，Ledger 不用出 code：

| 檔案 | 改動 |
|---|---|
| `src/lib/ledger/member-qr-client.ts` | `classifyScannedCode()` 已有 `groupBuy` 分支；移除 `UNSUPPORTED_GROUP_BUY_MESSAGE` 的攔截，改為回傳 `{ kind:'coupon', couponType:'group_buy' }` |
| `src/lib/ledger/rewards.ts` | 新增 `redeemGroupBuyByCode(code)` 包 `redeem_group_buy_voucher`；沿用既有 `friendlyLedgerMemberError()` 與店員 session |
| `src/components/members-page.tsx` | 確認彈窗／`handleScanConfirmRedeem()` 按券種分派；in-flight 鎖沿用 `scanRedeemBusy` |
| `src/components/coupon-redeem-success.tsx` | 團購券成功文案改為券名＋「已核銷」，**不顯示**「贈送餘額 +MOP …」 |
| `src/lib/ledger/member-qr.test.ts` | 補 `gb_` 分流與 `already_redeemed` 單測 |

若第 1B 項有提供只讀 RPC，POS 會**另外**在確認彈窗前多打一次 `preview_coupon_by_code`，把券名／面額／到期／所屬會員顯示給店員；這是唯一會新增的讀取，**每次掃碼 1 次，不做 polling**。

---

## 6. 紅線（沿 v3.5，請一併寫入 v3.6）

- **不可逆**：核銷即時生效、無沖正 RPC；確認彈窗＋in-flight 鎖是硬性要求，`already_redeemed` 不可當新成功。
- **個資 §7.2**：`customer_phone`／姓名只可當次 UI；禁寫 POS Supabase、`localStorage`／`IndexedDB`、analytics、`console.log`／error reporting 完整 payload。
- **身份**：只可用**店員** Ledger session；顧客 JWT 不得自核銷；POS 伺服器不得長期託管店員 token；不使用 `service_role`。
- **通道**：client 直連 Ledger Supabase RPC；禁開 Ledger Web／Server Action（§1.2 只豁免 §5.7.7 與 §5.12 兩條 HTTP）；禁 polling／`wallets` Realtime。
- **白名單即契約**：即使 PostgREST 技術上打得通（`grant execute` 範圍大於白名單），未列入 v3.6 前 POS 不會呼叫。

---

## 7. 上線次序與請回覆事項

1. Ledger 出 **v3.6 契約更新**（第 1A 項，純文件）→ 回覆版本號／commit。
2. POS 依第 5 節開 `gb_` 分支 → 雙方按第 4 節驗收。
3. 第 1B 項只讀 RPC **可獨立排期**，不卡第 1A 項上線。

**請回覆三件事**：
- (a) 是否同意把 `redeem_group_buy_voucher` 納入 v3.6 白名單（A 項）；
- (b) 是否提供 `preview_coupon_by_code` 只讀 RPC（B 項）；若提供，請給最終簽章與回傳欄位，POS 按此對接；
- (c) `paid_avos` 在收據／成功頁的呈現口徑是否如第 2 節所述「不得視為本次入帳」。

---

*本檔為單一交付檔案，可原檔轉發；所有行號指向 2026-11-05 時 Macau-Ledger 與 macauPosSystem 的本地工作副本。*
