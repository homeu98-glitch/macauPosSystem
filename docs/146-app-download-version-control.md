# 146 · App 下載入口 + 版本控制（2026-09-23）

> 一句話：登入頁按裝置出「下載 APK」／「下載安裝包」按鈕，連去 **admin「版本控制」頁**
> 目前設為 active 嘅版本 —— 換版本唔使改代碼、唔使重新部署。

---

## 1. 為何要做

改動之前「派邊個安裝包」係**寫死喺代碼**：

| 痛點 | 後果 |
|---|---|
| 出新 APK 要改代碼 → commit → push → 等 Vercel Redeploy | 分鐘級延遲，營業時間出事好難搞 |
| 想出錯時退回上一個版本 | 同樣要改代碼 + 重新部署 ⇒ **根本來唔及** |
| POS 網頁**完全冇**下載入口 | `public/releases/manifest.json` 只服務 Electron 自動更新；新機／新商家唔知去邊度裝 |
| 冇地方睇「而家對外派緊邊個版本」 | 只能靠記憶 |

---

## 2. 資料模型（migration 0050）

`public.pos_release_versions`（POS 專案 `iyrywzormzisyppkokbi`）：

| 欄位 | 說明 |
|---|---|
| `platform` | `android`（APK）／`desktop`（安裝包）—— `check` constraint 限定 |
| `version` | 版本號（自由文字，唔假設語意化版本） |
| `file_path` | Supabase Storage `macauposapk` bucket 內**相對路徑**，例如 `macau-pos.apk` |
| `download_url` | 完整外部連結；**非空時覆蓋**由 `file_path` 砌出嚟嘅連結 |
| `file_size` | bytes，顯示用（可空） |
| `notes` | 更新內容（可空） |
| `is_active` | 每個平台**最多一個** `true` |

三條 DB 層硬約束（唔靠應用層自律）：

1. `check (platform in ('android','desktop'))`
2. `check` 至少要有 `file_path` **或** `download_url` —— 唔會出現「active 但撳落去冇連結」
3. **partial unique index** `unique (platform) where is_active`
   ⇒ 任何人（包括直接改 SQL）都整唔出「兩條 active」

另有 RPC `pos_activate_release_version(uuid)`：一個 transaction 做「先落閘、後上位」，
避免分兩條 update 中間失敗而撞 unique index 或者留低「一個 active 都冇」。

### 安全

表**只** `service_role` 可讀寫（`anon` / `authenticated` 一律 revoke）。
公開讀取走 `/api/release/versions/active`，對外只回 **5 個欄位**
（`platform` / `version` / `downloadUrl` / `fileSize` / `notes`）。

> ⚠️ 唔可以為咗方便而 grant anon select —— 呢張表由 admin 寫入，anon 可讀等於公開
> 內部版本清單 + 備註。走 server route 反而攻擊面更細。

---

## 3. 檔案清單

### 新檔案

| 路徑 | 作用 |
|---|---|
| `supabase/migrations/0050_pos_release_versions.sql` | 建表 + RLS + 切換 RPC |
| `src/lib/release/release-core.ts` | **零 import** 純邏輯：裝置偵測、砌連結、驗證草稿、格式化 |
| `src/lib/release/release-core.test.ts` | 34 條單測（含「零 import」契約守衛） |
| `src/lib/release/release-row.ts` | row（snake_case）→ DTO（camelCase）映射、active 挑選、排序 |
| `src/lib/release/release-row.test.ts` | 19 條單測 |
| `src/lib/release/release-server.ts` | `server-only`：base URL 解析、select 欄位、錯誤分類、讀 active |
| `src/app/api/release/versions/active/route.ts` | **公開**（免登入）GET，登入頁用 |
| `src/app/api/admin/release-versions/route.ts` | Admin GET / POST / PATCH / DELETE |
| `src/app/admin/versions/page.tsx` | Admin「版本控制」頁 |
| `src/components/app-download-button.tsx` | 登入頁下載按鈕（含裝置偵測） |

### 改動

| 路徑 | 改動 |
|---|---|
| `src/components/login-screen.tsx` | 掛上 `<AppDownloadButton />`（喺 PWA 安裝按鈕之上） |
| `src/components/admin-shell.tsx` | 頂部 nav 加「版本控制」→ `/admin/versions` |

---

## 4. 裝置偵測口徑

```
User-Agent 含 "android"  →  android  →「下載 APK」
其餘                      →  desktop  →「下載安裝包」
```

| 裝置 | 結果 | 備註 |
|---|---|---|
| Android 手機／平板 | `android` | |
| Windows / macOS / Linux | `desktop` | |
| **iPhone / iPad** | `desktop` | 🔴 刻意 —— 我哋冇 iOS 安裝包，而「Android 先叫 mobile」係商家實際口徑 |
| 原生殼（APK WebView / Electron） | **唔顯示任何嘢** | 已經裝咗 |

Fallback：UA **空白**時（自訂 WebView 會清 UA）退用 `navigator.platform`
（`Linux armv8l` / `Linux aarch64` / `Android` → android）。

> 刻意**唔讀** `navigator.userAgentData.mobile`：喺 desktop Chrome 上長期係 `false`（幫唔到手），
> 而 iPad 會報 `true` ⇒ 讀咗反而會令 iPad 派 APK。

---

## 5. 下載連結點砌

```
優先 ①  download_url（完整外部連結，只接受 http(s)）
其次 ②  {SUPABASE_URL}/storage/v1/object/public/macauposapk/<file_path>
都冇 ③  → null（登入頁索性唔顯示按鈕，唔派死 link）
```

🔴 **base URL 唔可以 fallback 去 `NEXT_PUBLIC_SUPABASE_URL`**：

| 變數 | 實際指向 |
|---|---|
| `SUPABASE_URL` | **POS 專案**（`macauposapk` bucket 喺呢度） |
| `NEXT_PUBLIC_SUPABASE_URL` | **Ledger 專案**（冇呢個 bucket） |

2026-09-10 已因「兩邊指唔同專案」出過一次 P0（Realtime 靜默失效）。
呢度係同一類陷阱：fallback 過去會派一條 **404** 連結，而 `<a href>` 404
只係瀏覽器錯誤頁，任何 log 都見唔到。⇒ 寧願返 `null`。

可用 `RELEASE_DOWNLOAD_BASE_URL` 明確覆蓋（將來上 CDN／自訂網域）。

---

## 6. 上線步驟

1. **跑 migration**（最容易漏嘅一步）：
   Supabase Dashboard → **POS 專案**（`iyrywzormzisyppkokbi`，唔係 Ledger）→ SQL Editor
   → 貼 `supabase/migrations/0050_pos_release_versions.sql` → Run。
   全部 idempotent，可以重複貼。檔尾有 6 步驗收 SQL。

2. **確認 Storage bucket**：`macauposapk` 要係 **public**，檔案上傳到根目錄
   （檔名例如 `macau-pos.apk`）。

3. **環境變數**：`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` 必須已設
   （未設 → API 回 `available: false`，admin 頁會顯示提示而唔係爆 500）。
   ⚠️ Vercel 改 env 後要 **Redeploy**。

4. **admin 新增第一個版本**：`/admin` 登入 → 「版本控制」→「新增版本」
   → 平台選 Android → 版本號 `1.0.0` → 檔案路徑 `macau-pos.apk`
   → 勾「新增後即刻設為目前版本」。

5. **驗證**：用 Android 機開登入頁應見「下載 APK」；桌面機應見「下載安裝包」。

---

## 7. 行為細節（唔好改錯）

| 項目 | 行為 |
|---|---|
| 新版本預設狀態 | **唔 active** —— 避免「填錯連結但一生效就即刻對外派」 |
| 對外生效嘅唯一操作 | 「設為目前版本」（＝ RPC 切換） |
| 「停用」 | 允許「該平台暫時冇 active 版本」⇒ 登入頁唔顯示按鈕 |
| 刪除 | 只刪 DB 記錄，**唔刪 Storage 檔案**（破壞性操作要人手做） |
| 生效延遲 | 最多 **60 秒**（`/api/release/versions/active` 有 60s CDN 快取） |
| 編輯表單 | 用 `explicitDownloadUrl`（DB 原值）而唔係解析後嘅 `downloadUrl`，否則會把「由路徑砌」變成「寫死一條 URL」 |

---

## 8. 已知取捨

- **公開 API 有 60 秒快取** —— 換版本後唔會即時生效。想要即時就要犧牲 CDN 快取
  （本專案對 egress 敏感，唔值得）。
- **iPhone / iPad 會見到「下載安裝包」** —— 佢哋其實裝唔到。將來真出 iOS 版就加第三個平台，
  唔好改成「非 desktop 一律 mobile」而靜默改變現有行為。
- **`download` 屬性跨網域無效** —— Supabase Storage 通常靠 `Content-Disposition`
  觸發下載；按鈕用 `target="_blank"` 作為安全失敗模式（萬一被導航，登入頁仍然喺度）。
- **🔴 冇檔案上傳 UI —— 呢個係按需求刻意唔做，唔係漏做。**
  商家要嘅係「喺頁面管理 **link**」（填路徑／貼完整 URL、切換版本），
  檔案本體自己經 Supabase Dashboard 上傳到 `macauposapk`。
  2026-09-23 確認。

  > 若將來真的要做「頁面上傳」，**唔可以**經自家 API route 收檔案：
  > Vercel Function request body 上限 **4.5 MB**，APK 18 MB / 安裝包 90 MB 一定 413。
  > 正確做法 ＝ server 用 service role 簽一條 **signed upload URL**
  > （`createSignedUploadUrl`）→ 瀏覽器持該 URL 直上 Supabase Storage（繞過 Vercel）
  > → 成功後回寫 `file_path`。另外要先確認 Supabase 單檔上限
  > （免費層一般 50 MB ⇒ 90 MB 安裝包放唔入，要另議存放位置）。
