# 診斷：設置內「備註 / 折扣 / 支付方式」內容冇落 DB（2026-09-09）

> 範圍：POS 設置頁（`src/app/settings/page.tsx` → `DeviceSettings`）內三個 tab——
> 支付方式（payments）、備註（notes：常用備註／免單備註／取消備註／返結原因）、折扣（discounts）。
> 本次只做程式碼層定位，**未改任何 code**；驗證步驟見 §7。

## 一、結論（先講重點）

**呢三組「資料」喺 DB 冇專屬資料表，亦唔係寫入任何獨立 table row；佢哋淨係作為
`PosLocalSettings` 嘅陣列欄位，同打印機／樓層桌台等一齊打包入 `pos_device_configs.local_settings`
（jsonb，**以 `device_id` 為 PK**）。** 因此：

1. **DB 寫入淨得一條路**：設置頁撳「保存」→ `saveAll()` 直接 POST `/api/pos/device-config`，
   由 route upsert 落 `pos_device_configs`（onConflict `device_id`）。呢條係 **fire-and-forget 一次性請求，冇重試、冇補傳**。
2. **離線兜底通道（outbox）對設置事件係死嘅**：queue 入面嘅 `DEVICE_CONFIG_UPDATED` 事件，
   即使之後連返網自動 flush，server 端 `/api/pos/sync` **只會將佢原封寫入 `pos_queue_events`**，
   **永遠唔會套用落 `pos_device_configs`**（route 內根本冇 DEVICE_CONFIG 分支；DB 亦冇 trigger 消費佢）。
   → 任何「撳保存嗰刻 POST 唔成功」嘅設置改動，**一世唔會上到 DB**（本機留低都係靠運氣，見 §4）。
3. **讀取面係「全店揀最新一條 device row」**（GET `/api/pos/device-config`、`/api/pos/state` 都係
   `.eq(store_id).order(updated_at desc).limit(1)`），但寫入係 per-device row →
   多終端各自保存會互相覆蓋（LWW 但唔係同一行），新嗰次保存可能帶住舊／default 內容，
   **令先前已成功寫入嘅備註／折扣／支付方式「喺 DB 睇唔到」**。
4. **POS 主畫面同步會以 server 版覆蓋本機**：`pos-app.loadRuntimeState()` merge 時，呢啲欄位
   （notePresets/discounts/paymentMethods…）唔喺「本地優先」清單 → server 舊版／default
   可以將啱啱加好嘅內容**覆蓋返走**（淨係 floors/printTemplates/onlineOrderSettings/printContentToggles 保留本機）。

簡單講：**內容冇寫入 DB 的最直接原因 = 「撳保存嗰吓嘅 direct POST 冇成功，而 outbox 唔會補救」；
即使寫入成功，「以全店最新一條 device row 當 store 設定嚟讀」嘅設計亦會令佢睇落好似冇咗。**

## 二、現行同步鏈路（code 位置）

```
DeviceSettings（設置頁）
 ├─ 三 tab 編輯 → 只改 component state `localSettings`（草稿）     device-settings.tsx
 │    notes:      L1046-1349   （notePresets/comp/cancel/reopenReasons）
 │    discounts:  L1351-1465   （localSettings.discounts）
 │    payments:   L2496-2560   （localSettings.paymentMethods）
 ├─ 「保存」掣 → saveAll()                                       L529-602
 │    ├─ 1) saveLocal()：寫 localStorage（store-scope key）      L524-527
 │    ├─ 2) enqueue DEVICE_CONFIG_UPDATED（outbox）              L541-566
 │    │     ⚠️ payload 缺 discounts / reopenReasons /
 │    │        fullVoidBehavior / printContentToggles 等欄        L545-558
 │    ├─ 3) POST /api/pos/device-config   ← 唯一真正寫 DB 路      L569-576
 │    │        body = { ...config, localSettings: 全份 } 
 │    └─ 4) POST /api/online-order-settings（自動接單，另一件事） L577-584
 │
 ├─ 寫 DB：/api/pos/device-config/route.ts
 │    POST：upsert pos_device_configs（device_id PK）            route L49-77
 │          supabase 未配置 → 直接 return ok（冇寫入）            route L53、L71-76
 │    GET：eq(store_id) order updated_at desc limit 1（全店最新） route L22-28
 │
 ├─ server sync 入口：/api/pos/sync/route.ts
 │    DEVICE_CONFIG_UPDATED 只入 pos_queue_events                route L43-53、L221-238
 │    冇任何分支將佢套用落 pos_device_configs                    （ORDER_*/PRINT_* 先有）
 │
 └─ 讀取/覆蓋端：
      /api/pos/state/route.ts  L111-113 + L169   （全店最新 device row → local_settings）
      pos-app.loadRuntimeState L995-1048          （server localSettings 做 base，
                                                    淨係 floors/printTemplates/
                                                    onlineOrderSettings/printContentToggles
                                                    保留本機 → notes/discounts/payments 係 server 優先）
```

## 三、點解「內容冇成功寫入 / 同步至 DB」—— 成因分層

### 3.1 【最直接】寫入通道係一次性 POST，失敗即無
`saveAll()`（L569）個 `fetch` 失敗／超時／HTTP 500（離線、路由報錯、proxy 斷線）→ 行 `catch`，
**淨係 setStatus「已保留在本機待補傳」**。補傳靠 outbox，但 §3.3 證明 outbox 唔會寫 `pos_device_configs`。
→ **DB 永遠冇呢次改動**。呢個係最常撞到嘅「本機有、DB 冇」成因。

### 3.2 server 未配 Supabase → 假成功
`/api/pos/device-config` route：`getSupabaseServerClient()` 為 null（缺
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`）時，**POST 直接 return `ok:true`，一個字都冇寫**（L11-13 同款邏輯喺 GET、POST 喺 L53 只有 `if (supabase && …)`）。前端睇「已保存（本機 + 後台同步完成）」但 DB 空。
同類「靜默唔寫」喺 demo／未接 DB 嘅環境 100% 發生。

### 3.3 outbox（DEVICE_CONFIG_UPDATED）冇 server 消費者 —— 離線改動唔會補傳
- queue 事件出得世帶 `storeId`（`withStoreScope`，docs/111 已修）→ 可以被 flush 推上雲；
- 但推上去 `/api/pos/sync` 只會喺 `pos_queue_events` upsert 一行（L221-238），
  之後**冇任何 code／DB trigger 將呢行轉化為 `pos_device_configs` 更新**（已 grep migration 確認無 trigger）。
- 對比訂單／打印 job：`ORDER_*` 同 `PRINT_JOB_*` 喺同一 route 內有直接套用分支（L240-451）。
→ 設置類事件喺 server 側係「收咗當儲咗」，**語義上冇落地**。
- 附帶：呢個 queue payload（device-settings L545-558）**漏咗 `discounts`**（同 `reopenReasons`、
  `fullVoidBehavior`、`printContentToggles`、`autoPrint`、`grossProfitMarginPct`），就算日後加 server
  消費者，折扣都唔會跟 queue 上雲（payments + notePresets 三個反而有帶）。

### 3.4 資料模型：呢三組嘢根本冇「店級資料表」
`備註／折扣／支付方式` 預設清單只係 `PosLocalSettings` 上嘅陣列（`types.ts` L452-545），
**冇 migration 為佢哋開 table**。落 DB 只係 `pos_device_configs.local_settings` jsonb 內一部份。
若預期「DB 有 note_presets / discount_presets / payment_methods 等 table」→ 事實係**唔存在**，
就算寫入成功都要喺 jsonb 度睇（`local_settings->'notePresets'` 等）。
又：`pos_device_configs` PK 係 `device_id`（0011 migration L93-100），**唔係 store_id** ——
「一店一行」嘅店級設定表（參照 0027 `pos_print_templates` 做法）一直冇為呢三組嘢做。

### 3.5 多終端互相覆蓋（寫入成功但「DB 版本」會被推返轉頭）
- A 機保存 → A 嘅 device row `updated_at` 最新，DB 睇到 A 內容；
- B 機（row 較舊／localSettings 係舊快照）之後任何一次「保存」（哪怕只改打印機）→ 用 **B 嘅全份
  localSettings** 覆寫 B 自己 row → B row 變全店最新 → **DB「最新」版本唔再含 A 加嘅折扣／備註**。
- 讀取端（GET device-config、`/api/pos/state`）都係「全店最新一條」，所以呢個覆蓋即時影響：
  C 機／後台拉返嚟就係舊內容 → 「A 加嘅嘢冇咗」。
- 設置頁本身 `loadRemoteConfig`（L406-455）**刻意唔採用** remote localSettings（淨 merge 打印機），
  所以 A 機自己設置頁仲見到自己啲內容 → 同 DB／其他機對唔上，做成「同步唔到」觀感。

### 3.6 POS 主畫面同步會「server 優先」冚走本機新內容
`loadRuntimeState`（pos-app L1037-1047）以 server `payload.localSettings` 做 base，notes/discounts/
payments 等**唔喺本地優先清單**。當 server row 係舊版（3.5 被蓋）或唔存在（3.1-3.3 DB 從未寫入）：
- server 版 = 舊內容或 `defaultPosLocalSettings`（`/api/pos/state` L169 fallback default）；
- merge 落嚟 savePosLocalSettings → **本機啱啱加嘅備註／折扣／支付方式被冚走**。
- 觸發條件：queue 全 synced（方案 B gate）＋ pos-app（工作台 "/"）mount／reconnect／queue 清空。

### 3.7 環境／身份因素（令寫入落錯店或根本唔落）
- `resolveStoreId()` 無 merchantId（本地 mock 帳號登入、未登入）→ flush 400 ／ `store_id` 空白
  或 mock placeholder（`macau-store-a`）→ 寫咗都唔喺真實 store 底下（記憶 09-09「mock 本地帳號冇 merchantId」）。
- 設置頁首次開（未登入）用 default `deviceId:"tablet-01"`＋ `storeId:"macau-store-a"` 保存 → row 落錯店。

### 3.8 UX／流程（次要但常見）
三個 tab 都係「草稿 + 底部保存」模式；加咗／刪咗但**未撳保存**就離開頁面 → component state 即棄，
localStorage 同 DB 都唔會有（status bar 已經提醒「請先保存」）。

## 四、影響範圍

| 面向 | 影響 |
|---|---|
| 資料落點 | 備註（常用/免單/取消/返結原因）、折扣項目、支付方式 全部收埋喺 `pos_device_configs.local_settings` jsonb，**冇獨立 table**；per-device row 而唔係 store row |
| 單機（在線+有 DB） | 保存後本機 localStorage 即時生效；DB 有 row（只要嗰下 POST 成功），重開機靠本機快取照樣見——**呢個係唯一「正常」情境** |
| 單機（離線撳保存） | **DB 永遠唔會補**（3.3）；稍後 POS 主畫面同步可能冚走本機（3.6） |
| 多終端 | A 改 → B 保存 → DB「最新」變返舊內容（3.5）；B 嘅設置頁永遠唔會自動見到 A 啲嘢（3.5 loadRemoteConfig 設計） |
| 後台／報表 | 後台讀 `pos_device_configs`／`/api/pos/state` 只會見到「全店最新 device row」版本，同實際任何一部機嘅設定都可能唔一致 |
| 訂單落地 | 訂單層面（`pos_orders`）本身有 `order_note`/`comp_note`/`discount_amount`/`payment_method` 直欄，由 `/api/pos/sync` 寫 —— 唔受上面設置欄位影響；但設置頁改嘅「預設清單」只影響之後落單 UI，唔會追溯舊單 |
| 環境 | demo／無 server key：UI 顯示「同步完成」但 DB 零寫入（3.2） |

## 五、點驗證（read-only，揀啱嗰個成因先落手）

1. **本機即刻核**：DevTools → `localStorage["macau-pos/stores/{merchantId}/local-settings"]`
   睇 `discounts`／`notePresets`／`paymentMethods` 有冇你想要嘅內容（本機層確認）。
2. **DB 核**（喺真實 merchant UUID 下）：
   ```sql
   select device_id, store_id, updated_at,
          local_settings->>'paymentMethods' as pm,
          local_settings->>'discounts'      as disc,
          local_settings->>'notePresets'    as notes
   from pos_device_configs
   where store_id = '<真實 merchant UUID>'
   order by updated_at desc;
   -- 再睇 queue 有冇 DEVICE_CONFIG_UPDATED 但 device_config 冇對應內容：
   select id, type, status, store_id, created_at from pos_queue_events
   where type = 'DEVICE_CONFIG_UPDATED' order by created_at desc limit 10;
   ```
   - 若「本機有、DB 最新 row 冇」→ 3.1 / 3.3 / 3.5。
   - 若「queue 有 DEVICE_CONFIG_UPDATED 而 device_config 冇」→ 3.3 實錘。
3. **撳保存嗰下睇 network**：`/api/pos/device-config` POST 係 200 定 error；
   200 但 DB 冇 row → 3.2（server 冇 service key）或落錯 store_id（3.7）。
4. **多機現場**：B 機淨改打印機再保存，再查上面 SQL → 若 A 內容消失即 3.5。

## 六、修復方向（未做，供揀）

1. **店級資料表 + 獨立 route**（根治，照抄 0027 `pos_print_templates` 模式）：
   開 `pos_store_presets`（store_id PK + note_presets/discount_presets/payment_methods jsonb + updated_at），
   saveAll 改寫呢度；設置頁 mount 拉呢度；多終端 LWW 用 updated_at 對版。
2. **server 補 `DEVICE_CONFIG_UPDATED` 套用分支**（細改）：/api/pos/sync 遇到呢 type 時，
   將 payload 內 device/localSettings 拆出嚟 upsert `pos_device_configs`（要補埋 `discounts` 等漏帶欄位）。
3. **讀取改 per-device**：GET device-config / state 只揀「呢部機自己嘅 device_id」row
   （而唔係全店最新），多終端唔會再互相蓋 —— 但要另諗店級設定真源（返 1）。
4. **pos-app merge 將 notes/discounts/payments 都列入本地優先**（止喞 3.6 冚走，
   唔解決 DB 唔寫入）。
5. **saveAll 失敗要寫入 outbox 且唔可以「靜默」**；同埋 route 喺 supabase null 時要 return 503 唔好 ok。
