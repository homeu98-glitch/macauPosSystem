# 92. 線上訂單「自動接單」— POS ↔ Ledger 雙向同步

> **目的**：POS（macau-pos-system）嘅「線上訂單 · 自動接單」同 Ledger（membership.macau-tech.com）嗰粒同名掣，
> 今日係**兩個完全獨立、互不相干嘅開關**。商家喺 Ledger 撳咗，POS 畫面唔會變；喺 POS 撳咗，Ledger 都唔會變。
> 本文件定義**雙向同步**嘅規格：真源、資料表、兩條 HTTP 契約、即時廣播、同埋 Ledger 嗰邊要做嘅部分。
>
> **方案**：HTTP 雙向互推（**唔共用 DB**）。已確認 Ledger 嗰粒掣嘅資料喺**佢哋自己另一個資料庫**。
>
> **真源範圍**：由「每部收銀機各自 localStorage」改做「**全店共用（server 按 store 存一份）**」。

---

## 1. 現狀問題（點解要改）

### 1.1 POS 側真源 = 本機 localStorage（per-terminal）

```
讀：src/components/online-orders.tsx:67   localSettings.onlineOrderSettings.autoAccept
寫：改 localStorage + POST /api/online-order-settings（fire-and-forget，失敗淨係 console.warn）
表：online_order_settings（store_id, auto_accept, updated_at）
```

### 1.2 「Ledger 撳 → POS 顯示」= 100% 冇對接（寫咗但從來冇行過）

`/api/online-order-settings` **有** GET，唯一 caller 係 `src/components/device-settings.tsx:277-325`。
但嗰段邏輯**每一個分支都係 `return current`** —— 本地值永遠勝出，server 返嚟嘅值**從來冇被採用過**，係死 code。

雪上加霜：

| 問題 | 位置 |
|---|---|
| 只喺「設備設定」頁 mount 時 call 一次；點餐介面 / 訂單頁都唔會 call | `device-settings.tsx:277` |
| 全專案**禁 polling**，`online_order_settings` 亦**冇 Realtime 訂閱** → DB 改咗 POS 冇渠道知 | 全專案約定，見 docs/52 |
| GET 用 `.order("updated_at", desc).limit(1)` 而唔係按 PK 搵（似「全店最新一條」嗰隻寫法） | `api/online-order-settings/route.ts:38` |

### 1.3 「POS 撳 → Ledger 顯示」= 寫咗去一個 Ledger 睇唔到嘅地方

`resolveSupabaseUrl()`（`src/lib/supabase-server.ts:5`）= `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`：

- `SUPABASE_URL` = **POS 自有 Supabase**（`.env.example` B 段：「與 Ledger 分開的獨立專案」）
- `NEXT_PUBLIC_SUPABASE_URL` = 前端 Realtime 用（`src/lib/pos/supabase-client.ts:24`）

若 Vercel 有設 `SUPABASE_URL`，張表就寫咗去 POS 自己個 DB，Ledger 完全睇唔到。

> ⚠️ **可疑點（待查 Vercel env）**：`online_order_settings` 呢張表 **macauPosSystem repo 從來冇 migration 建立過**
> （0011 有齊 `pos_*` 全套但冇呢張；`git log -S` 只見 route 引用，未見 `create table`）。
> 若而家寫緊 POS 自有 project，POST 應該 500，而 client `.catch()` 靜默吞咗 → **可能一直寫唔到**。

### 1.4 結論

| 方向 | 現狀 |
|---|---|
| Ledger → POS | ❌ 完全冇（有 GET 但是死 code） |
| POS → Ledger | ❌ 寫去 POS 自己 DB，Ledger 睇唔到 |
| POS 機 ↔ POS 機 | ❌ 每部機各自 localStorage |

---

## 2. 設計目標

1. **單一真源**：`pos_online_order_settings`（**server，按 `store_id`**）。localStorage 降為**離線快取**。
2. **全店一致**：一間店一個開關。任何一部收銀機改 → 其他機**即時**跟住變（Realtime，**唔 polling**）。
3. **POS ↔ Ledger 雙向**：兩邊撳任何一邊，另一邊都跟住郁。
4. **離線優先唔可以甩**：無網絡時用 localStorage 快取繼續運作，復網後以 server 值為準。
5. **防迴圈**：由 Ledger 嚟嘅改動**唔好**再推返去 Ledger（用 `updated_source` 區分）。

---

## 3. 資料模型

### 3.1 新表 `pos_online_order_settings`（migration 0019）

```sql
CREATE TABLE IF NOT EXISTS pos_online_order_settings (
  store_id       text PRIMARY KEY,
  auto_accept    boolean     NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_source text        NOT NULL DEFAULT 'pos'
    CHECK (updated_source IN ('pos', 'ledger')),
  updated_by     text                          -- 店員 id / 'ledger:<user>'，審計用
);
```

| 欄位 | 用途 |
|---|---|
| `store_id` | PK。同 `pos_kiosk_settings.store_id` 同一套 id 空間（`loadAuthSession()?.merchantId`） |
| `auto_accept` | 開關。`false` = 預設（同現有 `defaultPosLocalSettings` 一致） |
| `updated_source` | **防迴圈關鍵**：`pos` = POS 端改（要推去 Ledger）；`ledger` = Ledger 推過嚟（**唔好**再推返去） |
| `updated_by` | 審計：邊個改嘅 |

### 3.2 點解唔重用舊嘅 `online_order_settings`

| 原因 | 說明 |
|---|---|
| 冇 migration | 呢個 repo 從來冇建立過佢，schema 冇版本控制，欄位（`updated_source`）加唔到落去而唔知會唔會爆 |
| 讀法錯 | 現有 GET 用 `.order(updated_at desc).limit(1)`，對一張 PK=store_id 嘅表係錯寫法 |
| 位置不明 | 唔知喺 POS project 定 Ledger project（見 §1.3） |
| 命名唔一致 | 其他 per-store 設定表都叫 `pos_kiosk_settings`，呢張應該叫 `pos_online_order_settings` |

舊表**唔 drop**（可能有其他嘢讀緊），但 `/api/online-order-settings` 之後一律讀寫新表。

### 3.3 RLS（跟 0016 加固模式）

```sql
ALTER TABLE pos_online_order_settings ENABLE ROW LEVEL SECURITY;

-- anon 只留 SELECT（Realtime 要跑 RLS；呢張表無 PII）
CREATE POLICY "pos_online_order_settings anon read" ON pos_online_order_settings
  FOR SELECT TO anon USING (true);

-- 寫入一律 server service_role
CREATE POLICY "pos_online_order_settings service only" ON pos_online_order_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.pos_online_order_settings FROM anon, authenticated;
GRANT  SELECT ON TABLE public.pos_online_order_settings TO anon;
GRANT  ALL    ON TABLE public.pos_online_order_settings TO service_role;
```

### 3.4 Realtime publication

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE pos_online_order_settings;
```

瀏覽器端（`src/lib/pos/use-pos-realtime.ts` 嘅 anon client）訂閱 `postgres_changes`，filter `store_id=eq.<storeId>`。

---

## 4. POS → Ledger（出站）

### 4.1 流程

```
收銀撳掣
  → POST /api/online-order-settings  { storeId, autoAccept }
  → server upsert pos_online_order_settings（updated_source='pos'）
  → server fire-and-forget POST {LEDGER_INTEGRATION_BASE_URL}/api/integration/pos/auto-accept
     （帶店員 Authorization: Bearer）
  → Realtime 廣播 → 其他收銀機即時更新
```

### 4.2 Request（POS server → Ledger）

```http
POST {LEDGER_INTEGRATION_BASE_URL}/api/integration/pos/auto-accept
Authorization: Bearer <店員 ledgerAccessToken>
Content-Type: application/json
Idempotency-Key: <uuid>          ; 建議，防重試重複寫

{
  "storeId": "6d1f...（merchant UUID）",
  "autoAccept": true,
  "updatedAt": "2026-08-31T15:04:05.000Z"
}
```

### 4.3 Response（預期）

```json
{ "ok": true, "autoAccept": true, "updatedAt": "2026-08-31T15:04:05.000Z" }
```

### 4.4 失敗處理

- **唔好**因為 Ledger call 失敗就 rollback POS 嘅改動 —— POS 掣要即刻有反應（樂觀更新）。
- 記 log（server-side），並喺 response 加 `ledgerSynced: false` 畀前端決定係唔係提示。
- 之後靠 **Ledger 嗰邊下次讀取 / 或者 POS 下次改動**自然收斂。

---

## 5. Ledger → POS（入站）

### 5.1 流程

```
Ledger 撳掣
  → POST https://macau-pos-system.vercel.app/api/integration/ledger/auto-accept
     （HMAC 簽名）
  → POS server 驗簽 + 限流
  → upsert pos_online_order_settings（updated_source='ledger'，唔好再推返去 Ledger）
  → Realtime 廣播 → 所有收銀機即時更新
```

### 5.2 Request

```http
POST /api/integration/ledger/auto-accept
Content-Type: application/json
X-Pos-Timestamp: 1756646400          ; Unix seconds
X-Pos-Signature: sha256=<hex>        ; HMAC-SHA256

{
  "storeId": "6d1f...（merchant UUID）",
  "autoAccept": true,
  "updatedBy": "ledger:user-123",
  "eventId": "evt_01J..."            ; 冪等，防重複處理
}
```

### 5.3 簽名（對齊 topUpAutomation webhook 模式）

```
signing_string = X-Pos-Timestamp + "." + raw_body
signature      = HMAC_SHA256(LEDGER_WEBHOOK_SECRET, signing_string)  → hex
```

- Secret：新 env `LEDGER_WEBHOOK_SECRET`（POS 同 Ledger 各存一份，server-only，**絕不加 `NEXT_PUBLIC_`**）。
- 時間窗：`|now - X-Pos-Timestamp| <= 300s`，過期直接 401。
- 比對用 `crypto.timingSafeEqual`（防 timing attack）。
- 限流：同 `/api/ledger/ensure-customer`（30 次 / 15 分鐘 / 店 / IP）。

### 5.4 Response

```json
{ "ok": true, "autoAccept": true, "updatedAt": "..." }
```

| HTTP | 情況 |
|---|---|
| 200 | 成功（冪等重複都返 200） |
| 400 | body 唔啱 / storeId 缺失 |
| 401 | 缺簽名 / 簽名錯 / timestamp 過期 |
| 503 | Supabase 未配置 |

---

## 6. 前端改動

### 6.1 新 hook `useOnlineOrderSettings(storeId)`

```
1. 初值 = localStorage 快取（離線優先，唔會白屏）
2. mount → GET /api/online-order-settings?storeId=...  → server 值覆蓋快取（server 權威）
3. 訂閱 Realtime（filter store_id=eq.<storeId>）→ 收到 UPDATE 就更新 state + 寫快取
4. setter = 樂觀更新 → POST → 失敗 rollback + 顯示錯誤
```

### 6.2 要改嘅 call site

| 檔案 | 而家 | 改成 |
|---|---|---|
| `src/components/online-orders.tsx:67` | `localSettings.onlineOrderSettings.autoAccept` | `useOnlineOrderSettings()` |
| `src/components/pos-app.tsx:885` | `localSettings.onlineOrderSettings.autoAccept` | `useOnlineOrderSettings()` |
| `src/components/device-settings.tsx:277-325` | 死 code GET（每分支都 `return current`） | **刪掉**，改用同一個 hook |

### 6.3 localStorage 角色降級

`PosLocalSettings.onlineOrderSettings.autoAccept` **保留**（schema 唔改，避免 migration），
但語意由「真源」改為「**離線快取**」：

- 冇網絡 / server 未配置 → 用快取值繼續運作
- 一讀到 server 值 → 快取被覆蓋
- 改值 → 寫快取 + POST（server 成功與否，快取都反映用家意圖，失敗先 rollback）

---

## 7. Ledger 嗰邊要做嘅部分（要交畀佢哋）

> 呢份係**對外契約**，可以直接畀 Ledger 團隊。POS 呢半邊做完之後，
> Ledger 未配合嘅話，效果會係「POS 改 → Ledger 唔變；Ledger 改 → POS 唔變」（即維持現狀），**唔會爆**。

1. **出**：喺佢哋粒「自動接單」掣改動時，call `POST https://macau-pos-system.vercel.app/api/integration/ledger/auto-accept`（§5 簽名規格）。
2. **入**：開 `POST {LEDGER}/api/integration/pos/auto-accept`（§4 規格），認 POS 店員嘅 `Authorization: Bearer`。
3. **共享 secret**：同 POS 夾一支 `LEDGER_WEBHOOK_SECRET`（只放 server env）。
4. **storeId 對齊**：POS 用嘅係 `loadAuthSession()?.merchantId`（同 Ledger 共用 Auth 嘅 merchant UUID），要確認佢哋嗰邊用同一個 id。

---

## 8. 環境變數

| 變數 | 狀態 | 用途 |
|---|---|---|
| `LEDGER_INTEGRATION_BASE_URL` | **已有**（預設 UAT） | POS → Ledger 出站 base URL |
| `LEDGER_WEBHOOK_SECRET` | **新增** | Ledger → POS 入站 HMAC 簽名 secret |

---

## 9. 檔案清單

| 檔案 | 動作 |
|---|---|
| `supabase/migrations/0019_pos_online_order_settings.sql` | 新增 |
| `src/app/api/online-order-settings/route.ts` | 改（讀寫新表 + 出站推 Ledger） |
| `src/app/api/integration/ledger/auto-accept/route.ts` | 新增（入站 webhook） |
| `src/lib/pos/online-order-settings.ts` | 新增（client helper + hook） |
| `src/lib/pos/use-pos-realtime.ts` | 改（加訂閱 `pos_online_order_settings`） |
| `src/components/online-orders.tsx` | 改（用 hook） |
| `src/components/pos-app.tsx` | 改（用 hook） |
| `src/components/device-settings.tsx` | 改（刪死 code GET） |
| `.env.example` | 改（加 `LEDGER_WEBHOOK_SECRET`） |

---

## 10. 驗收

1. **POS → Ledger**：POS 撳開 → `pos_online_order_settings.auto_accept=true`、`updated_source='pos'` → Ledger 收到 call。
2. **Ledger → POS**：用 §5 簽名 curl 打入站 → 表變 `true`、`updated_source='ledger'` → **開住 POS 嘅收銀機畫面 3 秒內掣變「開」**（Realtime，無 refresh）。
3. **全店一致**：開兩部機，A 機撳 → B 機即時跟住變。
4. **防迴圈**：Ledger 推入嚟之後，network log 入面**唔應該**見到 POS 再 call 出去 Ledger。
5. **離線**：斷網 → 掣仍然撳得（快取）；復網 → 以 server 值為準。
6. **驗簽**：改一個 byte 嘅 body / 過期 timestamp → 401。
7. **RLS**：用 anon key 打 PostgREST 做 INSERT/UPDATE → 必須失敗（0016 §5.2 驗收）。

---

## 11. 範圍外（本輪唔做）

- 舊表 `online_order_settings` 嘅資料搬遷 / drop（唔知有冇人讀緊）
- 自助點餐（線下）嗰粒「自動接自助單」嘅 Ledger 同步 —— 嗰粒係 POS 內部設定（`pos_kiosk_settings`），Ledger 冇對應掣
- 每部機可以有唔同設定嘅訴求（已決定改做全店共用）
