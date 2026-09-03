# 98 · 打印中繼排查計劃：配對成功但收不到單 ＋ 打印機路由可視性

> **日期**：2026-09-03
> **性質**：排查 → **已確證 + 部分修復**。H1/H6/H8/H9/H10 全數破案。
> **適用對象**：`C:\dev\print-relay`（macau-print-hub，Android 中繼機）
> 　　　　　`C:\dev\macauPos\macauPosSystem`（macau-pos，Next.js web POS）
> **配套**：[`docs/96`](./96-sunmi-print-relay-plan.md)（實作規格）、[`docs/97`](./97-cloud-relay-architecture.md)（架構與安全邊界）
>
> **⏵ 2026-09-03 18:15 修復總結**
> - **H10 修復**（主因）：24 處入隊點統一改 `status:"pending"`（pos-app.tsx 23 處、print-center.tsx:417 1 處）
> - **副 bug**：`print-center.tsx:373` pushEvents 唔 trigger flush worker，加 `notifyQueueChanged()`
> - **未動**：`sync-flush.ts` 嘅設計邏輯正確（`line 64-67 註解寫對咗`），改完入隊即 work

---

## 0. 一句講晒

**「配對成功」只證明 Hub 同 POS 認到同一個 `store_id`，完全唔證明有任何單寫咗上雲。**

而家「設備設置 → 測試打印」嗰粒掣 **壓根冇設計成走雲端中繼** —— 佢淨會試 native bridge 同
Companion，兩條都冇就直接彈「未配對 Companion 代理」，**連 sync queue 都冇掂過**。
所以「配對成功但收不到任務」喺現有代碼下係**預期行為**，唔係靈異事件。

---

## 1. 假設清單（按機率排序）

| # | 假設 | 機率 | 致命證據位置 | 驗證成本 |
|---|---|---|---|---|
| **H1** | **「測試打印」冇上雲**：`device-settings.tsx:502 testPrint()` 冇 `persistPrintJobs()` / `pushEvents()`，亦冇 relay 分支 → `pos_print_jobs` 永遠 0 行 | **極高** | `src/components/device-settings.tsx:502-587` | 低（一條 SQL） |
| **H2** | **`store_id` 對唔上**：Hub 用 login 嘅 `merchantId`，web 用 `resolveStoreId()`（auth session 或 **kiosk device binding**）；兩端帳號/綁定唔同就永久錯配 | 中 | `RelayApi.kt:98` vs `sync-flush.ts:221-227` | 低（比對兩個 UUID） |
| **H3** | **migration 0020/0021 未跑**：`pos_claim_print_jobs()` 唔存在 → claim 500 → Hub「認領失敗」 | 中 | `0020:9-12` 註明「寫咗 migration ≠ 跑咗 migration（已踩兩次）」 | 低（一條 SQL） |
| **H4** | **Realtime 訂閱失敗**：`supabaseUrl`/`anonKey` 空、表未入 publication、RLS 無 anon select policy | 中 | `RealtimeClient.kt:147-166` | 低（Hub UI 直接睇到） |
| **H5** | **端口/協議問題**：混淆咗本地直連 `:8787` 同雲端中繼兩條路；iPad HTTPS 頁打 `http://hub-ip:8787` 會被 mixed content 擋 | 中（屬**概念混淆**） | `HubHttpServer.kt:26` / `docs/97 §1.2` | 低 |
| **H6** | **任務發去錯誤目標**：`resolvePrinter()` 四級 fallback，前三級（row.printer / claim printers / name 匹配）實際上都命中唔到 → 跌去「第一個開 9100 嘅機」或 `ipAddress=null` | **高（但屬第二層問題）** | `JobRunner.kt:174-232` | 中（要有單先測到） |
| **H7** | **agent 驗證唔過**：`pos_print_agents` 冇呢條 agent / `revoked_at` 有值 / token hash 唔夾 | 低（已配對成功，基本排除） | `print-agent-server.ts:61-67` | 低 |
| **H8** | **relay `send()` 無條件回 ok**（2026-09-03 實測後新增）：`flushPosSyncQueue()` 失敗（400 缺 storeId / 示範店代碼 / RLS / 離線）被 `catch {}` 靜默吞掉，但 `dispatch.ts:75` 照樣標 `status:"sent"` → 打印中心顯示「已發送」係**假陽性** | **極高** | `relay-transport.ts:31-38` ＋ `dispatch.ts:75` | 低（Network tab 一睇就知） |
| **H9** | **`TEST_PRINT_REQUESTED` 係死事件**（2026-09-03 二輪新增）：白名單有（`sync/route.ts:46`）、types 有（`types.ts:92`），但**全庫冇 producer、sync 路由冇 handler** → 「測試打印經雲端」呢個設計從未完成。所以測試打印無單上雲係**設計缺口**，唔係 bug | **確定（code 層面已證實）** | `sync/route.ts:46` vs 全庫 grep 只有 2 處命中 | 零 |
| **H10** | **online 入隊寫 `status:"synced"` → 被 flush filter 永久 skip**：`pos-app.tsx` 24 處入隊點都寫 `status: networkOnline ? "synced" : "pending"`；而 `doFlush()` 喺 **legacyHealed=true 之後**（即每次 page load 嘅第一次 flush 之後）會 `filter(e => e.status !== "synced")` → **在線時新建嘅事件永遠唔會被推上雲，要等到下一次 page reload 嘅 legacy heal flush 先補推**。`pos_queue_events` 24 小時內只有 DELETE 零 CREATE ＋ `pos_orders` 24 小時 0 條 ＝ 全局性死結 | **已確證 + 已修復（2026-09-03 18:15）** | `pos-app.tsx:1814,1832,1870,…` vs `sync-flush.ts:239-242` | 低 |

> **H4 重要澄清**：就算 Realtime 完全斷，Hub 都有 **30 秒對賬 tick**（`HubService.kt:137, 298`）
> 兜底 claim。所以 H4 **只會令出紙慢 30 秒，唔會「完全收不到」**。
> 呢點可以用嚟快速排除 H4 作為「零單」嘅主因。

> **H1 vs H8 嘅分工**：H1 係「單根本冇入 sync queue」（測試打印掣），
> H8 係「單入咗隊但 push 上雲失敗，而 UI 照顯示成功」。兩者症狀一模一樣（雲端 0 行 ＋ 「已發送」），
> 要靠下面 Step 2b / 2c 先分得開。

---

## 2. 先分清兩條完全獨立嘅通道（排查前必讀）

Hub 同時開咗**兩條**入紙路徑，症狀會互相掩蓋，一定要先分清：

| | 路徑 A：雲端中繼（Scheme B） | 路徑 B：本地直連 HTTP |
|---|---|---|
| 入口 | Supabase Realtime WSS → `POST /claim` | `POST http://<hub-ip>:8787/print` |
| Hub 端代碼 | `HubService.kt` + `RealtimeClient.kt` + `JobRunner.kt` | `HubHttpServer.kt`（NanoHTTPD） |
| 發起方向 | Hub **主動出站**去雲端 | web POS **主動打入** Hub |
| iPad（HTTPS）可用？ | ✅ 唯一可用 | ❌ active mixed content，**必定被擋**（`docs/97 §1.2`） |
| 「配對成功」指邊條？ | ✅ 指呢條 | ❌ 同本地直連無關 |

> ⚠️ **Hub UI 顯示嘅「本機 HTTP：http://192.168.x.x:8787」同城雲端配對狀態係兩件事。**
> 見到 8787 通唔等於雲端中繼通；見到「已配對」亦唔等於 8787 有用。
> 排查時**先鎖死只測路徑 A**（iPad 場景得呢條行得通），路徑 B 淨喺「用電腦 curl 驗 Hub 本身死未」嗰陣用。

---

## 3. 兩個系統之間嘅通訊流程（含檢查點）

```
① iPad web POS 落單
   pos-app.tsx（8 處）/ print-center.tsx:414 / shift-page.tsx
     → persistPrintJobs([job])            ← 【檢查點 P1】localStorage 有冇寫？
     → pushEvents([PRINT_JOB_CREATED])    ← 【檢查點 P2】sync queue 有冇入？

② PrintFlushWorker（每 2.5s，print-flush-worker.tsx:42）
     → flushPendingPrintJobs()（dispatch.ts:39）
     → dispatchOneJob()（dispatch.ts:121-174）
        ① native bridge（window.PosNative）  ← iPad 上恒為 false
        ② Companion（localhost:9311）        ← 純 website 恒為 false
        ③ relay（dispatch.ts:165）           ← 淨係 call flushPosSyncQueue()

③ POST /api/pos/sync（sync-flush.ts）
     → 驗 storeId（resolveStoreId()，sync-flush.ts:221）  ← 【檢查點 P3】邊個 UUID？
     → Vercel /api/pos/sync（route.ts:311-342）
     → upsert pos_print_jobs（service_role）             ← 【檢查點 P4】表有冇行？

④ Supabase Realtime postgres_changes INSERT
     filter: store_id=eq.<storeId>（RealtimeClient.kt:149）  ← 【檢查點 P5】
     → Hub onWake() → RelayState.lastWakeAt

⑤ Hub drain（HubService.kt:135-141）
     wokeUp（有叫醒）或 stale（>30s）→ JobRunner.drain()
     → POST /api/pos/print-agent/claim（RelayApi.kt:165）
     → verifyAgent()（print-agent-server.ts:61）            ← 【檢查點 P6】401？
     → RPC pos_claim_print_jobs()（0020:69-103）            ← 【檢查點 P7】函數存在？
         WHERE store_id=? AND status IN ('pending','failed')
               AND attempts<5 AND (ttl IS NULL OR ttl>now)
               AND (claimed_by IS NULL OR claimed_at < now()-60s)

⑥ JobRunner.printOne()（JobRunner.kt:114）
     → resolvePrinter()（:174-232）                        ← 【檢查點 P8】解析到邊部機？
     → EscPosRenderer → SdkPrinter.printBytes() → LAN :9100

⑦ POST /api/pos/print-agent/result（status=sent/failed）
```

---

## 4. 排查步驟（嚴格按順序行，每步都有明確出口）

### Step 0 · 前置：確認環境（5 分鐘）

| 要確認 | 點確認 | 唔通過點算 |
|---|---|---|
| Hub 跑緊邊個 APK / 版本 | Hub UI 第二行 `POS：<url>　v<name> (<code>)`（`MainActivity.kt:110-116`） | 對唔到最新 build 就重裝 |
| `BuildConfig.POS_URL` 指向邊 | 同上；對照 `app/build.gradle.kts` | 指向 staging 就全部白測 |
| 測試用嘅 iPad 同 Hub **登入同一個帳號** | web POS 右上角 / Hub 配對時輸入嘅電話 | 唔同帳號直接打 H2 |
| 有冇第二部 Hub 同時開著 | `select * from pos_print_agents;` | 兩部機會互相 claim 走單 |

### Step 1 · 決策樹起點：淨睇 Hub UI 三個時間戳（30 秒，直接二分）

打開 Hub app，睇狀態區（`MainActivity.kt:268-295` 渲染）：

```
狀態：已連線（Realtime）
店舖：<storeName>（<storeId>）
已印 0 張 · 失敗 0 張
上次認領：3s 前　上次心跳：58s 前
上次叫醒：—
```

| 觀察到 | 推論 | 跳去 |
|---|---|---|
| 「上次認領」**一直係 `—`** | `JobRunner.drain()` 從未執行 → Hub 本地問題（未配對 / agentId·token 為 null / service 未起） | **Step 1b** |
| 「上次認領」有喺度跳（例如 `3s 前`）但「已印 0 張」 | claim 打得通、但**回 0 單** → 問題喺 POS 端 / 雲端數據 | **Step 2** |
| 「訊息：認領失敗：…」 | claim 返 error（401 / 500 / RPC 錯） | **Step 3 / Step 1c** |
| 「上次叫醒」係 `—` 但「上次認領」有跳 | Realtime 冇連上，**30s 兜底喺度行** → 單最多慢 30s；H4 唔係「零單」主因 | **Step 5**（低優先） |
| 「上次認領」有跳、已印 >0 張，但**打錯機** | 中繼通咗，路由解析出事 | **Step 7** |

**Step 1b**（上次認領 = `—`）：用 adb 睇 Hub 嘅 SharedPreferences
```bash
adb shell run-as com.macau.printhub cat \
  /data/data/com.macau.printhub/shared_prefs/macau_pos_relay.xml
```
要有 `agent_id`、`agent_token`、`store_id` 三樣（`RelayPrefs.isPaired()` 嘅條件，`:57-58`）。
缺 `supabase_url` / `anon_key` → 係 `GET /pair` 冇派到（Vercel 缺 `SUPABASE_URL` / `SUPABASE_ANON_KEY` env）→ 跳 Step 5。

**Step 1c**（認領失敗 401）：對 `pos_print_agents` 表查呢條 agent 係咪存在、`revoked_at` 係咪有值。

### Step 2 · 證實 H1：雲端究竟有冇單（一條 SQL 定生死）

去 Supabase Dashboard → SQL Editor：

```sql
-- 2a. 最近 20 張單（睇 order_no 有冇 'TEST'）
select id, store_id, order_no, printer_id, printer_name, status,
       attempts, claimed_by, created_at
  from public.pos_print_jobs
 order by created_at desc
 limit 20;

-- 2b. 按 store + status 聚合（睇 store_id 有冇分歧）
select store_id, status, count(*)
  from public.pos_print_jobs
 group by 1, 2
 order by 3 desc;
```

| 結果 | 結論 |
|---|---|
| **完全 0 行**（連真單都冇） | H1 成立（或 POS 根本未落單）。跳 Step 2b |
| 有真單、**冇 `order_no='TEST'`** | **H1 確證**：測試打印從未上雲。跳 Step 8 用真單做對照組 |
| 有 `TEST` 單但 `store_id` 同 Hub 唔同 | **H2 確證**。跳 Step 3 |

**Step 2b**：喺**撳打印嗰個瀏覽器**嘅 F12 Console 跑（key 係 per-store scoped，見 `storage.ts:101-105`，
所以唔使事先知 `merchantId`）：

```js
(() => {
  const out = {};
  for (const k of Object.keys(localStorage)) {
    if (!/sync-queue|print-jobs|auth-session|macau-pos-relay/.test(k)) continue;
    const raw = localStorage.getItem(k) || "";
    if (/sync-queue/.test(k)) {
      const q = JSON.parse(raw || "[]");
      out[k] = {
        total: q.length,
        byType: q.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}),
        printJobs: q.filter(e => e.type === "PRINT_JOB_CREATED")
                     .map(e => ({ id: e.id, status: e.status, attempts: e.attempts, createdAt: e.createdAt })),
      };
    } else {
      out[k] = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
    }
  }
  return out;
})()
```

重點睇三樣：
1. `sync-queue` 入面有冇 `PRINT_JOB_CREATED`？**冇 → H1 確證**（張單根本冇入隊）。
2. 有嘅話 `status` / `attempts` 係乜？`status:"failed"` 且 `attempts >= MAX_SYNC_ATTEMPTS` → 永久卡死（`sync-flush.ts:250`）。
3. `macau-pos-relay-*` 五個 key 係咪齊（`relay-config.ts:22-35`：`paired=1` ＋ agentId ＋ token ＋ storeId）。

**Step 2c**（最直接的證據）：F12 → Network，filter 打 `sync`，撳打印，睇 `POST /api/pos/sync` 呢一條：

| 見到 | 結論 |
|---|---|
| **冇呢條請求** | H1 確證：張單冇入隊，relay `send()` flush 咗個空隊列然後回 ok |
| **400** `缺少 storeId…` | **H8 確證（分支 A）**：`resolveStoreId()` 返 `undefined` → 未登入 POS 帳號／kiosk 未綁定店。跳 Step 3 |
| **400** `storeId「…」係示範店代碼` | **H8 確證（分支 B）**：`isPlaceholderStoreId()` 擋咗。跳 Step 3 |
| **200 但 `pos_print_jobs` 仍然 0 行** | sync 路由收咗但 upsert 靜默失敗 → 睇 Vercel 後台 log `[pos/sync] pos_print_jobs upsert failed:` |
| **401 / 403** | RLS 或 service key 問題 |

> ⚠️ 無論邊種，`relay-transport.ts:35-37` 嘅 `catch {}` 都會把錯誤吞掉，UI 照顯示「已發送」。
> 所以 Network tab 係唯一睇到真相嘅地方。

### Step 2d · 決定性證人：`pos_queue_events`（每個入到 server 嘅事件都留底）

`sync/route.ts:203-215` 會**喺寫 `pos_print_jobs` 之前**把每一條事件 upsert 落 `pos_queue_events`
（0011 migration 起就有，先寫事件、再分派去各業務表）。所以呢張表可以直接回答「事件到咗 server 未」：

```sql
-- 2d-1. 各類型事件嘅數量同最後時間
select type, count(*) as n, max(created_at) as last_at
  from public.pos_queue_events
 group by 1
 order by 3 desc;

-- 2d-2. 最近 20 條（睇有冇 PRINT_JOB_CREATED、payload 有冇 id）
select id, type, entity_id, status, created_at,
       payload -> 'id' as payload_id
  from public.pos_queue_events
 order by created_at desc
 limit 20;
```

| 結果 | 結論 |
|---|---|
| **全表 0 行** | 事件從未到過 server → H8-A（400 缺 storeId）／H10（被 filter skip）／flush 根本冇跑 |
| 有 `ORDER_*`、**冇 `PRINT_JOB_CREATED`** | storeId 同網絡都正常，係**打印單冇入隊**（H1 / H9） |
| 有 `PRINT_JOB_CREATED` 但 `pos_print_jobs` 0 行 | server 收咗但 handler 靜默跳過：`sync/route.ts:308-310` 嘅 `if (jobId)` 為空時**唔 push error、直接乜都唔做** → 查 `payload_id` 係咪 null |
| `PRINT_JOB_CREATED` 有、`payload_id` 有值、`pos_print_jobs` 仍然冇 | upsert 失敗 → 睇 Vercel log `[pos/sync] pos_print_jobs upsert failed:`（多數係缺 migration 欄位／RLS） |

### Step 2d 實測結果（2026-09-03 17:59）：**H10 確證**

`pos_queue_events` 最近 20 條（02:14:54 UTC 之前）：

| 觀察 | 事實 |
|---|---|
| 最近 20 條 **全部係 `PRINT_JOB_DELETED`** | **一條 `PRINT_JOB_CREATED` 都冇** |
| 最新事件時間 `02:14:54 UTC`（＝ 10:14 HKT） | 距今（17:59 HKT）**超過 7.5 個鐘冇任何事件到過 server**，期間有落單 |
| 時間戳成簇出現（01:10:13.923 一次 9 條、01:27:44.38 一次 9 條） | 係「清除已發送」批量刪除嘅特徵 |
| `status` 全部 `synced`、`payload_id` 有值 | server 正常收咗並寫入 |

**決定性對照：`PRINT_JOB_DELETED` 根本唔經 sync queue。**

```ts
// print-jobs.ts:380-402 deletePrintJobsOnServer()
const storeId = resolveStoreId();
if (!storeId) return;                       // ← 冇 storeId 就直接放棄
const events = ids.map((id) => ({
  id: `pjd-${id}`, type: "PRINT_JOB_DELETED", entityId: id,
  payload: { id },
  status: "synced" as const,                // ← 一樣寫 "synced"
  createdAt: new Date().toISOString(),
}));
await fetch("/api/pos/sync", { method: "POST", body: JSON.stringify({ events, storeId }) });
//     ↑ 自己直接 fetch，**完全唔經 pushEvents / queue / flush worker**
```

同一個 storeId、同一個網絡、同一個 server、連 `status:"synced"` 都一樣寫 ——
**唯一分別係 DELETE 直連 API、CREATE 行 sync queue。DELETE 全部到、CREATE 零條到。**

→ **H10 確證**：`PRINT_JOB_CREATED` 入隊時被寫成 `status:"synced"`，
　`doFlush()`（`sync-flush.ts:239-242`）喺 `legacyHealed=true` 之後 `filter(e => e.status !== "synced")`
　→ 在線時新建嘅打印單**永遠唔會被推上雲**。

**同時排除**：
- **H8-A（400 缺 storeId）排除** —— `deletePrintJobsOnServer:384` 嘅 `if (!storeId) return;` 冇被觸發，證明 `resolveStoreId()` 有值。
- **H8-B（示範店代碼）排除** —— server 收咗並寫入 `pos_queue_events`，若係 placeholder 會喺 `sync/route.ts:137` 被 400 擋低。
- **H2（store_id 錯配）**降為次要 —— storeId 有效；但仍需 Step 3 核實 Hub 嗰個係咪同一個 UUID。
- **H3 / H4 / H7** 早於 Step 1 已排除。

### Step 2e 而家嘅角色：由「區分 H8/H10」變成「確認修復方向」

H10 已由上面嘅對照確證，reload 實驗嘅用途变成：
**驗證「legacy heal flush 會補推」呢個預測**，同時係而家唯一唔改 code 就可以見到單嘅方法。

```text
1. 記低 pos_print_jobs / pos_queue_events 行數（而家應該係 0 條 CREATE）
2. POS 頁面撳 F5 重新載入
3. 等 10 秒
4. 再查：如果 PRINT_JOB_CREATED 同 pos_print_jobs 突然出現一堆 → 預測成立，H10 落實
```

> 若 reload 之後**依然 0 條**，唯一解釋係 queue 入面根本冇 PRINT_JOB_CREATED 事件
> （例如落單時 `buildKitchenPrintJobs` 冇建到單，或 `networkOnline` 長期 false）。
> 屆時要回頭做 Step 2b 嘅 localStorage dump。

H10 嘅特徵係：**數據只會喺 page reload 後嘅第一次 flush（legacy heal）先補推上雲。**

```text
1. 記低而家 pos_print_jobs / pos_queue_events 嘅行數（應該係 0）
2. 喺 POS 頁面撳 F5 重新載入（唔好開新分頁）
3. 等 10 秒（等 installPosSyncQueueAutoFlush 嘅 trigger() 跑完第一次 flush）
4. 再跑一次 2d-1 / 2a
```

| 結果 | 結論 |
|---|---|
| **reload 之後單突然出現咗** | **H10 確證**：在線入隊嘅事件被 `status:"synced"` filter skip，只靠 legacy heal 補推。呢個同時解釋埋點解「落單」同「測試打印」都冇數據 |
| reload 之後**依然 0 行** | H10 排除 → 返去 Step 2c 嘅 Network tab 睇 HTTP status（H8） |

> ⚠️ **H10 嘅副作用預測**：如果 H10 成立，今日落嘅**訂單**一樣會唔見（`pos_orders` 都係靠同一條 queue），
> 要 reload 先出現。順手跑 `select count(*) from pos_orders where created_at > now() - interval '1 day';`
> 就可以交叉驗證。

### Step 2 實測結果（2026-09-03 17:40）

| 觀察項 | 實測值 |
|---|---|
| Hub UI | 上次認領 ✅ 有跳／上次心跳 ✅ 有跳／上次叫醒 ✅ 有跳，訊息「已訂閱」 |
| `pos_print_jobs`（2a + 2b） | **0 行** |
| web 打印中心 | 狀態顯示「已發送」 |

**由此得出嘅結論：**

1. **Hub 側完全健康** —— claim loop 有跑、Realtime 已訂閱。
   → **H3（migration 未跑）、H4（Realtime 訂閱失敗）、H7（agent 驗證唔過）三項正式排除。**
   呢個結果亦再次印證 H4 澄清：Realtime 完好，30s 兜底根本冇出場。
2. **「已發送」＋雲端 0 行係矛盾組合**，得一個解釋：`sent` 係假陽性 → **H8 上場**。
3. 剩下就係 H1（冇入隊）／H2（store_id 錯）／H8（入咗隊但 push 失敗被靜默）三選一，靠 Step 2b / 2c 拆。

### Step 2 第二輪實測（17:52）：「測試打印」同「落單打印」兩條都冇數據

→ **H1 唔再係主因**：真單（`pos-app.tsx:2243-2258`）確實有 `pushEvents(PRINT_JOB_CREATED)`，
　如果連真單都上唔到雲，說明問題喺**入隊之後**嗰段（push 上雲／server 寫入），而唔係「冇入隊」。

→ 同輪 code 層面證實咗兩件新事：
1. **H9 已確定**：`TEST_PRINT_REQUESTED` 白名單有、但全庫得 2 處命中（定義＋類型），**零 producer、零 handler**。
　「測試打印經雲端中繼」呢條路**從來未 implement 過**，所以測試掣冇單上雲係設計缺口，唔係 regression。
2. **H10 上場**：在線入隊寫 `status:"synced"`（`pos-app.tsx:2248`; 退菜 1959、退桌 2049 等 8 處同一寫法），
　而 `doFlush()` 喺 `legacyHealed=true` 之後會 `filter(e => e.status !== "synced")`（`sync-flush.ts:239-242`）
　→ **在線時新建嘅事件唔會被推，要等下次 page reload 嘅 legacy heal flush 先補推**。
　`sync-flush.ts:64-67` 嘅註解仲寫住「收到 200 先標真正 synced」，可見而家嘅寫法同設計意圖已經對唔上。

### Step 3 · 證實 H2：`store_id` 係咪同一個 UUID

```sql
select agent_id, store_id, name, revoked_at, last_seen_at
  from public.pos_print_agents;
```
拎 Hub 嗰條 `store_id`，對比：
- Hub UI 狀態區顯示嘅 `（<storeId>）`（`MainActivity.kt:289`）
- iPad console：`JSON.parse(localStorage.getItem('pos-auth-session')).merchantId`
- 2b 查出嚟 `pos_print_jobs` 實際用開嘅 `store_id`

三者必須**完全一致**。唔同就要追邊條路徑唔同：
- Hub：`RelayApi.kt:98` `session.optString("merchantId")`（`/api/ledger/login`）
- web：`sync-flush.ts:221-227` `resolveStoreId()` → `auth.merchantId` **或 `loadKioskDeviceBinding().storeId`**
  → **若 iPad 係 kiosk 綁定機，`storeId` 會嚟自綁定而唔係 login → 同 Hub 必然唔同。呢個係 H2 最值得落力查嘅分支。**

### Step 4 · 證實 H3：migration 跑咗未

```sql
-- 4a. claim RPC 喺唔喺度
select proname, pg_get_function_result(oid) from pg_proc
 where proname = 'pos_claim_print_jobs';

-- 4b. 0020 加嘅欄位喺唔喺度
select column_name from information_schema.columns
 where table_name = 'pos_print_jobs'
   and column_name in ('printer','kind','store_name','copies','ttl',
                       'claimed_by','claimed_at','attempts','last_error');
-- 期望 9 行全中

-- 4c. Realtime publication 有冇呢張表
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime';
-- 必須見到 pos_print_jobs

-- 4d. anon 有冇 select policy（Realtime 靠佢做 RLS 判定）
select policyname, qual from pg_policies
 where tablename = 'pos_print_jobs' and cmd = 'select';
```

任何一項唔中 → H3 成立，要先補跑 `0020` / `0021`（**用手貼 SQL Editor，本機冇 DB 連線**）。

> 0021 要注意：窗由 14 日收窄到 24 小時。若 **0021 已跑但 0020 未跑**，`pos_print_jobs`
> 會缺 `claimed_by`/`attempts` → RPC 建唔起 → claim 全 500。

### Step 5 · 證實 H4：Realtime 訂閱狀態

Hub UI 直接睇：
- `狀態：已連線（Realtime）` → 訂閱成功
- `狀態：雲端斷線（30s 輪詢兜底）` → 訂閱失敗，訊息行會有原因

配合 adb logcat 攞細節：
```bash
adb logcat -s HubService:* JobRunner:* RealtimeClient:* HubHttpServer:* SdkPrinter:*
```

| logcat / UI 訊息 | 意思 |
|---|---|
| `已訂閱 realtime:public:pos_print_jobs` | ✅ 正常 |
| `訂閱被拒：…` | RLS / publication 問題 → 回 Step 4 |
| `欠 supabaseUrl / anonKey` | `GET /pair` 冇派憑證 → 查 Vercel env `SUPABASE_URL` / `SUPABASE_ANON_KEY` |
| `watchdog：70s 無收訊，重連` | 網絡唔穩，但 30s 兜底仍會 claim |

手動驗 `GET /pair` 派唔派憑證：
```bash
curl -s "https://<POS_URL>/api/pos/print-agent/pair?agentId=<agentId>" | head -c 400
# 期望：{"status":"paired","storeId":"...","supabaseUrl":"https://...","anonKey":"eyJ..."}
# anonKey 係空字串 → 就係 Vercel 缺 env
```

### Step 6 · 證實 H5：端口同協議（用嚟排除，唔係主線）

```bash
# 喺同一個 LAN 嘅電腦（唔係 iPad）验 Hub 本身死未
curl -s http://<hub-ip>:8787/status
curl -s http://<hub-ip>:8787/printers
```

- 通 → Hub 進程同 NanoHTTPD 正常，**證明問題喺雲端側，唔係 Hub 死機**
- 唔通 → Hub service 冇起 / 另一個 subnet / Android 防火牆。查 `HubService.start()` 同 Doze 白名單
  （Hub UI 有「電池優化」掣，`MainActivity.kt:300-320`）

> 打印機本體 `:9100`：由 Hub UI 撳「測試」掣直接驗（`MainActivity.kt:486-520`）。
> **呢個測試唔經雲端**，用嚟分離「打印機通唔通」同「中繼通唔通」。

### Step 7 · 證實 H6：任務有冇發去錯誤目標（要有單先測到）

呢步要等 Step 2/8 有單之後做。查 Hub 嘅 `LogEntryLog`（app 內日誌列表，可篩成功/失敗、可搜尋）：

每行日誌有 `targetPrinter`（`JobRunner.kt:111` `label()`），會係以下其中一種：

| `targetPrinter` 顯示 | 命中咗第幾級 fallback | 判定 |
|---|---|---|
| `<正確名> (<正確IP>:9100)` | 第 ③ 級：本地設備名匹配成功 | ✅ 正常 |
| `LAN 打印機 (冇 IP:9100)` | 第 ⑤ 級：**全部落空**，必定失敗 | ❌ 路由斷鏈 |
| 名啱但 IP 係第部機 | 第 ④ 級：跌咗去「第一個開 9100 嘅設備」 | ❌ 打錯機 |

對應代碼 `JobRunner.kt:174-232`，四級 fallback 嘅實際狀態：

| 級 | 來源 | 實際狀態（已確認） |
|---|---|---|
| ① `row.printer` jsonb | `pos_print_jobs.printer` | **恒為 NULL** —— web 端 `sync/route.ts:315-336` upsert 冇寫呢個 key，全 `src/` grep `"printer":` 零命中 |
| ② claim 響應 `printers` 陣列 | `/api/pos/print-agent/claim` | **恒為 `[]`** —— `claim/route.ts:41-42` 硬編碼，註釋寫明「v1 返空陣」 |
| ③ 本地 `DeviceStore` 按名匹配 | Hub 自己 LAN 掃描 | 唯一有機會中，但**淨係比對 name 字符串** |
| ④ 第一個 `canRawPrint` | 同上 | 危險 fallback：會隨機打去另一部機 |

> **呢條就係問題二嘅技術根因**：路由表喺 web 端，Hub 端只攞到一個 `printer_name` 字符串，
> 而 `printer_id` 係 web 本地 `uid()` 生成（`hub.ts:55`），Hub 嘅 `DeviceStore` key 係
> `mac:XX` / `ip:XX`（`MainActivity.kt:406`）→ **ID 匹配物理上冇可能中**。

### Step 8 · 對照組：用真實落單測（區分「中繼通唔通」同「測試掣壞唔壞」）

**呢步係整個排查嘅關鍵對照。** 喺 iPad 落一張真單（或去「打印中心」撳重打單，
`print-center.tsx:409-419` —— 呢條路**有** `persistPrintJobs` + `pushEvents`）：

| 結果 | 結論 |
|---|---|
| 真單出到紙、測試掣出唔到 | **H1 完全確證**：中繼链路 healthy，淨係 `testPrint()` 冇接上雲 |
| 真單都出唔到 | 中繼链路本身有問題，返去 Step 3/4/5 繼續 |

---

## 5. 問題二：點樣喺 Hub 端睇到 / 同步打印機路由配置

### 5.1 現狀：路由配置嘅「單一真源」喺 web，且有三處分散

| 層 | 位置 | 有冇數據 | Hub 讀到？ |
|---|---|---|---|
| ① web 本地 | `localStorage` `loadDeviceConfig()`（`storage.ts:414`）→ `DeviceConfig.printers` | ✅ | ❌ 淨喺嗰部 iPad |
| ② 雲端 | `pos_device_configs.printers`（jsonb），由 `device-settings.tsx:448 syncConfig()` 上傳 | ✅（要驗） | ❌ **冇任何下發 API** |
| ③ job 攜帶 | `pos_print_jobs.printer_id` + `printer_name` | ⚠️ 得 ID + 名，**冇 IP/port** | 名勉強用 |
| ④ job 攜帶 | `pos_print_jobs.printer`（jsonb，`0020:17`） | ❌ **全庫無人寫入** | ❌ 永遠 NULL |
| ⑤ claim 響應 | `printers: []`（`claim/route.ts:42`） | ❌ 硬編碼空陣 | ❌ |

### 5.2 調查方向（按順序）

**方向 A · 先確認雲端究竟有冇呢份配置（冇數據就唔使傾下發）**
```sql
select device_id, store_id, terminal_name, updated_at,
       jsonb_array_length(printers) as printer_count,
       printers
  from public.pos_device_configs
 order by updated_at desc
 limit 10;
```
- 0 行 / `printer_count` 為 0 → web 端 `syncConfig()` 根本冇上傳成功，問題喺寫入側
- 有數據但**多過一條 `store_id`** → 下面 B 嘅 filter 問題會好致命

**方向 B · 查讀取路徑嘅已知坑（決定下發時點寫 filter）**

`src/app/api/pos/device-config/route.ts:13-18`：
```ts
const { data, error } = await supabase
  .from("pos_device_configs")
  .select("*")
  .order("updated_at", { ascending: false })
  .limit(1);          // ⚠️ 冇 store_id / device_id 過濾 → 全平台最新一條
```
`pos-app.tsx:784` 已註明「`/api/pos/device-config` GET 冇 terminal filter」。
→ **任何「Hub 直接讀 `/api/pos/device-config`」嘅方案都會讀錯店**，調查時要先排除呢條路。

**方向 C · 評估三條可行嘅下發方案（淨係評估，唔好郁手）**

| 方案 | 做法 | 優點 | 要解決嘅問題 |
|---|---|---|---|
| C1 · claim 響應帶 `printers` | `claim/route.ts:42` 改為由 `pos_device_configs` 按 `agent.storeId` 讀 `printers` 落返去 | Hub 零改動（`JobRunner.kt:186-190` 第 ② 級已經寫好咗匹配邏輯） | 要加 `store_id` 過濾；多機配置合併策略未定 |
| C2 · 新增獨立接口 | `GET /api/pos/print-agent/printers`（用 `x-agent-id` 驗權） | 語義乾淨、可獨立輪詢、唔使改 claim 合約 | Hub 要加拉取 + 緩存 + UI |
| C3 · 將 `printer` 快照寫入 job | `sync/route.ts:315` upsert 補 `printer` 欄位 | 最權威（單據級）、唔使 Hub 端預配置、`JobRunner.kt:180` 第 ① 級即刻生效 | web 端建 job 時要附帶完整 config；job 體積變大 |

> **建議調查重點：C3 + C1 組合。** C3 解決「呢張單要打去邊部機」（單據級權威），
> C1 解決「Hub 端可視化」（畀人睇到全店路由表）。兩者唔衝突，但要分開排期。

**方向 D · Hub 端 UI 要做乜（調查要輸出嘅規格）**

而家 `MainActivity.kt:435-484 refreshPrinters()` 淨係列出 **LAN 掃描發現到嘅設備**
（名 / IP / 開咗嘅 port / MAC），**完全冇「邊部機打乜」嘅概念**。要喺 Hub 端做可視化，
至少要有以下字段，調查時要確認每樣拎唔拎到：

| 要顯示 | 來源 | 而家 Hub 拎到？ |
|---|---|---|
| 打印機名 / role（receipt / zone / label） | `DevicePrinterConfig.role` | ❌ `PrintJobDto` 冇解析 `printerGroup` |
| 分區 `zoneId` | `DevicePrinterConfig.zoneId` | ❌ 同上 |
| IP / port | `DevicePrinterConfig.ipAddress` / `lanPort` | ⚠️ 淨喺本地掃描設備有 |
| charset / kanjiEnlarge / copies | 同上 | ❌ `resolvePrinter()` 第 ③④ 級硬食 null |
| **「web 端配嘅名 ↔ Hub 掃到嘅設備」匹配狀態** | 兩邊 join | ❌ 完全冇，呢個就係最想睇嘅嘢 |

> **`PrintJobDto.fromRow()`（`PrintDtos.kt:83-96`）冇解析 `printer_group`。**
> 就算路由表送到 Hub，`JobRunner` 都冇字段可以按分區路由 —— 調查時要一併確認
> 係咪要加 `printerGroup` 落 DTO（連帶 `PrintJob.printerGroup` 嘅值域：`"receipt"` /
> `"label"` / `"zone:xxx"` / 測試時嘅 `"zone:test"`，見 `device-settings.tsx:522-527`）。

---

## 6. 日誌埋點缺口清單（調查時一併記錄，供後續排期）

| # | 缺口 | 位置 | 後果 |
|---|---|---|---|
| 1 | **claim 返 0 單時完全無聲** | `JobRunner.kt:42` 返 `error=null` → `HubService.kt:175-178` 淨喺 `error != null` 或 `claimed > 0` 先 `note()` | 冇單同「claim 冇跑」喺 UI 上睇落一樣 |
| 2 | 冇 claim 次數計數 | `RelayState` 冇 `claimCount` / `emptyClaimCount` | 無從判斷「有喺度 claim 但永遠 0」定「根本冇 claim」 |
| 3 | 冇記錄 claim 用嘅 `store_id` | `RelayApi.kt:165-184` | H2 要靠 adb 撈 xml 先知 |
| 4 | Realtime `onWake` 冇計數、冇記 payload 摘要 | `RealtimeClient.kt:142` / `HubService.kt:165` | 收唔到叫醒定叫醒咗但 claim 唔到，分唔開 |
| 5 | 冇記錄 `resolvePrinter()` 命中咗第幾級 | `JobRunner.kt:174-232` | 打錯機時淨知結果唔知原因 |
| 6 | web 端 `testPrint()` 全部失敗路徑冇 console log | `device-settings.tsx:502-587` | iPad 上淨見一句「未配對 Companion 代理」，查唔到點解 |
| 7 | `/api/pos/sync` 寫 `pos_print_jobs` 失敗冇上報 client | `sync/route.ts:337-342` | POS 端以為成功，實際 0 行 |

---

## 7. 排查期間嘅注意事項

1. **唔好改任何代碼** —— 本輪淨做只讀調查（SQL 查詢、adb logcat、curl、browser console）。
2. **一次淨改一個變數** —— 唔好同一輪又重裝 APK 又改配置，會令決策樹失效。
3. **每個 Step 都記低實際輸出**（SQL 結果 / logcat 片段 / Hub UI 截圖），
   尤其 Step 1 嗰三個時間戳 —— 佢係成個決策樹嘅分叉點。
4. **撳測試打印前後各影一次 Hub UI**，對比「上次認領」有冇跳。
5. **唔好淨靠測試打印落結論** —— Step 8 嘅真單對照組係必要嘅，
   否則會將「測試掣冇接雲」誤判成「中繼全斷」。
6. 多部 Hub 同時開住會互相 claim 走單（`for update skip locked`），排查時**淨開一部**。

---

## 8. 預期產出

排查完成後應該要有：

- [ ] Step 1 嘅三個時間戳截圖 + 判定（跳咗去邊條分支）
- [ ] Step 2 嘅 SQL 結果（`pos_print_jobs` 有冇行、`order_no` 分佈）
- [ ] Step 3 嘅三個 `store_id` 比對結論（一致 / 邊個唔同）
- [ ] Step 4 嘅 migration 驗收結果（4a/4b/4c/4d 各項中唔中）
- [ ] Step 8 嘅真單對照組結論
- [ ] 問題二：方向 A 嘅 `pos_device_configs` 查詢結果（有冇數據、幾多條 store）
- [ ] 問題二：方向 C 三方案嘅取捨建議

攞到呢啲之後先好寫修復方案，開新一份 `docs/99-*`。

---

## 9. 修復記錄（2026-09-03 18:15，H10 主因已解決）

### 9.1 改動清單（代碼）

| # | 檔案 | 行 | 原本 | 改成 |
|---|---|---|---|---|
| 1 | `src/components/pos-app.tsx` | 23 處 | `status: networkOnline ? "synced" : "pending"` | `status: "pending"` |
| 2 | `src/components/print-center.tsx` | 417 | `status: offlineMode ? "pending" : "synced"` | `status: "pending"` |
| 3 | `src/components/print-center.tsx` | 373-381 | pushEvents 只 saveQueue | 加 `notifyQueueChanged()` 觸發 flush worker |
| 4 | `src/components/print-center.tsx` | 43 後 | 缺 sync-flush import | `import { notifyQueueChanged } from "@/lib/pos/sync-flush"` |

**冇動嘅文件**（合約正確）：
- `src/lib/pos/sync-flush.ts` —— 設計意圖（line 64-67 註解）同新代碼終於一致：入隊 pending、收 200 先標 synced
- 4 處「推送成功後標 synced」嘅代碼（`pos-app.tsx:2078`、`device-settings.tsx:464`、`shift-page.tsx:294,415`、`kiosk-order.ts:308`、`print-jobs.ts:390`）—— 呢個係手動推送嘅合約，無問題

### 9.2 驗證步驟（deploy 後跑）

```sql
-- V1：即時睇新事件係咪開始上雲
select type, count(*) from public.pos_queue_events
 where created_at > now() - interval '5 minutes' group by 1;

-- V2：雲端訂單同打印單有冇補返
select count(*) from public.pos_orders where created_at > now() - interval '5 minutes';
select count(*) from public.pos_print_jobs where created_at > now() - interval '5 minutes';
```

預期：撳完落單 30 秒內 V1 至少 1 行 `ORDER_CREATED` + 1 行 `PRINT_JOB_CREATED`、V2 兩條都有數。

Hub 端觀察（撳完落單 30 秒內）：
- 「上次叫醒」時間戳跳咗 → Realtime 收到 `pos_print_jobs` INSERT
- 「上次認領」同「已印」都有跳 → `JobRunner` claim + 印到

### 9.3 殘留清理（一次性，重要）

因為 legacy queue 入面可能仲有大量「修補之前」嘅 `status:"synced"` 事件（從未真正推上雲），佢哋會被 `legacyHealed=true` 嘅 filter 永久 skip。**修補之後嘅新事件 work，但呢批 legacy events 仲卡住。**

喺 iPad 瀏覽器 F12 Console 跑（先 print 出嚟確認數量，唔好直接清）：

```js
(() => {
  const keys = Object.keys(localStorage).filter(k =>
    /sync-queue|print-jobs/.test(k) &&
    !/_tree_/.test(k)  // 排除 service worker cache
  );
  const out = {};
  for (const k of keys) {
    const raw = localStorage.getItem(k) || '';
    if (!raw.startsWith('[') && !raw.startsWith('{')) { out[k] = '(non-JSON)'; continue; }
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const statusCounts = arr.reduce((a, e) => {
        const s = e.status ?? '(none)';
        a[s] = (a[s] || 0) + 1;
        return a;
      }, {});
      out[k] = { total: arr.length, byStatus: statusCounts,
        syncedEvents: arr.filter(e => e.status === 'synced')
                         .map(e => ({ id: e.id, type: e.type, entityId: e.entityId })) };
    } catch { out[k] = '(parse failed)'; }
  }
  console.table(Object.entries(out).map(([k, v]) => ({ key: k, ...v })));
  return out;
})()
```

- 見到 `syncedEvents` 數量 > 0 → legacy 卡住嘅事件，影響唔到新單但佔空間
- 要清嘅話：將上面 `arr.filter(e => e.status !== 'synced')` 嘅結果寫返 localStorage（**先備份原值**）

**或者更簡單**：直接撳一次「清除已發送」按鈕（會刪所有 `status === 'sent'` 嘅 printJobs），雖然針對嘅唔係 queue，但係個衛生起手式。

### 9.4 第二個問題（打印機路由可視性）未動

仍係 TODO：Hub 端睇唔到「邊部機負責印咩內容」嘅配置喺邊。方向 A（讀 `pos_device_configs.printers` jsonb）、方向 B（行內 storeId 配 config API）、方向 C（hub 推配置）三條路徑都仲未做。建議下輪單獨開份 `docs/99-*` 處理。

