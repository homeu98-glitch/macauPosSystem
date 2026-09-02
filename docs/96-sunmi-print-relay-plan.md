# 96 · Sunmi 打印中繼機（Relay APK）方案

> **日期**：2026-09-02
> **性質**：架構設計 + 實作規格（**只寫文檔，未動代碼**）
> **背景**：iPad 用 Safari 跑 macau-pos（HTTPS，Vercel），要出單去店內 **LAN ESC/POS 打印機**。
> iPad 喺瀏覽器沙盒入面冇法直連區網（詳細查證見 §1.2），所以一定要有中繼。
> **決定**：另外開發一隻 **Sunmi 中繼 APK**（**唔包 macau-pos UI、唔係 WebView 殼**），
> iPad 經 Supabase 落單 → Sunmi 拎單 → 打去 LAN 打印機 / Sunmi 內置打印機。
> **配套**：[`docs/46`](./46-cloud-print-relay-spec.md)（協議定稿）、[`docs/43`](./43-cross-platform-print-dual-path.md)（雙路徑）、[`docs/95`](./95-receipt-print-fix.md)（三倉 renderer 合約）

---

## 0. 一句講晒

**唔使由零寫**。核心基建（`pos_print_jobs` 表 + realtime publication + sync 上傳 + ESC/POS renderer）**已經喺度**。
本方案只係加三件嘢：① 補幾個欄位嘅 migration ② web 加一個 `RelayPrintTransport` ③ **喺 `print-agent-android` repo 開一個新 app module**，復用現有 renderer，換走「WebView bridge 輸入」改做「Supabase Realtime 輸入」。

---

## 1. 背景與約束

### 1.1 角色定義

| 角色 | 設備 | 職責 | 狀態 |
|---|---|---|---|
| **Terminal**（終端） | iPad（Safari）/ 現有 Android APK / 桌面 Companion | 跑 POS、建 `PrintJob`、上傳、等 result | iPad 係**其中一個選項**，唔係唯一 |
| **Relay**（中繼） | **Sunmi 設備**（本方案主體） | 拎單 → 渲染 → 打去 LAN 打印機 / 內置打印機 → 回報 result | **新開發** |
| **打印機** | LAN `:9100` ESC/POS ／ Sunmi 內置 | — | — |

> ⚠️ **Sunmi 唔係用嚟跑 macau-pos**。佢係純中繼機，界面得「配對 + 狀態 + 打印機管理」，唔會載入 POS 網站。

### 1.2 點解 iPad 一定要經中繼（2026-09-01 已查證）

| 限制 | 結果 |
|---|---|
| iOS Safari 冇 raw TCP / WebUSB / Web Bluetooth | 打唔到 `LAN:9100`、USB、藍牙機 |
| HTTPS 頁 `fetch("http://192.168.x.x/...")` = **active mixed content** | 一律 block |
| **host 係 IP literal 嘅「可升級內容」（`<img>`）亦直接 block**（MDN 明文） | `LanHttpServer.kt` 嘅 `/beacon` 1x1 PNG 偷渡 **喺 Vercel HTTPS 頁上面無效** |
| Chrome PNA（公網 https → 區網 IP 要 preflight） | 官方 rollout **暫停中**，但政策會收緊，唔可以依賴 |
| 唯一例外：top-level navigation 唔算 mixed content | `window.open("http://192.168.x.x/print")` 通到，但要彈新 tab，UX 唔可用 |

**⇒ iPad 喺瀏覽器入面唯一出到去嘅窗，就係 HTTPS 出公網。**

### 1.3 點解揀 Supabase 而唔係自建 Node WSS

`docs/46 §2` 原本建議自建 Node WSS（Railway / Render / Fly）。本方案**改行 Supabase Realtime**：

- 項目**已經有** Supabase，唔使新 server、新 hosting、新 cert、新 port forwarding
- `docs/46 §2` 自己都列咗 Vercel serverless **唔適合長連 WSS**（冷啟 + 10s timeout）→ 唔考慮
- 中繼機係**主動出站**連去 Supabase → 唔使公網 IP
- `store_id` filter 天然跨店隔離

---

## 2. 架構總覽

```
   iPad（Safari，HTTPS，macau-pos）
        │
        │ ① POST /api/pos/sync  PRINT_JOB_CREATED   ← 已存在
        ▼
  ┌──────────────────────────────┐
  │ pos_print_jobs（Supabase）    │  ← 已存在，已入 supabase_realtime publication
  │ + migration 0020 加欄位      │
  └──────────────────────────────┘
        │ ② postgres_changes INSERT（filter store_id=eq.<storeId>）  ← 只係「叫醒」訊號
        ▼
  ┌──────────────────────────────┐
  │ Sunmi 中繼 APK（新建）        │
  │  · Realtime 訂閱 = 叫醒       │
  │  · claim RPC    = 權威拎單    │  ← for update skip locked，防重複打印
  │  · EscPosRenderer            │  ← 復用現有，出紙 byte-for-byte 一致
  └──────────────────────────────┘
        │ ③ raw socket / Sunmi AIDL
        ▼
   LAN 打印機 :9100   ／   Sunmi 內置打印機
        │
        │ ④ POST /api/pos/print-agent/result
        ▼
  pos_print_jobs.status = sent / failed
        │ ⑤ postgres_changes UPDATE（iPad 已訂閱）
        ▼
   iPad 更新本地 PrintJob 狀態（重印 / 失敗提示）
```

### 2.1 關鍵設計：Realtime 只係「叫醒」，claim RPC 先係權威

Supabase Realtime **postgres_changes payload 上限 1,024 KB**；**超標時 `new`/`old` 只會帶每個 ≤64 bytes 嘅欄位**（[官方 limits](https://supabase.com/docs/guides/realtime/limits)）。
即係話：`template` / `items` / `content` 呢啲 jsonb 欄，**一旦單據大到超標就會被剝走**。

所以：

- **Realtime INSERT 事件 = 純粹「有單到，起身做嘢」嘅訊號**，APK **唔可以**直接攞 event payload 去印
- **收到訊號 → call `pos_claim_print_jobs()` RPC** 由 Postgres 攞完整 row（普通 DB 讀，無 realtime 上限）
- 就算 Realtime 斷線 / 事件遺失 / payload 被截，都有一個 **60s 對賬 tick** 兜底

呢個設計同時解決三件事：**payload 截斷**、**event 遺失**、**多機爭奪**。

---

## 3. 點解唔係「由零寫一隻新 APK」

`docs/95` 定咗 **三倉 renderer 合約**：「設計介面 == 螢幕預覽 == 實際出紙」。
血案記錄：web 算好 `price` 傳落嚟，但 Android / Companion 兩個 renderer 冇讀 → **收據印唔出價錢**，改咗幾次都唔得。

如果由零寫一隻 APK，就要**第四個 renderer**，重新踩一次同一堆坑：

- ESC/POS 放大真相表（`ESC !` 淨管 ASCII、`FS !` 淨管 Kanji、`GS !` 管晒）— docs/81
- 中文 2 格 / ASCII 1 格嘅 `displayWidth()` padding
- 反白 `ESC { n` 表達強調，且**唔包 LF**
- QR 用 `GS v 0` 點陣，印圖前要 `resetMagnify()`
- 規格行加購價錢要靠右（`splitSpecLine()`）
- 單品折扣 saving = `原價 × (100 - rate) / 100`（**唔係** `× rate / 100`）
- Kotlin `Double.toString()` 出 `"30.0"` vs JS `"30"` → 要 `num()`

**⇒ 建議：喺 `C:\dev\print-agent-android` repo **開一個新 app module**（或 product flavor），
直接復用 `net/`、`model/`、`hub/` 大部份碼，只換輸入層 + UI。** 呢個先係「另外一隻 APK」嘅低風險做法。

---

## 4. 現有基建盤點（慳咗幾多）

### 4.1 已經有（macauPosSystem）

| 嘢 | 位置 |
|---|---|
| `pos_print_jobs` 表（`id` PK、`store_id`、`items` jsonb、`template`、`content`、`printer_id`） | `supabase/migrations/0011` + `0015` |
| 已加入 `supabase_realtime` publication | `0011` |
| RLS：anon SELECT（14 日窗）、service_role 全權 | `0016` |
| `PRINT_JOB_CREATED` 上傳（`pos-app.tsx` → sync queue → `/api/pos/sync` → `pos_print_jobs` upsert） | `src/app/api/pos/sync/route.ts:282` |
| 收銀側 Realtime 訂閱 `pos_print_jobs`（filter `store_id`） | `src/lib/pos/use-pos-realtime.ts` |
| 列模型 `PrintJob` / `PrintTransport` / `PrintSendResult` | `src/lib/types.ts:599-693` |
| `PrintTransport` 三通道派發（native / companion / relay） | `src/lib/print-bridge/dispatch.ts` |
| `relay-transport.ts` 骨架（**未接入 dispatch**） | `src/lib/print-bridge/relay-transport.ts` |

### 4.2 已經有（print-agent-android）

| 嘢 | 位置 |
|---|---|
| `PrintJobDto.fromJson()` — 食 web `PrintJob` JSON | `model/PrintDtos.kt` |
| `PrinterCfgDto.resolve()` — 搵目標打印機 | `model/PrintDtos.kt` |
| `EscPosRenderer.renderTemplateTicket(job, cfg)` — **主入口** | `net/EscPosRenderer.kt:366` |
| `SdkPrinter.print()` — 經 `net.posprinter` AAR 連 **ETHERNET / USB / BT**，info 格式 ETHERNET=`"ip,port"` | `net/SdkPrinter.kt` |
| `EscPosPrinter.printRaw(ip, port, bytes)` — 裸 socket 後備路 | `net/EscPosPrinter.kt` |
| `PrinterHub`、`LanScanner`（搵自己 IP / 網段）、`DeviceStore`（打印機持久化） | `hub/`、`data/` |
| foreground service + `START_STICKY` 寫法 | `hub/PrintHubService.kt` |

### 4.3 缺乜

| 缺 | 點補 |
|---|---|
| `pos_print_jobs` 冇 `printer`（打印機 config）、`kind`、`qr`、`copies`、`storeName`、`ttl` | **migration 0020** |
| 冇「原子拎單」機制 | **新增 RPC `pos_claim_print_jobs()`** |
| APK 冇 Supabase 連線 | 新增 realtime client |
| 冇配對 / agent token | 新增 `pos_print_agents` 表 + 配對流程 |
| web 冇 relay transport | 新增 `RealtimePrintTransport`，接入 `dispatch.ts` |

---

## 5. 資料模型改動

### 5.1 migration `0020_print_relay.sql`

```sql
-- ── A. pos_print_jobs 加欄位 ───────────────────────────────
alter table public.pos_print_jobs
  add column if not exists printer        jsonb,      -- 完整 DevicePrinterConfig（ip/lanPort/charset/kanjiEnlarge/lineSpacing/copies）
  add column if not exists kind           text,       -- receipt|kitchen|label|test
  add column if not exists store_name     text,
  add column if not exists payment_method text,
  add column if not exists total          numeric,
  add column if not exists qr             jsonb,      -- {size, bits}
  add column if not exists qr_url         text,
  add column if not exists copies         int,
  add column if not exists ttl            bigint,     -- epoch millis
  add column if not exists updated_at     timestamptz,
  add column if not exists claimed_by     text,
  add column if not exists claimed_at     timestamptz,
  add column if not exists attempts       int default 0,
  add column if not exists last_error     text,
  add column if not exists finished_at    timestamptz;

create index if not exists pos_print_jobs_queue_idx
  on public.pos_print_jobs (store_id, status, created_at);

-- ── B. 中繼機登記 ──────────────────────────────────────────
create table if not exists public.pos_print_agents (
  agent_id     text primary key,
  store_id     text not null,
  name         text,
  token_hash   text not null,          -- 只存 hash，明文 token 只交付一次
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists pos_print_agents_store_idx
  on public.pos_print_agents (store_id);

alter table public.pos_print_agents enable row level security;
revoke all on table public.pos_print_agents from anon, authenticated;
grant all on table public.pos_print_agents to service_role;
drop policy if exists "pos_print_agents service only" on public.pos_print_agents;
create policy "pos_print_agents service only"
  on public.pos_print_agents for all to service_role using (true) with check (true);

-- ── C. 原子拎單（防重複打印）────────────────────────────────
create or replace function public.pos_claim_print_jobs(
  p_store_id text,
  p_agent_id text,
  p_limit    int default 5
)
returns setof public.pos_print_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select j.id
      from public.pos_print_jobs j
     where j.store_id = p_store_id
       and j.status in ('pending', 'failed')
       and coalesce(j.attempts, 0) < 5
       and (j.ttl is null or j.ttl > (extract(epoch from now()) * 1000)::bigint)
       and (j.claimed_by is null or j.claimed_at < now() - interval '60 seconds')
     order by j.created_at
     for update skip locked
     limit greatest(p_limit, 1)
  )
  update public.pos_print_jobs j
     set claimed_by  = p_agent_id,
         claimed_at  = now(),
         status      = 'printing',
         attempts    = coalesce(j.attempts, 0) + 1,
         updated_at  = now()
    from picked p
   where j.id = p.id
  returning j.*;
end;
$$;

revoke all on function public.pos_claim_print_jobs(text, text, int) from public, anon;
grant execute on function public.pos_claim_print_jobs(text, text, int) to service_role;
```

> **點解一定要 `for update skip locked`**：兩部 Sunmi 同時收到 INSERT 事件時，
> 第一個拎走並鎖住，第二個直接 skip → **物理上唔可能重複打印**。
> `attempts < 5` 對齊現有 `MAX_SYNC_ATTEMPTS=5` 嘅「失敗留底」語義。

> ⚠️ **寫咗 migration ≠ 跑咗 migration**（已踩兩次：0018、0019）。
> 本機冇 `.env.local`／DB 連線／`supabase/config.toml` → `supabase db push` 跑唔到，
> **要人手去 Supabase Dashboard SQL Editor 貼**，貼完要用 curl 打 production API 驗證。

### 5.2 狀態機

```
pending ──claim RPC──> printing ──result ok──> sent
                            │
                            └──result fail / timeout──> failed ──（attempts<5）──> pending
```

---

## 6. Web 側改動（macauPosSystem）

### 6.1 擴 sync payload（`src/app/api/pos/sync/route.ts:282`）

而家只傳 11 欄。要加：

```
printer, kind, store_name, payment_method, total, qr, qr_url, copies, ttl
```

> `printer` = `resolveJobPrinter(job)` 嘅完整 `DevicePrinterConfig`（現有 `dispatch.ts` 已經咁做畀 companion）。

### 6.2 新 `RealtimePrintTransport`（`src/lib/print-bridge/`）

對齊現有 `PrintTransport` 接口（見 `src/lib/types.ts:686`）：

```ts
class RealtimePrintTransport implements PrintTransport {
  supports() { return true; }            // 中繼乜機都印到
  async send(job, printer, opts) {
    // 1) 確保 job 已上傳（sync queue 會做；呢度標住等緊邊個 jobId）
    // 2) 訂閱 pos_print_jobs 嘅 UPDATE，等 status 離開 printing
    // 3) 有結果 → resolve { ok, ticketId, code, error }
    // 4) 超時（job.ttl ?? 60s）→ resolve { ok:false, code:'RELAY_TIMEOUT' }
  }
}
```

### 6.3 接入 `dispatch.ts`

通道優先級改為：

1. **native bridge**（Android APK WebView — 終端自己係 Android 時最快）
2. **桌面 Companion**（localhost HTTP）
3. **Relay（Supabase → Sunmi）** ← 新，取代現有未接線嘅 `relay-transport.ts`

> 保持「冇通道就維持 pending」，等店主配對完 Sunmi 自動重試（對齊現有 `dispatch.ts` 行為）。

### 6.4 `mapPosPrintJobRow` 補新欄（`src/lib/pos/pos-order-mapper.ts`）

補 `qr` / `qrUrl` / `copies` / `ttl` / `printer` / `kind`，等第二部機同步返嚟都唔會甩。

---

## 7. Sunmi APK 側改動（print-agent-android）

### 7.1 新 module / flavor

```
print-agent-android/
  app/                    ← 現有：WebView 殼 + LAN HTTP hub（唔改）
  relay/                  ← 新：Sunmi 中繼 APK
    src/main/java/com/macau/pos/relay/
      RelayService.kt       foreground service，常駐
      JobListener.kt        Supabase Realtime 訂閱（叫醒）
      JobClaimer.kt         call pos_claim_print_jobs RPC
      ResultReporter.kt     POST /api/pos/print-agent/result
      PairingStore.kt       EncryptedSharedPreferences 存 agentId / token
      ui/                   配對 QR + 狀態 + 打印機管理（極簡）
  共用：net/ model/ hub/PrinterHub.kt（抽出做 :core module）
```

### 7.2 主流程（復用現有 code）

```
收到叫醒訊號
  └─> JobClaimer.claim()                       // POST /api/pos/print-agent/claim
        └─> RPC pos_claim_print_jobs           // 原子拎單，攞完整 row
              └─> PrintJobDto.fromJson(row)    // 復用
              └─> PrinterCfgDto.resolve(...)   // 復用
              └─> EscPosRenderer.renderTemplateTicket(job, cfg)   // 復用，byte-for-byte
              └─> 輸出：
                    connectionType=lan  → SdkPrinter（AAR ETHERNET，"ip,port"）
                                        或 EscPosPrinter.printRaw 後備
                    Sunmi 內置           → SunmiPrinterService AIDL sendRawData(bytes)
              └─> 份數：job.copies ?? printer.copies ?? 1（對齊 dispatch.ts）
                    └─> ResultReporter.report(ok / code / error)
```

### 7.3 點解出紙會同而家一模一樣

**同一個 `EscPosRenderer.renderTemplateTicket()`**，輸入同一個 `PrintJob` JSON。
所以而家 macau-pos 有嘅功能全部原樣過渡：

收據 / 廚房單 / 標籤單 / 測試頁 · 模板字型大小粗細對齊 · 分區打印機 · 份數 ·
QR · 折扣與反白 · 規格行加購價錢靠右 · 時價菜 · 備註 · 重印 · 失敗提示

### 7.4 Sunmi 內置打印機（可選輸出目標）

商米內置打印服務支援 **AIDL / 藍牙 / JS 橋** 三種接法（[官方文件](https://developer.sunmi.com/zh-CN/ability/print-service/)）。
原生 APK 用 **AIDL**：bind `SunmiPrinterService` → `ISunmiPrinterService.sendRawData(escPosBytes)`。

> 因為我哋自己 `EscPosRenderer` 已經產好完整 ESC/POS byte[]，
> 所以**淨用 `sendRawData()` 一個 API 就夠**，唔使學商米嘅高階排版 API。

⚠️ 要另外引入商米 SDK（`printerlibrary` AAR 或 AIDL jar）。
⚠️ sandbox build 係 `./gradlew assembleDebug --offline`（gradle cache 喺 `~/.gradle`）→ **加新依賴要先用一次 online build 預熱 cache**。

---

## 8. 配對流程（**2026-09-02 已定案 + APK 已實作，web 端要跟呢份**）

目標：**token 唔好明文落地喺任何 anon 可讀嘅表**，而且 Sunmi **唔使有相機**。

### 8.0 點解唔用原本諗嘅 Realtime broadcast

初版設計係「APK 訂閱 `pair:<agentId>` broadcast channel，iPad POST 之後 server 推 token 落去」。
**做唔到**：APK 喺配對完成前根本冇 `supabaseUrl` / `anonKey`，訂閱唔到 Realtime。
先經 Vercel HTTP 攞呢兩樣嘢、再訂閱，等於要兩段式握手，複雜度唔抵。

改做 **HTTP 短輪詢**：APK 每 3s 打一次 `GET /pair?agentId=`（得配對嗰陣先至打，
配到就停），server 唔使維持任何狀態，APK 唔使任何憑證。

> 🔄 **2026-09-02 再改**：下面 §8 嘅 QR 流程已被 **Android Hub 自註冊**取代（QR 需要相機 +
> 要人手對位，Hub 裝喺收銀枱底根本唔方便掃）。而家嘅流程係 Hub 直接打 `/pair`，
> iPad 端**只剩「檢查配對狀態」一個掣**。QR 流程留底做歷史記錄。

```
1. APK 首次啟動（或者撳「重新產生配對碼」）
     agentId = "ag-" + 16 bytes hex
     token   = 32 bytes hex（長期，用家明確要求）
     畫面顯示 QR：「MPA1|<agentId>|<token>」
     開始 GET /api/pos/print-agent/pair?agentId=<id>（每 3s）

2. iPad（已登入、有 store session）
     用現有 loadJsQr() 掃 QR（復用 Companion 配對嘅掃描 UX）
     POST /api/pos/print-agent/pair  { agentId, token, storeId, name? }
       · server 用 service_role 驗 store session 對唔對到 storeId
       · token_hash = sha256(token)
       · upsert pos_print_agents(agent_id, store_id, token_hash, name, created_at)
       · 回 { ok: true }

3. APK 下一次輪詢
     server 見到 pos_print_agents 有呢條（revoked_at is null）
     → 回 { status:"paired", storeId, storeName, supabaseUrl, anonKey }
     APK 存落 SharedPreferences，訂閱 Realtime，開始 claim 迴圈
```

### 8.0.1 現行流程：Android Hub 自註冊（**呢個先係而家行緊嗰條**）

```
1. 用戶喺 Android Hub 輸入 POS 登入號碼（8 位電話 + 4 位 PIN）
     POST /api/ledger/login { phone, pin }
     ← { ok: true, session: { merchantId: "<merchants.id UUID>", ... } }

2. Hub 用嗰個 merchantId 做 storeId 自註冊
     agentId = "ag-" + 16 bytes hex（首次產生，之後存 SharedPreferences）
     token   = 32 bytes hex
     POST /api/pos/print-agent/pair { agentId, token, storeId: merchantId, name? }
       · server 擋假店（黑名單 + 查 merchants 表驗真）
       · token_hash = sha256(token)
       · upsert pos_print_agents(...)
     ← { ok: true }

3. Hub 輪詢 GET /api/pos/print-agent/pair?agentId=<id>
     ← { status:"paired", storeId, storeName, supabaseUrl, anonKey }
     Hub 存落 SharedPreferences，訂閱 Realtime，開始 claim 迴圈

4. iPad（web POS，已登入同一個 POS 號碼）
     「設置 → 打印機 → 雲端列印中繼」撳「檢查配對狀態」
     GET /api/pos/print-agent/pair-status?storeId=<loadAuthSession().merchantId>
     ← { paired: true, agentId, storeId, storeName }
     → 寫落 localStorage，isRelayConfigured() 變 true，dispatch 通道③ 啟用
```

**點解 web 端唔使輸入任何嘢**：Hub 同 web 用**同一組**憑證打**同一條** `/api/ledger/login`，
拎到**同一個** `merchantId`。所以 `storeId` 係由登入身份隱含推導，唔係用戶要填嘅資料。
web 端舊版嗰個「本店店舖 ID（輸入 Android 中繼機用）」欄位已喺 2026-09-02 移除。

- token 只出現在：`POST /pair` 嘅 request body（HTTPS）、
  Hub 嘅 SharedPreferences（app sandbox）。**server 淨存 sha256**。
- server 每次驗 `sha256(x-agent-token)` 對 `token_hash` + `store_id` 一致 + `revoked_at is null`
- 後台可以 revoke agent（寫 `revoked_at`）→ APK 下一輪 heartbeat 會收到 401，返去配對畫面

> ⚠️ 風險：QR 明文帶 token。缓解：QR 只出現喺店內部機螢幕、掃完就應該收埋，
> 而且**淨係拎到 token 都無用** —— 完成配對一定要已登入嘅 store session。
> 若要再收緊（例如擔心被影相），可以改做「QR 淨帶 agentId + 6 位一次性 code，
> code 由 server 產生並用 broadcast 推落 APK 核對」，但要先解決 8.0 嘅握手問題。

### 8.1 API routes（Vercel，全部 service_role）— **APK 客戶端合約**

APK 實作位置：`C:\dev\print-agent-android\app\src\main\java\com\macau\pos\printagent\relay\RelayApi.kt`

#### `GET /api/pos/print-agent/pair?agentId=<id>`

| 情況 | Response |
|---|---|
| 未配對 | `{ "status": "pending" }` |
| 已配對 | `{ "status": "paired", "storeId": "...", "storeName": "...", "supabaseUrl": "https://xxx.supabase.co", "anonKey": "eyJ..." }` |

> `supabaseUrl` / `anonKey` 由 server 落而**唔係** APK hardcode —— 換環境唔使改 APK。

#### `POST /api/pos/print-agent/pair`（Android Hub 自註冊）

> **2026-09-02 更新**：配對流程已由「iPad 掃 QR 發起」改為 **Android Hub 自註冊**。
> Hub 先用 POS 登入號碼（8 位電話 + 4 位 PIN）打 `/api/ledger/login` 拎 `merchantId`，
> 再用嗰個 `merchantId` 做 `storeId` 打呢條 route。即係 **storeId 由登入身份隱含推導**，
> 用戶完全唔使輸入任何店舖 ID。

Request：
```json
{
  "agentId": "ag-...",
  "token": "<64 hex>",
  "storeId": "<merchants.id UUID — 由 /api/ledger/login 拎返嚟>",
  "name": "收銀旁 Print Hub"
}
```
Response：`{ "ok": true }` / `{ "ok": false, "error": "..." }`

> ⚠️ **`storeId` 唔可以係 `macau-store-a` 呢類 mock 值。**
> `macau-store-a` 係 admin 帳號系統（`docs/sql/admin-account-schema.sql`）嘅示範店代碼，
> **同 `merchants.id` 係兩套嘢**。配對用錯會出現最難 debug 嘅 silent failure：
> `/pair-status` 話「已配對」，但 Realtime filter `store_id=eq.<真 UUID>` 唔 match、
> `pos_claim_print_jobs()` 返 0 列 → **一張單都印唔出**。
> server 現時會擋：① 假店黑名單 ② 查 `merchants` 表驗真（表讀唔到嘅基建錯誤會 warn 放行）。

#### `POST /api/pos/print-agent/claim`

Headers：`x-agent-id: <agentId>`、`x-agent-token: <token>`、`Content-Type: application/json`

Request：`{ "agentId": "...", "storeId": "...", "limit": 5 }`

Response：
```json
{
  "ok": true,
  "jobs": [ { /* pos_print_jobs 全行，snake_case */ } ],
  "printers": [ { /* 該店 DevicePrinterConfig 陣列，可選 */ } ]
}
```

Server 實作：`select * from pos_claim_print_jobs(storeId, agentId, limit)`
（RPC 已內含 `for update skip locked` + 寫 `claimed_by/claimed_at/status='printing'/attempts+1`）

#### `POST /api/pos/print-agent/result`

Request：`{ "agentId": "...", "jobId": "...", "status": "sent" | "failed", "error": "..." }`
Response：`{ "ok": true }`

Server 實作：
- `sent`   → `status='sent'`, `finished_at=now()`, `last_error=null`
- `failed` → `status = case when attempts < 5 then 'pending' else 'failed' end`, `last_error=<error>`

#### `POST /api/pos/print-agent/heartbeat`

Request：
```json
{ "agentId": "...", "storeId": "...", "sunmiReady": true, "sunmiModal": "Sunmi V2",
  "printedCount": 12, "failedCount": 0, "realtimeConnected": true,
  "appVersion": "1.1.0", "versionCode": 5,
  "deviceModel": "Sunmi V2", "androidSdk": 25 }
```
Response：`{ "ok": true, "serverTime": 1756... }`（`serverTime` 係 epoch millis，畀 APK 對時）

Server 實作：`update pos_print_agents set last_seen_at = now() where agent_id = ...`
（token 驗唔過 → HTTP 401，APK 會清配對返去配對畫面）

---

## 9. 可靠性設計

| 情況 | 處理 |
|---|---|
| **兩部 Sunmi 同時拎同一單** | `for update skip locked` → 物理上淨一個拎到 |
| **Realtime 事件遺失** | 60s 對賬 tick 主動 claim 一次 |
| **>Realtime payload 被截（>1MB）** | 唔影響：claim RPC 由 DB 直接攞完整 row |
| **打印機冇反應 / 離線** | socket timeout 4s（現有 `EscPosPrinter` 默認）→ 回報 `failed` → `attempts<5` 自動重排 |
| **TTL 過期** | RPC 層 `ttl > now()` 過濾；過期單唔會出（防「半個鐘前嘅單突然印出嚟」） |
| **iPad 收唔到 result** | 本地 `PrintJob` 維持 `pending`，下次 flush 再問一次；job id 係 PK，upsert 冪等 → 唔會重複印 |
| **RPC 連續失敗** | `attempts >= 5` 後唔再排隊，留底等人工（對齊現有 `MAX_SYNC_ATTEMPTS=5`） |
| **Sunmi 斷網** | 心跳停 → 後台顯示「中繼離線」；iPad 維持 pending，恢復後自動繼續 |

### 9.1 ⚠️ Android 常開機嘅坑（做中繼必須處理）

`PrintHubService` 已經係 foreground service + `START_STICKY`，但要再加：

- **電池優化白名單**（Doze 會 cut network）→ 首次啟動引導用戶關 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
- **廠商自啟管理**（小米 / 華為 / Oppo 會殺後台）→ 設定頁放圖文引導；**Sunmi 係自家 ROM，通常冇呢個問題，反而係用 Sunmi 嘅一個實際好處**
- **息屏斷網** → `WifiManager.WifiLock`（`WIFI_MODE_FULL_HIGH_PERF`）
- **開機自動啟動** → `BOOT_COMPLETED` receiver（Sunmi 亦支援系統層設定開機啟動 app）
- **網絡切換**（WiFi ↔ 4G）→ Realtime 自動重連 + 重連後立即 claim 一次

---

## 10. ⚠️ Sunmi 硬件待確認（會影響實作）

| 要確認 | 點解重要 |
|---|---|
| **具體型號**（T2s / T3 / V2s / D3 …） | 決定 Android 版本、有冇內置打印機、有冇相機、有冇以太網口 |
| **Android 版本** | 現有 `minSdk = 26`（Android 8）。部分 Sunmi 係 Android 7.1（API 25）甚至更舊 → **可能要降 minSdk** |
| **內置打印機係咪要用** | 要 → 引入商米 AIDL SDK；唔要 → 淨用 LAN `:9100`，零新依賴 |
| **有冇以太網口 / 只 WiFi** | 中繼機建議**插網線**，穩定過 WiFi |

---

## 11. 分階段落地

| Phase | 內容 | 產出 |
|---|---|---|
| **P0** | 確認 Sunmi 型號 / Android 版本 / 係唔係要用內置打印機 | 決策記錄 |
| **P1** | migration 0020（欄位 + `pos_print_agents` + claim RPC）+ 人手去 Dashboard 跑 + curl 驗證 | DB 就緒 |
| **P2** | 4 條 `/api/pos/print-agent/*` route（service_role） | API 就緒 |
| **P3** | web：擴 sync payload + `RealtimePrintTransport` + 接入 `dispatch.ts` + 配對 UI（掃 QR） | iPad 端就緒 |
| **P4** | APK：抽 `:core` module + 新 `:relay` module（Realtime 訂閱 + claim + 渲染 + 輸出 + 回報） | APK 可跑 |
| **P5** | 可靠性：對賬 tick、心跳、重連、電池優化引導、開機自啟、後台「中繼在線」狀態 | 可上線 |
| **P6** | 實機驗收：iPad → Sunmi → LAN 打印機，逐項對照 §7.3 功能清單 | 驗收報告 |

> **P4 一定要 bump `versionCode` / `versionName`**（source 改咗唔等於生效，要 rebuild APK + 重新派版）。

---

## 12. 風險與待決策

### 12.1 風險

| 風險 | 級別 | 緩解 |
|---|---|---|
| 打印延遲（多一程雲） | 中 | 實測目標 < 1.5s（Realtime 推送即時，淨加一次 RPC round-trip）；若嫌慢可加 Supabase Edge Function 近場 |
| 依賴網絡：Supabase / 互聯網斷 → 印唔到 | **高** | 店內 WiFi 斷就全死。建議 **Sunmi 插網線**；長遠可保留「終端本身係 Android 就走 native bridge」做雙路徑（對齊 docs/43） |
| 雲端單據內容外露 | 中 | `pos_print_jobs` 已有 anon SELECT（14 日窗），屬既有風險，0016 已列 TODO；中繼只係多一個讀者 |
| 商米 SDK 引入困難 / 冇網絡預熱 gradle cache | 低 | 若唔用內置打印機，完全唔使引入 |

### 12.2 待決策（要用戶拍板）

1. **Sunmi 型號 / Android 版本**？（決定 `minSdk`，見 §10）
2. **要用 Sunmi 內置打印機，定係淨用 LAN `:9100`**？（決定係咪引入商米 SDK）
3. **一間舖幾部 Sunmi？** 若得一部，就係單點故障；建議最少一部 + 保留 iPad 本地 Companion 後備
4. **Relay 同現有 native bridge 嘅優先級**？建議：終端係 Android APK → 用 native（快）；終端係 iPad → 用 relay
5. **配對 token 有效期**？建議長效 + 可 revoke（簡單）；定係 30 日 rotate（安全但麻煩）

---

## 13. 同 `docs/46` 嘅關係

`docs/46` 定嘅協議幀（`submit` / `dispatch` / `result` / `anchor`）**全部保留**，只係**底層傳輸由「自建 Node WSS」改做「Supabase Realtime + RPC」**：

| docs/46 | 本方案 |
|---|---|
| Cloud Print Relay（自建 Node WSS） | Supabase Realtime（postgres_changes）+ claim RPC |
| Terminal → Relay `submit` | `PRINT_JOB_CREATED` → `pos_print_jobs`（已存在） |
| Relay → Stationary `dispatch` | Realtime INSERT 事件（叫醒）+ claim RPC（權威拎單） |
| Stationary → Relay `result` | `POST /api/pos/print-agent/result` |
| `anchor` 心跳 | `POST /api/pos/print-agent/heartbeat` → `pos_print_agents.last_seen_at` |
| `ttl` | RPC 層 `ttl > now()` 過濾 |
| `MAX_SYNC_ATTEMPTS=5` | RPC 層 `attempts < 5` |

---

## 14. 落地狀態（2026-09-02 更新）

### ✅ 已完成

| 項目 | 位置 | 備註 |
|---|---|---|
| Sunmi V2 硬件確認 | — | Android 7.1（API 25）、內置 **58mm** 打印機、WiFi 2.4G only、冇 RJ45 |
| migration `0020` | `supabase/migrations/0020_print_relay.sql` | 15 個新欄位 + `pos_print_agents` + `pos_claim_print_jobs()` RPC。**未跑**（見 §5.1 警告） |
| APK minSdk 26 → **24** | `print-agent-android/app/build.gradle.kts` | 等 API 25 嘅 Sunmi V2 裝到 |
| 引入 `com.sunmi:printerlibrary:1.0.24` | 同上 | 純 Java AIDL、minSdk 19、無 JNI → 同 arm-v7a 無衝突 |
| 引入 `com.squareup.okhttp3:okhttp:4.12.0` | 同上 | Realtime WSS + Vercel REST |
| Sunmi 內置打印機輸出 | `net/SunmiPrinter.kt` | AIDL `sendRAWData(bytes)`，行同一個 `EscPosRenderer` |
| `<queries>` 宣告 | `AndroidManifest.xml` | targetSdk ≥ 30 唔加就 bindService **靜默失敗** |
| **58mm 紙寬修正** | `net/EscPosRenderer.kt` | `renderTemplateTicket` 之前所有 `twoColumn()` 唔傳 `cols` → 永遠 48 格（80mm）→ 58mm 機上價錢甩行。加咗 `paperColumns()`：58→32、80→48，分隔線同步 |
| relay package | `relay/`（7 個檔） | `RelayPrefs` / `RelayState` / `RelayApi` / `RealtimeClient` / `JobRunner` / `RelayService` / `RelayActivity` / `BootReceiver` |
| `PrintJobDto.fromRow()` | `model/PrintDtos.kt` | 直接食 `pos_print_jobs` DB row（snake_case），共用同一套 items/content/template parser |
| `SdkPrinter.printBytes()` | `net/SdkPrinter.kt` | 中繼用：連線 → 送已 render 好嘅 bytes → 斷線 |
| 開機自動起身 | `relay/BootReceiver.kt` | `BOOT_COMPLETED` + `MY_PACKAGE_REPLACED`，得已配對先起 |
| **APK 已 build** | `C:/dev/print-agent-android/print-agent-1.1.0-debug.apk` | versionCode 5 / versionName 1.1.0 / minSdk 24 |

### ⏳ 未完成（web / DB 側）

1. **跑 migration 0020** —— 人手去 Supabase Dashboard SQL Editor 貼，貼完跑 file 尾嘅驗收 SQL
2. **4 條 Vercel routes**（§8.1 合約）
3. **擴 sync payload**（§6.1）— 加 `printer, kind, store_name, payment_method, total, qr, qr_url, copies, ttl`
4. **`RealtimePrintTransport`**（§6.2）+ 接入 `dispatch.ts`（§6.3）
5. **`mapPosPrintJobRow`** 補新欄（§6.4）
6. **配對 UI**（iPad 端掃描 → POST /pair）

### 部署步驟（Sunmi V2）

1. sideload `print-agent-1.1.0-debug.apk`（`adb install -r` 或抄去 SD 卡裝）
2. 開 app → 因為 `relayHome` 預設 false，會入 POS WebView 畫面
3. 喺 POS 嗰邊 call `window.PosNative.openRelay()`（或者先把 `relayHome` 設 true 再重開）
4. 中繼畫面撳「設為開機首頁（中繼專用機）」→ 之後開機直接入中繼
5. iPad 掃 QR → 配對完成
6. 撳「電池最佳化設定」加入白名單（**必須**，否則鎖屏一陣 Realtime 會斷）
7. 撳「測試打印（Sunmi 內置）」驗 58mm 紙寬 + 中文編碼

### ⚠️ 未實機驗證過嘅地方

- Sunmi AIDL 喺真機上嘅 `onRunResult` 回調時機（超時 25s 當失敗嘅假設）
- 58mm 出紙嘅實際斷行效果（`twoColumn` 退化邏輯：`pad < 1` 時變兩個空格分隔、唔削名）
- Sunmi V2 ROM 對 `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` 嘅相容性（API 25 其實無呢個概念，會自動忽略）
