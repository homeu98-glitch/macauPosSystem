# 127 · 登入流程改版：先登入 → 後選工作台（商戶模組授權）

> **狀態**：已實作（2026-09-13），待跑 migration 0037 + 人手驗收
> **確認稿**：`docs/mockups/login-then-module-select-2026-09-13.html`
> **Migration**：`supabase/migrations/0037_pos_merchant_modules.sql`

## 1. 問題

登入頁本來同一個畫面要做兩件事：**揀模式**（快餐／堂食／美容／自助點餐機／
後廚屏／出餐台屏）＋ **輸入帳號 PIN**。即係「未證明身份就先揀咗要做咩」。後果：

| 問題 | 說明 |
|---|---|
| 越權可見 | 6 個模式人人見到，包括商戶根本冇買嘅模組 |
| Admin 做唔到 | 想按商戶收窄可選範圍，只能改代碼，後台冇得設 |
| 揀錯直接入錯畫面 | 冇任何「呢個人可唔可以入呢個模式」嘅檢查點 |

## 2. 改動後流程

```
① /login              帳號 + PIN            → 證明「你係邊個」
② /select-workbench   揀呢部機做邊個崗位    → 只列 Admin 已開通嘅模組
③ 對應首頁            /  ·  /retail  ·  /salon  ·  /order  ·  /kitchen  ·  /expo
```

**兩個「唔使再揀」嘅捷徑**（兩者都**必須先過授權檢查**）：

- **深連結** `/login?mode=kiosk` —— 保留舊有預約安裝／桌面捷徑行為。
- **記住呢部機** —— 收銀機／後廚屏係固定崗位，每次開機都問一次好煩。

## 3. 資料模型（migration 0037）

```
pos_merchant_modules
  store_id         text primary key     -- = Ledger merchant UUID（同 pos_orders.store_id 口徑）
  workbenches      jsonb  default '[]'  -- 決定②顯示邊幾張卡
  sidebar_modules  jsonb  default '[]'  -- 決定入到收銀台之後側欄顯示邊幾個
  created_at / updated_at
```

權限照抄 0028 `pos_note_presets`：`revoke anon, authenticated` + `grant service_role`
+ RLS `service only` policy。寫入只經 server service_role。

### 🔴 核心不變量：冇記錄 = 全部開通，唔係「全部閂」

直覺會覺得「讀唔到 = 冇授權 = 唔畀入」比較安全，但實際後果係：

> 未跑 migration / service key 未配 / DB 打嗝 → 全部門店登入完「選擇工作台」一頁空白
> → 冇人入得返 POS → **全線停業**。

另一邊（當成全開）最壞只係「暫時見到多咗幾個模組」，而且 POS 每個模組本身仲有
自己嘅權限檢查。兩害相權取「全開」。

呢個決定同時令 rollout 安全：migration 上線一刻所有商戶都未有行，全部自動維持現狀；
Admin 逐間收緊，收到邊間就邊間生效。

**同一個口徑要喺 4 個地方一致**（改任何一個都要改晒）：

| 位置 | 表達方式 |
|---|---|
| `merchant-modules-server.ts` | `error \|\| !data` → `defaultMerchantGrants()` |
| `AuthSession.allowedModules` | 選填；`undefined` = 全部開通 |
| `login-screen.tsx` | `session.allowedModules?.workbenches ?? [...WORKBENCH_IDS]` |
| `app-sidebar.tsx` | `!grantedSidebarModules` → 全部顯示 |

## 4. 檔案清單

| 檔案 | 角色 |
|---|---|
| `supabase/migrations/0037_pos_merchant_modules.sql` | 新表 |
| `src/lib/pos/module-catalog.ts` | **唯一真源**：工作台 + 側欄模組目錄、`normalizeMerchantGrants()` |
| `src/lib/pos/module-catalog.test.ts` | 單元測試（15 個 case） |
| `src/lib/pos/merchant-modules-server.ts` | 讀寫（含「讀唔到 = 全開」不變量） |
| `src/lib/pos/apply-workbench.ts` | 由 `login-screen` 搬出嘅工作台副作用 |
| `src/lib/pos/workbench-preference.ts` | 「上次使用」+「記住呢部機」 |
| `src/components/login-screen.tsx` | **移除**模式選擇器 |
| `src/app/select-workbench/page.tsx` + `src/components/select-workbench-screen.tsx` | 新頁 |
| `src/components/app-sidebar.tsx` | 側欄按授權過濾 + 「工作台」逃生門 |
| `src/app/api/ledger/login/route.ts` | session 加 `allowedModules` |
| `src/app/api/admin/merchants/modules/route.ts` | Admin 讀寫 API |
| `src/components/admin-merchant-modules-dialog.tsx` | Admin 授權彈窗 |
| `src/app/admin/dashboard/page.tsx` | 商家列表加「模組」按鈕 |
| `src/lib/storage.ts` | `AuthSession.allowedModules`（選填） |

## 5. 紅線 / 易錯位

- 🔴 **加新模組一定要先改 `module-catalog.ts`**。只改 `app-sidebar` 或只改
  Admin UI = 兩邊走樣，而且**唔會 throw**，只會靜靜冇咗個開關。
- 🔴 **`normalizeMerchantGrants()` 要保留空陣列做空陣列**。「Admin 明確全部閂」
  同「DB 冇記錄」係兩件唔同嘅事 —— 前者係 `[]`，後者係 `undefined`。
- 🔴 **`module-catalog.ts` 要保持零 runtime 依賴**（只 `import type`），
  否則 `node --test` 會 `ERR_MODULE_NOT_FOUND`（`@/` 唔通）。
- 🔴 **`storage.ts` 嘅 `normalizeAuthSession()` 一定要帶返 `allowedModules`**。
  漏咗 = reload 之後被剷走（同 `posDeviceToken` 嘅歷史教訓一模一樣）。
- 🔴 **`applyWorkbenchSelection()` 只能有一份**，唔可以喺 `/select-workbench`
  再抄一份。抄 = 兩個地方各寫一半，日後必然走樣。
- 🔴 **Admin PATCH 一定要兩組一齊送**。Server 用兩個值覆寫整行，
  只送一組 = 另一組被靜靜清空。
- ⚠️ **`retail` 唔寫 `saveOperatingMode()`**：`OperatingMode` 只有
  `dinein | quick`，冇「零售」呢個狀態，硬寫 `dinein` 會污染主 POS。
- ⚠️ **終端行業每次都要明確寫**（salon → `salon`，其餘 → `restaurant`）。
  舊 code 只寫 salon、從來冇寫返 restaurant；改版之後同一部機可以日日切工作台，
  唔寫返就會出現「美容機揀完堂食，終端仍然當自己係美容院」。
- ⚠️ **裝置角色（kiosk / kitchen / expo）一律唔改店級掃碼模式**，
  否則自助點餐機綁店會同收銀台嘅堂食登入互相覆蓋
  （見 `scan-mode-from-login.ts` §12.2「兩部機打架」）。

## 6. 掃碼點餐模式嘅來源改變

舊：`scanModeForLoginMode(登入頁揀嘅模式)`
新：`scanModeForLoginMode(② 所選工作台)`

映射不變：`quick` → `quick`（全店一碼）、`dinein` → `dine_in`（每枱一碼）、
其餘一律 `null`（唔改店級設定）。**如果商戶同時開通堂食＋快餐兩個工作台，
就係「揀完工作台嗰一刻寫入」**（最後一次登入嘅工作台話事）。

## 7. 驗收

```bash
# 1) 跑 migration（Supabase SQL editor 或 supabase db push）
#    見 0037 檔尾嘅驗收 SQL

# 2) 型別 + lint + 測試
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/lib/pos src/components/select-workbench-screen.tsx
node --test

# 3) 建置
CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/next/dist/bin/next build
```

人手驗收清單：

- [ ] 未跑 migration 時登入 → ② 仍然顯示**全部**工作台（向後兼容）
- [ ] Admin 收緊某店（只留堂食 + 自助點餐機）→ 該店重新登入 → ② 只顯示呢兩個可撳
- [ ] 未開通嘅卡片**灰住 + 🔒**，撳落去出提示（唔係消失）
- [ ] 側欄只顯示已開通模組（`/settings` 同「工作台」永遠都在）
- [ ] 開「記住呢部機」→ 登出再登入 → **跳過** ② 直接入上次崗位
- [ ] Admin 之後閂咗嗰個工作台 → 再登入 → **唔會**自動進入，返去 ②
- [ ] `/login?mode=kiosk` → 登入後直接入自助點餐機
- [ ] 舊 session（改動前登入、未重新登入）reload → 側欄**唔會**變空

## 8. 相關文件

- 確認稿：`docs/mockups/login-then-module-select-2026-09-13.html`
- 掃碼模式：`docs/115-scan-dine-in-vs-quick-plan.md` §12
- KDS 崗位：`docs/116-kds-kitchen-display-plan.md` §4.4
- 終端憑證：`docs/113-agent-gotchas.md`
