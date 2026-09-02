# 97 · 雲端中繼（Scheme B）架構說明：Vercel 點樣安全地叫到店內本機 app

> 呢份係 **解釋文**，講「點解咁設計」同「安全邊界喺邊」。
> 實作規格（API 合約、migration、APK 檔案位置）喺 `docs/96-sunmi-print-relay-plan.md`。
>
> 寫於 2026-09-02。

---

## 0. 一句講晒

**Vercel 從來冇 call 過店內嘅本機 app。**

成個設計嘅核心就係呢句。雲端**冇任何一條連線**係由外面打入去店內網絡 ——
係店內部 Android Hub 自己**主動行出嚟**攞嘢，攞完自己返去印。

所以：**唔使開 firewall、唔使 port forwarding、唔使固定 IP、唔使 VPN、唔使 Cloudflare Tunnel。**

---

## 1. 角色

| 角色 | 喺邊 | 網絡位置 | 識唔識對方嘅地址 |
|---|---|---|---|
| **iPad / 瀏覽器（web POS）** | 店內或出面 | 公網 HTTPS | 只識 Vercel 同 Supabase |
| **Vercel（API routes）** | 雲 | 公網 | 唔知店內有任何機 |
| **Supabase（Postgres + Realtime）** | 雲 | 公網 | 唔知店內有任何機 |
| **Android Hub（中繼機）** | 店內 | 店內 LAN / 4G | 只識 Vercel 同 Supabase |
| **打印機** | 店內 | LAN `:9100` | 只識 Hub（同一個 subnet） |

注意最後一個：Hub 同打印機之間係**普通 LAN TCP**，冇加密、冇認證 ——
但因為佢哋喺同一個 subnet 入面，雲端根本掂唔到，所以唔使。

---

## 2. 方向圖

```
                    公網（HTTPS / WSS）
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   iPad (web POS)          Vercel              Supabase   │
  │        │                    │                    │       │
  └────────┼────────────────────┼────────────────────┼───────┘
           │ ①                  │ ②                  │ ③
           │ POST /api/pos/sync │ RPC / 寫入          │ Realtime
           │ （寫 pos_print_    │ （service_role）    │ INSERT 事件
           │   jobs）           │                    │
           │                    │                    ▼
           │                    │              ┌───────────┐
           │                    │              │ 事件「叫醒」│
           │                    │              └─────┬─────┘
           │                    │                    │
  ┌────────┼────────────────────┼────────────────────┼───────┐
  │        │                    │                    ▼       │
  │        │                    │            Android Hub     │
  │        │                    │              （主動出嚟）    │
  │        │                    │                    │       │
  │        │                    │ ④ POST /claim      │       │
  │        │                    │◀───────────────────┘       │
  │        │                    │   （agentId + token）      │
  │        │                    │                            │
  │        │                    │ ⑤ 返 jobs[]                │
  │        │                    │───────────────────▶        │
  │        │                    │                    │       │
  │        │                    │                    ▼       │
  │        │                    │            render ESC/POS  │
  │        │                    │                    │       │
  │        │                    │                    ▼       │
  │        │                    │            LAN :9100 打印機 │
  │        │                    │                    │       │
  │        │                    │ ⑥ POST /result     │       │
  │        │                    │◀───────────────────┘       │
  └────────┴────────────────────┴────────────────────────────┘
     店內 LAN                                    店內 LAN

  ✅ 全部箭嘴都係「由內向外」發起。
  ❌ 冇任何箭嘴係由雲端打入店內。
```

---

## 3. 完整時序（由落單到出紙）

```
1. 收銀撳「落單」
     web POS 生一個 PrintJob，status=pending，寫 localStorage
     同時入 sync queue（PRINT_JOB_CREATED）

2. PrintFlushWorker（每 2.5s）→ flushPendingPrintJobs()
     dispatch.ts 揀通道：
       ① native bridge（Android APK WebView）  ← 行呢條就唔使 relay
       ② 桌面 Companion（localhost:9311）      ← 行呢條都唔使 relay
       ③ Cloud Relay                          ← 得返瀏覽器 + 冇 Companion 呢個 case

3. 通道③ RelayTransport.send()
     佢**唔開 socket、唔打打印機**，只係做一件事：
       await flushPosSyncQueue()   →   POST /api/pos/sync
     即係「確保張單寫咗上雲端 pos_print_jobs」，然後樂觀返 ok。

4. Vercel /api/pos/sync 用 service_role 寫入 pos_print_jobs
     （store_id 由 resolveStoreId() 拎 = 登入嘅 merchantId）

5. Supabase Realtime 廣播 INSERT 事件
     Hub 訂閱時帶 server-side filter：store_id=eq.<storeId>
     → 收到「叫醒」

6. Hub 打 POST /api/pos/print-agent/claim
     headers: x-agent-id / x-agent-token
     body:    { agentId, storeId, limit: 5 }

7. Vercel 驗 token → RPC pos_claim_print_jobs(storeId, agentId, limit)
     RPC 內含 `for update skip locked`
     → 原子認領、寫 claimed_by / status='printing' / attempts+1

8. Hub render ESC/POS（同 web / Companion 共用同一套 renderer，見 docs/95）
     → 開 TCP 去 LAN 打印機 :9100 → 送 bytes → 斷線

9. Hub 打 POST /api/pos/print-agent/result
     status='sent'   → 完
     status='failed' → attempts<5 會變返 pending 自動重排

10. Hub 每 ~60s 打一次 /heartbeat
     順便做對賬 tick（補償冇收到嘅 Realtime 事件）
```

### 3.1 點解 Realtime 只係「叫醒」，claim RPC 先係權威？

| 只用 Realtime 傳 payload | 只用輪詢 claim |
|---|---|
| ❌ payload >1MB 會被截斷（單據有 items + template 快照，好易超） | ✅ RPC 由 DB 直接攞完整 row |
| ❌ 事件冇咗就冇咗（冇 ACK、冇重投） | ✅ 60s 對賬 tick 會補返 |
| ❌ 兩部 Hub 同時收到 → 重複打印 | ✅ `for update skip locked` 物理上淨一個拎到 |
| ✅ 夠快（毫秒級） | ❌ 淨靠輪詢會慢 |

所以：**Realtime 負責快，RPC 負責準。**
Realtime 斷咗、事件冇咗、payload 截咗 —— 最多係慢 60 秒，絕對唔會漏單或者重複印。

---

## 4. 「Vercel 點樣安全地 call 本機 app」逐條拆

### 4.1 方向：永遠 outbound，所以根本冇「打入去」呢件事

呢個係成個方案最緊要嘅一點，亦係佢同 Cloudflare Tunnel / VPN / port forwarding 最本質嘅分別：

| 方案 | 要唔要喺店內 router 開窿 | 要唔要公網 IP | 攻擊面 |
|---|---|---|---|
| Port forwarding | ✅ 要 | ✅ 要固定 IP | 打印機直接暴露喺公網 |
| VPN（Tailscale 等） | ❌ | ❌ | 要喺每部機裝 agent + 管 key |
| Cloudflare Tunnel | ❌ | ❌ | 多一個供應商 + `cloudflared` 要長期跑 |
| **Scheme B（呢個）** | ❌ | ❌ | **零入站連線** |

Hub 行嘅全部係 **outbound HTTPS / WSS**，同佢上 Facebook 冇分別。
店內 router 嘅 NAT 天然就擋住咗所有入站連線 —— 我哋**連試都唔使試**去開佢。

### 4.2 配對：點解 storeId 唔使用戶輸入

Hub 同 web POS 打**同一條** `/api/ledger/login`（8 位電話 + 4 位 PIN），
拎到**同一個** `merchantId`（`merchants.id` UUID）。

```
Hub:  login(phone, pin) → merchantId ─┐
                                      ├─ 同一個值 → 就係 storeId
web:  login(phone, pin) → merchantId ─┘
```

所以 storeId 係**由登入身份隱含推導**，唔係用戶要填嘅資料。
web 端舊版嗰個「本店店舖 ID」輸入欄已喺 2026-09-02 移除 —— 因為佢唔止多餘，
**仲危險**：用戶好易抄錯成 `macau-store-a`（admin 帳號系統嘅示範店代碼），
配對會「成功」但 Realtime filter 永遠唔 match → **一張單都印唔出**，最難 debug 嗰種。

### 4.3 認證：token 淨存 sha256

```
Hub 首次啟動：
  agentId = "ag-" + 16 bytes hex   （明文存，係公識別碼）
  token   = 32 bytes hex           （明文淨存喺 Hub 嘅 SharedPreferences）

POST /pair { agentId, token, storeId, name }
  → server: token_hash = sha256(token)   ← 淨存呢個

之後每一次 claim / result / heartbeat：
  header x-agent-token: <token>
  → server: sha256(收到嘅) == token_hash？
            store_id 對唔對？
            revoked_at is null？
            → 三樣全中先放行
```

- token **只出現喺**兩處：配對嗰一條 HTTPS request body、Hub app sandbox 入面。
- DB 漏咗都**反推唔到** token。
- 想踢部機走：寫 `revoked_at` → Hub 下一輪 heartbeat 收 401 → 自動清配對返去配對畫面。

### 4.4 授權：store_id 隔離

claim 嗰陣 server 用嘅係**自己由 token 查返出嚟嘅** `store_id`，
**唔係** Hub 報上嚟嗰個。`pos_claim_print_jobs(p_store_id, ...)` 係 `security definer`
但入口喺 Vercel 度驗過權，Hub 冇辦法靠改 body 入面嘅 `storeId` 去拎第間店嘅單。

### 4.5 配置唔 hardcode

`GET /pair` 會由 server 落 `supabaseUrl` + `anonKey` 畀 Hub。
換環境（例如搬去第二個 Supabase project）**唔使改 APK、唔使重新出包**。

### 4.6 `pos_print_agents` 係 service-role only

```
alter table public.pos_print_agents enable row level security;
revoke all on public.pos_print_agents from anon, authenticated;
grant all on public.pos_print_agents to service_role;
```

即係：**揸住 anon key 都讀唔到中繼機表**（冇 agentId 清單、冇 token_hash）。
所有特權操作一定要經 Vercel routes。

---

## 5. 信任邊界同殘餘風險

### 5.1 邊界表

| 邊界 | 點保護 | 漏咗會點 |
|---|---|---|
| iPad ↔ Vercel | HTTPS + POS 登入 session |  attacker 可以落假單（但要登入） |
| Vercel ↔ Supabase | `service_role` key，淨喺 server env |  key 漏 = 全權（要輪換） |
| Hub ↔ Vercel | HTTPS + agentId/token（sha256 比對） | token 漏 = 嗰間店嘅單可以被拎走 |
| Hub ↔ Supabase Realtime | WSS + anon key + server-side `store_id` filter | 見 5.2 |
| Hub ↔ 打印機 | **冇**（純 LAN TCP） | 但要已經喺同一個 subnet 入面 |

### 5.2 ⚠️ 已知缺口：Realtime 嘅 anon 讀權限冇按 store 隔離

`0016_security_rls_hardening.sql` 對 `pos_print_jobs` 嘅 anon 策略係：

```sql
create policy "pos_print_jobs anon read recent" on public.pos_print_jobs
  for select to anon
  using (coalesce(created_at, now()) >= now() - interval '14 days');
```

即係：**揸住 anon key 可以讀到所有店嘅 print job**。
Hub 自己帶咗 `filter: store_id=eq.<storeId>`（server-side 套用），
所以正常行為係淨收到自己間店嘅嘢。

但呢個 filter 係 **client 提供**嘅。一個改過嘅 client 可以唔帶 filter，
然後收到全平台嘅 print job（含單據內容）。

**點解而家仲未爆**：
- 單據內容係菜品名 + 價錢 + 備註，**一般唔含客人 PII**
- anon key 唔係秘密，但都要特登寫 client 去濫用
- 拎到事件都**印唔到嘢** —— claim 一定要過 agent token + store_id 驗權

#### ⚠️ 兩個常見誤解（2026-09-02 查證，寫低唔好再中伏）

**誤解一：「收窄時間窗可以減少 Realtime 被濫用」** —— ❌ 錯。

Supabase Realtime `postgres_changes` **只推即時變更，唔會回放歷史**。
所以時間窗對 Realtime 嘅暴露面係 **零影響** —— 窗係 14 日定 1 小時，
一個 subscribe 緊嘅 client 收到嘅即時事件**完全一樣**。
要擋 Realtime 濫用，淨得「`store_id` 隔離」一條路。

**誤解二：「收窄到 1 小時好穩陣」** —— ❌ 錯，而且會出事。

web POS（`src/lib/pos/use-pos-realtime.ts:79`）訂閱咗 `pos_print_jobs` 嘅 `event: "*"`
（**包 UPDATE**）。Realtime 對 UPDATE 事件係**用新 row 去過 RLS SELECT policy**，
而 `created_at` 喺 UPDATE 時**唔會變**。

→ 一張 09:00 建、中繼機 12:00 先 claim 到嘅單，12:00 嗰個 UPDATE 事件會因為
`created_at` 已經 3 個鐘前而被 1 小時窗擋咗 → **web 端收唔到出紙結果**。

而「延遲認領」正正係 Scheme B 設計上要支援嘅場景（60s 對賬 tick、`attempts<5`
自動重排）。所以**唔可以**收到 1 小時咁短。

#### 處置

| 做法 | 狀態 | 說明 |
|---|---|---|
| 收窄時間窗 `14 days → 24 hours` | ✅ **migration 已寫好，等人手跑** | `supabase/migrations/0021_print_jobs_anon_window_24h.sql`。**淨影響 PostgREST 直接 SELECT**（anon 有 `grant select`），REST 可摷嘅歷史減 14 倍。Realtime 事件全部照收（事件係即時，`created_at` ≈ now），對 web / Hub 行為零改變 |
| Realtime 淨推「叫醒」、payload 淨帶 `id` | ✅ 其實已經係咁行 | claim RPC 先係權威，Realtime payload 根本冇用到（見 §3.1） |
| **根治：JWT 帶 `store_id` claim** | ⏳ **未做，要 infra 配合** | 見下面 |

#### 根治方案：自簽 JWT 帶 `store_id`

```sql
create policy "pos_print_jobs agent read own store" on public.pos_print_jobs
  for select to authenticated
  using (
    store_id = coalesce(
      current_setting('request.jwt.claims', true)::json ->> 'store_id',
      ''
    )
  );
```

前置條件（**要人手加，唔可以寫落 migration**）：
1. Supabase Dashboard → Project Settings → API → 攞 **JWT Secret**
2. 加落 Vercel env：`SUPABASE_JWT_SECRET`（server-only，**唔好**加 `NEXT_PUBLIC_`）
   —— 現時 `.env.example` 得 `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
   `SUPABASE_SERVICE_ROLE_KEY`，**冇** JWT secret
3. `POST /api/pos/print-agent/pair` 成功時，用 JWT secret 簽一個短命（例如 24 小時）
   嘅 token，claims 帶 `{ role: "authenticated", store_id }`，取代而家直接派 `anonKey` 畀 Hub
4. Hub 攞呢個 token 去連 Realtime（而唔係 anon key）

到期點算：Hub 每輪 heartbeat 順便換 token（heartbeat 本身已經有 agent token 驗權，
唔使驚「拎新 token 嗰下冇權」）。

**另一條路（唔使 JWT）**：中繼機改成**純輪詢** `POST /claim` —— 本身已經有 agent token
驗權，天然按店隔離，完全唔用 Realtime。代價係出紙延遲由毫秒級升到輪詢間隔
（用 60s 對賬 tick 即係最慢 60 秒）。接受到嘅話呢條最簡單。

> 呢條唔係 Scheme B 引入嘅新問題，係 `0016` 就已經係咁。記低佢，唔好以為「有 RLS 就安全」。

### 5.3 物理安全

Hub 係放喺店內嘅實體機。拎到部機 = 拎到 SharedPreferences 入面嘅 plaintext token。
缓解：遠端寫 `revoked_at` 即刻失效（下一輪 heartbeat 生效，最多 60 秒）。

---

## 6. 同其他通道嘅關係

`dispatch.ts` 嘅通道優先級（**呢個係權威**）：

```
① native bridge   → Android APK WebView（window.PosNative.printJob）
                    部機自己就喺 LAN，直打打印機，最快最穩
② Companion       → 桌面 Electron agent（localhost:9311）
                    Windows/macOS 開瀏覽器 POS 時用
③ Cloud Relay     → 經 Supabase → 店內 Hub
                    得返「iPad + 純瀏覽器」呢個 case 先用
```

| | ① native | ② Companion | ③ Relay |
|---|---|---|---|
| 場景 | Android 一體機 POS | 桌面瀏覽器 | iPad / 平板瀏覽器 |
| 經唔經雲 | 唔經 | 唔經 | 經 |
| 延遲 | 最低 | 低 | 1–3 秒（Realtime） |
| 斷網可唔可以印 | ✅ | ✅ | ❌（要雲） |
| 要唔要額外機 | 唔使 | 要開住部 PC | 要部 Android Hub 長開 |

**Relay 係備援，唔係主力。** 能夠直打（①②）就唔好行雲。

### 6.1 順帶講吓 `shouldAutoDiscoverCompanion()`

通道② 嘅 Companion 住喺 `127.0.0.1:9311`。以前 `PrintFlushWorker` 每 2.5 秒會主動探一次
loopback。瀏覽器當 loopback 係 trustworthy origin，**唔會**被 mixed content 靜默擋，
而係真係嘗試連線然後 `ERR_CONNECTION_REFUSED` —— 純 website 上即係永久洗 console。

2026-09-02 加咗閘：只有 ① 跑緊 PC 原生殼 ② page 本身喺 localhost 先主動探。
用家主動要求嘅路徑（`?companion=` 參數、設定頁「測試連線」掣）一律照行。

---

## 7. FAQ

**Q：Hub 熄咗／冇電，單會點？**
A：web 端 RelayTransport 樂觀返 ok（當「交咗畀雲端」）。單留喺 `pos_print_jobs`
`status='pending'`，Hub 返嚟會 claim 返。**但張單唔會即刻出紙** —— 呢個係中繼方案嘅固有取捨。

**Q：兩部 Hub 同一間店會重複印？**
A：唔會。`for update skip locked` 物理上淨一個拎到。

**Q：Hub claim 咗但死機，單會唔會卡死？**
A：唔會。RPC 有 `claimed_at < now() - 60s` 嘅條件，60 秒後釋放畀第啲機。

**Q：點知間店有冇配對到？**
A：web 端「設置 → 打印機 → 雲端列印中繼」撳「檢查配對狀態」。
三態：已配對（綠）/ 尚未配對（琥珀，每 10 秒自動重查）/ 配對失敗（紅，會出 error detail）。

**Q：可唔可以由 Vercel 主動 push 落 Hub 而要 Hub 開 port？**
A：唔好。咁就變返要入站連線，成個方案嘅零配置優勢即刻冇咗。
要即時性嘅話，Supabase Realtime 已經提供到毫秒級。

**Q：換 Supabase project 要改 APK 嗎？**
A：唔使。`supabaseUrl` / `anonKey` 由 `GET /pair` 落。

---

## 8. 相關文檔

| 文檔 | 講乜 |
|---|---|
| `docs/96-sunmi-print-relay-plan.md` | **實作規格**：migration、API 合約、APK 檔案位置、落地狀態 |
| `docs/46-cloud-print-relay-spec.md` | 舊 WSS 骨架設計（已被 96 取代，留檔參考） |
| `docs/47-desktop-companion-spec.md` | 通道② Companion（桌面 Electron agent） |
| `docs/33-print-bridge-https-lan.md` | 瀏覽器 HTTPS 打 LAN 打印機嘅 mixed-content 死結 |
| `docs/35-cloudflare-tunnel-print-bridge.md` | 另一條路（Tunnel），同 Scheme B 嘅取捨對比 |
| `docs/95-receipt-print-fix.md` | 三倉 renderer 合約（web / Companion / APK 共用） |
| `supabase/migrations/0020_print_relay.sql` | `pos_print_agents` + `pos_claim_print_jobs()` RPC |
