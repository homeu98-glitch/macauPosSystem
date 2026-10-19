# Repo 檔案全面盤點與分類報告

- **日期**：2026-10-17
- **範圍**：`C:/dev/macauPos/macauPosSystem` 全部檔案（排除 `node_modules` 20,070 檔、`.git`、`.next`）
- **性質**：**唯讀盤點**。本次未刪除、未移動、未修改任何既有檔案；所有刪除動作等待 J 確認後執行。

---

## 0. 結論速覽

| 分類 | 檔數 | 大小 |
|---|---:|---:|
| 系統相關 | 1,411 | 224.9 MB |
| 資安相關 | 89 | 0.6 MB |
| 無關（臨時產物／agent 數據／範本殘留） | 197 | 9.3 MB |
| 無法明確歸類 | 1 | 0 MB |
| **合計** | **1,698** | **234.8 MB** |

要清理的話，全部集中在 §7 的四級建議裡：**T1（73 檔／2.2 MB，零風險）**、**T2（191 檔／0.8 MB，低風險）**、
**T3（301 檔／132.8 MB，業務決策：舊版安裝檔＋舊 mockup 證據）**、**T4（87 檔／6.9 MB，不建議刪）**。

一句話：**系統碼同資安碼本身冇垃圾**；要刪嘅都係「命令輸出、一次性腳本、舊截圖、舊安裝檔」呢類過程產物。

---

## 1. 方法與判定標準

1. **全量掃描**：以 Node 遞歸走完整個 repo，記錄路徑／大小／修改時間，排除 `node_modules`、`.git`、`.next`、`.vercel`；`.workbuddy`（本 agent 數據）與 `.workbuddy-ai`（另一款 AI 工具的記憶）單獨收集但一併分類。
2. **git 追蹤核查**：對每個刪除候選組用 `git ls-files` 確認是否已入版本庫（入庫 = 刪本地檔之外還要處理 git 紀錄）。
3. **內容覆核**：對所有「非常規」檔（0 位元組、無副檔名、`.out`/`.log`、`.exe`、根目錄散檔、空殼文件）逐個開內容檢查；對資安檔用 `git grep` 驗證職能（函式名／RLS／migration 名稱）。
4. **密鑰洩漏快速 scan**：`git grep` 全庫找硬編碼 JWT／`service_role` —— 結果乾淨（probe 內的 `eyJ` 只是偵測用 regex；memory 內的 `service_role` 只是文字提及 RLS 政策，無真實金鑰值）。

**分類定義**：

- **系統相關**：POS 產品本身——源碼、測試、migration、API、頁面、元件、建置／專案配置、設計與維運文件、開發工具。
- **資安相關**：存在目的即安全職能——鑑權／授權／會話／加密簽名／限流／RLS／金鑰配置／安全審計。
- **無關**：不參與建置與運行，內容為過程產物——命令輸出、一次性腳本、臨時稿、工具快取、未被引用的範本檔、AI agent 工作數據。
- **無法明確歸類**：內容不足以判定（見 §6）。

---

## 2. 總覽

### 2.1 按頂層目錄

| 目錄 | 檔數 | 大小 | 其中 git 已追蹤 |
|---|---:|---:|---:|
| `src/` | 665 | 7.6 MB | 665 |
| `docs/` | 519 | 61.7 MB | 445 |
| `tools/` | 320 | 2.6 MB | 320 |
| `supabase/` | 67 | 0.4 MB | 66 |
| `public/` | 14 | 155.0 MB | 14 |
| `print-relay/` | 4 | 0.0 MB | 4 |
| `(root)/` | 22 | 0.5 MB | 20 |
| `.workbuddy/` | 66 | 6.3 MB | 66 |
| `.workbuddy-ai/` | 21 | 0.6 MB | 21 |
| **合計** | **1698** | **234.8 MB** | **1656** |

### 2.2 按副檔名（前 12）

| 副檔名 | 檔數 |
|---|---:|
| `.ts` | 486 |
| `.png` | 292 |
| `.md` | 263 |
| `.cjs` | 187 |
| `.tsx` | 179 |
| `.sql` | 91 |
| `.txt` | 74 |
| `.html` | 40 |
| `.json` | 35 |
| `.mjs` | 15 |
| `.js` | 8 |
| `.svg` | 5 |

> git 追蹤總數 1656；未追蹤 42（主要為 .gitignore 排除的快取／截圖）。

**最大的 10 個單一檔案**：

| # | 路徑 | 大小 | 分類 |
|---|---|---:|---|
| 1 | `public/releases/Macau POS Desktop Setup 0.1.17.exe` | 77.4 MB | 系統相關 |
| 2 | `public/releases/Macau POS Desktop Setup 0.1.18.exe` | 77.4 MB | 系統相關 |
| 3 | `.workbuddy/tmp/crops/full2x.png` | 2.3 MB | 無關 |
| 4 | `docs/mockups/inventory-ui-diff-after-2026-09-26.html` | 1.8 MB | 系統相關 |
| 5 | `docs/mockups/i18n-verify-2026-10-07/01-select-workbench-en.png` | 1.0 MB | 系統相關 |
| 6 | `docs/mockups/i18n-verify-2026-10-07/01-select-workbench-zh-Hant.png` | 1.0 MB | 系統相關 |
| 7 | `docs/mockups/compact-redesign-2026-10-14/design-v2-full.png` | 797.6 KB | 系統相關 |
| 8 | `docs/mockups/inventory-ui-diff-2026-09-25.html` | 792.4 KB | 系統相關 |
| 9 | `docs/mockups/report-purchase-layout-2026-10-05.png` | 737.7 KB | 系統相關 |
| 10 | `docs/mockups/compact-redesign-2026-10-14/design-full.png` | 671.4 KB | 系統相關 |


> 兩個 `.exe` 已入 git（`public/releases` 4 檔全追蹤），合共 **158 MB**，是 repo 體積最大單一來源。

---

## 3. 分類總表

| 區域 ↓ ＼ 分類 → | 系統相關 | 資安相關 | 無關 | 無法明確歸類 | 小計 |
|---|---:|---:|---:|---:|---:|
| `src/` | 605 | 60 | 0 | 0 | 665 |
| `docs/` | 505 | 10 | 4 | 0 | 519 |
| `tools/` | 219 | 7 | 94 | 0 | 320 |
| `supabase/` | 56 | 10 | 1 | 0 | 67 |
| `public/` | 9 | 0 | 5 | 0 | 14 |
| `print-relay/` | 4 | 0 | 0 | 0 | 4 |
| `(root)/` | 13 | 2 | 6 | 1 | 22 |
| `.workbuddy/` | 0 | 0 | 66 | 0 | 66 |
| `.workbuddy-ai/` | 0 | 0 | 21 | 0 | 21 |
| **合計** | **1,411** | **89** | **197** | **1** | **1,698** |


---

## 4. 資安相關（89 檔）

#### 會話／登入（admin + 前端）

| 檔案 | 職責 |
|---|---|
| `.env.example` | 全量環境變數範本（密鑰項目的命名／用途／注意事項） |
| `.env.local.example` | 本機開發用精簡 env 範本 |
| `src/lib/admin-session-token.ts` | admin session token 簽發／驗證 |
| `src/lib/admin-account-server.ts` | admin 帳號服務端（PIN hash 驗證路徑） |
| `src/components/login-screen.tsx` | 登入畫面 |
| `src/components/auth-guard.tsx` | 前端路由守衛 |
| `src/app/api/auth/login/route.ts` | 登入 API |
| `src/app/api/admin/session/route.ts` | admin 會話 API |
| `src/app/api/admin/sessions/route.ts` | admin 會話管理 API |
| `src/app/admin/traffic/traffic-auth-contract.test.ts` | 流量頁鑑權契約測試 |
| `docs/reviews/admin-session-stuck-after-revoke-2026-09-22.md` | 吊銷後會話卡死事件 |
| `docs/reviews/env-secrets-and-flags-2026-09-15.md` | 環境變數／密鑰／flag 盤點 |

#### POS 終端／Realtime／寫入閘

| 檔案 | 職責 |
|---|---|
| `src/lib/pos/pos-device-token.ts` | POS 終端設備令牌（HMAC＋綁 storeId＋TTL 12h） |
| `src/lib/pos/pos-route-auth.ts` | POS API 路由鑑權守衛 |
| `src/lib/pos/pos-sync-auth.ts` | /api/pos/sync 鑑權 |
| `src/lib/pos/realtime-auth.ts` | Realtime 訂閱鑑權 |
| `src/lib/pos/realtime-auth-claims.ts` | Realtime JWT claims 校驗 |
| `src/lib/pos/realtime-auth-claims.test.ts` | claims 校驗測試 |
| `src/lib/pos/session-key.ts` | 會話密鑰派生 |
| `src/lib/pos/session-key.test.ts` | 密鑰派生測試 |
| `src/lib/pos/session-record.ts` | 會話記錄 |
| `src/lib/pos/session-record.test.ts` | 會話記錄測試 |
| `src/lib/pos/session-registry-server.ts` | 會話註冊表（服務端） |
| `src/lib/pos/session-revoked.ts` | 會話吊銷判定 |
| `src/lib/pos/session-revoked.test.ts` | 吊銷判定測試 |
| `src/lib/pos/store-id-guard.ts` | storeId 越權防護 |
| `src/lib/pos/order-id-guard.ts` | 訂單 ID 准入防護 |
| `src/lib/pos/order-id-guard.test.ts` | 訂單 ID 防護測試 |
| `src/lib/pos/write-gate.ts` | 寫入閘門（吊銷會話禁寫） |
| `src/lib/pos/write-gate.test.ts` | 寫入閘門測試 |
| `src/components/pos-session-revoked-banner.tsx` | 會話吊銷橫額 UI |
| `src/app/api/pos/device-token/route.ts` | POS 設備令牌簽發 API |
| `src/app/api/pos/realtime-bind/route.ts` | Realtime 綁定鑑權 API |
| `docs/reviews/session-and-write-gate-design-2026-09-21.md` | 會話＋寫入閘門設計 |

#### Ledger 會員通（會員登入／PIN／扣款／Webhook）

| 檔案 | 職責 |
|---|---|
| `src/lib/ledger/session.ts` | Ledger 會員會話核心 |
| `src/lib/ledger/supabase-server-auth.ts` | Ledger 服務端鑑權 client |
| `src/lib/ledger/admin-server.ts` | Ledger admin 服務端會話 |
| `src/lib/ledger/ledger-session-decision.ts` | 會員會話狀態判定 |
| `src/lib/ledger/ledger-session-decision.test.ts` | 會話判定測試 |
| `src/lib/ledger/ledger-session-guard.test.ts` | 會員會話守衛測試 |
| `src/lib/ledger/member-login.server.ts` | 會員登入服務端 |
| `src/lib/ledger/member-login-limit.ts` | 會員登入限流 |
| `src/lib/ledger/member-login-limit.test.ts` | 登入限流測試 |
| `src/lib/ledger/pin.server.ts` | 會員 PIN 驗證 |
| `src/lib/ledger/scan-debit.server.ts` | 掃碼扣款服務端 |
| `src/lib/ledger/scan-debit-crypto.ts` | 掃碼扣款簽名／加密 |
| `src/lib/ledger/scan-debit-crypto.test.ts` | 扣款加密測試 |
| `src/lib/ledger/webhook-signature.ts` | Webhook HMAC 驗簽（timestamp＋timingSafeEqual） |
| `src/components/kiosk/member-login-sheet.tsx` | kiosk 會員登入面板 |
| `src/app/api/ledger/login/route.ts` | Ledger 會員登入 API |
| `src/app/api/ledger/member-login/route.ts` | 會員登入 API |
| `docs/123-pos-staff-pin-permission-feasibility.md` | 員工 PIN 權限可行性 |
| `docs/127-login-workbench-permission-plan.md` | 登入／工作台權限計劃 |

#### 充值系統 SSO／店主會話

| 檔案 | 職責 |
|---|---|
| `src/lib/topup/owner-session.server.ts` | 充值系統店主會話 |
| `src/lib/topup/owner-session.test.ts` | 店主會話測試 |
| `src/lib/topup/sso.server.ts` | 充值系統 SSO 換票 |
| `src/app/api/topup/owner/[...slug]/route.ts` | 充值店主 API proxy（帶會話） |

#### 打印中繼／Grabber 入站

| 檔案 | 職責 |
|---|---|
| `src/lib/print-agent-server.ts` | 打印中繼 agent 鑑權（verifyAgent） |
| `src/lib/print-agent-server.test.ts` | 打印中繼鑑權測試 |
| `src/lib/grabber/grabber-secret.ts` | Grabber 推播密鑰管理 |
| `src/lib/grabber/grabber-secret.test.ts` | Grabber 密鑰測試 |
| `supabase/migrations/0062_pos_grabber_push_log.sql` | Grabber 推送審計日誌 |
| `supabase/migrations/0064_pos_grabber_inbox_and_capability.sql` | Grabber 收件匣＋能力令牌 |
| `docs/integration/print-relay-hardening-brief.md` | 打印中繼加固簡報 |
| `docs/integration/print-relay-per-store-token-handover.md` | 打印中繼分店令牌交接 |
| `docs/reviews/per-store-token-assessment-2026-09-23.md` | 分店令牌方案評估 |

#### 限流／簽名／金鑰管理

| 檔案 | 職責 |
|---|---|
| `src/lib/pos/rate-limit.ts` | API 限流 |
| `src/lib/pos/queue-signature.ts` | 同步隊列事件簽名 |
| `src/lib/pos/queue-signature.test.ts` | 隊列簽名測試 |
| `src/lib/supabase-server.ts` | 服務端 Supabase client（service_role 選擇＝RLS 邊界） |

#### DB 安全 migration（RLS／會話／PIN）

| 檔案 | 職責 |
|---|---|
| `supabase/migrations/0016_security_rls_hardening.sql` | RLS 安全加固 |
| `supabase/migrations/0021_print_jobs_anon_window_24h.sql` | 打印任務 anon 讀時間窗 |
| `supabase/migrations/0040_admin_pin_hash.sql` | admin PIN hash 欄位 |
| `supabase/migrations/0041_pos_anon_read_window_narrow.sql` | pos_orders anon 讀窗口收窄 |
| `supabase/migrations/0047_pos_sessions.sql` | POS 會話表 |
| `supabase/migrations/0051_pos_store_scoped_authenticated_read.sql` | 分店範圍已鑑權讀取 |
| `supabase/migrations/0052_pos_store_scoped_dual_claim.sql` | 分店範圍雙端 claim |
| `supabase/migrations/0053_pos_soldout_authenticated_read.sql` | 售罄已鑑權讀取 |

#### 安全審計／隔離／工具

| 檔案 | 職責 |
|---|---|
| `tools/audit-anon-endpoints.cjs` | anon 端點審計工具 |
| `tools/probe-anon-exposure.cjs` | anon 暴露面探測 |
| `tools/probe-anon-signin.cjs` | anon 登入探測 |
| `tools/probe-auth-settings.cjs` | 鑑權設定探測 |
| `tools/verify-pos-authgate.cjs` | POS 鑑權閘門驗證 |
| `tools/print-relay-revoke-stale-agents.sql` | 吊銷過期中繼 agent |
| `tools/diagnose-and-cleanup-cross-store-contamination.sql` | 跨店污染診斷／清理 |
| `docs/reviews/security-incident-2026-09-16.md` | 安全事件复盘 |
| `docs/pos-cross-store-isolation-fix-plan.md` | 跨店資料隔離修復計劃 |
| `src/app/api/members/route.ts` | 廢棄端點（410，保留擋舊呼叫） |
| `src/app/api/online-orders/route.ts` | 廢棄端點（410，保留擋舊呼叫） |



### 4.1 盤點中順帶發現的資安事實（供參考，不改动）

- **API 閘門覆蓋**：79 條 `route.ts` 中 **33 條**含明確鑑權呼叫（`readPosDeviceToken`／`readAdminSessionFromRequest`／`verifyAgent`／`verifyWebhookSignature`／限流等）；其餘多為刻意開放的 anon 讀窗口（RLS 時間窗）或 410 廢棄端點。
- **無硬編碼金鑰**：全庫 scan 無真實 JWT／service_role 值入庫。
- **`.env` 只有 `.example`**：`.gitignore` 正確排除 `.env`／`.env.local`，保留 `!.env.example`。
- ⚠️ `.workbuddy/` 與 `.workbuddy-ai/`（agent 記憶，共 87 檔）**已被 git 追蹤**，內含大量專案敏感上下文（store ID、專案 ref、內部決策）。不屬資安漏洞，但屬於「唔需要公開嘅資訊」，建議考慮移出版本庫（見 §7 T4）。

---

## 5. 無關檔（197 檔）逐組說明

| 組 | 規模 | 內容用途 | 判定為「無關」的理由 |
|---|---|---|---|
| `.workbuddy/**` | 66 檔／6.3 MB | 本 agent（WorkBuddy）的項目工作記憶、每日工作日誌、臨時截圖（`tmp/crops` 約 5 MB） | AI 協作過程數據，不參與建置／運行／測試；內容係決策記錄而唔係系統資產。⚠️ 已被 git 追蹤 |
| `.workbuddy-ai/**` | 21 檔／0.6 MB | 另一款 AI 工具（CodeBuddy）對同一專案的記憶（2026-08~10） | 同上；且工具已唔使用，屬歷史存檔 |
| `tools/**/*.out.txt`＋`_v.out`/`_v2.out` | 60 檔／1.4 MB | 歷次 DB 探測、測試、建置命令的 stdout 重定向存檔（最大：`_test-admin-20260930.out.txt` 492 KB、`_test-run-20260925.out.txt` 411 KB、`_v2.out` 301 KB） | 純輸出快照；結論已沉淀於 `docs/reviews/*` 同 memory，檔案本身不再被任何程式讀取 |
| `tools/tmp-e1.txt`、`tmp-e2.txt` | 2 檔／0.0 MB | 臨時 git log／commit hash 紀錄 | 一次性臨時紀錄，無引用 |
| `tools/_*pairs*.json` 等批次資料 | 32 檔／0.2 MB | i18n 翻譯批次（pairs/candidates/batch）與修補腳本的一次性輸入 | 批次工作已完成，資料不被現役工具讀取 |
| 根目錄 `_tmp_*`＋`.next-smoke.html` | 5 檔／0.0 MB | `_tmp_push.cjs`（git push 輔助）、`_tmp_verify_unit.cjs`（單元驗證）、`_tmp_wait.cjs`（等待）、`_tmp_member_mockup.html`（會員頁一次性稿）、`.next-smoke.html`（smoke 輸出） | 名稱已自標臨時；內容為當次任務的輔助稿，已被正式工具／mockup 取代 |
| `docs/mockups/_shots/**`＋`final2.log` | 4 檔／0.6 MB | 量度用臨時截圖與日誌 | 已被 `.gitignore` 明確排除（未入 git），屬生成過程副產品 |
| `public/{next,vercel,file,globe,window}.svg` | 5 檔／0.0 MB | create-next-app 範本預設圖示 | 全專案零引用（實測 `git grep` 五者皆 0 hit） |
| `tsconfig.tsbuildinfo`、`supabase/.temp/cli-latest` | 2 檔／0.2 MB | TS 增量編譯快照、Supabase CLI 版本標記 | 工具快取，可重生；已被 `.gitignore` 排除 |


---

## 6. 無法明確歸類（1 個）

| 檔案 | 大小 | 情況 | 建議 |
|---|---:|---|---|
| `0` | 0 B | 0 位元組空檔，無任何內容可判斷用途；於 commit `bae01f6`（庫存 P1）誤入庫 | 極可能係當年誤 `git add` 嘅產物。刪除功能上零風險，但因無法證實初衷，交 J 拍板 |


---

## 7. 待刪除建議（⚠️ 未經 J 確認，一個都未刪）

分四級。**T1 可直接刪；T2 建議先確認；T3 屬業務決策；T4 不建議刪。**

### T1 —— 零風險（73 檔／2.2 MB）

| 組 | 規模 | 為什麼零風險 |
|---|---|---|
| `tools/` 命令輸出（`*.out.txt`、`_v.out`、`_v2.out`） | 60 檔／1.4 MB | 純 stdout 存檔；無程式引用；資訊已沉淀於 docs/reviews |
| `tools/tmp-e1.txt`、`tmp-e2.txt` | 2 檔／0.0 MB | 臨時 git log 紀錄 |
| `tsconfig.tsbuildinfo` | 1 檔／0.2 MB | 編譯快取，`tsc` 自動重生；已被 gitignore |
| `supabase/.temp/cli-latest` | 1 檔／0.0 MB | CLI 版本標記，下次跑 CLI 自動重寫；已被 gitignore |
| `public/` 5 個範本 svg | 5 檔／0.0 MB | 零引用 |
| `docs/mockups/_shots/**`＋`final2.log` | 4 檔／0.6 MB | 未入 git 的臨時產物 |


### T2 —— 低風險：一次性產物（191 檔／0.8 MB）

| 組 | 規模 | 內容 | 刪除影響／相依風險 |
|---|---|---|---|
| 根目錄 `_tmp_*`＋`.next-smoke.html` | 5 檔／0.0 MB | 一次性輔助腳本／smoke 輸出 |
| i18n／修補批次資料（`_*pairs*.json` 等） | 32 檔／0.2 MB | 翻譯批次一次性輸入 |
| 一次性 `_` 前綴工具腳本（probe／analyze／egress／smoke／patch／batch 等，命名帶日期或編號） | 154 檔／0.7 MB | 2026-09~10 各次排查用的一次性取證腳本 |

> 保留清單（不刪）：`_add-i18n-keys.cjs`、`_cjk-audit.cjs`、`_t-keys-missing.cjs`（memory 記載的現役 i18n 工具鏈）、`_sdk_android.py`／`_sdk_iface.py`（SDK 文件分析）、`_find-macau-pos-apk.cjs`／`_classify-apk-shell.cjs`／`_apk-strings.cjs`／`_verify-print-agent-apk.cjs`（APK 審計工具鏈）。

### T3 —— 業務決策：大檔案／舊證據（301 檔／132.8 MB）

| 組 | 規模 | 刪除影響／相依風險 |
|---|---|---|
| `public/releases/Macau POS Desktop Setup 0.1.17.exe` | 1 檔／77.4 MB | 舊版安裝檔（已入 git）。`latest.yml`／`manifest.json` 只指向 0.1.18，electron-updater 只取最新版 ⇒ 刪除**不影響**自動更新；影響係 0.1.17 用戶無法官方回退安裝。可省約 77 MB |
| `docs/mockups/**` 證據檔（png/html） | 300 檔／55.4 MB | 各 plan／review 的附圖與設計稿（已入 git 266 檔）。多份 `docs/reviews/*.md` 內文引用佢哋做證據；刪除會令文檔失真。**10-01 前舊證據 108 檔／14.3 MB**；最大兩組 `i18n-verify-2026-10-07/08` 合共 74 檔／21.0 MB。最新 10-14／10-17 仍活躍，建議保留 |


### T4 —— 不建議刪除（87 檔／6.9 MB）

| 組 | 規模 | 建議 |
|---|---|---|
| `.workbuddy/**`＋`.workbuddy-ai/**` | 87 檔／6.9 MB | **不建議刪**：內含本專案兩年來嘅決策記錄（memory／DETAIL），有歷史價值。但已被 git 追蹤（87 檔／6.9 MB）且含大量內部上下文。建議改為「保留本地、移出版本庫」：`git rm -r --cached .workbuddy .workbuddy-ai` ＋ `.gitignore` 補兩行 |


### 執行前的最終檢查清單（刪前必做）

1. `git status` 確認工作區乾淨，先 commit／stash 在改文件。
2. T2 若要刪，用 `git rm` 而非只刪本地（否則 git 紀錄仍留完整歷史）。
3. 若要真正縮小 repo 體積（`.git` 大小），需重寫歷史（`git filter-repo`）——屬破壞性操作，必須 J 另行批准。
4. 刪完跑一次 `node --test` 確認測試仍全綠。

---

## 8. 附錄：完整檔案清單（1,698 個，含分類標籤）

> 標籤：`系`＝系統相關｜`資`＝資安相關｜`無`＝無關｜`?`＝無法明確歸類；方括號為刪除建議分級（T1–T4，無標記＝不建議刪）。本報告檔自身不列入。


#### `src/`（665 檔）

```
系         24.9 KB  src/app/admin/dashboard/page.tsx
系          4.7 KB  src/app/admin/page.tsx
系         17.7 KB  src/app/admin/reports/page.tsx
系         44.1 KB  src/app/admin/sessions/page.tsx
系         15.1 KB  src/app/admin/traffic/page.tsx
資          2.2 KB  src/app/admin/traffic/traffic-auth-contract.test.ts
系         27.7 KB  src/app/admin/versions/page.tsx
系          5.5 KB  src/app/api/admin/ledger/orders/route.ts
系          3.2 KB  src/app/api/admin/merchants/modules/route.ts
系         10.9 KB  src/app/api/admin/merchants/route.ts
系          2.5 KB  src/app/api/admin/merchants/status/route.ts
系          5.6 KB  src/app/api/admin/orders/route.ts
系         14.2 KB  src/app/api/admin/release-versions/route.ts
資          3.5 KB  src/app/api/admin/session/route.ts
資          5.7 KB  src/app/api/admin/sessions/route.ts
系          4.9 KB  src/app/api/admin/traffic/route.ts
資          0.7 KB  src/app/api/auth/login/route.ts
系          1.7 KB  src/app/api/backoffice/overview/route.ts
系          1.1 KB  src/app/api/backoffice/stores/[storeId]/route.ts
系          2.0 KB  src/app/api/desktop-release/route.ts
系         12.3 KB  src/app/api/integration/grabber/orders/route.ts
系         14.0 KB  src/app/api/integration/grabber/settlement/route.ts
系          4.2 KB  src/app/api/integration/grabber/store/route.ts
系          4.5 KB  src/app/api/integration/ledger/auto-accept/route.ts
系         12.1 KB  src/app/api/integration/ledger/offline-report/route.ts
系          2.3 KB  src/app/api/inventory/health/route.ts
系          8.0 KB  src/app/api/inventory/item-analysis/route.ts
系          3.4 KB  src/app/api/inventory/master-usage/route.ts
系          2.6 KB  src/app/api/inventory/merchants/[id]/route.ts
系          6.1 KB  src/app/api/inventory/merchants/route.ts
系          4.2 KB  src/app/api/inventory/payment-methods/route.ts
系          1.3 KB  src/app/api/inventory/products/[id]/adjust/route.ts
系          2.0 KB  src/app/api/inventory/products/[id]/route.ts
系          1.9 KB  src/app/api/inventory/products/route.ts
系          3.0 KB  src/app/api/inventory/products/sync-from-receipts/route.ts
系          6.7 KB  src/app/api/inventory/receipt-items/route.ts
系          7.7 KB  src/app/api/inventory/receipt-photos/route.ts
系          3.0 KB  src/app/api/inventory/receipt-photos/url/route.ts
系         11.5 KB  src/app/api/inventory/receipts/[id]/route.ts
系         17.0 KB  src/app/api/inventory/receipts/route.ts
系          0.4 KB  src/app/api/inventory/soldout/route.ts
系          6.5 KB  src/app/api/ledger/ensure-customer/route.ts
資         11.5 KB  src/app/api/ledger/login/route.ts
資          6.6 KB  src/app/api/ledger/member-login/route.ts
系          7.1 KB  src/app/api/ledger/scan-debit/commit/route.ts
系          4.9 KB  src/app/api/ledger/scan-debit/quote/route.ts
資          0.6 KB  src/app/api/members/route.ts
系          9.4 KB  src/app/api/online-order-settings/route.ts
資          0.5 KB  src/app/api/online-orders/route.ts
系          6.3 KB  src/app/api/pos/adopted-online-ids/route.ts
系          5.6 KB  src/app/api/pos/bootstrap/route.ts
系          5.3 KB  src/app/api/pos/device-config/route.ts
資          5.2 KB  src/app/api/pos/device-token/route.ts
系          3.6 KB  src/app/api/pos/grabber/capability/route.ts
系          2.6 KB  src/app/api/pos/grabber/count/route.ts
系         19.9 KB  src/app/api/pos/grabber/ingest/route.ts
系          5.0 KB  src/app/api/pos/kds/board/route.ts
系          6.5 KB  src/app/api/pos/kds/items/route.ts
系          7.2 KB  src/app/api/pos/kds/orders/route.ts
系         11.7 KB  src/app/api/pos/kiosk-settings/route.ts
系          4.6 KB  src/app/api/pos/note-presets/route.ts
系          6.6 KB  src/app/api/pos/order-lookup/route.ts
系          5.8 KB  src/app/api/pos/orders/route.ts
系          6.1 KB  src/app/api/pos/platform-settlements/route.ts
系          5.7 KB  src/app/api/pos/print-agent/claim/route.ts
系          6.4 KB  src/app/api/pos/print-agent/heartbeat/heartbeat-contract.test.ts
系          3.3 KB  src/app/api/pos/print-agent/heartbeat/route.ts
系          4.9 KB  src/app/api/pos/print-agent/pair-status/route.ts
系          4.3 KB  src/app/api/pos/print-agent/pair/pair-merchant-lookup.test.ts
系          9.1 KB  src/app/api/pos/print-agent/pair/route.ts
系          3.9 KB  src/app/api/pos/print-agent/result/route.ts
系          2.5 KB  src/app/api/pos/print-agent/unpair/route.ts
系          4.2 KB  src/app/api/pos/print-jobs/retry/route.ts
系          8.8 KB  src/app/api/pos/print-jobs/status/route.ts
系         13.5 KB  src/app/api/pos/print-templates/route.ts
資          5.6 KB  src/app/api/pos/realtime-bind/route.ts
系          2.7 KB  src/app/api/pos/sequence/route.ts
系         16.2 KB  src/app/api/pos/shift/route.ts
系         42.6 KB  src/app/api/pos/state/route.ts
系          4.0 KB  src/app/api/pos/state/state-egress-src.test.ts
系         11.0 KB  src/app/api/pos/state/state-incremental-contract.test.ts
系          6.6 KB  src/app/api/pos/store-status/route.ts
系        115.5 KB  src/app/api/pos/sync/route.ts
系          3.1 KB  src/app/api/pos/sync/sync-route-refund-columns.test.ts
系          3.3 KB  src/app/api/pos/sync/sync-route-write-gate.test.ts
系          3.5 KB  src/app/api/release/versions/active/route.ts
系          4.3 KB  src/app/api/salon/bootstrap/route.ts
系          7.6 KB  src/app/api/salon/state/route.ts
系         14.2 KB  src/app/api/salon/sync/route.ts
系          3.9 KB  src/app/api/topup/owner-embed/route.ts
資          7.5 KB  src/app/api/topup/owner/[...slug]/route.ts
系          3.9 KB  src/app/api/topup/pending-count/route.ts
系          0.7 KB  src/app/apple-icon.tsx
系          0.2 KB  src/app/backoffice/accounts/page.tsx
系          0.4 KB  src/app/backoffice/layout.tsx
系          0.1 KB  src/app/backoffice/page.tsx
系          0.4 KB  src/app/backoffice/stores/[storeId]/page.tsx
系          0.2 KB  src/app/backoffice/stores/page.tsx
系          0.2 KB  src/app/backoffice/sync/page.tsx
系          0.5 KB  src/app/expo/page.tsx
系         25.3 KB  src/app/favicon.ico
系         18.5 KB  src/app/globals.css
系          0.7 KB  src/app/icon.tsx
系          0.4 KB  src/app/inventory/page.tsx
系          0.6 KB  src/app/kitchen/page.tsx
系          5.4 KB  src/app/layout.tsx
系          0.1 KB  src/app/login/page.tsx
系          1.4 KB  src/app/manifest.ts
系          0.7 KB  src/app/members/page.tsx
系          0.7 KB  src/app/menu/page.tsx
系         30.9 KB  src/app/order/page.tsx
系          0.2 KB  src/app/orders/page.tsx
系          2.0 KB  src/app/page.tsx
系          1.5 KB  src/app/pos/page.tsx
系          0.2 KB  src/app/prints/page.tsx
系          0.9 KB  src/app/quick/page.tsx
系          6.5 KB  src/app/reports/bom/page.tsx
系          0.3 KB  src/app/reports/page.tsx
系          0.5 KB  src/app/retail/inventory/page.tsx
系          1.2 KB  src/app/retail/layout.tsx
系          0.5 KB  src/app/retail/page.tsx
系          0.3 KB  src/app/retail/products/page.tsx
系          0.6 KB  src/app/retail/returns/page.tsx
系          0.5 KB  src/app/retail/settings/page.tsx
系          0.5 KB  src/app/salon/booking/[id]/page.tsx
系          0.5 KB  src/app/salon/booking/new/page.tsx
系          0.4 KB  src/app/salon/calendar/page.tsx
系          0.6 KB  src/app/salon/checkout/[bookingId]/page.tsx
系          0.5 KB  src/app/salon/customers/[id]/page.tsx
系          0.5 KB  src/app/salon/customers/page.tsx
系          1.3 KB  src/app/salon/error.tsx
系          0.8 KB  src/app/salon/layout.tsx
系         17.8 KB  src/app/salon/online/page.tsx
系          0.3 KB  src/app/salon/page.tsx
系          0.5 KB  src/app/salon/prints/page.tsx
系          0.5 KB  src/app/salon/reports/page.tsx
系          0.5 KB  src/app/salon/settings/page.tsx
系          0.5 KB  src/app/salon/staff/[id]/page.tsx
系          0.5 KB  src/app/salon/staff/page.tsx
系          1.4 KB  src/app/select-workbench/page.tsx
系          0.2 KB  src/app/settings/page.tsx
系          0.2 KB  src/app/shift/page.tsx
系          0.2 KB  src/app/soldout/page.tsx
系          1.3 KB  src/app/staff/page.tsx
系          0.1 KB  src/app/topup/page.tsx
系         15.0 KB  src/components/admin-merchant-modules-dialog.tsx
系          5.3 KB  src/components/admin-shell.tsx
系          6.3 KB  src/components/app-download-button.tsx
系         13.1 KB  src/components/app-error-boundary.tsx
系         17.6 KB  src/components/app-sidebar.tsx
系          5.9 KB  src/components/app-update-panel.tsx
資          5.0 KB  src/components/auth-guard.tsx
系          5.0 KB  src/components/auto-accept-pill.tsx
系          5.3 KB  src/components/backoffice-accounts-page.tsx
系          4.4 KB  src/components/backoffice-shell.tsx
系         13.6 KB  src/components/backoffice-store-detail-page.tsx
系         12.8 KB  src/components/backoffice-stores-page.tsx
系          5.2 KB  src/components/backoffice-sync-page.tsx
系          3.9 KB  src/components/build-stale-banner.tsx
系          3.3 KB  src/components/build-version-row.tsx
系          0.5 KB  src/components/client-only.tsx
系          5.0 KB  src/components/compact-order-type-tabs.tsx
系         12.2 KB  src/components/date-range-filter-chips.tsx
系        220.7 KB  src/components/device-settings.tsx
系         16.8 KB  src/components/escpos-preview.tsx
系          2.9 KB  src/components/fixed-number-pad.tsx
系          1.0 KB  src/components/icons.tsx
系          7.0 KB  src/components/info-bubble.tsx
系          3.7 KB  src/components/input-pad-modal.tsx
系          2.8 KB  src/components/inventory/charts/AreaChart.tsx
系          3.2 KB  src/components/inventory/charts/DonutChart.tsx
系          2.8 KB  src/components/inventory/charts/LineChart.tsx
系          0.7 KB  src/components/inventory/charts/useChartWidth.ts
系         77.9 KB  src/components/inventory/inventory-contract-guard.test.ts
系         54.5 KB  src/components/inventory/inventory-settings-panel.tsx
系         28.7 KB  src/components/inventory/inventory-table.tsx
系        130.0 KB  src/components/inventory/inventory-view.tsx
系         35.6 KB  src/components/inventory/item-analysis-view.tsx
系          3.3 KB  src/components/inventory/payment-method-defaults-parity.test.ts
系          4.2 KB  src/components/ios-focus-helper.tsx
系          4.7 KB  src/components/item-spec-modal.tsx
系         20.7 KB  src/components/kds/expo-screen.tsx
系         23.4 KB  src/components/kds/kitchen-screen.tsx
系          6.5 KB  src/components/kds/station-picker.tsx
系          1.5 KB  src/components/kiosk-mode-gate.tsx
系          4.5 KB  src/components/kiosk-mode-panel.tsx
系          7.9 KB  src/components/kiosk-printer-panel.tsx
系          9.1 KB  src/components/kiosk-qr-panel.tsx
資         12.9 KB  src/components/kiosk/member-login-sheet.tsx
系         18.2 KB  src/components/kiosk/member-pay-sheet.tsx
系          2.8 KB  src/components/kiosk/order-summary-card.tsx
系          5.6 KB  src/components/kiosk/spec-sheet.tsx
系          3.9 KB  src/components/kitchen-ticket-preview.tsx
系          6.6 KB  src/components/lang-provider.tsx
系         69.0 KB  src/components/local-orders-panel.tsx
資         13.5 KB  src/components/login-screen.tsx
系         55.8 KB  src/components/member-topup-panel.tsx
系         35.8 KB  src/components/members-page.tsx
系         10.3 KB  src/components/merchant-open-pill.tsx
系          9.1 KB  src/components/merchant-order-config-section.tsx
系          1.8 KB  src/components/notice-focus-card.tsx
系          2.6 KB  src/components/number-input.tsx
系          2.3 KB  src/components/numeric-keypad.tsx
系          3.4 KB  src/components/online-open-pill.tsx
系         80.6 KB  src/components/online-orders.tsx
系          3.8 KB  src/components/online-reconcile-banner.tsx
系         11.5 KB  src/components/order-detail-list.tsx
系          5.6 KB  src/components/order-discount-display.tsx
系          1.6 KB  src/components/order-source-badge.tsx
系         12.7 KB  src/components/orders-hub.tsx
系          0.3 KB  src/components/pending-dot.tsx
系          3.6 KB  src/components/platform-fee-breakdown.tsx
系          6.3 KB  src/components/platform-settlement-breakdown.tsx
系          5.8 KB  src/components/pos-app-queue-identity.test.ts
系          3.7 KB  src/components/pos-app-stale-banner.test.ts
系          5.0 KB  src/components/pos-app-write-gate-client.test.ts
系        448.9 KB  src/components/pos-app.tsx
資          5.4 KB  src/components/pos-session-revoked-banner.tsx
系          1.5 KB  src/components/pos-sync-flush-worker.tsx
系          7.5 KB  src/components/pos-tools-menu.tsx
系        109.7 KB  src/components/print-center.tsx
系          2.1 KB  src/components/print-flush-worker.tsx
系         11.6 KB  src/components/printer-card-v2.tsx
系         26.5 KB  src/components/printer-companion-panel.tsx
系         42.1 KB  src/components/printer-wizard-modal.tsx
系          3.1 KB  src/components/purchase-currency-display.tsx
系          5.2 KB  src/components/pwa-install-button.tsx
系          2.5 KB  src/components/pwa-register.tsx
系         23.2 KB  src/components/quick-local-orders-strip.tsx
系          9.9 KB  src/components/quick-mode-orders-bar.tsx
系         52.6 KB  src/components/quick-online-orders-panel.tsx
系          3.0 KB  src/components/receipt-ticket-preview.tsx
系         20.9 KB  src/components/relay-pairing-panel.tsx
系          1.6 KB  src/components/reopen-badge.tsx
系          4.3 KB  src/components/responsive-modal.tsx
系        242.1 KB  src/components/restaurant-daily-report.tsx
系         55.4 KB  src/components/retail/retail-counter.tsx
系         14.2 KB  src/components/retail/retail-inventory.tsx
系         11.5 KB  src/components/retail/retail-label-print.tsx
系         28.6 KB  src/components/retail/retail-products.tsx
系         20.8 KB  src/components/retail/retail-returns.tsx
系         12.6 KB  src/components/retail/retail-settings.tsx
系          4.8 KB  src/components/retail/retail-sidebar.tsx
系         15.1 KB  src/components/retail/scanner-wizard.tsx
系         32.6 KB  src/components/salon/booking-form.tsx
系         18.6 KB  src/components/salon/calendar-board.tsx
系         68.7 KB  src/components/salon/checkout.tsx
系         33.7 KB  src/components/salon/customer-profile.tsx
系          7.3 KB  src/components/salon/customers-list.tsx
系         16.5 KB  src/components/salon/package-templates.tsx
系          5.5 KB  src/components/salon/prints-content.tsx
系          0.2 KB  src/components/salon/prints-list.tsx
系         13.8 KB  src/components/salon/reports.tsx
系          5.1 KB  src/components/salon/salon-sidebar.tsx
系         19.9 KB  src/components/salon/service-runner.tsx
系         56.9 KB  src/components/salon/settings.tsx
系         14.1 KB  src/components/salon/staff-detail.tsx
系          6.8 KB  src/components/salon/staff-list.tsx
系         13.7 KB  src/components/salon/workbench.tsx
系          8.5 KB  src/components/scan-mode-panel.tsx
系         36.0 KB  src/components/scan-order-page.tsx
系          5.1 KB  src/components/scheduled-pickup-badge.tsx
系         10.8 KB  src/components/select-workbench-screen.tsx
系          4.6 KB  src/components/self-order-action-buttons.tsx
系          3.8 KB  src/components/self-order-auto-accept-toggle.tsx
系          6.7 KB  src/components/self-order-notice-stack.tsx
系        169.2 KB  src/components/shift-page.tsx
系         17.9 KB  src/components/soldout-page.tsx
系         23.0 KB  src/components/staff/staff-mobile-app.tsx
系          4.4 KB  src/components/store-open-pill.tsx
系         29.2 KB  src/components/sync-health-modal.tsx
系          4.7 KB  src/components/table-assign-modal.tsx
系          6.2 KB  src/components/viewport-self-check.tsx
系          6.2 KB  src/components/workbench-picker.tsx
資         12.5 KB  src/lib/admin-account-server.ts
資          4.4 KB  src/lib/admin-session-token.ts
系          4.1 KB  src/lib/backoffice-client.ts
系          8.6 KB  src/lib/backoffice-server.ts
系          7.8 KB  src/lib/bootstrap-normalizer.ts
系          2.3 KB  src/lib/build-info-observe.ts
系          2.5 KB  src/lib/build-info-server.ts
系          8.3 KB  src/lib/build-info.test.ts
系          9.5 KB  src/lib/build-info.ts
系          3.0 KB  src/lib/csv-export.ts
系          1.8 KB  src/lib/egress-log-server.ts
系          3.2 KB  src/lib/egress-log.test.ts
系          2.7 KB  src/lib/egress-log.ts
系          3.0 KB  src/lib/escpos-qr.ts
系         15.8 KB  src/lib/escpos-render.ts
系         61.0 KB  src/lib/escpos-template.ts
系          8.2 KB  src/lib/expense-inventory.ts
系          1.6 KB  src/lib/expense-supabase.ts
系          4.7 KB  src/lib/format.ts
系         27.4 KB  src/lib/grabber/grabber-order.test.ts
系         26.9 KB  src/lib/grabber/grabber-order.ts
資          2.8 KB  src/lib/grabber/grabber-secret.test.ts
資          1.9 KB  src/lib/grabber/grabber-secret.ts
系        146.7 KB  src/lib/i18n-dict-en.ts
系        140.7 KB  src/lib/i18n-dict-zh.ts
系         53.6 KB  src/lib/i18n-layer-guard.test.ts
系          5.5 KB  src/lib/i18n.ts
系          7.1 KB  src/lib/image-compress-plan.test.ts
系          6.5 KB  src/lib/image-compress-plan.ts
系          6.5 KB  src/lib/image-compress.ts
系          3.9 KB  src/lib/inventory-item-suggestions.test.ts
系          3.6 KB  src/lib/inventory-item-suggestions.ts
系          3.7 KB  src/lib/inventory-order.test.ts
系          4.8 KB  src/lib/inventory-order.ts
系          9.2 KB  src/lib/inventory-p1-guard.test.ts
系         11.3 KB  src/lib/inventory-p2-guard.test.ts
系         24.3 KB  src/lib/inventory-p3-photo-guard.test.ts
系         18.3 KB  src/lib/inventory-products.ts
系          4.7 KB  src/lib/inventory-receipt-diff.test.ts
系          3.1 KB  src/lib/inventory-receipt-diff.ts
系         24.4 KB  src/lib/inventory-stats.ts
系          7.4 KB  src/lib/inventory-sync-diff.test.ts
系          4.8 KB  src/lib/inventory-sync-diff.ts
系         16.2 KB  src/lib/item-analysis.test.ts
系         16.0 KB  src/lib/item-analysis.ts
系          9.9 KB  src/lib/item-price-baseline.test.ts
系          8.0 KB  src/lib/item-price-baseline.ts
系          3.4 KB  src/lib/kds/device-binding.ts
系         15.2 KB  src/lib/kds/kds-board.test.ts
系         11.2 KB  src/lib/kds/kds-board.ts
系         10.1 KB  src/lib/kds/kds-server.ts
系          6.3 KB  src/lib/kds/stations.test.ts
系          5.6 KB  src/lib/kds/stations.ts
系          3.6 KB  src/lib/kds/types.ts
系         17.5 KB  src/lib/kds/use-kds-board.ts
系          8.3 KB  src/lib/kds/use-kds-realtime.ts
系          3.3 KB  src/lib/kiosk-cart.test.ts
系          3.4 KB  src/lib/kiosk-cart.ts
系         30.2 KB  src/lib/kiosk-order.ts
系          0.8 KB  src/lib/ledger/accept-idempotency.ts
資          2.3 KB  src/lib/ledger/admin-server.ts
系          4.0 KB  src/lib/ledger/auto-accept-sync.ts
系          1.9 KB  src/lib/ledger/checkout-member.ts
系          3.7 KB  src/lib/ledger/client-presence-params.ts
系          8.7 KB  src/lib/ledger/client-presence.test.ts
系          6.5 KB  src/lib/ledger/client-presence.ts
系          5.0 KB  src/lib/ledger/date-range.test.ts
系          6.4 KB  src/lib/ledger/date-range.ts
系          2.9 KB  src/lib/ledger/ensure-customer.ts
系         47.1 KB  src/lib/ledger/ledger-pos-bridge.ts
資          5.5 KB  src/lib/ledger/ledger-session-decision.test.ts
資          4.4 KB  src/lib/ledger/ledger-session-decision.ts
資          6.4 KB  src/lib/ledger/ledger-session-guard.test.ts
系          1.0 KB  src/lib/ledger/member-errors.ts
系          4.4 KB  src/lib/ledger/member-list.ts
資          3.5 KB  src/lib/ledger/member-login-limit.test.ts
資          5.0 KB  src/lib/ledger/member-login-limit.ts
資          9.3 KB  src/lib/ledger/member-login.server.ts
系          3.1 KB  src/lib/ledger/member-pay.test.ts
系          4.6 KB  src/lib/ledger/member-pay.ts
系          3.0 KB  src/lib/ledger/member-types.ts
系          4.1 KB  src/lib/ledger/members.ts
系         12.2 KB  src/lib/ledger/menu-import.ts
系          2.9 KB  src/lib/ledger/menu-spec.ts
系          6.9 KB  src/lib/ledger/menu.ts
系          8.0 KB  src/lib/ledger/online-order-actions.ts
系          7.5 KB  src/lib/ledger/order-actions.ts
系          6.5 KB  src/lib/ledger/order-config-parse.test.ts
系          7.6 KB  src/lib/ledger/order-config-parse.ts
系          5.0 KB  src/lib/ledger/order-config.ts
系          4.7 KB  src/lib/ledger/order-date-filter.ts
系         12.7 KB  src/lib/ledger/order-item-specs.test.ts
系         22.5 KB  src/lib/ledger/order-item-specs.ts
系         11.8 KB  src/lib/ledger/order-mapper.ts
系         14.7 KB  src/lib/ledger/orders.ts
系          6.4 KB  src/lib/ledger/paid-orders.ts
系          0.8 KB  src/lib/ledger/phone.ts
資          0.4 KB  src/lib/ledger/pin.server.ts
系          6.5 KB  src/lib/ledger/report-period.ts
系          7.7 KB  src/lib/ledger/report-range-criterion.test.ts
系          6.6 KB  src/lib/ledger/reports.ts
系          5.1 KB  src/lib/ledger/rewards.ts
資          4.9 KB  src/lib/ledger/scan-debit-crypto.test.ts
資          5.4 KB  src/lib/ledger/scan-debit-crypto.ts
資          9.3 KB  src/lib/ledger/scan-debit.server.ts
資          7.5 KB  src/lib/ledger/session.ts
系          2.4 KB  src/lib/ledger/supabase-client.ts
系          3.7 KB  src/lib/ledger/supabase-ledger-service.ts
資          1.2 KB  src/lib/ledger/supabase-server-auth.ts
系          8.6 KB  src/lib/ledger/use-ledger-orders-realtime.ts
系          6.6 KB  src/lib/ledger/use-ledger-products-realtime.ts
資          2.7 KB  src/lib/ledger/webhook-signature.ts
系         24.8 KB  src/lib/mock-data.ts
系          6.4 KB  src/lib/note-presets-server.ts
系          6.3 KB  src/lib/paper-columns.ts
系          6.0 KB  src/lib/platform-fee-pipeline.test.ts
系         35.1 KB  src/lib/platform-settlement-pipeline.test.ts
系         18.2 KB  src/lib/pos-order-filters.test.ts
系         29.6 KB  src/lib/pos-order-filters.ts
系         12.6 KB  src/lib/pos-order-row.test.ts
系         14.6 KB  src/lib/pos-order-row.ts
系          7.3 KB  src/lib/pos-orders-range.test.ts
系         14.0 KB  src/lib/pos-orders-range.ts
系         22.4 KB  src/lib/pos-orders.ts
系          4.8 KB  src/lib/pos/accept-outcome.test.ts
系          5.6 KB  src/lib/pos/accept-outcome.ts
系          4.0 KB  src/lib/pos/activity-tracker.ts
系          5.0 KB  src/lib/pos/adopt-completed-ledger-orders.test.ts
系          3.6 KB  src/lib/pos/adopt-completed-ledger-orders.ts
系          2.7 KB  src/lib/pos/adopted-online-ids.ts
系          9.7 KB  src/lib/pos/apply-workbench.ts
系          5.1 KB  src/lib/pos/backfill-guard.test.ts
系          6.8 KB  src/lib/pos/build-header-contract.test.ts
系          3.0 KB  src/lib/pos/close-gate-run.ts
系          4.1 KB  src/lib/pos/close-gate.test.ts
系          6.2 KB  src/lib/pos/close-gate.ts
系          4.2 KB  src/lib/pos/daily-order-seq.test.ts
系          3.8 KB  src/lib/pos/daily-order-seq.ts
系          2.9 KB  src/lib/pos/discount.ts
系          5.8 KB  src/lib/pos/display-floors.ts
系          6.9 KB  src/lib/pos/egress-meter-server.ts
系          7.0 KB  src/lib/pos/egress-usage.test.ts
系          8.6 KB  src/lib/pos/egress-usage.ts
系          1.9 KB  src/lib/pos/ios-keyboard.ts
系          6.1 KB  src/lib/pos/kiosk-outbox.ts
系          4.2 KB  src/lib/pos/kiosk-settings.test.ts
系         11.1 KB  src/lib/pos/kiosk-settings.ts
系          4.7 KB  src/lib/pos/kitchen-backfill.test.ts
系          4.4 KB  src/lib/pos/kitchen-backfill.ts
系          7.7 KB  src/lib/pos/ledger-online-range.test.ts
系          4.3 KB  src/lib/pos/merchant-modules-server.ts
系          6.9 KB  src/lib/pos/module-catalog.test.ts
系          9.0 KB  src/lib/pos/module-catalog.ts
系         66.2 KB  src/lib/pos/offline-report-guard.test.ts
系         67.6 KB  src/lib/pos/offline-report.test.ts
系         53.1 KB  src/lib/pos/offline-report.ts
系         10.3 KB  src/lib/pos/online-adopt-guard.test.ts
系          2.1 KB  src/lib/pos/online-dinein-fulfillment.test.ts
系          7.7 KB  src/lib/pos/online-dinein-fulfillment.ts
系          7.8 KB  src/lib/pos/online-dinein-labels.test.ts
系         10.4 KB  src/lib/pos/online-dinein-labels.ts
系          2.9 KB  src/lib/pos/online-dinein-ladder.test.ts
系          2.7 KB  src/lib/pos/online-dinein-ladder.ts
系          3.7 KB  src/lib/pos/online-quick-fulfillment.ts
系          3.8 KB  src/lib/pos/online-reconcile.test.ts
系          5.2 KB  src/lib/pos/online-reconcile.ts
系          6.8 KB  src/lib/pos/order-event-time.test.ts
系          5.5 KB  src/lib/pos/order-event-time.ts
資          2.6 KB  src/lib/pos/order-id-guard.test.ts
資          2.7 KB  src/lib/pos/order-id-guard.ts
系          8.2 KB  src/lib/pos/order-item-diff.test.ts
系          4.9 KB  src/lib/pos/order-item-diff.ts
系          1.9 KB  src/lib/pos/order-note-lock.ts
系          4.6 KB  src/lib/pos/order-notes.test.ts
系          3.0 KB  src/lib/pos/order-notes.ts
系          2.1 KB  src/lib/pos/order-only-terminal.test.ts
系          5.0 KB  src/lib/pos/order-only-terminal.ts
系          1.6 KB  src/lib/pos/order-source.ts
系          2.3 KB  src/lib/pos/order-status-label.test.ts
系          1.7 KB  src/lib/pos/order-status-label.ts
系          4.5 KB  src/lib/pos/orders-range-shared.ts
系          9.7 KB  src/lib/pos/payment-method-label.test.ts
系          3.7 KB  src/lib/pos/payment-method-label.ts
系          8.4 KB  src/lib/pos/platform-kitchen-print.test.ts
系          8.0 KB  src/lib/pos/platform-kitchen-print.ts
系          9.9 KB  src/lib/pos/platform-order-wiring.test.ts
系          5.3 KB  src/lib/pos/platform-order.test.ts
系          5.4 KB  src/lib/pos/platform-order.ts
系         24.2 KB  src/lib/pos/platform-settlement.test.ts
系         22.5 KB  src/lib/pos/platform-settlement.ts
系          6.3 KB  src/lib/pos/poll-gate-client.ts
系          8.1 KB  src/lib/pos/poll-gate.test.ts
系          8.7 KB  src/lib/pos/poll-gate.ts
系          8.6 KB  src/lib/pos/pos-app-queue-base.test.ts
系          4.5 KB  src/lib/pos/pos-deeplink-path.test.ts
資          5.6 KB  src/lib/pos/pos-device-token.ts
系         12.5 KB  src/lib/pos/pos-order-mapper.ts
資          4.7 KB  src/lib/pos/pos-route-auth.ts
資          6.3 KB  src/lib/pos/pos-sync-auth.ts
系          4.6 KB  src/lib/pos/print-agent-cadence.test.ts
系          5.1 KB  src/lib/pos/print-agent-cadence.ts
系         27.1 KB  src/lib/pos/print-and-order-realtime-guard.test.ts
系         11.6 KB  src/lib/pos/print-dedupe.test.ts
系         11.6 KB  src/lib/pos/print-dedupe.ts
系          5.3 KB  src/lib/pos/print-enqueue-callsites.test.ts
系          6.1 KB  src/lib/pos/print-job-enqueue.ts
系          2.8 KB  src/lib/pos/print-job-failure.test.ts
系          5.3 KB  src/lib/pos/print-job-failure.ts
系          2.7 KB  src/lib/pos/print-job-merge.test.ts
系          1.6 KB  src/lib/pos/print-job-merge.ts
系          5.1 KB  src/lib/pos/print-job-status.test.ts
系          4.5 KB  src/lib/pos/print-job-status.ts
系          5.1 KB  src/lib/pos/pwa-stale-table-guard.test.ts
系          5.0 KB  src/lib/pos/qr-print.ts
系         10.0 KB  src/lib/pos/queue-event-batch.test.ts
系          5.3 KB  src/lib/pos/queue-event-batch.ts
系         10.8 KB  src/lib/pos/queue-outbox.ts
資          3.4 KB  src/lib/pos/queue-signature.test.ts
資          2.7 KB  src/lib/pos/queue-signature.ts
系          1.7 KB  src/lib/pos/quick-labels.ts
系          2.4 KB  src/lib/pos/quick-scan-remembered-order.test.ts
系          4.6 KB  src/lib/pos/quick-scan-remembered-order.ts
資          1.7 KB  src/lib/pos/rate-limit.ts
資          8.2 KB  src/lib/pos/realtime-auth-claims.test.ts
資          7.8 KB  src/lib/pos/realtime-auth-claims.ts
資          9.5 KB  src/lib/pos/realtime-auth.ts
系         19.3 KB  src/lib/pos/realtime-resubscribe-loop.test.ts
系          9.2 KB  src/lib/pos/realtime-target.test.ts
系          8.0 KB  src/lib/pos/realtime-target.ts
系          9.6 KB  src/lib/pos/reopen-account-rows.test.ts
系          7.1 KB  src/lib/pos/reopen-account-rows.ts
系          2.2 KB  src/lib/pos/reopen-badge.test.ts
系          2.1 KB  src/lib/pos/reopen-badge.ts
系          3.3 KB  src/lib/pos/residual-channel.test.ts
系          3.2 KB  src/lib/pos/residual-channel.ts
系          5.8 KB  src/lib/pos/resubscribe-guard.test.ts
系          3.3 KB  src/lib/pos/resubscribe-guard.ts
系          2.0 KB  src/lib/pos/scan-mode-from-login.test.ts
系          2.9 KB  src/lib/pos/scan-mode-from-login.ts
系          5.2 KB  src/lib/pos/scheduled-pickup.test.ts
系          7.3 KB  src/lib/pos/scheduled-pickup.ts
系          6.7 KB  src/lib/pos/self-order-notice.test.ts
系          5.5 KB  src/lib/pos/self-order-notice.ts
系          5.3 KB  src/lib/pos/session-identity-guard.test.ts
資          2.3 KB  src/lib/pos/session-key.test.ts
資          4.9 KB  src/lib/pos/session-key.ts
資         16.6 KB  src/lib/pos/session-record.test.ts
資         19.0 KB  src/lib/pos/session-record.ts
資         11.1 KB  src/lib/pos/session-registry-server.ts
資          2.3 KB  src/lib/pos/session-revoked.test.ts
資          2.9 KB  src/lib/pos/session-revoked.ts
系          4.4 KB  src/lib/pos/settle-target.test.ts
系          2.9 KB  src/lib/pos/settle-target.ts
系          9.1 KB  src/lib/pos/settled-at-guard.test.ts
系          6.2 KB  src/lib/pos/single-flight.test.ts
系          3.4 KB  src/lib/pos/single-flight.ts
系          5.1 KB  src/lib/pos/soldout-display.test.ts
系          4.0 KB  src/lib/pos/soldout-display.ts
系          2.2 KB  src/lib/pos/soldout.ts
系          3.0 KB  src/lib/pos/spec-selection.ts
系          6.1 KB  src/lib/pos/staff-order.ts
系          3.5 KB  src/lib/pos/state-sync-client.ts
系          4.8 KB  src/lib/pos/state-sync-watermark.test.ts
系          6.4 KB  src/lib/pos/state-sync-watermark.ts
資          1.8 KB  src/lib/pos/store-id-guard.ts
系          3.8 KB  src/lib/pos/store-status.test.ts
系          6.0 KB  src/lib/pos/store-status.ts
系          1.2 KB  src/lib/pos/store-tel.ts
系          4.7 KB  src/lib/pos/supabase-client.ts
系         12.8 KB  src/lib/pos/sync-acks.ts
系         37.3 KB  src/lib/pos/sync-flush.ts
系          3.0 KB  src/lib/pos/sync-order-payload.test.ts
系          3.0 KB  src/lib/pos/sync-order-payload.ts
系         18.8 KB  src/lib/pos/sync-reconcile-daemon.ts
系         20.2 KB  src/lib/pos/sync-reconcile.ts
系          3.7 KB  src/lib/pos/table-order-badge.test.ts
系          2.7 KB  src/lib/pos/table-order-badge.ts
系          3.5 KB  src/lib/pos/table-scope.ts
系          8.0 KB  src/lib/pos/tooltip-placement.test.ts
系         10.2 KB  src/lib/pos/tooltip-placement.ts
系          7.2 KB  src/lib/pos/use-adopt-completed-ledger-orders.ts
系         22.9 KB  src/lib/pos/use-merchant-order-config.ts
系          1.7 KB  src/lib/pos/use-online-order-settings.ts
系          9.8 KB  src/lib/pos/use-pos-realtime.ts
系          5.4 KB  src/lib/pos/use-store-open-toggle.ts
系         14.8 KB  src/lib/pos/use-store-status.ts
系          3.5 KB  src/lib/pos/workbench-preference.ts
資          6.7 KB  src/lib/pos/write-gate.test.ts
資          6.3 KB  src/lib/pos/write-gate.ts
系          7.8 KB  src/lib/preview-fixtures.ts
資          4.4 KB  src/lib/print-agent-server.test.ts
資         10.5 KB  src/lib/print-agent-server.ts
系          1.9 KB  src/lib/print-bridge/auto-pair-companion.ts
系          1.3 KB  src/lib/print-bridge/companion-config.ts
系          3.4 KB  src/lib/print-bridge/companion-transport.ts
系         34.3 KB  src/lib/print-bridge/companion.ts
系          9.5 KB  src/lib/print-bridge/dispatch.ts
系          4.9 KB  src/lib/print-bridge/hub.ts
系          3.9 KB  src/lib/print-bridge/native-environment.ts
系         14.5 KB  src/lib/print-bridge/native.ts
系         44.2 KB  src/lib/print-bridge/printer-models.ts
系          6.3 KB  src/lib/print-bridge/printer-test-print.ts
系          2.6 KB  src/lib/print-bridge/relay-config.ts
系          1.5 KB  src/lib/print-bridge/relay-transport.ts
系         43.1 KB  src/lib/print-jobs.ts
系          3.5 KB  src/lib/print-templates-sync.ts
系          2.0 KB  src/lib/print-toggles.ts
系          3.1 KB  src/lib/purchase-currency.ts
系          8.2 KB  src/lib/purchase-items.test.ts
系          7.8 KB  src/lib/purchase-items.ts
系         12.2 KB  src/lib/qrcode.ts
系          4.5 KB  src/lib/quick-order-fulfillment.ts
系          7.6 KB  src/lib/receipt-timestamp.test.ts
系          5.0 KB  src/lib/receipt-timestamp.ts
系         11.0 KB  src/lib/receipt/subtotal-block.test.ts
系          8.1 KB  src/lib/receipt/subtotal-block.ts
系          7.7 KB  src/lib/refund-net.test.ts
系          4.1 KB  src/lib/refund-net.ts
系         13.4 KB  src/lib/release/release-core.test.ts
系         13.6 KB  src/lib/release/release-core.ts
系          9.2 KB  src/lib/release/release-row.test.ts
系          6.4 KB  src/lib/release/release-row.ts
系          6.7 KB  src/lib/release/release-server.ts
系          3.8 KB  src/lib/restaurant-bom.ts
系          5.5 KB  src/lib/restaurant-footfall.ts
系          9.7 KB  src/lib/retail/barcode-index.test.ts
系          7.1 KB  src/lib/retail/barcode-index.ts
系         12.0 KB  src/lib/retail/barcode-scanner-core.test.ts
系          7.7 KB  src/lib/retail/barcode-scanner-core.ts
系         13.1 KB  src/lib/retail/catalog-ops.test.ts
系         13.1 KB  src/lib/retail/catalog-ops.ts
系         14.4 KB  src/lib/retail/csv-import.test.ts
系         20.3 KB  src/lib/retail/csv-import.ts
系         10.4 KB  src/lib/retail/hold-orders.test.ts
系          6.4 KB  src/lib/retail/hold-orders.ts
系         13.5 KB  src/lib/retail/inventory-ops.test.ts
系         10.4 KB  src/lib/retail/inventory-ops.ts
系          9.0 KB  src/lib/retail/manual-scale.test.ts
系          6.7 KB  src/lib/retail/manual-scale.ts
系          3.9 KB  src/lib/retail/printer-roles.test.ts
系          3.7 KB  src/lib/retail/printer-roles.ts
系          7.8 KB  src/lib/retail/receipt-retail-blocks.test.ts
系          4.3 KB  src/lib/retail/receipt-retail-blocks.ts
系         15.7 KB  src/lib/retail/retail-cart.test.ts
系         14.7 KB  src/lib/retail/retail-cart.ts
系          7.8 KB  src/lib/retail/retail-label-content.test.ts
系          5.3 KB  src/lib/retail/retail-label-content.ts
系         11.1 KB  src/lib/retail/retail-orders.ts
系          9.1 KB  src/lib/retail/return-service.ts
系         24.9 KB  src/lib/retail/returns.test.ts
系         25.0 KB  src/lib/retail/returns.ts
系         12.6 KB  src/lib/retail/scanner-profiles.test.ts
系         18.7 KB  src/lib/retail/scanner-profiles.ts
系          9.4 KB  src/lib/retail/split-payment.test.ts
系          9.3 KB  src/lib/retail/split-payment.ts
系         11.6 KB  src/lib/retail/stock.test.ts
系          9.0 KB  src/lib/retail/stock.ts
系         12.3 KB  src/lib/retail/types.ts
系          4.8 KB  src/lib/retail/use-barcode-scanner.ts
系          7.6 KB  src/lib/retail/weighed-barcode.test.ts
系          8.1 KB  src/lib/retail/weighed-barcode.ts
系         11.7 KB  src/lib/salon/idb.ts
系          0.7 KB  src/lib/salon/industry-config.ts
系         16.8 KB  src/lib/salon/mock-data.ts
系          7.3 KB  src/lib/salon/mock-ledger.ts
系         10.1 KB  src/lib/salon/mock-realtime.ts
系          5.6 KB  src/lib/salon/orders.ts
系         13.3 KB  src/lib/salon/print.ts
系          6.3 KB  src/lib/salon/salon-labels.ts
系          1.6 KB  src/lib/salon/sound.ts
系         27.5 KB  src/lib/salon/storage.ts
系         26.1 KB  src/lib/salon/types.ts
系          1.7 KB  src/lib/salon/wages.ts
系         17.1 KB  src/lib/shift-sync.ts
系         77.3 KB  src/lib/storage.ts
系          1.3 KB  src/lib/store-display.ts
系          3.2 KB  src/lib/supabase-errors.ts
資          2.9 KB  src/lib/supabase-server.ts
系          2.8 KB  src/lib/topup/fetch-shop-id.server.ts
資          4.5 KB  src/lib/topup/owner-session.server.ts
資          6.1 KB  src/lib/topup/owner-session.test.ts
系          6.6 KB  src/lib/topup/pending-count-store.ts
系          0.8 KB  src/lib/topup/resolve-shop-id.ts
資          2.2 KB  src/lib/topup/sso.server.ts
系          0.9 KB  src/lib/topup/use-topup-pending-count.ts
系         80.4 KB  src/lib/types.ts
系          2.7 KB  src/lib/ui-preference.ts
系         77.3 KB  src/lib/use-kiosk-order.ts
系          1.9 KB  src/lib/use-network-online.ts
系          6.4 KB  src/lib/use-scan-order.ts
系         22.8 KB  src/lib/use-staff-order.ts
```

#### `docs/`（519 檔）

```
系          8.5 KB  docs/01-overall-system-design.md
系          3.5 KB  docs/02-system-overview.md
系          6.1 KB  docs/03-architecture-and-codebase.md
系          5.8 KB  docs/04-data-model-and-storage.md
系          6.0 KB  docs/05-pages-and-features.md
系          5.0 KB  docs/06-api-reference.md
系          3.8 KB  docs/07-development-setup.md
系          2.8 KB  docs/08-deployment-and-env.md
系          4.2 KB  docs/101-print-job-reprint-idempotent-fix.md
系          5.2 KB  docs/102-printed-terminal-state-plan.md
系          7.6 KB  docs/103-hub-null-header-and-reprint-root-cause.md
系         12.4 KB  docs/109-shift-sync-overtime-plan.md
系         28.2 KB  docs/110-self-order-member-login-plan.md
系         12.7 KB  docs/111-sync-queue-outbox-plan.md
系         16.2 KB  docs/112-order-sync-closed-loop-plan.md
系        210.1 KB  docs/113-agent-gotchas.md
系         17.2 KB  docs/114-receipt-divider-double-line-and-font-rootcause.md
系         29.8 KB  docs/115-scan-dine-in-vs-quick-plan.md
系         48.9 KB  docs/116-kds-kitchen-display-plan.md
系         28.9 KB  docs/117-kds-mockup.html
系         44.8 KB  docs/118-kds-ui-mockup.html
系         52.2 KB  docs/119-kds-ui-mockup-v2.html
系         53.2 KB  docs/120-kds-ui-mockup-v3.html
系         24.7 KB  docs/120-self-order-member-login-deduct-feasibility.md
系         68.5 KB  docs/121-kds-ui-mockup-v4.html
系         18.2 KB  docs/121-ledger-request-scan-login-deduct.md
系         17.4 KB  docs/122-customer-self-deduct-p2-proposal.md
資         25.4 KB  docs/123-pos-staff-pin-permission-feasibility.md
系         46.3 KB  docs/124-discount-note-mockup.html
系         86.3 KB  docs/124-retail-pos-plan.md
系          8.6 KB  docs/125-merchant-open-close-store-and-auto-accept.md
系         12.1 KB  docs/126-scan-debit-questions-to-ledger.md
資          8.7 KB  docs/127-login-workbench-permission-plan.md
系          8.7 KB  docs/128-date-range-custom-and-csv-export.md
系         19.8 KB  docs/129-scan-debit-v35-ledger-reply-analysis.md
系         23.6 KB  docs/130-member-login-payment-impl-plan.md
系         16.7 KB  docs/131-store-open-toggle.md
系         31.1 KB  docs/144-label-printer-separate-settings.md
系         11.2 KB  docs/145-ipad-home-app-keyboard-plan.md
系          8.3 KB  docs/146-app-download-version-control.md
系          7.9 KB  docs/147-build-stale-detection-coverage.md
系          6.3 KB  docs/148-ledger-client-presence-pos.md
系          7.1 KB  docs/149-inventory-supplier-itemrow-fix.md
系         10.3 KB  docs/150-ledger-offline-report-route.md
系         12.7 KB  docs/151-inventory-ux-5items-payment-master.md
系          9.2 KB  docs/152-inventory-ui-mockup-parity.md
系          8.9 KB  docs/153-ledger-offline-report-orders-dishes.md
系         55.6 KB  docs/154-ledger-offline-report-online-channel.md
系         17.6 KB  docs/155-ledger-offline-report-gap-plan-2026-10-08.md
系         50.4 KB  docs/26-beauty-salon-vertical.md
系          6.3 KB  docs/27-salon-pos-db-integration.md
系         22.7 KB  docs/28-salon-settings-redesign-and-packages.md
系          9.3 KB  docs/30-salon-loyalty-referral-birthday.md
系         15.5 KB  docs/31-salon-staff-wages-products-board.md
系          7.5 KB  docs/32-salon-ledger-integration-requirements.md
系         14.2 KB  docs/33-print-bridge-https-lan.md
系          6.9 KB  docs/34-on-prem-single-shop-deployment.md
系          9.3 KB  docs/35-cloudflare-tunnel-print-bridge.md
系         15.0 KB  docs/36-native-print-agent.md
系          6.9 KB  docs/37-apk-native-bridge-print-format.md
系         12.7 KB  docs/37-printjobs-backfill-rootcause-plan.md
系         15.5 KB  docs/38-reopen-reverse-settlement.md
系          2.9 KB  docs/39-ledger-reverse-adjust-rpc.md
系         12.2 KB  docs/40-customer-self-order-kiosk.md
系          4.4 KB  docs/41-kiosk-p1-implementation.md
系         14.4 KB  docs/41-print-integration-proposal.md
系          6.2 KB  docs/42-member-bulk-sync-feasibility.md
系         15.1 KB  docs/43-cross-platform-print-dual-path.md
系          9.1 KB  docs/44-packaging-feasibility.md
系         13.5 KB  docs/45-apk-dual-path-print-agent.md
系          7.0 KB  docs/46-cloud-print-relay-spec.md
系          9.6 KB  docs/47-desktop-companion-spec.md
系          7.6 KB  docs/48-desktop-shell-architecture.md
系          7.5 KB  docs/49-desktop-auto-update.md
系         17.2 KB  docs/50-desktop-modules-reeval.md
系          8.8 KB  docs/51-companion-web-integration.md
系         10.8 KB  docs/52-android-companion-usb.md
系         14.3 KB  docs/52-clear-delete-sync-consistency-plan.md
系          8.1 KB  docs/53-order-actions-status-receipt-template.md
系         11.8 KB  docs/54-print-copies-tables-occupancy-plan.md
系         10.4 KB  docs/55-android-template-driven.md
系          4.6 KB  docs/56-sync-delete-orders-scope.md
系          3.2 KB  docs/67-list-view-card-layout.md
系          8.1 KB  docs/68-stale-open-order-occupy-table.md
系         17.6 KB  docs/69-touch-ux-audit.md
系          8.1 KB  docs/70-template-font-size-mismatch.md
系         24.3 KB  docs/71-template-save-revert-troubleshoot-plan.md
系         19.6 KB  docs/72-usb-universal-plugandplay-plan.md
系          9.7 KB  docs/73-button-size-and-search-row-layout-plan.md
系          9.5 KB  docs/74-template-font-size-deformation-plan.md
系         11.1 KB  docs/75-sdk-line-spacing-analysis-plan.md
系         20.2 KB  docs/76-restaurant-daily-report-design.md
系         19.2 KB  docs/77-ledger-v3.2-integration-plan.md
系         15.1 KB  docs/77-restaurant-daily-report-mockup.html
系         11.9 KB  docs/78-member-list-and-add-via-topup.md
系          8.7 KB  docs/79-online-label-per-cup-plan.md
系         11.5 KB  docs/80-print-size-not-applied-and-deformation-fix.md
系         17.6 KB  docs/81-research-vs-docs80-diff-analysis-and-fix-plan.md
系         20.5 KB  docs/82-meituan-style-printer-setup-redesign.md
系         67.8 KB  docs/83-ledger-report-db-integration.md
系          9.7 KB  docs/84-ordered-note-lock.md
系         19.6 KB  docs/85-kiosk-self-order-plan.md
系         31.5 KB  docs/86-kiosk-self-order-v2-scope.md
系         27.1 KB  docs/87-kiosk-final-plan.md
系         30.1 KB  docs/87-pos-delivery-dispatch-integration.md
系          7.9 KB  docs/88-receipt-discount-section.md
系          7.4 KB  docs/90-receipt-optimization-57doc-style.md
系          7.0 KB  docs/91-comp-order.md
系         12.9 KB  docs/92-online-auto-accept-ledger-sync.md
系         18.3 KB  docs/94-ledger-report-api.md
系         29.0 KB  docs/95-receipt-print-fix.md
系         35.0 KB  docs/96-sunmi-print-relay-plan.md
系         18.6 KB  docs/97-cloud-relay-architecture.md
系         43.9 KB  docs/98-print-hub-no-jobs-investigation-plan.md
系         10.3 KB  docs/99-escpos-size-deformation-fix-plan.md
系         13.9 KB  docs/GRABBER_APK_INGEST_CONTRACT.md
系          4.7 KB  docs/README.md
系          0.1 KB  docs/admin-account-schema.sql
系          8.9 KB  docs/admin-store-id-migration-plan.md
系         12.1 KB  docs/database-review-2026-09-06.md
系          8.7 KB  docs/deployment-runbook-2026-09-06.md
系          3.1 KB  docs/diagnosis-2026-09-09-reprint-receipt-not-printing.md
系         12.7 KB  docs/diagnosis-2026-09-09-settings-notes-discounts-sync.md
系          7.0 KB  docs/diagnosis-2026-09-09-unsettled-orders.md
系          0.1 KB  docs/ecosystem-modules.md
系          6.4 KB  docs/handoff-print-divider-size.md
系         13.0 KB  docs/handoff-print-relay-printed-status.md
系          0.1 KB  docs/integration-guide.md
系          6.7 KB  docs/integration/README.md
系         17.5 KB  docs/integration/apk-optimization-handover-2026-09-21.md
系         18.9 KB  docs/integration/ecosystem-modules.md
系          5.0 KB  docs/integration/expense-recorder-2026-10-06-add-quantity-unit.sql
系         29.6 KB  docs/integration/ledger-client-api-v2-source.md
系         71.3 KB  docs/integration/ledger-client-api.md
系         23.5 KB  docs/integration/ledger-purchase-report-api.md
系         56.7 KB  docs/integration/ledger-purchase-report-reference-impl.md
系          4.1 KB  docs/integration/main-system-integration.md
系         13.5 KB  docs/integration/pos-member-system-requirements.md
系          8.9 KB  docs/integration/pos-offline-report-api.md
系         39.4 KB  docs/integration/pos-offline-report-channel-addendum-2026-10-07.md
系          9.5 KB  docs/integration/pos-offline-report-contract-review-2026-09-25.md
系          7.7 KB  docs/integration/pos-offline-report-reply-2026-09-25.md
系          9.9 KB  docs/integration/pos-offline-report-v1-addendum-2026-09-26.md
系         11.9 KB  docs/integration/pos-v3.4-partner-handover-customer-login.md
系          3.8 KB  docs/integration/pos-v3.5-partner-handover-scan-debit.md
系          8.9 KB  docs/integration/pos-v3.6-partner-handover-client-presence.md
系         15.1 KB  docs/integration/print-relay-device-config-runbook.md
資         17.4 KB  docs/integration/print-relay-hardening-brief.md
資          9.0 KB  docs/integration/print-relay-per-store-token-handover.md
系          7.4 KB  docs/integration/reply-device-config-step1-2026-09-18.md
系         23.7 KB  docs/integration/reply-relay-checklist-2026-09-17.md
系         44.1 KB  docs/inventory-four-changes-plan-2026-10-07.md
無[T1]    173.1 KB  docs/mockups/_shots/item-analysis-t7/v2-scr-desk.png
無[T1]    337.0 KB  docs/mockups/_shots/item-analysis-t7/v2-scr-fields.png
無[T1]     84.5 KB  docs/mockups/_shots/item-analysis-t7/v2-scr-mob.png
系[T3]     24.3 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/01-dinein-header-single-row.png
系[T3]     37.5 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/02-icon-menu-popover.png
系[T3]    109.3 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/03-quick-mode-orders-bar.png
系[T3]     22.0 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/10-settings-header-no-online-pill.png
系[T3]     68.6 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/11-orders-local-pill.png
系[T3]    101.4 KB  docs/mockups/accept-toggle-impl-verify-2026-09-15/12-settings-online-tab-pill-kept.png
系[T3]     40.0 KB  docs/mockups/accept-toggle-placement-2026-09-15-v2.html
系[T3]     28.4 KB  docs/mockups/accept-toggle-placement-2026-09-15-v3.html
系[T3]     35.3 KB  docs/mockups/accept-toggle-placement-2026-09-15.html
系[T3]     45.1 KB  docs/mockups/admin-pos-sessions-2026-09-22.html
系[T3]    184.2 KB  docs/mockups/admin-sessions-impl-verify-2026-09-22/admin-sessions-confirm.png
系[T3]    197.0 KB  docs/mockups/admin-sessions-impl-verify-2026-09-22/admin-sessions-detail.png
系[T3]    173.1 KB  docs/mockups/admin-sessions-impl-verify-2026-09-22/admin-sessions-list.png
系[T3]    112.1 KB  docs/mockups/admin-sessions-impl-verify-2026-09-22/pos-session-revoked-banner.png
系[T3]    307.4 KB  docs/mockups/app-download-version-control-verify-2026-09-23/01-login-desktop.png
系[T3]    306.1 KB  docs/mockups/app-download-version-control-verify-2026-09-23/02-login-android.png
系[T3]    295.1 KB  docs/mockups/app-download-version-control-verify-2026-09-23/03-login-no-release.png
系[T3]    107.3 KB  docs/mockups/app-download-version-control-verify-2026-09-23/04-admin-versions.png
系[T3]    113.7 KB  docs/mockups/app-download-version-control-verify-2026-09-23/05-admin-edit-open.png
系[T3]     85.3 KB  docs/mockups/build-header-from-shift-verify-2026-09-23.png
系[T3]     85.3 KB  docs/mockups/build-stale-banner-pos-verify-2026-09-23.png
系[T3]    671.4 KB  docs/mockups/compact-redesign-2026-10-14/design-full.png
系[T3]    797.6 KB  docs/mockups/compact-redesign-2026-10-14/design-v2-full.png
系[T3]     25.2 KB  docs/mockups/compact-redesign-2026-10-14/design-v2.html
系[T3]     24.8 KB  docs/mockups/compact-redesign-2026-10-14/design.html
系[T3]    100.4 KB  docs/mockups/compact-redesign-2026-10-14/part-1.png
系[T3]    124.5 KB  docs/mockups/compact-redesign-2026-10-14/part-2.png
系[T3]    100.3 KB  docs/mockups/compact-redesign-2026-10-14/part-3.png
系[T3]    116.8 KB  docs/mockups/compact-redesign-2026-10-14/part-4.png
系[T3]     88.1 KB  docs/mockups/compact-redesign-2026-10-14/part-5.png
系[T3]     84.0 KB  docs/mockups/compact-redesign-2026-10-14/part-6.png
系[T3]    132.6 KB  docs/mockups/compact-redesign-2026-10-14/v2-1.png
系[T3]    123.7 KB  docs/mockups/compact-redesign-2026-10-14/v2-2.png
系[T3]    107.2 KB  docs/mockups/compact-redesign-2026-10-14/v2-3.png
系[T3]    170.8 KB  docs/mockups/compact-redesign-2026-10-14/v2-4.png
系[T3]    121.8 KB  docs/mockups/compact-redesign-2026-10-14/v2-5.png
系[T3]     84.6 KB  docs/mockups/compact-redesign-2026-10-14/v2-6.png
系[T3]    110.2 KB  docs/mockups/egress-opt-verify-2026-09-21/01-收銀台-工作台選擇.png
系[T3]    373.1 KB  docs/mockups/egress-opt-verify-2026-09-21/02-點餐-桌台總覽.png
系[T3]    100.7 KB  docs/mockups/egress-opt-verify-2026-09-21/03-設置.png
系[T3]    131.4 KB  docs/mockups/egress-opt-verify-2026-09-21/04-報表.png
系[T3]     65.8 KB  docs/mockups/egress-opt-verify-2026-09-21/05-打印中心.png
系[T3]     72.3 KB  docs/mockups/egress-opt-verify-2026-09-21/06-訂單.png
系[T3]     63.1 KB  docs/mockups/egress-opt-verify-2026-09-21/07-會員.png
系[T3]     74.9 KB  docs/mockups/egress-opt-verify-2026-09-21/08-沽清.png
系[T3]    120.4 KB  docs/mockups/egress-opt-verify-2026-09-21/09-交班.png
系[T3]     95.0 KB  docs/mockups/egress-opt-verify-2026-09-21/10-庫存.png
系[T3]     21.3 KB  docs/mockups/egress-opt-verify-2026-09-21/11-線上菜單.png
系[T3]     56.4 KB  docs/mockups/egress-opt-verify-2026-09-21/12-後廚屏.png
系[T3]     47.2 KB  docs/mockups/egress-opt-verify-2026-09-21/13-出餐台屏.png
系[T3]     19.6 KB  docs/mockups/egress-opt-verify-2026-09-21/14-快餐模式.png
系[T3]     22.9 KB  docs/mockups/egress-opt-verify-2026-09-21/15-客人點餐頁.png
系[T3]     43.8 KB  docs/mockups/egress-opt-verify-2026-09-21/16-會員充值.png
系[T3]    383.6 KB  docs/mockups/egress-opt-verify-2026-09-21/17-登入頁.png
系[T3]    131.5 KB  docs/mockups/egress-opt-verify-2026-09-21/18-報表-文案已同步.png
系[T3]     65.8 KB  docs/mockups/egress-opt-verify-2026-09-21/19-打印中心-重驗.png
系[T3]     97.4 KB  docs/mockups/egress-opt-verify-2026-09-21/20-收銀台-重驗.png
系[T3]    543.6 KB  docs/mockups/entry-unified-01-root.png
系[T3]    147.7 KB  docs/mockups/entry-unified-02-pos.png
系[T3]   1065.2 KB  docs/mockups/i18n-verify-2026-10-07/01-select-workbench-en.png
系[T3]   1051.1 KB  docs/mockups/i18n-verify-2026-10-07/01-select-workbench-zh-Hant.png
系[T3]    324.2 KB  docs/mockups/i18n-verify-2026-10-07/02-settings-printers-en.png
系[T3]    323.3 KB  docs/mockups/i18n-verify-2026-10-07/02-settings-printers-zh-Hant.png
系[T3]    292.7 KB  docs/mockups/i18n-verify-2026-10-07/02a-settings-printers-top-en.png
系[T3]    327.0 KB  docs/mockups/i18n-verify-2026-10-07/02a-settings-printers-top-zh-Hant.png
系[T3]    292.7 KB  docs/mockups/i18n-verify-2026-10-07/02a2-settings-printer-cards-en.png
系[T3]    327.0 KB  docs/mockups/i18n-verify-2026-10-07/02a2-settings-printer-cards-zh-Hant.png
系[T3]    359.2 KB  docs/mockups/i18n-verify-2026-10-07/02b-settings-language-en.png
系[T3]    405.1 KB  docs/mockups/i18n-verify-2026-10-07/02b-settings-language-zh-Hant.png
系[T3]    358.9 KB  docs/mockups/i18n-verify-2026-10-07/02c-settings-toggles-en.png
系[T3]    406.1 KB  docs/mockups/i18n-verify-2026-10-07/02c-settings-toggles-zh-Hant.png
系[T3]    293.0 KB  docs/mockups/i18n-verify-2026-10-07/02d-settings-toggles-rows-en.png
系[T3]    323.3 KB  docs/mockups/i18n-verify-2026-10-07/02d-settings-toggles-rows-zh-Hant.png
系[T3]    293.0 KB  docs/mockups/i18n-verify-2026-10-07/02e-settings-companion-en.png
系[T3]    323.3 KB  docs/mockups/i18n-verify-2026-10-07/02e-settings-companion-zh-Hant.png
系[T3]    359.2 KB  docs/mockups/i18n-verify-2026-10-07/02f-settings-relay-en.png
系[T3]    383.9 KB  docs/mockups/i18n-verify-2026-10-07/02f-settings-relay-zh-Hant.png
系[T3]    223.3 KB  docs/mockups/i18n-verify-2026-10-07/03-pos-sidebar-en.png
系[T3]    220.6 KB  docs/mockups/i18n-verify-2026-10-07/03-pos-sidebar-zh-Hant.png
系[T3]    164.8 KB  docs/mockups/i18n-verify-2026-10-07/04-pos-mobile-en.png
系[T3]    164.2 KB  docs/mockups/i18n-verify-2026-10-07/04-pos-mobile-zh-Hant.png
系[T3]    225.4 KB  docs/mockups/i18n-verify-2026-10-08/10-pos-tables-en.png
系[T3]    217.5 KB  docs/mockups/i18n-verify-2026-10-08/10-pos-tables-zh-Hant.png
系[T3]    263.7 KB  docs/mockups/i18n-verify-2026-10-08/11-pos-order-a01-en.png
系[T3]    249.4 KB  docs/mockups/i18n-verify-2026-10-08/11-pos-order-a01-zh-Hant.png
系[T3]    274.7 KB  docs/mockups/i18n-verify-2026-10-08/12-pos-menu-panel-en.png
系[T3]    260.3 KB  docs/mockups/i18n-verify-2026-10-08/12-pos-menu-panel-zh-Hant.png
系[T3]    450.9 KB  docs/mockups/i18n-verify-2026-10-08/13-pos-checkout-en.png
系[T3]    420.5 KB  docs/mockups/i18n-verify-2026-10-08/13-pos-checkout-zh-Hant.png
系[T3]    276.4 KB  docs/mockups/i18n-verify-2026-10-08/20-orders-en.png
系[T3]    252.5 KB  docs/mockups/i18n-verify-2026-10-08/20-orders-zh-Hant.png
系[T3]    389.7 KB  docs/mockups/i18n-verify-2026-10-08/30-shift-en.png
系[T3]    384.9 KB  docs/mockups/i18n-verify-2026-10-08/30-shift-zh-Hant.png
系[T3]    365.7 KB  docs/mockups/i18n-verify-2026-10-08/40-reports-en.png
系[T3]    416.2 KB  docs/mockups/i18n-verify-2026-10-08/40-reports-zh-Hant.png
系[T3]    312.5 KB  docs/mockups/i18n-verify-2026-10-08/50-settings-en.png
系[T3]    333.1 KB  docs/mockups/i18n-verify-2026-10-08/50-settings-zh-Hant.png
系[T3]    344.1 KB  docs/mockups/i18n-verify-2026-10-08/51-settings-menu-en.png
系[T3]    372.7 KB  docs/mockups/i18n-verify-2026-10-08/51-settings-menu-zh-Hant.png
系[T3]    225.4 KB  docs/mockups/i18n-verify-2026-10-08/52-settings-floors-en.png
系[T3]    228.2 KB  docs/mockups/i18n-verify-2026-10-08/52-settings-floors-zh-Hant.png
系[T3]    185.2 KB  docs/mockups/i18n-verify-2026-10-08/53-settings-payment-en.png
系[T3]    180.9 KB  docs/mockups/i18n-verify-2026-10-08/53-settings-payment-zh-Hant.png
系[T3]    321.7 KB  docs/mockups/i18n-verify-2026-10-08/54-settings-online-en.png
系[T3]    351.0 KB  docs/mockups/i18n-verify-2026-10-08/54-settings-online-zh-Hant.png
系[T3]    330.6 KB  docs/mockups/i18n-verify-2026-10-08/55-settings-qr-en.png
系[T3]    377.1 KB  docs/mockups/i18n-verify-2026-10-08/55-settings-qr-zh-Hant.png
系[T3]    330.6 KB  docs/mockups/i18n-verify-2026-10-08/56-settings-language-en.png
系[T3]    377.1 KB  docs/mockups/i18n-verify-2026-10-08/56-settings-language-zh-Hant.png
系[T3]    176.2 KB  docs/mockups/i18n-verify-2026-10-08/60-members-en.png
系[T3]    183.0 KB  docs/mockups/i18n-verify-2026-10-08/60-members-zh-Hant.png
系[T3]    300.0 KB  docs/mockups/i18n-verify-2026-10-08/61-inventory-en.png
系[T3]    295.0 KB  docs/mockups/i18n-verify-2026-10-08/61-inventory-zh-Hant.png
系[T3]    276.3 KB  docs/mockups/i18n-verify-2026-10-08/62-soldout-en.png
系[T3]    276.7 KB  docs/mockups/i18n-verify-2026-10-08/62-soldout-zh-Hant.png
系[T3]    175.5 KB  docs/mockups/i18n-verify-2026-10-08/70-mobile-pos-en.png
系[T3]    162.3 KB  docs/mockups/i18n-verify-2026-10-08/70-mobile-pos-zh-Hant.png
系[T3]    160.1 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/inventory-en.png
系[T3]    155.4 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/inventory-zh-Hant.png
系[T3]    106.7 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/members-en.png
系[T3]    105.0 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/members-zh-Hant.png
系[T3]    158.7 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/orders-en.png
系[T3]    151.3 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/orders-zh-Hant.png
系[T3]    165.1 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/pos-en.png
系[T3]    162.3 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/pos-zh-Hant.png
系[T3]    226.4 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/reports-en.png
系[T3]    233.8 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/reports-zh-Hant.png
系[T3]    169.0 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/settings-en.png
系[T3]    167.8 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/settings-zh-Hant.png
系[T3]    175.8 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/shift-en.png
系[T3]    174.7 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/shift-zh-Hant.png
系[T3]    157.9 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/soldout-en.png
系[T3]    156.9 KB  docs/mockups/i18n-verify-2026-10-08/narrow-2026-10-08/soldout-zh-Hant.png
系[T3]    155.9 KB  docs/mockups/inventory-impl-2-2026-09-26/00-main.png
系[T3]    193.9 KB  docs/mockups/inventory-impl-2-2026-09-26/01-settings-two-panels.png
系[T3]    202.6 KB  docs/mockups/inventory-impl-2-2026-09-26/02-settings-four-panels.png
系[T3]    198.3 KB  docs/mockups/inventory-impl-2-2026-09-26/03-settings-dragging.png
系[T3]    187.2 KB  docs/mockups/inventory-impl-2-2026-09-26/04-settings-after-drag.png
系[T3]    165.2 KB  docs/mockups/inventory-impl-2-2026-09-26/05-receipt-modal-top.png
系[T3]    165.2 KB  docs/mockups/inventory-impl-2-2026-09-26/06-receipt-items-stepper.png
系[T3]     46.9 KB  docs/mockups/inventory-impl-2-2026-09-26/06b-receipt-modal-full.png
系[T3]     99.4 KB  docs/mockups/inventory-impl-2-2026-09-26/07-main-footnote.png
系[T3]      8.8 KB  docs/mockups/inventory-impl-2-2026-09-26/08-footnote-element.png
系[T3]     93.6 KB  docs/mockups/inventory-impl-verify-2026-09-25/00-pos-mounted.png
系[T3]    103.7 KB  docs/mockups/inventory-impl-verify-2026-09-25/01-inventory-main.png
系[T3]    121.9 KB  docs/mockups/inventory-impl-verify-2026-09-25/02-settings-supplier.png
系[T3]    120.4 KB  docs/mockups/inventory-impl-verify-2026-09-25/03-settings-category.png
系[T3]    116.4 KB  docs/mockups/inventory-impl-verify-2026-09-25/04-receipt-modal-top.png
系[T3]    114.0 KB  docs/mockups/inventory-impl-verify-2026-09-25/05-receipt-modal-items.png
系[T3]    114.9 KB  docs/mockups/inventory-impl-verify-2026-09-25/06-receipt-modal-item-focus.png
系[T3]     45.7 KB  docs/mockups/inventory-item-analysis-wireframe-2026-10-07.html
系[T3]     47.1 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-item.png
系[T3]    122.6 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-pay.png
系[T3]     68.6 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-receipt.png
系[T3]     91.5 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-set.png
系[T3]     86.1 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-stock.png
系[T3]     52.2 KB  docs/mockups/inventory-mockup-ref-2026-09-25/scr-sup.png
系[T3]    120.3 KB  docs/mockups/inventory-offline-nav-2026-10-12/00-video-sidebar-tap-inventory.png
系[T3]    411.4 KB  docs/mockups/inventory-offline-nav-2026-10-12/00-video-t016-shift-loading.png
系[T3]    108.8 KB  docs/mockups/inventory-offline-nav-2026-10-12/01-offline-click-inventory-stuck-on-shift.png
系[T3]      7.2 KB  docs/mockups/inventory-offline-nav-2026-10-12/02-offline-full-reload-stuck-loading.png
系[T3]    530.4 KB  docs/mockups/inventory-ui-diff-2026-09-25-preview.png
系[T3]    792.4 KB  docs/mockups/inventory-ui-diff-2026-09-25.html
系[T3]   1829.0 KB  docs/mockups/inventory-ui-diff-after-2026-09-26.html
系[T3]     34.5 KB  docs/mockups/inventory-ux-5items-2026-09-25.html
系[T3]    273.5 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/01-analysis-full.png
系[T3]    275.2 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/02-analysis-viewport.png
系[T3]    255.8 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/03-only-up.png
系[T3]    156.9 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/04-overview.png
系[T3]    106.1 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/05-mobile-analysis.png
系[T3]    307.6 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/06-mobile-cards.png
系[T3]    307.6 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/06b-mobile-cards-full.png
系[T3]    204.2 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/07-desktop-top.png
系[T3]    575.7 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/08-desktop-final.png
系[T3]     59.7 KB  docs/mockups/item-analysis-impl-verify-2026-10-07/09-empty-has-receipts.png
系[T3]     34.6 KB  docs/mockups/login-then-module-select-2026-09-13.html
系[T3]     77.9 KB  docs/mockups/mc-2026-10-17-v3/scr-card.png
系[T3]     97.2 KB  docs/mockups/mc-2026-10-17-v3/scr-modal.png
系[T3]     59.1 KB  docs/mockups/mc-2026-10-17-v3/scr-shift.png
系[T3]    131.9 KB  docs/mockups/member-login-payment-flow-2026-09-13.html
系[T3]     20.4 KB  docs/mockups/members-coupon-redeem-2026-10-12.html
系[T3]     25.4 KB  docs/mockups/orders-header-filter-inline-2026-09-12.html
系[T3]    121.7 KB  docs/mockups/p1-verify-2026-10-07/01-收據時間格式.png
系[T3]    115.8 KB  docs/mockups/p1-verify-2026-10-07/02-收據時間降級.png
系[T3]    103.2 KB  docs/mockups/p1-verify-2026-10-07/03-庫存表預設收合.png
系[T3]     96.1 KB  docs/mockups/p1-verify-2026-10-07/04-庫存表展開全部.png
系[T3]    140.4 KB  docs/mockups/p1-verify-2026-10-07/05-新增收據-品類必填.png
系[T3]    140.4 KB  docs/mockups/p1-verify-2026-10-07/06-品類必填擋儲存.png
系[T3]    115.2 KB  docs/mockups/p2-verify-2026-10-07/01-自動同步-無變化靜默.png
系[T3]    110.7 KB  docs/mockups/p2-verify-2026-10-07/02-自動同步-有變化提示.png
系[T3]    115.2 KB  docs/mockups/p2-verify-2026-10-07/03-手動同步-完整回饋.png
系[T3]     64.1 KB  docs/mockups/p2-verify-2026-10-07/04-品項分析-自動同步.png
系[T3]    116.9 KB  docs/mockups/p3-photo-verify-2026-10-07/01-modal-no-photo.png
系[T3]    116.2 KB  docs/mockups/p3-photo-verify-2026-10-07/02-modal-pending.png
系[T3]    117.2 KB  docs/mockups/p3-photo-verify-2026-10-07/03-modal-stored.png
系[T3]    118.8 KB  docs/mockups/p3-photo-verify-2026-10-07/04-layout-final.png
系[T3]     70.8 KB  docs/mockups/pos-app-split-baseline-2026-09-15/01-tables.png
系[T3]     89.6 KB  docs/mockups/pos-app-split-baseline-2026-09-15/02-open-table-modal.png
系[T3]     83.5 KB  docs/mockups/pos-app-split-baseline-2026-09-15/03-ordering.png
系          2.9 KB  docs/mockups/pos-app-split-baseline-2026-09-15/assertions.json
系[T3]     77.4 KB  docs/mockups/pos-app-split-baseline-2026-09-15/diag-after-open.png
系[T3]     89.6 KB  docs/mockups/pos-app-split-baseline-2026-09-15/diag-after-table.png
系[T3]     89.3 KB  docs/mockups/pos-app-split-baseline-2026-09-15/diag-full.png
系[T3]     93.5 KB  docs/mockups/pos-app-split-baseline-2026-09-15/full-dinein.png
系[T3]     33.0 KB  docs/mockups/purchase-items-multi-currency-2026-10-17.html
系[T3]     77.5 KB  docs/mockups/quick-mode-manual-update-and-reopen-2026-10-17.html
系[T3]     72.6 KB  docs/mockups/reopen-badge-position-20260918/00-cashier.png
系[T3]    338.8 KB  docs/mockups/reopen-badge-position-20260918/00-initial.png
系[T3]     72.6 KB  docs/mockups/reopen-badge-position-20260918/01-cashier.png
系[T3]     94.0 KB  docs/mockups/reopen-badge-position-20260918/01-orders-tab.png
系[T3]      2.0 KB  docs/mockups/reopen-badge-position-20260918/02-cell.png
系[T3]     26.2 KB  docs/mockups/reopen-badge-position-20260918/03-table.png
系[T3]     95.4 KB  docs/mockups/reopen-zone-impl-verify-2026-10-05/pos-reopen-zone-v1.png
系[T3]     94.9 KB  docs/mockups/reopen-zone-impl-verify-2026-10-05/pos-reopen-zone-v2-same-device.png
系[T3]     34.8 KB  docs/mockups/reopen-zone-layout-2026-10-05.html
系[T3]     27.8 KB  docs/mockups/report-purchase-layout-2026-10-05.html
系[T3]    737.7 KB  docs/mockups/report-purchase-layout-2026-10-05.png
系[T3]    138.0 KB  docs/mockups/responsive-huawei-2026-10-14/final/desktop-1440x900-en.png
系[T3]    106.1 KB  docs/mockups/responsive-huawei-2026-10-14/final/desktop-1440x900-zh-Hant.png
系[T3]    131.4 KB  docs/mockups/responsive-huawei-2026-10-14/final/desktop-1440x900.png
系[T3]    276.9 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-added.png
系[T3]    295.8 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-en-added.png
系[T3]    284.0 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-en-expanded.png
系[T3]    315.2 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-en.png
系[T3]    267.9 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-expanded.png
系[T3]    307.6 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600-zh-Hant.png
系[T3]    266.6 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-1000x600.png
系[T3]    205.2 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-portrait-600x1000-en.png
系[T3]    190.5 KB  docs/mockups/responsive-huawei-2026-10-14/final/huawei-portrait-600x1000-zh-Hant.png
系[T3]    410.1 KB  docs/mockups/responsive-huawei-2026-10-14/final/ipad-1080x810-en.png
系[T3]    303.0 KB  docs/mockups/responsive-huawei-2026-10-14/final/ipad-1080x810-zh-Hant.png
系[T3]    395.7 KB  docs/mockups/responsive-huawei-2026-10-14/final/ipad-1080x810.png
系[T3]    256.2 KB  docs/mockups/responsive-huawei-2026-10-14/final/narrow-900x600-en.png
系[T3]    253.7 KB  docs/mockups/responsive-huawei-2026-10-14/final/narrow-900x600-zh-Hant.png
系[T3]    286.2 KB  docs/mockups/responsive-huawei-2026-10-14/final/narrow-900x600.png
系[T3]    184.7 KB  docs/mockups/responsive-huawei-2026-10-14/final/portrait-600x1000.png
無[T1]      5.6 KB  docs/mockups/responsive-huawei-2026-10-14/final2.log
系[T3]     95.0 KB  docs/mockups/retail-pos-ui-2026-09-12.html
系[T3]     16.8 KB  docs/mockups/settings-header-online-order-toggle-2026-09-12.html
系[T3]     16.8 KB  docs/mockups/settings-header-store-open-pill-2026-09-14.html
系[T3]    143.9 KB  docs/mockups/settlement-impl-verify-2026-09-28/detail-settled.png
系[T3]    161.4 KB  docs/mockups/settlement-impl-verify-2026-09-28/report-mfood.png
系[T3]    127.7 KB  docs/mockups/shift-history-impl-verify-2026-09-15/01-initial.png
系[T3]    127.7 KB  docs/mockups/shift-history-impl-verify-2026-09-15/02-more.png
系[T3]    159.9 KB  docs/mockups/shift-history-impl-verify-2026-09-15/10-section-10days.png
系[T3]    160.1 KB  docs/mockups/shift-history-impl-verify-2026-09-15/11-section-20days.png
系[T3]    127.7 KB  docs/mockups/shift-history-impl-verify-2026-09-15/12-section-ipad1180.png
系[T3]    138.4 KB  docs/mockups/shift-history-impl-verify-2026-09-15/ipad-fix/desktop-1440.png
系[T3]    132.8 KB  docs/mockups/shift-history-impl-verify-2026-09-15/ipad-fix/ipad-1180.png
系[T3]    127.7 KB  docs/mockups/shift-history-impl-verify-2026-09-15/v2/01-initial.png
系[T3]    127.7 KB  docs/mockups/shift-history-impl-verify-2026-09-15/v2/02-more.png
系[T3]     18.2 KB  docs/mockups/shift-history-toolbar-pagination-2026-09-15.html
系[T3]    601.5 KB  docs/mockups/shift-inventory-expense-2026-10-05.png
系[T3]    518.0 KB  docs/mockups/shift-inventory-expense-full-2026-10-05.png
系[T3]    113.8 KB  docs/mockups/shots/qm-s1.png
系[T3]    144.0 KB  docs/mockups/shots/qm-s2.png
系[T3]    130.3 KB  docs/mockups/shots/qm-s3.png
系[T3]    111.9 KB  docs/mockups/shots/qm-s4.png
系[T3]    137.9 KB  docs/mockups/shots/qm-s5.png
系[T3]    124.8 KB  docs/mockups/shots/qm-s5b.png
系[T3]    153.7 KB  docs/mockups/shots/qm-s6.png
系[T3]    173.9 KB  docs/mockups/shots/qm-s7-b.png
系[T3]    167.8 KB  docs/mockups/shots/qm-s7-full.png
系[T3]    162.5 KB  docs/mockups/shots/qm-s7.png
系[T3]    115.0 KB  docs/mockups/shots/v2-a/reopen-zone-layout-2026-10-05--a-canvas.png
系[T3]    133.2 KB  docs/mockups/shots/v2-b/reopen-zone-layout-2026-10-05--b-canvas.png
系[T3]    117.8 KB  docs/mockups/shots/v2-c/reopen-zone-layout-2026-10-05--c-canvas.png
系[T3]     72.2 KB  docs/mockups/shots/v2-fit/scr-scr-a.png
系[T3]    153.0 KB  docs/mockups/shots/v3-a/reopen-zone-layout-2026-10-05--a-canvas.png
系[T3]    133.9 KB  docs/mockups/shots/v3-b/reopen-zone-layout-2026-10-05--b-canvas.png
系[T3]    118.5 KB  docs/mockups/shots/v3-c/reopen-zone-layout-2026-10-05--c-canvas.png
系[T3]    114.3 KB  docs/mockups/shots/zoneA/reopen-zone-layout-2026-10-05--a-canvas.png
系[T3]     20.2 KB  docs/mockups/sidebar-store-open-toggle-2026-09-14.html
系[T3]     45.9 KB  docs/mockups/staff-impl-01-tables.png
系[T3]     72.1 KB  docs/mockups/staff-impl-02-addon.png
系[T3]    551.0 KB  docs/mockups/staff-impl-03-workbench.png
系[T3]     67.1 KB  docs/mockups/staff-impl-04-order.png
系[T3]     81.0 KB  docs/mockups/staff-impl-05-confirm.png
系[T3]     67.1 KB  docs/mockups/staff-impl-06-stale-warning.png
系[T3]    147.7 KB  docs/mockups/staff-impl-07-escape-hatch.png
系[T3]    227.0 KB  docs/mockups/staff-mobile-01-login.png
系[T3]    102.7 KB  docs/mockups/staff-mobile-02-tables.png
系[T3]    117.7 KB  docs/mockups/staff-mobile-03-order.png
系[T3]     80.1 KB  docs/mockups/staff-mobile-04-cart.png
系[T3]     61.8 KB  docs/mockups/staff-mobile-05-confirm.png
系[T3]     80.7 KB  docs/mockups/staff-mobile-06-done.png
系[T3]     44.8 KB  docs/mockups/start-work-button-and-dismiss-2026-09-14.html
系[T3]    269.5 KB  docs/mockups/start-work-impl-verify-2026-09-14/01-未開工-彈窗.png
系[T3]    234.5 KB  docs/mockups/start-work-impl-verify-2026-09-14/02-飛航中.png
系[T3]    246.3 KB  docs/mockups/start-work-impl-verify-2026-09-14/03-落地.png
系[T3]    236.9 KB  docs/mockups/start-work-impl-verify-2026-09-14/04-收起後.png
系[T3]    254.0 KB  docs/mockups/start-work-impl-verify-2026-09-14/05-撳枱被擋.png
系[T3]     64.4 KB  docs/mockups/start-work-modal-fly-to-header-2026-09-14.html
系[T3]     25.4 KB  docs/mockups/table-order-no-badge-2026-09-22.html
系[T3]     51.8 KB  docs/mockups/table-order-no-badge-2026-09-22/01-floor1-grid.png
系[T3]    111.7 KB  docs/mockups/table-order-no-badge-2026-09-22/02-states-zoom.png
系[T3]    132.7 KB  docs/mockups/table-order-no-badge-2026-09-22/03-device-full.png
系[T3]     24.3 KB  docs/mockups/table-order-no-badge-2026-09-22/05-card-ordered.png
系[T3]     19.7 KB  docs/mockups/table-order-no-badge-2026-09-22/06-card-idle.png
系[T3]    114.6 KB  docs/mockups/unit-select-width-verify-2026-10-07/01-unit-select-fixed.png
系[T3]      4.2 KB  docs/mockups/unit-select-width-verify-2026-10-07/02-item-row.png
系[T3]     39.4 KB  docs/mockups/workbench-entry-in-orders-bar-2026-09-13.html
系         32.7 KB  docs/online-dinein-table-assign-plan-2026-09-12.md
資         12.3 KB  docs/pos-cross-store-isolation-fix-plan.md
系          0.1 KB  docs/pos-functional-review.md
系          0.9 KB  docs/pos-ledger-client-api.md
系          9.0 KB  docs/preview-static-fixture-2026-09-10.md
系          6.2 KB  docs/print-template-store-sync-2026-09-09.md
系         12.2 KB  docs/print-timeout-p2-claim-window-2026-09-15.md
系          6.5 KB  docs/reviews/action-now-print-fix-2026-09-16.md
資          4.3 KB  docs/reviews/admin-session-stuck-after-revoke-2026-09-22.md
系         12.2 KB  docs/reviews/after-close-calls-audit-2026-09-21.md
系         15.2 KB  docs/reviews/always-on-calls-inventory-2026-09-21.md
系          4.7 KB  docs/reviews/backfill-incident-2026-09-24.md
系          9.8 KB  docs/reviews/decisions-2026-09-15.md
系        100.8 KB  docs/reviews/diagnosis-relay-pairing-failed-2026-09-16.md
系          9.5 KB  docs/reviews/diagnosis-sunmi-relay-pairing-2026-09-16.md
系         23.2 KB  docs/reviews/dining-optimization-2026-09-15.md
系          6.0 KB  docs/reviews/egress-closed-hours-and-claim-cadence-2026-09-22.md
系         31.1 KB  docs/reviews/egress-optimization-implemented-2026-09-21.md
系         16.1 KB  docs/reviews/egress-optimization-plan-2026-09-21.md
系         12.1 KB  docs/reviews/egress-p0-p4-and-traffic-dashboard-2026-09-22.md
系          9.1 KB  docs/reviews/egress-post-fix-recheck-2026-09-22.md
系         15.8 KB  docs/reviews/egress-redesign-local-first-2026-09-22.md
資          9.9 KB  docs/reviews/env-secrets-and-flags-2026-09-15.md
系         57.9 KB  docs/reviews/errwarn-and-call-audit-2026-09-21.md
系          3.4 KB  docs/reviews/functional-review.md
系          8.2 KB  docs/reviews/incident-2026-09-15-print-outage.md
系         12.5 KB  docs/reviews/log-error-triage-and-order-loss-2026-09-22.md
系         28.7 KB  docs/reviews/online-order-kitchen-print-audit-2026-09-12.md
系         13.0 KB  docs/reviews/optimization-safety-review-2026-09-23.md
系         22.6 KB  docs/reviews/order-001-dup-print-and-002-delay-2026-09-25.md
系          7.9 KB  docs/reviews/order-001-fix-delivery-2026-09-24.md
系          7.0 KB  docs/reviews/order-001-missing-from-report-2026-09-24.md
系         14.5 KB  docs/reviews/order19-and-receipt-print-2026-09-22.md
系         13.4 KB  docs/reviews/page-load-calls-and-herd-2026-09-21.md
資         18.1 KB  docs/reviews/per-store-token-assessment-2026-09-23.md
系          8.9 KB  docs/reviews/pos-app-split-plan-2026-09-15.md
系         17.9 KB  docs/reviews/print-out-failure-and-latency-2026-09-22.md
系         14.3 KB  docs/reviews/print-timeout-feasibility-2026-09-15.md
系          9.7 KB  docs/reviews/project-wide-optimization-scope-2026-09-21.md
系         49.0 KB  docs/reviews/qr-self-order-audit-2026-09-10.md
系         10.1 KB  docs/reviews/quarantine-removal-offline-sync-2026-09-22.md
系         14.3 KB  docs/reviews/recheck-2026-09-23-egress-and-relay.md
系          7.2 KB  docs/reviews/recheck-2026-09-24-egress-business-hours.md
系          7.0 KB  docs/reviews/refund-bubble-preview-2026-09-28.html
系         14.8 KB  docs/reviews/reopen-cross-device-impact-2026-10-05.md
資         28.9 KB  docs/reviews/security-incident-2026-09-16.md
資         20.4 KB  docs/reviews/session-and-write-gate-design-2026-09-21.md
系         27.5 KB  docs/reviews/supabase-egress-root-cause-2026-09-21.md
系         32.7 KB  docs/reviews/system-audit-2026-09-15.md
系        543.1 KB  docs/reviews/table-flash-2026-09-22/01_t4.0_orders_list.png
系        413.7 KB  docs/reviews/table-flash-2026-09-22/02_t5.0_table_A03_occupied.png
系        421.7 KB  docs/reviews/table-flash-2026-09-22/03_t5.2_table_A03_occupied.png
系        405.0 KB  docs/reviews/table-flash-2026-09-22/04_t5.4_table_A03_gone.png
系        422.9 KB  docs/reviews/table-flash-2026-09-22/05_t6.4_table_all_free.png
系          6.5 KB  docs/reviews/table-flash-quarantine-2026-09-22.md
系         15.7 KB  docs/shift-template-2026-09-10.md
系         43.1 KB  docs/sql/83-ledger-readonly-access.sql
系         28.6 KB  docs/sql/94-ledger-report-api.sql
系          4.4 KB  docs/sql/admin-account-schema.sql
系         35.9 KB  docs/staff-mobile-ordering-mockup.html
系         22.6 KB  docs/staff-mobile-ordering-plan-2026-09-16.md
系          0.1 KB  docs/system-overview.md
```

#### `tools/`（320 檔）

```
系          1.7 KB  tools/2026-09-09-diagnose-svc-tax-ratio.sql
系          7.0 KB  tools/2026-09-09-repair-stuck-open-orders.sql
系          1.3 KB  tools/2026-09-09-verify-fix.sql
系          0.6 KB  tools/2026-09-09-verify-svc-tax-fields.sql
系          1.2 KB  tools/2026-09-09-verify-total-sum.sql
系          8.8 KB  tools/2026-09-11-check-pos-realtime.mjs
系          6.2 KB  tools/2026-09-11-measure-kds-layout.js
系         13.6 KB  tools/2026-09-11-smoke-check-html-mockup.js
系          4.6 KB  tools/2026-09-11-verify-kds-screens.js
系          4.8 KB  tools/2026-09-11-verify-pos-realtime.sql
系          5.3 KB  tools/2026-09-12-diagnose-kitchen-print.js
系          5.6 KB  tools/2026-09-15-diagnose-failed-without-reason.sql
系          4.4 KB  tools/2026-09-15-probe-print-jobs.cjs
系          7.6 KB  tools/2026-09-15-void-stale-pending-print-jobs.sql
系          4.9 KB  tools/2026-09-24-fix-backfill-overwritten-orders.sql
系         11.0 KB  tools/2026-09-24-print-once-key-collision.sql
系          3.6 KB  tools/_add-i18n-keys.cjs
系[T2]      7.3 KB  tools/_analyze-logs-20260922-2016.cjs
無[T1]     24.2 KB  tools/_analyze-logs-20260922-2016.out.txt
系[T2]      6.7 KB  tools/_analyze-logs-20260922-2016b.cjs
無[T1]     22.9 KB  tools/_analyze-logs-20260922-2016b.out.txt
系[T2]      5.8 KB  tools/_analyze-supabase-logs-20260921.cjs
系          3.1 KB  tools/_apk-strings.cjs
系[T2]      1.4 KB  tools/_apply-map.cjs
無[T2]      5.2 KB  tools/_batch3-pairs.json
無[T2]      5.4 KB  tools/_batch4-pairs.json
無[T2]      9.4 KB  tools/_batch5-en.txt
無[T2]      9.4 KB  tools/_batch5-pairs.json
無[T2]      8.7 KB  tools/_batch5-zh.txt
無[T2]     18.6 KB  tools/_batch6-en.txt
無[T2]     18.6 KB  tools/_batch6-pairs.json
無[T2]     17.6 KB  tools/_batch6-zh.txt
系[T2]      5.1 KB  tools/_batch7-fix.cjs
系[T2]      2.1 KB  tools/_batch7-tighten.cjs
無[T1]      3.8 KB  tools/_build-run-20260925.out.txt
系[T2]      1.3 KB  tools/_check-keys.cjs
系[T2]      5.8 KB  tools/_child-components-patch.cjs
系          0.8 KB  tools/_cjk-audit.cjs
系          4.6 KB  tools/_classify-apk-shell.cjs
無[T2]      1.0 KB  tools/_coupon-redeem-pairs.json
無[T2]      1.3 KB  tools/_currency-pairs.json
系[T2]      1.4 KB  tools/_dict-keys.cjs
系[T2]      4.7 KB  tools/_egen-estimate-20260921.cjs
系[T2]      4.7 KB  tools/_egress-aggregate-20260921.cjs
系[T2]      5.0 KB  tools/_egress-byip-20260922.cjs
無[T1]      3.0 KB  tools/_egress-byip-20260922.out.txt
系[T2]      3.9 KB  tools/_egress-closed-window-20260922.cjs
系[T2]      8.2 KB  tools/_egress-deep-20260922.cjs
無[T1]      7.1 KB  tools/_egress-deep-20260922.out.txt
系[T2]      9.0 KB  tools/_egress-recheck-20260922.cjs
無[T1]     16.4 KB  tools/_egress-recheck-20260922.out.txt
系[T2]      3.3 KB  tools/_egress-who-20260921.cjs
系[T2]      3.5 KB  tools/_errwarn-recheck-20260921.cjs
系          5.1 KB  tools/_find-macau-pos-apk.cjs
系[T2]      2.4 KB  tools/_find-t-scope.cjs
系[T2]      4.0 KB  tools/_fullstate-bursts-20260921.cjs
無[T1]      0.1 KB  tools/_fullsuite-20260929.out.txt
系[T2]      5.0 KB  tools/_gen-i18n-batch.cjs
系[T2]      6.9 KB  tools/_grab-tablet-flash.cjs
系[T2]      6.5 KB  tools/_i18n-inventory.cjs
系[T2]      4.0 KB  tools/_i18n-probe-order.mjs
系[T2]     21.9 KB  tools/_i18n-shots2.mjs
無[T2]      0.2 KB  tools/_l.json
無[T2]      2.8 KB  tools/_ledger-errors-pairs.json
無[T2]      4.3 KB  tools/_local-orders-pairs.json
無[T2]      0.2 KB  tools/_local-orders-pairs2.json
系[T2]      2.6 KB  tools/_online-orders-code-label.cjs
無[T2]     10.1 KB  tools/_online-orders-pairs.json
無[T2]      1.1 KB  tools/_online-orders-pairs2.json
系[T2]     13.3 KB  tools/_online-orders-patch.cjs
系[T2]      4.4 KB  tools/_online-orders-tref.cjs
無[T2]      0.5 KB  tools/_orders-hub-pairs.json
系[T2]     13.8 KB  tools/_p2b-templates.cjs
無[T2]      2.7 KB  tools/_p3-candidates.json
無[T2]      0.3 KB  tools/_p3-pairs-b.json
無[T2]      4.6 KB  tools/_p3-pairs.json
系[T2]      9.3 KB  tools/_p3-patch.cjs
系[T2]      1.5 KB  tools/_poll-build.cjs
系[T2]      2.6 KB  tools/_probe-20260924.cjs
系[T2]      4.2 KB  tools/_probe-41ccd63c-20260922.cjs
無[T1]      4.5 KB  tools/_probe-41ccd63c-20260922.out.txt
系[T2]      4.8 KB  tools/_probe-7day-sum-20260929.cjs
無[T1]      2.2 KB  tools/_probe-7day-sum-20260929.out.txt
系[T2]      5.0 KB  tools/_probe-adminstats-20260930.cjs
無[T1]      0.7 KB  tools/_probe-adminstats-20260930.out.txt
系[T2]      3.2 KB  tools/_probe-agent-contract-20260918.cjs
系[T2]      2.8 KB  tools/_probe-anon-scope-20260917.cjs
系[T2]      4.7 KB  tools/_probe-aomi-e2e-20261013.cjs
系[T2]      4.2 KB  tools/_probe-aomi-final-20261013.cjs
系[T2]      2.5 KB  tools/_probe-aomi-final2-20261013.cjs
系[T2]      2.2 KB  tools/_probe-aomi-pushlog-20261013.cjs
系[T2]      2.7 KB  tools/_probe-aomi-raw-20261013.cjs
系[T2]      5.4 KB  tools/_probe-aomi-settlement-20260929.cjs
無[T1]      0.8 KB  tools/_probe-aomi-settlement-20260929.out.txt
系[T2]      2.8 KB  tools/_probe-aomi-time-20261013.cjs
系[T2]      2.1 KB  tools/_probe-aomi-time2-20261013.cjs
系[T2]      2.7 KB  tools/_probe-apk-vs-ext-20261013.cjs
系[T2]      3.4 KB  tools/_probe-auth-state-20260917.cjs
系[T2]      4.3 KB  tools/_probe-backfill-damage-20260924.cjs
無[T1]      3.0 KB  tools/_probe-backfill-damage-20260924.out.txt
系[T2]      7.3 KB  tools/_probe-badge-overlap.cjs
系[T2]      3.4 KB  tools/_probe-daily-20260924.cjs
系[T2]      1.3 KB  tools/_probe-deploy-check-20260924.cjs
系[T2]      2.7 KB  tools/_probe-deploy-sha-20260917.cjs
系[T2]      7.2 KB  tools/_probe-device-config-step1-20260918.cjs
系[T2]      4.6 KB  tools/_probe-dup-after-backfill-20260924.cjs
無[T1]      5.1 KB  tools/_probe-dup-after-backfill-20260924.out.txt
系[T2]      5.5 KB  tools/_probe-dup-receipt-20260921.cjs
系[T2]      4.1 KB  tools/_probe-dup-receipt2-20260921.cjs
系[T2]      3.7 KB  tools/_probe-dup-receipt4-20260921.cjs
系[T2]      7.1 KB  tools/_probe-dupkitchen-20260924.cjs
無[T1]     16.5 KB  tools/_probe-dupkitchen-20260924.out.txt
系[T2]      3.5 KB  tools/_probe-dupkitchen2-20260924.cjs
無[T1]      0.9 KB  tools/_probe-dupkitchen2-20260924.out.txt
系[T2]      2.9 KB  tools/_probe-dupkitchen3-20260924.cjs
無[T1]      2.6 KB  tools/_probe-dupkitchen3-20260924.out.txt
系[T2]      2.6 KB  tools/_probe-find001-20260924.cjs
無[T1]      0.8 KB  tools/_probe-find001-20260924.out.txt
系[T2]      2.8 KB  tools/_probe-grabber-dup-20261007.cjs
系[T2]      2.9 KB  tools/_probe-grabber-dup2-20261007.cjs
無[T1]      1.8 KB  tools/_probe-grabber-e2e-20261006-after.out.txt
系[T2]      3.5 KB  tools/_probe-grabber-e2e-20261006.cjs
無[T1]      1.8 KB  tools/_probe-grabber-e2e-20261006.out.txt
系[T2]      3.0 KB  tools/_probe-grabber-items-20261006.cjs
系[T2]      4.7 KB  tools/_probe-grabber-oldorders-20260929.cjs
無[T1]      0.9 KB  tools/_probe-grabber-oldorders-20260929.out.txt
系[T2]      4.9 KB  tools/_probe-grabber-oldorders2-20260929.cjs
無[T1]      0.7 KB  tools/_probe-grabber-oldorders2-20260929.out.txt
系[T2]      4.5 KB  tools/_probe-grabber-oldorders3-20260929.cjs
無[T1]      0.8 KB  tools/_probe-grabber-oldorders3-20260929.out.txt
系[T2]      4.8 KB  tools/_probe-grabber-provenance-20261006.cjs
無[T1]      1.3 KB  tools/_probe-grabber-provenance-20261006.out.txt
系[T2]      3.3 KB  tools/_probe-grabber-pushlog-20261007.cjs
系[T2]      2.7 KB  tools/_probe-grabber-rawjson-20261006.cjs
系[T2]      2.7 KB  tools/_probe-grabber-tableexist-20261006.cjs
無[T1]      0.5 KB  tools/_probe-grabber-tableexist-20261006.out.txt
系[T2]      2.6 KB  tools/_probe-grabber-tables-20260929.cjs
無[T1]      0.1 KB  tools/_probe-grabber-tables-20260929.out.txt
系[T2]      2.9 KB  tools/_probe-grabber-tables-20261006.cjs
無[T1]      0.8 KB  tools/_probe-grabber-tables-20261006.out.txt
系[T2]      2.5 KB  tools/_probe-jobs-20260916.cjs
系[T2]      2.8 KB  tools/_probe-ledger-20260925.cjs
無[T1]      0.3 KB  tools/_probe-ledger-20260925.out.txt
系[T2]      1.9 KB  tools/_probe-ledger-orders-20260925.cjs
系[T2]      3.4 KB  tools/_probe-ledger001-20260924.cjs
無[T1]      0.1 KB  tools/_probe-ledger001-20260924.out.txt
系[T2]      2.1 KB  tools/_probe-ledgerkeys-20260924.cjs
無[T1]      0.9 KB  tools/_probe-ledgerkeys-20260924.out.txt
系[T2]      1.4 KB  tools/_probe-ledgerrpc-20260924.cjs
無[T1]      0.1 KB  tools/_probe-ledgerrpc-20260924.out.txt
系[T2]      2.2 KB  tools/_probe-mfood-fees-20261013.cjs
系[T2]      4.2 KB  tools/_probe-mfoodsettlement-20260929.cjs
系[T2]      3.8 KB  tools/_probe-mfoodsettlement2-20260929.cjs
系[T2]      3.2 KB  tools/_probe-mfoodsettlement3-20260929.cjs
系[T2]      2.0 KB  tools/_probe-mfoodsettlement4-20260929.cjs
系[T2]      1.5 KB  tools/_probe-mfoodsettlement5-20260929.cjs
系[T2]      3.2 KB  tools/_probe-missing-20260924.cjs
無[T1]      0.6 KB  tools/_probe-missing-20260924.out.txt
系[T2]      5.4 KB  tools/_probe-offlinereport-20260925.cjs
無[T1]      1.2 KB  tools/_probe-offlinereport-20260925.out.txt
系[T2]      7.9 KB  tools/_probe-offlinereport-online-20261007.cjs
系[T2]      7.2 KB  tools/_probe-offlinereport-paybreak-20261007.cjs
系[T2]      8.3 KB  tools/_probe-offlinereport-size-20260926.cjs
無[T1]      1.1 KB  tools/_probe-offlinereport-size-20260926.out.txt
系[T2]     14.1 KB  tools/_probe-offlinereport-truth-20261007.cjs
系         18.3 KB  tools/_probe-offlinereport-truth-20261007.json
無[T1]      3.2 KB  tools/_probe-offlinereport-truth-20261007.out.txt
系[T2]      4.8 KB  tools/_probe-offlinereport-v1base-20261007.cjs
系[T2]      4.9 KB  tools/_probe-offlinereport2-20260925.cjs
無[T1]      1.9 KB  tools/_probe-offlinereport2-20260925.out.txt
系[T2]      2.0 KB  tools/_probe-ord-20260924.cjs
系[T2]      1.4 KB  tools/_probe-order-sort-20261007.mjs
系[T2]      4.1 KB  tools/_probe-order001-20260924.cjs
無[T1]     14.9 KB  tools/_probe-order001-20260924.out.txt
系[T2]      3.3 KB  tools/_probe-order19-20260922.cjs
無[T1]     19.3 KB  tools/_probe-order19-20260922.out.txt
系[T2]      4.9 KB  tools/_probe-order19b-20260922.cjs
無[T1]     13.8 KB  tools/_probe-order19b-20260922.out.txt
系[T2]      4.9 KB  tools/_probe-order19c-20260922.cjs
無[T1]      8.9 KB  tools/_probe-order19c-20260922.out.txt
系[T2]      2.4 KB  tools/_probe-orders-cjk.mjs
系[T2]      1.7 KB  tools/_probe-orders-cjk2.mjs
系[T2]      2.0 KB  tools/_probe-pj-20260924.cjs
系[T2]      2.6 KB  tools/_probe-pj001-20260924.cjs
無[T1]      8.8 KB  tools/_probe-pj001-20260924.out.txt
系[T2]      3.5 KB  tools/_probe-postdeploy-20260924.cjs
無[T1]      0.5 KB  tools/_probe-postdeploy-20260924.out.txt
系[T2]      3.9 KB  tools/_probe-printfail-20261015.cjs
系[T2]      3.6 KB  tools/_probe-printfail2-20261015.cjs
系[T2]      2.8 KB  tools/_probe-printfail3-20261015.cjs
無[T1]      4.1 KB  tools/_probe-printfail3-20261015.out.txt
系[T2]      3.6 KB  tools/_probe-printfail4-20261015.cjs
無[T1]      1.3 KB  tools/_probe-printfail4-20261015.out.txt
系[T2]      2.8 KB  tools/_probe-printfail5-20261015.cjs
無[T1]      2.0 KB  tools/_probe-printfail5-20261015.out.txt
系[T2]      2.6 KB  tools/_probe-printjobs-all-20260922.cjs
無[T1]      5.7 KB  tools/_probe-printjobs-all-20260922.out.txt
系[T2]      3.1 KB  tools/_probe-reportcount-20260924.cjs
無[T1]      2.1 KB  tools/_probe-reportcount-20260924.out.txt
系[T2]      5.8 KB  tools/_probe-reportsplit-20260930.cjs
無[T1]      1.8 KB  tools/_probe-reportsplit-20260930.out.txt
系[T2]      4.4 KB  tools/_probe-reportsplit2-20260930.cjs
無[T1]      5.3 KB  tools/_probe-reportsplit2-20260930.out.txt
系[T2]      2.4 KB  tools/_probe-settings-20260925.cjs
系[T2]      4.8 KB  tools/_probe-store-60000002-20261006.cjs
無[T1]      1.2 KB  tools/_probe-store-60000002-20261006.out.txt
系[T2]      6.0 KB  tools/_probe-store-health-20260917.cjs
系[T2]      4.2 KB  tools/_probe-store-mismatch-20261006.cjs
無[T1]      1.0 KB  tools/_probe-store-mismatch-20261006.out.txt
系[T2]      2.6 KB  tools/_probe-storegroup-20260924.cjs
無[T1]      0.4 KB  tools/_probe-storegroup-20260924.out.txt
系[T2]      2.8 KB  tools/_probe-today-full-20260925.cjs
系[T2]      2.3 KB  tools/_probe-today-jobs-detail-20260925.cjs
無[T1]      5.7 KB  tools/_probe-today-jobs-detail-20260925.out.txt
系[T2]      3.1 KB  tools/_probe-today-orders-20260925.cjs
無[T1]      0.3 KB  tools/_probe-today-orders-20260925.out.txt
系[T2]      3.6 KB  tools/_probe-today-print-20260925.cjs
無[T1]     15.1 KB  tools/_probe-today-print-20260925.out.txt
系[T2]      3.6 KB  tools/_probe-verify002-20260924.cjs
無[T1]      2.5 KB  tools/_probe-verify002-20260924.out.txt
系[T2]      3.9 KB  tools/_probe10-timecheck.cjs
系[T2]      3.9 KB  tools/_probe11-heartbeat.cjs
系[T2]      3.7 KB  tools/_probe15-whichstore.cjs
系[T2]      4.7 KB  tools/_probe16-biaosao.cjs
系[T2]      4.0 KB  tools/_probe17-whichagent.cjs
系[T2]      2.6 KB  tools/_probe18-probe-agent.cjs
系[T2]      3.1 KB  tools/_probe2-20260924.cjs
系[T2]      1.5 KB  tools/_probe3-20260924.cjs
系[T2]      5.0 KB  tools/_probe6-20260916.cjs
系[T2]      3.9 KB  tools/_probe7-20260916.cjs
系[T2]      4.3 KB  tools/_probe9-live.cjs
無[T2]      0.7 KB  tools/_quick-candidates.json
無[T2]      0.6 KB  tools/_quick-pairs.json
系[T2]     10.4 KB  tools/_quick-patch.cjs
無[T2]      1.7 KB  tools/_quick2-candidates.json
無[T2]      0.1 KB  tools/_quick2-pairs-b.json
無[T2]      0.3 KB  tools/_quick2-pairs-c.json
無[T2]      1.3 KB  tools/_quick2-pairs.json
系[T2]     16.0 KB  tools/_quick2-patch.cjs
系[T2]      5.3 KB  tools/_reqdist-20260921.cjs
系[T2]      3.4 KB  tools/_sb-timeline-20260921.cjs
系[T2]      2.2 KB  tools/_sb-window-20260921.cjs
系[T2]      0.8 KB  tools/_scan-receipt-callsites.cjs
系          1.3 KB  tools/_sdk_android.py
系          0.7 KB  tools/_sdk_iface.py
無[T2]      6.9 KB  tools/_shift-missing.json
無[T2]      9.0 KB  tools/_shift-pairs.json
無[T2]     14.0 KB  tools/_shift-pairs2.json
系[T2]     17.3 KB  tools/_shift-patch.cjs
系[T2]      0.6 KB  tools/_shift-scan.cjs
系[T2]     14.7 KB  tools/_shift-translate.cjs
系[T2]      4.9 KB  tools/_smoke-admin-api-20260922.cjs
系[T2]      3.4 KB  tools/_smoke-pages-20260922.cjs
系[T2]      4.8 KB  tools/_smoke-state-throttle-20260922.cjs
無[T2]      0.3 KB  tools/_status-labels-pairs.json
系          7.6 KB  tools/_t-keys-missing.cjs
無[T1]    492.4 KB  tools/_test-admin-20260930.out.txt
無[T1]    411.8 KB  tools/_test-run-20260925.out.txt
無[T2]      0.1 KB  tools/_tmp-cand.json
無[T1]      0.0 KB  tools/_tsc-admin-20260930.out.txt
無[T1]      0.0 KB  tools/_v.out
無[T1]    301.6 KB  tools/_v2.out
系[T2]      1.7 KB  tools/_vc-messages-20260921.cjs
系[T2]      2.1 KB  tools/_vcdetail-20260924.cjs
系[T2]      0.9 KB  tools/_vchead-20260924.cjs
系          3.5 KB  tools/_verify-print-agent-apk.cjs
系[T2]      1.1 KB  tools/_verify-reopen-only.sql
無[T2]      1.1 KB  tools/_viewport-pairs.json
系[T2]      4.4 KB  tools/_wrap-t-ast.cjs
系[T2]     11.0 KB  tools/_wrap-t-jsstr.cjs
系[T2]      4.5 KB  tools/_wrap-t-jsxtext.cjs
系[T2]      4.1 KB  tools/_zoom-frames.cjs
系          4.6 KB  tools/analyze-sb-limit-fingerprint.cjs
系          9.4 KB  tools/analyze-vercel-log.cjs
資          3.8 KB  tools/audit-anon-endpoints.cjs
系          2.7 KB  tools/check-94-sql.py
系          1.4 KB  tools/check-expense-db.mjs
系          1.7 KB  tools/check-offline-sql.py
系          6.3 KB  tools/check-pos-offline-report-sql.py
系          7.6 KB  tools/compare-egress-logs.cjs
系          6.8 KB  tools/diag-order02-cloud-truth-20260918.sql
系          2.5 KB  tools/diag-shift-vs-report.console.js
資          5.3 KB  tools/diagnose-and-cleanup-cross-store-contamination.sql
系         12.3 KB  tools/diagnose-missing-orders-20260922.sql
系          4.1 KB  tools/diagnose-sync-queue.js
系          7.5 KB  tools/fix-order02-reopen-20260918.sql
系          9.9 KB  tools/log-recheck.cjs
系          4.7 KB  tools/mockup-canvas-fit.cjs
系          4.8 KB  tools/online-order-settings-apply-verify.sql
資          3.8 KB  tools/print-relay-revoke-stale-agents.sql
資          2.4 KB  tools/probe-anon-exposure.cjs
資          4.0 KB  tools/probe-anon-signin.cjs
資          3.1 KB  tools/probe-auth-settings.cjs
系          2.2 KB  tools/probe-deploy.cjs
系          4.9 KB  tools/probe-offline-report-day.cjs
系          4.0 KB  tools/purchase-report-reference.test.mjs
系          8.6 KB  tools/reset-pos-only-full.sql
無[T1]      1.1 KB  tools/tmp-e1.txt
無[T1]      0.1 KB  tools/tmp-e2.txt
系          9.1 KB  tools/usb-printer-probe.mjs
系          5.9 KB  tools/verify-brand-grouping.cjs
系          4.9 KB  tools/verify-deployed-bundle.cjs
系          5.3 KB  tools/verify-device-config-agent-live.cjs
系          4.6 KB  tools/verify-label-model-split.cjs
系          7.6 KB  tools/verify-label-paper-columns.cjs
系          6.5 KB  tools/verify-label-paper-width.cjs
系          5.7 KB  tools/verify-migrations-applied-20260922.sql
系         14.6 KB  tools/verify-offline-report-rpc.cjs
系          6.0 KB  tools/verify-offline-report-sql-runtime.cjs
系          6.8 KB  tools/verify-pos-api-contract.cjs
系          9.8 KB  tools/verify-pos-app-split.cjs
資          4.7 KB  tools/verify-pos-authgate.cjs
系          9.7 KB  tools/verify-pos-flows-live.cjs
系          4.2 KB  tools/verify-pos-request-count.cjs
系          4.9 KB  tools/verify-pos-sync-route.cjs
系          3.3 KB  tools/verify-print-job-kind.cjs
系          6.0 KB  tools/verify-printer-db-parity.cjs
系          9.5 KB  tools/verify-receipt-totals.mjs
系          3.8 KB  tools/verify-relay-agent.cjs
系          4.6 KB  tools/verify-reopen-fix-20260918.sql
```

#### `supabase/`（67 檔）

```
無[T1]      0.0 KB  supabase/.temp/cli-latest
系         18.9 KB  supabase/migrations/0005_salon_tables.sql
系          5.7 KB  supabase/migrations/0006_salon_packages.sql
系          9.8 KB  supabase/migrations/0007_salon_staff_products.sql
系          3.3 KB  supabase/migrations/0008_seed_salon_products_30.sql
系          9.1 KB  supabase/migrations/0009_seed_store_demo_salon_001.sql
系          1.1 KB  supabase/migrations/0010_kiosk_realtime.sql
系          7.2 KB  supabase/migrations/0011_pos_core_tables.sql
系          3.7 KB  supabase/migrations/0012_daily_sequence.sql
系          5.4 KB  supabase/migrations/0012_pos_schema_reconcile.sql
系          2.9 KB  supabase/migrations/0013_inv_products.sql
系          0.5 KB  supabase/migrations/0014_pos_serving_times.sql
系          5.4 KB  supabase/migrations/0015_pos_self_order.sql
資         13.2 KB  supabase/migrations/0016_security_rls_hardening.sql
系          5.3 KB  supabase/migrations/0017_pos_party_size.sql
系          6.7 KB  supabase/migrations/0018_pos_comp_note.sql
系          5.7 KB  supabase/migrations/0019_pos_online_order_settings.sql
系          7.1 KB  supabase/migrations/0020_print_relay.sql
資          5.7 KB  supabase/migrations/0021_print_jobs_anon_window_24h.sql
系          4.6 KB  supabase/migrations/0022_pos_queue_events_store_id.sql
系          1.1 KB  supabase/migrations/0023_drop_legacy_tables.sql
系          4.7 KB  supabase/migrations/0023_pos_shifts.sql
系          4.4 KB  supabase/migrations/0024_admin_store_id_align.sql
系          4.0 KB  supabase/migrations/0025_admin_cleanup_and_seed.sql
系          5.0 KB  supabase/migrations/0026_pos_queue_events_retention.sql
系          3.3 KB  supabase/migrations/0027_pos_print_templates.sql
系          3.3 KB  supabase/migrations/0028_pos_note_presets.sql
系          1.5 KB  supabase/migrations/0029_pos_orders_client_updated_at.sql
系          3.0 KB  supabase/migrations/0030_pos_print_templates_shift.sql
系          2.1 KB  supabase/migrations/0031_pos_kiosk_scan_mode.sql
系          2.7 KB  supabase/migrations/0032_pos_kiosk_printers.sql
系          7.3 KB  supabase/migrations/0033_pos_kds.sql
系          3.5 KB  supabase/migrations/0034_pos_discount_note.sql
系          5.9 KB  supabase/migrations/0035_print_job_stale_claim_requeue.sql
系          3.5 KB  supabase/migrations/0036_pos_online_order_settings_merchant_enabled.sql
系          3.8 KB  supabase/migrations/0037_pos_merchant_modules.sql
系          4.1 KB  supabase/migrations/0038_pos_order_member_fields.sql
系          7.3 KB  supabase/migrations/0039_pos_store_status.sql
資         10.2 KB  supabase/migrations/0040_admin_pin_hash.sql
資         11.1 KB  supabase/migrations/0041_pos_anon_read_window_narrow.sql
系          8.6 KB  supabase/migrations/0042_print_claim_window_segmented.sql
系          4.3 KB  supabase/migrations/0043_pos_order_reopen_audit.sql
系          3.9 KB  supabase/migrations/0044_pos_orders_range_indexes.sql
系          6.6 KB  supabase/migrations/0045_pos_print_jobs_once_key.sql
系          7.4 KB  supabase/migrations/0046_pos_orders_page_rpc.sql
資          4.6 KB  supabase/migrations/0047_pos_sessions.sql
系          6.3 KB  supabase/migrations/0048_pos_egress_daily.sql
系          4.5 KB  supabase/migrations/0049_pos_orders_refund_audit_columns.sql
系         10.1 KB  supabase/migrations/0050_pos_release_versions.sql
資         13.8 KB  supabase/migrations/0051_pos_store_scoped_authenticated_read.sql
資          9.9 KB  supabase/migrations/0052_pos_store_scoped_dual_claim.sql
資          7.2 KB  supabase/migrations/0053_pos_soldout_authenticated_read.sql
系          2.9 KB  supabase/migrations/0054_pos_orders_external_source.sql
系          2.5 KB  supabase/migrations/0055_pos_orders_external_unique_not_partial.sql
系          1.6 KB  supabase/migrations/0056_pos_orders_platform_fees.sql
系          8.7 KB  supabase/migrations/0057_pos_orders_settled_at.sql
系          8.8 KB  supabase/migrations/0058_pos_offline_report_rpc.sql
系         16.0 KB  supabase/migrations/0059_pos_offline_report_detail.sql
系         14.8 KB  supabase/migrations/0060_pos_offline_report_dishes_by_revenue.sql
系          6.3 KB  supabase/migrations/0060_pos_orders_platform_settlement.sql
系          6.9 KB  supabase/migrations/0061_pos_platform_settlements.sql
資          5.9 KB  supabase/migrations/0062_pos_grabber_push_log.sql
系          4.2 KB  supabase/migrations/0063_pos_orders_reopen_original_table.sql
資         10.5 KB  supabase/migrations/0064_pos_grabber_inbox_and_capability.sql
系          1.9 KB  supabase/migrations/0065_inv_products_baseline_cost.sql
系         50.5 KB  supabase/migrations/0066_pos_offline_report_channel.sql
系         17.2 KB  supabase/verify/0066_verify_production_20261007.sql
```

#### `public/`（14 檔）

```
系          3.0 KB  public/diag-shift-vs-report.js
無[T1]      0.4 KB  public/file.svg
無[T1]      1.0 KB  public/globe.svg
無[T1]      1.3 KB  public/next.svg
系[T3]  79290.4 KB  public/releases/Macau POS Desktop Setup 0.1.17.exe
系      79280.6 KB  public/releases/Macau POS Desktop Setup 0.1.18.exe
系          0.4 KB  public/releases/latest.yml
系          0.7 KB  public/releases/manifest.json
系         48.6 KB  public/sounds/cancel-order.mp3
系         35.6 KB  public/sounds/new-delivery-order.mp3
系         31.1 KB  public/sounds/new-order.mp3
系          3.1 KB  public/sw.js
無[T1]      0.1 KB  public/vercel.svg
無[T1]      0.4 KB  public/window.svg
```

#### `print-relay/`（4 檔）

```
系          2.0 KB  print-relay/README.md
系          0.3 KB  print-relay/package.json
系          3.9 KB  print-relay/server.mjs
系          1.8 KB  print-relay/stationary-agent.mjs
```

#### `(root)/`（22 檔）

```
資         11.7 KB  .env.example
資          1.0 KB  .env.local.example
系          3.1 KB  .gitignore
無[T2]     15.5 KB  .next-smoke.html
?          0.0 KB  0
系          0.7 KB  AGENTS.md
系          0.0 KB  CLAUDE.md
系          2.4 KB  README.md
無[T2]      8.8 KB  _tmp_member_mockup.html
無[T2]      2.9 KB  _tmp_push.cjs
無[T2]      6.7 KB  _tmp_verify_unit.cjs
無[T2]      0.4 KB  _tmp_wait.cjs
系          0.9 KB  eslint.config.mjs
系         17.0 KB  implementation-plan-2026-09-04.md
系          9.4 KB  ledger-offline-report-reply-2026-09-04.md
系          0.3 KB  next-env.d.ts
系          2.4 KB  next.config.ts
系        239.9 KB  package-lock.json
系          0.7 KB  package.json
系          0.1 KB  postcss.config.mjs
系          0.7 KB  tsconfig.json
無[T1]    212.2 KB  tsconfig.tsbuildinfo
```

#### `.workbuddy/`（66 檔）

```
無[T4]      2.1 KB  .workbuddy/lint.txt
無[T4]      1.8 KB  .workbuddy/lt.txt
無[T4]      0.5 KB  .workbuddy/m1.txt
無[T4]      0.5 KB  .workbuddy/m2.txt
無[T4]     20.5 KB  .workbuddy/memory/2026-09-04.md
無[T4]     18.1 KB  .workbuddy/memory/2026-09-05.md
無[T4]     34.3 KB  .workbuddy/memory/2026-09-06.md
無[T4]     29.4 KB  .workbuddy/memory/2026-09-07.md
無[T4]     19.3 KB  .workbuddy/memory/2026-09-08.md
無[T4]     64.1 KB  .workbuddy/memory/2026-09-09.md
無[T4]    100.5 KB  .workbuddy/memory/2026-09-10.md
無[T4]    100.3 KB  .workbuddy/memory/2026-09-11.md
無[T4]     84.5 KB  .workbuddy/memory/2026-09-12.md
無[T4]     99.8 KB  .workbuddy/memory/2026-09-13.md
無[T4]    106.8 KB  .workbuddy/memory/2026-09-14.md
無[T4]     49.0 KB  .workbuddy/memory/2026-09-15.md
無[T4]     87.1 KB  .workbuddy/memory/2026-09-16.md
無[T4]     31.6 KB  .workbuddy/memory/2026-09-17.md
無[T4]     23.2 KB  .workbuddy/memory/2026-09-18.md
無[T4]      7.2 KB  .workbuddy/memory/2026-09-19.md
無[T4]     78.5 KB  .workbuddy/memory/2026-09-21.md
無[T4]     74.4 KB  .workbuddy/memory/2026-09-22.md
無[T4]     55.6 KB  .workbuddy/memory/2026-09-23.md
無[T4]     41.2 KB  .workbuddy/memory/2026-09-24.md
無[T4]     23.4 KB  .workbuddy/memory/2026-09-25.md
無[T4]      7.5 KB  .workbuddy/memory/2026-09-26.md
無[T4]     12.8 KB  .workbuddy/memory/2026-09-27.md
無[T4]      3.2 KB  .workbuddy/memory/2026-09-28.md
無[T4]      1.8 KB  .workbuddy/memory/2026-09-29.md
無[T4]      5.4 KB  .workbuddy/memory/2026-09-30.md
無[T4]     18.3 KB  .workbuddy/memory/2026-10-01.md
無[T4]     25.8 KB  .workbuddy/memory/2026-10-05.md
無[T4]      3.1 KB  .workbuddy/memory/2026-10-06.md
無[T4]     86.4 KB  .workbuddy/memory/2026-10-07.md
無[T4]     45.0 KB  .workbuddy/memory/2026-10-08.md
無[T4]     22.4 KB  .workbuddy/memory/2026-10-11.md
無[T4]     12.4 KB  .workbuddy/memory/2026-10-12.md
無[T4]     14.8 KB  .workbuddy/memory/2026-10-13.md
無[T4]     18.2 KB  .workbuddy/memory/2026-10-14.md
無[T4]      5.4 KB  .workbuddy/memory/2026-10-15.md
無[T4]      3.8 KB  .workbuddy/memory/2026-10-16.md
無[T4]     17.4 KB  .workbuddy/memory/2026-10-17.md
無[T4]      9.4 KB  .workbuddy/memory/DETAIL-2026-09.md
無[T4]      9.7 KB  .workbuddy/memory/MEMORY.md
無[T4]     12.3 KB  .workbuddy/memory/archive/MEMORY-2026-09-12-full.md
無[T4]      0.0 KB  .workbuddy/pptr.txt
無[T4]      0.4 KB  .workbuddy/smoke.txt
無[T4]      0.1 KB  .workbuddy/tc.txt
無[T4]     68.8 KB  .workbuddy/test.txt
無[T4]      4.8 KB  .workbuddy/tmp/before-after.html
無[T4]     91.0 KB  .workbuddy/tmp/before-after.png
無[T4]    162.4 KB  .workbuddy/tmp/crops/d1.png
無[T4]    195.1 KB  .workbuddy/tmp/crops/d2.png
無[T4]   2376.6 KB  .workbuddy/tmp/crops/full2x.png
無[T4]    373.3 KB  .workbuddy/tmp/crops/head_vs_name.png
無[T4]    389.1 KB  .workbuddy/tmp/crops/items_bot.png
無[T4]    297.7 KB  .workbuddy/tmp/crops/items_mid.png
無[T4]    389.0 KB  .workbuddy/tmp/crops/items_top.png
無[T4]    166.5 KB  .workbuddy/tmp/crops/name1.png
無[T4]    253.8 KB  .workbuddy/tmp/crops/preview_div.png
無[T4]    133.8 KB  .workbuddy/tmp/crops/preview_name_row.png
無[T4]     12.0 KB  .workbuddy/tmp/table-responsive-check.html
無[T4]      0.0 KB  .workbuddy/tt.txt
無[T4]      0.5 KB  .workbuddy/typecheck.log
無[T4]      0.1 KB  .workbuddy/typecheck.txt
無[T4]      4.0 KB  .workbuddy/update-shift-history-table.mjs
```

#### `.workbuddy-ai/`（21 檔）

```
無[T4]     36.2 KB  .workbuddy-ai/memory/2026-08-14.md
無[T4]      2.8 KB  .workbuddy-ai/memory/2026-08-15.md
無[T4]     11.2 KB  .workbuddy-ai/memory/2026-08-17.md
無[T4]     33.9 KB  .workbuddy-ai/memory/2026-08-18.md
無[T4]     26.0 KB  .workbuddy-ai/memory/2026-08-19.md
無[T4]      9.4 KB  .workbuddy-ai/memory/2026-08-20.md
無[T4]      6.6 KB  .workbuddy-ai/memory/2026-08-21.md
無[T4]     64.7 KB  .workbuddy-ai/memory/2026-08-22.md
無[T4]     33.0 KB  .workbuddy-ai/memory/2026-08-23.md
無[T4]     47.6 KB  .workbuddy-ai/memory/2026-08-24.md
無[T4]     55.2 KB  .workbuddy-ai/memory/2026-08-25.md
無[T4]     33.5 KB  .workbuddy-ai/memory/2026-08-26.md
無[T4]     24.6 KB  .workbuddy-ai/memory/2026-08-27.md
無[T4]     28.0 KB  .workbuddy-ai/memory/2026-08-28.md
無[T4]     10.4 KB  .workbuddy-ai/memory/2026-08-30.md
無[T4]     52.7 KB  .workbuddy-ai/memory/2026-08-31.md
無[T4]     61.9 KB  .workbuddy-ai/memory/2026-09-01.md
無[T4]     38.3 KB  .workbuddy-ai/memory/2026-09-02.md
無[T4]     31.9 KB  .workbuddy-ai/memory/2026-09-03.md
無[T4]      6.6 KB  .workbuddy-ai/memory/2026-10-09.md
無[T4]      7.9 KB  .workbuddy-ai/memory/MEMORY.md
```

