# 安全排查報告：兩筆自助點餐機（kiosk）訂單 + 大量同步失敗

- 日期：2026-09-16（澳門時間）
- 店舖 storeId：`8291f843-9def-4956-9d0b-1cfef2598306`
- 分析對象：`macau-pos-system-log-export-2026-09-16T12-14-21.csv`（Vercel runtime log）
- 相關截圖：訂單列表（自取01／自取02，19:41）、模組授權（自助點餐機＝開）、同步健康檢查（6 筆失敗）

---

## 0. 一句話結論

**呢兩筆 kiosk 單唔係由收銀台產生嘅（收銀台寫死 `source:"pos"`），佢哋只可以來自「已綁店嘅 `/order` 自助機裝置」或者「直接打 `POST /api/pos/sync`」。而目前 `POS_REQUIRE_DEVICE_AUTH=0` 正在生產環境生效 ⇒ 任何知道 storeId 嘅人（storeId 本身印喺枱 QR 上，係公開值）都可以匿名建單、改單、結帳、刪單 —— 呢個係全份 log 最嚴重嘅發現，必須優先處理。同步失敗同網絡無關，係兩個獨立嘅客戶端缺陷。**

---

## 0.5 結案更新（2026-09-16 20:45 · 已用雲端 DB 覆核）

### (A) 兩筆 kiosk 單：確認由「自助機客戶端」產生，唔係 API 偽造

| 欄位 | 自取02 | 自取01 |
|---|---|---|
| id | `kiosk-81ed2f69` | `kiosk-b0dc1cdd` |
| **建立（澳門）** | **19:29:43** | **19:27:22** |
| 最後改動（澳門） | 19:41:32（→ cancelled） | 19:41:38（→ cancelled） |
| 金額 | MOP 43.00 | MOP 17.00 |
| 對應事件 | `evt-2348dae2`（11:29:43.992） | `evt-654b880d`（11:27:22.734） |

判讀：

1. id 前綴 `kiosk-` = `newKioskOrderId()` / `buildKioskOrder()` 產生（`kiosk-order.ts:21,314`）⇒ 走正常自助機落單流程。
2. 事件時間比訂單 `created_at` **只遲 1–2 ms**，正是 `submitKioskOrder()` 嘅簽名（同一函式內先建單後封 event）。人工 curl 好難做到呢個巧合。
3. 兩條事件都**帶齊 `store_id`**（跨店印章正常）⇒ 產生者係一部**已綁定你間店嘅正常客戶端**，唔係無狀態掃射。
4. 🔴 **UI 顯示「19:41」係「最後更新時間」（取消），唔係建立時間**；真正落單係 **19:27 / 19:29**。呢點之前一直被誤讀。
5. **3 日內全平台只有這 2 張 kiosk 單**（覆核：`8291f843` pos 91／kiosk 2；`d564b932` scan 11／pos 6；`f6ec837a` pos 2）⇒ **一次性事件**，唔似自動化攻擊。

⇒ **推論**：19:27–19:29 之間，有一部已綁店嘅裝置落了兩單（啤酒 MOP17 + 快餐 MOP43），約 12 分鐘後（19:41）被取消。
取消係 `ORDER_UPDATED(status=cancelled)`，正常由「本機有該單」嘅終端發出（即收銀台見到陌生單後撳「取消結帳」）。

**要捉到「邊部機／邊個人」**——匯出 Vercel log **UTC 11:26–11:31（澳門 19:26–19:31）**，睇三樣：

| 睇咩 | 判讀 |
|---|---|
| 有冇 `POST /api/pos/sequence` | kiosk 落單前**必然**打（用來攞 `自取01/02` 序號）⇒ 有就證明走完整自助機流程 |
| 同期 `requestUserAgent` | 同收銀機一樣嘅 `Macintosh … Version/17.14 Safari` ⇒ 可能就係店內 iPad（有人喺工作台揀「自助點餐機」再輸入 storeId）；`iPhone; CPU iPhone OS` ⇒ 手機；Android／陌生 UA ⇒ 優先級最高 |
| 若已開返 auth，`sync` 會自動印 `ip=` | `sync/route.ts:375`（見 §5.2） |

### (B) 6 筆同步失敗：同 kiosk **完全無關**——係線上單橋接嘅 payload 形狀 bug

`entity_id` 全部係 **`ledger-<uuid>`**（= Ledger 線上單鏡像 id，`ledger-pos-bridge.ts:567`），而 `payload->>'source' = null`：

- 截圖 6 筆對得上 DB：`…4bb11d32`、`…afea660c`、`…8e5917f2`、`…dffce238`、`…a36fe08f`（第 6 筆在 50 行截斷之外）。
- **根因（定位到行）**：`ledger-pos-bridge.ts:388-400 enqueueOrderEvent()` 兩種 type 都送 `payload: { order }`；
  而 `sync/route.ts:666` 舊版**只喺 ORDER_UPDATED 拆 `.order`**，ORDER_CREATED 直接用裸 payload
  ⇒ `order = { order: {…} }` ⇒ `order.id === undefined` ⇒ `ack(false,"事件 payload 缺少訂單 id")` ＋ **HTTP 400（永久）**。
- ⇒ 每次「線上單**首次**排位／採納」（`ledger-pos-bridge.ts:833`，`index < 0`）都會產生一條**永遠上唔到雲**嘅 ORDER_CREATED。
- **後果唔止 UI**：該張線上單喺 POS 雲端冇完整記錄——最壞情況一直唔存在，結帳時只由 `ORDER_SETTLED` 嘅 0 列 upsert 兜底建一條**最小記錄（冇 items）**（`sync/route.ts:1119-1150`）。
- ⇒ 亦解釋「按放棄又彈返」為何特別頑固：呢類事件係**被重新產生** + reload 後 legacy-heal 重推（見 §4.2），唔係單純殘留。

### (C) 已做嘅修正（**本地工作區，未 commit、未部署**）

| 檔案 | 改動 |
|---|---|
| `src/lib/pos/sync-order-payload.ts`（**新增**） | 拆解規則抽出為**單一真源**：`unwrapOrderEventPayload()` / `addedItemsOfEventPayload()`。事故根源正是「兩個地方各自實作、規則唔一致」，所以唔再容許 route 內自行寫一份。 |
| `src/lib/pos/sync-order-payload.test.ts`（**新增**） | 7 條迴歸測試，含「`{ order }` ＋ ORDER_CREATED → 必須回 `.order`」呢條事故形狀。 |
| `src/lib/ledger/ledger-pos-bridge.ts`（`enqueueOrderEvent`） | ORDER_CREATED 改送**裸 order**（對齊收銀台／kiosk 契約）＋ 長註釋記錄事故 |
| `src/app/api/pos/sync/route.ts`（LWW 預取段 → 用 helper） | 兩種 type 用同一條規則，LWW 守門唔再靜默失效 |
| `src/app/api/pos/sync/route.ts`（主解析段 → 用 helper） | **兩種 type 都接受兩種形狀** ⇒ 已經排隊嘅 6 筆舊事件會喺下次 flush **自動補上**，唔需要再手動放棄 |

驗證：

| 檢查 | 結果 |
|---|---|
| `node_modules/typescript/bin/tsc --noEmit` | **0 error** |
| `node --test`（全套） | **778 pass / 0 fail**（64 suites） |
| `eslint`（4 個改動檔案） | **exit 0（無 warning / error）** |

部署後預期：6 筆失敗事件自行轉成功並消失；之後新嘅線上單排位亦唔再產生壞事件。
（`ORDER_SETTLED` 嘅 0 列 upsert 兜底 `sync/route.ts:1119-1150` 保持不變 —— 佢係防止靜默丟單嘅最後防線。）

---

## 1. 先校正資料範圍（重要）

| 項目 | 實際情況 |
|---|---|
| Log 覆蓋時間 | **2026-09-16 11:42:20 – 11:42:59 UTC ＝ 19:42:20 – 19:42:59（澳門）**，只有 **約 40 秒** |
| 你講嘅「7:40–7:43」 | 對應 UTC−4（美東）＝ 11:40–11:43 UTC。但匯出檔只有 11:42 之後嘅行 ⇒ **19:40:00–19:42:19 完全缺失** |
| 影響 | 兩筆 kiosk 單建立時間係 **19:41**，**啱啱好喺缺失嘅時段內** ⇒ 用呢份 log **冇可能**直接睇到「係邊個建立」 |
| 檔案結構 | 138 行 = **50 個獨立請求**（Vercel 每個 `console.log` 出一行，所以同一 requestId 會重複好多行） |
| 🔴 冇 IP 欄 | 匯出欄位只有 `TimeUTC / requestPath / requestMethod / status / UA / region / message…`，**完全冇 `clientIp` / `x-forwarded-for`** ⇒ 「來源 IP 是否異常」用呢份檔**答唔到**（見 §6 補救方法） |

---

## 2. 呢 40 秒內實際發生咗咩（逐項）

### 2.1 請求分佈（按 50 個唯一請求計）

| 請求 | 狀態 | 數量 | 說明 |
|---|---|---|---|
| `GET /api/pos/state` | 200 | 12 | 收銀台輪詢 |
| `GET /api/pos/shift` | 200 | 9 | 交班狀態 |
| `GET /api/online-order-settings` | 200 | 9 | 線上接單設定 |
| `POST /api/pos/sync` | **400** | **1** | ⚠️ 一次過帶 32 條事件的批次，被整批拒 |
| `POST /api/pos/sync` | 200 | **1** | 5 秒後重推，同批 stale 事件改回 `applied:false` |
| `POST /api/topup/pending-count` | 200 | 5 | — |
| `GET /api/pos/store-status` / `/api/pos/bootstrap` | 200 | 3 | — |
| `POST /api/pos/print-agent/heartbeat`、`/claim` | 200 | 2 | 中繼機 `okhttp/4.12.0`（Android 打印中繼） |
| `GET /` `/reports` | 304 | 2 | 頁面載入 |

**冇出現**：401 / 403 / 500、任何 admin / backoffice / 匯出類端點、任何陌生 API 路徑。

### 2.2 客戶端身份

| UA | 數量 | 判斷 |
|---|---|---|
| `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Version/17.14 Safari/605.1.15` | 47 | iPad Safari（ipadOS 會自報 Macintosh）＝ 店內收銀／平板 |
| `okhttp/4.12.0` | 3 | Android 打印中繼機 |

視窗內**只有店內裝置**，冇任何陌生 UA。但**呢點唔足以排除入侵**：偽造者用 curl 打 API 唔會出現喺呢 40 秒（見 §1 時間缺失）。

### 2.3 兩個 sync 請求嘅內容（本報告核心證據）

**請求 A**：`4lnm2-1789558974780-e8b1…`（19:42:54.78）→ **HTTP 400**，32 條日誌：

- 1 × `⚠️ POS_REQUIRE_DEVICE_AUTH=0：跳過通道授權（應急模式，請盡快恢復）`
- 25 × `拒絕覆寫訂單 order-XXXX（現有=settled@…，incoming=sent_to_kitchen@…）付款階段降級`
- **6 × `訂單事件 payload 缺少訂單 id（type=ORDER_CREATED）`** ← 同「同步健康檢查」截圖嘅 6 筆完全對應

**請求 B**：`8894j-1789558979782-657f…`（19:42:59.78）→ **HTTP 200**，26 條日誌：同樣 1 × auth 警告 + 25 × 拒絕覆寫。

> ⚠️ 讀數陷阱：138 行睇落似「33 次 sync 400」，實際只係 **1 個** 400 請求（32 條 log 行）。唔好當成 33 次失敗。

**被拒嘅 23 張舊單，雲端 settled 日期分佈**：09-14 ×4、09-15 ×36、09-16 ×10 ⇒ 全部係**幾日前嘅舊快照**被反覆重推。

---

## 3. 兩筆自助機訂單：來源推斷

### 3.1 先收窄：唔可能係收銀台落嘅

| 產生者 | `order.id` 前綴 | `source` | 證據 |
|---|---|---|---|
| 收銀台 / 快餐收銀台 | `order-` | **寫死 `"pos"`** | `pos-app.tsx:2412`、`pos-app.tsx:2428`、`pos-app.tsx:3446` |
| 店員手機落單 | `staff-` | `"staff"`流程（無 kiosk） | `pos/staff-order.ts:76,122` |
| 自助機 `/order`／掃碼 | `kiosk-` | `isScanLink ? "scan" : "kiosk"` | `kiosk-order.ts:21,314`、`use-kiosk-order.ts:856` |

UI 上嗰個「自助點餐機」徽章 = **`order.source === "kiosk"`**（`order-source-badge.tsx:10`），唔係根據機型或單號推斷。
⇒ 收銀台**冇任何路徑**可以產生 kiosk 徽章。所以呢兩張單一定係以下其中一條路。

### 3.2 可能入口（按可能性排序）

**入口 ①（最可能）：真·自助機客戶端，但裝置唔係「你以為冇」**
- 要成為 kiosk 裝置，只需要喺 `/order` 綁店畫面**手動輸入 storeId**（`kiosk-order.ts:82-108`，存 localStorage `macau-pos-kiosk-device`）。
- 🔴 **storeId 本身係公開值**：枱 QR 就係 `/menu?tableId=…&store=<merchantId>`（`sync/route.ts:351-353` 註解明寫「枱 QR 已經公開 storeId」）。
- 所以**任何人用手機打開 `/order` + 輸入（或從 QR 取得）storeId**，就可以變身一部自助機、無限落單。
- 亦可能係店內某一部平板被同事誤開過 `/order` 一次（kiosk mode 係純 localStorage 旗標，一開就開機自動跳 `/order`）。

**入口 ②：直接 `POST /api/pos/sync` 偽造**
- 伺服器**設計上**允許匿名建單，只要 `payload.source ∈ {scan, kiosk}`（`sync/route.ts:398`）。
- 而家連呢個白名單都**冇生效**（見 §5），即係偽造者連 `source` 都可以照抄 kiosk，甚至自稱 `pos`。

**入口 ③（可排除）：跨店／其他店污染**
- 視窗內所有請求嘅 storeId 一律係 `8291f843…`，單一店，無跨店跡象。

### 3.3 決定性判別（10 分鐘可完成）

```sql
-- ① 睇 id 前綴 + 時間：kiosk- 開頭 = 由自助機客戶端建立；order-/staff- = 店內終端
select id, source, local_order_no, table_id, table_name, status,
       created_at, client_updated_at, order_note, total
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and source = 'kiosk'
order by created_at desc
limit 30;
```

```sql
-- ② 睇對應事件嘅 payload 形狀 + 有冇 store_id（偽造者通常唔帶 event.storeId）
select id, type, entity_id, payload->>'source' as src, store_id, created_at
from public.pos_queue_events
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and type = 'ORDER_CREATED'
order by created_at desc
limit 50;
```

```sql
-- ③ 順手查「一日內 kiosk 單異常多」嘅店（同一隻手會打幾間）
select store_id, source, count(*)
from public.pos_orders
where created_at >= now() - interval '3 days'
group by 1,2 order by 3 desc;
```

**判讀表**

| 觀察 | 結論 |
|---|---|
| id = `kiosk-xxxxxxxx`，store_id 欄位有值 | 由自助機客戶端建立 → 有人成功令一部裝置綁咗你間店（入口 ①／② 皆可能） |
| id 唔係 `kiosk-` 前綴（例如自訂字串） | **人工偽造**，走 API（入口 ②） |
| `pos_queue_events.store_id` 為 NULL | 舊 client 或偽造者冇帶跨店印章，值得追 |
| 該店同時出現多個 source=pos 嘅陌生單 | 高置信度入侵（匿名者繞過白名單） |

---

## 4. 「大量同步失敗」成因分析（同網絡**無關**）

### 4.1 兩個獨立成因

| # | 症狀 | 伺服器判定 | 性質 |
|---|---|---|---|
| A | 6 × `ORDER_CREATED` →「payload 缺少訂單 id」 | `sync/route.ts:1045-1047`；payload 唔係 object 或冇字串 `id`（`route.ts:618-620,673`） | **永久性**，重試一萬次都會失敗 |
| B | 25 × `拒絕覆寫訂單`（23 張 09-14/15/16 舊單） | LWW 守門：雲端已 `settled`，incoming 係 `sent_to_kitchen` 舊快照 → `ack(ok:true, applied:false, reason:"downgrade")`（`route.ts:892-915`） | **伺服器行為正確**，係客戶端 outbox 積累咗舊快照 |

### 4.2 為何「按放棄之後又彈返」——已定位到 code

1. 「放棄」＝ `discardFailedSyncEvent()` → 事件由 `failed` 轉 **`skipped` + skipReason:"user-discarded"**（`sync-flush.ts:262-281`）。看起來係終態。
2. 🔴 **但每次頁面 reload 後嘅第一輪 flush，會用「legacy heal」分支**：
   ```ts
   // sync-flush.ts:558-560
   const unflushed = legacyHealed
     ? allQueue.filter(e => e.status !== "synced" && e.status !== "skipped")   // ← 正常輪
     : allQueue.filter(e => !(e.status === "failed" && attempts >= 5));        // ← reload 後第一輪
   ```
   `legacyHealed` 係 module 變數，**每次 reload 都係 `false`**。呢個分支**只排除 `failed`**，**唔排除 `skipped`** ⇒ 你啱啱放棄嘅事件即刻被重新推送。
3. 推上去 → 再次 `400`（同一批壞 payload）→ `applyEventResults` 將 attempts 由 5 加到 6、狀態**轉返 `failed`**（`sync-flush.ts:506-518`）
   ⇒ 佢又重新出現喺「同步失敗事件」清單。**放幾多次都會返嚟。**
4. 另外仲有三條自動重試迴路會不斷重推：`failed` 15 分鐘退避重試（`sync-flush.ts:99,365-371`）、30 秒 flush interval（`:69`）、對賬守護 60 秒一輪 + 20 秒／8 秒補查（`sync-reconcile-daemon.ts:62-66`）。

### 4.3 排除「網絡不穩」

- 同一 40 秒內有 **29 個成功請求（19×200、2×304…）**，兩個 sync 請求**都收到完整 HTTP 回應**（400／200 帶 body），`/api/pos/state` 12 次全部 200。
- 400 係**業務拒絕**（`retryable:false`），由應用層自己嘅 payload 驗證產生；離線／逾時會走「保留 pending、唔加 attempts」分支（`sync-flush.ts:603-607`），log 完全冇呢類跡象。
- 結論：**同步失敗唔係網絡問題，亦同兩筆可疑訂單無因果關係**（一單 created 成功／失敗同 outbox 壞事件係兩條獨立鏈）。
- ⚠️ 唯獨要注意：呢 23 張舊單係 09-14/15 遺留，代表**該裝置至少有一次長時間離線或整批推送失敗**，係「慢性病」而非今次事件。

---

## 5. 🔴 P0：`POS_REQUIRE_DEVICE_AUTH=0` 正在生效（目前最大安全漏洞）

**證據**：log 明文出現 `[pos/sync] ⚠️ POS_REQUIRE_DEVICE_AUTH=0：跳過通道授權（應急模式，請盡快恢復）`（`sync/route.ts:369-372`），即係生產環境該 env 現時係 `0`。

### 5.1 影響（唔止 sync 一條端點）

| 閘 | 正常行為 | 現時（=0） |
|---|---|---|
| `posRouteAuthGuard()` 全部受保護端點（state／orders／shift／print-jobs／print-templates／device-config／note-presets／online-order-settings／pair-status…） | 需 admin token 或 POS 終端憑證 | **`resolvePosRouteAuth()` 第 59 行直接 `return {ok:true, via:"disabled"}` ⇒ 任何人帶 storeId 即 200** |
| `/api/pos/sync` 匿名通道限制 | 只准 `ORDER_CREATED/UPDATED` + `source ∈ {scan,kiosk}` | `authorized = !authEnforced \|\| …`（`sync/route.ts:365-368`）⇒ **永遠 `authorized=true`**，白名單、店內營業閘、售罄校驗全部跳過 ⇒ 匿名者可 **自稱 source:"pos"、改單、結帳（ORDER_SETTLED）、刪單（ORDER_DELETED）、建打印任務、寫設定** |
| 店內營業閘（`pos_store_status.is_open=false` 擋匿名客） | 暫停營業即擋掃碼／自助機落單 | `if (!authorized && storeClosed)`（`route.ts:698`）⇒ **唔會生效**，暫停營業照樣收到匿名單 |
| 費率限流 | 匿名按 IP 300/min | 走「已授權」分支：按 storeId 600/min |

**關鍵補充**：`POS_REQUIRE_DEVICE_AUTH` **「冇設」＝ 仍然開閘**（`pos-device-token.ts:137-139`，空值回 `true`）。所以「我冇改過」唔代表安全，而今次 log 證明佢**明確被設成 `0`**。

### 5.2 修復次序（唔可以亂）

1. **先驗簽發能力**：打 `POST /api/pos/device-token`，必須回 200 + token；若 503 = 缺 `POS_DEVICE_TOKEN_SECRET`／`ADMIN_SESSION_SECRET`／service role key，先補 env。
2. **確認店內 iPad 已持有 token**（`posDeviceAuthHeadersFresh()` 會自動續期）。
3. 設 `POS_REQUIRE_DEVICE_AUTH=1`（或直接刪除該 env）→ **Vercel 一定要 Redeploy**（改 env 唔會套用到現有 deployment）。
4. 逐端點驗：匿名無憑證打 `state` / `print-jobs/status` / `device-config` / `pair-status` 應回 **401**；收銀台正常操作應照 200。
5. ⚠️ **開閘後會連帶影響嘅東西（要先試）**：
   - `print-relay`（中繼 APK）嘅 `fetchDeviceConfig()` **冇帶憑證**（`RelayApi.kt:221`）⇒ 可能「拉唔到配置 → 打印機 IP 變 NULL → 全店停印」。
   - 自助機面板（`KioskPrinterPanel`）／`kiosk-settings` 等若部機冇店員登入 session，會由「一直得」變成 401。
   - ⇒ 建議**非營業時間／低峰做**，並準備即時回滾（設返 `0` + Redeploy）。

---

## 6. 你問嘅「來源 IP」——點先攞到

呢份 CSV 冇 IP 欄，但程式本身已經抽咗 IP，只係**冇印出嚟**：

- `clientIp()` 讀 `x-forwarded-for` / `x-real-ip`（`lib/pos/rate-limit.ts:43-47`）。
- `sync/route.ts:375` 本來有一句 `console.info("[pos/sync] 匿名通道請求（store=…, ip=…)")`，**但佢喺 `authEnforced && !authorized` 之下才會執行** —— 而家 auth 關咗，所以永遠唔會印。
- ⇒ **把 `POS_REQUIRE_DEVICE_AUTH` 設返 `1`，就即刻恢復匿名請求嘅 IP 記錄**（一石二鳥）。
- 另可考慮：暫時喺 sync route 開頭無條件 log 一行 `ip`（改一行 code，需你批准）。

**其他取證途徑**
1. Vercel 專案 → Observability → Logs，時間用 **UTC 11:40–11:43**（即澳門 19:40–19:43，唔好用美東時間），過濾 `requestPath = /api/pos/sync`，睇有冇 IP 資訊／Firewall 事件。
2. Vercel Firewall（WAF）若有開，睇同期 blocked 記錄（掃描／異常來源）。
3. Supabase（`iyrywzormzisyppkokbi`）→ `pos_orders.created_at` 對比 `pos_queue_events`，鎖定準確秒數後，再回頭匯出**嗰 2 分鐘**嘅 log。

---

## 7. 「即刻關閉自助點餐機」評估（關之前／之後要注意）

### 7.1 🔴 先講最重要嘅一句：**關模組授權，擋唔住呢兩筆單**

| 你可能期望 | 實際行為 |
|---|---|
| 關「自助點餐機」＝ 冇人可以落 kiosk 單 | ❌ 該開關只係 **UI 導覽授權**：`module-catalog.ts:130-138` 定義 `homePath:"/order"`，只影響 `/select-workbench` 同側欄顯示（`select-workbench-screen.tsx:83-90`、`app-sidebar.tsx:44-45,117`） |
|  | ❌ `/order` 路由本身**冇檢查模組授權** |
|  | ❌ `/api/pos/sync` **完全唔知模組授權呢回事**，`source:"kiosk"` 照收（`route.ts:398`） |
|  | ❌ 已經設成 kiosk mode 嘅裝置（`macau-pos-kiosk-mode`）開機照樣自動入 `/order` |
| 生效方式 | 由 Admin `PATCH /api/admin/merchants/modules` 寫授權 → **每部終端要重新登入**先見到（`ledger/login/route.ts:148-150` 註解明寫） |

### 7.2 關閉前要確認（避免連帶事故）

1. **冇真·自助機在用**：問清楚店內有冇任何平板／手機曾被綁成 kiosk（提示：查 `pos_print_agents` 唔關事，要睇裝置本機；亦可睇 `pos_orders.source='kiosk'` 近 30 日歷史）。
2. **自助機打印機配置**：kiosk 小票機係 per-store 存雲端（`KioskPrinterPanel`）—— 關模組唔會刪設定，但若之後再開要重新綁。
3. **無人之境**：唔會影響堂食收銀台、快餐收銀台、KDS、報表；`/order` 只係唔再從工作台進入。
4. **同步隊列**：關模組唔會清 outbox，之前嗰 6 筆＋23 張舊單**仍然會繼續重試並繼續彈**（見 §4）⇒ 要另外處理。

### 7.3 關閉後仍需做（真正止血）

| 優先 | 動作 | 為何 |
|---|---|---|
| P0 | `POS_REQUIRE_DEVICE_AUTH=1` + Redeploy | 唯一可以令「匿名偽造」收口嘅一步；同時恢復匿名 IP log |
| P0 | 檢查 storeId 曝光路徑：枱 QR、外賣單 QR、官網連結 | storeId 一旦外流，kiosk 綁定就係一個無需密碼嘅落單入口 |
| P1 | 為 `source:"kiosk"` 加「裝置綁定校驗」（需要 migration／新 token 方案） | 長遠根治；目前只有 per-store token（0041 §3）方案 |
| P1 | 清本機 outbox（6 筆壞事件 + 23 張舊單）＋ 修 `legacy-heal` 分支令 `skipped` 一律排除 | 停止「放棄後又彈返」 |
| P1 | 修產生「冇 id payload」嘅客戶端來源 | 否則新機／reload 後會再產生 |
| P2 | 加 `middleware.ts` 或統一閘，避免下次漏一條 route | 根因係「57 條 route 逐條自己寫、漏一條就係洞」 |
| P2 | 帳號安全：換 `merchant_staff` 密碼、檢查有無多餘 staff 帳號 | 同今次無直接證據，但屬標準收尾 |

---

## 8. 結論對照（你問嘅 5 條）

| 你嘅問題 | 答案 |
|---|---|
| 來源 IP 是否異常 | **用呢份 log 答唔到**（冇 IP 欄）＋ 覆蓋時間唔含 19:41。要 UTC 11:40–11:43 重新匯出，或先把 `POS_REQUIRE_DEVICE_AUTH` 設返 `1` 恢復 IP log |
| 有冇可疑 API 呼叫／異常操作 | 呢 40 秒內**冇**（全部係店內 iPad Safari + okhttp 中繼，只有 KDS 級別正常端點）。但 `POS_REQUIRE_DEVICE_AUTH=0` 令「冇發現」嘅意義大打折扣 |
| 兩筆 kiosk 單成因／入口 | 收銀台**唔可能**產生（寫死 `source:"pos"`）。入口只可以係「已綁店嘅 `/order` 客戶端」或「直接打 sync API 偽造」；判別靠 `pos_orders.id` 前綴（`kiosk-` vs 自訂）＋ 對應 `pos_queue_events` |
| 關閉自助機前後注意 | 見 §7。**核心：關模組擋唔住訂單**，真正止血係 `POS_REQUIRE_DEVICE_AUTH=1`；關閉需每部終端重新登入 |
| 同步失敗成因／同可疑訂單關係／優先漏洞 | 兩個客戶端缺陷（永久壞 payload ×6、舊快照重推 ×25），**同網絡無關、同可疑訂單無因果關係**。優先處理：**P0 `POS_REQUIRE_DEVICE_AUTH=0`** |

---

## 附錄：一頁式行動清單

```sql
-- 1) 今晚即刻做（只讀，確認有冇被寫入過）
select id, source, local_order_no, status, created_at, client_updated_at
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and source = 'kiosk'
order by created_at desc limit 30;

select count(*) filter (where source='kiosk') as kiosk_cnt,
       count(*) filter (where source='scan')  as scan_cnt,
       count(*) filter (where source='pos')   as pos_cnt
from public.pos_orders
where store_id = '8291f843-9def-4956-9d0b-1cfef2598306'
  and created_at >= date_trunc('day', now() at time zone 'Asia/Macau');
```

```
-- 2) Vercel 動作（依序）
a. POST /api/pos/device-token  → 確認 200 + token（503 = 缺 secret，先補 env）
b. 設 POS_REQUIRE_DEVICE_AUTH=1（或刪除該環境變數）
c. Redeploy
d. 覆核：匿名 curl 打 /api/pos/state?storeId=… 應該 401；
       收銀台 iPad 操作應正常；中繼機 heartbeat/claim 應正常
```

```
-- 3) 之後（需批准先做，屬 code 改動）
- sync-flush.ts:558-560：legacy-heal 分支加入 `&& e.status !== "skipped"`
- 為 6 筆壞 payload 事件提供「永久忽略」入口（唔靠 reload 重試）
- 追查產生「ORDER_CREATED 但 payload 無 id」嘅客戶端路徑
```

---

## 10. 加固後驗證（2026-09-16 21:25 · `POS_REQUIRE_DEVICE_AUTH=1` 已生效）

工具：`tools/verify-pos-authgate.cjs`（逐端點驗閘）、`tools/audit-anon-endpoints.cjs`（全站匿名可達掃描）。
兩者**只發 GET**，唔會寫任何資料。

### 10.1 閘生效確認

| 端點 | 匿名狀態 |
|---|---|
| `/api/pos/state`、`/api/pos/shift`、`/api/pos/print-jobs/status`、`/api/pos/print-templates`、`/api/pos/note-presets`、`/api/online-order-settings`、`/api/pos/device-config`、`/api/pos/print-agent/pair-status`、全部 `/api/admin/*` | **✅ 401** |
| `/api/pos/bootstrap`、`/api/pos/store-status`、`/api/pos/order-lookup`、`/api/pos/print-agent/pair` | ✅ 仍然匿名（**設計需要**：客人掃碼／自助機／中繼配對） |

⇒ 匿名者已無法讀寫店舖資料；客人掃碼路徑完好。

### 10.2 🔴 全站匿名掃描（28 條 GET）——仲有 4 條漏網

| 端點 | 匿名回傳 | 嚴重度 | 呼叫方 | 建議 |
|---|---|---|---|---|
| `/api/pos/orders` **GET** | **269 KB／500 張單**（菜品、金額、備註、時間） | 🔴 P0 | **倉內冇 in-app GET 呼叫**（`local-orders-panel.tsx:413` 只用 DELETE）；註解聲稱係「主系統整合 API」（`docs/integration/main-system-integration.md`，2026-08-12 嘅**建議文件**） | 若整合未上線 → 直接加同 DELETE 一樣嘅閘；若已上線 → 加服務憑證 `POS_INTEGRATION_TOKEN` |
| `/api/backoffice/overview` **GET** | **3.2 KB：全部店舖清單**（id + 名稱）＋帳號／權限組 | 🔴 P0（**可列舉 storeId**，再用 storeId 打其他端點） | `lib/backoffice-client.ts:66`（**冇帶憑證**） | `/backoffice` 受 `AuthGuard allowedRoles:["admin"]` 保護 ⇒ 端點應要求 **admin session 或 POS 終端憑證**，客戶端補 header |
| `/api/salon/state`、`/api/salon/bootstrap` **GET** | salon 訂單／客人／預約（本店回空） | 🟠 P1（**2026-09-15 審查已列 P0，至今未修**） | `lib/salon/storage.ts:300-301`（冇帶憑證） | 兩條都加 `posRouteAuthGuard` + 客戶端帶 `posDeviceAuthHeaders()` |
| `/api/inventory/health` **GET** | `{configured, connected, shop_users_count:11}` | 🟡 P2 | **冇任何呼叫方** | 加閘（或直接刪） |
| `/api/pos/kiosk-settings` **GET** | `selfOrderAutoAccept`／`scanMode` | 🟢 可接受 | `use-kiosk-order`（匿名） | **刻意開放**，已有 120/min 限流；唔好加閘 |
| `/api/desktop-release` | 版本／更新說明 | 🟢 可接受 | 桌面版更新檢查 | 保持 |
| `/api/pos/bootstrap`（42 KB 餐牌） | 菜單／價格／枱 | 🟢 可接受 | 客人掃碼 | 保持（設計） |

### 10.3 🟠 中繼機 `device-config` 收緊後嘅影響（已查 APK 源碼）

- 兩個中繼 App **都會**無憑證拉 `device-config`：`print-relay`（`RelayApi.kt:221-222`）、`macau-ledger-merchant`（`RelayApi.kt:184`）⇒ 而家**一定 401**。
- **但唔係即時停印**，因為：
  1. `RelayApi.fetchDeviceConfig()` 遇到非 2xx **回 `null`**，註釋明寫「caller 應保留舊值」；
  2. `HubService.kt:217` `if (list != null) …` ⇒ **保留上一次成功嘅值**；
  3. 真正揀機係 `JobRunner.resolvePrinter()`（`JobRunner.kt:187-250`）有**四級 fallback**：job 內 `printer` → `device-configPrinters` → claim 回傳嘅 `printers` → **本機 LAN 發現（按名匹配，再退到「第一個開 9100 嘅機」）**。
- ⚠️ **風險點**：`RelayState.deviceConfigPrinters` 係**純記憶體**（`RelayState.kt:53` 初始 `emptyList()`）⇒ **中繼機一重啟**（斷電／更新／強制停止）就會失去權威路由，靠 LAN 發現揀機：
  **唔會停印，但多打印機嘅店可能印錯機**，而且 Hub UI 見唔到路由。
- ⇒ 行動：**今晚唔好重啟中繼機**；營業前做一次測試打印；中期正解係中繼 App 帶 `agentId/agentToken`（server 端 `device-config` GET 接受 print-agent 憑證）——需要改 APK。

### 10.4 順手發現

- `GET /api/pos/store-status` 回報 `isOpen:false` ⇒ **店內目前係「暫停營業」**。
  因為閘已生效，`is_open=false` 而家**真正會擋**匿名掃碼／自助機落單（以前被繞過）。
  如果唔係刻意暫停，記得喺 header 撳返「營業中」。
- `print-agent/heartbeat` / `claim` **冇被擋**（設計如此）⇒ 中繼派工鏈路完好。

