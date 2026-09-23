# per-store token 導入評估（未實作，待你拍板）

日期：2026-09-23 10:50
背景：`docs/reviews/optimization-safety-review-2026-09-23.md` §6 — 你決定「需要有 per-store token，因為匿名讀取風險太高」
前置約束：**營運中的店家零停機、零退化**（列印即時性 / 訂單顯示 / 流程）

---

## 0. 一句話結論

**呢件事比預期細。** 專案**已經有**一套 per-store token（`pv1`，payload 帶 `storeId`），
只係佢係自家 HMAC 格式、**唔係 Supabase JWT**，所以 RLS／Realtime 認唔到。
要做嘅係「**把已有嘅店身份，包裝成 Supabase 認得嘅 JWT**」，而唔係由零建一套認證。

**建議採用「加性推進（additive）」四階段方案：全程保留現有 anon policy，
直到所有終端都確認改用 JWT 為止 —— 即係任何一刻都可以即時回滾，零停機。**
真正有風險嘅只有最後一步（刪 anon policy），而佢可以壓縮到單一 SQL、秒級回滾。

| 項目 | 評估 |
|---|---|
| 受影響表 | **6 張**（其中 **1 張建議保留匿名**，實質要改 5 張）|
| 需要改動 | DB 5 個 migration 段、Server 2 處、瀏覽器 client 3 個 hook、**中繼 APK 1 處（另一 repo）** |
| 停機 | **零**（加性方案）|
| 中斷風險 | 低～中；集中在「Realtime 靜默失效」同「token 過期」兩個已知同型病 |
| 回滾 | 每一階段都可獨立回滾；最後一步秒級 |
| 預估工作量 | 中型（DB＋server＋web 約 1 個工作天；APK 另計）|

---

## 1. 現況：已經有咩、差咩

### 1.1 已經有（唔使重做）

`src/lib/pos/pos-device-token.ts` —— HMAC-SHA256 簽名嘅終端憑證：

| 性質 | 值 |
|---|---|
| 格式 | `pv1.<base64url payload>.<base64url hmac>` |
| payload | `{ storeId, account, role, exp }` ← **已經係 per-store** |
| TTL | 12 小時（同一個班次級別）|
| 簽發點 | `POST /api/ledger/login`（server 唯一知道 `merchantId` 嘅地方）|
| 續期點 | `POST /api/pos/device-token`（用 Ledger access token 換新）|
| 傳遞 | `Authorization: Bearer` ＋ `x-pos-session` ＋ `x-pos-build` |
| 驗證 | `timingSafeEqual`（已防 timing attack）|
| 秘密 | `POS_DEVICE_TOKEN_SECRET` → 退 `ADMIN_SESSION_SECRET` → 退 service role key（**全部 server-only**）|

⇒ **「邊部機係邊間店」呢個資訊已經存在、已經簽過名、已經有續期機制。**
缺嘅只係一個 Supabase 認得嘅格式。

### 1.2 差咩

Supabase 嘅 RLS 同 Realtime 只認：① 官方 Auth 簽嘅 JWT ② **用專案 JWT secret 自簽嘅 JWT**
（官方「Custom tokens」文件明寫：`supabase.realtime.setAuth('your-custom-jwt')`）。
`pv1` 兩者都唔係 ⇒ 所以目前只有 anon 身份可用 ⇒ 所以要有時間窗式嘅匿名開放。

---

## 2. 影響面盤點：6 張表 + 各自嘅消費者

我先用生產環境嘅公開 anon key 實測，確認邊幾張表而家真係讀得到：

| 表 | anon 讀取 | 現行窗口 | 消費者 | 可否帶 per-store token？ |
|---|---|---|---|---|
| `pos_orders` | ✅ | 72 小時 | 收銀台 Realtime、後廚 Realtime | ✅ 兩者都係已登入終端 |
| `pos_print_jobs` | ✅ | 24 小時 | 收銀台 Realtime、**中繼 APK Realtime** | ✅ 中繼機有 agent 憑證可換 |
| `pos_kds_item_state` | ✅ | `using (true)` | 後廚 Realtime | ✅ |
| `pos_store_status` | ✅ | `using (true)` | 收銀台 Realtime（`use-store-status`）| ✅ |
| `pos_online_order_settings` | ✅ | `using (true)` | 收銀台 Realtime（`use-merchant-order-config`）| ✅ |
| `pos_soldout` | ✅ | `using (true)` | **客人掃碼／kiosk（匿名）**`use-kiosk-order.ts` → `soldout.ts` 直接讀 | ❌ **唔可以** |

🔴 **`pos_soldout` 係關鍵例外**：客人手機掃碼、自助點餐機**冇任何登入**，
唔可能持有店 token。而佢只有 `store_id + menu_item_id + sold_out` 三格、
**冇歷史、冇 PII、目前 0 行**（`0016 §3c` 已記錄同一理由）。
⇒ **建議呢張表保留 anon `using (true)`，唔納入今次範圍。**

⇒ **實質要改嘅係 5 張表**（`pos_soldout` 除外）。

### 2.1 好消息：未見過任何 `authenticated` 用法

全 49 份 migration 掃過：**零** `grant ... to authenticated`、**零** `auth.jwt()`。
即係呢個 role 同呢套 policy 模式係全新、無歷史包袱、唔會同既有口徑打架。

### 2.2 好消息：索引已齊（Realtime 授權成本可控）

Supabase 官方文件明寫：**Realtime 對每個事件、對每個訂閱者做一次授權檢查**
（100 個訂閱者 = 100 次 RLS 評估）。所以 policy 一定要走索引。實測已存在：

```
pos_orders_store_idx        (store_id)
pos_orders_store_created_idx(store_id, created_at)   ← 正合用
pos_print_jobs_store_idx    (store_id)
pos_print_jobs_created_idx  (created_at)
```

⇒ 唔需要為咗加 policy 而補 index。

---

## 3. 方案選擇

| 方案 | 做法 | 評價 |
|---|---|---|
| **A（建議起點）** | **Supabase 官方「Custom tokens」**：用**專案 JWT secret** 自簽 JWT（HS256），`role: "authenticated"` + `store_id` claim；client 用 `realtime.setAuth(jwt)` | ✅ 零外部依賴、官方支援、改動最小<br>⚠️ 要用 legacy JWT secret；**外洩 = 可偽造 service_role**，必須當最高機密 |
| B（中期遷移） | 改用**非對稱簽名金鑰**（Supabase 已由共用密鑰走向 JWKS）| ✅ 私鑰唔外流，係 Supabase 嘅未來方向<br>⚠️ 需要確認你哋專案版本支援，屬另一輪工作 |
| C | 用真正嘅 Supabase Auth（每個終端一個 user）| ✅ 最正統、有官方 refresh<br>⚠️ 最重：要建 user、管理密碼／magic link、綁 store、處理 rotation ⇒ 唔建議 |

**建議：現在行 A，並在設計上**唔好**把 JWT 簽名邏輯寫死在 route 入面** ——
抽成 `realtime-token.ts` 一個模組，將來換 B 只改一個檔。

---

## 4. 需要改動嘅部分

### 4.1 DB（5 個 migration，全部 idempotent、純加性）

```sql
-- 對 5 張表逐張：
create policy "<table> store scoped read" on public.<table>
  for select to authenticated
  using (
    store_id = (auth.jwt() ->> 'store_id')
    and coalesce(created_at, now()) >= now() - interval '72 hours'   -- pos_orders
  );
grant select on table public.<table> to authenticated;

-- 另建議：helpers（STABLE，令 planner 可以優化）
create or replace function public.pos_jwt_store_id() returns text
  language sql stable as $$ select nullif(auth.jwt() ->> 'store_id', '') $$;
```

要點：
- 🔴 **唔可以 drop 任何現有 anon policy**（呢個係「零停機」嘅全部秘密）。
- 🔴 `coalesce(created_at, now())` **唔可以省** —— `created_at` 可以係 null，
  寫 `created_at >= ...` 會變成 NULL ⇒ 令該行永遠讀唔到（`0016/0041` 已有同一寫法）。
- 🔴 時間窗唔可以比現時短（`pos_orders` ≥72h、`pos_print_jobs` ≥24h）——
  Realtime 嘅 UPDATE／DELETE 事件係用 **row 自身嘅 `created_at`** 過 policy。
  已寫入守衛 `src/lib/pos/print-and-order-realtime-guard.test.ts`。

### 4.2 Server（2 處）

| # | 改動 | 位置 |
|---|---|---|
| 1 | 新增「簽 Supabase JWT」純函式模組（`realtime-token.ts`）| 新檔；**零 import** 以便 `node --test` 測 |
| 2 | 續期時一齊發 JWT | `POST /api/pos/device-token`、`POST /api/ledger/login` —— **搭既有請求，零新增請求** |

⚠️ 新增 env：`SUPABASE_JWT_SECRET`（POS 專案）。**只可以放 Vercel server env，永遠唔可以入 client bundle。**
⚠️ 唔可以沿用 `POS_DEVICE_TOKEN_SECRET` 去簽 JWT —— Supabase 只認自己嗰把。

### 4.3 瀏覽器 client（3 個 hook + 1 個 client 工廠）

| 檔案 | 改動 |
|---|---|
| `src/lib/pos/supabase-client.ts` | `createClient(url, anonKey, { accessToken: async () => jwt })`；**取唔到 JWT 就回 null ⇒ 自動退回 anon** |
| `src/lib/pos/use-pos-realtime.ts` | 建 channel 前 `realtime.setAuth(jwt)`；續期成功後重新 `setAuth` |
| `src/lib/kds/use-kds-realtime.ts` | 同上 |
| `src/lib/pos/use-store-status.ts`、`use-merchant-order-config.ts` | 走同一個 client 工廠 ⇒ 理論上免改（要實測確認）|

🔴 **fallback 係零停機嘅關鍵**：JWT 拿唔到（未登入／舊 server／網絡問題）⇒ 保持 anon 行為，
即係「最壞情況同今日一樣」，唔會更差。

### 4.4 中繼 APK（另一 repo，唯一需要出 APK 嘅部分）

- `GET /api/pos/print-agent/pair` 同 `/pair-status` 已經回 `supabaseUrl` + `anonKey`
  ⇒ **加多一個 `realtimeJwt`**（同樣字段：缺值 → APK 保持 anon，退化而唔係斷線）。
- APK 側：`RelayPrefs` 存 JWT；Realtime client `setAuth(jwt)`。
- 🔴 **舊 APK 完全唔受影響**（`org.json` `opt*` 會忽略未知欄位）⇒ 可以「先上伺服器、後上 APK」。
- ⚠️ ktor 客戶端目前用 `vsn=1.0.0`；換 JWT 時要確認對應版本嘅 `setAuth` API。

### 4.5 Admin（1 處，用嚟做導入驗收閘）

🔴 **重要發現：Supabase log CSV 匯出嘅 `auth_user` 欄一律係 `null`**（我實測過 1,000 筆全空），
所以**唔可以**用 Supabase log 判斷「邊部機仲用 anon」。要用我哋自己有嘅表：

| 改動 | 用途 |
|---|---|
| `pos_sessions` 加 `realtime_auth text`（`anon` / `jwt`）| 收銀台／後廚：admin「POS 工作階段」頁一眼睇到邊個分頁未切換 |
| `pos_print_agents` 加 `realtime_auth text` | 中繼機：由 claim route 用一個**新 optional 標頭**寫入；舊 APK 冇傳 → `null` ⇒ 一眼知邊部未升級 |

⚠️ 呢兩個都係**加欄 + 由既有請求順帶上報** ⇒ **零新增請求、對舊 client 零影響**。

---

## 5. 導入步驟（四階段，每階段都可獨立停下／回滾）

```
階段 1  加性 DB           階段 2  Web 切換          階段 3  中繼 APK       階段 4  收口
─────────────────▶ ─────────────────▶ ─────────────────▶ ─────────────────▶
加 authenticated        瀏覽器開始帶 JWT          APK 帶 JWT            刪 anon policy
policy（保留 anon）      （保留 anon fallback）    （保留 anon fallback）  （只留 authenticated）
                                                    ＋ pos_soldout 例外
風險：幾乎零             風險：低                  風險：低               風險：中（唯一一步）
回滾：drop 新 policy     回滾：關 feature flag     回滾：APK 保持舊版      回滾：貼回 anon policy SQL
```

### 階段 1 —— 加性 DB（可獨立部署，對任何 client 零影響）
- 寫 5 段 policy（純新增）。
- **驗收**：`anon` 讀取結果逐位元不變（即現有行為完全不變）；
  用一個手造嘅測試 JWT 確認 `authenticated` 只讀到自己店。

### 階段 2 —— Web 切換（feature flag 可控）
- 出 JWT + client `setAuth`；**保留 anon fallback**。
- **驗收閘**（兩個都要）：
  1. 「POS 工作階段」頁面顯示所有在線分頁 `realtime_auth = jwt`（**冇一個係 anon**）。
  2. **功能實測**：掃碼／線上單 → 收銀台**秒級彈窗**；KDS 秒級出單；關店期間無異常。
- ⚠️ 呢步要觀察足一個**營業日**才可去階段 3。

### 階段 3 —— 中繼 APK
- 伺服器先加 `realtimeJwt` 欄位（對舊 APK 零影響）→ 再出 APK → 逐店更新。
- **驗收閘**：`pos_print_agents.realtime_auth` 全部 `jwt`；
  **實測出紙**：落單 → 廚房單／收據**秒級**（唔係等 180 秒）。
- ⚠️ 呢個係**列印即時性**嘅守門測試，唔可以只看標記。

### 階段 4 —— 收口（唯一有風險嘅一步）
- 條件：階段 2 同 3 嘅驗收閘**全部綠** ≥1 個營業日。
- 動作：`drop policy "pos_orders anon read recent"` 等 5 條。
- **執行時機：關店時段**（DDL 會攞 ACCESS EXCLUSIVE lock；呢幾張表細，通常毫秒級，但唔博）。
- 保留 `pos_soldout` 嘅 anon policy。

---

## 6. 停機與中斷風險（逐項）

| 風險 | 嚴重度 | 會唔會靜默 | 對策 |
|---|---|---|---|
| **Realtime 靜默失效**（token 無效／過期 ⇒ 事件唔推、channel 照 `SUBSCRIBED`）| 🔴 高 | ✅ 會 | ① TTL 與 `pv1` 一致（12h）② 續期成功後**強制** `setAuth` + 重新 subscribe（resubscribe 本身會 backfill，安全）③ 加「Realtime 靜默偵測」見 §7 |
| **Token 過期而連線仲用舊 token** | 🔴 高 | ✅ 會 | 同上；另外 `pos_sessions` 記錄最後一次收到 Realtime 事件嘅時間，超過 N 分鐘 → UI 提示重載 |
| DDL 鎖表 | 🟡 低 | ❌ 唔會 | 關店時段執行 |
| **JWT secret 外洩 ⇒ 可偽造 service_role** | 🔴 高 | — | 只放 Vercel server env；**唔可以**用 `NEXT_PUBLIC_*`；唔可以寫入任何 client bundle；建議中期遷去方案 B（非對稱）|
| 舊 APK 冇 JWT ⇒ 收口後收唔到推送 | 🔴 高 | ✅ 會 | 階段 4 前必須確認 `pos_print_agents.realtime_auth` 全部 `jwt` |
| 客人掃碼／kiosk 被誤收口 | 🟡 中 | ❌ | `pos_soldout` 明確排除 |
| Realtime 授權成本上升（每事件 × 每訂閱者）| 🟡 低 | — | 索引已齊（§2.2）；仍要觀察 Realtime 用量 |
| **DELETE 事件唔受 RLS 保護** | 🟡 中 | — | Supabase 官方限制（Postgres 無法驗證已刪除行嘅權限）⇒ **client 側依 `payload.storeId` skip 外店事件嘅 L3 閘唔可以拆** |

---

## 7. 兩個必須連帶做嘅配套（唔可以省）

1. **Realtime 靜默偵測**：目前「WS 訂錯／token 失效」都係零 error。
   ⇒ 在 `pos_sessions` 記 `last_realtime_event_at`；超過門檻（例如 10 分鐘）而店係營業中 →
   UI 出「即時通知可能已中斷，請重新載入」提示。
   （本專案已有同型資產：`build-stale-banner.tsx` 嘅「版本過期」橫幅，可以照抄模式。）
2. **手動逃生門**：`pos-app` 保留一個「強制全量拉取」按鈕（已有 `forceFull`），
   令店員發現唔彈單時可以即刻自救，唔需要等工程。

---

## 8. 回滾方案（逐階段，全部可即時執行）

| 階段 | 回滾動作 | 時間 |
|---|---|---|
| 1 | `drop policy "<table> store scoped read"` ×5 | 秒級 |
| 2 | 關 feature flag（client 回到 anon；anon policy 仲在）| 即時（下一個請求）|
| 3 | 叫店家繼續用舊 APK（伺服器欄位係可選）| 即時 |
| 4 | **貼回 `rollback-0041-anon.sql`**（重新 create anon policy）| 秒級 |

🔴 **紀律**：階段 4 之前，**`drop anon policy` 嘅 SQL 同「貼返 anon policy」嘅 SQL 要一齊準備好**，
並且喺同一份 migration 檔尾以註釋保留，唔可以只寫 drop。

---

## 9. 工作量與建議排期

| 部分 | 內容 | 估時 |
|---|---|---|
| DB | 5 段 policy + 2 個 helper + 2 條加欄 | 0.5 天 |
| Server | `realtime-token.ts`（純模組）+ 2 個簽發點 | 0.5 天 |
| Web | client 工廠 + 3 個 hook + 靜默偵測 | 1 天 |
| 守衛 | 擴充 `print-and-order-realtime-guard.test.ts` + token 模組單測 | 0.5 天 |
| APK | 另一 repo（`RelayPrefs` + `setAuth`）| 另計 |
| 驗收 | 每個階段各需 1 個營業日觀察 | 3 天（日曆時間）|

**建議排期**：階段 1 可以先做（零風險、可長期擱置）；階段 2–4 需要一個完整營業週期做驗收，
最好排喺生意較靜嘅日子，並預先通知店員「如果唔彈單，撳『強制更新』」。

---

## 10. 我做唔到嘅部分（要你決定）

1. **`SUPABASE_JWT_SECRET` 要由你喺 Supabase Dashboard 拎**（Settings → API）並放入 Vercel env ——
   我唔應該、亦唔會代你去取得或儲存呢個密鑰。
2. **要唔要行方案 A 定直接上方案 B（非對稱金鑰）** —— 取決於你哋 Supabase 專案版本。
3. **中繼 APK 屬另一個 repo** —— 要你確認可唔可以排期改同出 APK。

---

## 附：中繼機救回後嘅注意事項

### 已確認（由你告知 + 日誌核對）
- 兩部中繼機都好，事故結束。

### ⚠️ 呢次事故嘅性質：**靜默故障**
佢死嘅時候**店裡冇人**（07:43 未開門），而**表面零症狀** ——
因為 `pos_claim_print_jobs` 只按店認領、唔綁 agent，而 `device-config` 係**店級**查詢
⇒ 剩低嗰部中繼機拿到**同一份**打印機清單，可以照認領**全部**任務。
所以真正後果係「**失去冗餘 ＋ 吞吐減半（180 秒一輪、每次最多 5 張）**」，而唔係即刻印唔出。
⇒ **呢個正是佢可以靜默兩個鐘頭冇人發現嘅原因。**

### 冇卡紙、冇漏單（已由機制確認）
`0042` migration 嘅重領窗口：

```sql
or j.claimed_by is null
or (j.claimed_by  = p_agent_id and j.claimed_at < now() - interval '6 minutes')
or (j.claimed_by <> p_agent_id and j.claimed_at < now() - interval '90 seconds')
```

⇒ 死機前認領咗但未印完嘅 job，**90 秒後就會被另一部機重領**；
而 `print_jobs_once_key_uniq` 內容唯一鍵去重會擋住重複出紙。
**⇒ 唔需要人手清 job，亦唔會漏。**

### 後續要注意（按優先）

| 優先 | 事項 |
|---|---|
| **1** | **確認根因**：① 該裝置係唔係長期插電？② Android 有冇開「電池優化」把 App 殺咗？③ App 有冇前台服務 + `START_STICKY` + 開機自動啟動？<br>⇒ 如果冇，**佢會再死**（呢次係凌晨 4 小時後死，唔似偶然）|
| **2** | **開店 SOP 加一步**：開門後睇一眼 POS **打印中心**，確認兩部中繼機都係綠（門檻：`last_seen_at` ≥5 分鐘 → 疑似離線）。呢個係目前唯一嘅人眼防線 |
| **3** | **考慮加自動告警**：現在只有「打開打印中心才睇到」。可以做「中繼機離線 → admin 頁／通知」。（未做，需要你決定）|
| **4** | **唔需要**人手清 print job（見上）；**唔需要**重跑任何 migration |
| **5** | 如果佢**再次**半夜死掉而原因係電池／省電，要當成**硬件／設定問題**處理（換機或改成固定供電），唔係軟件 bug |

### 一個順帶嘅建議
佢死喺**未開門時段**，所以「開門前去唔去睇」係關鍵。
如果打印中心嘅離線提示唔夠顯眼，可以喺「開店前檢查」清單度加一格 ——
但你之前明講過觸控 UI 要「只加不減」，所以我唔會自己動，等你話要才做。
