# Print 中繼 / 雲端打印 —— 安全加固與交接說明（給 print relay 側）

> **日期**：2026-09-15
> **發起**：macau-pos（`C:\dev\macauPos\macauPosSystem`）全面安全審查
> **目的**：界定「雲端打印」路徑的安全邊界，列出**需要你方提供的資訊**、
> **建議設計**、**驗收標準**，令兩邊可以各自施工而唔會互相弄壞。
> **關聯報告**：[`docs/reviews/system-audit-2026-09-15.md`](../reviews/system-audit-2026-09-15.md) §2、[`docs/reviews/dining-optimization-2026-09-15.md`](../reviews/dining-optimization-2026-09-15.md) §6

---

## 0. 🔴 先問三個問題（答案決定後面所有優先次序）

**Q1. `print-relay/`（WSS 骨架）到底有冇真正部署？**
- 我哋 repo 內嘅 `src/lib/print-bridge/relay-transport.ts:25-34` 嘅 `send()`
  **完全冇開 WebSocket** —— 佢只係 `await flushPosSyncQueue()`，
  即「確保張單已寫落雲端 `pos_print_jobs`，等中繼 APK 自己 claim」。
- `print-relay/README.md:41` 亦自認 relay client「暫未接入 `dispatch.ts`」。
- ⇒ **推論：生產嘅雲端打印係走 Supabase `pos_print_jobs` + `/api/pos/print-agent/*`，唔係走 `print-relay/server.mjs`。**
- **若我哋推論正確** ⇒ `print-relay/` 屬**未使用骨架**，最安全嘅處理係**封存／刪除**（見 §4），
  因為一個「auth 係 placeholder、綁 0.0.0.0、token 放 query string」嘅服務一旦被誤部署，就係一個現成後門。
- **若你方其實有部署** ⇒ 請即刻照 §4 加固，並告訴我哋部署 URL／平台。

**Q2. 中繼機（Hub / Stationary Agent）而家係點取得身份憑證？**
- 我哋見到兩條可能路徑，需要你方確認實際用邊條：
  - (a) APK 用 POS 登入號碼（phone + PIN）取得 merchantId，再 `POST /api/pos/print-agent/pair` 自註冊
    （見 `src/app/api/pos/print-agent/pair/route.ts` 檔頭註解）；
  - (b) 由網頁端（已登入）代為配對。
- 我哋**已確認 web 側只會查 `pair-status`（GET），唔會 POST `pair`** ⇒ 若 (b) 成立，請指出係邊個元件做。
- **為何要問**：`POST /pair` 目前**不能加鑑權**（見 §2），因為加咗就可能斷你方 APK 嘅自註冊流程。
  要知道你方有無能力帶憑證，先可以決定配對碼方案點設計。

**Q3. `POST /api/pos/print-agent/claim` / `result` / `heartbeat` 嘅現有 header 約定係唔係已經穩定？**
- 我哋側見到係 `x-agent-id` + `x-agent-token`（`src/lib/print-agent-server.ts:69-75`），
  `token` 只用 sha256 存 `pos_print_agents.token_hash`。
- 請確認你方**所有** agent 請求都帶齊呢兩個 header（尤其 `heartbeat`），
  因為收銀台嘅「中繼機離線」紅 banner 就係靠 `last_seen_at` 判斷。

---

## 1. 現況盤點（我方實測，非推測）

### 1.1 生產雲端打印路徑（Supabase 側）

| 端點 | 鑑權現況（2026-09-15） | 備註 |
|---|---|---|
| `POST /api/pos/print-agent/pair` | 🔴 **仍然只驗「storeId 是否真商戶」，唔驗請求者身分** | 見 §2，**待你方回答 Q2 後才可修** |
| `GET /api/pos/print-agent/pair-status` | ✅ 已加 POS 終端憑證閘（綁店） | 本批已做；web 側 2 個呼叫點已補憑證 |
| `POST /api/pos/print-agent/claim` | ✅ 已驗 agent token（`verifyAgent`） | 另已修：token 比對改 `timingSafeEqual` |
| `POST /api/pos/print-agent/result` | ✅ 已驗 agent token | — |
| `POST /api/pos/print-agent/heartbeat` | ✅ 已驗 agent token | — |
| `POST /api/pos/print-agent/unpair` | ✅ 已加閘（POS 憑證 **或** agent 自證） | 刻意保留 APK 自我解除路徑 |
| `GET /api/pos/print-agent/pair?agentId=` | ⚠️ 未加閘，會回 `storeId` + `supabaseUrl` + `anonKey` | 該 anon key 本身已 inline 在瀏覽器 bundle（公開值），所以**唔算嚴重**；但會洩露 agentId ↔ storeId 對應 |

### 1.2 `print-relay/` 骨架（若已部署即為風險）

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| R1 | `authenticate()` 只檢查 token 非空 | `server.mjs:30-35` | 任何人自備 token 即可冒充 terminal 或 stationary |
| R2 | **冇把 token 綁到 storeId** | `server.mjs:37-60` | 傳入任意 `storeId` 即進入該店 room，可讀走全部 `dispatch`（菜品／枱號／金額） |
| R3 | token 放 **query string** | `server.mjs:39` | 會落入反向代理／access log／瀏覽器歷史 |
| R4 | 綁 `0.0.0.0` 且係明文 `ws://` | `server.mjs:14` | README 寫 WSS，但實際係 `WebSocketServer({ port })`（無 TLS、無 host 限制） |
| R5 | `role` 由 query 決定且**未驗證** | `server.mjs:41,52` | 任何非 `"stationary"` 字串＝terminal ⇒ 可加入並接收他人 result |
| R6 | `pending` 重連時**全量重派**，無 idempotency | `server.mjs:54-57` | stationary 重連 = 同一批 job 再印一次（**重複出紙**） |
| R7 | `rooms` Map **永不清理** | `server.mjs:19-24` | 店數／重連次數增加＝記憶體無上限增長 |
| R8 | `ttl` 語意未鎖定 | `server.mjs:71` | `expiresAt = m.ttl`（當**絕對** ms）⇒ 若 client 傳「時長」（如 `60000`），會變成 1970 年已過期 ⇒ **靜默全部唔出紙** |
| R9 | 無 rate limit、無監控、無持久 ack | README:36 | 無法觀測、無法追責 |

> ⚠️ R8 與我方 `PrintJob.ttl`（`supabase/migrations/0035` line 60）**係同一類陷阱**：
> 兩邊都係「絕對 epoch ms 期限」，但**都冇喺契約文件寫明**。
> 建議我方與你方一齊把「`ttl` = 絕對 epoch ms」寫入契約（見 §3.4）。

---

## 2. 待辦 A：`POST /api/pos/print-agent/pair` 加「一次性配對碼」

### 為何唔可以就咁加 POS 憑證閘

`pair` 目前只由**中繼機自己**呼叫（我方 repo 內零呼叫點，已用腳本確認）。
若直接要求 POS 終端憑證，而你方 APK 冇能力取得 ⇒ **即刻斷配對**。

### 建議設計（兩條，選一）

**方案 A（推薦）：由已登入的網頁簽發一次性配對碼**
1. 店員在網頁（`/settings` → 打印中繼面板）撳「產生配對碼」→ 呼叫新端點
   `POST /api/pos/print-agent/pair-code`（需 POS 終端憑證，綁店）
   → server 產生 6-8 位、**TTL 5 分鐘、單次使用**的短碼，存 server（或重用 `pos_print_agents` 加 pending 欄）。
2. 店員把短碼輸入中繼機（或掃 QR）。
3. 中繼機 `POST /api/pos/print-agent/pair` 帶 `{ agentId, token, storeId, pairingCode }`
   → server 驗短碼有效且未用過 → 才寫 `pos_print_agents` + 消耗短碼。
4. ⇒ 攻擊者需要「店員在場產生的短碼」，而唔係只要知道 storeId。

**方案 B：你方 APK 改用 `/api/ledger/login` 取得的 POS 終端憑證**
- 你方 APK 用 phone + PIN 打 `/api/ledger/login`（該端點回 `posDeviceToken`），
  之後所有 `print-agent/*` 請求帶 `Authorization: Bearer <posDeviceToken>`。
- 我方 `pair` 直接套 `posRouteAuthGuard()`（已有現成守衛）。
- 代價：APK 要存 token 並處理 12 小時 TTL 續期（可打 `/api/pos/device-token` 換新）。

### 需要你方提供

- ⬜ Q2 的答案（邊條路徑）＋ APK 是否已有能力帶 HTTP header。
- ⬜ APK 是否可實作「輸入短碼」或「掃 QR」的 UI。
- ⬜ 你方對 token 續期（TTL 12h）的處理能力。

### 驗收標準

- ⬜ 無短碼／無憑證的 `POST /pair` → **401**。
- ⬜ 用過的短碼重複使用 → **401**。
- ⬜ 過期（>5 分鐘）短碼 → **401**。
- ⬜ 正常流程（店員產生短碼 → APK 配對）→ `ok:true`，且 `pair-status` 立刻反映已配對。
- ⬜ 配對後落單出紙照常（呢個係唯一可信嘅 end-to-end 驗收）。

---

## 3. 待辦 B：`GET /api/pos/orders` 與整合方憑證

### 現況

`GET /api/pos/orders?storeId=` 被列為**對外嘅「主系統整合 API」**
（`docs/integration/main-system-integration.md:62-69`、`docs/06-api-reference.md:16`），
所以本批**只收窄了「唔帶 storeId 就回全平台」**，**冇加憑證閘**（外部系統冇 `posDeviceToken`）。

### 需要你方（或主系統側）提供

- ⬜ 邊個系統／服務在呼叫 `GET /api/pos/orders`？部署喺邊？由邊個團隊維護？
- ⬜ 佢哋可唔可以帶自訂 header（`Authorization` / `x-api-key`）？
- ⬜ 呼叫頻率同用途（即時對賬？報表？）—— 用嚟定 rate limit 額度。
- ⬜ 佢哋需要嘅欄位（現時回全欄位，其實只需要一部分？）

### 建議設計

新增一支 **service 憑證**：`POS_INTEGRATION_API_KEY`（Vercel env，server-only），
呼叫方帶 `x-api-key`；`GET /api/pos/orders` 接受
**「POS 終端憑證」或「POS_INTEGRATION_API_KEY」** 任一。
→ 兩邊都唔會斷，而匿名 scrape 即刻封死。

### 驗收標準

- ⬜ 無任何憑證 → 401。
- ⬜ 帶正確 `x-api-key` → 200（且**必須**帶 `storeId`）。
- ⬜ 帶 POS 終端憑證 → 200。
- ⬜ 憑證錯 → 401（唔可以 500）。

---

## 4. 待辦 C：`print-relay` 認證（**若 Q1 確認有部署，才做**）

### 若**冇**部署（我哋推斷）

建議：
1. 在 `print-relay/server.mjs` 頂部加**明顯的未完成警告**，並在 `README.md` 標明「**未生產使用**」。
2. 或直接移入 `docs/archive/`，避免日後被誤部署（**一個 placeholder auth + 0.0.0.0 的服務 = 現成後門**）。
3. 若保留，至少修 R1–R8（見 §1.2）。

### 若**有**部署（加固規格）

| 項 | 要求 |
|---|---|
| 認證 | **唔可以**「非空即過」。改為驗簽名 token（你方與我方共用一支 secret，HMAC-SHA256），payload 帶 `storeId` + `role` + `exp`；**token 內的 storeId 必須等於請求的 storeId** |
| 傳遞方式 | token 由 query string 改為 **WebSocket subprotocol** 或 `Authorization` header（避免落 access log） |
| 傳輸 | 前面必須有 TLS 終結（真 WSS）；`WebSocketServer` 加 `host: "127.0.0.1"` 或明確只聽反代 |
| 角色 | `role` 只接受白名單 `terminal` / `stationary`，其他一律拒 |
| 冪等 | `pending` 重派必須帶 `jobId` 去重（我方 `PrintJob.id` 可用）；重連重派唔可以令同一 job 出兩次紙 |
| 資源 | `rooms` 空 room 要回收；`pending` 要有上限（建議與 `attempts<5` 對齊） |
| 觀測 | 加 rate limit（per store per minute）、連線數、claim/dispatch/result 計數 |
| TTL 契約 | `ttl` = **絕對 epoch ms 期限**（同我方 `0035` 一致）；不接受「時長」 |

### 驗收標準

- ⬜ 無 token／錯 token／`storeId` 不匹配 → 連線即被拒（`close` + `error`）。
- ⬜ 用 A 店 token 連 B 店 room → 被拒。
- ⬜ stationary 重連後重派 → 同一 `jobId` 唔會印第二次。
- ⬜ 過量連線／submit → 被 rate limit 擋並有 log。

---

## 5. 待辦 D：Rate limit 持久化

### 現況（我方）

所有 rate limit 都係 **in-memory `Map`（per server instance）**
（`src/lib/pos/rate-limit.ts:1-14,29-40`），
Vercel serverless 多實例下基本無效；而 `clientIp()` 只讀 `x-forwarded-for` 第一個值
（`rate-limit.ts:43-47`）⇒ 若前置未清洗該 header 可直接偽造繞過。

### 需要你方／infra 提供

- ⬜ 可否提供一個**共用 counter store**？（Upstash Redis / Vercel KV / Supabase table 任一）
- ⬜ Vercel 前置係唔係已經覆寫 `x-forwarded-for`（唔可信嘅話連 IP 都唔可信）。
- ⬜ 可接受的洩漏程度（漏幾多 request 算 OK）。

### 建議設計

1. 抽象出 `checkRateLimit(key, limit, windowMs)` 介面，實作二選一：
   - **Upstash Redis**（`INCR` + `EXPIRE`，最簡單）；
   - **Supabase table**（`rate_limit_buckets(key, window_start, count)` + `upsert` 原子加一）—— 唔需要新基建。
2. 未配置外部 store 時**fail-open**（保持現狀），配置後才 hard enforce。
3. `clientIp()` 加 fallback：讀 `x-vercel-forwarded-for` / `cf-connecting-ip`，並在缺漏時回一個明確標記而唔係空字串。

### 驗收標準

- ⬜ 同一 IP 超過限額 → 429。
- ⬜ 換 instance 後限額**唔會重置**（即跨 instance 生效）。
- ⬜ 未配置外部 store → 行為同今日一致（唔會爆）。

---

## 6. 我方已完成（你方唔需要做，但要知道）

| 項目 | 內容 |
|---|---|
| `verifyAgent` 改 `timingSafeEqual` | `src/lib/print-agent-server.ts`；**行為不變**，只是消除 timing side-channel |
| `unpair` 加閘 | 保留 APK 自證路徑（`x-agent-token` 或 body `token`），web 側走 POS 憑證 |
| `pair-status` 加閘 | 綁店；web 側 2 個呼叫點已補憑證 |
| 打印／同步 fetch 加 20 秒硬逾時 | 修「一次網絡懸掛鎖死整個打印 worker」 |
| Realtime 補 `CLOSED` 恢復 + 指數退避 + 防重入 | 修「channel 一死就永久靜默收唔到事件」 |

---

## 7. 交接清單（Copy 去你方 ticket）

```
[ ] Q1 回答：print-relay 有無部署？平台／URL？
[ ] Q2 回答：中繼機而家用邊條路徑取得憑證？APK 可否帶 HTTP header？
[ ] Q3 回答：claim/result/heartbeat 係唔係全部帶 x-agent-id + x-agent-token？
[ ] 決定 §2 方案 A（一次性配對碼）or 方案 B（APK 帶 POS 憑證）
[ ] 提供 §3 需要的整合方資訊（邊個系統、可否帶 header、頻率、需要欄位）
[ ] 若 print-relay 有部署 → 照 §4 加固（R1–R8 + 驗收標準）
[ ] 確認 §5 可提供邊個 counter store
[ ] 一齊把 `ttl = 絕對 epoch ms` 寫入雙方契約文件
[ ] end-to-end 驗收：落一張單 → 印得出紙 + 收銀台即時見到（唔可以只靠 F5）
```
