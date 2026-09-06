# Admin Panel（方向重整版）+ DB 清理 部署 Runbook（2026-09-06）

> 本文件整合 2026-09-06 全日工作嘅部署步驟。代碼已全部落地並通過
> `tsc --noEmit` / ESLint / `next build`（零 warning）/ 本地生產構建 HTTP 冒煙測試。
> 沙箱無 DB 憑證，migration 同生產驗證需要喺你嘅環境執行。
>
> **⚠️ 下午方向重整**：admin panel 改為單管理員 + view-only 看板（見 §〇-B），
> 上晝版本嘅多賬號 CRUD 已拆除。本 runbook 已按新架構更新。

---

## 〇、本次改動總覽

**新 migration（4 個，待跑）**

| 檔案 | 用途 |
|------|------|
| `supabase/migrations/0022_pos_queue_events_store_id.sql` | queue 事件加 `store_id`（跨店隔離修復核心） |
| `supabase/migrations/0023_drop_legacy_tables.sql` | 刪 6 張廢棄表（online_order 4 張 + pos member 2 張） |
| `supabase/migrations/0024_admin_store_id_align.sql` | admin 表加 `merchant_id text`（無 FK——POS DB 冇 merchants 表） |
| `supabase/migrations/0025_admin_cleanup_and_seed.sql` | 刪死 store `macau-store-a/b` + 測試賬號 `63936541/63936542`；確保 admin 賬號 **60000000 / PIN 0000** |

**代碼改動（已驗證）**

- 跨店隔離：`sync-flush.ts` / `pos-app.tsx` / `shift-page.tsx` / `/api/pos/sync` 等 6 層防禦
- per-store 加固：`bootstrap` / `device-config` / `state` 路由冇 storeId 時 fail-safe；footfall per-store key
- 構建衛生：`globals.css` `@source not` 排除 docs / .workbuddy*（Tailwind 源碼掃描污染修復）

### B. Admin Panel（方向重整版：單管理員 + view-only 看板）

**新 API（全部 admin session token 把關）**

| 端點 | 用途 |
|------|------|
| `GET /api/admin/merchants` | 全體商家列表（Ledger `merchants`）+ 每店今日/7日營業統計（POS `pos_orders` 聚合，settled/paid 口徑同報表一致）。無 Ledger key 時降級只列 POS 有單嘅店 |
| `PATCH /api/admin/merchants/status` | **全 panel 唯一寫操作**：`merchants.status` active⇄suspended。suspended 後該店全部賬號登入 POS 即 403（`/api/ledger/login` 內置檢查，零改動生效） |
| `GET /api/admin/orders` | 跨店訂單只讀（storeId 可選=全部店、start/end、limit≤5000、offset） |
| `POST /api/admin/session` | 單管理員登入（60000000 / 0000，不變） |

**新頁面 / 組件**

- `src/components/admin-shell.tsx`：view-only 外殼（總覽/報表導航 + adminSessionToken 認證門，hydration-safe）
- `/admin/dashboard`：商家表格（狀態徽章、統計、啟停按鈕帶 confirm）+ 下單明細（店舖+日期篩選，最多顯示 200 行）
- `/admin/reports`：商家下拉（含「全部」彙總）+ `RestaurantDailyReport`
- `RestaurantDailyReport` 新 props：`merchantIdOverride` / `storeNameOverride` / `allStoresMode` + `adminOrderFetcher`（POS 單店用法零改動；admin 模式自動跳過 merchant-JWT 類 Ledger RPC）
- `src/lib/pos-order-row.ts`：`pos_orders` 行映射抽共享（state 路由與 admin orders 同源）

**已刪除**：`/admin/accounts` 頁、`admin-accounts-page.tsx`、`/api/admin/accounts` 路由（多賬號 CRUD；`admin_account_users` 表保留供 60000000 登入）。backoffice-shell 已移除「帳戶管理」入口。

**環境變數（Vercel 必加）**：`LEDGER_SERVICE_ROLE_KEY`——商家列表與啟停功能依賴；無 key 時 merchants API 降級、啟停返回 503（登入同報表不受影響）。

---

## 一、備份（必做）

```bash
pg_dump -h <host> -U <user> -d <db> \
  -t pos_orders -t pos_queue_events -t pos_order_items -t pos_order_payments \
  -t pos_shift_sessions -t pos_shift_events -t pos_refunds -t print_jobs \
  -t admin_stores -t admin_account_users -t admin_permission_groups -t admin_account_store_bindings \
  -F c -f pos_backup_$(date +%Y%m%d).dump
```

---

## 二、按序跑 migration（①→④，唔好跳序）

```bash
supabase db push
# 或喺 Supabase SQL Editor 逐個執行 0022 → 0023 → 0024 → 0025
```

要點：

1. **0025 每次重跑會把 60000000 嘅 PIN 重置返 0000**（冪等 upsert by design，符合「確保可登入」要求）。
2. **0024 嘅 `merchant_id` 係 `text` 無 FK**——POS DB 冇 `merchants` 表（嗰個喺 Ledger DB，跨庫建唔到 FK）。
3. 0025 第 5 段係**註釋模板**：攞到 Ledger merchant UUID 後（SQL：喺 Ledger DB 跑 `select id, name from merchants;`，或 POS 登入後睇 `authSession.merchantId`）取消註釋填 UUID 再跑，admin_stores 就有真實門店可綁定。
4. 舊 seed 檔 `docs/sql/admin-account-schema.sql` **已停用勿再跑**（會重新插入死 store / 測試賬號，檔案頂有警告 banner）。

---

## 三、部署代碼（Vercel）

全部 migration 跑完先 deploy。改動一覽：

```text
M  src/app/admin/page.tsx                       # /admin 登入頁 → 跳 /admin/dashboard
M  src/components/auth-guard.tsx                # admin-only session 放行（關鍵修復）
M  src/components/backoffice-shell.tsx          # 移除「帳戶管理」入口（admin panel 獨立）
M  src/lib/admin-account-server.ts              # macau-store-a fallback 清理
M  src/lib/storage.ts                           # 同上 ×2
M  src/app/api/pos/bootstrap/route.ts           # 無 storeId 返 mock
M  src/app/api/pos/device-config/route.ts       # 無 storeId 返 null
M  src/app/api/pos/state/route.ts               # printJobs/deviceConfig 無 storeId limit(0)；行映射抽共享
M  src/lib/restaurant-footfall.ts               # footfall per-store key
M  src/app/globals.css                          # @source not 排除 docs/.workbuddy*
M  src/components/restaurant-daily-report.tsx   # admin 參數化（override / allStoresMode / 跳過 JWT RPC）
A  src/app/admin/dashboard/page.tsx             # 店鋪總覽 + 啟停 + 下單明細（view-only）
A  src/app/admin/reports/page.tsx               # 商家篩選報表（含「全部」）
A  src/components/admin-shell.tsx               # view-only 外殼 + 認證門
A  src/lib/ledger/admin-server.ts               # Ledger service-role client（LEDGER_SERVICE_ROLE_KEY）
A  src/lib/pos-order-row.ts                     # pos_orders 行映射共享模塊
A  src/app/api/admin/merchants/route.ts         # 商家列表 + 統計
A  src/app/api/admin/merchants/status/route.ts  # 啟停（唯一寫操作）
A  src/app/api/admin/orders/route.ts            # 跨店訂單只讀
D  src/app/admin/accounts/page.tsx              # 多賬號頁（拆除）
D  src/components/admin-accounts-page.tsx       # 多賬號 CRUD UI（拆除）
D  src/app/api/admin/accounts/route.ts          # 多賬號 CRUD API（拆除）
A  supabase/migrations/002{3,4,5}_*.sql          # 見上表
```

（另有早前已部署／待一併部署嘅跨店隔離改動：`sync-flush.ts`、`pos-app.tsx`、`shift-page.tsx`、`print-center.tsx`、`pos-orders.ts`、`kiosk-order.ts`、`quick-order-fulfillment.ts`、`print-jobs.ts`、`types.ts`、`0022`。）

---

## 四、部署後驗證清單

0. **環境變數**：Vercel 加 `LEDGER_SERVICE_ROLE_KEY`（Ledger DB service-role key），redeploy 後生效。無 key：商家列表降級、啟停 503（登入/報表正常）。
1. **Admin 登入**：開 `https://macau-pos-system.vercel.app/admin` → `60000000` / `0000` → 應直達 `/admin/dashboard` 店鋪總覽。
2. **店鋪總覽**：商家表格應列出全體商家（名稱/狀態/今日與 7 日統計）；下單明細可按店舖 + 日期篩選。
3. **啟停測試**：停用一間測試店 → 該店 8 位賬號登入 POS 應 403「商戶已停用」→ 重新啟用恢復。
4. **報表**：`/admin/reports` 商家下拉切換；選「全部」應彙總所有商家（會員充值/線上渠道類顯示零值屬預期——admin 無商戶 JWT）。
5. **跨店隔離**：A 店落單 → 切 B 店報表，唔應出現 A 店菜品。
6. **per-store fail-safe**：`GET /api/pos/bootstrap`（無 storeId）應返 mock；`device-config` 返 null；`state` printJobs 返空。
7. **本機冒煙已驗證**（2026-09-06，生產構建 + 無 DB 環境）：`/admin` `/admin/dashboard` `/admin/reports` 全 200；舊 `/admin/accounts` 404；三個 admin API 無 token 全 401；登入無 DB → 503 fail-closed；錯 PIN → 401 統一文案。

---

## 五、本環境已知事項（僅本地開發相關）

- **`next build` 被 safe-delete shim 誤攔**：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npx next build`（shim 官方開關；`.next` 係構建產物，誤攔屬 false positive）。
- **Tailwind v4 掃描污染已修**：`globals.css` `@source not` 排除 docs / .workbuddy*；任何被掃描位置（包括 CSS 注釋）唔好寫類樣 token（`min-[佔位]` 呢類）。
- **建議（待拍板）**：`.workbuddy/`、`.workbuddy-ai/` 目前被 git 追蹤並提交，AI 日誌入 repo 會持續污染 Tailwind 掃描同增大 repo，建議 `.gitignore` + `git rm --cached -r` 解除追蹤。
