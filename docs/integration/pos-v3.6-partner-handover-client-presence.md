# 給 macauPosSystem 的 Admin「商戶端活躍」回報交接（可直接轉貼）

> **歸檔說明（POS 端）**：本檔由 Ledger 於 2026-09-24 經微信發送，原樣歸檔供追溯；
> 檔名嘅 `v3.6` 係**我方按前例推斷**（v3.4＝§4.5／§5.11、v3.5＝§5.12、本檔＝§4.6），
> 未經 Ledger 確認。實作記錄見 [`../148-ledger-client-presence-pos.md`](../148-ledger-client-presence-pos.md)。
> ⚠️ 引用嘅權威契約 `pos-ledger-client-api.md` **§4.6 我哋手上未有**（mirror 仍係 v3.4／2026-09-11）—— 已向 Ledger 索取。


> **對象**：[homeu98-glitch/macauPosSystem](https://github.com/homeu98-glitch/macauPosSystem)（Joe）  
> **部署**：[macau-pos-system.vercel.app](https://macau-pos-system.vercel.app/)  
> **日期**：2026-09-24  
> **權威契約**：[pos-ledger-client-api.md](pos-ledger-client-api.md) **§4.6**（以該檔為準；本文是實作清單）  
> **Ledger 內部說明**：[merchant-client-presence.md](../merchant-client-presence.md)  
> **前置**：店員 Ledger 登入仍看契約 **§4.1–§4.4**（與 v3.2 相同 HMAC + `signInWithPassword` + `merchant_staff` 驗證）。  
> **不是**：即時「誰在線」監控。**不是**：顧客登入（§4.5）回報。**不是**：新增 Ledger HTTP Route。**不是**：需要 `SUPABASE_SERVICE_ROLE_KEY`。

請把本檔 + 契約 §4.6 交給 POS Agent。規格細節以契約為準。

---

## 一句話

店員在 POS 用 Ledger 電話 + PIN **登入成功**（或 PWA **恢復 session**）後，用**店員 JWT** client 直連 Ledger Supabase，呼叫 **`record_merchant_client_login(..., 'pos')`**。Ledger Admin `/admin` 的「**商戶端活躍與接入**」才會顯示該店的 **POS** 欄有時間。

**僅在 macau-pos-system 登入、未呼叫此 RPC → Admin 不會顯示 POS 活躍**（這是預期，不是 Ledger bug）。

---

## Admin 上會看到什麼？

| 項目 | 說明 |
|------|------|
| **位置** | Ledger Admin → `/admin` → 卡片「**商戶端活躍與接入**」 |
| **正式 Admin** | `https://membership.macau-tech.com/admin` |
| **UAT Admin** | `https://membership-uat.macau-tech.com/admin` |
| **粒度** | 每店 × 端別：`web`／`sunmi`／`pos`；**不含**哪位店員、哪台裝置 ID |
| **語意** | **近 30 日最後活躍**，不是「現在正在登入」 |
| **POS 欄** | 有 `last_login_at` → 顯示澳門時區時間；僅 integration HTTP 成功 → 顯示「整合活動」；都沒有 →「尚未回報」 |

Ledger **不** polling POS、**不**讀 POS 自有 Supabase。資料只來自客戶端主動回報或窄幅 integration API。

---

## 何時呼叫（店員 §4 專用）

| 時機 | 要呼叫？ | 備註 |
|------|----------|------|
| 店員 `POST /api/ledger/login` 成功 + 已驗 `merchant_staff` | ✅ **必做** | 取得 `merchant_id` 後立刻 fire-and-forget |
| PWA／瀏覽器重開，**恢復** Ledger session 且仍為店員 | ✅ **建議** | 對齊商米 App `restoreSession()` |
| Supabase `onAuthStateChange`：`INITIAL_SESSION` | ✅ 建議 | 對齊 Ledger Web 商戶端 |
| Supabase `onAuthStateChange`：`TOKEN_REFRESHED` | ✅ 可選 | JWT 約 1h refresh；DB 端 6h 節流，多呼無害 |
| 顧客掃碼登入（§4.5） | ❌ **禁止** | 一般會員無 `merchant_staff`，RPC 會 `not authorized` |
| 每次 RPC／每次按鍵 | ❌ 禁止 | 無 polling；靠登入 + session 恢復 + refresh 即可 |

---

## 實作（client 直連 Ledger Supabase）

### 參數

| 參數 | 值 |
|------|-----|
| `p_merchant_id` | §4.3 查到的 `merchant_staff.merchant_id`（UUID） |
| `p_client` | 固定字串 **`pos`**（小寫） |
| `p_app_version` | 選填；建議 POS 語意版本，例如 `1.2.0` 或 git tag（勿含 PIN／電話） |

### RPC

```http
POST {NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/record_merchant_client_login
Authorization: Bearer <店員 access_token>
apikey: {NEXT_PUBLIC_SUPABASE_ANON_KEY}
Content-Type: application/json

{
  "p_merchant_id": "<merchant_id uuid>",
  "p_client": "pos",
  "p_app_version": "1.2.0"
}
```

### TypeScript（supabase-js）

```typescript
async function reportPosClientPresence(
  ledger: SupabaseClient,
  merchantId: string,
) {
  const { error } = await ledger.rpc("record_merchant_client_login", {
    p_merchant_id: merchantId,
    p_client: "pos",
    p_app_version: process.env.NEXT_PUBLIC_POS_APP_VERSION ?? null,
  });
  if (error) {
    console.warn("[pos-presence] record failed:", error.message);
  }
}
```

### 建議掛點（概念）

```typescript
// 1) 店員登入成功後（§4.2 步驟 4–5 之後）
const { data: staff } = await ledger
  .from("merchant_staff")
  .select("merchant_id")
  .eq("user_id", session.user.id)
  .limit(1)
  .maybeSingle();
if (staff?.merchant_id) {
  void reportPosClientPresence(ledger, staff.merchant_id);
}

// 2) App shell：恢復 session 時（勿阻塞 UI）
ledger.auth.onAuthStateChange((event) => {
  if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") {
    void refreshStaffMerchantAndReport(ledger);
  }
});
```

**錯誤處理**：RPC 失敗**不得**阻擋進 POS 主畫面；`console.warn` 即可（與 Ledger Web／商米 App 相同）。

**節流**：DB 端同一 `(merchant_id, pos)` **6 小時內**重複呼叫通常**不更新** `last_login_at`（版本字串變更仍會更新）。POS **不需要**自做 6h timer。

---

## 環境（與店員登入相同）

| 環境 | Ledger Admin | Ledger Supabase |
|------|--------------|-----------------|
| **UAT** | `https://membership-uat.macau-tech.com/admin` | UAT 專案 URL + anon（與現有 pepper 同套） |
| **正式** | `https://membership.macau-tech.com/admin` | 正式專案 URL + anon |

macau-pos-system 連哪套 Ledger，Admin 就要看**同一套**環境。UAT 登入不會出現在正式 Admin。

**不要**再要 `SUPABASE_SERVICE_ROLE_KEY`。

---

## 驗收步驟（給 Joe／QA）

1. 用示範店員登入 POS（正式例：`60000002` / `2222`，店名通常為「老饕牛肉麵 [示範]」）。
2. 確認 POS 登入流程已呼叫 `record_merchant_client_login`（Network 見 RPC 200；或 log 無 warn）。
3. 開啟**同環境** Ledger Admin `/admin`，重新整理（Dashboard 有約 60s cache）。
4. 「商戶端活躍與接入」該店 **POS** 欄應顯示剛才時間（澳門時區）。
5. 可選：篩選 chip「有 POS 活躍」、排序「POS」欄，確認列表行為正常。

**對照**：同一帳號登入 Ledger 商戶 Web `/merchant/login` 應更新 **網頁** 欄；兩端互不取代。

---

## 若暫未實作 RPC：僅有的替代訊號

下列 Ledger **integration HTTP** 成功時，Admin POS 欄可能顯示 **「整合活動」**（`last_integration_at`，**不是**完整登入）：

| API | 何時 |
|-----|------|
| `POST /api/integration/pos/ensure-customer` | 代建未註冊會員成功 |
| `POST /api/integration/pos/scan-debit/commit` | 掃碼扣餘額 commit 成功 |

**僅登入、未做上述操作 → Admin POS 仍「尚未回報」。** 產品期望仍是登入後呼叫 §4.6 RPC。

---

## 禁止項

- 顧客 JWT 呼叫 `record_merchant_client_login`（會失敗或誤報）。
- 用 POS 自有 Supabase client 打 Ledger RPC（須 Ledger 專案 client + 店員 session）。
- 為此功能新增對 Ledger Vercel 的 polling／heartbeat Route。
- 把 pepper、PIN、完整 JWT 寫進 `p_app_version` 或前端 log。

---

## 參考實作（Ledger 端，供對照）

| 客戶端 | 行為 |
|--------|------|
| Ledger 商戶 Web | 登入 Server Action + `MerchantClientPresenceReporter`（`web`） |
| macau-ledger-merchant 商米 App | `login()` / `restoreSession()` 後 RPC（`sunmi` + `VERSION_NAME`） |
| macauPosSystem（本需求） | 店員登入／恢復 session 後 RPC（`pos` + 自訂版本字串） |

商米 Kotlin 片段（語意相同）：

```kotlin
supabase.postgrest.rpc(
    function = "record_merchant_client_login",
    parameters = buildJsonObject {
        put("p_merchant_id", merchantId)
        put("p_client", "pos")          // POS 用 "pos"，商米用 "sunmi"
        put("p_app_version", appVersion)
    },
)
```

---

## DB 前置（Ledger 維護）

正式／UAT Ledger 須已套用 migration `20260924120000_merchant_client_presence.sql`（含 RPC 與 Admin summary 擴充）。若 RPC 回 `function does not exist`，請聯絡 Ledger 方 `db:push`，不是 POS 端能自行修復。

---

## 附：給 Joe 的 Slack／Email 草稿

> macau-pos-system 店員登入 Ledger 成功後，請 client 直連 Ledger Supabase 多打一支 RPC：  
> `record_merchant_client_login(merchant_id, 'pos', app_version)`。  
> 這樣 membership Admin「商戶端活躍與接入」才會顯示 POS 欄。  
> 不是即時在線監控；近 30 日最後活躍。  
> 完整步驟：`Macau-Ledger/docs/integration/pos-partner-handover-client-presence.md`（契約 §4.6）。
