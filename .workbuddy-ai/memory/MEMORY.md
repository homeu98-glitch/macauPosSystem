# Macau POS System — 專案記憶

## 結構
澳門 Web POS（`C:\dev\macauPos\macauPosSystem`），前台已上線（macau-pos-system.vercel.app，Supabase `zymdemjflsckicwcinxl`）。Next.js 16 + React 19 + TS5 + Tailwind4 + Supabase（Ledger 必配 / POS 可選）+ PWA + LocalStorage 離線優先 + print-bridge。
- `src/app/`（餐飲 v1 + salon）；`src/components/pos-app.tsx` 核心。`src/lib/types.ts` 權威。
- **Android Print Agent**：獨立 repo `C:\dev\print-agent-android`（v1.1.1/code 6）。
- **Print Hub**：獨立 repo `C:\dev\print hub`（com.macau.printhub, v1.1.0/code 2）。純 LAN relay hub（無 Sunmi、無 WebView）：IP 掃描 + NanoHTTPD 8787 + 日誌 + 配對。

## 重要約定
- localStorage：餐飲 `macau-pos/*`；salon `macau-pos-salon/*`。PrintJob 模型共用。
- Ledger 介面層不可繞過。不引入新依賴。
- 設定真源：per-terminal 本地優先；其餘 server 優先。
- itemIdentity 三邊同步：`menuItemId|specs|price|note`。
- 備註鎖定（docs/84）：鎖 sent_to_kitchen/paid/settled 等；唔鎖 draft/reopened。
- 非永久狀態唔越界：`*-temp/-draft/-ghost` 在 render + persistence 都要 filter。
- 長文字 `whitespace-pre-wrap break-words`，唔好 `truncate`。
- 訂單排序一律 `compareOrderByLocalNo()` = 純 `createdAt` asc。
- **storeId 單一真源 = `resolveStoreId()`（`src/lib/pos/sync-flush.ts`）**：登入 `merchantId` → kiosk binding → undefined。所有 sync / pair-status call site 必須用佢，唔好自己砌 `??` 鏈。
- **`macau-store-a` 係 admin 帳號系統嘅示範店代碼，同 `merchants.id`（UUID）係兩套嘢**。見到就要警覺：寫落 `pos_print_jobs.store_id` 或拎去配對，會變「配咗對但印唔出單」。
- **`pos_print_agents` 冇 `store_name` 欄**（0020 只喺 `pos_print_jobs` 加咗）。select/insert 佢會 42703 → `loadPairedAgent()` 返 null → claim/result/heartbeat 認證全斷 + `GET /pair` 永遠 pending + `/pair-status` 500。店名一律由 auth session（`merchants.name`）提供。

## 打印
- **通道優先級**（`dispatch.ts`）：① native bridge ② Companion ③ Cloud Relay。relay 只喺 pure-web 觸發；`RelayPairingPanel` 已 self-gate（`isRunningInNativeShell()` → `return null`）。
- **Companion loopback 唔好主動探**（2026-09-02）：`shouldAutoDiscoverCompanion()` 閘 —— 只有 PC 原生殼或 page 喺 localhost 先探 `127.0.0.1:9311`。純 website 探只會永久 `ERR_CONNECTION_REFUSED`（loopback 係 trustworthy origin，唔會被 mixed content 靜默擋）。用家主動嘅 `?companion=` / 設定頁「測試連線」照行。
- **⚠️ 已知安全缺口（未修）**：`pos_print_jobs` 嘅 anon RLS 策略係 `created_at >= now() - 14 days`，**冇按 store 隔離**。改過嘅 client 唔帶 `filter: store_id=eq.<storeId>` 就收到全平台 14 日內 print job。0016 就係咁，唔係 Scheme B 引入。收窄方向見 `docs/97 §5.2`。
- **三倉 renderer 合約（docs/95）**：web / Companion / APK 共用。加欄位必須同步三倉。
- **收據金額鐵律**：`原價+服務費+稅−抹零−優惠===總金額`。雙軌 `resolveTotalDiscount()` 取 min 截頂。
- 規格加購價靠右：三倉 `splitSpecLine()` + `twoColumn()`。中文字 2 格、ASCII 1 格。

## 雲端中繼（Scheme B，解釋文 docs/97 / 規格 docs/96）
iPad(HTTPS) → Supabase Realtime(WSS) → Android Hub(LAN) → LAN printer(:9100)。
- **核心：Vercel 從來冇 call 過店內本機 app**。全部連線係 Hub 主動行出嚟（outbound），所以零入站連線 → 唔使 firewall / port forwarding / 固定 IP / VPN / Cloudflare Tunnel。
- **relay 係備援唔係主力**：能直打（native bridge / Companion）就唔好行雲。
- 「Realtime 負責快，RPC 負責準」：Realtime 斷/漏/截最多慢 60s，絕不漏單或重複印。
- **配對 = Android 自註冊（用戶唔使輸入任何 ID）**：Hub 用 POS 號碼（8 位電話 + 4 位 PIN）打 `/api/ledger/login` → 拎 `merchantId` → `POST /pair` → `GET /pair?agentId=` 拎 `{storeId,supabaseUrl,anonKey}`。web 端行同一條 login 拎同一個 merchantId，所以兩邊天然對上。
- **web 端只剩「檢查配對狀態」一個掣**（`GET /pair-status?storeId=<resolveStoreId()>`），「本店店舖 ID」輸入欄已於 2026-09-02 移除。
- **`POST /pair` 會驗真 storeId**：假店黑名單 + 查 `merchants` 表（`22P02` 當 missing 擋；基建錯 fail-open 只 warn）。缺 storeId 嘅 sync 一律 400（無 DEFAULT fallback）。
- 6 條 Vercel route：`pair`/`claim`/`result`/`heartbeat` + `pair-status`/`unpair`。已完成。
- Realtime payload >1MB 被截 → 只當叫醒，數據經 RPC `pos_claim_print_jobs`（`for update skip locked`）。
- **print-agent-android**（v1.1.1）：含 Sunmi 內置 + LAN + relay 完整功能。
- **print hub**（`C:\dev\print hub`，v1.0.0）：純 LAN relay hub（無 Sunmi、無 WebView），含 IP 掃描 + NanoHTTPD 8787 + 日誌 + 配對。port 自 `print-agent-android` 核心 Kotlin。

## 原生殼檢測
`isRunningInNativeShell()`：`window.PosNative.printJob`（Android）/ `window.companionShell`（PC）。

## 開發環境
- 語言：繁體中文（廣東話風味）。
- git 一律 `run_in_background`；push 前 `git ls-remote` 對。
- `tsc --noEmit` 唯一誤報：`layout.tsx LayoutProps`。
- **`npx next build` 前要先 `mv .next .next.bak-<ts>`**，否則 Turbopack 清快取會撞 sandbox 批量刪除保護（count 50 / threshold 50）→ 卡 20 分鐘後報 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。改名後 1.5 分鐘 build 完。`.gitignore` 已有 `/.next.bak*/`。
- Android build：`export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"` + `./gradlew assembleDebug`。print hub 首次需 online（nanohttpd 等新 dep）。
- 寫咗 migration ≠ 跑咗 migration；本機冇 DB → 人手 Dashboard SQL Editor 貼。
