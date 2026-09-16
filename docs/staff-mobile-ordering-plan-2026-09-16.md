# 店員手機下單系統 — 完整方案（2026-09-16）

> 目標：讓店員用手機在**枱邊**幫客人現場點餐／下單。
> 訂單直接入後台並**自動出廚房單**（與自助點餐機一致）。
> 手機**不直連打印機** —— 出紙沿用既有雲端打印鏈路。

---

## 實作狀態（2026-09-16 更新）

| 階段 | 狀態 |
|---|---|
| 1 身份與路由骨架 | ✅ 已完成 |
| 2 選枱與點餐 | ✅ 已完成 |
| 3 送單鏈路 | ✅ 已完成 |
| 4 出紙鏈路（建單側） | ✅ 已完成 |
| 5 加單 | ✅ 已完成 |
| 5 權限（終端級「落單專用」） | ✅ 已完成（**非安全邊界**，見 §5.5） |
| 5 權限（帳號級 `waiter` 角色） | ⬜ 未做（需 migration，見 §5.6） |
| 6 打磨與實機驗收 | ⬜ 未做 |

### 5.5 已實作：終端級「落單專用」

揀「店員手機」工作台 ⇒ 該手機被標記為落單專用（`pos.orderOnlyTerminal.<storeId>`），
`AuthGuard` 攔住收銀台路由並導向 `/staff`。白名單只有三個：
`/staff`（落單）、`/login`（憑證過期）、`/select-workbench`（**逃生門**）。

**🔴 這不是安全邊界。** 旗標住 localStorage，只擋前端路由：

```
localStorage.removeItem("pos.orderOnlyTerminal.<storeId>")   // 一秒解除
curl -X POST /api/pos/sync -d '{"events":[{"type":"ORDER_SETTLED",...}]}'  // 直接結帳
```

它解決的是**誤操作**（店員撳錯書籤／上一頁而誤結單），不是權限。
無法阻擋懂技術的人或直接呼叫 API。

### 5.6 未做：帳號級角色（真權限）

三個必要條件，缺一不可：

1. **要有 waiter 的真源** —— Ledger `merchant_staff.staff_role` 只有
   `owner` / `staff`（`api/ledger/login/route.ts:41` 明文註解），
   **沒有 waiter 概念** ⇒ 必須新增 POS 端資料表（建議 `pos_staff_roles`，migration 0043）。
2. **登入時把角色簽入 POS 憑證** —— `issuePosDeviceToken({ role })` 已有欄位，
   但值來自 Ledger ⇒ 要改成讀 POS 端角色覆寫。
3. **`/api/pos/sync` 對「動錢」事件驗角色** —— `ORDER_SETTLED`、退菜、免單。

#### 🔴 前置條件：`POS_REQUIRE_DEVICE_AUTH` 必須開返

`src/lib/pos/pos-route-auth.ts:59`：

```ts
if (!isPosDeviceAuthRequired()) return { ok: true, via: "disabled" };
```

設成 `0` 時**第一條分支直接放行，根本不會讀取 POS 憑證** ⇒
憑證裡的角色無從檢查 ⇒ 就算做完上面三步，角色限制一樣形同虛設。

**驗證步驟**（不可跳步）：

1. 先確認 `POST /api/pos/device-token` 回 200 + token（iPad 續期鏈路通）；
2. 才把 `POS_REQUIRE_DEVICE_AUTH` 設為 `1`（或刪除該變數＝預設開啟）；
3. **Redeploy**（Vercel 改 env 不會自動套用到現有 deployment）；
4. 逐端點驗 401（未帶憑證時應被拒）。

⚠️ 次序不可顛倒：iPad token 續期未通就開閘 ⇒ 全站即刻 401。

---

## 附錄三：權限設計的取捨記錄（2026-09-16）

用戶選擇「先做 A（終端級 UI 收縮）＋按終端區分」，而非直接做帳號級角色。
理由：Ledger 沒有 waiter 概念，做真角色要新表 + Admin UI + 登入改動 + sync 閘，
而你連 0042 都尚未跑。先交付可用的誤操作防護，把真權限留待鑑權閘修好後再做。

**已交付的防護**：`/staff` 介面完全沒有結帳、退菜、折扣、免單功能；
落單專用終端無法透過導航進入收銀台。
**未交付的防護**：無法阻止有人繞過前端直接呼叫 API 結帳。


### 已交付檔案

| 檔案 | 用途 |
|---|---|
| `src/lib/pos/staff-order.ts` | 店員單純函式建構器 |
| `src/lib/pos/spec-selection.ts` | 規格換算（由 pos-app 抽出，單一真源）|
| `src/lib/use-staff-order.ts` | 店員落單狀態核心 |
| `src/components/staff/staff-mobile-app.tsx` | 手機介面 |
| `src/app/staff/page.tsx` | 路由（`AuthGuard`）|

### 實作時發現並修正的三件事

1. **`source` 一定要用 `"pos"`** —— `0015_pos_self_order.sql:19` 的 CHECK 約束
   只允許 `pos`/`kiosk`/`scan`。用 `kiosk` 不但寫入被拒，還會讓收銀端
   當成自助單而**重複出紙**。
2. **出紙前必須拉 `device-config`** —— `buildKitchenPrintJobs()` 靠本機
   `loadDeviceConfig()` 取分區打印機；手機沒設定過，不拉就會
   `zonePrinters.length === 0` → **零出紙且不報錯**。
3. **枱況必須拉雲端** —— 只靠本機訂單，新手機上所有枱都顯示「空枱」，
   店員會為已佔用的枱開重複單。拉不到時明確顯示「枱況未確認」。

---

## 0. 一句話結論

專案裡已經有 **90% 的基礎設施**（菜單 bootstrap、購物車純函式、落單重試隊列、
Realtime 售罄、POS 終端憑證、雲端打印派工）。本方案**不另起一套系統**，
而是在既有骨架上**新增一個「店員身份」的分支**：

- 新增路由 `/staff`（PWA，店員手機開瀏覽器即用）
- 復用 `useOrderingCore()` 的購物車／金額／落單基礎設施（新增 `variant: "staff"`）
- 訂單 `source: "staff"`，**帶 POS 終端憑證**（非匿名通道）
- 落單後由 `pos_print_jobs` 派工出紙，與收銀台完全同一條路

---

## 1. 整體架構

### 1.1 三層結構

| 層 | 元件 | 職責 |
|---|---|---|
| 客戶端 | `/staff`（Next.js PWA） | 店員登入、選枱、點餐、送單、看單況 |
| API 層 | 復用既有 `/api/pos/*` | bootstrap、sequence、sync、state、print-jobs |
| 資料層 | Supabase（POS 專案）+ Ledger | `pos_orders`、`pos_print_jobs`、`pos_bootstrap_config` |

### 1.2 與既有模組的關係

```
                      ┌──────────────────────────┐
                      │  useOrderingCore(variant) │  ← 共用核心
                      └────────────┬─────────────┘
          ┌────────────────────────┼────────────────────────┐
       "kiosk"                  "scan"                   "staff" ← 新增
    /order 自助機            /menu 客人掃碼           /staff 店員手機
   （有單號、印小票）      （無單號、以枱號）      （有單號、帶憑證、不印小票）
```

**關鍵設計原則：只加分支，不改既有行為。**
`variant` 三分支已在 `useOrderingCore` 內建（現有 `"kiosk" | "scan"`），
只需擴充為 `"kiosk" | "scan" | "staff"` 並在分支處決定憑證、單號、打印行為。

### 1.3 為何選 PWA 而非 APK

| 面向 | PWA | APK |
|---|---|---|
| 落地速度 | 極快（復用全部 API） | 慢（需重做憑證／打印） |
| 維護 | 一次改，全店生效 | 需逐台更新 |
| 打印 | 走雲端鏈路 ✅ | 可直連，但需同網段 |
| 適用 | **店員枱邊點餐** | 固定安卓手持機 |

本次場景是「店員用自己手機」，PWA 是正確選擇。

---

## 2. 主要功能模組

| 模組 | 內容 | 來源 |
|---|---|---|
| M1 登入與裝置綁定 | 帳號 + PIN → 換 POS 終端憑證 | 復用 `/login`、`/api/ledger/login` |
| M2 選枱 | 樓面／枱號選擇，顯示佔用狀態 | 依 `bootstrap.tables` + `pos_orders` |
| M3 點餐 | 分類瀏覽、規格選擇、加購物車 | 復用 menu + `ItemSpecModal` |
| M4 購物車與金額 | 數量、備註、折扣、稅／服務費 | 復用 `computeOrderTotals()` |
| M5 送單 | 落單上雲 + 冪等重試 | 新增 `submitStaffOrder()` |
| M6 本枱單況 | 已落菜單、可加單、待付金額 | 復用 resume 邏輯 |
| M7 出紙 | 由雲端派工出廚房單 | **零新增**，沿用 `pos_print_jobs` |
| M8 會員（可選） | 查餘額、扣款 | 復用 `merchant_apply_pos_txn` |

---

## 3. 店員使用流程（端到端）

```
① 開啟 /staff（已加到主畫面）
        ↓
② 首次：輸入帳號 + PIN  →  換取 POS 終端憑證（12h）
   （憑證存 localStorage，之後 12h 內免登入）
        ↓
③ 選枱：樓面圖 / 枱號列表
   ├─ 空枱 → 建立新單（ORDER_CREATED）
   └─ 有單 → 載入本枱現有單，可加單（ORDER_UPDATED）
        ↓
④ 點餐：分類 → 選菜 → 規格 → 加入購物車
   （售罄菜灰化，Realtime 即時更新）
        ↓
⑤ 購物車確認：數量、備註、金額
        ↓
⑥ 送出：POST /api/pos/sync（帶 POS 憑證）
   ├─ 成功 → 訂單入 DB + 派工出紙 ✅
   ├─ 網絡抖動 → 入本地隊列，顯示「已收到，同步中」
   └─ 業務拒絕 → 明確報錯，保留購物車
        ↓
⑦ 回讀確認：由 DB 取回最終單，顯示「已送出，廚房已接單」
        ↓
⑧ 返回選枱，接下一位客人
```

**與客人掃碼流程的關鍵差異**：

| 項目 | 客人掃碼(scan) | 店員手機(staff) |
|---|---|---|
| 身份 | 匿名 | 帶 POS 憑證 |
| 枱號來源 | URL 參數 | 店員主動選 |
| 店休閘 | 擋（`shop-closed`） | **不擋**（同收銀台） |
| 單號 | 無（堂食以枱號） | **有**（店內序號） |
| 出紙 | 收銀台印 | 雲端派工自動印 |

---

## 4. 訂單傳送與後台接收

### 4.1 傳送路徑

```
店員手機 → POST /api/pos/sync（Authorization: Bearer <posDeviceToken>）
              ↓
        resolvePosRouteAuth() → via: "device"
              ↓
        getSupabaseWriteClient()（service_role）
              ↓
        upsert pos_orders + pos_print_jobs
              ↓
        Realtime 廣播 → 收銀台 / KDS / 中繼機
```

### 4.2 後台接收方式

| 接收方 | 機制 | 說明 |
|---|---|---|
| 收銀台 | Supabase Realtime | 訂單即時出現在列表 |
| 廚房屏(KDS) | `pos_kds_*` 輪詢/Realtime | 依 `printerGroup` 分站 |
| 打印中繼機 | `pos_print_jobs` claim | 60s fetch 派工，出紙 |
| 報表 | `pos_orders` 聚合 | 與收銀單同一份真源 |

**沒有任何新通道** —— 店員單與收銀單寫入同一張表，因此報表、
對帳、KDS 全部自動涵蓋。

### 4.3 🔴 最關鍵的技術限制：匿名通道白名單

`src/app/api/pos/sync/route.ts:398`：

```ts
const ANONYMOUS_ALLOWED_SOURCES = new Set(["scan", "kiosk"]);
```

**店員單 `source: "staff"` 必須走「已授權」分支，不可落入匿名通道。**

正確做法有兩種，**建議 A**：

- **A（建議）**：店員單因為**帶 POS 憑證**，`authorized === true`，
  直接繞過白名單檢查（見 `route.ts:686` 的 `if (!authorized && ...)`）
  → **無需修改白名單**，最乾淨。
- B（不建議）：把 `"staff"` 加進白名單 → 等於讓匿名者也能偽造店員單，**開了一個洞**。

⚠️ 因為 **server client 用 service_role 繞 RLS**，白名單加錯會直接裸奔資料庫。

---

## 5. 角色權限與登入機制

### 5.1 既有角色（`login-screen.tsx:57`）

```ts
role: "admin" | "manager" | "cashier"
permissions: { refundOrder, voidItem, manageAccounts? }
```

### 5.2 建議新增角色與權限

| 角色 | 落單 | 加單 | 改單 | 退菜 | 結帳 | 看報表 |
|---|---|---|---|---|---|---|
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| manager | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| cashier | ✅ | ✅ | ✅ | ⚙️可配 | ✅ | ❌ |
| **waiter（新增）** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

`waiter`（服務員）是手機下單的核心角色：
**只能落單／加單，不能收款、不能退菜、不能免單**。

### 5.3 登入機制（復用，不重做）

| 環節 | 實作 | 現況 |
|---|---|---|
| 身份驗證 | `POST /api/ledger/login`（帳號+PIN） | 已有 |
| POS 憑證 | 12h HMAC，含 `storeId` + `role` | 已有 |
| 綁店 | `claims.storeId === storeId` | 已有 |
| 客戶端 | `posDeviceAuthHeadersFresh()` 自動續期 | 已有 |

### 5.4 🔴 店員手機特有的安全要求

1. **憑證不可共用**：每位店員各自登入，不可全店共用一組帳號 ——
   否則「誰落的單」無法追溯。
2. **12h 後強制重新登入**：手機易遺失，不宜長期免登入。
3. **離職即失效**：登入時 server 須驗證帳號仍有效。
4. **🍎 iOS 輸入陷阱（用戶已知硬性要求）**：
   PIN 欄位必須用 `type="text"` + `inputMode="numeric"` + `pattern="[0-9]*"`，
   **不可用 `type="password"`**（iOS Safari 會彈字母鍵盤，店員打不到數字）。

---

## 6. 行動裝置介面設計要點

### 6.1 硬性規範（用戶既定要求）

- 點擊目標 **≥ 40px**
- 內容完整可見，**無文字截斷**
- 響應式佈局，適配多尺寸
- 繁體中文 + 廣東話書面，技術名詞保留英文

### 6.2 版面建議（單手操作優先）

```
┌─────────────────────────┐
│ 枱 A03 · 2人      [切枱] │ ← 頂欄：枱號 + 快捷動作（≥44px）
├─────────────────────────┤
│ [飲品][小食][主菜][甜品]  │ ← 分類：橫向滾動 chips
├─────────────────────────┤
│  ┌────┐ ┌────┐          │
│  │菜品│ │菜品│          │ ← 2 欄網格，卡片 ≥ 88px 高
│  └────┘ └────┘          │
│  ┌────┐ ┌────┐          │
│  └────┘ └────┘          │
├─────────────────────────┤
│ 3 項  合計 $186.00       │ ← 底部結算條（固定，含稅費）
│      [ 查看購物車 ]       │ ← 主 CTA ≥ 48px
└─────────────────────────┘
```

### 6.3 關鍵設計決策

| 要點 | 做法 | 原因 |
|---|---|---|
| 選枱 | 樓面圖 + 列表雙模式 | 店員熟悉枱位，視覺更快 |
| 加菜 | 購物車固定底部條 | 隨時可見、不需回頭找 |
| 售罄 | 灰化 + 標籤，**不移除** | 店員可向客人解釋替代 |
| 送單 | 二次確認對話框 | 防誤觸送出 |
| 加單 | 同枱自動合併，明確標示 | 避免「以為新單」 |
| 離線 | 頂部橫幅提示隊列數 | 店員知道單未上雲 |
| 鍵盤 | 數量用自繪數字鍵盤 | 避免系統鍵盤遮擋 |

### 6.4 手機輸入實作要點（既有慘痛教訓）

- 只准數字的欄位：`onChange` 內 `replace(/\D/g, "")`（處理貼上）
- 加 `onKeyDown` Enter 提交
- 避免系統鍵盤遮擋：用 `refocusForIosKeyboard()`（專案已有）

---

## 7. 分階段實作步驟

### 階段 1：身份與路由骨架

1. `src/app/staff/page.tsx` 新增路由（PWA）
2. `workbench` 目錄新增 `"staff"` 工作台定義（`module-catalog.ts`）
3. 擴充 `OrderingVariant` 為 `"kiosk" | "scan" | "staff"`
4. `/select-workbench` 顯示「店員手機」卡片（依 Admin 授權）
5. 驗證：能登入、能進入 `/staff`

### 階段 2：選枱與點餐

6. 樓面／枱號選擇元件（雙模式）
7. 枱況查詢：哪些枱有未結單
8. 復用菜單瀏覽 + 規格選擇
9. 復用購物車 + `computeOrderTotals()`
10. 驗證：能選枱、能加菜、金額正確

### 階段 3：送單鏈路

11. `buildStaffOrder()`：`source: "staff"`、帶序號
12. `submitStaffOrder()`：帶 POS 憑證，重用既有重試隊列
13. **確認走「已授權」分支**（不進匿名白名單）
14. 落單後由 DB 回讀確認
15. 驗證：訂單入 `pos_orders`，收銀台即時可見

### 階段 4：出紙鏈路驗證

16. 確認 `pos_print_jobs` 有店員單的廚房單
17. 確認中繼機 claim 並出紙
18. 驗證：實機出紙正確、無重複、無漏單

### 階段 5：加單與權限

19. 本枱現有單載入 + 加單
20. 新增 `waiter` 角色與權限校驗
21. 前端依權限隱藏不該有的按鈕
22. 驗證：加單不重複出紙、權限擋得住

### 階段 6：打磨與上線

23. 離線橫幅、隊列狀態顯示
24. 觸控尺寸全面覆核（≥40px）
25. 實機測試（iOS Safari + Android Chrome）
26. 試點一間店，觀察一週後推廣

---

## 8. 技術選項建議

| 面向 | 建議 | 理由 |
|---|---|---|
| 前端 | Next.js PWA（現有） | 零新增框架，復用全部 |
| 狀態 | React hooks（現有） | `useOrderingCore` 已完備 |
| 傳送 | `/api/pos/sync` | 已有冪等＋重試隊列 |
| 資料 | Supabase（POS 專案） | 既有真源 |
| Realtime | 既有 `usePosRealtime` | 售罄／枱況即時 |
| 打印 | 既有雲端派工 | **零修改** |
| 登入 | `/api/ledger/login` | 已有 12h HMAC |
| PWA | `manifest.ts` + `pwa-register` | 已有（可加到主畫面） |

**核心原則：能復用的一律不重寫。**

---

## 9. 限制與風險

### 9.1 🔴 高風險

| 風險 | 說明 | 對策 |
|---|---|---|
| 匿名白名單污染 | 若把 `"staff"` 加進 `ANONYMOUS_ALLOWED_SOURCES`，等於開放偽造店員單 | **必須走已授權分支**，白名單不動 |
| service_role 繞 RLS | 鑑權一旦漏，等於直接裸奔 DB | 每個 route 都過 `posRouteAuthGuard` |
| `POS_REQUIRE_DEVICE_AUTH` | **未設定 ≠ 關閉，預設開啟**；但若被設 `0` 則全局放行 | 上線前確認值為 `1` |
| 重複出紙 | 加單若誤用新 orderId，會造成重複出紙 | 加單必須重用同一 `order.id` |
| 憑證共用 | 全店共用帳號 → 無法追溯責任 | 一人一帳號 |

### 9.2 ⚠️ 中風險

| 風險 | 對策 |
|---|---|
| 手機遺失 | 12h 憑證過期 + 後台可撤銷帳號 |
| 同枱併單衝突 | 兩人同時為同枱加菜 → 後加覆蓋 | 送出前回讀，加單用 diff |
| 離線落單 | 隊列滿時需明確報錯，不可假裝成功 |
| 店休閘 | 店員單**不應**被 `shop-closed` 擋（同收銀台）|
| 序號碰撞 | 手機與收銀機共用 `/api/pos/sequence`，天然不撞 |

### 9.3 已識別的專案地雷（避免踩）

1. 🔴 **建單後必須 `appendPrintJobsWithSync()`** —— 只 `savePrintJobs()` 等於零出紙
2. 🔴 **打印 `ttl` 是絕對 epoch ms**，只在 insert 寫；舊行 `ttl=NULL` 永不過期
3. 🔴 **多個 store_id、每店獨立心跳** —— 排查時要先不帶 store 過濾掃
4. 🔴 **改版「只加不減」** —— 新內容併入原有檔案，不另開新頁取代
5. 🔴 **同檔案不可平行發多個 Edit** —— 會靜默丟失改動

---

## 10. 驗收標準

- [ ] 店員用手機能在 60 秒內完成一次枱邊點餐
- [ ] 訂單 3 秒內出現在收銀台
- [ ] 廚房單正確出紙，無重複、無漏單
- [ ] 加單合併到同一張單，不產生第二張
- [ ] 斷網時單入隊列，恢復後自動補推
- [ ] 所有點擊目標 ≥ 40px
- [ ] iOS Safari PIN 輸入正常彈數字鍵盤
- [ ] 無權限的店員看不到結帳／退菜按鈕
- [ ] `waiter` 角色無法透過 API 越權

---

## 附錄：關鍵程式碼位置

| 檔案 | 用途 |
|---|---|
| `src/lib/use-kiosk-order.ts` | 共用訂單核心（`useOrderingCore`）|
| `src/lib/kiosk-cart.ts` | 購物車純函式 + 金額真源 |
| `src/lib/kiosk-order.ts` | `buildKioskOrder` / `submitKioskOrder` |
| `src/lib/pos/pos-route-auth.ts` | 統一授權閘 |
| `src/lib/pos/pos-device-token.ts` | POS 終端憑證 |
| `src/app/api/pos/sync/route.ts` | 落單主入口（⚠️ 白名單在此）|
| `src/lib/pos/module-catalog.ts` | 工作台／模組唯一真源 |
| `src/lib/print-jobs.ts` | 打印任務建構 |
| `src/lib/pos/print-job-enqueue.ts` | 打印任務入列 + 同步 |

---

## 附錄二：介面確認稿（2026-09-16 已交付）

| 檔案 | 內容 |
|---|---|
| `docs/staff-mobile-ordering-mockup.html` | 六畫面高保真確認稿（可直接開瀏覽器／手機睇）|
| `docs/mockups/staff-mobile-01-login.png` | ① 登入（自繪數字鍵盤）|
| `docs/mockups/staff-mobile-02-tables.png` | ② 選枱（格狀樓面圖，枱況三態）|
| `docs/mockups/staff-mobile-03-order.png` | ③ 點餐主畫面（售罄灰化保留）|
| `docs/mockups/staff-mobile-04-cart.png` | ④ 購物車（大數量鍵）|
| `docs/mockups/staff-mobile-05-confirm.png` | ⑤ 送出確認（二次確認）|
| `docs/mockups/staff-mobile-06-done.png` | ⑥ 送出後回饋（出紙四態）|

### 已確認的設計決定（用戶 2026-09-16 確認）

1. **售罄菜灰化保留**，不隱藏 —— 店員可向客人解釋並建議替代品。
2. **選枱只做格狀樓面圖**，不做列表切換。
3. **枱況三態**：空枱（綠）／用膳中（橙）／即將結帳（紅，帶金額）＋停用（灰）。
4. 手機端**不直連打印機、不收款結帳、不印客人小票**。

### 驗證方式

用真實 Chromium 逐框量度（`tools/` 臨時腳本，已清理）：
**六個畫面全部零溢出、零裁切**；另親眼覆核每張截圖，
修正了兩處版面問題（枱數／菜品數過少導致大片空白；購物車送出按鈕被 grid row 拉伸）。

