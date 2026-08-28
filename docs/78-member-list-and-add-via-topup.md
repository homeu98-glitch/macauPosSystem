# 會員列表 +「充值即新增」(ensure-customer) 實作計劃

> **日期**：2026-08-28
> **關聯**：`docs/77-ledger-v3.2-integration-plan.md`（M5③）、`docs/integration/ledger-client-api.md` §5.6–§5.9
> **權威契約**：`docs/integration/ledger-client-api.md` **v3.2（2026-08-28）**
> **狀態**：✅ **已解鎖並落實**（落實記錄見 §5）
>
> ⚠️ **重要更正**：本檔早前標 ⛔ BLOCKED 係**我方誤判**，唔係 Ledger 未定稿。原因：本 repo 嘅契約副本
> 仍係 v2（2026-08-11），而 Ledger 權威檔 `pos-ledger-client-api.md` 同短清單 `pos-v3.2-partner-handover.md`
> 只喺 **Ledger private repo**，本 repo 根本搜唔到。Ledger 2026-08-28 確認：兩個接口**均已在線**。

---

## 0. 現狀盤點 + Ledger v3.2 確認結果

### Q1 — 會員頁「全店會員」？
**結論：唔做「無輸入自動載入全店」；改做「搜尋式分頁列表」——呢個係 v3.2 唯一合約合規做法。**

**Ledger v3.2 確認（`list_merchant_customers`，§5.7）：**

- **唔係新建 RPC**：自 migration `20260530160000` 已喺 DB；Ledger Web `/merchant/reports/users` 日常使用。
  v3.2 只係將佢**列入 POS 白名單**，並加 `paid_balance_avos`／`gift_balance_avos`（migration `20260828120000`）。
- 店員**唔好傳** `p_merchant_id`（傳咗會 `not admin`）。
- `p_search` **必須非空**（≥2 字或完整 8 位電話）；`p_page_size ≤ 50`；一次一頁。
- `balance_avos` **已係 paid+gift 合計**，**唔好**再 `balance + gift`。
- 全店人數 → `get_merchant_report_summary.member_count`（**省略 `p_merchant_id`**），**唔好**用空搜尋 `total`。

**「無輸入自動載入全店」仍然唔可行**，但原因唔係「冇接口」，而係**契約刻意禁止**：

- 禁止進頁 dump 全店、禁止空搜尋當一覽；
- PII §7.2 禁止電話／姓名落 POS DB / `localStorage` / IndexedDB → 「全店會員庫」本質違約，離線亦無資料；
- 要瀏覽全店名單 → 用會員通 Web `/merchant/reports/users`。

現狀：`src/components/members-page.tsx` manage tab 只有單筆 8 位電話 lookup；`member-list.ts` **未建**（本輪建）。

### Q2 — 充值即完成新增會員（Ledger 概念「新增」）？
**結論：分流邏輯不變，但 `ensure-customer` 係 Ledger **已上線**嘅 HTTP；POS 唔使等新 RPC，亦唔好自製同名本體。**

- 現有充值（Task #8 已做）只接**已註冊**會員：走 `applyPosTopup`（`merchant_apply_pos_txn(topup)`）。
- 分流（v3.2 §5.9）：
  ```
  lookup(merchant_lookup_customer_wallet)
    registered=true  → client 直連 merchant_apply_pos_txn(p_type:"topup")   ← 已做 #8
    registered=false → POS 伺服器 POST
                       https://membership-uat.macau-tech.com/api/integration/pos/ensure-customer
                       Authorization: Bearer <店員 Ledger access_token>
    ⛔ 禁 p_type = "add"
  ```
- **POS 唔好**再做一條 `/api/integration/pos/ensure-customer` 當 Ledger 本體；只做**薄轉發**
  （校驗＋限流＋轉發到 Ledger），見 §2‑B。
- 未註冊建檔後，**顧客自行**到會員通 `/wallet/login` 設 PIN；POS 唔幫設 PIN。

---

## 1. 分流邏輯（你描述嘅流程，正好係契約指定）

使用者輸入 8 位會員號碼 + 充值金額 → 撳「充值」：

1. 先 `merchant_lookup_customer_wallet(phone)`。
2. **`registered=true`** → 直接 `applyPosTopup(phone, amountAvos, idempotencyKey)`（已實作，#8）。
3. **`registered=false`** → 呢個就係 Ledger「新增」：browser 打 POS 自己嘅**薄轉發**
   `POST /api/ledger/ensure-customer` `{ merchantId, phone, displayName?, amountAvos, idempotencyKey }`。
   - POS 伺服器帶店員 Ledger Bearer token **轉發**到
     `https://membership-uat.macau-tech.com/api/integration/pos/ensure-customer`（**Ledger 本體，已上線**）。
   - 建檔業務邏輯**全部喺 Ledger**；POS 只做校驗＋限流＋轉發，**唔**自製本體。
   - 成功後顧客到會員通 `/wallet/login` 自設 4 位 PIN 即可用（餘額已在）；POS 唔幫設 PIN。
4. 成功 → 刷新錢包 + 券（`lookupCustomerWallet` + `listCustomerRewardGrants`）。

> 即「充值」一個掣同時 cover 已註冊充值 同 未註冊新增+首充；靠 `registered` 分支自動揀。

---

## 2. 實作計劃

> ✅ **已解鎖**（2026-08-28）：Ledger 確認 `list_merchant_customers` 同 HTTP `ensure-customer` **均已在線**，
> 契約已轉錄進 `docs/integration/ledger-client-api.md` §5.6–§5.9（v3.2）。以下 A / B / C 已按此落實。

### A. 會員列表（搜尋式 · **v3.2 唯一合規做法**）

- **新 `src/lib/ledger/member-list.ts`**：`listMerchantCustomers({ search, page })` 封裝 `list_merchant_customers`：
  - 省略 `p_merchant_id`（契約 §1）；`p_search` 必須非空（≥2 字或完整 8 位電話，call 前校驗，唔允空）。
  - `p_page_size = 50`；`p_page = page`。
  - 回傳 `{ customers: LedgerCustomerSummary[]; total: number; hasMore: boolean }`（`total` 只係當次搜尋筆數，唔當全店總數）。
- 類型 `LedgerCustomerSummary`：`walletId` / `customerId` / `phone`（render-only，唔落 storage）/
  `displayName` / `nickName` / `balanceAvos`（**已係 paid+gift 合計，唔好再加 gift**）/
  `paidBalanceAvos` / `giftBalanceAvos`。
- **`members-page.tsx` manage tab 改造**：
  - 搜尋框（≥2 字或 8 位電話）→ 撳「搜尋」/數字鍵盤 confirm → `listMerchantCustomers`。
  - 結果列表（分頁 `hasMore` → 「載入更多」）；每列顯示姓名 + 尾 4 位 + 餘額。
  - 揀中一筆 → 展開現有 detail（錢包 + 券 + 充值 section）。
  - **唔寫 localStorage**（PII 規則）；只 in-memory state；離線提示。
- **保留**原有「輸入滿 8 位 → 直接 lookup 單筆」嘅精準路徑（結帳最快），**額外**提供 ≥2 字模糊搜尋列表。

### B. ensure-customer 薄轉發（M5③ · Ledger HTTP **已上線**）
- **新 `src/app/api/ledger/ensure-customer/route.ts`**（**薄轉發，唔係 Ledger 本體**；沿用
  `src/app/api/ledger/login/route.ts` 嘅 rate-limit + 錯誤 JSON 模式）：
  - browser 打 **POS 自己**嘅 route（`/api/ledger/...` 前綴，明確係 POS 端），**唔直接打 Ledger**。
  - 讀 `Authorization: Bearer <店員 Ledger access_token>`（由 `getLedgerAccessToken()`）。
  - 校驗 body：`merchantId`、`phone`（8 位）、`amountAvos`（>0）、`idempotencyKey`（**有金額必填**）。
  - 限流：**每店 / 每操作者 15 分鐘 30 次**（in-memory bucket；禁 `setInterval` / 背景 tab 連打）。
  - **轉發**到 Ledger 本體：
    `POST ${LEDGER_INTEGRATION_BASE_URL}/api/integration/pos/ensure-customer`
    （base 由 env 控制；預設 UAT `https://membership-uat.macau-tech.com`，正式換 `membership.macau-tech.com`）
  - 回傳：pass-through Ledger JSON + HTTP status；連線失敗回 `{ ok:false, error, status: 502 }`。
- ⛔ **唔好**喺 POS repo 實作建檔邏輯當 Ledger 本體；只係校驗＋限流＋轉發。
- 注意：日常充值**唔好**打呢條（`registered=true` 用 `applyPosTopup` client 直連 RPC）。

### C. 前端「充值即新增」分支
- **`members-page.tsx` `handleTopup`** 改造：
  - lookup → `registered=true` → `applyPosTopup`（現有）。
  - `registered=false` + `amount>0` → call client wrapper `ensureCustomer`（→ `POST /api/ledger/ensure-customer`）；成功刷新 wallet+grants；提示「已為新會員建檔並充值」。
  - `registered=false` + `amount=0` → 提示「請輸入充值金額以新增會員」（唔靜默代建無餘額）。
- **新 `src/lib/ledger/ensure-customer.ts`**：client 包 `ensureCustomer({ merchantId, phone, displayName?, amountAvos, idempotencyKey })`，帶 Bearer token 打上述路由，友好錯誤（`friendlyLedgerMemberError`）。

### D. 驗收
- `npx tsc --noEmit`：0 錯（除已知 layout.tsx 誤報）。
- UAT（先 UAT `membership-uat.macau-tech.com`）：
  - 用未註冊 8 位測試號（夥伴自備）→ 充值即新增 + 首充成功 → 到 `/wallet/login` 自設 PIN。
  - 搜尋式列表：≥2 字搜尋返回分頁結果；空搜尋被拒。
  - 限流：同一店/操作者 15 分內第 31 次被拒（429）。

---

## 3. 新增 / 修改檔案
- **新** `src/app/api/ledger/ensure-customer/route.ts`（POS 薄轉發 → Ledger HTTP）
- **新** `src/lib/ledger/member-list.ts`（`list_merchant_customers` 封裝）
- **新** `src/lib/ledger/ensure-customer.ts`（client wrapper）
- **改** `src/components/members-page.tsx`（manage tab：搜尋式列表 + 充值即新增分支）
- **改** `docs/integration/ledger-client-api.md`（v2 → v3.2；新增 §5.6–§5.9 會員契約）
- **改** `docs/integration/pos-member-system-requirements.md`（移除「新建？」誤導標註）
- **改** `docs/77`（§8 加本計劃狀態）

## 4. 待確認
1. ~~**Q1 方向**~~ ✅ **已解決（2026-08-28）**：Ledger 確認做「搜尋式分頁」（§5.7）。
   「無輸入全店一覽」係**契約禁止**（非技術限制）；要睇全店名單去會員通 Web `/merchant/reports/users`。
2. ~~**ensure-customer 上游**~~ ✅ **已解決（2026-08-28）**：Ledger HTTP 已上線
   `https://membership-uat.macau-tech.com/api/integration/pos/ensure-customer`；POS 只做薄轉發。
3. **正式環境 base URL**：`LEDGER_INTEGRATION_BASE_URL` 由 UAT 換正式域名（待用家確認確切域名）。
4. **UAT 聯測**：店主 `60000001`／PIN `1111`；會員 `60000003`。

---

## 5. 落實記錄（2026-08-28）

| 檔案 | 內容 |
|------|------|
| **新** `src/lib/ledger/member-list.ts` | `listMerchantCustomers({search,page})`、`isValidMemberSearch()`、`MEMBER_LIST_PAGE_SIZE=50`。**唔傳 `p_merchant_id`**；`p_search` call 前校驗非空；兼容 array / `{items,total}` 回傳形狀；`balanceAvos` 直接用（唔加 gift） |
| **新** `src/lib/ledger/member-types.ts` → `LedgerCustomerSummary` | `walletId`/`customerId`/`phone`/`displayName`/`nickName`/`balanceAvos`/`paidBalanceAvos`/`giftBalanceAvos`；註明 balance 已合計 + PII 禁落地 |
| **新** `src/app/api/ledger/ensure-customer/route.ts` | POS **薄轉發**（唔係 Ledger 本體）：Bearer 憑證 → 參數校驗（8 位電話、avos 正整數、有金額必填 idempotencyKey）→ 限流 30/15min/店/IP → 轉發 `${LEDGER_INTEGRATION_BASE_URL}/api/integration/pos/ensure-customer`，pass-through status/JSON |
| **新** `src/lib/ledger/ensure-customer.ts` | client wrapper：帶 `getLedgerAccessToken()` 打 `/api/ledger/ensure-customer`，錯誤經 `friendlyLedgerMemberError` |
| **改** `src/components/members-page.tsx` | ① 新增會員搜尋列（≥2 字）+ 結果列表（電話尾 4 位遮罩、餘額、載入更多）+ `pickFromList()` 帶入精準 lookup；② `handleTopup()` 改一掣兩分支（registered→`applyPosTopup`／未註冊→`ensureCustomer`）；③ 未註冊顯示「建檔並充值」面板；④ 共用 `topupControls` |
| **改** `docs/integration/ledger-client-api.md` | v2 → **v3.2（2026-08-28）**；新增 §5.6 lookup／§5.7 `list_merchant_customers`／§5.8 `merchant_apply_pos_txn`／§5.9 `ensure-customer` HTTP；修正 §5.5.3（apply_pos_txn 已轉白名單） |
| **改** `docs/integration/pos-member-system-requirements.md` | §4 加「v3.2 已定稿」註 + v3.2 狀態欄，移除「新建？」誤導 |
| **改** `docs/77` | 狀態解除 DEFER；§2／§4／§8 補完成記錄 |

**驗證**：`npx tsc --noEmit` → 0 錯（只餘已知 `layout.tsx` `LayoutProps` false positive）；
`npx eslint` 改動檔 → 0 problems。

**未做 / 注意**：

- 正式環境要設 `LEDGER_INTEGRATION_BASE_URL=https://membership.macau-tech.com`（預設係 UAT，需確認確切域名）。
- `ensure-customer` 嘅 `displayName` 為可選欄，前端暫未加輸入框（需要時再補）。
- UAT 實機聯測未跑。
