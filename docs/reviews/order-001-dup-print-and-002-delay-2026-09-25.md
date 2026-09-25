# 訂單 001 重複廚房單 與 002 出紙延遲 · 取證報告（2026-09-25）

> **症狀一**：打印中心出現**兩行 001**（09:27「打印成功」、09:30「已發送」），兩張廚房單內容
> 幾乎一樣但有一處唔同（一行顯示店名「**門店**」、無時間／預約時間／全單備註）。
> **症狀二**：商家指 002「打印 delay 差不多 1 分鐘」。
>
> **狀態**：純取證，**未改任何代碼**。兩處修法建議見 §6，全部「未做」。
> **未閉環**：本報告有一項無法由 log 判定嘅事實（§3.4），需要商家回答；答案會決定 §6-④ 要唔要做。

---

## 0 TL;DR

| # | 症狀 | 結論 | 嚴重性 |
|---|---|---|---|
| 1 | 001 出現兩行打印記錄 | **多終端重複補印**：iPad 09:27:29 出過紙；桌面 PC 09:30:49 才開 `/pos`，本機「已出過紙」帳本空 ⇒ 09:30:52 為同一張 001 **再造一條廚房 job**。該條**雲端無對應行**（現時 DB 全日只有 3 條 job，冇第三條 001），本地狀態永遠停「已發送」 | 中。係**已知、程式碼明文接受**嘅邊界（`ledger-pos-bridge.ts` L515-519），唔係新 bug |
| 2 | 兩張紙「睇落唔同」 | **係預覽顯示問題，唔係出紙問題**：`/api/pos/state` 嘅 printJobs 映射**剝走 `template` 同 `content`**，雲端種入本機嘅 job 會落到 `KitchenTicketPreview` 兜底分支 ⇒ 硬寫店名「門店」、無時間／預約／備註 | 中。**真 bug、可修、改動細**（§5） |
| 3 | 002 delay ~1 分鐘 | **唔在打印鏈路**。job 09:30:52 建立 → 同秒 claim → 09:30:52.94 回報（< 1 秒）。1 分鐘全部發生在「客落單 → POS 建立 job」之前：iPad 全程冇接到 002（Realtime 反覆重訂），要等 PC 掛載全量拉單才接 | 高（營運體感）。**根因未定量**，需 Ledger 落單時間（§4.3） |
| 4 | （順帶發現） | **8 部未撤銷中繼機並存**，每 30 秒 warn 一次 | 低（衞生） |

**最重要嘅一句**：症狀 1 同症狀 2 **係兩件獨立嘅事**。症狀 1 產生一條「雲端冇、本機有」嘅 job 行；
症狀 2 令該行**同另一行顯示唔同**。**唔可以憑預覽差異推論印咗兩張紙。**

---

## 1 取證材料與方法

### 1.1 材料

| 材料 | 窗口（澳門時間） | 備註 |
|---|---|---|
| `macau-pos-system-log-export-2026-09-25T01-33-38.csv` | 09:06:37 → 09:33:10 | Vercel，706 行 |
| `supabase_logs (18).csv` | **09:30:52.938 → 09:33:10.559** | POS 專案 `iyrywzormzisyppkokbi`，100 行 |
| 截圖 ×3 | — | 打印中心列表 ＋ 兩張 001 詳情彈窗 |
| 唯讀生產探測 | — | `tools/_probe-today-full-20260925.cjs`、`_probe-settings-20260925.cjs` |

⚠️ **兩份 log 窗口唔重疊**：Supabase 窗由 09:30:52.938 才開始，即 **001 出紙（09:27:29–30）完全在窗外**，
002 嘅 claim（~09:30:52.0）亦剛好在窗邊緣外。所以「DB 冇寫入某行」**唔可以**只靠 Supabase 窗斷定，
必須配合 `pos_print_jobs` 直查（§2.1）。

### 1.2 量度陷阱（實測踩到）

Vercel log 匯出**一行 log 輸出 = 一行 CSV**，而每個請求產生嘅行數**可變**。實測：

```
2026-09-25 09:27:25 | rows=90 uniqReqId=1 | UA=Macintosh/iPad
```

即「同一秒 90 條 `POST /api/pos/sync`」其實係**一個請求**噴咗 81 條 `拒絕覆寫訂單` warn。
⇒ **凡按次數落結論，必須先按 `requestId` 去重**，否則會誤判成「同步風暴」。
（同理：CSV 有引號內換行，唔可以用簡單 `split("\n")`；`grep` 中文關鍵字對 UTF-8 BOM／引號會失效，要用腳本 parse。）

### 1.3 唯讀探測方法

由已部署 bundle（`https://macau-pos-system.vercel.app/pos`、`/prints`）抽公開 anon key，
直查 POS 專案 PostgREST。**唔需要任何憑證、唔碰 `service_role`、全程唯讀**。

---

## 2 硬事實（可直接複核）

### 2.1 2026-09-25 全日 `pos_print_jobs` 只有 3 條

| created_at（澳門） | id | 單號 | status | once_key |
|---|---|---|---|---|
| 09:27:29.277 | `print-a973f43f` | **001** | printed | `ledger-b2aa7a13-…\|kitchen:normal:0:1xos25y\|printer-861f2f6e` |
| 09:30:52.255 | `print-03e343b5` | **002** | printed | `ledger-c5a19d31-…\|kitchen:normal:0:1xos25y\|printer-861f2f6e` |
| 09:50:22.059 | `print-fddc6564` | 澳覓#34 | printed | `aomi-FAKE-AOMI-381874-1776\|kitchen:normal:0:1iq0yvx\|printer-861f2f6e` |

**三個結論**：

1. **冇第三條 001** ⇒ 截圖嗰行「001 @09:30」係**純本機 job**，雲端由頭到尾冇呢一行。
2. `once_key` 係 **composed 格式**（`<orderId>|<onceScope>|<printerId>`）⇒
   2026-09-24 嘅 `printOnceDbKey()` server 側修補**已確實上線**
   （09-24 嘅行仍係 raw 格式，例如 `kitchen:normal:0:z5sbte`，正好做對照組）。
3. 001 同 002 嘅 **內容簽名同為 `1xos25y`** —— 因為兩張單菜品／規格／數量**完全相同**
   （`快閃餐（南乳炸鸡翼饭）x1` ＋ `饮料:例汤／熱定凍:熱／要唔要膠袋:要`）。
   ⇒ 證明 `printOnceContentSignature()` **唔包含** 單號、時間、全單備註（001 備註＝「轉五谷飯」、
   002 備註＝「飯，轉「五谷飯」，謝謝」，兩者不同但簽名一樣）。
   ⇒ 亦證明兩張單靠 **`orderId` 前綴**分開，唔會互相撞鍵。

### 2.2 打印鏈路本身唔慢（逐段量度）

| 段 | 001 | 002 |
|---|---|---|
| job 建立（雲端 `created_at`） | 09:27:29.277 | 09:30:52.255 |
| 中繼 claim | 09:27:30 | 09:30:52 |
| 回報完成（`finished_at` / PATCH） | 09:27:30 | 09:30:52.938 |
| `attempts` | 0 | 0 |
| **鏈路總耗時** | **< 1 秒** | **< 1 秒** |

⚠️ 順帶澄清一個容易誤讀嘅數字：`/api/pos/print-agent/claim` 嘅間隔**唔係**固定 30 秒。
實測序列 `09:22:43 → 09:25:43（180s）→ 09:27:30 → 09:28:44 → 09:29:15 → 09:30:15 →
09:30:52 → 09:32:15 → 09:32:45`，**idle 上限 180 秒只係 keepalive**；真正出紙係
**Realtime 事件驅動**（claim 同 job 建立同秒），所以「claim 間隔長」**唔等於**出紙慢。

### 2.3 現場狀態（現值）

| 項 | 值 | 更新時間（澳門） |
|---|---|---|
| `pos_online_order_settings.auto_accept` | **true** | 09:10:57（source=pos） |
| `pos_online_order_settings.merchant_enabled` | true | 09:10:57 |
| `pos_store_status.is_open` | **true** | 09:10:54（source=pos） |

⇒ 自動接單係**開住**嘅、店係開住嘅。呢點令 §4 嘅「iPad 冇接到 002」更值得追。

anon 可讀：`pos_online_order_settings`、`pos_store_status`、`pos_print_jobs`（24h 窗）。
anon **讀唔到（401）**：`pos_kiosk_settings`、`pos_print_agents`。

### 2.4 兩台機身份（由 Vercel log 逐請求拆）

| 機 | IP | UA | 關鍵動作 |
|---|---|---|---|
| **iPad (A)** | `60.246.53.111` | `Macintosh; Intel Mac OS X … Safari` | 09:27:24、09:27:25、09:27:29 三支 `sync`；09:27:30 / 09:28:01 / 09:30:16 / 09:30:48 / 09:31:18 `state?src=resubscribe` |
| **桌面 PC (B)** | `182.93.6.133` | `Windows NT 10.0; Win64; x64 … Chrome/153` | 09:30:49 開 `/pos`；09:30:52 `state?mode=full`；09:30:52 一支 `sync`(203ms)；09:30:53 一支 `sync`(929ms) |

**兩支決定性請求**：

- `09:27:29 | POST /api/pos/sync 150ms | iPad（Mac UA）` → 呢支就係**建立 001 job** 嘅請求。
- `09:30:52 | POST /api/pos/sync 203ms | Windows UA` → 呢支就係**建立 002 job** 嘅請求。

### 2.5 「清除已成功」33 條 DELETE

`09:30:53.968 → 09:30:54.777`（0.8 秒內）連續 33 支 `DELETE /rest/v1/pos_print_jobs?id=eq.print-…`，
全部來自 **PC（B）**（同一窗口內佢亦有 `state?src=orders-panel`、`pos_queue_events` upsert）。

**33 個 id 全部唔係 `print-a973f43f` / `print-03e343b5`**（即今日兩張真紙嘅行**冇被刪**，現時仍然在 DB）。
⇒ 呢 33 條係該機本地列表內較舊（09-24 及之前）嘅成功 job。

### 2.6 Vercel log 全文搜尋結果（關鍵陰性證據）

| 關鍵字 | 命中次數 |
|---|---|
| `內容唯一鍵` | **0** |
| `略過重複`／`print-dedupe` | **0** |
| `once_key` | **0** |
| `23505`／`duplicate key` | **0** |

帶 `message` 嘅行共 345 條（其餘為 `[egress]`、`[print-agent/pair-status]` 警告、81 條
`拒絕覆寫訂單`、2 條 `退貨豁免`），**冇任何一條係內容唯一鍵去重**。

⇒ 意義：如果那條重複 001 job 曾經被推到伺服器並撞唯一索引，
`/api/pos/sync` 必定 `console.info("[pos/sync] 內容唯一鍵重複 → 略過重複出紙…")`（`route.ts:1780` 附近）。
**冇呢句 ⇒ 該條 job 嘅 `PRINT_JOB_CREATED` 從未真正進入 insert 分支。**

---

## 3 症狀一：001 為何有兩條打印記錄

### 3.1 兩行係兩條**不同嘅 job**

| 列 | createdAt | 建立者 | 雲端對應 | 本機狀態 | 紙 |
|---|---|---|---|---|---|
| 001 | 09:27 | **iPad** | ✅ `print-a973f43f`（`printed`） | 打印成功 | ✅ **第 1 張（合法）** |
| 001 | 09:30 | **桌面 PC** | ❌ **無** | 已發送（永遠） | ❓ 見 §3.4 |

雲端全日只有 3 行（§2.1），排除咗「有第三條隱藏行」。而狀態回填係**按 job id 配對**
（`print-center.tsx` `syncCloudPrintOutcomes()`：`cloudById.get(job.id)`），
⇒ 09:30 嗰行 id 唔在雲端 ⇒ 永遠唔會被升級做「打印成功」，只會停在本機樂觀值。

### 3.2 根因：補印判準**全部係本機**（程式碼明文承認）

`src/lib/ledger/ledger-pos-bridge.ts` L505-519（原文）：

> ── 去重（三重，全部必要）──
> 1. `decideKitchenBackfill()` 查「已出過紙帳本 + 本機 job」→ 唔會重複印；
> 2. `kitchenBackfillAttempted`：同一個 session 每張單**只試一次**；
> 3. `kitchenBackfillInFlight`：**跨元件**防止兩邊同時通過判準。
>
> ⚠️ **已知邊界（多終端）**：以上都係**本機**判準。若同一間店同時開住兩個 POS 介面
> （例如 iPad + 桌面版），A 機接單出紙之後，B 機要等到**下次載入 runtime state**（reload / 手動更新）
> 才會經雲端 backfill 見到嗰張 job —— 中間呢段時間 B 機**有機會補印多一張**。
> 現階段接受（**商家口徑：寧多一張，好過廚房零紙**），要根治就要喺伺服器按
> `order_id` 查一次 `pos_print_jobs`（**未做**）。

判準原始碼（`src/lib/pos/kitchen-backfill.ts` `decideKitchenBackfill()`）：

```ts
if (input.inFlight) return "in-flight";
if (input.hasJob) return "has-job";                       // ← per-瀏覽器
const status = normalizeBackfillStatus(input.status);
if (!KITCHEN_BACKFILL_STATUSES.includes(status)) return "inactive-status";
if (status !== "completed") return "print";               // ← 非終態＝無時間窗限制
…
```

**PC 09:30:49 掛載時實際發生嘅事**：

1. `restoreLedgerSession()` → `loadLedgerOrders("full")` → 見到 001 狀態係 `accepted`／`preparing`
   （iPad 09:27 已接單）。
2. `hasPrintJobForOrder("ledger-b2aa7a13-…")` → **false**。原因：該函式讀
   `loadPrintJobs()`（本機 localStorage）＋ `printedLedgerOrders`（同為本機）——
   **PC 呢部機由未出過 001，所以佢「唔知」iPad 出過**。
3. `decideKitchenBackfill` 見 `status="accepted"`（∉ `completed`）⇒ **直接 `return "print"`**，
   **完全冇時間窗／次數限制**。
4. ⇒ 為**已經出過紙嘅 001** 再造一條廚房 job → 09:30 嗰行。

同一輪亦令 002 正常接單出紙（`auto_accept=true`，§2.3）。

`ensureKitchenPrintForLedgerOrderOnce()` 被呼叫嘅位置（兩處，都會跑）：
`src/components/quick-online-orders-panel.tsx` L539-（`for (const order of ledgerOrders)`，
**唔篩 status**）／`src/components/online-orders.tsx` 同源兜底。

### 3.3 為何第二條冇上雲、又冇紅標

兩個可能，**log 都指向第二個**：

| 可能 | 機制 | 對 log 嘅預期 | 實測 |
|---|---|---|---|
| ① 推到伺服器被唯一索引擋 | composed 鍵同 001 一樣 ⇒ insert 23505 ⇒ `ack(true, applied:false, reason:"print-dedupe-skip")` | **必定**有 `[pos/sync] 內容唯一鍵重複` info 行 | ❌ **冇**（§2.6） |
| ② 從未進入 insert 分支 | 舊 client 嘅「只寫本機」路徑、或事件未入 outbox | 冇該 info 行 | ✅ 符合 |

兩個可能嘅**共同後果**都係：**雲端冇呢一行 ⇒ 中繼 APK claim 唔到 ⇒ 呢條 job 喺雲端路徑上一張紙都唔會出。**
本地則因為 `dispatch` 走 relay 分支時 `RelayTransport.send()` 係 no-op、樂觀回 `{ok:true}`
（`src/lib/print-bridge/relay-transport.ts`）⇒ 被標成 `"sent"`（綠色「已發送」）。
呢個就係 `docs/113`／`print-center.tsx` L476-482 記載嘅陷阱：

> 「本地有、雲端冇 → 永遠停留『已發送』，**零紅標、唔會自我修正**。」

（`unsyncedPrintJobIds` 只喺 outbox 仍有該 `PRINT_JOB_CREATED` 未 synced 時才標紅；
如果事件由頭到尾冇入過 outbox，連呢個提示都唔會出。）

### 3.4 🔴 未閉環：到底有冇出實體紙？

`src/lib/print-bridge/dispatch.ts` 嘅通道優先級係
**① native bridge → ② 桌面 Companion（localhost）→ ③ relay（雲端備援）**：

- 純瀏覽器（website／PWA）：只有 ③ ⇒ `send()` no-op ⇒ **唔會出紙**。
- 若該台 PC 有 **Companion 或 native APK**：行 ② ⇒ **本機直接送打印機、完全繞過雲端**。

⇒ **如果 PC 有本機通道，嗰 09:30 嘅第二條 job 就會本機出紙**，而
**DB 內容唯一鍵完全攔唔到佢**（唯一鍵只管雲端 relay 路徑）。呢個係暫時唯一
能解釋「物理上收到兩張 001」嘅路徑。

**需要商家回答**：
1. 該台 PC 有冇裝桌面 Companion／原生 print agent？
2. 廚房實際收到**一張**抑或**兩張** 001 紙？

（若答「兩張」⇒ §6-④ 必須做；若答「一張」⇒ 症狀 1 只係**清單顯示**多一行，嚴重性即刻下降。）

---

## 4 症狀二：002「delay 差不多 1 分鐘」

### 4.1 分段歸因

| 段 | 內容 | 002 實測 | 邊度慢 |
|---|---|---|---|
| A | 客落單 → Ledger `orders` INSERT | **未知**（見 §4.3） | ❓ |
| B | Ledger 單 → POS 偵測到並建立 kitchen job | job 建立 = **09:30:52.255** | **✅ 慢（體感 1 分鐘）** |
| C | job → 中繼 claim | 09:30:52 | 快 |
| D | claim → 出紙回報 | 09:30:52.938 | 快（< 1 秒） |

⇒ **B 段之前唔關打印事**，A+B 就係商家感受到嘅 1 分鐘。

### 4.2 B 段為何慢：iPad 全程冇接到 002

| 時間 | 事件 | 來源 |
|---|---|---|
| 09:30:16 | `state?incr=1 … src=resubscribe` | iPad |
| 09:30:48 | `state?incr=1 … src=resubscribe` | iPad |
| **09:29 – 09:31** | **完全冇 iPad 嘅 `POST /api/pos/sync`** | Vercel log |
| 09:30:49 | 開 `/pos`（`mount`） | **PC** |
| 09:30:52 | `state?mode=full … printJobs=200`（423 KB） | **PC** |
| 09:30:52 | 建立 002 job | **PC** |

⇒ 09:30 期間**只有 iPad 開住**，但佢**冇**為 002 建立 job、亦冇推任何事件；
係 **PC 一開就透過全量拉單（`mode=full`）見到 002 並接單**。

而 iPad 兩次 `src=resubscribe` 顯示其 **Realtime channel 反覆重訂**。
`quick-online-orders-panel.tsx` 對應邏輯：

```ts
onResubscribed: () => loadLedgerOrders("incremental")
```

⇒ 正常情況下每次重訂都會順手增量拉一次 Ledger 單，理應大約 30 秒內補到。
所以「iPad 竟然冇接到」有兩個候選，**都未證實**：

- **候選 1**：`auto_accept` 在本機（per-terminal）實際係熄嘅
  （`local_settings.onlineOrderSettings.autoAccept` 係 **per-terminal 真源**，
  而雲端 `pos_online_order_settings.auto_accept=true` 係**店級**）⇒ iPad 冇自動接單，
  只有 PC 開頁才人手／自動接。⚠️ 值得留意：`auto-accept` 有歷史「雲端值還原本地開關」事故
  （`pos-app.tsx` L1716-1722 註釋），係已知易漂移項。
- **候選 2**：增量水位（`cursor.since` / `sinceId`，`quick-online-orders-panel.tsx` L251-263）
  漏單；或 Ledger Realtime 訂閱本身冇收到 INSERT（對應記憶中「QR 自助點餐收銀端收唔到
  realtime 通知」嘅舊問題）。

### 4.3 定量缺口：需要 Ledger 落單時間

POS 專案查唔到 Ledger 單（`ledger-*` 只存在於投影／bridge registry；今日 `pos_orders` = **0 筆**），
而 Ledger `orders` 對 anon 係 **401 permission denied**。請在 **Ledger 專案**（`zymdemjflsckicwcinxl`）
SQL Editor 跑：

```sql
select id, order_no, status, payment_status,
       created_at at time zone 'Asia/Macau' as created_mo,
       updated_at at time zone 'Asia/Macau' as updated_mo
from   public.orders
where  created_at >= timestamp with time zone '2026-09-25 09:00+08'
  and  created_at <  timestamp with time zone '2026-09-25 10:00+08'
order  by created_at;
```

拿到 002 嘅 `created_at` 之後，`A 段 = created_at → 09:30:52.255` 就可以定死，
亦可以直接判斷候選 1／候選 2（若 A 段本來就只有幾秒，問題就純粹係 B 段）。
同時建議檢查 **`pos_kiosk_settings.self_order_auto_accept`**（anon 401，要在 Dashboard 睇）。

---

## 5 順帶發現（真 bug）：`/api/pos/state` 剝走 `template` / `content`

### 5.1 位置

`src/app/api/pos/state/route.ts` L729-755，printJobs 映射**只回**：

```
id, orderId, orderNo, tableName, ticketType, printerGroup, printerName,
printerId, onceKey, items, status, createdAt
```

**冇 `template`、冇 `content`**（刻意的 egress 取捨，同 L710-717 嘅註釋一脈相承）。

而 `src/components/pos-app.tsx` L1704-1707：

```ts
if (Array.isArray(payload.printJobs)) {
  // P0-1：以 localStorage 為底 merge…只補本機冇嘅 server 單
  persistPrintJobs(payload.printJobs);
}
```

⇒ **雲端 job 會被種入本機打印記錄**，但**冇快照**。

### 5.2 後果

`src/components/kitchen-ticket-preview.tsx` 三條分支，冇 `template` 就落到 ③：

```ts
const content: Record<string, string> = {
  store_name: "門店",                                  // ← 硬寫
  order_no: job.orderNo ?? job.orderId,
  table_name: job.tableName ?? "",
  order_type: ticketTypeLabel(job.ticketType),
  order_note: job.content?.order_note ?? "",
  footer: "",
};
return renderEscPosLines(buildSnapshot("kitchen", DEFAULT_KITCHEN_TEMPLATE), content, job.items ?? []);
```

⇒ 預覽會顯示 **店名「門店」**、**冇打印時間／預約時間／全單備註**。

**實測對照**：雲端 `print-a973f43f` 明明有
`content = {time:"09:27", store_name:"表嫂美食", scheduled_pickup:"預約時間: 09/25 12:00", order_note:"轉五谷飯", …}`
＋ `template`（923 chars），但截圖 1 嗰張紙顯示「門店」＋無時間。
⇒ 兩張 001 紙「睇落唔同」**完全由呢個顯示缺陷解釋**。

### 5.3 為何唔可以「塞返入 state」

`state?mode=full` 已經 **423 KB／200 條 job**（`bytes=423846`）。每條 job 加
`template`(~923B) + `content`(~300B) ≈ 1.2 KB ⇒ 200 條 = **+250 KB／次**，
而 `state` 係 mount / resubscribe 都會打。
⇒ 正確做法係 **lazy fetch**：撳「查看」時按 job id 單獨拉一條完整內容（§6-②）。

### 5.4 推論邊界（寫入 memory 嘅紅線）

**預覽 ≠ 出紙。** 預覽缺 template 只係顯示問題；實體紙係 relay／Companion 用
**雲端／本機 job 嘅完整 payload** 印嘅。任何「兩張紙內容唔同」嘅判斷，
**必須先排除呢個顯示因素**，否則會誤診成出紙錯誤。

---

## 6 未做嘅修法（建議，按優先次序）

| # | 目標 | 位置 | 做法 | 風險／成本 |
|---|---|---|---|---|
| ① | **治本：多終端重複補印** | `ledger-pos-bridge.ts` `ensureKitchenPrintForLedgerOrderOnce()` ＋ 一支唯讀查詢端點 | `decideKitchenBackfill` 判 `print` 之後、build job 之前，**先問 server「`order_id` 有冇 job」**（帶 POS 終端憑證）。有 ⇒ 唔補印 | 低頻請求（只喺補印場景）。**要決定離線 fallback**：建議 fail-open（照補印，維持「寧多一張」）＋ 記錄 |
| ② | 預覽同出紙一致 | `print-center.tsx`「查看」＋ 新端點 | 按 job id lazy 拉 `template`/`content`（**唔可以**塞入 `state`，見 §5.3）。無快照時明確顯示「雲端記錄，未含模板快照」 | 改動細、零 egress 增量 |
| ③ | 「本地 sent／雲端冇」對賬 | `print-center.tsx` `syncCloudPrintOutcomes()` | 本地 `sent` 但雲端連續 N 輪查唔到 ⇒ 標紅（現時只覆蓋 outbox pending 同 dedupe-skip 兩種） | 純顯示，安全 |
| ④ | **封本機通道繞過唯一鍵** | `dispatch.ts` native／Companion 分支 | 本機出紙前亦要確認雲端有 job（或至少把本機出紙結果上報），令 DB 唯一鍵對所有通道有效 | **只在 §3.4 答「有本機通道」時才要做**。會影響主打印路徑，需獨立評估 |

**唔建議**：將「已出過紙」帳本由 localStorage 改成雲端同步（每次建單都查雲端）——
會把低頻問題變成高頻請求，直接牴觸 09-24 嘅 egress 紀律。

---

## 7 待確認事項（回覆後可即時更新本報告）

| # | 問 | 對象 | 影響 |
|---|---|---|---|
| 1 | 廚房實際收到 **1 張**抑或 **2 張** 001 紙？ | 商家 | 決定 §6-④ 要唔要做 |
| 2 | 該台桌面 PC 有冇裝 **Companion／原生 print agent**？ | 商家 | 同上 |
| 3 | Ledger 專案跑 §4.3 嘅 SQL，取 002 嘅 `created_at` | Ledger | 定死延遲係 A 段抑或 B 段 |
| 4 | iPad 上嘅**自動接單開關**實際值（per-terminal） | 商家／截圖 | 分辨 §4.2 候選 1 vs 2 |
| 5 | （順帶）是否 revoke 8 部舊中繼機 | 商家 | 衞生；`tools/print-relay-revoke-stale-agents.sql` |

---

## 8 附錄：可重跑嘅取證命令

### 8.1 唯讀探測（保留在 repo）

```bash
node tools/_probe-today-full-20260925.cjs     # 今日 pos_print_jobs 全欄位（含 template/items/content）
node tools/_probe-settings-20260925.cjs       # auto_accept / is_open / kiosk / agents
```

### 8.2 逐請求去重（避免 Vercel log 倍數陷阱）

```bash
node -e "…"   # 見本報告 §1.2；核心係 group by requestId 之後才計數
```

### 8.3 直接對 DB 覆核今日行數

```
GET https://iyrywzormzisyppkokbi.supabase.co/rest/v1/pos_print_jobs
    ?select=id,order_no,status,created_at,once_key
    &store_id=eq.8291f843-9def-4956-9d0b-1cfef2598306
    &created_at=gte.2026-09-24T16:00:00Z
    &order=created_at.asc
```
（帶已部署 bundle 抽出嘅 anon key；24h RLS 窗，見 `supabase/migrations/0021`。）

---

## 9 事故教訓（一句）

> **「已出過紙」唔可以係 per-瀏覽器狀態。**
> 只要同一間店有第二部機、換過機、重裝過、或 reload 過，
> 本機帳本就同現實脫節，而 UI 唔會出聲（顯示「已發送」、無紅標）。
> 現時唯一兜底係雲端 DB 內容唯一鍵 —— 但佢**只管雲端 relay 路徑**；
> 本機 Companion／native 出紙完全繞過。要根治，判準一定要落到伺服器（§6-①、④）。
