# 中繼機（Print Relay / Hub）操作文檔：`device-config` 憑證化

> 建立：2026-09-16 · 適用於 `macau-pos-system` 部署之後
> 關聯文件：`docs/integration/print-relay-hardening-brief.md`（§8 為本文件的規格來源）
> 相關工具：`tools/verify-relay-agent.cjs`、`tools/verify-pos-authgate.cjs`、`tools/audit-anon-endpoints.cjs`

---

## 0. 一頁摘要（先睇呢度）

| 問題 | 答案 |
|---|---|
| 而家係咩狀態？ | `GET /api/pos/device-config` 已加憑證閘，**匿名一定 401**（2026-09-16 21:37 生產實測）。中繼機拉唔到打印機路由配置。 |
| 會唔會即刻停印？ | **唔會**。失敗時中繼機**保留上一次成功嘅值**，而且揀機有 4 級 fallback（最後一級係本機 LAN 發現）。 |
| 真正風險係咩？ | `RelayState.deviceConfigPrinters` 係**純記憶體** ⇒ **中繼機一重啟**就失去權威路由，改用 LAN 發現揀機 ⇒ **多打印機嘅店可能印錯機**。 |
| 今晚要做咩？ | ① **唔好重啟中繼機**；② 營業前做一次測試打印；③ 之後照本文件 §3 部署 server 兼容版本 + §4 更新 APK。 |
| 部署次序？ | **server 先，APK 後**（server 版本係「兩條路任一條通過」嘅兼容版，先部署唔會打斷未升級嘅 APK）。 |
| Server 側做咗未？ | ✅ **已實作（2026-09-16 21:45），待部署**（`src/app/api/pos/device-config/route.ts`）。部署之後 R2／R3 先會由 401 轉 200。 |

---

## 1. 背景：為何要改

2026-09-16 嘅安全加固把 `POS_REQUIRE_DEVICE_AUTH` 設為 `1`，全部有 `posRouteAuthGuard` 嘅端點對匿名請求回 401。
`device-config` 係其中之一，但**兩個中繼 App 都係無憑證去拉佢**：

| App | 位置 | 現況 |
|---|---|---|
| `print-relay`（`com.macau.printhub`） | `C:/dev/print-relay/app/src/main/java/com/macau/printhub/relay/RelayApi.kt:221-225` | `Request.Builder().url(url).get().build()`，**冇任何 header** |
| `macau-ledger-merchant`（`com.macauledger.merchant`） | `C:/dev/_ref-macau-ledger-merchant/app/src/main/java/com/macauledger/merchant/posrelay/RelayApi.kt:184` | 同上 |

### 1.1 受影響 / 不受影響嘅端點（重要）

| 端點 | 中繼機用途 | 現時狀態 |
|---|---|---|
| `POST /api/pos/print-agent/heartbeat` | 心跳（30s） | ✅ 可匿名（**設計如此**），照常 |
| `POST /api/pos/print-agent/claim` | 領取打印任務 | ✅ 可匿名，照常 |
| `POST /api/pos/print-agent/result` | 回報結果 | ✅ 可匿名，照常 |
| `GET /api/pos/print-agent/pair` | 配對 / 取 Realtime 憑證 | ✅ 可匿名，照常 |
| **`GET /api/pos/device-config`** | **拉打印機路由配置（60s）** | 🔴 **401**（本文件要處理嘅唯一一項） |
| Supabase Realtime（`pos_print_jobs`） | 即時喚醒 | ✅ 不受影響（走 APK 自己嘅 supabaseUrl/anonKey） |

⇒ **派工鏈路（claim → 出紙）完全冇斷**，斷嘅只有「邊部機負責印咩」嘅路由配置。

---

## 2. 檢查項目（逐項打勾）

> 現場檢查前先確認：**唔要重啟中繼機**（重啟會即時失去權威路由）。

| # | 檢查 | 方法 | 預期 / 判讀 |
|---|---|---|---|
| C1 | 店內中繼機跑**邊個 App** | 睇 APK 包名；或由 POS「打印中心」嘅 `last_error` 文案判斷 | `兩種通道都失敗｜…` ⇒ `print-relay`；`dispatch failed` ⇒ `macau-ledger-merchant` |
| C2 | APK 版本 | 設定 → 應用程式 → 版本（或 `versionCode`） | 記低，決定要唔要升級 |
| C3 | 已配對？ | `GET /api/pos/print-agent/pair?agentId=<id>` | 要 `status:"paired"` **而且** `supabaseUrl` / `anonKey` 兩欄都有值 |
| C4 | 心跳有冇更新 | App UI 顯示嘅「最後心跳」；或 DB `pos_print_agents.last_seen_at`（需 service_role） | 每 30s 更新 |
| C5 | `device-config` 現時狀態 | `curl -s -o /dev/null -w '%{http_code}\n' 'https://macau-pos-system.vercel.app/api/pos/device-config?storeId=<storeId>'` | **401**（呢個係預期，唔係故障） |
| C6 | 自上次啟動有冇重啟過 | 問現場 / 睇 App uptime | 未重啟 ⇒ 路由仍在新鮮狀態，唔急 |
| C7 | 測試打印 | POS 打印中心 → 測試打印；或落一張真單 | 出紙（並記低印**邊部機**，做對照） |
| C8 | 由 LAN 發現揀機嘅後果 | 數店內有幾部 9100 打印機 | 只有 1 部 ⇒ 風險低；多部 ⇒ 優先做 §4 |

---

## 3. Server 側（我方）要調整嘅設定

> **狀態（2026-09-16 21:45）：已實作，待部署。** 部署之後 §5 嘅 R2／R3 先會由 401 轉 200。
> 未部署之前，中繼機照 §2 檢查、**唔好重啟**。

**目標**：`device-config` GET 由「單閘」改為「**agent 憑證 OR POS 憑證** 兩條路任一條通過」。

實際實作（`src/app/api/pos/device-config/route.ts`）：

```ts
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";

const { agentId, token } = readAgentHeaders(request);           // x-agent-id / x-agent-token
const agent = agentId && token ? await verifyAgent(agentId, token) : null;
// 🔴 一定要綁店：唔驗 storeId 就變咗「任何一部中繼機都可以讀別店配置」
const viaAgent = Boolean(agent && agent.storeId === storeId);

if (!viaAgent) {
  const denied = posRouteAuthGuard(request, storeId, "pos/device-config");
  if (denied) return denied;
} else {
  console.info(`[pos/device-config] 中繼機憑證通道（agent=${agentId}, store=${storeId}）`);
}
```

| 要點 | 說明 |
|---|---|
| 複用既有 helper | `src/lib/print-agent-server.ts`：`readAgentHeaders()`（`:93`）、`verifyAgent()`（`:84`）。`verifyAgent` 已經驗 `revoked_at is null` 同 `sha256(token) === token_hash` —— **唔好另寫一套** |
| 綁店檢查 | `agent.storeId === storeId`（agent 嘅店必須等於 query 嘅店） |
| 保留原閘 | POS 終端 / admin session 路徑照舊可以讀（POS「打印中心」要用） |
| **最小權限** | 中繼憑證通道一律回 `localSettings: null`（已核對兩個中繼 App 都只用 `deviceConfig.printers`），避免外洩 `local_settings.printZones`（KDS 分區權威來源）。POS 終端路徑行為不變 |
| 審計 | 每次經中繼通道讀取都會落一行 `console.info`（Vercel log 可查） |
| 部署次序 | **先部署呢個兼容版本**，再更新 APK。反過來做會有一個窗口期兩邊都拉唔到配置 |

---

## 4. APK 側（中繼機）要調整嘅設定

### 4.1 `print-relay`（`com.macau.printhub`）

`app/src/main/java/com/macau/printhub/relay/RelayApi.kt` —— 加兩個 header（**header 名必須同 `post()` 一致**，見同檔 `:259-260`）：

```kotlin
fun fetchDeviceConfig(
    baseUrl: String,
    storeId: String,
    agentId: String,
    token: String,
): List<RoutingPrinter>? {
    val req = Request.Builder()
        .url(url)
        .addHeader("x-agent-id", agentId)
        .addHeader("x-agent-token", token)
        .get()
        .build()
    // 其餘不變（非 2xx 回 null，由 caller 保留舊值）
```

`app/src/main/java/com/macau/printhub/relay/HubService.kt:216` —— 由 `prefs` 傳入（本來就有）：

```kotlin
val list = api.fetchDeviceConfig(
    BuildConfig.POS_URL,
    storeId,
    prefs.agentId ?: return@launch,
    prefs.agentToken ?: return@launch,
)
```

### 4.2 `macau-ledger-merchant`（`com.macauledger.merchant`）

同一改法，位置 `app/src/main/java/com/macauledger/merchant/posrelay/RelayApi.kt:184`（`fetchDeviceConfig`）+ 其 caller `PosJobRunner.kt`。

### 4.3 發佈注意

| 項目 | 注意 |
|---|---|
| `versionCode` | **一定要 bump**，否則 ADB / 檔案管理員安裝會被拒（「簽名相同但版本唔高」） |
| 簽名 | 要用同一個 keystore（`merchant-release.jks` 之類），否則無法覆蓋安裝 |
| 離線安裝 | 中繼機通常喺店內，直接 ADB / U 盤安裝，唔使經 Play |
| 舊機 | 若同時存在兩個 App 版本，要確認**邊部機跑邊個**（C1） |

---

## 5. 驗證方式

### 5.1 用工具（建議）

```bash
# 匿名（R1）
node tools/verify-relay-agent.cjs

# 帶 agent 憑證（R2）；憑證用環境變數，唔好落 shell history
RELAY_AGENT_ID=xxx RELAY_AGENT_TOKEN=yyy \
  node tools/verify-relay-agent.cjs --agent

# 跨店打（R3）
RELAY_AGENT_ID=xxx RELAY_AGENT_TOKEN=yyy \
  node tools/verify-relay-agent.cjs --agent --store <另一間店 storeId>
```

### 5.2 用 curl（唔想裝 node 時）

```bash
BASE=https://macau-pos-system.vercel.app
SID=<本店 storeId>

# R1 匿名 → 期望 401
curl -s -o /dev/null -w 'R1 %{http_code}\n' "$BASE/api/pos/device-config?storeId=$SID"

# R2 帶 agent 憑證 → 期望 200 且 printers 有內容
curl -s -H "x-agent-id: $AID" -H "x-agent-token: $TOK" \
  "$BASE/api/pos/device-config?storeId=$SID" | head -c 300

# R3 甲店憑證打乙店 → 期望 401
curl -s -o /dev/null -w 'R3 %{http_code}\n' -H "x-agent-id: $AID" -H "x-agent-token: $TOK" \
  "$BASE/api/pos/device-config?storeId=<乙店 storeId>"
```

### 5.3 驗收標準（全部要過）

| # | 檢查 | 預期 |
|---|---|---|
| R1 | 匿名 `GET device-config?storeId=<真店>` | **401** |
| R2 | 帶本店已配對 agent 憑證 | **200**，`deviceConfig.printers` 有內容 |
| R3 | 帶**甲店**憑證打**乙店** | **401**（綁店生效） |
| R4 | 帶已撤銷（`revoked_at` 非空）憑證 | **401** |
| R5 | 中繼機 App UI | 見到「邊部機負責印咩內容」有值 |
| R6 | **重啟中繼機後即時落一張單** | **印得出紙、而且印對機**（今次改動嘅核心，唔可以跳） |

> R6 係唯一真正證明問題已解決嘅測試 —— 重啟會清空 `RelayState`，逼中繼機重新由 server 拉配置。

> ⚠️ **現時（server 兼容版本未部署之前）R2／R3 會回 401**，屬預期：目前部署只有單閘，
> 未識認 agent 憑證。要等 §3 部署之後，R2 才會回 200。R1 現時已經係 401（2026-09-16 21:37 實測 ✅）。

---

## 6. 注意事項與常見問題

### Q1 而家會唔會突然停印？
**唔會。** 證據（APK 源碼）：
1. `RelayApi.fetchDeviceConfig()` 遇非 2xx **回 `null`**，註釋明寫「caller 應保留舊值」；
2. `HubService.kt:217` 係 `if (list != null) RelayState.deviceConfigPrinters = list` ⇒ **唔會用空值覆蓋**；
3. `JobRunner.resolvePrinter()`（`JobRunner.kt:187-250`）四級 fallback，最後一級係本機 LAN 發現。

**唯一會出事嘅情境**：中繼機重啟（斷電 / App 更新 / 強制停止）⇒ in-memory 配置歸零 ⇒ 退到 LAN 發現。

### Q2 點解唔可以直接把 `device-config` 開返匿名？
匿名 = 任何人知道 storeId（**枱 QR 就印住 storeId**）就可以讀你間店嘅設備／打印機／分區／備註／付款方式設定，亦係跨店列舉嘅起點。既然只需改 2 個 header 就解決，唔應該用「降低安全性」換方便。

### Q3 App 顯示「已連線」是否等於印得出？
**唔等於。** Realtime `sendJoin()` 只認 `phx_reply`，**唔會驗證 `pos_print_jobs` 存唔存在** ⇒ 訂到一張唔存在嘅表都會顯示「已連線」。
判別要睇三個獨立訊號：① `claim` 有冇拎到單；② 心跳有冇更新；③ 實際出紙。

### Q4 見到「配對失敗：POS 雲端未設定」點算？
**唔好即刻去改 Vercel env。** 呢句文案係三個無關原因共用（`PosRelaySession.kt:219`）。判別次序：
① `GET /pair` 回 `pending` ⇒ **App 內重新配對**；
② 回 `paired` 但兩欄空白 ⇒ 查 Vercel env（`SUPABASE_URL` / `SUPABASE_ANON_KEY` 成對）；
③ 回 `paired` 且兩欄有值 ⇒ 查 **Ledger 登入態**；
④ 最後才輪到 `BuildConfig.POS_URL`。

### Q5 換機 / 重裝 APK 之後？
會產生**新 `agent_id`**。同一間店可以有多部中繼機（歷史遺留），所以查配對狀態一定要 `.limit(1)`（`pos_print_agents` 嘅 PK 係 `agent_id`，`maybeSingle()` 撞到兩行會報錯）。
換機後舊 agent 應該 `unpair` / 撤銷，否則佢嘅 token 仍然有效（R4 就係測呢個）。

### Q6 由 LAN 發現揀機會有咩後果？
`JobRunner` 會退到「按打印機名匹配」，再退到「**第一個開 9100 嘅機**」。如果店內有多部打印機（收據 / 標籤 / 廚房），有機會**印錯機**——單據會出，但出喺錯嘅機器，而且錯誤係**靜默**嘅（唔會報錯）。

### Q7 憑證會唔會外洩？
`x-agent-token` 係明文經 HTTPS 傳，server 只存 `sha256`（`token_hash`）。中繼機側存喺 SharedPreferences。所以：① 全程 **HTTPS**；② 部機唔好 root / 唔好隨便裝 APK；③ 懷疑外洩就 `unpair` 重新配對（舊 token 即刻失效）。

### Q8 幾時可以完全關掉匿名通道？
兩部 App 都升級完（R5、R6 過）之後，可以再加一步：`device-config` 嘅 GET 只收「admin／POS 憑證 / agent 憑證」，連兼容窗口都收埋。屆時要重新跑一次 `node tools/verify-pos-authgate.cjs` 確認冇打斷 POS「打印中心」。

### Q9 「店內暫停營業」會唔會影響中繼機？
唔會影響打印（中繼機只負責出紙）。但 **`pos_store_status.is_open = false` 會擋匿名掃碼／自助機落單**（`sync/route.ts:698`），呢個係 2026-09-16 交換鑑權恢復之後才真正生效嘅行為。如果店其實在營業，記得開返。
（2026-09-16 21:37 實測：本店 `isOpen:false`。）

### Q10 出咗事要點回滾？
| 情況 | 正確做法 |
|---|---|
| 中繼機拉唔到配置、急住恢復 | **回退該次 Vercel deployment**（唔好改 `POS_REQUIRE_DEVICE_AUTH`，嗰粒制會把**全部**閘一齊打開，等於放棄整輪加固） |
| 只想臨時放行 `device-config` | 為該 route 加一個短期 flag（例：`POS_ALLOW_ANON_DEVICE_CONFIG=1`），部署時寫明到期日 |
| APK 更新出事 | 中繼機唔會停印（見 Q1），可以慢慢修；唔好現場亂試重啟 |

---

## 7. 執行次序（照住做）

```
□ Step 0  今晚：唔好重啟中繼機；營業前做測試打印（C7）
□ Step 1  Server：device-config GET 改「agent OR guard」+ 綁店檢查 → 部署
          （✅ 代碼已寫好：src/app/api/pos/device-config/route.ts；tsc 0 error、eslint 0 error）
□ Step 2  驗 R1（匿名 401）、R2（帶 agent 200）—— 用 node tools/verify-relay-agent.cjs
□ Step 3  APK print-relay：加 header → bump versionCode → 安裝到該店中繼機
□ Step 4  現場驗 R5（UI 見路由）+ R6（重啟後印對機）← 核心驗收
□ Step 5  APK macau-ledger-merchant：同樣改（如該店用呢個 App）
□ Step 6  兩部 App 都過關後，考慮收埋兼容窗口（Q8）
□ Step 7  更新 docs 契約：`x-agent-id` / `x-agent-token` 列為 device-config 嘅合法憑證
```

---

## 8. 交接清單（複製去 ticket）

```
[ ] 確認店內中繼機跑邊個 App + versionCode（C1 / C2）
[ ] 確認 /pair 回 paired 且兩欄齊（C3）
[ ] 確認心照每 30s 更新（C4）
[ ] 確認 anonymous device-config = 401（C5）
[ ] Server 側：device-config 加「agent OR guard」+ agent.storeId === storeId
[ ] APK print-relay：fetchDeviceConfig 帶 x-agent-id / x-agent-token（RelayApi.kt:221）
[ ] APK merchant：同改（posrelay/RelayApi.kt:184）
[ ] 兩部 APK：bump versionCode、同 keystore 簽名
[ ] R1–R6 全部通過（R6 = 重啟後印對機）
[ ] 舊 agent（換機 / 重裝）已 unpair / 撤銷
[ ] 文件更新：合法憑證清單 + 本 runbook 連結
```
