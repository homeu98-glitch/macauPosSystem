# 打印中繼 APK 優化交接文件（macauPosSystem → Ledger 同事）

> **版本**：2026-09-21（第 2 版，取代同日早上嘅第 1 版）
> **對象**：負責 `macau-ledger-merchant` / print-relay（雲端打印中繼）APK 嘅同事
> **發起方**：macauPosSystem（收銀 POS 網頁端）
> **核心要求（來自商家 J）**：
> 「**不應該不停的 polling。我明白打印機和中繼有可能需要，但我相信有更好的方法。**
>  我也不太想他們一直 call heartbeat。」
> **優先級**：P1 ＝ 刪獨立心跳（**建議做，風險低**）；P2 ＝ claim 節奏改由伺服器控制；P3 ＝ 憑證核對

---

## 0. 一句話摘要

**中繼機現時每分鐘打 3 次伺服器（心跳 2 次 ＋ claim 1 次）。其中「獨立心跳」完全多餘，
可以直接刪；claim 亦唔需要每 60 秒一次。做完之後 3.0 → 0.33 次/分鐘（−89%），
而且出紙速度不變 —— 因為 APK 本身已經有 Realtime 推送即時叫醒。**

| 指標 | 現況（實測） | 改完之後（預期） | 變化 |
|---|---:|---:|---:|
| `POST …/print-agent/heartbeat` | **2.00 次/分鐘** | **0** | −100% |
| `POST …/print-agent/claim` | 1.01 次/分鐘 | 0.33 次/分鐘 | −67% |
| **中繼機合計** | **3.01 次/分鐘** | **0.33 次/分鐘** | **−89%** |
| 出紙速度 | 即時（Realtime 叫醒） | **不變** | — |

---

## 1. 現況實測（2026-09-21，營業中同一間店）

### 1.1 請求分佈（Vercel function log，29.6 分鐘、按 `requestId` 去重後 141 個請求）

| 次數 | /分鐘 | 端點 | 來源 |
|---:|---:|---|---|
| 59 | **2.00** | `POST /api/pos/print-agent/heartbeat` | 中繼 APK |
| 32 | 1.08 | `POST /api/pos/print-agent/claim` | 中繼 APK |
| 10 | 0.34 | `GET /api/pos/device-config` | 中繼 APK |
| 4 | 0.14 | `POST /api/pos/print-agent/result` | 中繼 APK |

⇒ **中繼機佔全部伺服器請求 63%**，其中心跳單獨佔 **12%**。

### 1.2 Supabase 側對照（印證節奏對得上 APK 常數）

| 操作 | 節奏 | 對應常數 |
|---|---|---|
| `PATCH pos_print_agents` | 每 ~19.5 秒 | heartbeat 蓋章（30s）＋ claim 蓋章（60s） |
| `rpc/pos_claim_print_jobs` | **每 60.18 秒**（極穩定） | `TICK_MS = 60_000` |

### 1.3 你哋源碼嘅相關位置（本機參考副本，**請以你哋 trunk 為準**）

| 檔案 | 內容 |
|---|---|
| `posrelay/PosJobRunner.kt:301-303` | `TICK_MS = 60_000L`／`HEARTBEAT_MS = 30_000L`／`DEVICE_CONFIG_EVERY_TICKS = 5` |
| `posrelay/PosJobRunner.kt:60-73` | **獨立 `heartbeatJob` 迴圈**（本文件建議刪走） |
| `posrelay/PosJobRunner.kt:74-95` | `tickJob` 迴圈（claim ＋ 每 5 tick 拉 device-config） |
| `posrelay/PosJobRunner.kt:111-124` | `onRealtimeWake()` ← **Realtime 叫醒入口（已經有）** |
| `posrelay/PosRealtimeSubscriber.kt:84-120` | 訂 `pos_print_jobs` **INSERT** → `onWake()` |
| `posrelay/RelayApi.kt:155-180` | `heartbeat(...)` |
| `posrelay/RelayApi.kt:113-138` | `claim(...)` ← 建議由呢度讀 `nextPollMs` |
| `posrelay/RelayApi.kt:182-219` | `fetchDeviceConfig(storeId)` ← P3 請核對憑證 |
| `posrelay/RelayApi.kt:221-242` | `post(...)`（加 `x-agent-id` / `x-agent-token`）|

---

## 2. 🔑 為何「獨立心跳」可以整個刪走（三條理由）

### 理由 ①：`claim` 已經蓋同一個章 —— 心跳係完全冗餘

伺服器側（macauPosSystem）已經改成：**`claim` 每次驗證 agent 嘅同時，順手蓋 `last_seen_at`**
（`claim/route.ts` 傳 `recordActivity: true`，用一個 `update … returning` 同時做「驗證＋記活躍」）。

而心跳**唯一**嘅效果就係蓋 `last_seen_at`。既然 `claim` 每輪都會蓋 →
**「心跳」呢個概念已經由 `claim` 兼任**，獨立心跳迴圈係純浪費。

### 理由 ②：心跳送嘅資料，伺服器由頭到尾冇讀過

`heartbeat` 會送 `ipAddress` / `ipAddresses`（本地網卡 IP）。但：
- 全 repo（POS 專案）**冇任何 `ip_address` 欄位**，`pos_print_agents` 亦冇；
- `heartbeat/route.ts` **根本冇讀 payload**，只讀 header 去驗身分。

⇒ **刪心跳唔會失去任何伺服器可見資料**。

### 理由 ③：APK 本身已經係 push-first —— 心跳唔係「快」嘅來源

你哋已經有 `PosRealtimeSubscriber`：訂 `pos_print_jobs` **INSERT**（filter `store_id`）
→ `onWake()` → `PosJobRunner.onRealtimeWake()` → `tickOnce()` → claim → 出紙。

即係：**有單要印嗰一刻就即刻叫醒**，唔係靠 30 秒心跳或 60 秒 tick。
`heartbeat`（30s）同 `claim`（60s）**本來就係兜底**，只係兜底跑到太密。

---

## 3. 改動 1【P1】刪走獨立心跳迴圈

**`PosJobRunner.kt`**

```kotlin
// ❌ 刪走成個 heartbeatJob 區塊（start() 之內，約 60-73 行）
heartbeatJob = scope.launch {
    while (scope.isActive) {
        try {
            heartbeatOnce(epoch)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            PosRelayState.markHeartbeatFail(e.message)
            PosRelayState.log("心跳迴圈異常: ${e.message}")
            noteFailure(isHeartbeat = true)
        }
        delay(HEARTBEAT_MS)
    }
}
```

同時要處理：
1. `private var heartbeatJob: Job? = null` → 刪（同 `stop()` 內嘅 `heartbeatJob?.cancel()`）。
2. `heartbeatOnce()` / `HEARTBEAT_MS` → 可保留但唔再被呼叫（或者一併刪，睇你哋整潔度要求）。
3. **`heartbeatFailStreak` / `markHeartbeatOk()` / `markHeartbeatFail()` 嘅去留要諗清楚**（見下面「⚠️ 唯一要注意」）。
4. `RelayApi.heartbeat(...)` 可以保留（唔再呼叫）或者標 `@Deprecated`；伺服器端**唔會**因為冇心跳而 401。

### ⚠️ 唯一要注意：APK 自己嘅「健康狀態」顯示

`heartbeatFailStreak` 目前同 `claimFailStreak` 一齊餵 `noteFailure()`（連續 3 次失敗 → `onUnhealthy()`）。
刪心跳之後，**`onUnhealthy()` 只會由 `claimFailStreak` 觸發** ——
邏輯上等價（`claim` 一樣會驗身分、一樣會因為斷線失敗），但你哋要確認：

- 如果 UI 有寫「上次心跳：N 秒前」，要改成讀 **claim 成功嘅時間**（純顯示層，唔影響出紙）。
- 如果 `heartbeatJob` 有做任何**其他**副作用（例如順手重連 Realtime、更新本地 IP 顯示），
  要將嗰部分搬去 `tickJob` 或者 Realtime 回呼，**唔可以連埋一齊刪**。

> 💡 我哋只能睇到你哋嘅參考副本，`heartbeatOnce()` 內除咗 `relayApi.heartbeat(...)` 之外
> 只做 `PosRelayState.refreshLocalIps()` / `markHeartbeatOk()` → 冇其他真實副作用。
> 但**請你哋自己喺 trunk 覆核一次**。

---

## 4. 改動 2【P2】claim 節奏改由伺服器控制（`nextPollMs`）

**背景**：`TICK_MS = 60_000L` 係兜底，而 Realtime 已經負責即時性。
但**唔應該淨係改大 APK 常數** —— 咁樣日後想再調（關店放慢／夜間放慢）就要再出一個 APK。

**伺服器已經回傳建議值**（macauPosSystem 側已上線）：

```jsonc
// POST /api/pos/print-agent/claim 回應
{
  "ok": true,
  "jobs": [ /* … */ ],
  "printers": [],
  "nextPollMs": 180000        // 🆕 建議下次幾時再 claim（現值 3 分鐘）
}
```

**APK 改動（兩處）**

```kotlin
// ① RelayApi.kt：ClaimResult 加欄位
data class ClaimResult(
    val jobs: List<JSONObject>,
    val printers: List<JSONObject>,
    val error: String?,
    val unauthorized: Boolean = false,
    val nextPollMs: Long? = null,      // 🆕 缺失 / 超範圍 → null
)

// claim() 內，回傳時加：
ClaimResult(
    jobs = resp.optJSONArray("jobs").toObjectList(),
    printers = resp.optJSONArray("printers").toObjectList(),
    error = null,
    nextPollMs = resp.optInt("nextPollMs", 0).takeIf { it in 5_000..180_000 }?.toLong(),
)
```

```kotlin
// ② PosJobRunner.kt：tickJob 嘅 delay 由回應決定
while (scope.isActive) {
    var suggested: Long? = null
    try {
        suggested = tickOnce(epoch)          // ← 改成回傳 ClaimResult.nextPollMs（或 TickResult）
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        PosRelayState.markTickError(e.message)
        PosRelayState.log("對賬迴圈異常: ${e.message}")
        noteFailure(isHeartbeat = false)
    }
    ticks += 1
    delay(suggested ?: TICK_MS)              // ← 由固定 60s 變成「跟伺服器建議」
}
```

### 🔴 為何上限係 180 秒（3 分鐘）—— 唔可以再大

POS 網頁嘅打印中心寫死：**`last_seen_at` 距今 ≥ 5 分鐘 → 顯示「疑似離線」**。
刪咗心跳之後，`last_seen_at` 只會由 `claim` 更新 ⇒ claim 間隔 **一定要 ≤ 3 分鐘**，
否則會出**假警報**（明明在線顯示離線）。

> 如果將來想放到 300 秒以上：**必須同時通知我哋放寬嗰個 UI 閾值**，唔可以單邊改。

### ⚠️ 加欄位嘅安全性（已查證）

你哋用 `org.json.JSONObject` 嘅 `optBoolean` / `optString` / `optInt`：
**會忽略未知欄位、對缺失欄位回預設值**（唔似 `kotlinx.serialization` 預設會 throw）。
⇒ 加 `nextPollMs` 對**現役 APK 零影響**，所以**伺服器可以先上、APK 後上**，次序冇限制。

---

## 5. 改動 3【P3，請核對】`fetchDeviceConfig()` 有冇帶 agent 憑證

**背景**：`/api/pos/device-config` 由 2026-09-16 起加咗授權閘。中繼機冇 POS 憑證，
所以伺服器**特設第二條通道**：認 `x-agent-id` + `x-agent-token`
（`readAgentHeaders()` ＋ 驗 `agent.storeId === storeId`）。

**核對結果**：
- ✅ **生產環境已經在用呢條通道** —— 伺服器 log 實測有
  `[pos/device-config] 中繼機憑證通道（agent=ag-0fa2296ed7dbdad86947130f14130f81, store=…)`
  ⇒ 你哋線上版本**已經**帶住 header，運作正常。
- ⚠️ 但**本機兩份參考副本**（`_ref-macau-ledger-merchant` 同 `print-relay`）嘅
  `fetchDeviceConfig()` 仍然係冇 header 嘅版本 ⇒ 屬舊副本。請確認 trunk 已同步。

**若要修（或核對寫法）**：

```kotlin
val req = Request.Builder()
    .url(url)
    .addHeader("x-agent-id", agentId)      // 🆕
    .addHeader("x-agent-token", token)     // 🆕
    .get()
    .build()
```

**點解要緊**：一旦 `POS_REQUIRE_DEVICE_AUTH` 收緊，冇 header 就會 401 →
`routingPrinters` 變空 → 中繼機失去**權威路由**，退到 LAN 發現／Sunmi fallback
⇒ 多打印機嘅店**可能印錯機**（而且係靜默，唔會報錯）。

**呢項唔省請求**，係消除一個定時炸彈。

---

## 6. 🔴 唔可以改嘅嘢

| 常數 / 行為 | 約束 | 原因 |
|---|---|---|
| `claim` 間隔（`nextPollMs`）| **≤ 180_000（3 分鐘）** | POS 網頁 5 分鐘就標「疑似離線」⇒ 會出假警報 |
| `claim` 嘅 `limit`（預設 5）| 唔建議改 | 一輪最多領 5 張單，係出紙吞吐保證 |
| `DEVICE_CONFIG_EVERY_TICKS = 5`（300s）| 維持 | 打印機改 IP 後生效延遲嘅上界 |
| `x-agent-id` / `x-agent-token` | **一定要繼續帶** | claim / result / heartbeat 全靠佢驗身分；缺咗 ＝ 401 ＝ 清配對 |
| `PosRealtimeSubscriber` | **絕對唔可以拆** | 佢係「即時叫醒」嘅唯一來源；拆咗就變返純輪詢 |
| `GET /pair`、`GET /pair-status` | 屬**匿名端點**，唔加憑證 | 配對流程本身就要喺未配對時用 |
| `unauthorized` 處理（清配對）| 照舊 | 伺服器已保證「只喺真驗證失敗才回 401」（蓋章失敗會降級為純讀，唔會誤報）|

---

## 7. 如何驗證改動生效（唔需要睇 APK 內部）

### 7.1 Vercel function log（最直接）

匯出 `macau-pos-system` 專案嘅函式 log（CSV），數同一時間窗內嘅請求次數。
⚠️ **一定要按 `requestId` 去重** —— 匯出檔每個請求佔 **3 行**，只有 1 行有 message。

| 指標 | 改前 | 改後預期 |
|---|---:|---:|
| `POST …/heartbeat` | 2.00 /min | **0** |
| `POST …/claim` | 1.01 /min | **≈0.33 /min** |
| 中繼機合計 | 3.01 /min | **≈0.33 /min** |

### 7.2 Supabase log

```
PATCH /rest/v1/pos_print_agents        ← 由每 ~19.5 秒 1 次 → 每 ~180 秒 1 次
POST  /rest/v1/rpc/pos_claim_print_jobs ← 由每 60 秒 → 每 180 秒 1 次
```

### 7.3 真機回歸（必做）

1. 重啟中繼 App → 確認仍然 `paired`、`last_seen_at` 有更新（**≤3 分鐘**）；
2. POS 網頁打印中心**唔應該**顯示「疑似離線」；
3. 落一張單 → **廚房單 ＋ 收據都要出紙**（呢步係驗 Realtime 叫醒仍然有效）；
4. 拔網線 2 分鐘再插返 → 應該自動回復領單，**唔需要重新配對**；
5. 改打印機 IP（POS 設定頁）→ 5 分鐘內新 IP 生效。

---

## 8. 回滾方法

| 改動 | 回滾 |
|---|---|
| 刪心跳 | 還原 `heartbeatJob` 區塊 ＋ `delay(HEARTBEAT_MS)` 迴圈。**伺服器唔需要動。** |
| `nextPollMs` | `delay(suggested ?: TICK_MS)` → 改返 `delay(TICK_MS)`（60 秒）。**伺服器唔需要動。** |
| 憑證 header | 移除兩個 `addHeader` ⇒ 回到 401 行為（⚠️ 只在 `POS_REQUIRE_DEVICE_AUTH` 未收緊時安全）|

**伺服器側完全唔需要回滾**：所有改動都係「新增欄位」或「合併 query」，舊 APK 照樣運作。

---

## 9. 附錄：伺服器側（macauPosSystem）已經做咗嘅準備

以下**唔需要你哋做嘢**，只係列出合約方便對照：

| 項目 | 內容 | 狀態 |
|---|---|---|
| `claim` 回應新增 `nextPollMs` | 現值 `180_000` | 已上線 |
| `claim` / `result` 順手蓋 `last_seen_at` | `recordActivity: true`（一個 `update … returning`，query 數不變）| 已上線 |
| `heartbeat` 由 2 query 變 1 query | 驗證 ＋ 蓋章合併 | 已上線 |
| `/api/pos/device-config` 認 agent 憑證 | `x-agent-id` / `x-agent-token` ＋ 綁店驗證 | 2026-09-16 已上線 |
| 蓋章失敗**唔會**回 401 | update 失敗自動退回純讀驗證 ⇒ **唔會誤令 APK 清配對** | 已上線 |
| 伺服器守衛測試 | `heartbeat-contract.test.ts` 守住 `nextPollMs` 值域、`recordActivity`、`ok`/`serverTime` 不被剝走 | 已加 |

## 10. 建議執行次序

```
① 刪獨立心跳迴圈（P1）        ← 一個區塊，風險最低，即刻 −67%
② claim 讀 nextPollMs（P2）   ← 一個欄位 ＋ 一行 delay，再 −67%（合共 −89%）
③ 核對 device-config 憑證（P3）← 唔省請求，但消除印錯機風險
④ 觀察 2~3 日：last_seen_at 正常、打印中心冇假警報、出紙正常
```

## 11. 相關文件（macauPosSystem 側）

- `docs/96-sunmi-print-relay-plan.md`（列印中繼 agent 合約）
- `docs/97-cloud-relay-architecture.md`（雲端中繼架構 / 心跳設計）
- `docs/integration/print-relay-device-config-runbook.md`（device-config 中繼憑證通道規格）
- `docs/integration/print-relay-hardening-brief.md`（中繼機加固說明）
- `docs/reviews/errwarn-and-call-audit-2026-09-21.md`（請求數 / egress 實測與來源分析）
- `docs/reviews/session-and-write-gate-design-2026-09-21.md`（push-first 原則與輪詢閘設計）
