# 診斷：網站 relay「配對失敗」＋ 商米「POS 雲端未設定」（2026-09-16）

> 用戶描述：無法與 Sunmi 打印機完成配對，昨日（09-15）下午 17:30 之後開始，之前正常。
> 網站 relay 狀態顯示正常。商米機現顯示「配對失敗: POS雲端未設定」。
> 並要求檢查：是否與今天動過的 env 變數有關。

---

## 一、結論（先講答案）

**兩個訊息描述同一件事的兩半，並指向同一個根因：iPad 部裝置手上冇有效嘅 POS 終端憑證。**

1. 商米的「**配對失敗: POS雲端未設定**」= APK 嘅 `RelayService` 拎唔到 `supabaseUrl` / `anonKey`
   → 即 `GET /api/pos/print-agent/pair` 回 `supabaseUrl: null, anonKey: null`。
2. 網站的「**配對失敗**」= `relay-pairing-panel.tsx` 收到 `pair-status` 非 200
   → 實測係 **HTTP 401「未經授權：需要 POS 終端憑證」**。

**兩條都不是網絡問題，也不是 supabase env 缺失（已實測排除，見下）。**

### 🔴 2026-09-16 01:04 用戶補充（決定性收窄）

> `POS_DEVICE_TOKEN_SECRET` 這個沒設。`POS_REQUIRE_DEVICE_AUTH` 這個也沒有。
> 我剛剛也把 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 重新再 save 一次。

#### 這兩個 env 沒設，實際會發生什麼？

**（A）`POS_DEVICE_TOKEN_SECRET` 沒設 → 不會壞。**
`resolveSecret()`（`pos-device-token.ts:50-57`）有三段 fallback：
```
POS_DEVICE_TOKEN_SECRET → ADMIN_SESSION_SECRET → SUPABASE_SERVICE_ROLE_KEY / _KEY
```
只要 `SUPABASE_SERVICE_ROLE_KEY` 有設，簽名密鑰照樣拿得到，token 照簽得出。

**（B）🔴 `POS_REQUIRE_DEVICE_AUTH` 沒設 → 閘照樣開著（不是關閉！）**
`isPosDeviceAuthRequired()`（`pos-device-token.ts:136-140`）：
```ts
const raw = process.env.POS_REQUIRE_DEVICE_AUTH?.trim();
if (raw === undefined || raw === "") return true;   // ← fail closed
```
**「沒設」≠「關閉」，係「強制」。** 這是一個很反直覺的陷阱 ——
很多人以為「我沒開這個開關，所以閘沒生效」，實際上預設就是開的。

#### 🔴 決定性實測（線上，2026-09-16 01:04）

| 端點 | 實測 | 判讀 |
|---|---|---|
| `POST /api/pos/device-token`（空 body） | `400 {"error":"缺少 accessToken。"}` | 端點活著，rate-limit 通過 |
| `POST /api/pos/device-token`（假 token） | `401 {"error":"Ledger 會話已失效，請重新登入。"}` | **唔係 503「系統未設定終端憑證密鑰」** ⇒ **secret 鏈有值，簽發能力正常！** |
| `GET /api/pos/state?storeId=test-store` | `401 「未經授權：讀取店舖資料需要 POS 終端憑證」` | 閘生效 |
| `GET /api/pos/print-jobs/status?storeId=…` | `401 「未經授權：需要 POS 終端憑證」` | 閘生效 |

**⇒ 關鍵：`SUPABASE_SERVICE_ROLE_KEY` 有設，簽發路徑健康。
所以 `POS_DEVICE_TOKEN_SECRET` 沒設 ≠ 問題根源。**

面板上那句「Ledger 會話已失效，請重新登入。」是我送假 token 得到的；
但**這正是 iPad 會遇到的情況**：12h TTL 過期 / `ledgerAccessToken` 過期 →
`refreshPosDeviceTokenIfNeeded()` 續期失敗 → 冇 token → 打 `pair-status` 得 401 →
`relay-pairing-panel` 顯示「配對失敗」。

**⇒ 修復 = iPad 重新登入 POS 帳號。唔使改任何 env、唔使 redeploy。**

### ⚠️ `SUPABASE_URL` / `SUPABASE_ANON_KEY` 重 save 之後必做

🔴 **Vercel 改 env 唔會自動套用到現有 deployment，一定要 Redeploy。**
去 Deployments 睇最新一次部署時間，確認係「重 save env 之後」才部署。
另外，`androidReady` 唔喺 live bundle（掃咗 20 個 chunk）⇒ 線上仍係舊版，
而這批 09-16 的改動正好就是為了讓下次一眼看得出這類事故，**建議連這次修復一起 push + redeploy**。

### 成因排序（更新版）

| # | 成因 | 為什麼吻合 | 機率 |
|---|---|---|---|
| **1** | **iPad 嘅 POS 終端憑證已過期／失效**（12h TTL 或 Ledger session 過期） | `/api/pos/device-token` 續期需要有效 `ledgerAccessToken`；過期即續不到 → 冇 token → `pair-status` 401 → panel 紅 → 配對流程停擺 | **🔴 最高** |
| **2** | 09-15 加鑑權閘後，iPad 從未重新登入 | `pair-status` 同 `unpair` 當日加咗 `posRouteAuthGuard`。已登入但 session 內冇 token 的舊終端會即刻壞 | 高（與 #1 同源） |
| **3** | 配對流程被中途中斷（unpair / 停止自動配對） | `macau-pos-relay-auto-pair-stopped=1` 落 localStorage → reload 都唔會自動重試 | 中 |
| **4** | iPad 換過瀏覽器 profile / 清過 site data | `relay-config` 全放 localStorage，清咗就當未配對，但商米側有行 → 兩邊不一致 | 低 |

**⚠️ 關鍵澄清：「網站 relay 狀態顯示正常」這句話要重新定義。**
`pairing`（有冇 localStorage 記錄）同 `state`（啱啱探測結果）係兩個獨立 state。
`result-panel` 嘅**徽章**只睇 `paired`；`state.kind === "failed"` 會另出一個紅色 block。
所以可以同時見到「綠底／已配對」＋下面紅色「配對失敗」——**徽章綠唔等於探測成功**。

---

## 二、實測證據（2026-09-16 00:09 澳門時間，全部唯讀、無需 secret）

| 探測 | 結果 | 判讀 |
|---|---|---|
| `GET /api/pos/print-agent/pair?agentId=ag-deadbeef…` | `200 {"status":"pending"}` | 端點存活。**注意：不存在嘅 agentId 一律回 `pending`**，所以呢個探測證明唔到 env 有冇值 |
| `GET /api/pos/print-agent/pair`（缺 agentId） | `200 {"status":"pending"}` | 同上，唔會報錯 |
| `GET /api/pos/print-agent/pair-status`（缺 storeId） | `400 {"paired":false}` | early-return 正常（喺 auth 閘之前） |
| `GET /api/pos/print-agent/pair-status?storeId=test-store` | **`401 {"ok":false,"error":"未經授權：需要 POS 終端憑證，請重新登入 POS 帳號。"}`** | **✅ 呢條就係網站顯示「配對失敗」嘅真身** |
| live bundle 掃描（20 個 chunk） | POS URL `iyrywzormzisyppkokbi` ✅、Ledger URL `zymdemjflsckicwcinxl` ✅、1 條 JWT `role=anon ref=iyrywzormzisyppkokbi` ✅ | **POS anon key 喺前端係齊嘅** → `SUPABASE_ANON_KEY` 大機會已設 |
| bundle 有冇 `androidReady` 字串 | **冇**（20 個 chunk 全部掃過） | 線上部署**未包含** 09-16 嘅 `androidReady` 改動 → 線上仍係舊版 pair-status route |
| x-vercel-id | `hkg1::sin1::…` | 部署係新嘅、有 CDN 命中，唔係 CDN 舊快取 |

### GitHub 提交流水（UTC → 澳門 +8）

| commit | Macau 時間 | 訊息 |
|---|---|---|
| `3d71dba` | 09-16 00:05 | up |
| `adc14e5` | 09-15 23:25 | update |
| **`2494cbb`** | **09-15 22:04** | update ← **改 `pair-status/route.ts`（加 `androidReady`）** |
| `460a12d` | 09-15 13:46 | up |
| `a0f88b8` | 09-15 12:03 | up |

`pair-status/route.ts` 嘅前一次改動：`5eb7895`（09-12 18:58）、`3d50006`（09-07 21:42）。

**➜ 加鑑權閘嘅改動係 09-15 落嘅（與 09-15 下午起故障時間吻合）。**

---

## 三、環境變數：逐項排除

`.env.local` / `.env` / `.env.production` **本機都唔存在**（全部 env 喺 Vercel Dashboard）。
`.env.example` mtime = `2026-09-15T09:18:08Z` = **澳門 09-15 17:18** ← *正正就係用戶講嘅「下午 5:30 之後」之前 12 分鐘*。

| 變數 | 影響 | 判斷（2026-09-16 01:04 後更新） |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | `resolveRelayRealtimeConfig()` 必須**成對**存在，否則回 `null` → `/pair` 回 null → 商米顯示「POS 雲端未設定」 | ✅ 你剛重 save 了；**但必須 Redeploy 才生效**。bundle 有 POS anon key ⇒ 之前已大機會 OK |
| `NEXT_PUBLIC_SUPABASE_URL`（Ledger） | `resolveSupabaseUrl()` 會 fallback 到佢 | ⚠️ 陷阱：DB 讀得到（走 Ledger），令人以為「Supabase 已配置」，但 relay 憑證依然可能係 null |
| `POS_DEVICE_TOKEN_SECRET` | 沒設 → **不會壞**。`resolveSecret()` 會 fallback 到 `SUPABASE_SERVICE_ROLE_KEY` | ✅ **確認沒設，但已實測證明簽發正常**（`/api/pos/device-token` 回 401 而非 503）。**不是本次病因** |
| `POS_REQUIRE_DEVICE_AUTH` | 沒設 → **閘照樣開著**（`raw === "" → return true`，fail closed） | 🔴 **確認沒設，但這正是閘生效的原因**。若想臨時全關要明確設 `=0` |
| `SUPABASE_SERVICE_ROLE_KEY` | 簽名密鑰的**最後 fallback**；同時 `getSupabaseWriteClient()` 必需 | ✅ **實測證明有值**（簽發路徑健康） |

### 關於「是否與今天動過的 env 變數有關」
**答案：這次不是 env 缺失造成的。** 已用線上實測證明：
- 簽發路徑健康（`/api/pos/device-token` 回 401 而非 503 ⇒ secret 鏈有值）
- POS anon key 在前端 bundle 齊全（`ref=iyrywzormzisyppkokbi`）

**真兇是 iPad 手上的憑證過期／失效**，而閘又是 fail-closed 預設開啟的，
所以一旦憑證過期就會立刻全線 401 —— 這與「09-15 下午之後一直發生」完全吻合（12h TTL）。

**唯一要注意**：如果你「重 save」`SUPABASE_URL` / `SUPABASE_ANON_KEY` 後**沒有 redeploy**，
那這次 save 不會生效（但這也解釋不了 09-15 起的故障，因為商米那句訊息可能來自 iPad 側文案）。

---

## 四、為什麼之前正常、09-15 下午後就壞

三個改動疊加，時間點全部落喺 09-15：

1. **09-15 加鑑權閘**（`posRouteAuthGuard`）→ `pair-status` 由「任何人可打」變成「必須帶 POS 終端憑證」。
2. **`POS_DEVICE_TOKEN_SECRET` 由 service-role fallback 改為獨立 secret**（見 `incident-2026-09-15-print-outage.md`）
   → **所有簽發中 token 即刻失效**，全部 POS 終端 + Admin 需重新登入。
3. **`.env.example` 於澳門 17:18 被改動**，即用戶所講「下午 5:30 之前不久」。

在此之前：iPad 有舊憑證（或端點唔使憑證）→ 配對順暢。
在此之後：iPad 憑證失效 → 401 → panel 紅 → 配對流程停擺 → 商米拎唔到憑證 → 兩邊同時紅。

**⚠️ 注意：`pair-status` 一加閘，就會連「配對流程」本身都擋住。**
呢個係設計上嘅副作用：本意係保護查詢端點，但因為 panel 靠 `pair-status` 判斷配對狀態，
401 會令 panel 誤以為「配對失敗（server 錯）」，而唔係「未授權，請重新登入」。

---

## 五、修復步驟（按順序做，做完一步睇一步）

### Step 1 — 先確認 iPad 憑證狀態（最快、零風險）
1. 喺 iPad 開 POS 網站 → 去「設置 → 打印機」（`/settings`）。
2. 睇「雲端列印中繼（relay）」區塊底下嘅紅色字。
   - 若係「**未經授權：需要 POS 終端憑證，請重新登入 POS 帳號。**」→ 確認係憑證問題，跳 Step 2。
   - 若係「**伺服器回應異常（HTTP 5xx）**」→ 係 server 端問題，跳 Step 3。
   - 若係「**網絡連線失敗**」→ 檢查 iPad 網絡。

### Step 2 — 重新登入 POS 帳號（✅ 最可能就是這一步）
1. 喺 iPad 登出 POS → 重新用 8 位電話 + 4 位 PIN 登入。
   - 登入成功會重新簽發 12h 的 `posDeviceToken` 並寫入 `authSession`。
2. 返去 `/settings` → 睇紅色字有冇消失、徽章變唔變「已配對」。
3. 若之前撳過「解除配對」／「停止自動配對」→ 手動撳一次「**配對**」鈕重啟 5s 自動配對循環。
4. **然後去商米機**：開 APK 中繼畫面（或由 POS 設定頁撳「開啟雲端列印中繼」）。
   - 確認右上角顯示 `POS：https://macau-pos-system.vercel.app`。
   - 睇「狀態：」一行。若仍係「等待配對」→ 停喺呢個畫面（APK 每 3s 輪詢一次）。
   - 幾秒後應該變「連線中…」→「**已連線（Realtime）**」。
   - 若變「**雲端斷線（30s 輪詢兜底）**」= Realtime 拎唔到憑證，但輪詢仍然會印（慢 30s）。

### Step 3 — 確認 redeploy（🔴 你剛重 save 了 env，這步必要）
Vercel → Project `macau-pos-system` → **Deployments** → 睇最新部署時間。
- 如果最新部署**早於**你重 save env 的時間 → **手動 Redeploy**。
- Vercel 改 env **不會**自動套用到現有 deployment。

同時確認（Production 環境）**成對**存在：
```
SUPABASE_URL          = https://iyrywzormzisyppkokbi.supabase.co
SUPABASE_ANON_KEY     = eyJ...（role=anon, ref=iyrywzormzisyppkokbi）
```
🔴 最常犯的錯：只設一個 → `resolveRelayRealtimeConfig()` 回 `null` → 商米顯示「POS 雲端未設定」。

**`POS_DEVICE_TOKEN_SECRET` / `POS_REQUIRE_DEVICE_AUTH` 不用加**（已證明不是病因）。

### Step 4 — 驗證商米拎到憑證
改完 redeploy 之後，喺商米中繼畫面應該見到：
- 「狀態：**已連線（Realtime）**」← 成功
- 通知欄顯示「**雲端中繼執行中 · 已連線 · 已印 N 張**」

然後喺 iPad 出一次測試單，睇商米有冇即時（< 2s）出紙。

### Step 5 — 若商米仍紅，睇 database 側
用 SQL Editor（service_role）查：
```sql
select agent_id, store_id, name, last_seen_at, revoked_at
from pos_print_agents
order by last_seen_at desc nulls last
limit 20;
```
- 有行 + `last_seen_at` 係幾分鐘前 → APK 活住，`heartbeat` 通，問題純粹喺 Realtime 憑證。
- `revoked_at` 非 null → 部機被 revoke 過，要重新配對。
- 完全冇行 → APK 從未成功 `POST /pair`。

---

## 六、長期加固建議

### A. `pair-status` 401 要顯示專屬文案（高優先）
而家 401 落 `state.kind = "failed"` → 顯示「配對失敗」+ server 原字串。
應該分開一個 `kind: "unauthorized"`，文案改成
「**POS 登入已過期，請重新登入**」+ 一個「重新登入」按鈕。
否則店員見到「配對失敗」會去搞商米，但其實要重新登入嘅係 iPad。

### B. 商米機「POS 雲端未設定」要喺 iPad 側都睇得到（高優先）
而家只有商米機自己知。應該令 `pair-status` 回 `androidReady`（**已在 09-16 實作，但線上未部署**），
並喺 `print-center.tsx` 顯示。已實作嘅線上路徑係：`print-center.tsx:1769-1782`。
⚠️ **但呢個 banner 只喺 `/prints` 出現，而且只喺有未完成雲端任務時才 render** ——
收銀頁 `/` 完全睇唔到。建議喺 `/settings` 嘅 relay panel 都加。

### C. 配對流程唔應該被查詢端點嘅 401 擋死
現時 `relay-pairing-panel` 一收到 401 就停。應考慮：
- 401 時仍然繼續 5s 輪詢（因為商米側配對可能已成功）；
- 只係顯示「未授權」提示，唔停循環。

### D. 部署前驗證 env 成對（中優先）
加一個 startup 檢查：`resolveRelayRealtimeConfig() === null` 時喺 build log 出 `console.error`，
令「漏設一個」呢類錯喺 deploy 階段就爆出嚟，而唔係等到店員發現印唔到。

### E. `resolveSupabaseUrl()` 嘅 fallback 要收緊（中優先）
`process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL`
—— 呢個 fallback 令「POS 專案未配置」被 Ledger 專案遮蓋，產生「DB 讀得到但 relay 冇憑證」
嘅假正常狀態。建議 fallback 時出警告 log。

### F. 執行 `0042` migration（未跑）
分段式 claim window（同機 6 分鐘／跨機 90 秒）+ `finished_at is null` 守衛。純 90s 會令中繼機搶返自己長單 → 重複出紙。

---

## 七、可重用嘅無 secret 診斷法

呢次用嘅方法完全唔需要 Supabase key：

1. **睇端點實際回應**：直接 `GET` 線上端點，睇 HTTP status + body。
   `pair-status?storeId=x` → 401 就即刻知係憑證問題。
2. **掃 live bundle 抽 anon key**：由 `_next/static/*.js` harvest `eyJ...` JWT，
   base64 decode 中間段，讀 `ref` 欄認專案。
3. **掃 bundle 特定字串判斷部署版本**：例如 `androidReady` 唔喺 bundle 就證明線上未部署該改動 ——
   比 `git log` 更直接，因為佢反映嘅係 CDN 實際送到瀏覽器嘅版本。
4. **用 x-vercel-id + age header** 判斷係 CDN 舊快取抑或真新部署。

---

## 八、要問店員／要你確認的問題

1. ✅ **已確認**：`POS_DEVICE_TOKEN_SECRET` 沒設、`POS_REQUIRE_DEVICE_AUTH` 沒設
   → 兩者都不是病因（已實測證明簽發路徑健康；且「沒設」等於閘開著，是預期行為）。
2. ✅ **已確認**：`SUPABASE_URL` / `SUPABASE_ANON_KEY` 剛重 save → **請確認已 redeploy**。
3. ❓ **iPad 是否 09-15 之後從未重新登入過 POS？** ← 這是現在最關鍵的一問。
4. ❓ **iPad 上 `/settings` 紅色細字的完整內容是什麼？**
   - 「未經授權：需要 POS 終端憑證，請重新登入 POS 帳號。」→ 憑證過期，Step 2 解決
   - 「伺服器回應異常（HTTP 5xx）」→ server 端問題
   - 「網絡連線失敗…」→ iPad 網絡問題
5. ❓ **有沒有按過「解除配對」或「停止自動配對」？**

---

## 九、為什麼 `POS_DEVICE_TOKEN_SECRET` 沒設卻還能簽發？（機制說明）

`pos-device-token.ts:50-57`：
```ts
function resolveSecret(): string | null {
  const dedicated = process.env.POS_DEVICE_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const adminSecret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (adminSecret) return adminSecret;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  return serviceKey?.trim() || null;
}
```
設計理由（見原檔註解）：寫入路徑本身**必須**有 service role key 才寫得入 DB
（`getSupabaseWriteClient()` 永不 fallback 去 anon），所以
「能寫 ⇒ 有 secret ⇒ 簽得出 / 驗得到」三者天然一致。

**⇒ 沒設 `POS_DEVICE_TOKEN_SECRET` 是安全的，只是職責混在一起。**

### 建議（可選）：加設 `POS_DEVICE_TOKEN_SECRET`
理由：把「POS 終端憑證簽名」與「Supabase 後台權限」兩件事分開。
否則日後**更換 `SUPABASE_SERVICE_ROLE_KEY`**（例如懷疑洩漏而輪替）時，
會**意外地令全部 POS 終端即刻要重新登入** —— 一次無預警的全店停擺。

設法：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
⚠️ 設好之後：**所有簽發中的 token 即刻失效 → 全部 POS 終端 / Admin 要重新登入一次**（一次性代價）。
建議在非營業時間做，並且與 Step 2 的重登合併成一次。
