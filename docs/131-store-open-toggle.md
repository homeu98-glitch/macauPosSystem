# 131. 「店內營業」開關（線下營業狀態）

> **狀態**：2026-09-14 已實作（POS 側）。**migration 0039 要喺 Supabase SQL Editor 手動跑**。
> **相關**：`docs/125`（線上接單／開關店 —— **係另一個開關**）、`docs/115`（掃碼模式）、
> `docs/113`（坑總表 §店內營業開關）、`docs/87`（kiosk）。

---

## 1. 需求（J 2026-09-14）

設置頁「線上接單」開關隔籬加一個「**營業中**」開關，控制**線下**營業狀態：

1. 獨立於「線上接單」，切換「營業中」唔會影響線上接單設定……
2. ……但**關店要連帶暫停線上接單**（J 拍板：單向連動）。
3. 暫停營業 → 掃碼點餐同 kiosk 均無法落單，顯示「商家不在營業中」。
4. 不影響現有「開工」／「交班」功能。
5. ~~交班後未重新開工 → 同樣無法落單~~ → **J 拍板唔做**（見 §6）。

---

## 2. 🔴 兩個「營業中」一定要分清

| 開關 | 真源 | 鏡像／儲存 | 關咗之後 |
|---|---|---|---|
| **線上接單**（原名「線上訂單」） | **Ledger** `merchants.merchant_enabled`（RPC `merchant_set_order_enabled`） | `pos_online_order_settings.merchant_enabled`（0036，跨機 Realtime） | 會員通**線上**落唔到單；店內堂食／快餐／掃碼／kiosk **照舊** |
| **店內營業**（本文件） | **POS DB** `pos_store_status.is_open`（0039） | 同一張表（跨機 Realtime） | 掃碼點餐（`/menu`、`/quick`）＋ kiosk（`/order`）落唔到單 |

⚠️ **開關入口 = 側欄底部「商店名卡」**（2026-09-14 定案，見 §3.1）。設置頁 header 只剩
「線上接單」一粒 pill（嗰粒同分頁已由「線上訂單」改名做「**線上接單**」）。

⚠️ `merchant-open-pill.tsx` 嘅**預設確認文案**寫死「只影響會員通（店內堂食、快餐、自助點餐
不受影響）」—— 只適用於線上接單。店內營業用 `confirmMessage` prop 自己嗰句，否則會講大話。

---

### 2.1 入口位置同顏色（2026-09-14 由設置頁 header 搬入側欄）

**入口 = 側欄底部嘅「商店名卡」**（`app-sidebar.tsx`，即「表嫂美食／總部」嗰格）。

| 狀態 | 外觀 | 角色行 |
|---|---|---|
| 營業中 | `bg-slate-800` ＋ `text-slate-200`（**完全保留現狀**） | 顯示角色（總部／店長／收銀） |
| 已暫停 | `bg-red-600` ＋ 白字 | 讓位顯示「**已暫停**」 |
| 未讀到（`null`） | 同「營業中」外觀但**停用** | — |

- **撳商店名 = 撳開關**：營業中 → 彈二次確認；已暫停 → 即時開返；未讀到 → 停用（`title` 講明原因）。
- 位置維持喺「同步／在線」徽章**上方**、**零額外行高**（同「工作台入口搬去設置頁」同一個
  「側欄每行都係稀缺資源」取捨）。
- ⚠️ 側欄「同步受阻」徽章本身都係 `bg-red-600` → **同一個紅有兩個意思**，
  靠位置（商店名卡）同文字（已暫停／同步受阻）分辨。J 已知悉並拍板用紅。
- 行為（二次確認文案、單向連動、失敗提示）全部喺 `src/lib/pos/use-store-open-toggle.ts`，
  UI 只負責畫掣 → 下次再搬位唔使抄邏輯。
- ⚠️ **只喺桌面側欄（`md:` 以上）有入口**；手機底部 nav 冇營業狀態顯示（如有需要再補）。

## 3. 單向連動（J 2026-09-14 拍板）

```
關「店內營業」 ──→ 前端順手 setMerchantEnabled(false)（Ledger RPC）
                    └─ 失敗（未登入 / RPC 未上線）→ **照關**店內營業 ＋ 提示手動撳

切「線上接單」 ──→ 唔影響「店內營業」

開「店內營業」 ──→ **唔會**自動開返「線上接單」（原本暫停可能係刻意）
                    └─ 若線上接單仍暫停 → 出提示「如需接單請撳隔籬嗰粒掣」
```

點解重開唔對稱開返：店主可能因為某啲原因（例如線上平台對帳）刻意暫停收線上單，
唔應該由「開返鋪」呢個動作擅自幫佢開返。

---

## 4. 資料流

```
收銀撳「店內營業」
  └─ POST /api/pos/store-status（要 POS 終端憑證）
        └─ pos_store_status（POS DB）
              ├─ 0039 Realtime publication → 其他收銀機 pill 即時跟住變
              └─ /api/pos/sync 嘅 **2.55 營業中閘** 讀佢做權威判斷
```

| 讀者 | 途徑 | 憑證 | 失敗時 |
|---|---|---|---|
| 收銀機 pill（`useStoreStatus`） | GET + POST `/api/pos/store-status` | POST 要 POS 憑證 | `isOpen: null` → 顯示「未接通」＋停用 |
| 客人端（掃碼 / kiosk） | GET 同上（入頁一次 ＋ 落單前） | **唔使** | 當營業中（fail-open） |
| server 硬閘（`/api/pos/sync` 2.55） | 直接 service_role 讀 DB | — | 放行（fail-open） |

### 4.1 點解兩邊都 fail-open

| 情況 | 做法 | 理由 |
|---|---|---|
| 客人端讀唔到（離線 / 42P01） | 當**營業中**，`storeOpen` 保持 `null`（未知，唔阻） | 反過來＝一斷網全店掃碼＋kiosk 即停（誤停業）。最壞「多撳一下」由 server 擋 |
| server 查唔到 | **放行** | 同售罄校驗「查唔到唔好當全部售罄」一致 |
| `pos_store_status` 無 row | **營業中**（`DEFAULT_STORE_OPEN = true`） | 新店／舊店一上線唔可以即刻停業（同 0036 鏡像欄 DEFAULT true 同一考慮） |

⚠️ 呢個 default **唔可以**改 false。`store-status.test.ts` 有測試鎖死。

### 4.2 客端 UI gating

`useOrderingCore()` 暴露 `storeOpen: boolean | null`（`useKioskOrder` 自動繼承；
`useScanOrder` 有轉發）。三個頁面：

- `app/order/page.tsx`（kiosk）：`storeOpen === false && !submittedOrder` → 全屏
- `components/scan-order-page.tsx`（`/menu`、`/quick`）：
  `storeOpen === false && !quickPickupOrder && !activeTableOrder` → 全屏

🔴 **一定要加「未落單」條件**：客人落單之後店員一關店，如果無條件蓋走畫面，
**扣款結果 / 取餐號**就冇咗 —— S9 扣款未確認時「重試」係唯一入口，蓋走等於嗰筆扣款永遠冇人知。

### 4.3 落單被拒

`/api/pos/sync` 2.55（只喺 `!authorized` 時查，每 request 一次）：

```ts
if (!authorized && storeClosed) {
  rejectBusiness(...);
  ack(false, "商家不在營業中", { reason: "shop-closed" });
  continue;
}
```

- 回 4xx `retryable:false` → client 側 `KioskOrderRejectedError`（已加 `reason`）
- `placeOrder()` catch 到 `reason === "shop-closed"` → `setStoreOpen(false)` → 轉全屏
- **唔會**入本地待同步隊列（重試一萬次都唔會成功）

---

## 5. 檔案清單

| 檔案 | 動作 |
|---|---|
| `supabase/migrations/0039_pos_store_status.sql` | 新增 —— 表 / RLS（anon SELECT + service_role ALL）/ Realtime publication / 驗收 SQL |
| `src/lib/pos/store-status.ts` | 新增 —— 純函式（`normalizeStoreOpen` / `readStoreOpenFromPayload`）＋ fetcher |
| `src/lib/pos/store-status.test.ts` | 新增 —— 11 個 `node --test`（鎖死 default true 同 `fromServer` 語意） |
| `src/app/api/pos/store-status/route.ts` | 新增 —— GET（開放＋限流）/ POST（POS 憑證）；42P01 降級 |
| `src/lib/pos/use-store-status.ts` | 新增 —— module store（server + Realtime + visibilitychange，禁 polling） |
| `src/components/app-sidebar.tsx` | 改 —— **商店名卡變成營業狀態開關**（撳商店名 = 切換；已暫停 = `bg-red-600` ＋「已暫停」行；未讀到 = 停用） |
| `src/lib/pos/use-store-open-toggle.ts` | 新增 —— **共用行為層**：`CONFIRM_CLOSE_STORE_MESSAGE` ＋ 二次確認 ＋ 單向連動 ＋ 提示 |
| `src/components/device-settings.tsx` | 改 —— header **移除**「店內營業」pill（已搬側欄）；tab 改「線上接單」 |
| `src/components/merchant-open-pill.tsx` | 改 —— 加 `confirmMessage` prop（預設文案唔可以借畀店內營業） |
| `src/components/merchant-order-config-section.tsx` | 改 —— header pill 同 section 標題改「線上接單」 |
| `src/lib/kiosk-order.ts` | 改 —— `KioskOrderRejectedError` 加 `reason`（4xx 帶 `myAck.reason`） |
| `src/lib/use-kiosk-order.ts` | 改 —— `storeOpen` state ＋ 入頁讀一次 ＋ i18n ＋ catch `shop-closed` |
| `src/lib/use-scan-order.ts` | 改 —— 轉發 `storeOpen` |
| `src/components/scan-order-page.tsx` | 改 —— 全屏停單頁 |
| `src/app/order/page.tsx` | 改 —— 全屏停單頁 |
| `src/app/api/pos/sync/route.ts` | 改 —— 2.55 營業中閘 |
| `docs/113-agent-gotchas.md` | 改 —— 新增「店內營業開關」一節 |

---

## 6. ⚠️ 未做 / 已知限制

1. ~~**需求 4（交班後未重新開工 → 落唔到單）刻意未實作**（J 2026-09-14 拍板「唔查開工」）~~
   → **2026-09-18 已實作**（J 第三輪拍板「3. 做」）。見 §8 班次閘。
   原判斷（「交班後未開工」同「從來冇開工」喺 `pos_shifts` 上完全一樣）仍然成立，
   但結論改咗：正因為兩者一樣，**冇 open row 就係未開工**——呢個係事實記錄，
   唔係「未設定」。所以 server 側可以放心擋（客端仍然只被動反應，唔自己查）。
2. **客人端唔會即時知**（只喺入頁 / 返前景讀一次）。已經企喺 kiosk 前面揀緊菜嘅客人，
   會喺**撳落單**嗰刻被拒（然後轉全屏）。冇做 Realtime 匿名訂閱 —— 成本同 RLS 風險唔值。
3. **未跑 migration 0039**：收銀撳掣會回 503「表未建立」（**唔會**靜靜當成功）；
   客人端照樣落得到單（fail-open）。
4. **`/api/pos/store-status` 仍有假店 fallback**（`DEFAULT_STORE_ID = "macau-store-a"`，
   GET 53 行 / POST 117-119 行）：缺 `storeId` 時會靜默寫入呢間假店，
   同 `/api/online-order-settings` 2026-09-15 已移除 fallback 嘅做法唔一致。
   **2026-09-18 記錄，未收緊**（改動會影響 URL 回溯兼容性，要另開一輪確認）。

---

## 8. 關店總掣（2026-09-18）

### 8.1 需求（J 2026-09-18）

> 「結數完成後，我發現線上系統和線下系統並沒有在同一個時間點被關閉……」
> 「當完成結帳並執行關店操作後，要能一次性地將該門市的所有線上與線下通路全部一起關閉。」

**根因**：`closeShift()` 以前**完全唔碰**任何接單開關 —— 班次收咗，
但掃碼／kiosk（`pos_store_status.is_open`）同線上（Ledger `merchant_enabled`）
照樣開住，客人仍然落得到單。三條軌道（班次／線下接單／線上接單）互不相干，
係**設計現狀**，唔係 bug。

### 8.2 四個取捨點（J 2026-09-18 拍板）

| # | 取捨 | 拍板 |
|---|---|---|
| 1 | step2 勾選框預設狀態 | **預設勾** |
| 2 | 線下關成功但線上失敗 | **保留線下已關 + 提示**（唔回滾） |
| 3 | 順帶把「未開工不可落單」延伸到客人端 | **做** |
| 4 | `/pos` 加「殘留通道」紅點 | **加** |

### 8.3 執行紀律

- **序列，唔並行**：先線下後線上（線下係店門口嗰道閘，次序有意義）。
- **中途失敗繼續行**：線下關唔到**唔可以** `return`，否則連帶令線上永遠關唔到。
- **`null`（未讀到）＝ `skipped`，唔算失敗**：本來就冇值可以關；寫落去會製造假狀態。
- **永遠唔 throw**：交班流程唔應該因為關店出問題而中斷。
- **位置**：喺 `forceSyncBeforeClose()` 之後、**兩個 early return 之前**
  （打印總開關關咗 / server close 失敗嗰兩個 return 都會完成交班，關店唔可以排喺佢哋之後）。

### 8.4 架構：為咩要 module-level 函式（A 方案）

`closeShift()` 係普通 async function，**唔可以**呼叫 hook。兩個選擇之中揀咗 **A**：

| | 做法 | 結果 |
|---|---|---|
| ~~B~~ | `ShiftPage` 掛 hook + setter 塞 ref | 多開 Realtime channel、stale closure 溫床 |
| **A** | 兩個 hook 模組**額外 export 模組層函式** `applyStoreOpen()` / `applyMerchantEnabled()`，hook 內嘅 setter 轉呼叫佢 | 單一真源、可被非 React 呼叫端重用 |

### 8.5 檔案清單

| 檔案 | 改動 |
|---|---|
| `src/lib/pos/close-gate.ts` | **新增**（純決策 + 文案，**零 import**） |
| `src/lib/pos/close-gate-run.ts` | **新增**（執行層：import 兩個 hook 模組，`runCloseGate()`） |
| `src/lib/pos/close-gate.test.ts` | **新增**（14 test） |
| `src/lib/pos/residual-channel.ts` | **新增**（殘留通道偵測，**零 import**） |
| `src/lib/pos/residual-channel.test.ts` | **新增**（10 test） |
| `src/lib/pos/use-store-status.ts` | 抽 `applyStoreOpen()` 出模組層（export） |
| `src/lib/pos/use-merchant-order-config.ts` | 抽 `applyMerchantEnabled()` 出模組層（export） |
| `src/components/shift-page.tsx` | step2 勾選、step3 回顯、`closeShift()` 接總掣、狀態列彙總 |
| `src/components/merchant-open-pill.tsx` | 新增 `residual` / `residualHint` prop（label 前加警示點） |
| `src/components/store-open-pill.tsx` | 傳 `residual`（線下關 + 線上開） |
| `src/components/online-open-pill.tsx` | 傳 `residual`（線上關 + 線下開） |
| `src/app/api/pos/sync/route.ts` | 新增 **2.56) 班次閘** + `reason: "shift-closed"` |
| `src/lib/use-kiosk-order.ts` | `shiftClosed` state + i18n（`shiftClosedTitle` / `Body`） |
| `src/lib/use-scan-order.ts` | 轉發 `shiftClosed` |
| `src/app/order/page.tsx`、`src/components/scan-order-page.tsx` | 全屏「本店尚未開始營業」 |
| `src/lib/kiosk-order.ts` | `KioskOrderRejectedError.reason` 文件補 `shift-closed` |

### 8.6 班次閘口徑（`/api/pos/sync` 2.56 段）

| 情況 | 行為 |
|---|---|
| 匿名 + `pos_shifts` 有 open row | 放行 |
| 匿名 + **冇** open row | 拒單，`reason: "shift-closed"` |
| 匿名 + 查詢失敗（42P01 等） | **放行**（fail-open —— 唔可以一斷網全店停單） |
| **帶 POS 憑證**（收銀台） | **完全唔受影響**（逃生門） |

🔴 **同 2.55 段嘅 default 方向刻意相反**：
`pos_store_status` 冇 row ＝ 營業中（店主冇主動暫停過）；
`pos_shifts` 冇 open row ＝ **真係未開工**（班次係事實記錄）。

🔴 **`shop-closed` 同 `shift-closed` 唔可以撈埋**：
前者係店主主動關門（叫客人等可能等到今日都唔開）；
後者係未開工／已收工（叫客人「稍後再試」係有意義嘅）。所以客端分兩套文案。

### 8.7 驗收

1. **step2 勾選預設勾住**；取消勾選 → step3 顯示「接單狀態不變」+ step2 出琥珀警示。
2. **交班 + 勾住** → 側欄商店名卡變紅、線上 pill 變「已暫停」；兩粒 pill **唔出**警示點。
3. **部分失敗** → 狀態列出黃色／紅色附註，**明確講邊條通道未關** + 去側欄補救；
   線下**維持已關**（唔回滾）。
4. **未讀到（`null`）** → `skipped`，唔算失敗，狀態列唔出警告。
5. **`residual` 警示點**：線下關 + 線上開 → 線下 pill 出點；
   線上關 + 線下開 → 線上 pill 出點；兩粒**永遠唔會同時**出點。
6. **客端**：未開工時客人撳落單 → server 拒 → 全屏「本店尚未開始營業」（**唔係**
   「商家不在營業中」）；`pos_orders` **冇**新 row。
7. **收銀逃生門**：未開工時收銀台**照樣**落單 / 結帳（帶憑證唔受閘影響）。
8. `tsc --noEmit` 0 error ／ `node --test` 新增 24 test 全 pass。


---

## 7. 驗收

1. **側欄一眼睇到**：營業中時商店名卡同現狀一模一樣（深灰 ＋ 角色行）；
   撳一下 → 彈二次確認 → 確定後**變紅** ＋ 角色行顯示「已暫停」；
   「同步／在線」徽章**唔受影響**（佢講網絡同資料同步）。
   同一時間設置頁 header 只見到「線上接單」一粒 pill。
2. **關店**：撳側欄商店名卡 → 確認框文案講明「掃碼／自助點餐機落唔到單 ＋ 會暫停線上接單」
   → 確認後商店名卡變紅，設置頁「線上接單」pill 亦變「已暫停」。
3. **掃碼**：客人手機開 `/quick?store=<storeId>` → 即刻「商家不在營業中」。
4. **kiosk**：`/order` 同樣。
5. **落單硬閘**：已開住菜單嘅客人撳落單 → 唔會「落單成功」，即刻轉全屏；
   `pos_orders` **冇**新 row。
6. **收銀逃生門**：店已暫停時，收銀台**照樣**落單 / 結帳 / 補印（帶 POS 憑證唔受閘影響）。
7. **重開**：撳返側欄嗰格紅卡 → 掃碼 / kiosk 即刻落得到；「線上接單」**仍然暫停** ＋ 出提示。
8. **跨機**：A 機撳關 → B 機（開住設置頁）3 秒內變「已暫停」
   （前提：Vercel 有 `NEXT_PUBLIC_POS_SUPABASE_URL` / `_ANON_KEY` 並已重新部署；
   否則 `crossTerminalSync` 會係 `on-enter`）。
9. **離線／未跑 migration**：唔會停業（當營業中），收銀 pill 顯示「未接通」。
10. `tsc --noEmit` 0 error ／ `eslint` 改動檔 0 error ／ `node --test store-status.test.ts` 11/11 pass。
