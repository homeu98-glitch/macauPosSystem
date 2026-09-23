# 147 · 版本過期偵測覆蓋面（2026-09-23）

> 一句話：收銀台「版本過期」橫幅本身早就做好，但**偵測時機太遲**（可能幾個鐘唔出）——
> 呢次將偵測**搭上兩個本來就會打嘅週期請求**，**零新增請求、零新增流量**。

---

## 1. 問題：橫幅做咗，但可能唔出

`src/components/build-stale-banner.tsx`（2026-09-22 上線，見
`docs/reviews/errwarn-and-call-audit-2026-09-21.md` 附錄 F.1）要有
「**本機 JS 版本 ≠ 線上最新版本**」先會出現。

- 「本機版本」＝建置時**內聯**入 bundle（`next.config.ts`）⇒ 唔使問人。
- 「線上最新」＝**回應標頭** `x-pos-build` ⇒ 一定要有請求先拎得到。

🔴 **改動前只有 `/api/pos/state` 帶呢個標頭，而佢係純事件驅動、冇週期輪詢**
（mount／Realtime 重連／手動／撞 limit 才會打；架構刻意如此，見 `pos-app.tsx` 註解
「即時架構（用家要求：禁用 polling）」）。

實測：靜置 20 秒內 `/api/pos/state` **只打 1 次**
⇒ 一部開住、Realtime 連線健康嘅收銀機，可能**幾個鐘**都唔會再拉 state
⇒ 明明跑住舊 bundle，橫幅一直唔出 —— 而「開住舊分頁靜靜燒 egress」
正正係呢個橫幅想防嘅事（09-21 事故：單一舊分頁佔 97% egress）。

---

## 2. 做法：搭既有週期請求（唯一允許嘅做法）

| 請求 | 頻率 | 之前帶標頭？ | 現在 |
|---|---|---|---|
| `GET /api/pos/state` | 事件驅動（可能幾個鐘一次） | ✅ | ✅（不變） |
| **`POST /api/pos/sync`** | 有 pending 事件時 **每 30 秒** | ❌ | ✅ **新增** |
| **`GET /api/pos/shift`** | **每 180 秒**（受輪詢閘限制） | ❌ | ✅ **新增** |

### 🔴 硬性紀律：唔准為咗呢件事增加任何請求

本專案對請求數／egress 極敏感（`docs/113`、`src/lib/pos/egress-meter-server.ts`）。
⇒ **唔可以**為咗令版本資訊快啲到手而：
- 新增一個版本檢查 endpoint（`/api/version`）；
- 加快任何輪詢間隔；
- 喺 server 內部 fetch 自己嘅 API。

呢條紀律已寫成守衛測試（見 §4），「零新增請求」係可執行嘅約束，唔係口號。

**實際成本**：一個標頭 ≈ 20 bytes。相對 response body（`/api/pos/state` 一次 35 KB）
完全可忽略；而且**冇任何新請求**。

---

## 3. 實作

### 新增

| 檔案 | 作用 |
|---|---|
| `src/lib/build-info-server.ts` | `buildJson()` —— 包住 `NextResponse.json()`，**自動**落 `x-pos-build` |
| `src/lib/build-info-observe.ts` | `observeServerBuildFromResponse(response)` —— client 側讀標頭（**永不 throw**） |
| `src/lib/pos/build-header-contract.test.ts` | 9 條守衛（見 §4） |

### 改動

| 檔案 | 改動 |
|---|---|
| `src/app/api/pos/sync/route.ts` | **13** 個 `NextResponse.json(` → `buildJson(` |
| `src/app/api/pos/shift/route.ts` | **28** 個（＋ `validateStoreId` 回傳型別 `NextResponse` → `Response`） |
| `src/lib/pos/sync-flush.ts` | fetch 之後 `observeServerBuildFromResponse(result)`（放喺 `if (!result.ok)` **之前**，失敗回應一樣帶標頭） |
| `src/lib/shift-sync.ts` | `fetchServerShiftState()` 嘅 GET 之後讀標頭 |
| `src/components/pos-app.tsx` | 原本寫死 `"x-pos-build"` 字串 → 改用共用讀取器 |

### 為何要包 `buildJson()` 而唔係逐個 `return` 手動 set

sync 有 13 個 return、shift 有 **28** 個 —— 手動加**一定會漏**，
而漏咗嘅後果係**靜默**（橫幅唔出、零錯誤、零 log）。
用 wrapper 之後，**將來新增嘅任何 return 都自動帶標頭**。

### 為何標頭名唔可以喺各處寫死

真源係 `src/lib/pos/session-record.ts` 嘅 `POS_BUILD_HEADER`。
兩處各寫一次 `"x-pos-build"` 必然漂移（本專案已中過多次「同一個判斷寫兩次」）。

---

## 4. 守衛（9 條，`build-header-contract.test.ts`）

| 組 | 守住 |
|---|---|
| 回應側 | sync / shift route **唔可以**再出現裸 `NextResponse.json(` |
| 回應側 | `buildJson()` 必須用 `POS_BUILD_HEADER`（唔准字面字串）＋ 有 `server-only` |
| 讀取側 | 三個讀取點（`pos-app` / `sync-flush` / `shift-sync`）都要用共用讀取器 |
| 讀取側 | 讀取器必須 `try/catch`（唔可以影響落單流程） |
| 讀取側 | `@/lib/build-info` 仍然**零 import**（`node --test` 要直接載入） |
| 🔴 零新增請求 | 版本相關模組**唔可以有** `fetch(` / `setInterval` / XHR |
| 🔴 零新增請求 | sync / shift route 唔可以內部 fetch 自己嘅 API |

### 反向驗證（證明守衛唔係空轉）

故意植入 3 個違規，**3 條對應守衛即刻失敗**，還原後回綠：

| 植入 | 被抓 |
|---|---|
| sync route 改回 `NextResponse.json(` | ✅ 回應側第 1 條 |
| `build-info-observe.ts` 加 `fetch("/api/version")` ＋ 唔用共用讀取器 | ✅ 零新增請求組 ＋ 讀取側 |
| `shift-sync.ts` 改回寫死 `"x-pos-build"` | ✅ 讀取側第 1 條 |

---

## 5. 驗證證據（真瀏覽器，2026-09-23）

### 5a. 兩個 route 嘅回應都帶標頭（連錯誤回應都帶）

```bash
GET /api/pos/shift?storeId=66123456   → 503  | x-pos-build = "aaaaaaa"   ✅
GET /api/pos/state?storeId=66123456   → 401  | x-pos-build = null
```

（`shift` 連 503 都帶標頭 ⇒ 28 個 return 全部覆蓋，包括錯誤路徑。
`state` 嘅 401 係既有行為 —— 佢喺設定標頭之前就 early return，唔屬本次範圍。）

### 5b. 隔離驗證：橫幅**確實係由 shift 路徑**驅動

手法（決定性隔離）：

1. dev server 用 `VERCEL_GIT_COMMIT_SHA=aaa…` 啟動 ⇒ client 內聯 id ＝ `aaaaaaa`；
2. 攔 `/api/pos/state`，**剝走** `x-pos-build` ⇒ 呢條路徑**無法**提供版本；
3. 攔 `/api/pos/shift`，**加上** `x-pos-build: bbbbbbb`；
4. 如果橫幅出現且顯示 `bbbbbbb` ⇒ 只可能嚟自 shift 路徑。

結果：**5/5 PASS**

```
hits.state = 1   hits.shift = 1
可疑新 endpoint（version/build/release）= (none) ✅
bannerLine = ⚠ 此裝置運行舊版本（本機 aaaaaaa（… · 本機）， 線上最新 bbbbbbb）
```

截圖：`docs/mockups/build-header-from-shift-verify-2026-09-23.png`

### 5c. 驗證同一輪嘅頁面其他 `/api` 請求（全部係既有）

`/api/pos/store-status`、`/api/pos/device-token`、`/api/pos/bootstrap`、
`/api/topup/pending-count`、`/api/online-order-settings`
⇒ **冇任何新 endpoint 被叫**。

### 5d. 靜態檢查

`tsc --noEmit` 0 error ｜ `node --test` **1331 pass / 0 fail**（1,322 ＋ 9）

---

## 6. 副作用評估（為何安全）

| 關注 | 評估 |
|---|---|
| 請求數 | **不變** —— 只喺本來就會回嘅回應上加標頭 |
| egress | 每回應 +~20 bytes（response header **唔計入** Supabase 帳單，Supabase 計嘅係 DB→function） |
| 行為 | **零改動** —— body、status、DB 查詢全部不變；舊 client 完全唔理個標頭 |
| 收銀流程 | 讀標頭包咗 `try/catch`，任何意外都靜默 ⇒ 最壞情況只係少一次版本更新 |
| 快取 | sync 係 POST（無 CDN 快取）；shift 係 dynamic route（同樣無快取）⇒ 加標頭唔影響快取行為 |
| 錯誤回應 | 順帶**改善**：以前只有 state 嘅成功回應帶標頭，而家 sync／shift 連 401／503 都帶 |

---

## 7. 仍未覆蓋（刻意，等拍板）

- **其他端別**：`/retail`、`/staff`、`/kitchen`、`/expo`、`/order`、`/admin/*`
  都**冇**版本過期橫幅（佢哋唔用 `pos-app.tsx`）。要加就逐個端接，屬另一個改動。
- **完全閒置嘅收銀機**：輪詢閘（`poll-gate`）喺閒置 ≥5 分鐘／兩條接單通路都關／已收工時
  會停掉週期請求 ⇒ 嗰段時間偵測唔到。但嗰段時間**幾乎零 egress**，
  而有人返嚟用（開單 → pending 事件 → sync）就會喺 30 秒內偵測到 ⇒ 可接受。
- **形態維持「頁頂 in-flow 橫幅」**，唔改 toast —— 附錄 F.1 明文理由：
  `fixed` overlay 會蓋住「開工／線上接單／線下接單」控制項。
