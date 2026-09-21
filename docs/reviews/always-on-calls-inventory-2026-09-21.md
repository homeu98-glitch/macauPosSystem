# 持續執行呼叫盤點（關店情境）— 必要性評估

> 日期：2026-09-21 ｜ 樣本：Supabase `supabase_logs (3).csv`（**07:16–07:40 UTC ＝ 澳門 15:16–15:40**，
> 店已關：截圖顯示線上／線下接單皆「已暫停」）＋ Vercel log（全路由，29.8 分鐘）
> 結論一句話：**關店後真正持續「燒」嘅唔係 heartbeat，而係「每 36 秒一次嘅全量 state 拉取」；
> heartbeat 本身係「多餘嘅」，因為 claim 每 65 秒已經做緊同一件事嘅驗證。**

---

## 0. 實測：關店後 24 分鐘嘅全部請求（Supabase 側）

| 表 | 查詢形狀 | 次數 | /分鐘 | 屬於 |
|---|---|---|---|---|
| `pos_print_agents` | `GET select=5欄 agent_id=eq` | **70** | 2.92 | `verifyAgent()`（claim / heartbeat / result / pair-status 共用） |
| `pos_print_agents` | `PATCH agent_id=eq` | **44** | 1.83 | **heartbeat 蓋 `last_seen_at`** |
| `pos_print_jobs` | `GET select=* limit=200` | **35** | 1.46 | 🔴 **全量 state 拉取**（state route 嘅 printJobs 查詢） |
| `pos_queue_events` | `GET select=* limit=300` | **35** | 1.46 | 🔴 **全量 state 拉取**（queue 查詢） |
| `pos_device_configs` | `GET select=* limit=1` | **40** | 1.67 | 🔴 **全量 state 拉取** |
| `rpc/pos_orders_page` | POST | **38** | 1.58 | 訂單（全量拉取 ＋ 報表） |
| `pos_note_presets` / `pos_print_templates` | GET | 36 / 36 | 1.51 | 🔴 全量 state 拉取（每次都陪拉） |
| `pos_print_jobs` | `PATCH select=1欄 id=eq` | 28 | 1.17 | `/api/pos/sync` 寫出紙狀態 |
| `rpc/pos_claim_print_jobs` | POST | **22** | 0.92 | **APK claim（每 65 秒）** |
| `pos_print_jobs` | POST | 14 | 0.58 | 新 print job |
| `pos_queue_events` | POST | 14 | 0.58 | sync 批次 upsert（已優化） |
| `pos_shifts` | `GET select=* limit=1` | 5 | 0.21 | 班次同步（180 秒） |
| `/realtime/v1/websocket` | GET | 1 | 0.04 | Realtime（可忽略） |

**兩條最重要嘅推論：**

1. 🔴 **全量 state 拉取 ＝ 35~40 次／24 分鐘（每 ~36 秒一次）**，而且**關店後完全冇停**。
   指紋：`queue GET` ≈ `printJobs GET` ≈ `device_configs` ≈ `templates` ≈ `note_presets` ≈ `orders RPC`
   —— 六個數字幾乎一樣 ⇒ 同一個操作造成。**呢個佔咗關店後大部分請求。**
2. 🔴 **heartbeat ＝ 44 次 PATCH（每 33 秒）＋ 44 次對應嘅 verify GET ＝ 88 個請求**，
   佔 `pos_print_agents` 114 次嘅 **77%**。**而 claim 每 65 秒已經做緊一次完整驗證。**

---

## Q1：關店後，heartbeat 同 print-agent 相關呼叫仲有冇必要？

**分三層答：**

| 呼叫 | 關店後仲有冇用？ | 判斷 |
|---|---|---|
| `POST /print-agent/claim` | **仍然有用，但唔需要咁密。** 關店後冇新單，claim 只剩兩個用途：① 重試 `failed` 單 ② 救回「認領咗但冇回報」嘅卡死單（RPC 內嘅 90 秒／6 分鐘窗口） | ⚠️ **應退避**（65 秒 → 關店時 2~5 分鐘），**唔應該停** |
| `POST /print-agent/heartbeat` | **關店後價值最低**：`last_seen_at` 只用嚟喺後台顯示「中繼機在線」。關店後冇人睇，而且 claim 已經持續證明存活 | ✅ **可完全省**，或放慢到 2~3 分鐘（見 Q2 硬約束） |
| `POST /print-agent/result` | 只在出紙後發生，關店後自然停 | ✅ 冇問題 |
| `GET /print-agent/pair-status` | 只喺**打印中心頁開著**時每 30 秒（client） | ✅ 關頁即停 |

**⚠️ 但要講清楚（避免誤判優先次序）**：print-agent 相關呼叫**唔係 egress 元兇** ——
每次只回 1 行（≈300 B），114 次／24 分鐘 ≈ **1.4 MB／日**。
佢係「**請求數**」與「**架構清晰度**」問題，唔係用量問題。
**真正嘅用量仍然係全量 state 拉取（35~40 次／24 分鐘、每次 ~857 KB ⇒ ~30 MB／24 分鐘）。**

---

## Q2：一次成功嘅 claim 本身係唔係已經構成 heartbeat？

### 技術上：**係，而且係完全等價嘅證據。**

`claim` route 做嘅事（`src/app/api/pos/print-agent/claim/route.ts:19-36`）：

```ts
const agent = await verifyAgent(agentId, token);   // ← ① 讀 pos_print_agents 驗身份（GET）
if (!agent) return 401;
const { data, error } = await supabase.rpc("pos_claim_print_jobs", {...});   // ← ② claim
```

`verifyAgent()`（`src/lib/print-agent-server.ts:84`）→ `loadPairedAgent()` →
`select(...).eq("agent_id", id)` ⇒ **已經讀咗 `pos_print_agents` 並確認 agent 存在、未 revoke、token 正確**。
`heartbeat` 做嘅額外事情只有一件：`update({ last_seen_at })`（`heartbeat/route.ts:24-27`）。

### 所以：**`last_seen_at` 係唯一多得嚟嘅資訊，而佢可以零成本取得。**

| 做法 | 效果 | 需要改 APK？ |
|---|---|---|
| **A. 把 `last_seen_at` 蓋章搬入 `pos_claim_print_jobs` RPC**（`update pos_print_agents set last_seen_at = now() where agent_id = p_agent_id`） | claim 自動變心跳；**零額外 round trip**（RPC 本來就一個 call） | ❌ 唔需要（服務端改就得） |
| **B. `loadPairedAgent()` 由 `select` 改成 `update({last_seen_at}).select(...)`** | 任何 agent 呼叫（claim / result / heartbeat）都順手蓋章 ⇒ 每次由 2 個 query 變 1 個 | ❌ 唔需要 |
| **C. APK 停止發獨立 heartbeat**（因為 claim 已蓋章） | 直接省 **88 個請求／24 分鐘（`pos_print_agents` 嘅 77%）** | ✅ 需要改 APK |
| **D. heartbeat 回應帶 `nextPollMs`（服務端控制頻率）** | 服務端可以「關店就叫 APK 放慢」而唔使改 APK 政策 | ✅ 需要 APK 讀呢個欄 |

**建議組合：A（或 B）先做 → 再改 APK 做 C** ⇒ 先令 heartbeat「變得可以省」，再真正省。
⚠️ **A/B 有代價**：把「每次呼叫一次 SELECT」變「一次 UPDATE」——請求數減半，但 DB 寫入變多
（single-row UPDATE，`pos_print_agents` 係細表，可接受；但要知悉呢個係 trade-off，唔係純賺）。
若想保守：**只做 C**（若 APK 可改），服務端完全唔改。

### 🔴 心跳頻率嘅硬約束（唔可以只睇「有冇必要」）

`last_seen_at` **只用作顯示**（全 repo 只有 print-center 讀，冇任何 server 邏輯靠佢撤銷 agent ✓），
但 UI 有寫死閾值：

```ts
// src/components/print-center.tsx:1789
`中繼打印機：最後心跳 ${minutesAgo} 分鐘前${minutesAgo >= 5 ? "（疑似離線）" : ""}。`
```

⇒ **心跳間隔一旦 ≥ 5 分鐘，打印中心就會誤報「疑似離線」。**
⇒ **安全上限係 2~3 分鐘**；若要做 5 分鐘以上，**必須同時改呢個 UI 閾值**（例如改 10 分鐘）。
（設計文件 `docs/97:123` 寫住「每 ~60s 打一次 /heartbeat」，但**實測係每 ~33 秒**——
所以現時係設計值嘅兩倍頻率，本身就有下調空間。）

---

## Q3：**全部**持續執行嘅呼叫清單 ＋ 逐項必要性評估

### A. 中繼 APK（Android，`okhttp/4.12.0`）→ 本 repo route

| 呼叫 | 實測頻率 | 每次 Supabase | 必要性 | 可否省 / 降頻 | 改邊度 |
|---|---|---|---|---|---|
| `POST /print-agent/claim` | **每 65 秒** | 2（verify GET ＋ claim RPC） | 🔴 **出紙必需**（唔 claim 就永遠唔出紙） | ⚠️ 空閒／關店退避到 2~5 分鐘；由「服務端回 `nextPollMs`」控制最好 | 服務端 + APK |
| `POST /print-agent/heartbeat` | **每 33 秒** | 2（verify GET ＋ PATCH） | 🟠 **低**（claim 已提供同等證據） | ✅ **可完全省**，或放慢到 5 分鐘 | 服務端(A/B) + APK(C) |
| `POST /print-agent/result` | 只喺出紙後 | 2 | 🔴 必需（冇佢就唔知印成功／失敗） | ❌ 唔可以省 | — |

### B. 瀏覽器（POS 分頁開住）→ route

| 呼叫 | 實測／設計頻率 | 觸發者 | 必要性 | 可否省 / 降頻 | 改邊度 |
|---|---|---|---|---|---|
| `GET /api/pos/state`（**全量**） | 🔴 **每 ~36 秒（關店都係）** | mount／queue 變／`backToTables()`／**realtime 重連** | 🔴 需要（但唔需要咁密） | ✅ **守衛已寫、待部署**（估 −90%）；`backToTables()` 仍屬人手步速 | 已改 `pos-app.tsx` |
| `GET /api/online-order-settings` | 每次頁面載入 **4~8 次**（實測 3 分鐘 53 次） | **多個 hook 各自 mount**（thundering herd） | 🟠 需要但重複 | ✅ **可合併**（改成模組層單一 fetch＋共用 promise） | `use-merchant-order-config.ts` |
| `GET /api/pos/store-status` | 事件驅動 ＋ 每次進入 route | 線上接單開關狀態 | 🔴 需要（開關店正確性） | ❌ 唔建議省 | — |
| `GET /api/topup/pending-count` | 5 分鐘 ＋ 回前景（30s 去抖） | 側欄「充值待審」紅點 | 🟠 **低**（純顯示） | ✅ 可再放慢（15 分鐘）或改成「撳入會員頁先拉」 | `pending-count-store.ts` |
| `GET /api/pos/shift` | 180 秒 | 班次跨機對齊 | 🟠 中 | ⚠️ **關店後可停**（已收工就唔需要對齊）；或放寬到 5 分鐘 | `pos-app.tsx:745` 附近 |
| `POST /api/pos/sync` | 事件驅動 ＋ 30 秒（**只在有 pending 時**） | 上雲（落單／結帳／出紙） | 🔴🔴 **絕對必需** | ❌ 唔可以省；已批次化 | — |
| `GET /api/pos/device-config` | 每次進入設定／打印頁 | 讀終端設定 | 🟠 中 | ✅ 可加記憶體快取（同一 session 內只拉一次） | 各頁 |
| `GET /print-jobs/status` | 30 秒（**打印中心頁開著時**） | 顯示雲端出紙結果 | 🟠 中 | ✅ 關頁即停（已做）；進一步可只在有未完成 job 時輪詢 | `print-center.tsx` |
| `GET /print-agent/pair-status` | 30 秒（打印中心頁開著時） | 偵測配對／在線 | 🟠 中 | ✅ **已配對就可以停輪詢**（或放慢到 5 分鐘） | `print-center.tsx` |

### C. 純本機（**零網絡**，唔需要處理）

| 模組 | 週期 | 為何唔係問題 |
|---|---|---|
| `print-flush-worker.tsx` | 2.5 秒 | **只讀 localStorage**；只有 relay 通道才間接觸發 flush |
| `pos/sync-acks.ts` `useSyncHealth` | 15 秒 | **只讀 localStorage**（`computeSyncHealth`） |
| `sync-flush.ts` | 30 秒 | 只在 queue 有 pending 時才發 POST |
| KDS 看門狗 | 15 秒 tick | 只喺 `/kitchen`、`/expo` 開頁時；**已停用 = 0** |

---

## 建議執行次序（按 ROI）

| # | 項目 | 效果 | 風險 | 需要 API 改動 |
|---|---|---|---|---|
| **1** | **部署今日已寫嘅 resubscribe 守衛** | 全量拉取 35 → **~5 次／24 分鐘**（−85%） | 極低（已測 924 tests + 17 路由） | 已寫，待 push |
| **2** | **claim 兼任 heartbeat**（RPC 內蓋 `last_seen_at`，或 verify 順手蓋） | `pos_print_agents` 114 → **~26**（−77%） | 低（A/B 係寫入換請求；C 最乾淨） | 服務端（A/B）＋ APK（C） |
| **3** | **空閒／關店時 claim 退避**（`nextPollMs` 由服務端控制） | claim 22 → **~5** | 中（影響「卡死單」恢復延遲；2~5 分鐘可接受） | 服務端 ＋ APK |
| **4** | `online-order-settings` herd 收口（模組層單一 fetch） | 64 → **~15**（−77%） | 低 | `use-merchant-order-config.ts` |
| **5** | `pair-status` 已配對後停輪詢 | 打印中心開頁時 ~2 → 0.2／分鐘 | 低 | `print-center.tsx` |
| **6** | `topup/pending-count` 再放慢（5→15 分鐘）或改按需 | 29 → ~10 | 低（紅點延遲） | `pending-count-store.ts` |
| **7** | `pos/shift` 關店後停／放寬 | 27 → ~5 | 低 | `pos-app.tsx` |

**⚠️ 唔建議動**：`POST /api/pos/sync`（上雲命脈）、`/api/pos/store-status`（開關店正確性）、
Realtime 訂閱（即時性命脈，只佔 1% egress）。

---

## ✅ 已落實：項目 1 ＋ 2A/2B（2026-09-21）

### 項目 1：realtime 重連補拉守衛 —— **已上線**

commit `8e26f00`（07:35:26Z）→ Vercel Production `07:36:07Z`（澳門 15:36）。
**線上 bundle 掃到新標記 `重連補拉已跳過` ⇒ 確認生效**（同批 5 個標記全部命中）。
詳細改動見 `egress-optimization-implemented-2026-09-21.md` §0.5。

### 項目 2A/2B：`claim` 兼任 heartbeat —— **已實作（未 commit）**

#### 🔴 實作前發現：**原版 2B 唔可以做**

`verifyAgent()` / `loadPairedAgent()` 嘅呼叫端包括：

| Route | Method | 用途 |
|---|---|---|
| `print-agent/heartbeat` | POST | 心跳 |
| `print-agent/claim` | POST | claim |
| `print-agent/result` | POST | 出紙結果 |
| `print-agent/unpair` | POST | 解配對 |
| **`pos/device-config`** | **GET**（`route.ts:46`，GET 由 `:8` 開始） | agent 讀打印機配置 |
| **`print-agent/pair`** | **GET**（`route.ts:76`） | 配對取憑證 |

⇒ **若照原方案改 `loadPairedAgent` 本身，就會令兩條 GET 路由寫入 DB**（違反 HTTP 語義：
GET 應該安全／可快取／可 prefetch；瀏覽器預取、代理重試、爬蟲都會意外改寫 `last_seen_at`，
而 `last_seen_at` 正是「中繼機在線」嘅唯一證據）。

#### ✅ 實際做法：`recordActivity` 選項，**預設純讀**，只有 POST 路由傳 `true`

```ts
loadPairedAgent(agentId, { recordActivity?: boolean })   // 預設 false（純讀）
verifyAgent(agentId, token, options?)
```

`recordActivity: true` 時改用 **`update({last_seen_at}).eq(...).select(columns).maybeSingle()`**
—— 一個 query 同時「驗證 ＋ 蓋章」（`update … returning`）。

| 呼叫端 | 改動 | 效果 |
|---|---|---|
| `heartbeat` | `verifyAgent(..., { recordActivity: true })` ＋ **移除原本嘅獨立 UPDATE** | **2 query → 1 query**（每次心跳省 1 個） |
| `claim` | 加 `{ recordActivity: true }` | query 數不變（verify + RPC），但**順手蓋章** ⇒ claim 正式兼任心跳（為日後 APK 慳 heartbeat 鋪路） |
| `result` | 同上 | 同上 |
| `device-config`（GET）、`pair`（GET） | **不動** | 保持純讀 ✅ |

#### 🔴 一個必須有嘅保護：蓋章失敗**唔可以**當驗證失敗

驗證失敗一律回 **401**，而 APK 收到 401 會**清走配對、返配對畫面**
（見 `heartbeat/route.ts` 頂部註解）。合併之後，一次「UPDATE 鎖超時／連線抖動」
就會變成 401 ⇒ **收銀機要重新配對中繼機**，比「今次冇蓋到章」嚴重得多。
⇒ `loadPairedAgent` 喺 update 失敗時**降級為純讀再驗一次**：
讀得到就照常運作（只係呢輪冇更新 `last_seen_at`）；讀都失敗就同舊版一樣返 null（401）。

#### 驗證

| 檢查 | 結果 |
|---|---|
| `tsc --noEmit` | **0 error** |
| `node --test` | **929 passed / 0 failed**（924 ＋ 5 新） |
| 新測試 `src/lib/print-agent-server.test.ts`（5 條，**source 掃描守衛**） | GET 路由**唔可以**出現 `recordActivity`；三個 POST 路由**必須**有；heartbeat 唔可以再有獨立 UPDATE；update 之後一定要 `.select()`；必須有降級 fallback |
| `tools/verify-pos-api-contract.cjs`（加咗 print-agent 三個 POST） | **12/12** —— 三個 POST 都係 503（本機未配置），**冇 500 / crash**；`device-config` GET 照樣回答 |
| `tools/verify-pos-flows-live.cjs` | **17/17 ✅、有問題嘅頁面數 0** |

⚠️ **本機無法測真正嘅 update**（要 Supabase service role；route 會喺未配置時 early return 503），
所以要靠上面嘅 source 掃描測試 ＋ 部署後觀察 Supabase log（`pos_print_agents` PATCH 應該消失、
`pos_print_agents` 總數應該由 114 降到 ~70／24 分鐘）。

### 尚未做（仍待拍板）

APK 停止發獨立 heartbeat（−77%）、空閒／關店 claim 退避（`nextPollMs`）、
`online-order-settings` herd 收口、`pair-status` 已配對停輪詢、`topup` 放慢、`shift` 關店停。
