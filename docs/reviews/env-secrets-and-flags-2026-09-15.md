# 環境變數與安全開關實務指南（macau-pos）

> **日期**：2026-09-15
> **對應問題**：`POS_DEVICE_TOKEN_SECRET` / `ADMIN_SESSION_SECRET` 從哪裡取得；`POS_REQUIRE_DEVICE_AUTH=0` 放哪裡、如何生效、有何影響
> **依據**：`src/lib/pos/pos-device-token.ts:50-57,136-140`、`src/lib/admin-session-token.ts:41-46`、`.env.example` B-3/B-4 段
> **已同步更新**：`.env.example`（新增 B-3 / B-4 / B-5 三段 —— 之前完全冇記錄過呢兩支 secret）

---

## 一、兩支簽名密鑰（`POS_DEVICE_TOKEN_SECRET` / `ADMIN_SESSION_SECRET`）

### 1.1 結論先講：**兩支都唔係「向邊個索取」，係你自己生成嘅隨機值**

唔係由 Ledger 團隊派、唔係 Supabase Dashboard 取（Supabase 只有 JWT Secret 那一支，見 §3.3）。
兩支都係**你自己產生嘅隨機 secret**，用途係為 HMAC 簽名提供密鑰。

### 1.2 唔設都可以運作（重要）

兩個 resolver 都有一條 fallback 鏈，所以**唔設唔會壞**：

| 用途 | 解析順序（前者有值就用前者） | 檔案 |
|---|---|---|
| POS 終端憑證 | `POS_DEVICE_TOKEN_SECRET` → `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY` → `null`（fail-closed） | `pos-device-token.ts:50-57` |
| Admin session | `ADMIN_SESSION_SECRET` → `SUPABASE_SERVICE_ROLE_KEY` → `null` | `admin-session-token.ts:41-46` |

> 原設計的論證（`pos-device-token.ts:47-48`）：寫入路徑本身必須有 service role key 才寫得入 DB，
> 所以「能寫 ⇒ 有 secret ⇒ 簽得出／驗得到」三者一致。

**那為何仍建議設定？** 三個實際好處：

1. **輪換唔使換 DB key**：現在想作廢所有 token 就要 rotate `SUPABASE_SERVICE_ROLE_KEY`，那會連帶影響所有 server 端寫入。
2. **唔會兩套憑證共用同一把鎖**：若只設 `ADMIN_SESSION_SECRET`，POS 憑證與 Admin 憑證會簽在同一支 key 上（`pos-device-token` 會 fallback 用它）。
3. **同 service role key 解耦**：service role key 一旦外洩，攻擊者不單能繞 RLS，還能**自行簽發合法 POS／Admin token**。

### 1.3 生成方式

```bash
# 建議（Node）—— 產出 64 個 hex 字元 = 256 bits
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```powershell
# PowerShell 等價寫法
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

**建議長度**：**32 bytes（= 64 個 hex 字元）**。
下限：唔好短過 32 個字元。上限：冇限制（HMAC key 長度唔影響輸出）。

### 1.4 可直接套用的範例值

> ⚠️ 下面兩組係**即時生成嘅真隨機值**，可直接貼去用。
> 但因為佢哋已經出現喺對話紀錄，**若這個對話會被分享／留存，請自行再生成一組**。
> 兩支**必須唔同值**（已確保）。

```env
POS_DEVICE_TOKEN_SECRET=789ed9dd623c752555977a7a0f5708e4bf2f866cd1794f478fb586d21d5446b3
ADMIN_SESSION_SECRET=1e92465a96b181fcfd1bd961d5eac273214be5679292e8753b8f39cabf6847d4
```

### 1.5 應該寫入哪個 env 檔案

| 環境 | 寫哪裡 | 備註 |
|---|---|---|
| **本機開發** | 專案根目錄 `.env.local` | 已由 `.gitignore` 覆蓋，**唔會 commit**。`.env.example` 只放說明與註解值 |
| **生產（Vercel）** | Vercel → Project Settings → **Environment Variables** → **Production** scope | 🔴 **唔需要、亦唔應該**寫入任何檔案 |
| 預覽（Preview） | 同上，Preview scope | 可選；同一組值即可 |

🔴 **三條絕對禁忌**：
1. **唔可以**加 `NEXT_PUBLIC_` 前綴 —— 加咗會被 inline 落瀏覽器 bundle，等於公開（同 `sb_secret_` 外洩同級）。
2. **唔可以**寫入 `.env.example` 的真值位置（該檔會 commit）。已在檔內以註解說明，保持註解狀態。
3. **唔可以**兩支用同一個值。

### 1.6 🔴 設定／改動之後的即時後果

兩支 secret 一改，**所有已簽發嘅 token 即刻失效**（簽名對不上）：

- 全部 POS 終端要**重新登入**（token TTL 12 小時，但簽名已失效 ⇒ 唔會等 TTL）。
- 全部 Admin / Backoffice session 要重新登入。
- 症狀：店員撳任何功能都回 `401 未經授權：需要 POS 終端憑證，請重新登入 POS 帳號。`
  （正是 `docs/113` §「『未經授權：需要 POS 終端憑證。』(401) 排查」那一節的同一訊息 —— 唔好誤判成權限問題。）

⇒ **建議首次上線前就設好。** 若店已營運中要補設，揀**非營業時間**，並預先通知店員重新登入。

### 1.7 驗證清單（設定後）

- ⬜ `node -e "console.log(process.env.POS_DEVICE_TOKEN_SECRET?.length)"` 在同 env 下應回 `64`
- ⬜ 店員重新登入 → 落一張測試單 → 出紙正常（證明簽發與驗證兩邊用同一支 key）
- ⬜ Admin 由 `/settings` 入去撳儲存成功（證明 admin token 亦有效）
- ⬜ 若任何一項 401：先檢查 Vercel 是否**只在 Production scope 設**（Preview 部署會讀唔到）

---

## 二、`POS_REQUIRE_DEVICE_AUTH=0`（應急回滾開關）

### 2.1 放哪裡

**同 §1.5 完全一樣**：本機 → `.env.local`；生產 → Vercel Environment Variables（Production scope）。
`.env.example` B-4 段已加註解說明。

### 2.2 如何設定與生效

判定邏輯（`pos-device-token.ts:136-140`）：

```ts
export function isPosDeviceAuthRequired(): boolean {
  const raw = process.env.POS_REQUIRE_DEVICE_AUTH?.trim();
  if (raw === undefined || raw === "") return true;          // 未設 → 要求鑑權（fail-closed）
  return !(raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off");
}
```

| 設定值 | 結果 |
|---|---|
| 未設 / 空字串 | ✅ **要求鑑權**（預設，fail-closed） |
| `1` / `true` / `yes` / 任何其他字串 | ✅ 要求鑑權 |
| **`0`** / `false` / `FALSE` / `off` / `OFF` | 🚨 **關閉鑑權** |

🔴 **生效方式**：這是 **server 端 runtime 讀取**嘅環境變數（唔係 `NEXT_PUBLIC_`，唔會 inline 落 bundle）。
在 Vercel 改完之後**需要重新部署才會生效**（Vercel 的 env 變更會觸發新 deployment；若用 CLI 改咗但未 redeploy，
可 `vercel --prod` 或推一個空 commit 觸發）。

> 準確講：Vercel 上「改 env → 需要一次新 build」才會套用到 runtime。
> 所以嚴格嚟講佢係「**一個 deployment 嘅時間**」而唔係「即時」。

### 2.3 設為 0 之後的影響

關閉之後，**所有用 `posRouteAuthGuard()` / `isPosDeviceAuthRequired()` 嘅端點一律放行**，
包括 2026-09-15 新加閘嘅 9 條餐飲端點：

| 端點 | 關閉鑑權後可被匿名做的事 |
|---|---|
| `DELETE /api/pos/orders?storeId=` | 🔴 **清空該店所有線下訂單**（營收紀錄無法復原） |
| `GET /api/pos/orders` | 讀該店全部訂單（品項／金額／枱號） |
| `GET/POST /api/pos/shift` | 替他店收工、篡改 `actual_cash` / `cash_difference`、讀走班次財務 |
| `GET/POST /api/pos/device-config` | 覆寫他店打印機綁定與 `printZones`（KDS 分區來源） |
| `GET/POST /api/pos/print-templates` | 改他店收據／廚房單模板 → 影響**實體出紙** |
| `GET/POST /api/pos/note-presets` | 改他店備註預設（含免單／折扣備註） |
| `GET /api/pos/print-jobs/status` | 讀他店打印任務狀態 |
| `POST /api/pos/print-agent/unpair` | 撤銷他店中繼機 → 雲端打印中斷 |
| `GET/POS /api/online-order-settings` | 讀他店接單鏡像、關掉他店自動接單 |

⚠️ **注意：`storeId` 屬半公開**（枱 QR 內容 `?store=<merchantId>` 已經公開）⇒
一旦關閉，攻擊門檻由「有憑證」降到「掃過碼」。

### 2.4 使用注意事項（SOP）

1. **只作臨時措施**：定義為「救火」而唔係「設定選項」。建議同時在團隊頻道記錄「已關閉 + 原因 + 預計恢復時間」。
2. **唔會寫 warning**：原註解聲稱「關閉時 server 會寫 warning log」，但**現行程式碼並冇實作這句 log**
   （`isPosDeviceAuthRequired()` 只回 boolean，冇 console.warn）⇒ **唔可以靠 log 發現有人關咗**。
   建議：關閉期間自行記錄；或日後補上 warn（已列入待辦）。
3. **恢復做法**：刪走該行（或改 `1`）→ 重新部署 → 跑一次「登入 → 落單出紙 → 設置儲存」驗證。
4. **不要用嚟繞過憑證簽發問題**：若根因係 secret 設定錯／未設，正確做法係設好 secret（§1），
   而唔係長期關閉鑑權。
5. **關閉期間 `POS_REQUIRE_DEVICE_AUTH=0` 亦會影響 `/api/pos/state`（原本已有閘）** ⇒ 等於全線無鑑權。

### 2.5 建議的觀察期

| 階段 | 設定 |
|---|---|
| 首次開啟鑑權後 48 小時 | 保持開啟；若出現問題，先看是否 secret 未設／Preview scope 缺 env，**唔好即刻關** |
| 真的需要回滾 | 設 `0` → 重新部署 → 同時開一張故障單記錄 → 修好後**當日**恢復 |

---

## 三、附：其他相關 secret（一次過講清楚）

| 變數 | 誰提供 | 用途 | 唔設會點 |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → POS 專案 → Settings → API | 所有 server 端寫入（繞 RLS） | 🔴 端點回 503；寫入靜默失敗 |
| `AUTH_PIN_PEPPER` | 同 Ledger 用**同一支**（Ledger Vercel env 內） | 店員 PIN 派生登入密碼；**0040 之後亦用作 `pin_hash` 的 pepper** | Ledger 登入失敗 |
| `LEDGER_WEBHOOK_SECRET` | 同 Ledger 團隊夾定**同一支** | 驗入站 webhook HMAC 簽名 | 未設 → 入站一律 500（fail-closed，正確） |
| `SUPABASE_JWT_SECRET` | Supabase Dashboard → POS 專案 → Settings → API → JWT Settings | 【**未啟用**】簽發帶 `store_id` claim 的 token，用嚟根治跨店 anon 讀取 | 唔影響現有功能；見 `0041` §3 |

> `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_POS_SUPABASE_URL` / `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY`
> 屬**公開值**（anon key 設計上就會 inline 落瀏覽器 bundle），唔需要當機密處理 —— 但要靠 RLS 把關。
