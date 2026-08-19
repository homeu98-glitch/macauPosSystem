# 32 · Salon ↔ Ledger 對接需求文檔（給 Ledger 團隊）

> 日期：2026-08-19
> 背景：美容院 module（salon）已上線生產，會員／線上預約／套餐／產品需與 Ledger **全系統打通、統一會員系統**。
> 現狀：餐飲（POS）已接通 Ledger 會員錢包、線上下單、充值 SSO；salon 沿用同一套接入，但**預約制**與**積分／套餐／產品託管**有額外缺口。
> 目標：本文檔列出 Ledger 必須實作／擴充的接口，使 salon 功能完整。
> 約定：不動餐飲；salon 代碼位於 `src/app/salon/`、`src/components/salon/`、`src/lib/salon/`；離線優先（localStorage→IndexedDB→sync-queue）。

---

## 一、現狀摘要（餐飲已接通 vs salon 缺口）

| 能力 | 餐飲現狀（Ledger） | salon 缺口 |
|------|-------------------|-----------|
| 會員查詢 | `merchant_lookup_customer_wallet(p_merchant_id, p_phone)` 單筆 | **無批量讀取**；無法一次攞齊會員 |
| 會員餘額 / 等級 | `balanceAvos` + `giftBalanceAvos` + `tier`（salon 結帳扣餘額已可用） | 欄位穩定即可，無缺口 |
| 積分 / 忠誠度 | **無**（只有 reward grants 券） | salon 已實作 pointsPerDollar／生日倍率／推薦獎勵，**缺 points 欄位與增扣 RPC** |
| 線上交易 | `orders` 表 + `list_merchant_orders` + `useLedgerOrdersRealtime`（postgres_changes by merchant_id） | salon 係**預約制**，需 `bookings` 表 + 預約 API + realtime |
| 充值 | `POST /api/topup/owner-embed` 取 SSO embed URL（線上轉帳審核） | salon 已 reuse 同一 `MemberTopupPanel`，需確認通道對 salon 商戶可用 |
| 套餐 / 產品 | 餐飲 menu 經 Ledger 託管 + 同步 | salon 現全放本地 bootstrap，**未接 Ledger** |

---

## 二、具體需求清單

### R1 · 會員批量讀取（list all members）
- **為何需要**：salon 客戶檔案列表、報表、推薦獎勵候選、開單選會員下拉，都需一次攞齊全店會員；現只支援逐個 phone 查詢，無目錄。
- **建議接口**：
  - `list_merchant_members(p_merchant_id, p_cursor)` → `{ members: [{ phone, name, balanceAvos, giftBalanceAvos, points, tier }], next_cursor }`
  - 分頁沿用餐飲 `computeSyncCursor` 的 `{ since, sinceId }` 游標模式。
- **驗收**：salon 可不經逐筆 `lookup_customer_wallet` 撈齊會員。

### R2 · 積分 / 忠誠度系統
- **為何需要**：salon 已實作 `pointsPerDollar`（每店配比）、生日窗口倍率、推薦獎勵（只有推薦人得分）、推薦人連結；全部依賴會員 `points` 欄位。Ledger 現無 points。
- **建議接口**：
  - 會員加欄位 `points`（整數）、`tier`、`point_accrual_rules`（per-store `pointsPerDollar`、生日窗口 `month|week`、倍率）。
  - RPC：`get_member_points(p_merchant_id, p_phone)`、`award_member_points(p_merchant_id, p_phone, p_points)`（結帳賺分）、`redeem_member_points(p_merchant_id, p_phone, p_points)`（扣分抵現）。
- **驗收**：salon 結帳賺分 / 扣分到賬，餘額與積分分開計。

### R3 · 預約 / 預約下單 API（booking，非 order）
- **為何需要**：salon 係預約制 —— 客人經 Ledger 線上提早預約（指定服務、時間、師傅偏好、定金）。餐飲只有即時下單，無預約概念。
- **建議接口**：
  - 新增 `bookings` 表（或 `salon_bookings`），欄位對齊 salon `SalonBooking`：
    `merchant_id, source='online_ledger', customer_phone, customer_name, services[] (serviceItemId/name/price/durationMinutes), start_at, deposit_amount, deposit_paid, status, ledger_booking_id`。
  - RPC：`create_booking`、`list_merchant_bookings(p_merchant_id, p_cursor)`、`update_booking_status(p_booking_id, p_status)`。
  - `status` 枚舉與 salon 對齊：`pending → confirmed → checked_in → in_service → completed`（+ `cancelled` / `no_show`）。
- **驗收**：Ledger 手機端可落預約 → salon 即見。

### R4 · 線上預約 Realtime 推送 salon
- **為何需要**：商家要即時收到新預約，並於 `/salon/online` 確認、安排師傅。
- **建議接口**：realtime 訂閱 `bookings` 表 `merchant_id=eq.{merchantId}` 的 INSERT / UPDATE（**照搬餐飲 `useLedgerOrdersRealtime` 模式，只換表名**）。
- **驗收**：新預約即時出現於 salon「線上訂單」頁，狀態變更即時反映。

### R5 · 充值入口（top-up）
- **現狀**：餐飲經 `POST /api/topup/owner-embed` 取得 SSO embed URL（線上轉帳截圖審核），封裝於 `MemberTopupPanel`。salon 已 **reuse 同一組件** 作為客戶檔案「替會員充值」入口。
- **需求**：確認此 SSO top-up 通道對 salon 商戶同樣可用（同一 merchant 身份即可）。
  - 若 Ledger 打算提供直接充值 RPC，亦歡迎補 `topup_member_balance(p_merchant_id, p_phone, p_amount)` 以取代 iframe。
- **驗收**：salon 客戶檔案「替會員充值」能開到充值頁並成功充值。

### R6 · 套餐 / 產品 Ledger 為主 + 雙向同步
- **為何需要**：商家要在 Ledger 手機端設定套餐／產品（價格、內容、佣金率），salon POS 讀取並可售；參考餐飲 menu 同步模式，兩邊互通。
- **建議接口**：
  - Ledger 託管 `salon_packages` + `salon_products` 目錄（per merchant）。
  - RPC 讀寫 + realtime（沿用餐飲 menu 同步機制）。
  - salon 本地 bootstrap 的套餐／產品改為「由 Ledger 鏡像」：保留本地只讀 cache + 離線可用。
- **驗收**：Ledger 改套餐／產品 → salon 自動更新；salon 售賣扣減同步回 Ledger。

### R7 · 會員餘額 / 等級讀取（已有，確認即可）
- `merchant_lookup_customer_wallet` 已提供 `balanceAvos` + `giftBalanceAvos` + `tier`，salon 結帳扣餘額已可用。**確認欄位穩定、對 salon 商戶返回正確** 即可，無新需求。

---

## 三、salon 端預計改動（migration seam）

| 領域 | 現狀 | 接 Ledger 後 |
|------|------|-------------|
| 會員 | 本地 `mock-ledger` + 逐筆 lookup | 接 R1 批量 + R2 積分；保留本地 cache |
| 線上訂單 | `/salon/online` 頁已建，讀本地 mock | 接 R3 + R4 後改訂閱 Ledger realtime |
| 充值 | 已 reuse `MemberTopupPanel`（R5） | 確認通道可用即可 |
| 套餐 / 產品 | settings CRUD 寫本地 bootstrap | 接 R6 後鏡像 Ledger，本地只讀 cache |
| 結帳扣餘額 | 已可用 | 不變 |

> salon 代碼已保留接 Ledger 的 seam（localStorage 熱路徑 → IndexedDB → sync-queue → `/api/salon/sync`），真後端到位後切換 channel 即可，不需重寫 UI。

---

## 四、優先級

- **P0（阻塞 salon 核心上線）**：R3 預約 API + R4 預約 realtime + R5 充值通道確認。
- **P1**：R1 批量會員讀取、R2 積分／忠誠度。
- **P2**：R6 套餐／產品 Ledger 為主雙向同步。
- **R7**：確認即可，無開發量。

---

## 五、參考（餐飲已存在，salon 直接沿用）

- 會員錢包：`merchant_lookup_customer_wallet(p_merchant_id, p_phone)`
- 線上單讀取：`list_merchant_orders`（RPC，cursor `{since, sinceId}`）
- 線上單 realtime：`useLedgerOrdersRealtime`（Supabase `postgres_changes` on `orders`，`merchant_id=eq.{merchantId}`）
- 扣款：`merchant_apply_pos_txn`（RPC）
- 券 grants：`list_customer_reward_grants` / `redeem_reward_grants`
- 充值 SSO：`POST /api/topup/owner-embed` → `buildTopupOwnerEmbedUrl()`
- 詳見 `docs/integration/ledger-client-api.md` 與 `docs/26-beauty-salon-vertical.md`。
