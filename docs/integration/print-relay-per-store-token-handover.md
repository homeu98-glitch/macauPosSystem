# 中繼 APK 交接：per-store token（Realtime 憑證）第 3 階段

日期：2026-09-23
對象：**macauLedger / print-relay APK**（另一個 repo）
上游評估：`docs/reviews/per-store-token-assessment-2026-09-23.md`
相關 migration：`supabase/migrations/0051_*`、`0052_*`（已加性部署，對舊 APK 零影響）

---

## 0. 一句話

**只有 `pos_print_jobs` 一張表需要 APK 配合。** 其餘四張（`pos_orders` /
`pos_kds_item_state` / `pos_store_status` / `pos_online_order_settings`）
嘅 Realtime 消費者**全部係 web** ⇒ 可以先收口，**唔需要等 APK**。

### 訂閱矩陣（已由原始碼核對）

| 表 | 收銀台 web | 後廚 web | **中繼 APK** |
|---|---|---|---|
| `pos_orders` | ✅ | ✅ | ❌ |
| `pos_print_jobs` | ✅ | ❌ | **✅** ← 唯一要 APK 配合嘅 |
| `pos_kds_item_state` | ❌ | ✅ | ❌ |
| `pos_store_status` | ✅ | ❌ | ❌ |
| `pos_online_order_settings` | ✅ | ❌ | ❌ |
| `pos_soldout` | ✅ | ❌ | ❌（且**永久保留 anon** —— 匿名客人端讀）|

---

## 1. 為何 APK 一定要配合（唔可以「照舊」）

APK 而家用 `/pair` / `/pair-status` 攞到嘅 `SUPABASE_ANON_KEY` 訂 `pos_print_jobs`。
Supabase Realtime **只推「你 SELECT 得到」嘅行**；anon 身份冇 store claim。

- 一旦 `pos_print_jobs` 嘅 anon 政策被移除 ⇒ **APK 一個事件都收唔到**，
  而 channel 照樣 `SUBSCRIBED`、**零 error** ⇒ 靜默失效。
- 後果：出紙由「**1–3 秒**」退化成「等下一個 claim」——
  claim 節奏係 30→60→120→**180 秒**（冇 job 時退避），
  ⇒ **閒置一段時間之後嘅第一張單，最長要等 180 秒**。呢個係不可接受嘅退化。

> ⚠️ **唔可以**用「叫 server 縮短 `nextPollMs`」嚟繞過：就算縮到 15 秒，
> 都係由 1–3 秒退化成 ≤15 秒，仍然係退化。APK 更新係唯一保住即時性嘅路。

---

## 2. 為何唔急：可以分兩批收口

`0051` / `0052` 係**加性**（只加政策，唔刪 anon）⇒ 冇時序壓力。建議：

| 批次 | 表 | 需要 APK？ |
|---|---|---|
| **第 1 批（可即做）** | `pos_orders`、`pos_kds_item_state`、`pos_store_status`、`pos_online_order_settings` | ❌ 唔需要 |
| **第 2 批（等 APK）** | `pos_print_jobs` | ✅ 需要 |

⇒ **唔需要為咗 APK 而拖住整個項目。**

---

## 3. 機制（已定，唔需要任何密鑰）

Supabase 專案已用**非對稱簽名金鑰（ECC P-256）**，私鑰取唔出 ⇒ **唔可以自簽 JWT**。
所以改用 **Supabase Auth 簽發**，store 綁定寫入 **`app_metadata`**
（只有 service_role 寫得入，用戶改唔到）：

```sql
-- 0052 已部署（加性）
store_id = coalesce(
  auth.jwt() -> 'app_metadata' ->> 'store_id',   -- Supabase Auth 簽發路徑
  auth.jwt() ->> 'store_id'                      -- 自簽路徑（保留兼容）
)
```

---

## 4. APK 要改咩

### 4.1 取得 session（兩個選項，請同 APK repo 確認邊個可行）

| 選項 | 做法 | 評價 |
|---|---|---|
| **A（建議）** | APK 自己 `signInAnonymously()`（用 `/pair` 已回嘅 `supabaseUrl` + `anonKey`），取得 `role:"authenticated"` 嘅 JWT + refresh token | APK 自己管 refresh，最乾淨；需要 Supabase 專案**開啟 Anonymous sign-ins** |
| B | 由 POS server 用 Admin API 建立／取得 session，再把 `access_token` + `refresh_token` 交畀 APK | 唔需要開 anonymous sign-ins；但 server 要代管 refresh，較複雜 |

**開啟 Anonymous sign-ins 嘅位置**（2026-09 版本）：
`Dashboard → Authentication → Sign In / Providers` → 清單底部 **Anonymous Sign-Ins** → 開啟。
舊版選單可能喺 `Authentication → General configuration → User Signups → Allow anonymous sign-ins`。

### ⚠️ 開啟前必須知嘅副作用（已做預檢，確認安全）

官方明文：**匿名用戶攞嘅係 `authenticated` role**（唔係 `anon`）。所以一旦開啟，
**任何寫成 `to authenticated using (true)` 嘅政策會即刻對「任何人」開放**
——因為任何人都 call 得到 `signInAnonymously()`，唔需要 email／密碼。

✅ **本專案已預檢，確認冇風險**：掃過全部 migration + `tools/*.sql` 嘅生效區，
**冇任何既有 `to authenticated` 政策或 grant**（`pos_kiosk_settings` 嘅
`anon_all_*` permissive policy 已由 0016 §2 清走；`next_daily_sequence` 嘅
`anon, authenticated` execute 亦已由 0016 §4 回收）。
唯一嘅 `to authenticated` 政策係我哋自己嘅 0051 / 0052，**每條都帶 `store_id` 過濾**
⇒ 冇 store claim 嘅匿名用戶**讀唔到任何嘢**。
🔴 **所以：呢兩份 migration 嘅 `store_id` 過濾永遠唔可以放鬆做 `using (true)`**
（守衛 `print-and-order-realtime-guard.test.ts` 已鎖住）。

⚠️ 另外兩點（唔影響安全，但影響成本）：
- 匿名用戶係 `auth.users` 嘅**真實用戶** ⇒ 會佔用 MAU／用戶配額（本專案規模＝
  終端數＋中繼機數，十位數以內，可忽略）。
- 官方預設限制 **每小時 30 次匿名註冊** ⇒ 設備數遠低於此，但要留意
  「localStorage／App 資料被清」會產生一個新用戶。可喺 Dashboard → Authentication →
  Rate Limits 調整。

### 4.2 綁店（新 endpoint，兩種選項都要）

```
POST /api/pos/print-agent/realtime-bind
Headers: x-agent-id, x-agent-token          ← 沿用既有中繼憑證
Body:    { "accessToken": "<Supabase Auth access_token>" }
回應：    { "ok": true, "storeId": "..." }
```

Server 側行為：驗 agent（`verifyAgent`）→ 由 `accessToken` 解出 `sub`（user id）→
`supabase.auth.admin.updateUserById(sub, { app_metadata: { store_id: agent.storeId } })`。

> 🔴 **唔可以**由 APK 自報 store_id：`user_metadata` 係用戶可改嘅，
> 一定要用 service_role 寫 `app_metadata`，否則等於冇綁。

### 4.3 Realtime 連線

1. `realtime.setAuth(accessToken)` —— **必須喺建立 channel 之前**（官方要求）。
2. 之後才 `.channel(...).on("postgres_changes", { table: "pos_print_jobs", ... })`。

### 4.4 🔴🔴 最容易中嘅陷阱：綁完之後一定要 refresh + 重新 subscribe

JWT 係**簽發時嘅快照**。`app_metadata` 改咗，**舊 token 唔會變**。
若果綁完就咁繼續用舊 token：

- Realtime 嘅 RLS 檢查會**全部拒**（token 冇 `store_id`）；
- 但 channel **仍然顯示 `SUBSCRIBED`**、**零 error**；
- ⇒ 就係本專案最常中嘅「**Realtime 靜默失效**」 —— 睇落連線正常，實際一張紙都唔會出。

**正確次序：**

```
signInAnonymously() → accessToken
  → POST /realtime-bind（server 寫 app_metadata）
  → refreshSession()            ← 🔴 一定要，攞返帶 store_id 嘅新 token
  → realtime.setAuth(新 token)
  → 建立 channel 並 subscribe
  → 補一次 claim（因為訂閱期間可能已經有新 job）
```

⚠️ 之後**每次 token refresh 成功**，都要 `setAuth(新 token)` 並重新 subscribe
（重新 subscribe 之後同樣要補一次 claim）。呢個係「唔會靜默變死」嘅唯一保證。

---

## 5. 兼容性（對現役 APK 零影響）

- Server 側改動全部係**可選欄位／新 endpoint**，舊 APK 唔識就照用 anon ⇒ **行為完全不變**：
  - 選項 A：只需新增 `POST /api/pos/print-agent/realtime-bind`（APK 自己 `signInAnonymously()`）。
  - 選項 B：另外要 `/pair`、`/pair-status` 多回一組 `realtimeJwt`（**可缺**，缺值時 APK 行原有 anon 路徑）。
- **可以「先上 server、後上 APK」**，次序唔可以顛倒。
- 第 2 批（收 `pos_print_jobs` anon）**只可以喺所有在役 APK 都升級之後**做。

---

## 6. 驗收（第 2 批收口前必須全綠）

| # | 檢查 | 方法 |
|---|---|---|
| 1 | 所有在役 agent 都已綁店 | 查 `pos_print_agents.realtime_auth`（或新增一欄記錄 bind 狀態）＝ `jwt` |
| 2 | **實測出紙即時性** | 落單 → 廚房單／收據**必須 1–3 秒出**（唔可以等 180 秒）。**呢個係唯一可信嘅判準** |
| 3 | 舊 APK 行為不變 | 未升級嘅機照舊印得到（仍然靠 anon 窗口） |
| 4 | 綁店失敗有可見後果 | 未綁店時 APK 要**大聲顯示**（唔可以靜默用 anon 而介面顯示「已連線」）|

---

## 7. 回滾

- **APK 側**：保留「冇 JWT 就用 anon」嘅 fallback ⇒ 即時回滾（唔需要重出 APK）。
- **Server 側**：`/realtime-bind` 停用即回滾。
- **DB 側**：第 2 批嘅 `drop policy "pos_print_jobs anon read recent"` 之前，
  一定要準備好「貼返 anon 政策」嘅 SQL（秒級）。詳見 0052 檔尾 §3。

---

## 8. 唔可以改嘅嘢（照抄現狀）

- `pos_print_jobs` anon 窗口**唔可以短過 24 小時**（Realtime UPDATE／DELETE 用 row 自身 `created_at`）。
- 唔可以 fallback 去 Ledger 專案嘅 `NEXT_PUBLIC_SUPABASE_*`（Ledger 冇 `pos_*` 表）。
- claim 失敗仍然一律 401、RPC 失敗仍然一律 500（APK 靠 401 判斷要唔要清配對）。
- claim 回應要繼續帶 `nextPollMs`。
- `pos_soldout` 永久保留 anon（匿名客人端）。
  ⇒ 守衛：`src/lib/pos/print-and-order-realtime-guard.test.ts`（19 條）。
