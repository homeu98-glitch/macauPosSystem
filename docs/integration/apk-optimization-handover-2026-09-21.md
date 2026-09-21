# 打印中繼 APK 優化交接文件（macauPosSystem → Ledger 同事）

> **文件日期**：2026-09-21
> **對象**：負責 `macau-ledger-merchant`（POS 中繼 / print-relay）APK 嘅同事
> **發起方**：macauPosSystem（收銀 POS 網頁端）
> **目標**：降低中繼機嘅請求頻率（Vercel invocations），**唔影響任何現有行為**
> **優先級**：P1（A-1）＝ 建議做；P2（A-2）＝ 請核對；其餘＝可選

---

## 0. 一句話摘要

現時**中繼機佔全部伺服器請求 63%**（每分鐘 3 次：心跳 2 次 ＋ claim 1 次）。
伺服器側已經為你哋做咗所有準備（`nextPollMs` 欄位、claim 順手蓋章、agent 憑證通道），
**APK 只要改一個常數嘅來源**，就可以由 3 次/分鐘降到 2 次/分鐘（保守）
或 1 次/分鐘（進取，見 A-3）。**兩邊都唔需要改任何業務邏輯。**

---

## 1. 實測現狀（2026-09-21，營業中，同一間店）

### 1.1 請求分佈（Vercel function log，29.6 分鐘、去重後 141 個請求）

| 次數 | /分鐘 | 端點 | 來源 |
|---:|---:|---|---|
| 59 | 2.00 | `POST /api/pos/print-agent/heartbeat` | **中繼 APK 心跳** |
| 30 | 1.01 | `POST /api/pos/print-agent/claim` | **中繼 APK 領單** |
| 14 | 0.47 | `GET /api/pos/shift` | POS 網頁 |
| 12 | 0.41 | `GET /api/online-order-settings` | POS 網頁 |
| 9 | 0.30 | `POST /api/topup/pending-count` | POS 網頁 |
| 8 | 0.27 | `GET /api/pos/store-status` | POS 網頁 |
| 6 | 0.20 | `GET /api/pos/device-config` | **中繼 APK 拉打印機路由** |

⇒ **`heartbeat` + `claim` ＋ `device-config` 合共 95 / 141 ＝ 67%**。

### 1.2 Supabase 側對照（331 秒樣本）

| 操作 | 次數 | 節奏 | 對應 |
|---|---:|---|---|
| `PATCH pos_print_agents` | 17 | ≈ 每 19.5 秒 | heartbeat 蓋章 ＋ claim 蓋章 |
| `rpc/pos_claim_print_jobs` | 6 | **每 60.18 秒**（極穩定） | APK `TICK_MS = 60_000` |

**推算**：只有 **1 部中繼機**，行為完全對得上源碼常數 ——
`HEARTBEAT_MS = 30_000L`（→ 2 次/分鐘）＋ `TICK_MS = 60_000L`（→ 1 次/分鐘）。

### 1.3 現行源碼位置（已核對，供你哋定位）

| 檔案 | 內容 |
|---|---|
| `posrelay/PosJobRunner.kt:302` | `const val HEARTBEAT_MS = 30_000L` |
| `posrelay/PosJobRunner.kt:301` | `const val TICK_MS = 60_000L` |
| `posrelay/PosJobRunner.kt:303` | `DEVICE_CONFIG_EVERY_TICKS = 5`（→ 每 300 秒拉一次 device-config）|
| `posrelay/PosJobRunner.kt:60-73` | 獨立 `heartbeatJob` 迴圈（`delay(HEARTBEAT_MS)`）|
| `posrelay/PosJobRunner.kt:74-95` | `tickJob` 迴圈（`delay(TICK_MS)`，內含 `claim`）|
| `posrelay/RelayApi.kt:155-180` | `heartbeat(...)` → `HeartbeatResult(ok, unauthorized)` |
| `posrelay/RelayApi.kt:182-219` | `fetchDeviceConfig(storeId)` |
| `posrelay/RelayApi.kt:221-242` | `post(...)`（加 `x-agent-id` / `x-agent-token`）|

---

## 2. 變更項目

### A-1【P1，建議做】心跳間隔改由伺服器回傳值決定

**現況**：`HEARTBEAT_MS = 30_000L` 寫死。
**建議**：改成「伺服器回咩就用咩，冇回就 fallback 30 秒」。

伺服器**已經**回傳呢個欄位（現時值 `60_000`）：

```jsonc
// POST /api/pos/print-agent/heartbeat 回應
{
  "ok": true,
  "serverTime": 1789982505323,
  "nextPollMs": 60000          // ← 新增（2026-09-21）
}
```

**APK 改動（兩處，唔涉及業務邏輯）**

```kotlin
// ① RelayApi.kt：HeartbeatResult 加一個欄位
data class HeartbeatResult(
    val ok: Boolean,
    val unauthorized: Boolean,
    val nextPollMs: Long? = null,      // 🆕 缺失 / 型別唔對 → null（唔會 throw）
)

// heartbeat() 內，原本：
HeartbeatResult(
    ok = resp.optBoolean("ok", false) && !unauthorized,
    unauthorized = unauthorized,
)
// 改成：
HeartbeatResult(
    ok = resp.optBoolean("ok", false) && !unauthorized,
    unauthorized = unauthorized,
    // ⚠️ optInt 對「欄位唔存在」回 0 ⇒ 一定要自己夾下限，唔可以用 0 去 delay
    nextPollMs = resp.optInt("nextPollMs", 0).takeIf { it in 5_000..180_000 }?.toLong(),
)
```

```kotlin
// ② PosJobRunner.kt：heartbeatJob 用伺服器建議值
heartbeatJob = scope.launch {
    while (scope.isActive) {
        var suggested: Long? = null
        try {
            suggested = heartbeatOnce(epoch)      // ← 改成回傳 HeartbeatResult（或只回 nextPollMs）
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) { /* 維持原狀 */ }
        delay(suggested ?: HEARTBEAT_MS)          // ← 由固定 30s 變成「跟伺服器建議」
    }
}
```

> 💡 兩個 `opt*` 嘅容錯性已經查證：`RelayApi.kt` 全程用 `org.json.JSONObject` 嘅
> `optBoolean` / `optString`，**會忽略未知欄位、對缺失欄位回預設值**
> （唔似 `kotlinx.serialization` 預設會 throw）⇒ 加欄位對現役 APK **零影響**。
> 所以**可以先上伺服器、後上 APK**，次序冇限制。

**為咩唔係改細 APK 常數就好**：把 30 秒寫死改成 60 秒一樣達到效果，但日後想再調
（例如關店後放慢到 120 秒）就要再出一個 APK。用伺服器回傳值＝**一次改動，長期可調**。

**預期效果**：`heartbeat` 2.00/min → 1.00/min ⇒ 總請求 4.8/min → 3.8/min（−21%）。
單計中繼機：3 次/分鐘 → 2 次/分鐘（−33%）。

**風險 / 注意**：
- 🔴 **建議值唔可以超過 3 分鐘**。POS 網頁 `print-center.tsx` 寫死
  「`last_seen_at` 距今 ≥ 5 分鐘 → 標示『疑似離線』」，超過就會出**假警報**。
  現時伺服器回 60 秒，非常安全。
- 🔴 **唔可以刪 `ipAddress` / `ipAddresses` 欄位**（見 A-3 備註）。
- 伺服器側一時故障回唔到值 → fallback 30 秒，行為同今日一樣。

---

### A-2【P2，請核對】`fetchDeviceConfig()` 有冇帶 agent 憑證

**背景**：`/api/pos/device-config` 由 2026-09-16 起加咗授權閘。中繼機冇 POS 憑證，
所以伺服器**特登開咗第二條通道**：認 `x-agent-id` + `x-agent-token`
（見 `src/lib/print-agent-server.ts` 嘅 `readAgentHeaders()`、
`src/app/api/pos/device-config/route.ts:45-54`）。

**核對結果（重要）**：

- ✅ **生產環境已經在用呢條通道** —— 伺服器 log 實測有
  `[pos/device-config] 中繼機憑證通道（agent=ag-0fa2296ed7dbdad86947130f14130f81, store=8291f843-…)`
  ⇒ 你哋線上版本**已經**帶住 header，運作正常。
- ⚠️ 但本機兩份源碼副本（`C:\dev\_ref-macau-ledger-merchant` 同 `C:\dev\print-relay`）
  嘅 `fetchDeviceConfig()` 仍然係：
  ```kotlin
  val req = Request.Builder().url(url).get().build()   // ❌ 冇 header
  ```
  ⇒ 屬**舊副本**。請確認你哋 trunk 上嘅版本係已修好嗰個。

**若要修（或想核對寫法）**：

```kotlin
suspend fun fetchDeviceConfig(agentId: String, token: String, storeId: String): List<RoutingPrinter>? =
    withContext(Dispatchers.IO) {
        val url = "$root/api/pos/device-config?storeId=${URLEncoder.encode(storeId, "UTF-8")}"
        val req = Request.Builder()
            .url(url)
            .addHeader("x-agent-id", agentId)
            .addHeader("x-agent-token", token)
            .get()
            .build()
        // …其餘完全不變
    }
```

> header 名同 `post()` 完全一致（`x-agent-id` / `x-agent-token`，大小寫唔敏感）。

**點解要緊**：`POS_REQUIRE_DEVICE_AUTH` 一旦收緊，冇 header 就會 401 →
`routingPrinters` 變空 → 中繼機失去**權威路由**，退到 LAN 發現／Sunmi fallback
⇒ 多打印機嘅店**可能印錯機**（而且係靜默，唔會報錯）。

**呢項唔會省請求**，係**消除一個定時炸彈**，所以放 P2 但建議一齊做。

---

### A-3【可選，進取】完全停用獨立心跳迴圈

**理由（已核對源碼）**：

1. `claim` 每 60 秒**無條件**執行（`PosJobRunner.kt:74-95`，`TICK_MS` 迴圈）。
2. 伺服器側 `claim` 已經**順手蓋 `last_seen_at`**
   （`claim/route.ts` 傳 `recordActivity: true`；`result/route.ts` 一樣）
   ⇒ **成功嘅 claim 本身已經構成一次心跳**，同心跳路線係同一個 `update … returning`。
3. `heartbeat` 送出嘅 `ipAddress` / `ipAddresses`，**伺服器由頭到尾冇存過** ——
   已 grep 全 repo：`pos_print_agents` 冇任何 IP 欄位，route 收到就丟
   （`heartbeat/route.ts` 根本冇讀 payload）。⇒ **刪心跳唔會失去任何伺服器可見資料**。

**要做嘅事**：刪／停 `heartbeatJob`（`PosJobRunner.kt:60-73`），並確認
`PosRelayState.markHeartbeatOk/markHeartbeatFail` 喺 APK UI 上顯示嘅「上次心跳」
改為使用 claim 嘅時間戳（**純顯示層**，唔影響出紙）。

**預期效果**：中繼機由 3 次/分鐘 → **1 次/分鐘（−67%）**；總請求 4.8/min → 2.8/min（−42%）。

**⚠️ 唔建議嘅情況**：
- 若 APK UI 有「心跳健康」相關嘅使用者可見狀態，改成 claim 之後語義有變
  （由「心跳」變「領單」），要你哋自己判斷可接受性；
- 若將來 `claim` 由無條件改成「有 wake-up 才打」（例如依賴 Realtime 訊號），
  呢個方案就會令 `last_seen_at` 疏到不可用 —— 所以**唔好同時做這兩件事**。

**若唔想動 UI**：就只做 A-1（60 秒），已經穩妥。

---

## 3. 伺服器側（macauPosSystem）已經做咗嘅準備

以下**唔需要你哋做嘢**，只係列出合約，方便對照：

| 項目 | 內容 | 生效版本 |
|---|---|---|
| `heartbeat` 回應新增 `nextPollMs` | 現值 `60_000` | 已上線 |
| `claim` / `result` 順手蓋 `last_seen_at` | `recordActivity: true`（`update … returning`，query 數不變）| 已上線 |
| `heartbeat` 由 2 query 變 1 query | 驗證 + 蓋章合併成一個 `update … returning` | 已上線 |
| `/api/pos/device-config` 認 agent 憑證 | `readAgentHeaders()` 讀 `x-agent-id` / `x-agent-token`，並驗 `agent.storeId === storeId` | 2026-09-16 已上線 |
| 蓋章失敗**唔會**回 401 | update 失敗自動退回純讀驗證 ⇒ **唔會誤令 APK 清配對** | 已上線 |

---

## 4. 🔴 唔可以改嘅嘢（會影響出紙或造成假警報）

| 常數 / 行為 | 約束 | 原因 |
|---|---|---|
| `TICK_MS = 60_000L` | **唔建議放慢** | 決定「幾快領到單」＝出紙延遲；亦係 `last_seen_at` 嘅主要存活證明 |
| `HEARTBEAT_MS` 有效上限 | **≤ 3 分鐘** | POS 網頁 5 分鐘就標「疑似離線」⇒ 會出假警報 |
| `DEVICE_CONFIG_EVERY_TICKS = 5`（300s）| 唔建議再放慢 | 打印機改 IP 後，最多 5 分鐘仍然打舊機 |
| `claim` 嘅 `limit = 5` | 唔建議改 | 一輪最多領 5 張單，係出紙吞吐保證 |
| `GET /pair`、`GET /pair-status` | 屬**匿名端點**，唔加憑證 | 加咗反而會壞（配對流程就係未配對時用） |
| `x-agent-id` / `x-agent-token` | **一定要繼續帶** | `claim` / `result` / `heartbeat` 全靠佢驗身分；缺咗＝401＝清配對 |
| `unauthorized` 處理 | 照舊清配對 | 但注意伺服器已保證「只喺真驗證失敗才 401」，唔會因 DB 鎖超時誤報 |

---

## 5. 如何驗證改動生效（唔需要睇 APK 內部）

### 5.1 睇 Vercel function log（最直接）

匯出 `macau-pos-system` 專案嘅函式 log（CSV），數同一個時間窗內嘅請求次數
（⚠️ **一定要按 `requestId` 去重** —— 匯出檔每個請求佔 3 行，只有 1 行有 message）：

| 指標 | 改前（2026-09-21 實測） | A-1 之後預期 | A-3 之後預期 |
|---|---:|---:|---:|
| `POST …/heartbeat` | 2.00 /min | **1.00 /min** | **0** |
| `POST …/claim` | 1.01 /min | 1.01 /min | 1.01 /min |
| 中繼機合計 | **3.01 /min** | 2.01 /min | 1.01 /min |

### 5.2 睇 Supabase log

```
PATCH /rest/v1/pos_print_agents   ← 由每 ~19.5 秒 1 次，變成每 ~60 秒 1 次
POST  /rest/v1/rpc/pos_claim_print_jobs ← 應該維持每 60 秒 1 次（唔應該變）
```

⚠️ Supabase log 記嘅係 **PostgREST** URL，**唔會**出現我哋自己嘅 query 參數
（`ordersOnly` / `skipQueue` / `fields`）—— 搜唔到**唔代表**冇生效。

### 5.3 睇中繼機喺線狀態（功能回歸）

```
GET /api/pos/print-agent/pair-status?storeId=<storeId>
```
回傳嘅 `lastSeenAt` 應該仍然維持 **60 秒內**更新。
（⚠️ 唔可以睇網頁 `/prints` 嗰句「N 分鐘前」—— 嗰個係前端自己計、會膨脹。）

### 5.4 真機回歸（必做）

1. 重啟中繼 App → 確認仍然 `paired`、`last_seen_at` 有更新；
2. 落一張單 → **廚房單 + 收據都要出紙**；
3. 改打印機 IP（POS 設定頁）→ 5 分鐘內新 IP 生效；
4. 拔網線 2 分鐘再插返 → 應該自動回復領單（唔需要重新配對）。

---

## 6. 回滾方法

| 改動 | 回滾 |
|---|---|
| A-1 | `delay(suggested ?: HEARTBEAT_MS)` → 改返 `delay(HEARTBEAT_MS)`（30 秒）。**伺服器唔需要動**（`nextPollMs` 只係多出嚟嘅欄位，舊 APK 會忽略）。 |
| A-2 | 移除兩個 `addHeader` ⇒ 即刻回到 401 行為。⚠️ 只在 `POS_REQUIRE_DEVICE_AUTH` 未收緊時安全。 |
| A-3 | 還原 `heartbeatJob` 迴圈區塊。 |

**伺服器側完全唔需要回滾**：所有改動都係「新增欄位」或「合併 query」，
舊 APK 照樣運作（已用 `org.json.opt*` 容錯性核對過）。

---

## 7. 建議執行次序

```
① A-1（心跳讀 nextPollMs）      ← 一個常數 + 一個欄位，風險最低、即刻省 21%
② A-2（核對 device-config 憑證）← 唔省請求，但消除印錯機風險
③ 觀察 1~2 日，確認 last_seen_at 正常、出紙正常
④ 如仍然想再省 → A-3（停用獨立心跳）
```

---

## 8. 相關文件（macauPosSystem 側）

- `docs/reviews/errwarn-and-call-audit-2026-09-21.md` — 本輪 error/warning 複核 ＋ 呼叫來源分析
- `docs/reviews/always-on-calls-inventory-2026-09-21.md` — 關店後仍然持續嘅呼叫盤點
- `docs/integration/print-relay-device-config-runbook.md` — device-config 中繼憑證通道規格
- `docs/integration/print-relay-hardening-brief.md` — 中繼機加固說明
- `docs/96-sunmi-print-relay-plan.md`（列印中繼 agent 合約）、
  `docs/97-cloud-relay-architecture.md`（雲端中繼架構 / 心跳設計）

---

## 附錄：本次核對用嘅實際指令（唯讀）

```bash
# ① 數 Vercel 請求（自動按 requestId 去重）
node tools/analyze-vercel-log.cjs "<vercel-log-export.csv>"

# ② 睇 Supabase 逐表節奏指紋（間隔中位、10 秒桶）
node tools/_sb-timeline-20260921.cjs "<supabase_logs.csv>"

# ③ 確認線上 bundle 已含最新改動
node tools/verify-deployed-bundle.cjs
```
