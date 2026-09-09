# 打印模板按店存 DB + 進入即拉（0027 落地）

日期：2026-09-09
狀態：已實作（migration 0027 / route / print-center / pos-app merge / /api/pos/state）
對應：docs/71 擱置嘅 "push seam"；收據/標籤/廚房/自助點餐機四槽模板嘅 store-level 同步。

## 背景

以前 `printTemplates`（收據 receipt / 標籤 label / 廚房 kitchen / 自助點餐機 kiosk）
真源 = 每部機 localStorage `macau-pos/stores/{storeId}/local-settings`
（docs/71 §8 client-only）：print-center 任何保存都只寫本機、從不 POST；
pos-app `loadRuntimeState` merge 用 `printTemplates: local.printTemplates` 永遠保留本機。
結果：跨終端各自為政、新終端入打印頁永遠只見到 default、同店冇共用模板。
唯一 DB 副本（`pos_device_configs.local_settings`）係終端級 + 「全店最新一行」讀法，
0015/0019 已明文警告唔好攞嚟做 per-store 設定。

## 方案（今次做咗）

### 1. migration `supabase/migrations/0027_pos_print_templates.sql`
- `pos_print_templates`：`store_id text PK` + `receipt/label/kitchen/kiosk jsonb` + `created_at/updated_at`。
- 一店一行 → 天然唔互蓋；RLS service_role-only（照 0023 pos_shifts 模式，revoke anon/authenticated）。
- 唔入 realtime publication（進入打印頁先拉一次，禁 polling）。

### 2. API `src/app/api/pos/print-templates/route.ts`
- `GET ?storeId=` → `{ ok, found, templates, updatedAt }`
  - `found:false`（未設定過 / 冇 storeId / supabase 未配）→ client 保留本地（向後兼容舊店未上傳）。
  - `found:true` → templates 經 `normalizePrintTemplateSet()` 先返：DB 舊記錄缺新 section
    （如 divider / qrSize）都唔會被當權威，normalize 補返預設 + 保留用戶設定。
- `POST { storeId, templates }` → 先讀現有 row 補齊「今次請求冇帶嘅槽位」→ normalize →
  `upsert onConflict store_id`，`updated_at = now()`（last-write-wins）。成功回 `{ ok, updatedAt }`。
- 寫入用 `getSupabaseWriteClient()`（service role 必須，缺 → 503）；讀用 `getSupabaseServerClient()`。

### 3. storage helper `src/lib/storage.ts`
- `normalizePrintTemplateSet(raw)`：淨 normalize 四槽，同 `normalizePosLocalSettings` 共用 merge
  （逐 id 併 block / 補新 section / 保留 qrUrl/qrSize/footerText），server + client 單一真源 normalize。
- `PrintTemplateSyncMeta = { updatedAt }` + `loadPrintTemplateSyncMeta() / savePrintTemplateSyncMeta()`：
  本機已知 server 模板版本。存 localStorage（store-scope `print-template-meta`，同 local-settings
  同一把 key scope —— 用 `resolveSettingsStoreScope()`）。唔入 PosLocalSettings，
  避免 normalize 每次重寫整份設定。

### 4. client helper `src/lib/print-templates-sync.ts`
- `fetchStorePrintTemplates(storeId)` / `pushStorePrintTemplates(storeId, templates)`。
- 任何網絡失敗都返 null（唔 throw）→ caller 保留本地，離線優先，唔卡設計介面。

### 5. print-center `src/components/print-center.tsx`
- **進入即拉**（mount effect）：`resolveStoreId()` → GET。server 有記錄 → 採納入
  local state + localStorage + 記 meta updatedAt，toast「已載入雲端模板設定」；冇 → 保留本地。
  採納規則（LWW）：本機冇 meta（全新機 / 未對過版）→ 採納；`serverTs > localTs` → 採納；
  `serverTs <= localTs`（啱啱自己推完）→ skip，避免「重入頁面用舊 server 蓋返自己新 edit」。
- **改動即上雲（節流）**：`updateLocalTemplate / undo / redo` 存本機後 → `scheduleTemplateCloudPush`
  （1.5s debounce）。離線時淨標 `unsyncedRef`，`[networkOnline]` effect 恢復時即刻補推。
  離開頁面 cleanup 會 flush 最後一次 pending debounce（防「改完 1.5s 內即走」漏上雲）。
- **「💾 儲存模板」**：read-back 驗證 + 強制上雲。toast 三態：
  無 storeId→存本機；離線→存本機 + 恢復網絡自動同步；成功→「已儲存並同步到雲端（全部收銀機可共用）」；
  失敗→存本機 + 稍後自動重試。

### 6. pos-app merge `src/components/pos-app.tsx` loadRuntimeState
- `/api/pos/state` 新增 `printTemplatesServer`（0027 row，normalize 過）。
- merge 改做 LWW：`server 有 row && serverTs > 本機 meta` → 採納 server 模板並記 meta；
  其餘（本機啱啱推完 / server 未設定）→ 保留本地。呢個係 docs/71 §8 舊 bug（server 預設
  每逢同步蓋走設計）嘅新解法：server 來源改做**獨立店級表**，唔再係 device_configs 預設值。
- 即係：另一部機喺打印頁改完模板 → 呢部收銀台下次 state sync 自動採納最新版。

## 向後兼容 / 遷移
- 0027 表預設空 → 現有店第一次入打印頁：`found:false` → 保留佢哋已設計好嘅本地模板；
  一撳「儲存模板」（或改動後 1.5s auto-save）就上傳 → DB 成為該店真源。
- 之後任何終端入打印頁 / 收銀台 state sync 都會見同一份（server 較新先採納）。
- 標籤字型鎖死 / divider / qr 系列欄位全部都經 `normalizePrintTemplateSet` 保護，唔會喺
  reload 或跨端採納時被剷走。

## 驗證
- `tsc --noEmit`：0 error。
- 手動：
  1. 打印頁改一欄 → 等 ~2s（或撳儲存）→ DB `select store_id, updated_at from pos_print_templates`。
  2. 第二部機入打印頁 → 應見同模板 + toast「已載入雲端模板設定」。
  3. 斷網改 → toast「已儲存本機；目前離線…」→ 恢復網絡 → 應自動補推（DB updated_at 跳起）。
  4. 舊店遷移：DB 冇 row 前入打印頁，本地設計唔會被蓋。

## 已知限制 / 注意
- 多終端同時喺打印頁編輯 → 純 last-write-wins（冇衝突合併 / 冇人版）。店級模板編輯
  通常係集中管理，接受呢個 trade-off；要強就日後加 updated_by / 版本號。
- `/api/pos/print-templates` GET 用 server client：部署環境需有 service key（同
  `/api/pos/state` 讀 queue/device_config 一樣嘅既有前提），冇會 500/空。
- `pos_device_configs.local_settings` 內嘅模板副本照舊由設備設定頁帶住走，但已冇人採用
  （printTemplates merge 一律唔睇佢）——可留作診斷 / 終端級兜底。
