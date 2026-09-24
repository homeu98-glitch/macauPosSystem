# Egress 覆核（2026-09-24 · **營業中**窗口）

> 商家問題：「依家既用量係唔係正常左好多？重需唔需要優化？昨天生意不是太好。」
> 樣本：Supabase log 1,000 行（MAC 10:29:41–11:22:16，52.6 分）＋ Vercel 匯出 339 行 →
> **222 個唯一請求**（MAC 10:54:00–11:21:40，27.7 分）。窗口重疊 ✅。
> 兩間店同時 `is_open: true`（`8291f843…` 今早 09:00 開；`d564b932…` 亦開）⇒ **首次「營業中」覆核**。

---

## 一、直接答問題

### 1）用量係唔係正常左好多？ → **係，已經完全回到預算內**

| 項目 | 金額 |
|---|---|
| 本 period 已用（Supabase 用量頁） | **0.06 GB** |
| Pro Plan 包含 | **250 GB** |
| 佔比 | **0.024 %** |
| 23 Sep 全日 | PostgREST 37.86 MB ＋ Realtime 7.77 MB ＋ Storage 3.40 MB ＋ Auth 0.05 MB ≈ **49 MB** |
| 24 Sep（至 11:24） | ≈ **10 MB** |

對比：09-22 曾單日爆 **7.27 GB 超額**。即係同樣一日，由「幾 GB」跌到「幾十 MB」——**兩個數量級**。

### 2）重需唔需要優化？ → **帳單上唔需要；但有 1 個「唔係帳單、係正確性」嘅問題要跟**

技術指標全部達標（見 §二）。剩下嘅係**請求數噪音**同一個**新發現嘅時間漂移風險**（見 §三.1）。

### 3）昨天生意唔好 → **所以要特別小心解讀呢個「靚數字」**

由 `pos_orders` 直查（anon 72h 窗口，澳門日）：

| 日期 | 訂單數 |
|---|---|
| 21 Sep | 23（11:48 起，部分） |
| 22 Sep | 37 |
| **23 Sep** | **23** |
| 24 Sep（至 11:15） | 4 |

⇒ 49 MB **係用一個只有 23 張單嘅慢日換返嚟嘅**。**唔可以當係繁忙日基準。**
粗略外推：若繁忙日訂單數係慢日 4–5 倍，egress 大概 150–250 MB/日 ⇒ 仍然只係 250 GB 嘅 **0.1 %**。
但呢個係**算術外推，唔係實測**——想確認就揀一個旺日再導一次 log。

---

## 二、已確認達標（可作為新基準）

| 指標 | 舊基準 | 今次（營業中） |
|---|---|---|
| `legacy=1` / `queue=300` / `limit=300` | 1,050 / 928 / — | **全部 0 次** |
| `legacyThrottled` | 曾反覆出現 | **0 次** |
| stale 拒收 log | 924 行 / 45 秒 | **0 行** |
| `pos/state` 單次 bytes | 843 KB → 404 KB | 增量 **34,989 B** ／全量 bootstrap 416 KB |
| `pos_queue_events` limit 指紋 | `limit=300` | `{limit=0: 19, POST: 37}`（**零個 300**）＝全部新 bundle |
| 中繼機 claim | 中位 76s | 單機 `ag-89639934` 中位 **60s**、P90 181s |
| 打印鏈 | — | 最近 40 張 job 全部 `status=printed`、`attempts=0`、created→claimed **1–2 秒** |

⚠️ 兩個量度陷阱已避開：Vercel CSV **339 行 → 只 222 個唯一請求**（倍數 1.53，可變）；
Supabase 1,000 行係**匯出上限**，窗口只有 52.6 分，唔可以當一整日。

---

## 三、仍然存在嘅問題

### 1. 🔴 同一批事件每 30 秒重推，歷時 ≥51 分鐘（**唯一值得即刻跟**）

**證據（Supabase log 逐 id 去重）**

| 操作 | 次數 | 時間跨度 | 間隔 |
|---|---|---|---|
| `PATCH pos_print_jobs?id=eq.print-11e37b9e` | **27** | 10:35:27 → 11:19:50 | 全部 **30.0s** |
| `PATCH pos_orders?id=eq.order-778dbb99` | **25** | 同上 | 30.0s（與下一條成對，gap 0s） |
| `PATCH pos_orders?id=eq.ledger-2cc9593f…` | **22** | 10:57:46 → 11:19:50 | 30.0s |

每個 30 秒 tick 固定 7 條 Supabase 查詢：
`pos_store_status[select=is_open]`（＝ `/api/pos/sync` 嘅營業閘）＋ `pos_shifts` ＋ `pos_orders` ＋
`PATCH pos_orders`×2 ＋ `PATCH pos_print_jobs` ＋ `POST pos_queue_events`
⇒ **14 次/分**，全窗口 976 條 edge 請求（18.56/分）。

**為何係 30 秒**：`sync-flush.ts` `FLUSH_INTERVAL_MS = 30_000`；`doFlush()` 開頭有
`if (allQueue.length === 0) return;` ⇒ **冇 pending 就唔會打網絡**。
換句話講：**因為隊列永遠清唔空，所以 30 秒兜底 timer 永遠唔 idle。**

**🔴 直接可觀測後果（唔只係噪音）**

兩張單嘅雲端 `updated_at` 被逐步推到 **11:26:35**，但內容**零變化**：

| 單 | status | `client_updated_at` | 雲端 `updated_at` |
|---|---|---|---|
| `order-778dbb99` | `sent_to_kitchen` | 10:35:27 | **11:26:35** |
| `ledger-2cc9593f…` | `settled` | 10:58:11 | **11:26:35** |

而 `isSaleCountable()` + 報表用 `orderEventInstant()` 排序／篩日期，雲端**冇** `original_settled_at` 欄
⇒ 雲端實際係靠 `updated_at`。
⇒ **一張 23:50 結帳嘅單，只要被呢個迴圈推過午夜，就會掉到第二日嘅報表。**
呢個同「數字夾唔埋」係同一類風險，比多幾 MB 流量重要得多。

**根因未定位**（log 睇唔到 client 決定）。兩個候選：
① 事件 ack 之後被重新入隊（`enqueueEvents` 按 `type:entityId` 原位取代）；
② 對賬守護 (`sync-reconcile-daemon`) 反覆補推同一批單。
**下一步（最便宜）**：在 Mac 收銀台開 DevTools console，睇有冇 `[pos-sync-flush]` /
`[queue-outbox]` / `[sync-reconcile]` 週期性輸出；或喺 `sync/route.ts` 加一行
「本批事件 id＋type」log（1 個 deploy）。**未確認根因之前唔好改任何 ack 邏輯。**

### 2. ⚠️ 83 條逐筆 DELETE（非緊急）

10:59:34–37 四秒內 83 條 `DELETE /rest/v1/pos_print_jobs?id=eq.print-…`＝打印中心一次過清 83 張舊 job
（每個 `PRINT_JOB_DELETED` 事件一條 DELETE）。
**只係 1 個 Vercel invocation、payload≈0 ⇒ 對帳單零影響**，只係 Supabase 請求數。
可批次化成 `id=in.(…)`，但唔急。

### 3. ⚠️ 2 次 `23505 duplicate key "pos_print_jobs_once_key_uniq"`

10:57:47（`once_key=receipt:0`）、10:59:32（`once_key=kitchen:normal:0:1ah9q6a`）＋1 次 409。
同一 `onceKey` 用**新 randomUUID** 重推 ⇒ update-by-id 永遠 miss、insert 永遠撞唯一鍵。
去重生效（**冇重複出紙**），但係 log noise。

### 4. ⚠️ Realtime WS 每 ~105 秒重連

30 條 websocket / 52.6 分（09-23 記錄係 11.8 分鐘一次）。Realtime 佔當日 egress 15.8%（7.77 MB）。

### 5. ⚠️ 增量仍每次回 34,989 B 全量 config

`src=mount` 喺 10:56–11:05 八分鐘內出現 6 次。即 `incr=1` 只省 orders 差量，
`deviceConfig` / `localSettings` / `printTemplatesServer` / `notePresetsServer` 照樣全量回。
**唔建議照舊建議去加 `?fields=`**（見下）。

---

## 四、建議（按優先次序）

| # | 做唔做 | 項目 | 理由 |
|---|---|---|---|
| 1 | ✅ **做** | 定位 §三.1 嘅 30 秒重推根因（先攞 Mac client console） | 唔止流量，係**報表跨日漂移**風險 |
| 2 | ⏸ 觀察 | 揀一個**旺日**再導一次 log ＋ 用量截圖 | 現時只有 23 張單嘅慢日樣本 |
| 3 | ⏸ 可選 | 83 條 DELETE 批次化 | 只省請求數，省唔到錢 |
| 4 | 🚫 **唔好做** | `resubscribe` 帶 `?fields=` 投影 | 白名單係 order 欄位；resubscribe 係全量 backfill，投影會令訂單顯示空洞（見 skill 禁止清單） |
| 5 | 🚫 **唔好做** | 為省流量收緊 anon RLS／改 payload 語義 | 已知會靜默搞死列印／訂單顯示 |

⭐ **判斷準則**：本專案 egress 已經喺預算內（≈50 MB/日 vs 250 GB）。
**任何「省流量」改動，只要可能改變 payload 語義或 client 可見行為，一律唔做。**
