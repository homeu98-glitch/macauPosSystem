# 開工流程三問題 — 診斷與實作方案（問題一/二/三）

> 2026-09-07 · 對應 code change：
> - `supabase/migrations/0023_pos_shifts.sql`（新，需喺 Supabase 執行）
> - `src/app/api/pos/shift/route.ts`（新）
> - `src/lib/shift-sync.ts`（新）
> - `src/lib/storage.ts`（ShiftState 加員工 / ack / synced 欄位）
> - `src/components/pos-app.tsx`（開工上雲、reconcile poll、逾時提醒 modal）
> - `src/components/shift-page.tsx`（reconcile、開工上雲、收工上雲）

---

## 問題一：開工/收工狀態跨裝置不同步

### 1.1 根因（已確認，有代碼證據）

開工/收工狀態**從來冇寫入後端資料庫，只存在於每部機嘅 localStorage**：

| 證據 | 位置 |
|---|---|
| `ShiftState` 型別 + `loadShiftState/saveShiftState` 只係 `readStoreJson/writeStoreJson`（localStorage） | `src/lib/storage.ts:713-760`，key = `macau-pos/stores/{merchantId}/shift` |
| 開工按鈕 handler = `saveShiftState(next)` + 發 `pos-shift-changed`（window CustomEvent，**只係同一 window 內 listeners 收到**，跨 tab 都收唔到） | `src/components/pos-app.tsx startWork()`、`src/components/shift-page.tsx` |
| POS 開工 gate（`!shift.openedAt` 全屏鎖）直接讀 localStorage | `src/components/pos-app.tsx`（開工 gate modal） |
| 全 repo **冇任何** shift API route / DB table / `storage` event listener | grep 確認：`/api/*/shift*` 不存在、`pos_shifts` 唔存在 |

所以：
- A 機開工 → 只寫 A 機 localStorage → B 機（另一 browser / 另一部機）嘅 localStorage 仍然係空 → 開工 gate 又彈出，**每次都要求重新開工**；
- 「開工時間唔會更新」：每部機各自造自己嘅 `openedAt`，冇單一真源；開工時間亦只係「嗰部機撳掣嗰刻」嘅 local time。

### 1.2 修正方案：`pos_shifts` 做單一真源 + 離線優先本地即時生效

**資料模型（`0023_pos_shifts.sql`）**：一張表一個班次一行；active 班次 = `closed_at IS NULL`；partial unique index 保證每店同一時間最多一個 active 班次。

| 欄位 | 用途 |
|---|---|
| `store_id` | 店舖（同 `pos_orders.store_id` 口徑 = 登入 merchant UUID） |
| `employee_account / employee_name` | 開工員工（新） |
| `opened_at`（not null） | **開工時間權威**（跨裝置一致） |
| `opening_note` | 開工備註 |
| `overtime_acked_at` | 問題二嘅 ack 權威 |
| `closed_at`（null = active） | 收工時間 |
| `closing_note / actual_cash / cash_difference` | 收工結算 |
| `summary jsonb` | 收工統計快照（settledCount/revenue/…） |

**API（`/api/pos/shift`）**：
- `GET ?storeId=` → `{ active, serverNow }`（active 可能係 null）
- `POST action=open` → 已有 active 就回 `conflict:true + active`（**唔開第二個班次**），否則 insert
- `POST action=close` → update 該 active（冇 active → 404）
- `POST action=ackOvertime` → update `overtime_acked_at`

**前端 merge 規則（`src/lib/shift-sync.ts reconcileLocalShift`，以 server 為權威 + 識 heal）**：

| 場景 | 處理 |
|---|---|
| server 有 active、本地未開工／開工時間唔同 | **adopt server**（解決「換機又要重新開工」+「開工時間唔統一」） |
| server 有 active、本地已收工（`closedAt >= server.openedAt`，即同一班） | 自動**補 close**（上次離線收工漏上雲） |
| server 有 active、本地一致 | 只同步 ack / synced 旗標 |
| server 冇 active、本地開工中 | 自動**補 open**（離線開工事後上雲，以本地 openedAt 為準） |

**觸發時機**：`pos-app.tsx` 每 60 秒 + 網絡恢復（`pos-network-status-changed`）+ window focus；`shift-page.tsx` 入頁一次。離線時完全唔 block 本地操作（離線開工照開，恢復網絡後 reconcile 自動補）。

### 1.3 修改檔案清單

| 檔案 | 改動 |
|---|---|
| `supabase/migrations/0023_pos_shifts.sql` | **新**：建表 + partial unique + 權限（service_role only） |
| `src/app/api/pos/shift/route.ts` | **新**：GET/POST（open/close/ackOvertime），跟 `/api/pos/sync` 同一安全口徑（storeId 白名單 + 假店黑名單 + 長度驗證 + service_role） |
| `src/lib/shift-sync.ts` | **新**：fetcher + reconcile + OT 判斷 |
| `src/lib/storage.ts` | `ShiftState` 加 `employeeAccount/employeeName/overtimeAckedAt/serverSynced/lastCloseSummary` |
| `src/components/pos-app.tsx` | `startWork()` 帶員工 + 上雲（conflict → 以 server 為準）；新增 sync effect（60s + 網絡恢復 + focus）；開工 gate 會因 adopt 自動解鎖 |
| `src/components/shift-page.tsx` | 入頁 reconcile；開工按鈕改 async 上雲；`closeShift()` 收工時先 POST close（失敗提示、唔 block 打印） |

### 1.4 邊界 case

- **離線收工**：收工流程本身要 online（原 `forceSyncBeforeClose` 已擋），但 server close 若失敗仍會完成本地收工 → reconcile 下次自動補 close。
- **兩部機同時開工（race）**：DB unique index 保證只有一個 insert 成功，另一部收到 `conflict` → 自動 adopt 已存在班次。
- **收工統計上雲失敗唔會丟失**：`closeShift` 將收工統計存本地 `lastCloseSummary` 兜底；server close 成功即清走，失敗就由 reconcile「補 close」帶埋上 server（`pos_shifts.summary` 唔會永久缺統計）。
- **本地已收工但 server 仍 active**：用 `closedAt >= openedAt` 判斷係同一班先補 close，避免誤收「收工後另一人先開」嘅新班次。
- **顯示開工員工**：開工/收工都帶 `employeeAccount/employeeName`；交班頁班次狀態顯示「已開工：{員工} · {server 開工時間}」，跨裝置知道邊個開咗工。

### 1.5 驗證

```bash
# 1. Supabase 跑 0023 migration
# 2. 兩部機／兩個 browser 用同一店登入：
#    A 開工 → B（唔使開工，等 ≤60s 或 re-focus）自動變「已開工」，時間 = A 嘅 server 時間
# 3. A 收工 → B 自動變「未開工」
# 4. 斷網開工（devtools offline）→ 恢復網絡 ≤60s 內 server 出現該班次
```

---

## 問題二：連續開工超過 10 小時自動提醒

### 2.1 計時邏輯與判斷依據（以後端為準）

**權威值全部喺 server**：`pos_shifts.opened_at`（開工時間）、`overtime_acked_at`（最近一次「取消」ack）、server clock（`GET` 回傳 `serverNow`）。

```
連續營業時長  = serverNow − opened_at                       （首次提醒門檻 10h）
提醒條件       = 連續營業時長 ≥ 10h
              AND (overtime_acked_at IS NULL            ← 未 ack 過，由開工起計
                   OR serverNow − overtime_acked_at ≥ 10h)  ← 已 ack，要再滿 10h 先再提醒
```

`src/lib/shift-sync.ts isShiftOvertimeDue()` 用 serverNow（唔用 client clock），任何一部機計出嚟都一樣 → **跨裝置行為一致**。ack 寫入 server（`overtime_acked_at = server now`），A 機撳「取消」之後，B 機唔會再彈。

### 2.2 行為規格

- **彈窗文案**：「你已經連續上班超過 10 個小時，需要交班嗎？」
- **取消（繼續營業）** → `POST ackOvertime`（server 記 `overtime_acked_at = now`）→ 關閉；再累計滿 10 小時重新觸發。
- **確認，去交班** → `router.push("/shift")`，喺交班頁完成結數收工（收工 = `closed_at` 寫上，提醒自然消失）。
- **重新整理 / 重新登入仍正確**：因判斷嚟自 server `opened_at + overtime_acked_at`，重開 app 後 reconcile 攞返 server state，會按同一條件再彈（若已 ack 且未再滿 10h 就唔會彈）。

### 2.3 修改檔案清單

| 檔案 | 改動 |
|---|---|
| `supabase/migrations/0023_pos_shifts.sql` | `overtime_acked_at` 欄 |
| `src/app/api/pos/shift/route.ts` | `POST action=ackOvertime`；`GET` 回 `serverNow` |
| `src/lib/shift-sync.ts` | `isShiftOvertimeDue(openedAt, ackedAt, serverNow)`、`serverAckOvertime()` |
| `src/components/pos-app.tsx` | sync effect 每次 reconcile 更新 `shiftOvertimeDue`；逾時 modal（「取消（繼續營業）」= ack；「確認，去交班」= 跳 `/shift`）；`acknowledgeShiftOvertime()` handler |

### 2.4 驗證（測試劇本）

```
1. 直接喺 DB 將 active shift 嘅 opened_at 改做 11 小時前（或改 serverNow 較易：臨時
   用 sql 改 opened_at = now() - interval '11 hours'）→ ≤60s 內任何開住嘅 POS 都彈窗。
2. 撳「取消」→ DB overtime_acked_at 有值；另一部機唔會彈。
3. 再將 opened_at 提早 / 或等 10h（唔實際等就再手動推前 opened_at 同清 ack）→ 再彈。
4. 撳「確認，去交班」→ 去 /shift；喺嗰度交班（close）後，全部機唔再彈。
```

---

## 問題三：iPad 輸入欄位無法喚起鍵盤

### 3.1 已確認排除（codebase 層面冇問題嘅地方）

已檢查並排除以下常見 iOS 鍵盤殺手：
- ❌ 冇任何 `touchstart/touchmove` 嘅 `preventDefault`（嗰種會令成頁 input 無法 focus）——全 repo 只有 `beforeinstallprompt`（pwa-register）同 Enter key（login）兩個無害 handler。
- ❌ `globals.css` 冇 `user-select: none` / `-webkit-user-select` / `-webkit-touch-callout`。
- ❌ 全屏 flash / toast 層都有 `pointer-events-none`（`pos-app.tsx` orderSuccessFlash / settlementFlash），唔會食 tap。
- ❌ `ResponsiveModal` overlay `onClick={onClose}` 有 `stopPropagation` 喺 panel；正常唔會搶 focus。

### 3.2 最可能成因（按機率排）

1. **iPadOS 實體鍵盤連接**（Magic Keyboard / 藍牙）：iPadOS 偵測到實體鍵盤時**唔會彈虛擬鍵盤**。若店內 iPad 用緊鍵盤保護套，呢個係 100% 系統行為，唔係 bug。→ 驗證：拔走鍵盤／熄藍牙再 tap。
2. **頁面 / app 被加咗 PWA 全屏（standalone）＋ `body { overflow: hidden }`**：鍵盤彈出時 iOS 會縮細 visual viewport 並嘗試 scroll 去 focused input；如果 input 喺內部 scroll container 而 container 又啱啱喺視口外，部分 iOS 版本會 focus 失敗或鍵盤即彈即縮（似「唔彈」）。呢個同全 app `body{overflow:hidden}` 嘅設計有關。
3. **點擊被「兩段式」消費**：input 喺橫向 `overflow-auto` 表格（例如交班歷史「補錄備註」列）內，第一下 tap 可能被當成 scroll，要 tap 多一下先 focus。
4. **特定 input 型別**：`<input type="search">` 喺 iOS 有時要 tap 兩次；`readOnly` 或 disabled 就完全唔彈（檢查有冇誤設）。

### 3.3 現場驗證步驟（喺出事嘅 iPad 做）

```js
// 喺 Safari / PWA 嘅 console（或臨時加喺頁面）貼呢段，睇 tap 之後 focus 有冇發生：
document.addEventListener('pointerup', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    setTimeout(() => {
      console.log('target:', t.id || t.className, '| activeElement:', document.activeElement === t, '| readonly:', t.readOnly, '| disabled:', t.disabled);
    }, 50);
  }
});
```

判讀：
- `activeElement === false` → tap 根本冇 focus 到 input → 屬 3.2-2/3/4（元素被遮／要 tap 兩次／readOnly）→ 對應下方修正 A。
- `activeElement === true` 但鍵盤唔彈 → 屬 3.2-1（實體鍵盤）→ 無 code fix，檢查鍵盤連接。

### 3.4 對症修正

- **修正 A（保險，建議做）**：輸入框 focus 時強制捲入視野。喺 root layout 加一個全局 `focusin` listener，凡 `INPUT/TEXTAREA/SELECT` 被 focus 就 `el.scrollIntoView({ block: "center", behavior: "smooth" })`，並避免元素被 fixed bottom sheet 遮住。要小心只喺 `document.activeElement` 喺內部 scroll container 時做，避免同 POS 本身嘅 scroll 行為打架（實現見 `src/lib/ios-focus-helper.ts`，optional）。
- **修正 B**：若確認係 `overflow-hidden` body 導致，將出事頁嘅最外層內容 wrapper 確保係可滾動容器（同報表頁問題一樣嘅「內部 scroll container」模式），唔好靠 body scroll。
- **實體鍵盤 case**：喺 UI 加唔到 fix；寫入操作指引（店員手冊）：「iPad 若駁住鍵盤，虛擬鍵盤唔會彈出屬正常」。

---

## 部署 / 執行清單

1. 喺 **Supabase SQL Editor 執行** `supabase/migrations/0023_pos_shifts.sql`（idempotent，可重跑）。
2. `tsc --noEmit` 已通過（0 errors）；`next build` 確認後部署 Vercel。
3. 部署後按上面 1.5 / 2.4 劇本驗證。

## 已知限制 / 之後再做

- 交班**歷史**仍只存本機（60 條）；`pos_shifts.summary` 已開始累積 server 數據，日後可加 `/api/pos/shift/history` 做跨裝置交班歷史。
- 開工 employee 欄位由今次開始寫；舊班次（未上雲前）冇員工資料屬正常。
