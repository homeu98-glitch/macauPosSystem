# P0 / P1 / P2 優化項 —— 實作前安全性審查（確認報告）

日期：2026-09-23 10:25
範圍：`docs/reviews/recheck-2026-09-23-egress-and-relay.md` §5 列出的 P0 / P1 / P2 全部項目
你的硬性約束：**列印即時性、訂單存在顯示、整體流程各環節，一律不得退化或改變行為**

---

## 0. 結論摘要

| # | 原建議 | 判定 | 一句話理由 |
|---|---|---|---|
| P0-1 | 補一次「營業中」窗口覆核 | ✅ **可以做（零代碼）** | 只係觀察，唔改任何嘢 |
| P0-2 | `pos_orders` / `pos_print_jobs` 加 RLS 收口 | 🚫 **否決（照做即退化）** | anon 讀取係**三個 Realtime 消費者**嘅必要條件；收咗＝列印失去即時喚醒＋訂單唔再自動彈出，而且**靜默** |
| P1-a | 把心跳 PATCH 併入 claim RPC | 🟡 **技術可行，但不建議** | 省嘅係 Supabase 請求數（**唔係** Vercel invocation），egress 只省 ~0.1 MB/日；而代價係動到「401 ⇒ APK 清配對」呢條認證契約 |
| P1-b | 已蓋章路徑不再 `verifyAgent` | 🚫 **否決** | `verifyAgent` 係**安全驗證**（解 token hash + 驗 revoked），唔係可省嘅重複讀取 |
| P1-c | `device-config` 加長快取／ETag | 🚫 **否決** | 商家改打印機 IP 之後，中繼機最長 30 分鐘仍然印去舊 IP ⇒ **印錯機** |
| P1-d | 查 `ag-402ef86e` 係咪壞機 | ✅ **要即刻做** | 呢個係真正影響列印嘅問題（詳 §3） |
| P1-e | 確定性拒收加 6 小時 TTL | ✅ **已經有，無需實作** | `sync-flush.ts:510-519` 已落 `skipped / server-newer` 終態 |
| P2-a | resubscribe 帶 `?fields=` 投影 | 🚫 **否決** | 投影會令 orders 缺 `items`/`total` 等欄，merge 入本機 ⇒ **訂單顯示空洞** |
| P2-b | `pos/state` 回 304 / ETag | 🚫 **否決** | 屬 payload 語義改動；處理不當＝重演 2026-09-22「partial payload」事故 |
| P2-c | 管理頁同範圍快取 | 🚫 **否決** | 商家落完單 60 秒內喺 admin 頁睇唔到 ⇒ 屬流程退化 |
| P2-d | 查 realtime 重連原因 | ✅ **可以做（唯讀）** | 純診斷 |

**已實作**：`src/lib/pos/print-and-order-realtime-guard.test.ts`（14 條守衛，全部通過）
**已修正**：上一份報告 §3.3 一處事實錯誤（見 §5）

> **核心判斷**：呢一輪優化清單裡面，**冇一項同時滿足「安全」＋「值得」**。
> 現時關店時段 egress 估算 ≈ 5–8 MB/日（未壓縮）≈ **2–3 MB/日 帳單**，
> 對比免費額 5 GB/月（≈166 MB/日）有 **50 倍以上餘裕**。
> 用「列印即時性 / 訂單顯示」去換呢個量級嘅節省，唔符合成本效益。

---

## 1. 三條紅線嘅技術根源（先講清楚「為咩會退化」）

### 紅線 A：列印即時性
即時出紙**唔係**靠輪詢，係靠 **Realtime 喚醒**：

```
pos_print_jobs INSERT
   → Supabase Realtime（中繼 APK 用 anon key 訂 postgres_changes）
   → APK 即刻 POST /api/pos/print-agent/claim
   → 出紙（1–3 秒）
```

- 憑證來源：`src/lib/print-agent-server.ts` `resolveRelayRealtimeConfig()` →
  `SUPABASE_URL` + `SUPABASE_ANON_KEY`（**POS 專案**，刻意唔 fallback Ledger）。
- **`/claim` 嘅 30→180 秒退避只係「兜底輪詢」**，唔係主路徑。
  ⇒ 一旦 Realtime 斷，出紙由「1–3 秒」變「最長 180 秒」。
- 🔴 Realtime 對 **RLS 係敏感嘅**：anon 訂閱者只會收到佢 **SELECT 得到**嘅行。
  收緊 anon SELECT ⇒ **一個事件都唔推，而 channel 照樣 `SUBSCRIBED`（零 error）**。

### 紅線 B：訂單存在顯示
同 A 完全同型，另外兩個消費者：
- `src/lib/pos/use-pos-realtime.ts` → 收銀台訂 `pos_orders` / `pos_print_jobs` / `pos_soldout`
- `src/lib/kds/use-kds-realtime.ts` → 後廚屏訂 `pos_orders` / `pos_kds_item_state`

⇒ 呢個正是 docs/113 記錄嘅「Realtime 靜默失效」型：畫面顯示已連線，但收銀台永遠收唔到新單，
要人手 F5 才見到（2026-09-10 P0 就係同一型，成因係 env 指錯專案）。

### 紅線 C：流程完整性
卽使唔碰 Realtime，**改回應內容**亦會退化。本專案有一條血淚鐵律（memory §8）：

> 🔴🔴 **伺服器唔可以用「partial payload ＋ 一個新欄位」去保護舊 client** ——
> 舊 client **唔會睇個新欄位**。凡係「可能令 `orders` 變空」嘅回應路徑，
> 必須**要麼回真資料（至少未結帳單），要麼唔回 200**。

實案：2026-09-22 P0b 用空骨架節流 → 舊 bundle 唔識 `incremental` → 照跑孤兒對賬 →
**本機所有未結帳單被移入隔離區**（列表清空、每 3 秒重演）。
⇒ P2-a / P2-b 就係踩喺呢條線上面。

---

## 2. 逐項安全審查（證據）

### P0-1 營業中窗口覆核 ✅ 安全
零代碼改動。判斷方式：開店營業 1–2 小時後，睇 **Admin → 雲端用量**（`pos_egress_daily`），
或用 `node tools/log-recheck.cjs --both <vercel.csv> <supabase.csv>`。
唯一要注意：**唔可以**用關店數字推論營業日。

### P0-2 `pos_orders` / `pos_print_jobs` 加 RLS 收口 🚫 否決

**證據 1 —— 呢兩張表早已有 RLS，而且係刻意的時間窗**（我上一份報告寫錯咗，見 §5）：

| 表 | 生效 anon 讀取窗口 | 定義檔（最後生效者）|
|---|---|---|
| `pos_orders` | **72 小時** | `0041_pos_anon_read_window_narrow.sql` |
| `pos_print_jobs` | **24 小時** | `0021_print_jobs_anon_window_24h.sql` |

**證據 2 —— `0041` 檔頭明文禁止移除／加 store 過濾**：

> 「🔴🔴 最重要嘅一句：**唔可以**就咁畀 anon policy 加 `store_id` 過濾
> · 收銀台／快餐：`use-pos-realtime.ts`（pos_orders / pos_print_jobs / pos_soldout）
> · 後廚／出餐屏：`use-kds-realtime.ts`（pos_orders / pos_kds_item_state）
> · 雲端中繼機 Hub（pos_print_jobs）
> anon 身份**冇任何 store claim** ⇒ 對 anon 永遠唔成立 ⇒ **一個事件都唔會推**。
> 而 Supabase Realtime **唔會報錯** ⇒ 正是 docs/113 同一型靜默失效。」

**證據 3 —— 時間窗亦唔可以收得太短**：Realtime 嘅 UPDATE / DELETE 事件係用
**row 自身嘅 `created_at`** 過 policy（`created_at` 唔會變）⇒ 窗口太短會令
「延遲認領 / 延遲結帳」嘅舊單事件被擋 ⇒ **收據／廚房單永遠唔出**。

**⇒ 結論**：要做按店隔離，**必須連 per-store token（JWT 內帶 `store_id` claim）一齊做**，
屬獨立立項（涉簽 token ＋ 三個 client 換憑證 ＋ APK 側配套）。**唔可以當「加一條 policy」去做。**

### P1-a 心跳 PATCH 併入 claim RPC 🟡 不建議

量化（用今日實測）：`PATCH pos_print_agents` = 216 次 / 6.1 小時，與 claim 1:1。

| 項目 | 實情 |
|---|---|
| 省到嘅 | **Supabase 請求數** −20 次/小時/部（−33% 待機請求）|
| **省唔到嘅** | **Vercel invocation** —— PATCH 係 claim route **內部**嘅一次 DB 呼叫，同一個 function invocation |
| egress | PATCH 回應 ~300 B ⇒ 省 **~0.14 MB/日/部** |
| 風險 | 要動「`verifyAgent` 失敗 ⇒ **401** ⇒ APK 清配對返配對畫面」呢條契約。一次判斷錯＝收銀機要重新配對中繼機 |

⇒ 為 0.14 MB/日 去動列印認證路徑，**不成比例**。

### P1-b 已蓋章路徑不再 `verifyAgent` 🚫 否決
`verifyAgent()` 做嘅係：`sha256(token) === token_hash` + `revoked_at is null`。
呢個係**安全驗證**，唔係「重複讀取」。省佢＝省掉驗身分。

### P1-c `device-config` 加長快取 🚫 否決

`/api/pos/device-config` 係中繼機攞**打印機路由（IP:port）**嘅唯一來源
（`print-relay-device-config-runbook.md`）。現時每 6 分鐘拉一次。

若延長到 30 分鐘 ⇒ 商家改完打印機設定（換機／改 IP／改分區）之後，
**最長 30 分鐘仍然印去舊機** ⇒ 直接命中你要保護嘅「列印」。

### P1-e 確定性拒收 6 小時 TTL ✅ 已經有
`src/lib/pos/sync-flush.ts:510-519`：

```ts
if (ok && !applied) {
  superseded += 1;
  return [{ ...event, status: "skipped", skipReason: "server-newer",
            lastError: `雲端已有較新版本（${r?.reason ?? "stale"}），改由對賬守護補推` }];
}
```

⇒ 今日 log 見到嘅 79 行 stale 拒收，係該裝置 outbox 嘅**一次性清理批次**
（推完就標 `skipped`，唔會無限重試）。**唔需要再加 TTL。**
（我上一份報告建議嘅 P1「6h TTL」屬重複建設，撤回。）

### P2-a resubscribe 帶 `?fields=` 投影 🚫 否決

`?fields=` 白名單係由 `POS_ORDER_DB_COLUMNS` 派生（**order 欄位**）。
正因為 `sync-reconcile-daemon` **只比對 `status`**，投影對佢才安全。
但 resubscribe 路徑係 **`pos-app` 嘅全量 backfill**，回傳會 **merge 落本機**
（`loadOrders()` / `loadRuntimeState()`）⇒ 投影走 `items` / `total` / `table_name` 等，
本機就出現**缺欄訂單** ⇒ 訂單詳情、桌台總覽、收據補打全部退化。

### P2-b / P2-c 304、管理頁快取 🚫 否決
- 304：`fetch` 對 304 嘅行為 + 本機 merge 守門難保證；同 P2-a 同一條紅線 C。
- 管理頁 60 秒快取：商家落完單喺 admin 訂單頁 60 秒內睇唔到 ⇒ 屬流程退化。

### P2-d realtime 重連診斷 ✅ 安全（唯讀）
只需讀 log：`31 條 WS / 6.1 小時`，其中 **27 條係 `ktor-client`（中繼 APK）**、
4 條係瀏覽器。⇒ **重連churn 主要嚟自 APK，唔係瀏覽器**；
而 `src=resubscribe` 嘅 35 KB `pos/state` 係**瀏覽器**觸發（ip=60.246.53.111、Mozilla）。
⇒ 兩件事**唔係同一條因果鏈**，唔可以混為一談（我上一份報告呢點寫得太籠統）。

---

## 3. ⚠️ 唯一真正需要即刻處理嘅事：一部中繼機靜默

```
ag-402ef86e…  最後一次蓋章 = MAC 2026-09-23 07:43:09（窗口到 09:50 都冇再出現）
ag-89639934…  持續到 09:48:28
MAC 04:00–07:00：兩部機各 ~30 次/小時；MAC 08:00 起：只剩一部
```

**為何算「影響列印」**：一部中繼機 = 一組打印機嘅出紙通道。
佢靜默 ⇒ 掛喺佢下面嘅廚房單／收據印唔出（POS 端應該已顯示「疑似離線」，門檻 5 分鐘）。
**呢個唔係優化問題，係營運事故，優先於所有 P0/P1/P2。**

需要你確認：係刻意關機（收店）定係真故障？

---

## 4. 本輪已實作

### 4.1 新增守衛：`src/lib/pos/print-and-order-realtime-guard.test.ts`（14 條）

把「不可回退」嘅口徑釘成可執行測試，**正好覆蓋你點名嘅三樣嘢**：

| 組 | 條數 | 鎖住咩 |
|---|---|---|
| A 列印即時性 | 6 | `pos_print_jobs` 必須有 anon SELECT policy；窗口 ≥ 24h；中繼機 Realtime 目標**唔可以** fallback 去 Ledger；claim 驗證失敗＝401 / RPC 失敗＝500（**唔可以混**）；回應必須帶 `nextPollMs`；節奏上限 5s–180s |
| B 訂單存在顯示 | 6 | `pos_orders` 必須有 anon SELECT policy；窗口 ≥ 72h；收銀台／後廚 realtime 必須訂 `pos_orders`；partial payload 必須帶 `incremental: true`；非增量回應**唔可以**省略 config 區塊 |
| C 匿名依賴本身 | 2 | 瀏覽器 client 仍用 anon key；全庫掃描冇「drop 咗 anon policy 而冇重建」 |

**設計要點**：SQL 掃描前**剝走 `--` 註釋行** —— 因為 `0021` / `0041` 故意喺註釋裡留低
「日後可以改成咩樣」嘅範例（`store scoped read`、`interval '14 days'` 回滾版），
唔剝註釋就會掃到**未生效**嘅寫法而誤判。

### 4.2 驗證結果

```
node node_modules/typescript/bin/tsc --noEmit   → exit 0
node --test                                      → tests 1286 / pass 1286 / fail 0
node --test src/lib/pos/print-and-order-realtime-guard.test.ts → 14 pass / 0 fail
```

反向驗證（確認唔係空轉）：守衛實際讀到 `pos_orders → 72h（0041）`、
`pos_print_jobs → 24h（0021）`、節奏常數 `15/30/60/120/180` —— 全部係真實值。

---

## 5. 修正：上一份報告嘅一處事實錯誤

`docs/reviews/recheck-2026-09-23-egress-and-relay.md` §3.3 初稿寫：

> 「範圍受表內資料量限制 —— 呢個係資料保留政策嘅巧合，**唔係 RLS 保護**。」

**呢句係錯嘅。** 經查 `0016 / 0021 / 0041`：兩張表早已有 RLS + `for select to anon` policy，
窗口分別係 **72 小時**（`pos_orders`）同 **24 小時**（`pos_print_jobs`），
而且係刻意保留（理由見 §2 P0-2 證據 2）。已於原檔原地更正並加註更正說明。
同檔 §5 嘅 P0 建議欄亦已由「加 RLS」改成「換 per-store token（獨立立項）」。

---

## 6. 需要你決定 / 提供嘅兩件事

1. **`ag-402ef86e` 係關機定故障？**（§3）—— 若係故障，請即刻重啟該中繼機。
2. **per-store token 立項唔立項？**（P0-2）
   呢個係唯一真正能收口匿名讀取、又唔會搞死 Realtime 嘅路。工作量屬中型
   （簽 token ＋ 三個 client 換憑證 ＋ APK 側），需要你排期意願。
   喺未立項之前，**兩張表維持現狀係安全側**，唔應該動。

其餘 P0/P1/P2 我建議**唔做**，理由已逐項列喺 §2（安全 / 效益兩個維度都唔通過）。
如果你仍然想推進某幾項，請指定邊幾項，我會為佢單獨出一份風險評估 + 回滾方案先。
