# 診斷：網站 relay「配對失敗」＋ 商米「POS 雲端未設定」（2026-09-16）

> 用戶描述：無法與 Sunmi 打印機完成配對，昨日（09-15）下午 17:30 之後開始，之前正常。
> 網站 relay 狀態顯示正常。商米機現顯示「配對失敗: POS雲端未設定」。
> 並要求檢查：是否與今天動過的 env 變數有關。

---

## 一、結論（先講答案）

> ## 🚩 **2026-09-16 09:37 —— 請直接跳去 §十五（最新、三個 store 全停）**
>
> 本文檔係**滾動累積**嘅排查記錄，**中間幾節嘅結論已被推翻**，閱讀時務必跟住時序：
>
> | 節 | 結論 | 現狀 |
> |---|---|---|
> | §一 / §一B（01:10） | `SUPABASE_ANON_KEY` 冇 fallback ⇒ 商米配對失敗 | ⚠️ 曾真確，後又被推翻 |
> | §九（01:40） | 配對已通，新卡點係 `dispatch failed` | ⚠️ 當時狀態，已過時 |
> | §十（07:40） | 真根因：打印機唔同網段 | ✅ **下游根因，仍然成立** |
> | §11.4 | `POS_URL` 在三個實戰 env 缺失 | ❌ **本次唔適用** |
> | §11.11 | 唔係配對方法引起打印失敗 | ✅ 結論對（理由已更正） |
> | §12 | 狀態「矛盾」機制 + 兩條路徑判別 + `POS_REQUIRE_DEVICE_AUTH` 被關 | ⚠️ 機制對，但「Vercel 憑證缺」已被 §13 推翻 |
> | §十三（09:10） | 實測證明 `GET /pair` 兩欄有值 ⇒ 真兇係 `restorePairing()` 見 `pending` 靜默失敗 | ⚠️ 對「`ag-f38b08c…`」成立；但唔係用戶嗰台 |
> | §十四（09:23） | 真兇鎖定：心跳已停（`d564b932` 08:30:34） | ⚠️ 對，但只係三個 store 之一 |
> | **§十五**（09:37） | **🔴 三個 store、三台中繼機，全部停咗；且 UI 顯示嘅可能係別店心跳** | 🔴 **最新，睇呢節** |
>
> **一句話（修訂）：**
> `pos_void_stale_print_jobs()` 回 `0` 係**正常**（只掃 `ttl` 已過期；你嗰批 10 張 ttl 未過、1 張 `ttl=NULL`）。
> 真正要處理嘅係兩件事：
> ① **DB 裡有三個 `store_id`**（`d564b932` / `f6ec837a` / `8291f843`），三台機心跳 **08:30:34 / 01:31:06 / 09-15 14:24:37** 全部停咗；
> ② **`resolveStoreId()` = iPad 登入嘅 merchantId**，所以截圖嗰句「1138 分鐘前」對應嘅係 **`8291f843`（1154 分）**，
> **唔係你哋現場正用嗰台**。
> ⇒ 先確認 iPad 登入邊個店，再針對**嗰間店**去叫醒中繼機。

**兩個訊息描述同一件事的兩半，並指向同一個根因：iPad 部裝置手上冇有效嘅 POS 終端憑證。**

> 🔴🔴 **2026-09-16 01:10 更新 —— 真正原因已找到：`SUPABASE_ANON_KEY` 沒有 fallback**
> 見下面「一 B」節。這也是為什麼「重 login 後 web 正常，但商米仍然配對失敗」。

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

## 一 B、🔴🔴 真正原因：`SUPABASE_ANON_KEY` 在線上部沒有 fallback（01:10 找到）

把線上實際部署的版本（`3d71dba`）拉出來看 `GET /pair`：

```ts
// src/app/api/pos/print-agent/pair/route.ts（3d71dba，線上版本）
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
return NextResponse.json({
  status: "paired", storeId: agent.storeId, storeName: agent.storeName,
  supabaseUrl: url, anonKey,
});
```

🔴 **兩個變數的待遇完全不對稱：**

| 變數 | fallback | 若缺失的後果 |
|---|---|---|
| `url` | 有 → `NEXT_PUBLIC_SUPABASE_URL` | ⚠️ **會靜默 fallback 去 Ledger 專案**（沒有 `pos_*` 表）→ 訂閱成功但零 event（靜默失效） |
| `anonKey` | **沒有** | 🔴 `""` → APK `pollPair` 的 `takeIf { it.isNotBlank() }` 轉成 `null` → 「POS 雲端未設定」 |

即：**只要 `SUPABASE_ANON_KEY` 沒設，商米就一定顯示「POS 雲端未設定」**，
而且 Web 端（`pair-status`）依然會綠燈 —— 因為它查的是另一條完全不同的變數
（`getSupabaseWriteClient()` 走 service role key）。

### 這解釋了全部現象

- ✅ Web「已配對」綠燈 —— service role key 那條路正常
- ❌ 商米「POS 雲端未設定」—— anon key 那條路缺值
- ❌「重 login 之後還是唔得」—— login 只補好了 `pair-status` 的 401，補不到 anon key
- ❌「重 save env 之後還是唔得」—— 見下面部署時間線

### 修復（`653ea43` 已 push + Vercel 已部署）

我加的 `resolveRelayRealtimeConfig()`（`print-agent-server.ts`）正正根治這個不對稱：

```ts
export function resolveRelayRealtimeConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;   // ← 成對才有值
  return { url, anonKey };
}
```
刻意**不 fallback** `NEXT_PUBLIC_SUPABASE_URL`（= Ledger，沒有 `pos_*` 表）。

**部署狀態（01:14 實測）**：live bundle **已含 `androidReady`** ⇒ `653ea43` 已完成部署。

**⇒ 現在 `pair-status` 會回 `androidReady` 欄位。**
iPad 重整 `/prints` 頁面後：
- `androidReady: true` → env 已 OK
- `androidReady: false` → **確證 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 未成套套用**（要 Redeploy）
  └─ 紅 banner 會直接寫「Android 側未拎到雲端連線憑證（supabaseUrl / anonKey）」

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

---

## 九、2026-09-16 01:40 續——**配對已通**，新卡點係 `dispatch failed`

> 上一節（01:10）判定嘅根因（ `SUPABASE_ANON_KEY` 冇 fallback）**已修並已部署**。
> 本節係修好之後嘅**新現場證據**：雲端嗰截已經通咗，失敗點往前移咗一步。

### 9.1 決定性變化：中繼機開始認領任務

| 指標 | 01:14 之前 | **01:30（本次實測）** |
|---|---|---|
| `claimed_by` 有值嘅行 | **完全冇**（全部 NULL） | `ag-a466746da8946cd1421916043eb643e1` ✅ |
| `claimed_at` | 全 NULL | `01:30:55` ✅ |
| `attempts` | 恆 0 | 2 / 3 / 5（真係重試過） ✅ |
| 任務狀態流轉 | 淨係 `pending` → 冇人理 | `pending → printing → failed` ✅ |

⇒ **01:10 嗰個修復生效咗：APK 拎到雲端任務。** 剩低嘅問題已經唔係「配對／雲端」。

### 9.2 新嘅失敗點：`AGENT_FAILED: dispatch failed`

近 20 行入面 8 張全部同一個結局：

```
status=failed  attempts=5  last_error = "AGENT_FAILED: dispatch failed"
```

`result/route.ts:77` 嘅構造式：

```ts
patch.last_error = rawError ? `AGENT_FAILED: ${rawError}`.slice(0, 300) : "AGENT_FAILED";
```

⇒ **`dispatch failed` 係 APK 用 error 欄回傳上雲嘅原文**，server 只係加咗前綴。
即係：**claim 成功、render 冇拋錯，但最後一段「送紙落打印機」失敗。**

### 9.3 🔴 最可疑嘅結構性原因：雲端 job 完全冇帶打印機連線資料

實測每一張 job：

| 欄位 | 值 |
|---|---|
| `printer_name` | `廚房打印機` |
| `printer_id` | `printer-kitchen-1` |
| **`printer`（jsonb 快照）** | **`NULL`** ← server 從未寫過 |
| **(claim 回傳 `printers[]`)** | **`[]`** ← `claim/route.ts:42` 硬編碼 |

而三個版本嘅 APK `JobRunner.resolvePrinter()` 都係咁揀機：

1. `row.printer`（jsonb 快照）→ **無**
2. claim 嘅 `printers[]`（按 id → name 配對）→ **恒 `[]`**
3. 本機已發現設備（按 name 配對）→ 要機上有同名設備先中
4. **兜底**（最致命）：
   - print-agent-android → `connectionType="sunmi"` 嘅「Sunmi 內置打印機」
   - print-relay → `ipAddress=null` 嘅「LAN 打印機」

⇒ 只要第 3 步配唔到（例如本機發現嘅設備唔叫「廚房打印機」、或 id 唔係 `printer-kitchen-1`），
就**必然**跌落第 4 步嘅假打印機，跟住 100% dispatch 失敗。
**呢個同「全部都係同一句 dispatch failed」完全吻合。**

相關既有記載：`docs/98-print-hub-no-jobs-investigation-plan.md:452` 已註明 claim 嘅 `printers` 恒為空陣，
屬已知但未修嘅 TODO。

### 9.4 ⚠️ 「dispatch failed」唔喺本機任何源碼／APK 入面

排查方法（可重用）：

| 步驟 | 結果 |
|---|---|
| grep 全機 `C:/dev` 1389 個文字檔 | **0 命中**（只有無關嘅 `Callback dispatch failed.`） |
| grep 三個 Android repo（`print-agent-android` / `print-relay` / `macauMemebershipPrintingService` / `print-agent-android.SOURCE-BACKUP`） | 全部得中文文案，例如 `"列印失敗（第 x/y 份）"`、`"打印機連線逾時…"`、`"Sunmi 內置打印機未就緒（…）"` |
| **解 APK → inflate `classes*.dex` → 掃 13 個 APK** | **`dispatch failed` 全部 0 命中**；同時 `RelayState` / `列印失敗` / `printBytes` 有命中 ⇒ 掃描方法有效，唔係假陰性 |

⇒ **而家機上跑緊嗰個 build，源碼唔喺呢部機。**
要繼續精確定位，必須由用戶提供：部機裝嘅係邊個 APK（檔名／版本／邊度 build 出嚟）。

> ⚠️ 坑：APK 嘅 `classes.dex` 喺 zip 入面係 **DEFLATE 壓縮**，
> 直接 `fs.readFileSync(apk).includes("字串")` **一定掃唔到**（實測連 `RelayState` 都係 n）。
> 必須先解 zip central directory → `zlib.inflateRawSync` → 再掃。工具：`tools/_apk-strings.cjs`。

### 9.5 中繼機喺 01:30:57 之後又靜咗

- 01:34:17 新建嘅 job → 到 01:40 仍然 `pending`、`claimed_by=NULL`
- 最後一次寫入：**01:30:57**

⇒ 活躍窗口得 **01:12 → 01:31（約 18 分鐘）**，之後冇再認領。
最可能：APK 被手動開過／測過一次，退到背景後冇 foreground service 保住（同 09-15 事故 A/C 節同一個病）。

### 9.6 建議（按優先序，全部待批，未動手）

| # | 建議 | 點解 |
|---|---|---|
| **1** | 落葉 job 補打印機快照：寫 `printer` jsonb（或起碼令 `claim` 返真嘅 `printers[]`） | 根治 §9.3 —— 而家中繼機**結構上無可能**可靠揀機 |
| **2** | 由用戶提供機上實裝 APK 檔 | 追唔到 `dispatch failed` 真身嘅唯一方法 |
| **3** | APK 補 foreground service + 開機自啟 + 電池白名單 | 解決 §9.5「一退背景就死」 |
| **4** | claim 失敗／無 perceived 心跳要喺**收銀台 `/`** 可見（現時只有 `/prints` 會顯示） | 今次又係要靠雲端 probe 先發現 |
| 5 | 跑 `0042` migration（分段式 claim 窗口） | 仍然未跑 |

---

## 十、2026-09-16 07:40 突破——**真正根因：打印機唔喺同一網段**

> 用戶 push 之後商米重新上線，雲端**仍然**失敗，但今次夾雜咗一句**完全唔同**嘅錯誤原文，
> 一舉鎖定根因。**唔關 POS 程式事。**

### 10.1 決定性證據（`last_error` 原文）

任務 `01:13:47` 嗰張（重試 5 次）嘅失敗原因係：

```
AGENT_FAILED: 兩種通道都失敗｜
  直連：failed to connect to /192.168.31.38 (port 9100)
        from /10.61.49.153 (port 41752) after 5000ms｜
  SDK：打印機連線失敗（lan 192.168.31.38,9100 → 失敗）
```

呢句話同時講咗三件事：

| 觀察 | 判讀 |
|---|---|
| 目標 = `192.168.31.38:9100` | ✅ APK **正確解析到廚房打印機**（唔係兜底假機）⇒ §9.3 嗰個結構缺陷**今次唔係主因** |
| 來源 = `10.61.49.153` | 🔴 **商米部機嘅 IP**，同打印機**唔同網段** |
| `兩種通道都失敗` | 呢句**只存在於 `print-relay`**（`SdkPrinter.kt:182`）⇒ **商米跑嘅係 `com.macau.printhub` v1.1.4 / versionCode 6**（`C:/dev/print-relay`） |

⇒ **`10.61.49.153` 打唔到 `192.168.31.38:9100`** —— 唔係程式 bug，係**網絡拓撲**問題。

### 10.2 兩個網段點解會唔同

| 網段 | 屬於 |
|---|---|
| `192.168.31.x` | 典型家用路由器網段（小米／TP-Link 預設），**打印機喺呢邊** |
| `10.61.49.x` | 🔴 **典型 iPad／iPhone 個人熱點網段**（iOS Hotspot 預設 `172.20.10.x`；`10.61.x.x` 常見於營運商 CGNAT／流動網絡／其他手機熱點） |

**最可能情境**：商米部機連咗**流動數據或者另一部手機嘅熱點**，
而廚房打印機喺店內 Wi-Fi（`192.168.31.x`）。
兩個網段**互不相通**（冇 routing、打印機亦唔會做 NAT 後嘅反向連線）。

### 10.3 順帶澄清：`dispatch failed` 之謎

- `dispatch failed` 係**另一個 build** 報上嚟嘅（唔喺本機任何 repo／APK 裡，見 §9.4）
  —— 因為商米上**前後裝過兩個唔同嘅 App**（`ag-a4667…` @01:30 vs `ag-f38b08`／`ag-0590816d` @07:35+）
- 而 `兩種通道都失敗｜…` 就**明確可追溯到 `print-relay` v1.1.4**
- ⇒ §9.3「job 冇帶打印機連線資料」呢個**結構缺陷依然存在、依然要修**，
  但**今次事故唔係佢引起**（`printer_id` 有值、`RelayState.deviceConfigPrinters` 拉到配置、IP 解析正確）

### 10.4 為何 `printer` jsonb 恒 NULL

`pos_print_jobs` 寫入（`/api/pos/sync`）只填 `printer_name` / `printer_id`，
**從來冇填 `printer` 快照** ⇒ APK 只能靠 `RouteConfig`（`device-config` 60s 拉一次）攞 IP。
`print-relay` 之後，`ipAddress` 就只有 `RouteConfig` 一個來源（佢已經冇咗 §9.3 講嘅「掃到咩就印咩」兜底）。

### 10.5 修復（**唔使改一行代碼**）

| # | 動作 | 說明 |
|---|---|---|
| **1** | **令商米同打印機連同一個網段** | 部機 Wi-Fi **改連店內同一部路由器**（`192.168.31.x`）；**關掉流動數據**（避免 Android 用 cellular 做 default route 而 Wi-Fi 又斷） |
| 2 | 驗證方法 | 商米「設定 → Wi-Fi → 進階」睇 IP 係咪 `192.168.31.x`；或者喺 App 日誌睇 `兩種通道都失敗｜直連：… from /<IP>` 嘅 `<IP>` 有冇換段 |
| 3 | 之後 | 去 `/prints` 撳「重打整單」試一張（⚠️ 先睇 §9.5：逾 6 分鐘嘅 pending 會**一次過爆紙**，建議先清舊 pending） |

### 10.6 ⚠️ 順帶發現：`device-config` 端點**冇鑑權**（今日新增風險）

實測：

```
GET /api/pos/device-config?storeId=__probe__  →  200 {"ok":true,"deviceConfig":null,"localSettings":null}
```

- 對**唔存在**嘅 storeId 回 200 = early-return 生效（`route.ts:22-24`）
- 但 `route.ts:28` 之後**有** `posRouteAuthGuard` —— 所以「有 storeId 就要憑證」
- 🔴 **問題**：閘前嗰個 early-return **分唔開**「冇 storeId」同「storeId 唔存在」
  ⇒ 攻擊者**無法枚舉**，但同樣**任何知 storeId 嘅匿名請求都會被擋 401**（呢個係好嘅）
- ⚠️ 但 `print-relay` 嘅 `fetchDeviceConfig()`（`RelayApi.kt:221-252`）**完全冇帶任何憑證 header**
  ⇒ 一旦閘收緊到 `storeId` 存在就要驗身，**中繼機就拉唔到路由配置 → 打印機 IP 又會變 NULL → 全店停印**
  ⇒ **呢個係下一粒定時炸彈**，要盡快為中繼機補一條「agent token 可讀 device-config」嘅通道。

### 10.7 待辦（按優先序）

| # | 項目 | 類型 |
|---|---|---|
| **1** | 商米改連店內 Wi-Fi（同打印機同網段） | 用戶操作，**即做** |
| **2** | 為中繼機補 device-config 鑑權通道（agent token） | 代碼，**防定時炸彈** |
| 3 | 落 job 補 `printer` jsonb 快照 | 代碼，根治 §9.3 依賴漂移 |
| 4 | claim 強制檢查「IP 可達性」並回明確錯誤（唔好再出 `dispatch failed` 咁含糊） | 代碼，可觀測性 |
| 5 | 中繼離線／IP 不可達要喺**收銀台 `/`** 可見 | 代碼 |
| 6 | 清舊 pending、跑 `0042` | 維運 |

---

## 十一、2026-09-16 續——`macau-ledger-merchant` 配對流程審查（源碼級）

**審查對象**：`C:\Users\surface\Desktop\macau-ledger-merchant.zip`
（`applicationId = com.macauledger.merchant`、`versionCode 16`、`versionName 1.1.10`）

**✅ 已驗證：zip 與本機參考目錄 `C:\dev\_ref-macau-ledger-merchant` 逐檔位元組一致** —
85 個 `.kt/.kts/.xml/.pro/.json` 全部 `Buffer.compare === 0`，0 個不同、0 個缺失。
⇒ 下文本地行號**直接對應**你在商米上跑的那個 build。

> 註：zip 係**源碼包**（163 entries，冇 `classes.dex`、冇 `META-INF`），
> 所以**讀唔到 `BuildConfig.POS_URL` 嘅實際值**（`BuildConfig` 係 build 期生成）。
> 下面的 §11.6 就係圍繞呢個盲區。

### 11.1 一句話結論

**配對邏輯本身寫得相當穩健，唔係今次打印失敗的成因。**
`dispatch failed`（= §9.2 那條 `AGENT_FAILED: dispatch failed`）出喺 **`dispatchPrint()` 回 false**，
即 `LanTcpPrinter.send()` 連唔上 `192.168.31.38:9100` —— **同 §10 已鎖定的跨網段問題一致**。

**但配對子系統有 3 個真問題要修**，其中 ① 係**潛在「整個堂食 POS 功能靜默失效」**級：

| # | 問題 | 嚴重度 | 一句話 |
|---|---|---|---|
| **①** | **`POS_URL` 在三個實戰 env 檔全部缺失** | 🔴 高 | `BuildConfig.POS_URL = ""` → 直接 `配對失敗：POS 雲端未設定`，通道**永遠唔會啟動** |
| **②** | **dispatch 失敗原因被吞掉**（硬編碼 `"dispatch failed"`） | 🔴 高 | 雲端永遠睇唔到「connection refused / timeout / unknown host」 | 
| **③** | `clearPairing()` **唔清 `KEY_ENABLED`** + `getPair` 永遠回 `pending` | 🟡 中 | 令「解除配對」按鈕實際行為 = 立刻重配；亦係 §5 那條「配對失敗→面板顯示→流程停擺」誤判之根源 |

### 11.2 配對流程實作方式（完整鏈路）

**設計取向：無 PIN、無配對碼、零人工輸入。**
APK 用「已登入的 Ledger `merchantId`」直接當 `posStoreId` 自註冊，POS 側
`POST /pair` 只做「認唔認這個 storeId」，`GET /pair` 回傳 POS 專案的 Supabase 憑證。

```
① PrinterService.onCreate()
   └─ initPosRelay()                          PrinterService.kt:59-70
      └─ PosRelaySession(...).startObserving()      :69

② startObserving()                           PosRelaySession.kt:65-85
   ├─ hydrateEnabledFromPrefs()               :59   → 讀 pos_relay_enabled（預設 false）
   ├─ PosRelayState.refreshLocalIps()         :69
   ├─ AppSession.merchant
   │    .map { merchantIdOrPersisted(it?.merchantId) }   :71-74
   │    .distinctUntilChanged().collect { syncForMerchant(it) }
   └─ PosRelayState.enabled.collect { ... }   :76-84  → 開關一擰即 syncForMerchant

③ syncForMerchant(merchantId)                :170-181
   ├─ !isEnabled()            → stopChannel(status="未啟用")
   ├─ merchantId 空           → stopChannel(unpair=true, status="未登入")
   └─ 否則                    → startPosRelayIfReady(merchantId)

④ startPosRelayIfReady(merchantId)           :183-236  ← ★配對總閘
   ├─ :201  if (BuildConfig.POS_URL.isBlank())  → status="配對失敗：POS 雲端未設定" ⛔ 直接返回
   ├─ :206  if (now < pairCooldownUntil)        → status="配對冷卻中" + schedulePairRetry
   ├─ :214  restorePairing(merchantId)          ← 先試開機恢復
   ├─ :216  autoPair(merchantId, storeName)     ← 失敗才自註冊
   ├─ :227  runner.start()     → 60s 對賬 + 30s 心跳 + 15s 狀態刷新
   ├─ :228  realtime.start(merchantId)
   ├─ :229  acquireWifiLock()
   └─ :232  status = "已連線"

⑤ PosPairingManager.autoPair()               PosPairingManager.kt:13-44  ← ★配對核心
   ├─ :14-15  agentId = prefs.getAgentId()    ?: "ag-" + 16 bytes hex
   │          agentToken = prefs.getAgentToken() ?: 32 bytes hex
   ├─ :16     relayApi.postPair(agentId, agentToken, ledgerMerchantId, storeName)
   │            └─ POST /api/pos/print-agent/pair
   │               標頭 x-agent-id / x-agent-token；body {agentId,token,storeId,name}
   │               ⚠️ 只認 resp.optBoolean("ok", false) === true（RelayApi.kt:61）
   ├─ :19     relayApi.getPair(agentId)
   │            └─ GET /api/pos/print-agent/pair?agentId=…
   ├─ :20-22  status != "paired"                    → fail(error ?: "配對尚未完成")
   ├─ :23-24  storeId 空                            → fail("配對回應缺少 storeId")
   ├─ :25-29  storeId != ledgerMerchantId           → fail("POS storeId 與本店不符，已拒絕") ★防串店
   ├─ :30-34  url/anonKey 任一空                    → fail("配對失敗：POS 雲端未設定")
   ├─ :35-37  urlsEqual(url, BuildConfig.SUPABASE_URL) → fail("配對失敗：POS 雲端未設定") ★防打Ledger
   ├─ :39     PosRelayClient.init(url, anonKey)     ← 建 POS Supabase 客戶端
   ├─ :40     prefs.savePairing(...)                ← EncryptedSharedPreferences
   └─ :43     Result.success(PairingResult(storeId, url, anonKey))

⑥ 通道起來後（PosJobRunner.kt:42-96）
   ├─ tickJob      :74-95   先 refreshDeviceConfig()，之後每 60s tickOnce()
   ├─ heartbeatJob :60-73   每 30s heartbeatOnce()
   └─ statusJob    :48-59   每 15s PosRelayState.touchRunningStatus()

⑦ Realtime 叫醒（PosRealtimeSubscriber.kt:75-129）
   channel "pos-print-jobs-$posStoreId"，filter store_id EQ posStoreId
   flow.collect { onWake() } → runner.onRealtimeWake() → tickOnce()
   ⚠️ 只叫醒，唔解析 payload 出紙（設計如此，避免重複出紙）
```

### 11.3 關鍵邏輯：五道防線（值得保留的設計）

| 防線 | 位置 | 作用 |
|---|---|---|
| **A. `POS_URL` 空就唔配** | `PosRelaySession.kt:201` | 避免對空 host 發請求 |
| **B. 只認 `ok:true`** | `RelayApi.kt:61` | `POST /pair` 任何非明確成功都視為失敗（**fail-closed**） |
| **C. `storeId` 必須等於本店 merchantId** | `PosPairingManager.kt:25-29` | **防串店**——就算 POS 回錯 storeId 都唔會將別店訂單拉落自己機 |
| **D. POS Supabase URL 唔可以等於 Ledger URL** | `PosPairingManager.kt:35-37`、`61-63`、`71` | **防配置漂移**——Ledger 專案冇 `pos_*` 表，連錯就全靜默（呢個正正係 docs/92 的歷史坑） |
| **E. `url`/`anonKey` 必須成對非空** | `PosPairingManager.kt:32-34` | 避免半套憑證 |

另外 `restorePairing()`（`:49-77`）的**開機恢復**設計也對：
- `:55-60` `posStoreId != persistedMerchantId` → 清本地配對 + `shutdown()` → 返回 false（換店唔會誤用舊憑證）
- `:65-68` 仍然**線上** `getPair` 覆核一次（唔盲信本地快取）
- `:69-70` 線上值優先，本地值兜底

`onAgentUnauthorized()`（`PosRelaySession.kt:238-270`）也合理：
401 → 清配對 → 立刻重配；**連續 3 次**才進入 **5 分鐘冷卻**（`UNAUTHORIZED_COOLDOWN_AFTER = 3`、`PAIR_COOLDOWN_MS = 300_000`）——
避免對端壞掉時打出無限重配風暴。

### 11.4 🔴 問題 ①：`POS_URL` 在三個實戰 env 檔全部缺失（**已被 §12.3 推翻為「非本次根因」**）

> 🔴🔴 **2026-09-16 09:30 更正 —— 本節結論對「本次這個部署」唔成立。**
> 原文推論「`BuildConfig.POS_URL == ""` ⇒ 永久 `配對失敗：POS 雲端未設定`」在**邏輯上正確**，
> 但 **Step 0 判別（§12.6）已證實 `claimed_by` 有值** ⇒ 歷史上**曾經**配對成功
> ⇒ 呢個 APK **必然**有非空 `POS_URL`（否則連第一次 `postPair` 都去唔到）。
> **⇒ 本次現象係「路徑 2」（`PosPairingManager.kt:33/36`，Vercel 側憑證缺），唔係本節嘅路徑 1。**
> 🔴🔴 **09:10 再修正：連「路徑 2」都唔成立** —— 實測 `GET /pair` 兩欄有值（**§13.1**）。
> 真兇係 `restorePairing()` 見 `status=pending` 靜默失敗（**§13.2**）。**請以 §十三 為準。**
>
> 📌 本節仍然**有價值**，但降級為「**潛在風險**」而非「本次根因」：
> - 若將來換 build 機、清 `local.properties`、或換 flavor，**「三個實戰 env 都冇 `POS_URL`」會真係踩中**。
> - 建議補上（§12.9 動作 11），但**唔會**解決今日嘅問題。
> - `loadProjectEnv`「只讀第一個存在嘅檔」係**真**嘅缺陷，值得記住。

**證據鏈（逐檔實測 key 清單）：**

| 檔案 | key 數 | 有 `POS_URL`？ |
|---|---|---|
| `.env.example` | 13 | ✅ 有（`https://macau-pos-system.vercel.app`） |
| `.env.local` | 12 | ❌ **冇** |
| `.env.prod.local` | 12 | ❌ **冇** |
| `.env.uat.local` | 12 | ❌ **冇** |

**Gradle 側（`app/build.gradle.kts`）：**

```kotlin
// :11-26  ★關鍵：只讀「第一個存在的檔」，唔會合併
fun loadProjectEnv(preferredFile: String): Map<String, String> {
    val envFile = sequenceOf(preferredFile, ".env.local")
        .map { rootProject.file(it) }
        .firstOrNull { it.exists() }        // ← 只揀一個
        ?: return emptyMap()
    ...
}
// :55    val posUrl = env["POS_URL"].orEmpty()      ← 冇 key → ""
// :66    buildConfigField("String", "POS_URL", "\"${posUrl.escapeForBuildConfig()}\"")
```

`prod` flavor 傳入 `.env.prod.local`，**該檔存在** ⇒ `firstOrNull` 就揀咗它，
**永遠唔會 fallback 去 `.env.local`**。而 `.env.prod.local` 冇 `POS_URL`
⇒ **`BuildConfig.POS_URL == ""`**。

**後果（`PosRelaySession.kt:201-204`）：**

```kotlin
if (BuildConfig.POS_URL.isBlank()) {
    PosRelayState.setStatus("配對失敗：POS 雲端未設定")
    return@withLock                     // ← 通道永不啟動
}
```

⇒ 設定頁「堂食 POS」狀態**永遠**顯示 `配對失敗：POS 雲端未設定`，
`runner.start()` / `realtime.start()` / `acquireWifiLock()` 全部唔會執行，
**唔會有心跳、唔會有 claim**。而 `schedulePairRetry` 亦**唔會被叫**（呢條 return 在 `:221` 之前）
⇒ **唔會自動恢復，需要人手改 env 重新 build**。

**⚠️ 但必須注意一個矛盾（唔可以就此落結論）：**

`docs/POS_RELAY.md` 係 v1.1.8+ 文件，而呢個 build 係 **v1.1.10** ——
文件描述配對流程寫得咁詳盡，**暗示實際發行的 APK 應該係有 `POS_URL` 的**。
可能情況：
1. 商米上跑嘅其實係 `.env.local`（冇 flavor 或 `assembleDebug`）build → 但 `.env.local` 都冇 `POS_URL`；
2. build 機上有**另一份未進 zip 的 `.env.local`**（`.env.local` 係 gitignored，**唔應該**進源碼包）；
3. 曾經用過 `POS_URL` 有值嘅 env，之後被清走。

**⇒ 驗證方法（5 秒，唔使拆 APK）：**
去商米「設定 → 堂食 POS」睇狀態文字。

| 顯示 | 判讀 |
|---|---|
| `配對失敗：POS 雲端未設定` | 🔴 **命中問題 ①**，`POS_URL` 真係空 |
| `已連線` / `配對中…` / `未啟用` 等其他字 | ✅ `POS_URL` 有值，① 唔成立，`dispatch failed` **純粹係 §10 網絡問題** |

（若想 100% 確定，可喺 build 機執行
`node -e "console.log(require('fs').readFileSync('app/build/generated/source/buildConfig/prodRelease/com/macauledger/merchant/BuildConfig.java','utf8').match(/POS_URL.*/)[0])"`
讀生成檔，或直接 `grep POS_URL app/build/generated/**/BuildConfig.java`。）

**修法（唔改一行 Kotlin）：** 在 `.env.prod.local` 與 `.env.uat.local` 各補一行

```
POS_URL=https://macau-pos-system.vercel.app
```

> ⚠️ 注意 `.env.example:55-57` 已明示：「v1 prod／uat **同一 URL**。UAT APK 打正式 POS；
> 若該 POS 連正式 Ledger，UAT 商戶配對會失敗（不另做 UAT POS）」——
> 即兩個 flavor 都填同一個正式 POS URL 係**預期行為**。

### 11.5 🔴 問題 ②：dispatch 失敗原因被完全吞掉（可觀測性缺陷）

呢個就係**今次事故查咗幾個鐘嘅結構性原因**。

**三層資訊衰減：**

```kotlin
// 第一層：LanTcpPrinter.kt:27-30  —— 有原因，但只寫本機 log
} catch (e: Exception) {
    PosRelayState.log("LAN 打印失敗 ${ip}:${port}: ${e.message}")
    false                                   // ← 只回 Boolean，e.message 就此消失
}

// 第二層：PosPrintDispatcher.kt:9-26  —— 一樣只回 Boolean
fun dispatch(dto: PrintJobDto, cfg: PrinterCfgDto): Boolean { ... }

// 第三層：PosJobRunner.kt:236-248  —— 硬編碼常數字串上報雲端
for (i in 0 until copies) {
    if (!dispatchPrint(dto, cfg)) { success = false; break }
    if (i < copies - 1) delay(600)
}
if (success) { ... relayApi.report(..., "sent", null) }
else {
    rollbackPendingPrint(dedupKey)
    relayApi.report(agentId, agentToken, dto.id, "failed", "dispatch failed")  // ← ★:247
}
```

⇒ **雲端 `pos_print_jobs.last_error` 永遠只會係 `AGENT_FAILED: dispatch failed`**，
分唔清以下四種完全唔同的故障：

| 實際故障 | 現時上報 | 應該上報 |
|---|---|---|
| TCP `ECONNREFUSED`（打印機關機／port 唔開） | `dispatch failed` | `LAN 192.168.31.38:9100 連線被拒` |
| TCP timeout（**跨網段，今次情況**） | `dispatch failed` | `LAN 192.168.31.38:9100 連線逾時（5s）` |
| `sunmi.sendRaw()` 失敗（AIDL 未綁定） | `dispatch failed` | `Sunmi 內建打印機未連接` |
| `UnknownHostException`（IP 格式錯） | `dispatch failed` | `無法解析主機 x.x.x.x` |

**同 `print-relay` 對比就更明顯**（`C:\dev\print-relay\...\SdkPrinter.kt:182`）：

```kotlin
IOException("兩種通道都失敗｜直連：$rawErr｜SDK：${sdk.exceptionOrNull()?.message}")
```

⇒ 就係因為呢一句，§10 才能**一次過**睇出「`192.168.31.x` vs `10.61.x.x` 唔同網段」。
`macau-ledger-merchant` **冇呢個能力**。

**建議改法（3 個小 diff）：**

```kotlin
// 1) LanTcpPrinter.kt —— 回傳原因
object LanTcpPrinter {
    data class SendResult(val ok: Boolean, val error: String? = null)
    fun send(ip: String, port: Int = 9100, data: ByteArray): SendResult {
        if (ip.isBlank()) return SendResult(false, "IP 為空")
        if (port <= 0 || port > 65535) return SendResult(false, "port 非法 $port")
        return try {
            Socket().use { socket ->
                socket.soTimeout = TIMEOUT_MS
                socket.connect(InetSocketAddress(ip, port), TIMEOUT_MS)   // ← 可分辨 refused / timeout
                socket.getOutputStream().apply { write(data); flush() }
            }
            Thread.sleep(150)
            SendResult(true)
        } catch (e: java.net.SocketTimeoutException) {
            SendResult(false, "LAN $ip:$port 連線逾時（${TIMEOUT_MS / 1000}s）— 檢查是否同一網段")
        } catch (e: java.net.ConnectException) {
            SendResult(false, "LAN $ip:$port 連線被拒 — 打印機未開機或 port 9100 未開")
        } catch (e: Exception) {
            SendResult(false, "LAN $ip:$port 失敗：${e.javaClass.simpleName} ${e.message}")
        }
    }
}

// 2) PosPrintDispatcher.kt —— 把原因傳出去（LAN 直連 + Sunmi 兩條路）
// 3) PosJobRunner.kt:247 —— "failed" 的 error 參數改為真實原因
relayApi.report(agentId, agentToken, dto.id, "failed", lastDispatchError ?: "dispatch failed")
```

> 呢個改動**同時令 `classifyPrintJobFailure()`（`src/lib/print-job-failure.ts`）有意義** ——
> 現時 6 個原因碼在 `AGENT_FAILED` 分支下永遠只能收到同一個字串。
> （POS 側已 `error.take(300)` 截斷，`result/route.ts:77` 亦已 `slice(0, 300)`，容量足夠。）

### 11.6 🟡 問題 ③：`clearPairing()` 唔清 `KEY_ENABLED`（設計如此，但 UI 語意會誤導）

```kotlin
// PosRelayPrefs.kt:48-56
fun clearPairing() {
    sp.edit()
        .remove(KEY_AGENT_ID)
        .remove(KEY_AGENT_TOKEN)
        .remove(KEY_POS_STORE_ID)
        .remove(KEY_SUPABASE_B_URL)
        .remove(KEY_SUPABASE_B_ANON_KEY)
        .apply()                    // ← 冇 remove(KEY_ENABLED)
}
```

配合 `unpairFromUi()`（`PosRelaySession.kt:94-101`）的註解本身就寫明係刻意：
「設定頁解除配對：清憑證；**開關仍開則重新自動配對**」。

**⇒ 行為鏈：** 撳「解除配對」→ 清憑證 → `:98-100` 見 `isEnabled()` 仍為 true → 立刻 `syncForMerchant()`
→ `startPosRelayIfReady()` → `autoPair()` → **幾百毫秒內又配返**。

**副作用（真實困擾）：**
1. 用戶撳「解除配對」想**停掉**堂食 POS，結果機照跑 ⇒ 以為「解除冇效」。
2. 想「先解除、改 POS 側設定、再配」的運維流程做唔到 —— 一撳就即刻重配，永遠卡住中間態。
3. 呢個亦係 §5 記錄嘅「面板顯『配對失敗』→ 配對流程自己停擺」現象的**放大器**：
   當 `getPair` 有問題時，`autoPair` 失敗 → `schedulePairRetry` 15s 後再試 → 循環，
   用戶只見到狀態字串不斷跳。

**建議：** 「解除配對」應該**一併**把開關撥到 off（或加一個 confirm dialog 明示「將同時停用堂食 POS」）。
如要保留現行為，至少按鈕文案應改為**「重新配對」**，避免語意誤導。

### 11.7 🟡 問題 ④：`RelayApi.claim()` 的錯誤形狀判定過於寬鬆

```kotlin
// RelayApi.kt:124-137
val resp = post(...) ?: return@withContext ClaimResult(emptyList(), emptyList(), "claim 連線失敗")
if (resp.optString("error").contains("HTTP 401")) { ... unauthorized = true }
val err = resp.optCleanString("error")
if (err != null && !resp.optBoolean("ok", true)) {   // ← ok 缺席時默認為 true
    return@withContext ClaimResult(emptyList(), emptyList(), err)
}
ClaimResult(jobs = resp.optJSONArray("jobs").toObjectList(), ...)
```

- `:130` `optBoolean("ok", true)` —— **默認 true**（與 `postPair` 的 `optBoolean("ok", false)` 相反！）
  ⇒ 若雲端回 `{"error":"..."}`（冇 `ok` 欄）就會判定為「唔係錯誤」，然後 `jobs` 缺席 → 當成空列。
  **兩種 fail 語意不一致，建議統一為 `false`。**
- `:126` 靠 `error` 字串 `contains("HTTP 401")` 判鑑權失敗 —— 依賴 `post()` 在
  `:236` 把 `HTTP ${code}` 塞入 `error` 欄。若日後改了錯誤格式，**401 判定會靜默失效**。

### 11.8 ⚠️ 問題 ⑤：`RelayApi.post()` 把所有例外壓成 `null`（同上，可觀測性）

```kotlin
// RelayApi.kt:229-241
return try {
    client.newCall(req).execute().use { resp -> ... }
} catch (_: Exception) {
    null                                    // ← DNS 失敗 / TLS 失敗 / timeout 全部變 null
}
```

所有呼叫端只能回報**泛化字串**：
- `postPair` → `"配對連線失敗"`（`:60`）
- `claim` → `"claim 連線失敗"`（`:125`）
- `heartbeat` → `HeartbeatResult(ok=false)`（`:172`，**連 error 欄都冇**）

⇒ `POS_URL` 打錯 host、憑證過期、TLS 憑證問題……全部顯示同一句話。
**建議** `post()` 改回傳 `Result` 或 `Pair<JSONObject?, String?>`，帶上 `e.javaClass.simpleName + e.message`。

### 11.9 邊界情況清單（值得記住）

| # | 邊界 | 現時行為 | 備註 |
|---|---|---|---|
| 1 | `pos_relay_enabled` 預設 = **false** | 新裝／清資料後唔會自動配對 | 需人手在設定頁開 | 
| 2 | 換店（`activeStoreId != merchantId`） | `stopImmediate` + `shutdown` + `clearLocalPairing` + `notifyCloudUnpair`（`:195-200`） | ✅ 乾淨 |
| 3 | 快速登出→再登入（agent 已換） | **只**通知雲端解除舊 agent，**唔拆**新通道（`:122-124`） | ✅ 防誤拆 |
| 4 | `agentId` 已存在但 `posStoreId` 換了 | `restorePairing` 返回 false（`:55`）→ 走 `autoPair` | `agentId` 會**重用**（唔會重新生成） |
| 5 | `getPair` HTTP 500 | `PairPoll(status="error", error="HTTP 500 …")`（`RelayApi.kt:79-87`） | 被判為「未配對」而非「服務壞」 |
| 6 | `getPair` 對**不存在的 agentId** | 永遠回 `pending`（API 行為） | ⇒ **證明唔到 env 有值**，唔可以當健康檢查 |
| 7 | `Realtime` 持續斷線 | 45s 後拋 `IllegalStateException` 重訂，backoff 5s→60s（`PosRealtimeSubscriber.kt:38-56`、`:106-108`） | ✅ 有退避 |
| 8 | 心跳／對賬連續失敗 3 次 | `onUnhealthy()` → `restartChannel()`，但 **30s 冷卻**（`:272-278`） | 冷卻內**靜默略過**（只寫 log） |
| 9 | `runner.processJob` 逐單 try/catch | 單張出錯只 fail 該單，迴圈繼續（`PosJobRunner.kt:180-192`） | ✅ 正確 |
| 10 | `copies` | `(dto.copies ?: cfg.copies ?: 1).coerceIn(1, 5)`，多份之間 `delay(600)` | 上限寫死 5 |
| 11 | 去重 key | `pos:{id}:{printerGroup ?: "receipt"}:{ticketType ?: "normal"}`；`id` 空時用 `System.nanoTime()` ⇒ **空 id = 永不去重**（`PosPrintDedup.kt`） | 但 `processJob` 已有 `dto.id.isBlank()` 早退（`:223-226`） |
| 12 | `dedupKey` 已存在 | **直接報 `sent`**（`PosJobRunner.kt:228-231`） | ⚠️ 即「本次冇出紙但報成功」—— 重啟後舊 job 重 claim 會靜默收割 |
| 13 | `printedKeys` 上限 400（`PrinterService.kt:241-243`） | 超限逐個淘汰最舊 → **可能重印舊單** | 只有 400 個槽，繁忙店要留意 |
| 14 | `WifiLock` | `WIFI_MODE_FULL_HIGH_PERF`，`setReferenceCounted(false)`（`PosRelaySession.kt:318-326`） | 但**唔會**強制 Wi‑Fi 做 default network ⇒ 關流動數據仍然必要 |
| 15 | `printTestTicket()` | **完全唔經 runner**，直接 `sunmi.sendRaw(renderTestPage(SUNMI_FALLBACK, …))`（`:146-153`） | ⇒ 「堂食測試印」成功**唔代表**配對／claim／LAN 通！ |
| 16 | `SUNMI_FALLBACK` 兜底 | 冇匹配打印機時靜默改打機身內建 | `PosJobRunner.kt:272`、`PosPrintDispatcher.kt:20-25`；⚠️ 會令人誤以為「印到」 |

> **#15 特別重要**：設定頁嗰個「堂食測試印」按鈕係**繞過整條雲端鏈路**的。
> 店員按完見到出紙，會以為「配對正常」；實際 `POS_URL` 可能係空、claim 可能從未成功。
> ⇒ 建議「堂食測試印」加印一行明確標示通道狀態（例如 `POS_URL: <值或(空)> / 通道: <status>`）。

### 11.10 對比：`macau-pos` ↔ `macau-ledger-merchant` 打印配對方法

| 維度 | **macau-pos**（Vercel：`macau-pos-system.vercel.app`） | **macau-ledger-merchant**（商米 APK） | 一致？ |
|---|---|---|---|
| **配對發起方** | 被動：提供 `POST /pair`、`GET /pair`、`/unpair` | 主動：用 Ledger `merchantId` 自註冊 + 輪詢 `GET /pair` | ✅ 契約一致 |
| **`storeId` 定義** | 由請求帶入的 `storeId` | = 已登入的 Ledger `merchantId` | ✅ 語意一致 |
| **鑑權憑證** | 簽發並記錄 `agentId` + `agentToken` | `x-agent-id` / `x-agent-token` 標頭 | ✅ 一致 |
| **憑證儲存** | DB（`pos_print_agents`） | `EncryptedSharedPreferences("macau_merchant_pos")`（`AES256_SIV` / `AES256_GCM`） | ✅ 合理 |
| **配對碼／PIN** | 冇 | 冇 | ✅ 一致 |
| **雲端憑證下發** | `GET /pair` 回 `supabaseUrl` + `anonKey` | `PairingManager.kt:39` `PosRelayClient.init(url, anonKey)` | ✅ 一致 |
| **防打錯 Ledger 專案** | 伺服器側無此概念 | `PairingManager.kt:35-37` 比對 `BuildConfig.SUPABASE_URL` 並拒絕 | ⚠️ **只有 APK 側有** |
| **`POS_URL` 來源** | N/A（本身係 POS） | `BuildConfig.POS_URL` ← env 檔 | 🔴 **三個實戰 env 檔都冇** |
| **心跳** | 收 `POST /heartbeat`，寫 `ipAddress`/`ipAddresses` | 每 30s 發一次（`PosJobRunner.kt:60-73`） | ✅ |
| **認領** | `POST /claim`（`limit=5`） | 60s 對賬 + Realtime 叫醒觸發（`:161-166`、`PosRealtimeSubscriber`） | ✅ |
| **claim 回傳 `printers`** | 🔴 **硬編碼 `[]`**（`claim/route.ts:42`） | 靠 `device-config` 60s 拉路由表補足（`PosJobRunner.kt:210-214`） | ⚠️ **兩邊靠不同來源，易漂移** |
| **job 帶 `printer` 快照** | 🔴 寫入時**從來冇填** `printer` jsonb | `resolvePrinter()` 第 1 順位就是 `row.printer` ⇒ 永遠落空（`:256`） | ⚠️ **結構缺陷（§9.3）** |
| **出口分流** | N/A | `lan`+IP → TCP:9100；本機 IP → Sunmi `sendRaw`；`usb`/`bt`/無 IP → `SUNMI_FALLBACK` | ✅ |
| **失敗原因上報** | 只收到 `AGENT_FAILED: <300字>` | 🔴 **硬編碼 `"dispatch failed"`**（`PosJobRunner.kt:247`） | 🔴 **不對稱** |
| **結果回報** | `POST /result`（`sent`/`failed`） | `relayApi.report(...)`（`:244`、`:247`、`:229`、`:189`） | ✅ |
| **401 處理** | `error` 含 `HTTP 401` | 清配對 → 重配；3 次後冷卻 5min | ✅ |
| **對比 `print-relay`** | — | `print-relay` 有 `兩種通道都失敗｜直連：…｜SDK：…`（`SdkPrinter.kt:182`） | 🔴 **`macau-ledger-merchant` 落後** |

### 11.11 ✅ 結論：對比結果 —— **唔係配對方法引起打印不成功**

逐點核對：

1. **配對鏈路曾經成功走完。** §9.1 實測到 `claimed_by = ag-a466746da8946cd1421916043eb643e1`、
   `claimed_at = 01:30:55` —— 能 claim 就證明**當時** `agentId`/`agentToken` 有效、`storeId` 匹配、
   POS Supabase 憑證已下發並成功建 client。
   ⚠️ **但要注意時間軸（§12.3 更正）**：呢啲 `claimed_by` 屬**過去**嘅活躍窗口
   （01:30 / 07:35 / 08:30），**唔代表**目前這個 app 實例仍配對成功 —— 佢現正處於
   「路徑 2 配對失敗」。**正確講法**：配對*邏輯*冇問題，但**目前這台機嘅配對握手在失敗**。
   （唯一可靠判別仍然係「有冇任何 `claimed_by` 非 NULL 行」＝路徑 2。）

2. **打印機解析正確。** §10.1 的 `last_error` 原文：
   `兩種通道都失敗｜直連：failed to connect to /192.168.31.38 from /10.61.49.153`
   —— 目標 `192.168.31.38:9100` 正是正確的 LAN 打印機。
   `resolvePrinter()`（`PosJobRunner.kt:251-273`）的
   `row.printer`（空）→ `dto.printer`（空）→ `routingPrinters`（**命中**）三段判斷**運作正常**。

3. **`dispatch failed` 的唯一可能來源。** 因為 §2 已命中，所以 `dispatchPrint()`
   入到 `PosPrintDispatcher.kt:18` 的 `LanTcpPrinter.send("192.168.31.38", 9100, bytes)`
   → `:27` catch → `false`。**純網絡層不可達**（跨網段），與 §10 完全一致。

4. **`macau-pos` 側亦無配對缺陷。** `src/app/api/pos/print-agent/*` 的
   `pair` / `claim` / `result` / `heartbeat` 四個端點職責清晰；
   `resolveRelayRealtimeConfig()` 拒絕 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`（= Ledger）**是正確設計**。

**⇒ 今次「打印不成功」的根因：商米機（`10.61.49.153`）與打印機（`192.168.31.38`）唔係同一網段。**
配對層面唯一要修的是 **§11.4 的 `POS_URL` 缺失** —— 但那是**另一個獨立風險**，
唔會產生 `dispatch failed`（若 `POS_URL` 為空，連 claim 都唔會發生，雲端只會見到「未認領 0 張」而唔會見到 `已認領未回報`）。

> **呢句就係最好的判別式（但只判「路徑 1 vs 2」，唔判「現在係唔係成功」）：**
> 你截圖嗰陣顯示「**已認領未回報（試 N 次）**」
> ⇒ 表示**過去某時**通道確實有跑、claim 確實成功過
> ⇒ **`BuildConfig.POS_URL` 必然係有值**（否則 claim 無從發生）
> ⇒ **§11.4 問題 ① 在此次部署中唔成立**（但仍然建議補上 env 作防禦）。
>
> ⚠️ **唔可以**由此推出「配對現在正常」 ——
> 08:42／08:54 兩張新 job 係 `attempts=0`、`claimed_by=NULL`，證明**現在**冇 claim 成功。
> **⇒ 正確結論：APK 側冇問題，問題在 Vercel 側憑證（§12.3／§12.6 Step A）。**
> 🔴🔴 **09:10 修正：Vercel 都已實測排除** —— `GET /pair` 兩欄有值（**§13.1**）。
> 真正卡點係 `restorePairing()` 見 `GET /pair` 回 `pending` 就靜默 `return false`（**§13.2**）。

### 11.12 待辦（合併 §10.7，按優先序）

| # | 項目 | 類型 | 狀態 |
|---|---|---|---|
| **1** | 商米改連店內 Wi‑Fi（同打印機同網段）＋ 關流動數據 | 用戶操作 | 🔴 **即做（真根因）** |
| 2 | 為 `.env.prod.local` / `.env.uat.local` 補 `POS_URL`（防禦性） | 配置 | 建議做 |
| 3 | `LanTcpPrinter` / `PosPrintDispatcher` 回傳真實錯誤，`PosJobRunner:247` 上報（§11.5） | 代碼 | 高優先（可觀測性） |
| 4 | 為中繼機補 device-config 鑑權通道（agent token）（§10.6） | 代碼 | 防定時炸彈 |
| 5 | 落 job 補 `printer` jsonb 快照（§9.3／§10.4） | 代碼 | 根治依賴漂移 |
| 6 | `RelayApi.claim()` 的 `optBoolean("ok", true)` 改 `false`；`post()` 保留例外原因（§11.7／§11.8） | 代碼 | 中優先 |
| 7 | 「解除配對」一併關開關，或改文案為「重新配對」（§11.6） | 代碼／文案 | 中優先 |
| 8 | 「堂食測試印」加印通道狀態，避免店員誤判（§11.9 #15） | 代碼 | 中優先 |
| 9 | 中繼離線／IP 不可達要喺**收銀台 `/`** 可見 | 代碼 | 中優先 |
| 10 | 清舊 pending、跑 `0042` | 維運 | 待做 |

---

## 十二、2026-09-16 08:58 用戶新截圖——**狀態矛盾嘅真正機制**（推翻 §11.4 的判讀）

### 12.1 用戶提供嘅截圖事實

設定頁同時顯示：

```
外賣: 已連線 | 堂食POS: 配對失敗：POS 雲端未設定      ← App 通知欄／狀態列
...
堂食 POS
  啟用堂食 POS        [開]
  店名：—
  狀態：配對失敗：POS 雲端未設定
```

而 `/prints` 顯示 **11 張未完成（未認領 2 張、已認領未回報 4 張…）**，
兩行 `訂單01（重打）` 同時有 **`●已發送`（綠）＋ `▲雲端未認領`（橙）**。

### 12.2 🔴 兩個狀態**唔係矛盾** —— 佢哋嚟自兩條完全獨立嘅通道

| 顯示項 | 真源 | 管乜嘢 |
|---|---|---|
| **雲端通道：已連線** | `AppState.mqttStatus`（`PrinterService.observeMerchantForMqtt()`） | **外賣** MQTT 保險通道 |
| **堂食POS：配對失敗…** | `PosRelayState.status`（`PosRelaySession`） | **堂食 POS** 打印中繼 |

通知欄文案係兩者拼接（`PrinterService.kt:74-76`）：

```kotlin
combine(AppState.mqttStatus, PosRelayState.status) { mqttStatus, posStatus ->
    "外賣: $mqttStatus | 堂食POS: $posStatus"
}
```

⇒ **「外賣已連線 ＋ 堂食POS 失敗」係完全正常嘅組合**，兩條通道互不影響。
用戶以為「矛盾」，係因為將「雲端通道」誤讀成「POS 雲端」。

> ⚠️ 呢個**文案設計本身有誤導性**：`外賣: … | 堂食POS: …` 一眼睇落似同一個系統，
> 實際係兩個獨立子系統。建議改為 `外賣通道: … ｜ 堂食POS通道: …` 並在失敗時加 ⚠️。

### 12.3 🔴🔴 真正嘅卡點：`配對失敗：POS 雲端未設定` —— **兩條路徑，必須先分清**

**先修正 §11.11 嘅錯判。** 我之前用「已認領未回報」推論「`POS_URL` 必有值，所以 §11.4 唔成立」——
**個推論錯**：`claimed_by` 有值嘅係**舊 agent**（`ag-0590816d…` @08:30、`ag-f38b08c…` @07:35），
而**當前** App 實例已經係**重新配對失敗**狀態。兩者係**唔同時段**嘅事：

| 時間（澳門） | 事件 | 證據 |
|---|---|---|
| 01:30:55 | `ag-a4667…` claim 3 張，報 `dispatch failed` | §9.1 |
| 07:35:56 | `ag-f38b08c…` claim 1 張，報 `兩種通道都失敗｜10.61→192.168.31` | §10.1 |
| 08:30:35 | `ag-0590816d…` claim 3 張，報 `dispatch failed` | 本次實測 |
| **08:42 / 08:54** | **2 張新 job，`claimed_by=NULL`、`attempts=0`** | 本次實測 🔴 |
| 08:58 | 用戶見「配對失敗：POS 雲端未設定」 | 用戶截圖 |

⇒ **08:30 之後中繼機就冇再 claim 過**，而 08:42/08:54 兩張新單**完全冇人碰**
（`attempts=0` ＝ 連一次都冇認領過，唔係「碰完失敗」）。

#### 🔴 但呢句字串有**兩條產生路徑**，排查方向完全相反

全 `posrelay` 套件 grep `雲端未設定` → **只有 4 處**，分屬兩條路徑：

| 路徑 | 位置 | 觸發條件 | 有冇打過伺服器 | 修邊邊 |
|---|---|---|---|---|
| **路徑 1**（早退） | `PosRelaySession.kt:202` | `BuildConfig.POS_URL.isBlank()` → **直接 return** | ❌ **完全冇** | 🔵 **APK 側 `.env`** |
| **路徑 2**（握手失敗） | `PosPairingManager.kt:33` | `GET /pair` 回嘅 `supabaseUrl`／`anonKey` 為空（＝Vercel `SUPABASE_URL`/`SUPABASE_ANON_KEY` 缺） | ✅ **有** POST+/pair | 🟠 **Vercel 環境變數** |
| 路徑 2 變體 | `PosPairingManager.kt:36` | 回嘅 URL **等於** `BuildConfig.SUPABASE_URL`（＝Ledger） | ✅ 有 | 🟠 **Vercel 環境變數** |
| 路徑 2 冒泡 | `PosRelaySession.kt:219` | `autoPair` 失敗後把 `exceptionOrNull().message` 當狀態顯示 | ✅ 有 | 同上 |

**⇒ 兩條路徑顯示**完全一樣**嘅字**，但一條要改 APK 重 build、一條只要改 Vercel env。

#### 一句話判別（唔使拆 APK）

睇雲端 `pos_print_jobs` **有冇任何「`claimed_by` 非 NULL」嘅行**：

| 觀察 | 判讀 | 依據 |
|---|---|---|
| **有**（本次實測：08:30 / 07:35 / 01:30 都有） | ⇒ **路徑 2**。因為「能 claim」證明過去曾有過有效憑證 ⇒ 曾配對成功 ⇒ `POS_URL` **一定有值**（否則連第一次 `postPair` 都去唔到） | `PosRelaySession.kt:201` 早退後唔會 call 到 `autoPair` |
| **冇**（全 NULL） | ⇒ **路徑 1**，`POS_URL` 為空 | 冇任何 HTTP 發生 |

✅ **本次實測係「有」⇒ 判為「曾有過有效配對」。**
⇒ **修正 §11.4 嘅結論：`BuildConfig.POS_URL` 係有值嘅（問題 ① 唔成立）。**

> 🔴🔴 **2026-09-16 09:10 再修正 —— 本節下面「真正缺嘅係 Vercel `SUPABASE_URL`/`SUPABASE_ANON_KEY`」係錯嘅。**
> 實測 `GET /pair?agentId=ag-0590816d…` 回嘅 **兩欄齊全且非 Ledger**（見 **§13.1**）。
> 真兇係 `restorePairing()` 要求 `status=="paired"`，而部分 agentId 回 **`pending`**（見 **§13.2**）；
> 加上「POS 雲端未設定」可能只係 `PosRelaySession.kt:219` 嘅**垃圾桶 fallback 文案**（見 **§13.4**）。
> **請以 §十三 為準。**

#### 為何路徑 2 會**持續**失敗（但**唔係**永久卡死）—— 15 秒自癒

`PosRelaySession.kt:214-223`：

```kotlin
val restored = pairing.restorePairing(merchantId)
if (!restored) {
    val result = pairing.autoPair(merchantId, storeName)
    if (result.isFailure) {
        PosRelayState.setStatus(result.exceptionOrNull()?.message ?: "配對失敗：POS 雲端未設定")
        schedulePairRetry(merchantId)          // ← 15 秒後重試（唔係永久卡死）
        return@withLock
    }
}
```

- `restorePairing()` 會 **先打 `GET /pair`**（`PosPairingManager.kt:65`）→ 缺憑證 → 回 false
- → `autoPair()` → `POST /pair` 成功但 `GET /pair` 兩欄為空 → `:33` fail
- → `schedulePairRetry(merchantId)` 預設 **15 秒**（`PAIR_RETRY_MS`）
- ⚠️ 但 `schedulePairRetry` 有 `if (pairRetryJob?.isActive == true) return` 保護，
  且 **`unauthorizedStreak` 唔會增加**（呢條路徑唔經 401）⇒ **唔會進入 5 分鐘冷卻**
  ⇒ 實際係 **每 15 秒不斷重試 `POST /pair` + `GET /pair`**，一直失敗，狀態字串一直停留。

**⇒ 呢個係好事**：只要 Vercel 補回 `SUPABASE_URL` / `SUPABASE_ANON_KEY` + **Redeploy**，
**15 秒內會自動配對成功，唔使重啟 APK**。

#### 🔴 為何「能 claim」同「配對失敗」可以同時為真（第 3 個獨立狀態）

`PosRelayPrefs` 存嘅係**加密 SharedPreferences**，`clearPairing()` 會清 `agentId`，
但 `restorePairing()`（`PosPairingManager.kt:49-77`）本身**唔會清** prefs——
只有 `persistedMerchantId` 唔匹配時才清（`:55-60`）。

⇒ 所以 `agent_id` / `agent_token` **仍然喺 prefs 度**，你可以：
- **用舊 token 成功 claim**（claim 只驗 `x-agent-id` + `x-agent-token`，**唔需要 Supabase 憑證**）
- **但訂唔到 `pos_print_jobs` 嘅 Realtime**（需要 `PosRelayClient.init()`，而它從未成功）

⇒ **呢個就係「能 claim 但狀態顯示配對失敗」嘅第三個狀態**，同 §12.2 嘅兩通道無關。
`PosRelayClient.init()` 冇成功 ⇒ `PosRelayClient.client == null` ⇒
`PosRealtimeSubscriber.runSubscription()` 首行 `PosRelayClient.client ?: run { log("未就緒"); delay; return }`
⇒ **Realtime 永遠連唔上，只剩 60 秒對賬兜底**。

> ✅ 呢句 log（`POS Realtime client 未就緒`）就係路徑 2 嘅**獨立佐證**，可以喺 App 日誌直接睇到。

### 12.4 為何「已發送」同「雲端未認領」可以同時出現

呢個**唔係 bug**，係兩個唔同層面嘅狀態併排顯示：

| 徽章 | 層面 | 真源 | 意思 |
|---|---|---|---|
| `●已發送`（綠） | **本地** | `loadPrintJobs()` 嘅 `status="sent"` | 收銀機**本地帳本**認為已交給列印橋 |
| `▲雲端未認領`（橙） | **雲端** | `cloudUnfinished[job.id]` ← `GET /print-jobs/status` | **雲端** job 仍 `pending`／`printing` |

`print-center.tsx:463-467` 已明文記載：

> 🔴「**已發送**」係**樂觀值** —— `RelayTransport.send()` 唔理 `flushPosSyncQueue()` 成唔成功
> 都 `return { ok: true }`，dispatch 見 ok 就標 `"sent"`。而 `syncCloudPrintOutcomes()` 只會**向上**覆寫
> （雲端 printed/failed → 本地），本地有、雲端冇 → **永遠停留「已發送」，零紅標、唔會自我修正**。

⇒ 綠徽章只代表**POS 本地已投遞**，橙標代表**雲端未完成**。兩者**同時為真係設計結果**。
橙標就係為咗補救「綠徽章騙人」而加嘅（`2026-09-12` 事故）。

### 12.5 「所有打印任務都顯示雲端未認領」嘅完整成因清單

按**由上游到下游**排序，每一層都有獨立證據：

| # | 成因 | 證據（本次實測） | 唔係嘅原因 |
|---|---|---|---|
| **A** | **配對未成功 ⇒ 堂食通道從未啟動**（真兇：`restorePairing()` 見 `GET /pair` 回 `pending` 即 `return false`，或 `autoPair` 缺 `merchantId`；見 §13.2）<br>⚠️ ~~Vercel 憑證缺~~ 已由 §13.1 推翻 | 狀態字串精確吻合；08:42／08:54 兩張 `attempts=0`（＝本次實例從未 claim） | 唔係配對**邏輯**錯（五道防線設計正確）；亦唔係 APK `.env` 缺 `POS_URL`；亦唔係 Vercel 憑證缺 |
| **B** | 中繼機離線／被系統殺（foreground service 冇保住） | 活躍窗口 01:12–01:31、07:35、08:30，之後全靜 | 唔係 Realtime 壞 |
| **C** | 跨網段（`10.61.49.153` → `192.168.31.38`） | 07:35 `兩種通道都失敗｜直連：… after 5000ms` | 唔係 printer_id 錯（解析正確） |
| **D** | 出紙失敗原因被吞（`dispatch failed` 硬編碼） | 今日 5/5 failed 全係呢句 | 唔係 claim 失敗 |
| **E** | 下游 `status='printing'` 卡死行唔會被重排 | 3 張 07:38 行仍 `printing`、`updated_at` 停在 08:30 | 唔係 DB 壞 |

> ⚠️ **E 嘅細節**：呢 3 張（07:38:17 / 07:38:20 / 07:38:35）`claimed_at=08:30:35`、
> `last_error=AGENT_FAILED: dispatch failed`、但 `status` 仍然係 `printing`。
> `result/route.ts` 寫 `failed` 時應同時改 `status`，但呢度冇 ⇒ **狀態與 `last_error` 唔一致**。
> 佢哋會**一直停留 `printing`** 直到 90 秒 stale 窗後被任何一部機重新 claim
> ⇒ **一旦有機上線，呢 3 張會即刻爆紙**（加上 2 張 pending 共 5 張）。

### 12.6 逐步診斷流程（照做，每步都有明確判準）

> 🔴 **本次已判定為「路徑 2」** —— 所以流程**由 Step 0 判別 → Step A 查 Vercel 側開始**，
> 而**唔係**一開始就去 build 機拆 `BuildConfig.POS_URL`。
> 最後嘅「12.6b」只保留畀**真係路徑 1** 嘅情況。

**Step 0 — 判別「路徑 1 vs 路徑 2」（唯一決定性動作，30 秒，唔使拆 APK）**

在 SQL Editor（或任何唯讀 DB 通道）執行：

```sql
select count(*) filter (where claimed_by is not null) as 有claim過,
       count(*)                                  as 總job數,
       min(claimed_at) at time zone 'Asia/Macau' as 最早認領,
       max(claimed_at) at time zone 'Asia/Macau' as 最近認領
  from public.pos_print_jobs;
```

| 結果 | 判為 | 意義 | 下一步 |
|---|---|---|---|
| `有claim過 > 0` | ✅ **曾有有效配對** | `POS_URL` 一定有值（否則連第一次 `postPair` 都去唔到）⇒ **排除 APK `.env` 缺陷**，但**唔代表現在配得成** | → **Step A** |
| `有claim過 = 0`（全 NULL、`attempts=0`） | ⚠️ **可能係 `POS_URL` 空** | 根本冇發出過 HTTP | → **§12.6b** |

**本次實測：** `claimed_at` 有 **08:30:35 / 07:35 / 01:30:57** 三個活躍窗口 ⇒ 曾有有效配對。
（08:42:28、08:54:30 兩張新 job 係 `claimed_by=NULL`、`attempts=0`，
證明**目前這個 app 實例**從未 claim 成功，與歷史窗口唔矛盾 —— 見 §12.3。）

---

**Step A — 對「目前這台機的 agentId」打 `GET /pair`（🔴 本次核心，一個 curl 睇清）**

先拎到目前 agentId（`pos_print_agents` anon 讀唔到，可由 App 設定頁或
最近 `claimed_by` 反推），然後：

```bash
curl -s "https://macau-pos-system.vercel.app/api/pos/print-agent/pair?agentId=<agentId>"
```

| 回應 | 判讀 | 動作 |
|---|---|---|
| `{"status":"pending"}` | 🔴 **agent 被撤銷／未確認** ⇒ `restorePairing()` 直接 `return false`（`:66`） | **App 內重新配對**（撳「配對」＋填 storeId）→ Step A″ |
| `{"status":"paired","supabaseUrl":"…","anonKey":"…"}` 兩欄有值、非 Ledger | ✅ agent 正常 ⇒ 問題在 **`merchantId`**（店員未登入 Ledger？） | → **Step A″** |
| `supabaseUrl`／`anonKey` 空 | ⚠️ 才是 Vercel `SUPABASE_URL`/`SUPABASE_ANON_KEY` 缺 | → Step B |
| `supabaseUrl` 含 `zymdemjflsckicwcinxl` | ⚠️ 撞正 Ledger（`PosPairingManager.kt:36`） | → Step B |
| HTTP `401` | panel 會紅；要 **iPad 重新登入** | → Step A″ |

> ⚠️ **本次實測係第 2 種**（`ag-0590816d` 兩欄齊全）⇒ **唔需要改 Vercel env。**
> 而 `ag-f38b08c`／`ag-a466746d` 回 `pending` ⇒ 呢兩個 agent 已失效。

**Step A″ — 確認 Ledger 登入態（本次最可疑）**

`autoPair()`（`PosPairingManager.kt:16,25`）靠 **`AppSession.merchant.merchantId`** 做 `storeId`。
**若店員未登入 Ledger、或登入態過期 ⇒ `merchantId` 為空 ⇒ `autoPair` 必敗**
（`storeId != merchantId` 或 `POST /pair` 直接 400）。
⇒ **在 App 內確認已成功登入 Ledger 商家帳號**，再撳一次「配對」。

> 🔴 **「配對失敗：POS 雲端未設定」可能只係 fallback 文案**（`PosRelaySession.kt:219`：
> `result.exceptionOrNull()?.message ?: "配對失敗：POS 雲端未設定"`）。
> 當 `RelayApi.post()` 把例外吞成 `null`（§11.8），就會顯示呢句**即使真正原因完全無關**。
> **唔可以逐字當真。**

**Step B — 只在 Step A 確認「兩欄空／撞 Ledger」時才做**

```ini
# Vercel → Environment Variables（至少 Production）
SUPABASE_URL          = https://iyrywzormzisyppkokbi.supabase.co
SUPABASE_ANON_KEY     = eyJ…（role=anon, ref=iyrywzormzisyppkokbi）
```

然後 **Redeploy**。

✅ **關鍵：配對修好之後唔使重啟 APK、唔使重裝。**
`PosRelaySession.schedulePairRetry()` 係 **`PAIR_RETRY_MS = 15_000L`**，
而且呢條路徑冇 401 ⇒ **唔會**進入 `PAIR_COOLDOWN_MS = 300_000L` 嘅 5 分鐘冷卻。
⇒ 補好前置條件後**最多 15 秒**，商米會自動由「配對失敗」→「配對中…」→「已連線／運行中」。
（**呢點推翻早期「會永久卡死、要重啟 APK」嘅講法。**）
⚠️ **唯一例外**：若係 `restorePairing()` 撞正 `status=pending`，即使自動重試都會一直 pending
—— 因為 `pending` 係**伺服器側嘅狀態**，要 App 重新 `POST /pair` 才會變 `paired`。

**Step C — 驗證通道真的起來**

| 檢查 | 判準 |
|---|---|
| 商米狀態字串 | 應變成 `配對中…` → `運行中｜RT已連｜心跳N秒前｜對賬N秒前｜…` |
| `pos_print_agents` 有心跳 | 🔴 **anon 讀唔到**（`42501`）⇒ 要用 service_role，或睇 `/prints` 紅 banner |
| `/prints` 紅 banner | 「中繼打印機：最後心跳 N 分鐘前」應該歸零 |
| 新 job 有冇 `attempts` 上升 | 上升 = claim 成功 |

**Step D — 通道起來但仍「未認領」→ 查 claim 層**

| 檢查 | 判準 |
|---|---|
| 中繼機是否活著 | `/prints` 紅 banner「最後心跳 N 分鐘前」；> 5 分鐘 = 離線 |
| 商米 Wi-Fi 網段 | 必須 `192.168.31.x`（同打印機）；見到 `10.61.x` / `172.20.10.x` = **手機熱點／流動網絡** |
| 流動數據是否已關 | Android 會用 cellular 做 default route |
| `attempts` 有冇上升 | 上升 = 有 claim（去 Step E）；唔動 = 完全冇 claim（返 Step A） |

**Step E — 有 claim 但出紙失敗 → 修網路層**

07:35 嘅 `last_error` 已指明：`failed to connect to /192.168.31.38 from /10.61.49.153 after 5000ms`。
⇒ 改 Wi-Fi 到店內路由器 + 關流動數據，**唔使改一行代碼**。（詳見 §10。）

---

#### 12.6b 若 Step 0 判為「路徑 1」（`POS_URL` 真係空）才做

去 **build 機**跑（唔使拆 APK）：

```bash
# 全路徑 node（本機 bash 壞：冇 coreutils、npm/npx 跑唔到）
C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe -e "
const fs=require('fs');
const g='app/build/generated/source/buildConfig';
['prodRelease','prodDebug','uatRelease','uatDebug'].forEach(f=>{
  const p=g+'/'+f+'/com/macauledger/merchant/BuildConfig.java';
  try{ console.log(f+': '+fs.readFileSync(p,'utf8').match(/POS_URL\s*=\s*.*/)[0]); }
  catch(e){ console.log(f+': (未 build)'); }
});
"
```

- `POS_URL = ""` ⇒ 證實路徑 1 ⇒ 在 `.env.prod.local` / `.env.uat.local` **各補一行**
  `POS_URL=https://macau-pos-system.vercel.app`，**重新 build + 重裝 APK**
  （`BuildConfig` 係編譯期常量，改 env 唔會影響已裝嘅 APK）。
- 非空 ⇒ 唔係路徑 1，返 **Step A**。

### 12.7 ⚠️ 收尾前必做：清舊任務，避免一次爆 5 張紙

現時未完成任務（本次實測，全部 **ttl 未過期**，最遲 20:54 才到期）：

| 建單時間 | 狀態 | attempts | claimed_by | 一恢復會發生 |
|---|---|---|---|---|
| 08:54:30 | `pending` | 0 | NULL | 即時被 claim 出紙 |
| 08:42:28 | `pending` | 0 | NULL | 即時被 claim 出紙 |
| 07:38:35 / :20 / :17 | **`printing`** | 4/5/5 | `ag-0590816d` | **90 秒窗後可被重新 claim ⇒ 出紙** |
| 07:32:27 / :07 | `pending` | 2/3 | NULL | 即時被 claim 出紙 |
| 01:34:17 / 01:27:13 | `pending` | 4/4 | NULL | 即時被 claim 出紙 |
| 01:13:47 | **`printing`** | 5 | `ag-f38b08c` | `attempts=5` ⇒ **`coalesce(attempts,0) < 5` 唔成立 ⇒ 永不 claim** ✅ |
| 09-15 21:19:30 | `pending` | 0 | NULL | `ttl=NULL` ⇒ **永不過期 ⇒ 會出紙** |

🔴 **一旦通道修好，會有 8 張舊單同時爆紙**（`ttl=NULL` 那張隔夜單尤其危險）。
**建議先做**（Supabase → SQL Editor，需 service_role）：

```sql
-- 睇清楚會爆幾張
select id, created_at at time zone 'Asia/Macau' as 建單_澳門, status, attempts, printer_name, last_error
  from public.pos_print_jobs
 where finished_at is null
   and coalesce(attempts,0) < 5
   and (ttl is null or ttl > (extract(epoch from now())*1000)::bigint)
 order by created_at;

-- 把唔想補印嘅作廢（用 0042 嘅正式端點，會寫原因碼）
select public.pos_void_stale_print_jobs('<你的 storeId>');
-- 若 pos_void_stale_print_jobs 未建（= 0042 未跑），退而用：
-- update public.pos_print_jobs
--    set status='failed', claimed_by=null, claimed_at=null,
--        last_error='VOID_STALE: 人手作廢（2026-09-16 中斷排查）', updated_at=now()
--  where finished_at is null and status in ('pending','printing')
--    and created_at < '2026-09-16 08:00+08';
```

### 12.8 🔴🔴 重大附帶發現：鑑權閘已被**全局關閉**

本次探測（**匿名、零憑證**）全部回 **200**：

| 端點 | 09-16 01:04 實測 | **09-16 09:00 實測** |
|---|---|---|
| `/api/pos/state?storeId=test-store` | `401` 未經授權 | 🔴 **`200`** 回完整店舖資料 |
| `/api/pos/print-jobs/status?storeId=…` | `401` | 🔴 **`200`** |
| `/api/pos/device-config?storeId=…` | — | 🔴 **`200`** |
| `/api/pos/orders?storeId=…` | — | 🔴 **`200`** |
| `/api/pos/print-agent/pair-status?storeId=…` | **`401`** | 🔴 **`200`** |

⇒ **`POS_REQUIRE_DEVICE_AUTH` 已經由「未設（＝fail-closed 開著）」變成明確設為 `0`／`false`**，
`resolvePosRouteAuth()`（`pos-route-auth.ts:59`）第一條分支 `disabled` 直接放行全部請求。

**兩個意涵：**

1. ✅ **意外地解除了 §9／§10 卡咗幾個鐘嘅「配對失敗」問題** ——
   `relay-pairing-panel` 不再收到 401，`pair-status` 回正常 `{paired:false}`，
   所以 **iPad 側已唔會再顯示「配對失敗」**。（商米側係另一件事，見 §12.3。）
2. 🔴 **資安風險回到 09-15 之前**：`getSupabaseServerClient()` 優先取
   `SUPABASE_SERVICE_ROLE_KEY`，**繞過 RLS** ⇒ 任何知道 `storeId` 嘅匿名請求都可以讀寫該店資料。
   `storeId` 係 UUID，但會出現在 URL／QR／log／前端 localStorage，**唔可以當秘密**。

⚠️ **唔可以在未確認原因前就把它改回 `1`** —— 若 `POS_DEVICE_TOKEN_SECRET` 冇設、
iPad token 又冇續期，改返 `1` 會**即刻再次全站 401**、堂食 POS 又停。
**正確次序（見 Step 3 之後）：**
先確認 iPad 能成功簽發 token（`POST /api/pos/device-token` 回 200 + token），
再設 `POS_REQUIRE_DEVICE_AUTH=1` + **Redeploy**，最後逐端點驗證 401 有冇恢復。

### 12.9 修復優先序（合併 §12 全部結論）

> 排序原則：**先確保唔會爆紙 → 再修根因 → 最後改代碼**。
> 動作 1–2 係「唔做會後悔」（一次爆 8 張舊單）；3–4 係真正根因；5 之後係加固。

| # | 動作 | 類型 | 急迫 |
|---|---|---|---|
| **1** | **清舊 pending／printing（8 張會爆紙）** —— 先跑 §12.7 嘅 SELECT 睇清單，再跑 `pos_void_stale_print_jobs('<storeId>')` | 維運（SQL Editor） | 🔴 **修通道之前**做（最高） |
| **2** | 跑 `0042` migration（若未跑）—— 冇佢就**冇**分段 claim 窗＋作廢端點 | 維運 | 🔴 高 |
| **3** | 跑 §12.6 **Step 0** 判別路徑 → 本次已判為「曾有有效配對」 | 已完成 | ✅ 已做 |
| **4** | 🔴 打 `GET /pair?agentId=<目前所用>` → 判係 `pending` 抑或 `paired`（§12.6 Step A／§13.1） | 用戶 | 🔴 **即做（真正根因入口）** |
| **4b** | 若回 `pending` ⇒ **App 內重新配對**；若 `paired` ⇒ 確認 **Ledger 登入態**（`AppSession.merchant`） | 用戶 | 🔴 即做 |
| **5** | 商米 Wi-Fi 改連店內路由器 + **關流動數據** | 用戶 | 🔴 即做（下游根因，唔改代碼） |
| **6** | 為 `.env.prod.local` / `.env.uat.local` 補 `POS_URL`（**防禦性**；本次唔係根因） | 配置 | 低（建議做） |
| **7** | 查清 `POS_REQUIRE_DEVICE_AUTH` 為何變 `0`；確認 iPad 能簽 token 後**改返 `1` + Redeploy** | 用戶／代碼 | 🔴 高（資安，⚠️ 次序唔可以顛倒） |
| **8** | 通知欄文案改 `外賣通道: … ｜ 堂食POS通道: …`（消除 §12.2 誤讀） | 代碼（APK） | 中 |
| **9** | `PosRelaySession.kt:219` 唔好用 fallback 文案蓋住真原因（§13.4） | 代碼（APK） | 中 |
| **10** | `restorePairing()` 回 false 時加 log（現時靜默，查幾個鐘） | 代碼（APK） | 中 |
| **11** | `LanTcpPrinter`／`PosPrintDispatcher` 回傳真實錯誤（§11.5） | 代碼（APK） | 中 |
| **12** | `result/route.ts` 寫 `failed` 時**同時改 `status`**（消除 §12.5-E 不一致） | 代碼（POS） | 中 |
| **13** | 為中繼機補 device-config 鑑權通道（agent token）（§10.6） | 代碼 | 中 |
| **14** | 一旦又見「配對失敗」，**先跑 Step 0 + Step A**，唔好直接跳去改 Vercel 或拆 `BuildConfig` | 流程 | — |

#### 🔴 一句話總結（貼在牆上）

1. **`外賣: 已連線` 與 `堂食POS: 配對失敗…` 唔矛盾** —— 兩條獨立通道（`AppState.mqttStatus` vs `PosRelayState.status`）。
2. **「配對失敗：POS 雲端未設定」係垃圾桶文案**（`PosRelaySession.kt:219` 嘅 fallback），
   **唔可以逐字當真** —— 三種完全唔同嘅原因都會顯示同一句。
3. **Ledger 講「`GET /pair` 兩欄空」係錯嘅**：實測兩欄齊全（§13.1）。
   真兇係 `restorePairing()` 見 `status=="pending"` 就靜默 `return false`（§13.2）。
4. **唔使改 Vercel、唔使重裝 APK** ⇒ 去 App 內**重新配對** + 確認 **Ledger 登入態**。
5. **但先清爆紙舊單**（§12.7）—— 通道一恢復會同時出紙（含一張 `ttl=NULL` 隔夜單）。
6. **「雲端未認領」係通道冇起來嘅下游症狀**，唔係 claim 契約問題 —— 舊 agent 今朝 08:30 仍 claim 得到。

---

## 十三、2026-09-16 09:10 —— **實測推翻「Vercel 憑證缺」**，真兇係 `restorePairing()` 早退

### 13.1 決定性實測（`tools/_probe6-20260916.cjs`、`_probe7-20260916.cjs`，全部唯讀）

Ledger 回覆要求「貼 `GET /pair` 的 url／key 是否空」。我照做，結果**兩欄完全唔空**：

```
GET /api/pos/print-agent/pair?agentId=ag-0590816d9f60e8d2f55a16cf721042dd
→ HTTP 200
{
  "status": "paired",
  "storeId": "d564b932-0c91-45e9-86fd-0ec8e2711f13",
  "supabaseUrl": "https://iyrywzormzisyppkokbi.supabase.co",     ← ✅ 有值、又唔係 Ledger
  "anonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…(role=anon, ref=iyrywzormzisyppkokbi)"  ← ✅ 有值
}
```

🔴 **⇒ §12.3 判「路徑 2（Vercel `SUPABASE_URL`/`SUPABASE_ANON_KEY` 缺）」係錯嘅。**
`PosPairingManager.kt:33`（兩欄空）同 `:36`（撞 Ledger）**兩條都唔成立** —— 呢兩欄既齊全、又唔係 Ledger。

### 13.2 真正嘅關卡：`restorePairing()` 先打 `GET /pair`，`status=pending` 就 `return false`

`PosPairingManager.kt:65-68`：
```kotlin
val poll = relayApi.getPair(agentId)
if (poll.status != "paired" || poll.storeId != posStoreId) {
    return false          // ← ★ 呢度！冇任何 log、冇任何 status 訊息
}
```

而各 agentId 嘅實測回應（`_probe7`）：

| agentId | `GET /pair` 回應 | 命運 |
|---|---|---|
| `ag-0590816d…`（08:30 活躍） | `status:"paired"` + 兩欄齊全 | ✅ 呢個 agent 配得成 |
| `ag-f38b08c…`（07:35 活躍） | **`{"status":"pending"}`** | ❌ `restorePairing` false |
| `ag-a466746d…`（01:30 活躍） | **`{"status":"pending"}`** | ❌ `restorePairing` false |

⇒ **`pos_print_agents` 嗰行只要 `revoked_at` 有值（或從未 `POST /pair` 成功），
`GET /pair` 就永遠回 `pending`** ⇒ `restorePairing()` 回 false ⇒ 跟住 `autoPair()`。

而 `autoPair()` 會**用同一個 agentId** 打 `POST /pair`… **除非** `merchantId` 拎唔到（例如店員未登入 Ledger）。
**若 `AppSession.merchant` 為 null ⇒ `merchantId` 為空 ⇒ `autoPair` 內部比對 `storeId != merchantId` 直接失敗。**

### 13.3 🔴 修正 Ledger 的因果鏈（他所講大部分正確，但有一處要改）

| Ledger 講法 | 核實結果 |
|---|---|
| 他們的分類程式在 `src/lib/pos/print-job-failure.ts` | ✅ 完全準確（`status==='pending'`→`TIMEOUT_CLAIM`；`'printing'`→`TIMEOUT_STALE`） |
| 07:38 舊 App 有認領 → 舊版「可以」 | ✅ 準確：`ag-0590816d` @08:30:35 claim 3 張、`ag-f38b08c` @07:35:56 claim 1 張 |
| 08:42／08:54 新單 `pending`、`claimed_by=NULL`、`attempts=0` | ✅ 準確（本次實測一致） |
| 心跳停 34 分鐘 = claim／heartbeat 沒在跑 | ✅ 準確 |
| **「不是 claim API 被我們改壞」** | ✅ **同意**：`pos_claim_print_jobs` 契約完好，舊 agent 今朝仍 claim 得到 |
| **「原因仍是新 App 重配時 `GET /pair` 沒拿到 `supabaseUrl`／`anonKey`」** | ❌ **錯**。實測 `ag-0590816d` 嘅 `GET /pair` **兩欄都有值**。真兇見 §13.2 |
| **「舊版吃的是本機舊快取」** | ⚠️ **部分對但形式唔同**：`restorePairing():69-70` 確實會 fallback 本機舊值 —— **但佢仍然要 `status=="paired"` 先過得去（:66）**。所以「有快取」≠「跑得動」 |

**⇒ 正確講法：問題唔在 `GET /pair` 回空，而在 `GET /pair` 回 `pending`
（該 agentId 在 `pos_print_agents` 被撤銷／未確認），令 `restorePairing()` 硬性失敗。**
而 `autoPair()` 亦無補救 —— 佢靠 `AppSession.merchant` 嘅 `merchantId`，
若店員未登入 Ledger（或登入態過期），`autoPair` 一樣失敗，
最後由 `PosRelaySession.kt:219` 冒泡出 `exceptionOrNull().message`。

### 13.4 為何顯示的是「POS 雲端未設定」而非「配對尚未完成」

`PosRelaySession.kt:218-220`：
```kotlin
PosRelayState.setStatus(
    result.exceptionOrNull()?.message ?: "配對失敗：POS 雲端未設定",   // ← fallback 文案
)
```
`autoPair` 失敗時如果 `message` 為 null（例如 `postPair` 被 `RelayApi.post()` 的
`catch(_:Exception){null}` 吞成泛化例外），就會**顯示 fallback 文案「配對失敗：POS 雲端未設定」**
—— **即使真正原因同「雲端未設定」完全無關。**
⇒ **呢句字串係一個「垃圾桶文案」，唔可以逐字當真。**（§11.8 早已記錄 `post()` 吞例外嘅問題。）

### 13.5 修正後嘅診斷次序

1. **先確認店員／App 的 Ledger 登入態** —— `AppSession.merchant` 有冇值？
   冇值 ⇒ `merchantId` 空 ⇒ `autoPair` 必敗。（**呢個係本次最可疑**。）
2. **確認該機目前用邊個 `agentId`** —— 對佢打 `GET /pair`：
   - 回 `pending` ⇒ agent 被撤銷 ⇒ 要**重新 `POST /pair`**（App 內撳「配對」+ 填 storeId）
   - 回 `paired` + 兩欄有值 ⇒ agent 正常 ⇒ 問題在 `merchantId` 或 `restorePairing` 嘅 `posStoreId` 比對
3. `BuildConfig.POS_URL` / Vercel env **兩者都已排除**（有 `claimed_by` 證明 APK OK；§13.1 證明 Vercel OK）。
4. ⚠️ **「清舊 job」嘅警告依然有效**（§12.7）—— 通道一恢復仍會爆紙。

### 13.6 給 Ledger 嘅回覆要點（可直接用）

> 多謝核實，你們對 `print-job-failure.ts` 嘅引用**完全正確**，
> 「不是 claim API 被改壞」我哋**同意** —— 舊 agent 今朝 08:30 仍成功 claim 3 張。
>
> 但有一處要修正：**`GET /pair` 嘅 `supabaseUrl`／`anonKey` 實測係有值嘅**，唔係空。
> 我哋直接打過：
> `GET /api/pos/print-agent/pair?agentId=ag-0590816d9f60e8d2f55a16cf721042dd`
> → `{"status":"paired","supabaseUrl":"https://iyrywzormzisyppkokbi.supabase.co","anonKey":"eyJ…(anon)"}`
> 兩欄齊全、亦唔係 Ledger 專案。
>
> **真正卡點**在 `PosPairingManager.kt:65-68`：`restorePairing()` 要求 `GET /pair` 回
> `status=="paired"`，但我哋測到 `ag-f38b08c…`／`ag-a466746d…` **都回 `{"status":"pending"}`**
> ⇒ 直接 `return false`，冇 log。之後 `autoPair()` 靠 `AppSession.merchant` 嘅 merchantId；
> 若店員未登入 Ledger 就一樣失敗，最後由 `PosRelaySession.kt:219` 冒泡出 fallback 文案
> 「配對失敗：POS 雲端未設定」—— **所以呢句話並唔代表「雲端未設定」，佢係垃圾桶文案。**
>
> 另：Ledger 講「舊版吃本機舊快取」**部分對** —— `restorePairing():69-70` 確實 fallback 本機舊值，
> **但仍然要 `status=="paired"` 先過得去（:66）**。所以「有快取」≠「跑得動」，
> 唔可以將「舊版畫面寫已連線」當成「`GET /pair` 現在有鑰匙」。
>
> **請協助確認：該機目前 `agentId` 喺 `pos_print_agents` 嘅 `revoked_at` 係唔係有值**
> （我哋 anon 讀唔到該表，`42501`）。若已撤銷 ⇒ App 內重新配對即可，**唔需要換回舊 APK**。

---

## 十四、2026-09-16 09:23 用戶現場測試後 —— **真兇鎖定：心跳已停 54 分鐘**

### 14.1 用戶提供嘅事實
- 用戶**身處店內**，剛剛嘗試打印 → **仍然失敗**
- `/prints` 顯示：**已有 2 張**未完成（未認領 2 張、已認領未回報 0 張）
- **「中繼打印機：最後心跳 1138 分鐘前（疑似離線）」** ← 🔴 關鍵新數字
- 訂單 `005`（16/09 09:20）→ `已發送` + `雲端未認領`

### 14.2 🔴 決定性發現：心跳**已完全停止**，唔係配對問題

實時探測（`tools/_probe9-live.cjs`、`_probe11-heartbeat.cjs`）：

| 項目 | 實時值 |
|---|---|
| `lastSeenAt`（真實心跳） | **2026-09-16 08:30:34（澳門）= 54 分鐘前** |
| 最後一次 claim | **2026-09-16 08:30:35** ← 同心跳**同一秒** |
| `pair-status` `paired` | ✅ `true` |
| `pair-status` `androidReady` | ✅ `true` |
| `GET /pair?agentId=ag-0590816d…` | ✅ `status=paired` + **兩欄有值** |

**⇒ 心跳（每 30 秒一次）同 claim 同時喺 08:30:35 停止**
⇒ **`PosJobRunner` 嘅 `heartbeatJob` 同 `tickJob` 都已經停止**
⇒ **唔係配對問題、唔係 env 問題、唔係 `POS_URL` 問題** —— **係 App 嘅 runner 停咗。**

### 14.3 為何 §13 嘅「重新配對」推論都唔夠準確

§13 發現 `ag-f38b08c…`／`ag-a466746d…` 回 `pending` 係**真**嘅，
但**唔係本機目前所用嘅 agent**。實測 `pair-status` 回嘅目前 agentId 係
**`ag-0590816d…`**，而佢嘅 `/pair` **完全正常（`paired` + 兩欄有值）**。

⇒ **所以連「重新配對」都唔需要做！** 真正要做嘅係**令 App 嘅 runner 重新跑起**。

### 14.4 為何 runner 會停？三個可能（按可能性）

| # | 可能 | 點解合理 | 點樣驗證 |
|---|---|---|---|
| **1** | 🔴 **App 退到背景被 Android 殺咗／Doze 休眠** | 08:30 之後**零**心跳、零 claim；`runEpoch` 機制會 cancel 舊 job，重入前景才重啟 | 去商米**開返 App 前台** → 睇心跳有冇即刻恢復 |
| **2** | **Foreground service 冇保住 / 被系統清理** | 商米係 Android 商用機，預設電池優化會殺背景 | 設定 → 電池 → 唔限制 |
| **3** | **`onUnhealthy` 觸發後 `stop()` 咗** | `PosJobRunner` 有 `UNHEALTHY_STREAK = 3` 機制 | 睇 App 內日誌有冇「連續失敗」字樣 |

> 📌 **注意**：`PosRelaySession.stopImmediate()` → `PosRelayClient.shutdown()` 亦會停 runner。
> 若 App 曾收到 401（`onAgentUnauthorized`），會 `stopImmediate()` + `clearLocalPairing()`。
> 但 `pair-status` 顯示 `paired: true` + `androidReady: true` ⇒ **唔似**呢條路徑。

### 14.5 ⚠️ 順帶解釋：截圖嘅「1138 分鐘前」係**舊快照**

`print-center.tsx:1769-1772` 嘅 `minutesAgo` 係**前端即時用 `Date.now()` 算**：
```ts
const minutesAgo = Math.max(0, Math.round((Date.now() - lastSeenMs) / 60000));
```
若 `/prints` 頁一直開住冇重整，`lastSeenAt` 唔會更新，但 `Date.now()` 一直行
⇒ 呢個數字會**不斷膨脹**。1138 分鐘反推 = **09-15 14:25**，
同實測嘅 08:30 **完全對唔上** ⇒ **截圖嗰個 `lastSeenAt` 係昨晚 14:25 前後嘅舊值**。

🔴 **⇒ 呢個數字極之誤導，唔可以用嚟判離線時長。** 要睇就睇**實時**打 `pair-status`。

### 14.6 🔴🔴 現在真正要做嘅事（取代 §12.6／§13 嘅步驟）

**次序：**

1. **🔴 先清爆紙舊單**（8 張，見 §12.7）—— 因為 runner 一恢復就會即刻認領
2. **去商米，把 App 切到前台**（唔係「重新配對」，只係叫醒佢）
   - 若狀態變 `運行中｜RT已連｜心跳0秒前｜…` ⇒ ✅ 搞定
3. **若切前台都唔動 ⇒ 完全重啟 App**（殺掉再開）
4. **若重啟都唔動 ⇒ 檢查 Android 電池優化／背景限制**，設為「不限制」
5. **確認 Wi-Fi 網段** = `192.168.31.x`（出紙失敗嘅獨立根因，見 §10）
6. **⚠️ 唔需要**重新配對、**唔需要**改 Vercel、**唔需要**重裝 APK

### 14.7 驗證成功嘅訊號

| 檢查 | 期望 |
|---|---|
| App 狀態 | `運行中｜RT已連｜心跳 0 秒前｜對賬 N 秒前` |
| `pair-status` `lastSeenAt` | 應該係**現在**（1 分鐘內） |
| 新 job | `pending` → `printing` → `printed` |
| `/prints` | 「雲端未認領」消失 |

### 14.8 可重用教訓（已寫入 skill）

🔴 **判「中繼機死活」唔可以睇 `/prints` 嗰句「N 分鐘前」** —— 佢可能係舊快照、會不斷膨脹。
**正確做法：實時打 `GET /api/pos/print-agent/pair-status?storeId=` 睇 `lastSeenAt`。**
再對照 `pos_print_jobs` 最後一次 `claimed_at`，兩者同一時刻 ⇒ runner 已死。

---

## 十五、2026-09-16 09:37 —— 🔴🔴 **`pos_void_stale_print_jobs()` 回 0 的真正原因：三個 store，三台機，全部停咗**

### 15.1 🔴 第一個更正：sweep 回 `0` 係**正常行為**，唔係冇嘢好清

用戶跑咗：
```sql
select public.pos_void_stale_print_jobs('d564b932-0c91-45e9-86fd-0ec8e2711f13');
-- → 0
```
**實時覆核：11 張風險 job 一張都冇變**，證明 sweep 冇揀到嘢。

睇返 `0042` 函數本體（`:140-146`）：
```sql
where store_id = p_store_id
  and finished_at is null
  and status in ('pending','failed','printing')
  and ( ttl is not null and ttl <= (extract(epoch from now()) * 1000)::bigint )
                                    ↑↑↑ 只掃「ttl 已過期」嘅行
```
**呢個 sweep 係為「有正常設 ttl 嘅單」設計**，唔係「ttl=NULL 嘅歷史遺留」。

實測 11 張風險單嘅 ttl 分佈：
| 分類 | 張數 | sweep 會唔會處理 |
|---|---|---|
| `ttl = NULL` | **1** | ❌ 唔會（`ttl is not null` 條件篩走） |
| ttl 已過期 | **0** | — |
| ttl 仍有效 | **10** | ❌ 唔應該（未過期，仲想印） |

⇒ **回 0 完全正確。`ttl=NULL` 係另一類問題 —— 我早前已記錄過嘅 `ttl` 只喺 insert 寫、舊行恆 NULL 嘅歷史遺留。**

### 15.2 🔴🔴 第二個（重大）發現：**唔止一間店、唔止一台中繼機**

按 `store_id` 分組掃 `pos_print_jobs`，發現**三個唔同 store** 都有未完成 job：

| store_id | 未完成 | 風險(<5) | 中繼機 agentId | **最後心跳** | 距今 |
|---|---|---|---|---|---|
| `d564b932-0c91-45e9-86fd-0ec8e2711f13` | 7 | 3 | `ag-0590816d9f60e8d2f55a16cf721042dd` | **09-16 08:30:34** | 68 分 |
| `f6ec837a-03d9-48f0-ae05-f1fbc3483221` | 8 | 4 | `ag-4d013eda51299e8268545fcd1c6d1892` | **09-16 01:31:06** | **488 分（8 小時）** |
| `8291f843-9def-4956-9d0b-1cfef2598306` | 43 | 4 | `ag-302b8281b76742d95467537f38b84bbf` | **09-15 14:24:37** | **1154 分（19 小時）** |

**三個都 `paired:true` + `androidReady:true`，但三個心跳都停咗、停喺唔同時間。**
⇒ 唔係「一部機嘅 App 被殺」，係**三台中繼機各自停擺**（或其中兩台已長期離線）。

按 `printer_name` 判設備，三間店嘅設備亦唔同：
- `d564b932` → `printer`
- `f6ec837a` → `廚房打印機`
- `8291f843` → `小票機 · 通用 80mm 熱敏打印機`

### 15.3 🔴 第三個更正：「1138 分鐘前」之謎解開 —— **UI 顯示嘅根本唔係你嗰台機**

`resolveStoreId()`（`sync-flush.ts:308-314`）= **登入 session 嘅 `merchantId`**：

```ts
export function resolveStoreId(): string | undefined {
  const auth = loadAuthSession();
  if (auth?.merchantId) return auth.merchantId;   // ← 登入邊間店，就查邊間
  const binding = loadKioskDeviceBinding();
  if (binding?.storeId) return binding.storeId;
  return undefined;
}
```

`print-center.tsx:419-424` 就係用佢去叫 `pair-status?storeId=`。

**對號入座：**
| 候選 | 分鐘數 | 對得上截圖「1138」？ |
|---|---|---|
| `8291f843…` | **1154** | ✅ **最接近**（差 16 分 ≈ 截圖到現在嘅時差） |
| `d564b932…` | 68 | ❌ |
| `f6ec837a…` | 488 | ❌ |

⇒ **你截圖嗰句「最後心跳 1138 分鐘前」，講嘅係 `8291f843…` 嗰台機（停咗 19 個鐘），唔係你哋現場正用嗰台。**
⇒ 亦即：**當日「現場測試仍然冇紙」，真正原因要睇你 iPad 登入邊個店**：
- 若 iPad 登入 `8291f843…` ⇒ 佢嘅中繼機停咗 19 個鐘 ⇒ 當然印唔出，而且 banner 數字係真
- 若 iPad 登入 `d564b932…` ⇒ 心跳只停 68 分，banner 數字係**跨店污染**（顯示咗別店）

### 15.4 修訂後嘅行動次序

1. **🔴 先確認 iPad 登入邊個 merchant**（呢個決定你查邊台機）
   iPad → 設定/帳號 → 睇 merchantId；或在瀏覽器 console 跑 `localStorage` 睇 auth session。
   **必須同實際中繼機嗰間店一致。**
2. **針對「你實際用嗰間店」**：叫醒對應嗰台商米 App（切前台 → 重啟 → 電池不限制）
3. **另外兩間店**：若已停用/搬走 ⇒ 標記為已知離線，唔好再當佢哋係活躍店；
   若仍在營運 ⇒ 各自都要去叫醒（呢個係獨立事件，唔會互相影響）
4. **清 job**：`pos_void_stale_print_jobs()` 對 `ttl=NULL` 無效（§15.1）。
   要清就用 UPDATE 退路，**並且逐個 store 分開跑**：
```sql
-- 逐個 store 換 p_store（先跑 SELECT 睇清楚）
with p_store as (select 'd564b932-0c91-45e9-86fd-0ec8e2711f13'::text as sid)
select id, created_at at time zone 'Asia/Macau' as 建單_澳門, status, attempts, ttl, printer_name
  from public.pos_print_jobs
 where store_id = (select sid from p_store)
   and finished_at is null and coalesce(attempts,0) < 5
 order by created_at;
```
⚠️ **唔好一次過清三個 store** —— 逐間確認，避免清錯仍在營運嘅店。

### 15.5 為何「全 store 掃」會揭到呢件事

之前一直只查 `storeId=d564b932`，所以只見到 68 分鐘。
**教訓：查中繼打印問題，第一步應該「唔帶 store 過濾」掃一次 `pos_print_jobs`**，
睇 `group by store_id` —— 因為**「印唔出」可能係「你查緊嘅 store 根本唔係 iPad 用緊嗰個」**。
