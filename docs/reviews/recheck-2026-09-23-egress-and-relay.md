# 優化成效覆核（第四次）：09-23 日凌晨窗口

日期：2026-09-23 09:55
樣本：`macau-pos-system-log-export-2026-09-23T01-49-54.csv`（Vercel，160 行／**60 個唯一請求**）
　　＋ `supabase_logs (15).csv`（Supabase，1,000 筆＝匯出上限）
工具：**`tools/log-recheck.cjs`（今次新建，一次過取代散落嘅 `_egress-*` / `analyze-*`）**
基準：`docs/reviews/egress-post-fix-recheck-2026-09-22.md`、`egress-closed-hours-and-claim-cadence-2026-09-22.md`、`log-error-triage-and-order-loss-2026-09-22.md`

---

## 0. 一句話結論

**eegress 三條「用戶端大戶」全部清零：舊版全量拉取 0 次、`queue=300` 0 次、
單次 state 由 404 KB 跌到 34,989 B；中繼機 claim 節奏由 76 秒升到 180 秒上限。**
但今次窗口仍然係**關店時段**（澳門 03:44–09:50），**「營業中」嘅驗證缺口仍未補**；
而且發現 3 個新問題：① 一部中繼機自 07:43 起靜默；② 待機請求 79% 集中喺同一組輪詢三角；
③ `pos_orders` / `pos_print_jobs` 仍然全世界（anon）可讀。

---

## 1. 先講窗口：樣本限制（唔可以唔講）

| 來源 | 窗口（澳門） | 長度 | 樣本 |
|---|---|---|---|
| Supabase | **09-23 03:44:45 → 09:50:09** | 365.4 分鐘 | 1,000 筆（**匯出上限，已截斷**） |
| Vercel | **09-23 09:21:19 → 09:48:28** | 27.2 分鐘 | 160 行 → 60 個唯一請求 |

🔴 **兩份 log 只有 27 分鐘重疊**，所以唔可以逐項互相對質，只能各用自己窗口嘅**速率**。
🔴 窗口 **03:44–09:50 全部係關店時段**（單店、1–2 部終端），
　 **「營業中多終端」嘅 egress 目標（10–20 MB/日）依然未被驗證** —— 呢個係由 09-22 至今一直未補嘅缺口。

### 1.1 一個必記嘅量度陷阱

Vercel 匯出**每行 `console.log` 就係一行 CSV**，同一個 HTTP 請求會展開成 N 行（共用 `requestId`）：

```
CSV 160 行 → 唯一請求只有 60 個（展開倍數 2.67）
其中 /api/pos/sync 一個請求 = 81 行（因為佢喺一次請求內拒收咗 78 張 stale 單）
```

⇒ **唔按 `requestId` 去重就會把請求量高估 2.7 倍**（今次就係咁，初睇以為 27 分鐘 160 個請求）。
Supabase 側同理：CSV 1,220 行 → 實際 1,000 筆（`logs` 欄有引號內換行，`split('\n')` 會多算 22%）。

---

## 2. 主要指標：優化前 → 今次實測

| # | 指標 | 09-22 基準 | 09-23 實測 | 判定 |
|---|---|---|---|---|
| 1 | `legacy=1` 舊版全量拉取 | **1,050 次 / 368 分** | **0 次** | ✅ **完全清零** |
| 2 | `queue=300`（每次多 ~500 KB） | 928 次 | **0 次** | ✅ **完全清零** |
| 3 | `pos_queue_events` `limit=` 指紋 | 28 次 `limit=0`、其餘 300 | **`limit=0` 3 次、`limit=300` 0 次** | ✅ 舊 bundle 痕跡消失 |
| 4 | `pos/state` 單次大小 | 843 KB → 404 KB（P0）→ 291 KB（ordersOnly） | **34,989 B**（含 deviceConfig＋localSettings＋printTemplates＋notePresets） | ✅ **−92%~−96%** |
| 5 | `legacyThrottled` 節流觸發 | — | **0 次**（因為已經冇 legacy 請求可節流） | ✅ 無需觸發 |
| 6 | 中繼機 claim 節奏 | 152 次 / 192 分 ＝ **每 76 秒** | **每部機中位 180s / P90 181s**（命中設計上限） | ✅ **達成 180s 目標** |
| 7 | 關店請求速率 | 15:30–16:00＝1.4/分；16:00–17:00＝**0.0/分** | **2.17/分**（3,121/日） | ⚠️ 見 §3.2 |
| 8 | 「拒絕覆寫訂單」風暴 | **924 行 / 77 張 / 45 秒**（每張被拒 11–22 次） | **79 行 / 72 張 / 1 個請求**（每張 1–2 次） | 🟡 **大幅收斂但未清零** |
| 9 | 5xx / 4xx | error 噪音 924 行 | **1 次 503**（`/api/admin/release-versions`，屬**預期 graceful**） | ✅ |
| 10 | `pos_release_versions`（0050） | **未跑** | **已跑**（09:39:53 建表＋開 RLS，09:40:04 寫入 201＋RPC 200） | ✅ 狀態更新 |
| 11 | anon 可讀嘅業務表 | 近 14 日明細＋`pos_print_jobs` | **`pos_orders` 65 行、`pos_print_jobs` 48 行仍可讀**；其餘 10 張表已 401 | 🔴 未收口 |

### 2.1 逐項對照（第 6 項嘅細節 —— 之前一直被「多機混算」誤導）

```
claim 混算中位 94s（← 呢個數字會令人以為節奏冇改善）
逐 agent 拆開後：
  ag-89639934  PATCH n=133  中位 180s / P90 181s   最後出現 MAC 09-23 09:48:28
  ag-402ef86e  PATCH n=83   中位 181s / P90 182s   最後出現 MAC 09-23 07:43:09
```

⇒ **兩部中繼機都精準跑喺 180 秒上限**。94s 純粹係兩部機交錯嘅假象。
（教訓已寫入 `tools/log-recheck.cjs` 嘅輸出警告，避免下次再誤判。）

### 2.2 逐項對照（第 8 項 —— 舊 outbox 殘留）

| 項目 | 09-22 | 09-23 |
|---|---|---|
| 總行數 | 924 | **79** |
| 涉及單數 | 77 | **72**（同批，仍然係 09-14 ~ 09-19 舊單） |
| 每張被拒次數 | 11 次（多數）／22 次（7 張） | **1 次**（7 張 2 次） |
| 分佈 | 45 秒內、**多個請求** | **單一請求內一次推完** |

⇒ 判斷：`sync-flush.ts` 新增嘅 **`skipped / server-newer` 終態已生效**（唔再無限重試），
但該裝置嘅 outbox **仍然攜帶 72 張舊單**，開頁／重連時會**再推一次**。
結論：**「無限重推」已止血，但「殘留未清」未解決。**

---

## 3. 新發現嘅問題

### 3.1 🔴 一部中繼機自 09-23 07:43 起完全靜默（≥2 小時）

```
ag-402ef86e…  最後一次 last_seen_at 蓋章 = MAC 09-23 07:43:09
ag-89639934…  持續到窗口結束（09:48:28）
MAC 04:00–07:00 每小時兩部機各 30 次；MAC 08:00 起只剩一部
```

**影響**：若該中繼機負責廚房打印機，07:43 之後嘅廚房單可能印唔出
（POS 端應該已顯示「疑似離線」—— `last_seen_at ≥5 分鐘` 判準）。
**待確認**：係刻意關機（收店）定係真故障？如屬故障 → 屬營運事故，需查 APK 存活。

### 3.2 ⚠️ 待機請求 79% 集中喺「輪詢三角」

窗口 792 個 edge 請求嘅組成：

| 請求 | 次數 | 佔比 |
|---|---|---|
| `PATCH /rest/v1/pos_print_agents`（心跳蓋章） | 216 | 27.3% |
| `POST /rest/v1/rpc/pos_claim_print_jobs` | 215 | 27.1% |
| `GET /rest/v1/pos_device_configs` | 99 | 12.5% |
| `GET /rest/v1/pos_print_agents`（verifyAgent） | 96 | 12.1% |
| 其餘全部（orders / sessions / shifts / realtime / storage…） | 166 | 21.0% |
| **三角合計** | **626** | **79.0%** |

**每部中繼機每小時 = 60 次**（claim 20 ＋ 心跳 PATCH 20 ＋ verify GET 10 ＋ device-config GET 10）：
- 心跳 PATCH 同 claim **1:1**（216 vs 215）—— `loadPairedAgent({recordActivity:true})` 每次都蓋章；
- `device-config` 每 6 分鐘重拉一次**基本上唔會變**嘅打印機路由設定；
- `verifyAgent()` 為咗驗身分**再 GET 一次 `pos_print_agents`**，而 PATCH 本身已經 `select` 返成行。

⇒ 即係**每次輪詢做咗 2–4 個 round trip，但實際只需要 1–2 個**。

### 3.3 ⚠️ `pos_orders` / `pos_print_jobs` 仍然 anon 可讀（**經查證：係刻意設計，唔係漏做**）

用部署 bundle 內嘅公開 anon key 直讀（`tools/probe-anon-exposure.cjs`，唯讀）：

```
200   65 筆   pos_orders          ← 訂單明細（金額、狀態、items）
200   48 筆   pos_print_jobs      ← 出紙任務（含 items）
200    2 筆   pos_store_status
200    3 筆   pos_online_order_settings
401           pos_egress_daily / pos_sessions / pos_print_agents / pos_queue_events
401           pos_device_configs / pos_print_templates / pos_shifts / pos_bootstrap_config
401           pos_note_presets / pos_release_versions        ← 0050 已 revoke anon ✅
```

> 🔴 **更正（2026-09-23 10:20，同日覆核後補）**
>
> 本節初稿寫「範圍受表內資料量限制 —— 呢個係資料保留政策嘅巧合，唔係 RLS 保護」。**呢句係錯嘅。**
> 經查 `supabase/migrations/0016 / 0021 / 0041`：呢兩張表**早已有 RLS + `for select to anon` policy**，
> 而且係**刻意保留嘅時間窗**：
>
> | 表 | 生效窗口 | 定義檔 |
> |---|---|---|
> | `pos_orders` | **72 小時** | `0041_pos_anon_read_window_narrow.sql`（由 14 日收窄）|
> | `pos_print_jobs` | **24 小時** | `0021_print_jobs_anon_window_24h.sql`（由 14 日收窄）|
>
> 實測吻合：`created_at < 2026-09-20`（＝超出 72 小時）查詢回 0 行；全表可見 65 / 48 行。
>
> **而 `0041` 檔頭明文寫住「唔可以就咁畀 anon policy 加 `store_id` 過濾 / 唔可以移除 anon 讀取」**，
> 理由係**三個 Realtime 消費者全部用 anon key 訂 `postgres_changes`**：
> 收銀台／快餐（`use-pos-realtime.ts`）、後廚出餐屏（`use-kds-realtime.ts`）、
> 雲端中繼機（`print-agent-server.ts` 派 `SUPABASE_ANON_KEY` 畀 APK）。
> anon 身份冇任何 store claim ⇒ 一旦收緊，**一個事件都唔會推**，而 Supabase
> **唔會報錯**（channel 照樣 `SUBSCRIBED`）⇒ 正是 docs/113 嘅「Realtime 靜默失效」。
>
> ⇒ 所以呢項**唔係「未收口」，而係「刻意開放、有待換成 per-store token」**。
> 真正嘅按店隔離必須**連 token 機制一齊做**（JWT 帶 `store_id` claim），屬獨立立項。
> 已加守衛 `src/lib/pos/print-and-order-realtime-guard.test.ts`（14 條）鎖住呢條約束，
> 防止日後有人當 bug 去「修」而靜默搞死列印同訂單彈窗。

### 3.4 ⚠️ `pos/state` 喺增量之下仍然回全量 config（35 KB）

```
[egress] pos/state bytes=34989 mode=full orders=0 queue=0
         skipQueue=1 legacy=0 legacyQueueOff=0 incr=1
         truncated=0 printJobs=0 limit=200 ip=60.246.53.111 src=resubscribe
```

`incr=1`（帶咗 `since`）＋ `orders=0`（完全冇新單），但仍然回 34,989 B ——
即係 **`incremental` 只省咗 orders 差量，config 區塊（deviceConfig＋localSettings＋
printTemplatesServer＋notePresetsServer）照樣全量回**。
兩次都由 `src=resubscribe` 觸發（realtime 重連），而 **realtime 每 11.8 分鐘就重連一次**
（31 條連線 / 6.1 小時）⇒ 純粹因為斷線重連而反覆買 35 KB。

`state/route.ts` 已經有 `?fields=` 白名單投影（line 37），但 resubscribe 路徑冇傳。

### 3.5 🟡 其他

- **`schema_migrations_pkey` duplicate（09:30:40）**：有人在 09:30 重跑 migration（0012 schema drift 對齊）。
  被 PK 擋住，無害；但**同時反映「重跑 migration」係慣用手法**，要小心 0049/0050 之類唔係 idempotent 嘅步驟。
- **`pos_print_jobs_once_key_uniq` duplicate（09:34:27）**：對應 `[pos/sync] 內容唯一鍵重複 → 略過重複出紙
  （job=print-5b1339ed once_key=receipt:0）` ⇒ **去重機制正常運作** ✅（memory §4 嘅收口有效）。
- **09:34:58 `order-f39edc2e` 被重推**：該單 09:34:27 已 `settled`（PATCH 204），
  31 秒後 outbox 再推 `sent_to_kitchen@09:34:24` 被拒 ⇒ **當日單亦會殘留重推**，值得列作待觀察。
- **管理頁 egress**：`/api/admin/orders` 一次載入做 4 條查詢，其中
  `pos_orders?select=store_id,created_at&limit=2000` 單次最大。屬人手操作、非主要來源，但可加範圍快取。

---

## 4. 優化目標達成度

| 目標（源自 09-21/09-22 計劃） | 目標值 | 實測 | 達成 |
|---|---|---|---|
| 舊分頁全量拉取歸零 | 0 | 0 次 legacy、0 次 queue=300 | ✅ |
| 全量 state 404 KB → 遠細 | — | 34,989 B | ✅ |
| 訂單頁 incremental | 291 KB → ~3 KB | 窗口內 ordersOnly 已見增量路徑（`incr=1`） | ✅ |
| claim 節奏退避到 180s | 180s | **每部 180s（P90 181s）** | ✅ |
| 關店時段請求量下降 | −83%（2,880→480/日/部） | 每部 480 次/日（20/h × 24） | ✅ |
| 日 egress 10–20 MB（營業日） | 10–20 MB | **無法驗證（窗口全在關店時段）** | ⛔ |
| 「同步健康」唔再被 log 洗版 | 大幅減少 | 924 → 79 行 | 🟡 部分 |
| 刪除／隔離機制唔再誤傷訂單 | 0 誤傷 | 窗口內 0 單被誤刪（無隔離事件） | ✅ |

---

## 5. 後續優化建議（按效益排序）

| 優先 | 行動 | 預期效果 | 成本 |
|---|---|---|---|
| **P0** | **補一次「營業中」窗口覆核**（開店後 1–2 小時，多終端、真實落單量） | 補上 09-22 至今唯一未驗證嘅缺口；確認 10–20 MB/日目標 | 只需再匯一次 log（`tools/log-recheck.cjs` 一鍵） |
| **P0** | `pos_orders` / `pos_print_jobs` 由「時間窗 anon 讀取」換成 **per-store token（JWT 帶 `store_id` claim）** | 真正做到按店隔離；⚠️ **唔可以淨改 SQL** —— 會靜默搞死 3 個 Realtime 消費者（見 §3.3 更正） | 高（獨立立項：簽 token ＋ 三個 client 換憑證 ＋ APK 側） |
| **P1** | 查 `ag-402ef86e` 係咪壞機（APK 存活、`last_seen_at` 監控） | 避免廚房單靜默唔出紙 | 低 |
| **P1** | **把心跳 PATCH 併入 claim RPC**（一次 round trip 完成「驗證＋蓋章＋取 job」） | 每部機 −20 次/小時（−33% 待機請求） | 低（改 RPC + route） |
| **P1** | `verifyAgent()` 喺已蓋章路徑**唔好再 GET 一次** | 再 −10 次/小時 | 低 |
| **P1** | `device-config` 加長快取（30 分）或 ETag（設定幾乎唔變） | 再 −10 次/小時 | 低 |
| **P1** | 舊 outbox 殘留：**確定性拒收 → 6 小時 TTL 自動轉 `skipped`**，＋伺服器端 log 節流 | 79 行 → 0；「待同步」數字歸零 | 低（純模組，可加單測） |
| **P2** | resubscribe 路徑帶 `?fields=` 投影（唔要 config 就唔好回 config） | 每次重連 35 KB → ~2 KB；配合 realtime 重連修復，省最多 | 低（白名單已存在） |
| **P2** | 查 realtime 每 11.8 分鐘重連原因（keepalive／`eventsPerSecond=5`） | 減少 resubscribe 觸發 | 中 |
| **P2** | `pos/state` 加輕量 ETag（orders=0 時回 304） | 重連成本近乎歸零 | 低 |
| **P2** | 管理頁同範圍快取（`admin/orders` limit=2000 那條） | 人手操作成本下降 | 低 |

---

## 6. 方法備註（下次照做）

```bash
# 一次過出齊：請求去重、路徑組成、指紋、逐 agent 節奏、egress 原文、postgres error
node tools/log-recheck.cjs --both "<vercel.csv>" "<supabase.csv>"

# anon 曝光面逐表探測（唯讀，自動由部署 bundle 抽 anon key）
node tools/probe-anon-exposure.cjs
```

三個必記陷阱：
1. **Vercel 一行 log = 一行 CSV** → 計數前必須按 `requestId` 去重（今次 160→60）。
2. **兩份 log 窗口通常唔重疊** → 只可以比「速率」，唔可以逐項對質。
3. **多部中繼機混算 claim 間隔會腰斬** → 一定要逐 `agent_id` 拆開睇。
