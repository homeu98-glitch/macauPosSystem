# 42 · 會員一次性同步顯示可行性調查（僅查詢）

> **日期**：2026-08-22  
> **性質**：**只查詢、不動代碼**。確認能否將該店所有會員一次性同步顯示於我哋嘅會員介面。  
> **結論先行**：**暫時唔可以**。現有 Ledger 契約只有「單一會員（按 8 位手機）查詢」RPC，**冇「列出該店全部會員」嘅 RPC**；要實現一次性同步，需要 Ledger 新建／白名單一個**分頁式 list RPC**（例如 `list_merchant_customers` / `list_merchant_members`），並解決 PII 快取限制。

---

## 1. 現有會員整合（已落地）真實結構

### 1.1 已實作嘅 RPC（POS 側 `src/lib/ledger/`）

| RPC | 來源 | 用途 | 輸入 | 輸出 |
|-----|------|------|------|------|
| `merchant_lookup_customer_wallet` | `members.ts:lookupCustomerWallet` | 查單一會員錢包 | `p_merchant_id` + `p_phone`（8 位） | 單一會員：`customer_id` / `display_name` / `balance_avos` / `gift_balance_avos` |
| `list_customer_reward_grants` | `rewards.ts` | 查某會員嘅券 | `p_merchant_id` + `customer_id` | 該會員嘅券陣列 |
| `list_redeemable_grants_for_customer` | `rewards.ts` | 查可用券 | 同上 | 可用券 |
| `merchant_apply_pos_txn` | `members.ts` | 扣／加餘額（寫） | `p_merchant_id` + `p_phone` + 金額 + `idempotency_key` | 交易 id / `balance_after` |
| `redeem_reward_grants` | — | 核銷券（寫） | — | — |

> 權威 RPC 白名單見 `docs/integration/ledger-client-api.md`（Phase 1 v2）。**該白名單全部係訂單相關 RPC，會員類 RPC 冇被列進去**（`merchant_apply_pos_txn` 仲被標註「記帳另議／禁止」，見 §5.5.3）。

### 1.2 會員 UI 現狀（`src/components/members-page.tsx`）

- **只係「輸入 8 位手機 → 查單一會員」**（debounce 300ms 後 call `lookupCustomerWallet`）。
- 明確寫死：「Phase 1 不支援 POS 代建帳號或現場充值；新會員請透過會員通 App 或 Ledger Web 註冊。」
- **完全冇會員列表／一覽頁**，更冇「列出全店會員」嘅 UI 或 call。
- `src/app/api/members/route.ts` 已 **410 Gone**（舊 mock 會員 API 廢棄），確認 POS 唔再本地存會員。

---

## 2. 有冇「列出全店會員」嘅 RPC？

**冇，現階段冇。** 證據：

1. `docs/integration/ledger-client-api.md`（權威）**冇**任何會員 list RPC。
2. `docs/integration/pos-member-system-requirements.md`（POS 提案）：
   - §3.1 MEM-001 明確係**開放問題**：「是否支援『模糊搜尋／列表分頁』（會員頁是否要 list RPC）？」——Ledger 仲未答。
   - §4 建議白名單：`list_merchant_customers`（**新建？，可 Phase 2**）——標住「新建？」同「Phase 2」，**即係仲未確定存在／未開放**。
3. `docs/32-salon-ledger-integration-requirements.md:29` 有 salon 側提案：`list_merchant_members(p_merchant_id, p_cursor) → { members:[...], next_cursor }`——**都係提案，未確認實裝**。
4. 全 repo grep `list_merchant_customers` / `list_merchant_members` 只得上述兩處文檔，**代碼內冇任何 call**。

---

## 3. 要「一次性同步全店會員」需要咩

假設 Ledger 提供咗分頁 list RPC（例如 `list_merchant_customers(p_merchant_id, p_limit, p_cursor)`），POS 側要：

1. **一次性拉取**（進會員頁嗰陣 call 一次，翻頁 cursor 拉晒），**唔可以** `setInterval` 輪詢（違反 ledger-client-api §6.5 禁 polling 鐵則）。
2. **分頁**：`p_limit` / cursor，店大（幾百～幾千會員）要 loop 拉幾頁 merge 入記憶體。
3. **PII 快取限制**（ledger-client-api §7.2）：電話／姓名**只可當次 UI 顯示**，**禁止**寫入 POS Supabase / `localStorage` / IndexedDB 長期快取。即係「同步顯示」可以（記憶體內 render），但**唔可以落地**做離線會員庫。
4. **權限**：RPC 內 `is_merchant_staff(p_merchant_id)` 守衛，只返該店會員。

---

## 4. 可行性結論

| 項目 | 結論 |
|------|------|
| 而家可以一次性同步全店會員？ | **唔可以**。只有單一手機查詢。 |
| 技術上可行？ | **可行**，但前提是 Ledger 新建／白名單一個分頁 list RPC。 |
| 要改動 POS 幾多？ | 中：新增一個 `listMerchantCustomers()`（類 `lookupCustomerWallet`），會員頁加「一覽」tab（記憶體內分頁 render，唔落地）。 |
| 法律／合約限制？ | PII 唔可持久化（§7.2）；禁 polling（§6.5）。 |
| 離線可唔可顯示全店會員？ | **唔可以**（PII 唔落地，離線就無資料）——呢點要同用家講清楚。 |

---

## 5. 建議下一步（待用家／Ledger 決定）

1. **向 Ledger 團隊確認** `list_merchant_customers`（或 `list_merchant_members`）RPC 嘅：簽章、分頁參數、回傳欄位（`phone` / `name` / `balance` / `points` / `tier`）、白名單開放畀 Web POS 與否。
2. 確認後，POS 側：
   - `src/lib/ledger/members.ts` 加 `listMerchantCustomers(merchantId, cursor)`；
   - `members-page.tsx` 加「會員一覽」tab（記憶體分頁，唔寫 localStorage）；
   - 保留現有「單手機查詢」做精準搜尋。
3. 若 Ledger 暫時唔做 list RPC：**維持現狀（單手機查詢）**，並喺會員頁清楚提示「請輸入會員手機查詢」。

> 本調查**未改動任何代碼**，純粹讀契約／文檔／現有 RPC 與 UI 得出結論。
