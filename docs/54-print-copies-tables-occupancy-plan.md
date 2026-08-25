# 實作計畫：打印張數 / 10 人桌台與占用顯示 / 菜品明細輸出

> 日期：2026-08-25
> 狀態：**Done（2026-08-25 已實作，tsc 0 error / eslint 0 error）**
> 範圍：餐飲 POS（`pos-app` / `device-settings` / `print-bridge`）+ Salon 收據打印（共用 print-bridge 基建）

---

## 一、總覽

| 功能 | 模組 | 資料結構調整 | 影響範圍 |
|------|------|--------------|----------|
| ① 每次打單打印張數 | `print-bridge/dispatch.ts` + `salon/print.ts` + `device-settings.tsx` | `DevicePrinterConfig` 新增 `copies?: number` | 餐飲 + Salon 全部打印通道（native / companion / relay）+ 測試打印 |
| ② 10 人桌台 + 占用顯示 | `device-settings.tsx` + `pos-app.tsx` | 無（`StoreTable.capacity` 已存在） | 設置桌台 UI + 桌台總覽卡片 |
| ③ 菜品明細輸出 | 無 | 無 | **零改動**，沿用現有廚房單格式 |

---

## 二、功能 ①：每次打單打印張數（copies per printer）

### 2.1 資料結構調整
`src/lib/types.ts` — `DevicePrinterConfig`（~line 169）新增可選欄位：

```ts
/** 每次打單打印份數；未設定或 ≤1 視為 1 份 */
copies?: number;
```

- 舊店遷移：欄位為 optional，未寫入的店家讀到 `undefined` → 實作時一律 `?? 1`，**零遷移**。
- 嚴格化：`Math.max(1, Math.floor(printer.copies ?? 1))`，避免 0 / 負 / 小數。

### 2.2 設定 UI（模組：`device-settings.tsx`）
- 位置：打印機配置卡片，現有最後一個欄位為「ESC/POS 跨碼（中文字集）」selector（~line 974–987），在其後、`</div>`（988）前新增一組 `<label>`。
- 控件：數字輸入框，綁 `printer.copies`，經 `updatePrinter(printer.id, { copies: Number(event.target.value) || 1 })` 寫回（與現有 lanPort / capacity 同款寫法，line 933 / 2043 對齊）。
- 屬性：`min={1}`、`max={9}`、`inputMode="numeric"`、placeholder「1」、說明文字「每次打單打印張數（1–9）」。

### 2.3 套用張數（模組：`print-bridge/dispatch.ts` → `dispatchOneJob`）
現有 `dispatchOneJob`（line 85–119）是餐飲**唯一**派發入口，三通道（native / companion / relay）都在這裡 if/else 分派。改法：解析出 `printer` 後，先算 `copies`，再把「選定通道的一次發送」包進 `for` 迴圈。

```ts
async function dispatchOneJob(job: PrintJob) {
  const printer = resolveJobPrinter(job);
  if (!printer) return { ok: false, error: `搵唔到對應打印機（printerGroup=${job.printerGroup}）` };

  const kind = printer.role === "receipt" ? "receipt" : "kitchen";
  const storeName = loadBootstrapCache()?.storeName;
  const copies = Math.max(1, Math.floor(printer.copies ?? 1));

  // 依通道選定「發送函式」一次，再 loop copies 次（同一張單印 N 份）
  const sendOnce = isNativeBridgeAvailable()
    ? () => dispatchJobToNative(job, { printer, kind, storeName })
    : getCompanionTransport()
      ? (c: typeof getCompanionTransport()) => c!.send(job, printer, { kind, storeName })
      : getRelayTransport()
        ? (r: typeof getRelayTransport()) => r!.send(job, printer, { kind, storeName })
        : null;

  if (!sendOnce) return { ok: false, error: "無可用打印通道（native / companion / relay 都無）" };
  for (let i = 0; i < copies; i++) {
    const res = await sendOnce(isNativeBridgeAvailable() ? undefined : (getCompanionTransport() || getRelayTransport())!);
    if (!res.ok) return res;   // 任一份失敗即整單標 failed（避免只印一半）
  }
  return { ok: true };
}
```

> 說明：上層 `flushPendingPrintJobs`（line 21）按 `result.ok` 把 job 標 `sent`/`failed`，copies 迴圈放在 `dispatchOneJob` 內不影響外層狀態機，也不會觸發重複 flush（`isFlushing` 鎖仍在）。

### 2.4 Salon 平行入口（模組：`salon/print.ts` → `dispatchPrint`）
Salon 收據打印**沒有**走 `dispatch.ts`，而是自建 `dispatchPrint`（line 29–61），結構是 `dispatchOneJob` 的平行拷貝。為保持與現有「餐飲 / salon 各自維護 dispatch」架構一致（非動公共基建），**同款 copies 迴圈照抄進 `dispatchPrint`**：解析 `printer` 後加 `const copies = Math.max(1, Math.floor(printer.copies ?? 1))`，把 native/companion/relay 三分支包進 `for` 迴圈。

> 替代方案（未採用，留作日後重構）：抽 `dispatchJobWithCopies(job)` 共用模組讓兩邊呼叫。現階段為最小爆破半徑，維持雙份邏輯。

### 2.5 測試打印（模組：`device-settings.tsx` → `testPrint`，line 463）
`testPrint` 有 native（490）/ companion（518）兩分支，各自發一次。為讓商家能驗證張數設定，兩分支各包 `for (let i=0;i<copies;i++)`，`copies` 取 `printer.copies ?? 1`。

### 2.6 影響範圍
- 改：`types.ts`、`device-settings.tsx`（UI + testPrint）、`dispatch.ts`、`salon/print.ts`。
- 不動：`companion-transport.ts` / `relay-transport.ts` / `native.ts` 的單次發送契約（張數在 dispatch 層 loop，不污染傳輸層）。
- 覆蓋：餐飲 normal/kitchen/receipt 單 + Salon 收據 / 返結單，三通道全數生效。

---

## 三、功能 ②：10 人桌台 + 占用顯示「已坐人數/總人數」

### 3.1 資料結構調整
**無需調整**。`StoreTable`（types.ts line 128）已有 `capacity?: number`。

### 3.2 桌台設定 UI（模組：`device-settings.tsx`）
- 「新增桌子」預設 `capacity: 4`（line 1994）——保留 4 為預設值即可，**不強制改 10**。
- 每桌 `capacity` 輸入框（line 2030–2053）已 `type="number"`、`min={1}`、**無 max 上限**，因此輸入 10 已經支援。確認項：
  - 维持 `min={1}`，不必加 max（或加 `max={99}` 防呆，可選）。
  - placeholder 已為「座位數」，足夠。
- 結論：設定側**近乎零改動**，僅確認「可輸入 10」成立（已成立）。如需更友好，可把預設 4 → 改為常見 4/6/10 快速鈕，但非必要。

### 3.3 桌台總覽占用顯示（模組：`pos-app.tsx`，line 2841–2888）
現狀：
- 區域行：`{table.area}{table.capacity ? ` · ${table.capacity} 座位` : ""}`（line 2877–2879）
- 徽章：`labelFull = seated ? `${label} · ${seated}人` : label`（line 2855）

改成「已坐人數/總人數」格式：

```ts
const seatedCount = seatedPartySizes[table.id] ?? 0;
const total = table.capacity ?? 0;          // 未設 capacity → 顯示「—」
const occupancy = total > 0 ? `${seatedCount}/${total}` : `${seatedCount}/—`;
```

顯示位置（兩選其一，建議 B）：
- **A**：把區域行 `· ${capacity} 座位` 換成 `· 已坐 ${seatedCount}/${total}`。
- **B（推薦）**：狀態徽章維持「已下單 / 空閒」等語意；另起一行小字顯示占用，例如 `已坐 {seatedCount}/{total}`，無人佔用即 `0/10`。capacity 缺失顯示 `0/—`。

`seatedPartySizes` 已在 `pos-app.tsx`（line 180）由 `loadOrders()` 的 `partySize` 彙總，來源不變，只需調顯示公式。

### 3.4 影響範圍
- 改：`device-settings.tsx`（確認/微調，近乎零）、`pos-app.tsx` 桌台總覽卡片（line 2841–2888）。
- 不動：桌台 modal（line 2920–2921 的「（N 座位）」）可保留或同步改為 `已坐/seated/total`，建議保留現狀以減爆破；若用戶要統一可一併改。
- Salon 不涉及：`salon/settings.tsx` 的 `capacity` 是「服務站位容量」（`SalonStationType`），與餐飲桌台無關，不動。
- 全倉搜證：`座位` / `capacity` 渲染點僅 `device-settings.tsx`（設定）+ `pos-app.tsx`（總覽 + modal），無第三處，影響完整。

---

## 四、功能 ③：菜品明細輸出（沿用廚房單格式）

### 4.1 現狀確認（關鍵）
`src/components/kitchen-ticket-preview.tsx`（line 11–40）已直接拿 `PrintJob.items` 重畫：
- `item.name` — 菜品名
- `item.quantity` — 份數
- `item.specs?.join(" / ")` — 規格 / 加料
- `item.note` — 備註（紅字）

實際出單路徑（EscPosRenderer / companion / native）用的也是同一份 `PrintJob.items`。即「廚房打印單」本就輸出菜品層級明細（名 / 份 / 規格 / 備註）。

### 4.2 結論
**用戶明確表示「直接沿用現有廚房打印單格式，無須額外調整」→ 本功能零程式改動。**
- 僅於本文檔記錄為「已確認沿用」，並在實作後於收據 / 廚房模板預覽做一次視覺確認（見 §五）。
- 若未來要把「收據單」也套用廚房單的明細排版，屬另一需求，不在本次範圍。

---

## 五、驗證方式

1. **types / 編譯**：`npx tsc --noEmit`（已知 layout.tsx `LayoutProps` standalone 誤報，Vercel build 無礙，忽略）。
2. **功能 ①**：
   - 設置頁把某收據機 `copies` 設 3 → 結帳一張單，確認實體出 3 份。
   - Salon 結帳同樣出 3 份（驗證 salon/print.ts 平行迴圈）。
   - `copies` 留空 / 設 0 / 設負 → 視為 1 份（不報錯）。
   - 測試打印按鈕按 copies 出份數。
3. **功能 ②**：
   - 設置新增 `capacity=10` 桌台 → 總覽顯示 `0/10`；開桌坐 5 人 → 顯示 `5/10`。
   - 既有 `capacity=4` 桌台顯示 `0/4` → `N/4` 正常。
4. **功能 ③**：收據 / 廚房模板預覽目視確認菜品明細（名 / 份 / 規格 / 備註）已如現狀呈現，無回歸。

---

## 六、實作順序（確認後）

1. `types.ts` 加 `copies` 欄位。
2. `device-settings.tsx`：打印機 `copies` 輸入框 + `testPrint` 迴圈。
3. `dispatch.ts` `dispatchOneJob` 套 copies 迴圈。
4. `salon/print.ts` `dispatchPrint` 套 copies 迴圈。
5. `pos-app.tsx` 桌台總覽占用顯示改 `已坐/總`。
6. `npx tsc --noEmit` 驗證；docs/54 標記 done；memory 記錄。

---

## 七、風險與注意

- **重複出單**：copies 在 dispatch 層 loop，若通道本身（如 companion 內部）已做 retry，需確認不雙重乘。現 companion/relay `send` 為單次 POST，無內部倍率，安全。
- **失敗語意**：任一份失敗即整單 `failed`，避免「印了 2 份第 3 份失敗」半成品；商家重試會從頭印 copies 份（可接受）。
- **Salon 雙份維護**：copies 邏輯在餐飲 / salon 各一份，後續若改打印架構應同步，已在 §2.4 註記。
- **capacity 語意**：僅餐飲桌台用 `StoreTable.capacity`；Salon 同名欄位含義不同，勿混淆。

---

## 八、實作記錄（2026-08-25）

| 項 | 落點 | 改動 |
|----|------|------|
| ① types | `src/lib/types.ts` `DevicePrinterConfig` | 加 `copies?: number` |
| ① UI | `src/components/device-settings.tsx` 打印機卡片 | 「ESC/POS 跨碼」後加「每次打單打印張數」數字框（1–9），`updatePrinter({copies})` 寫回 |
| ① 餐飲套用 | `src/lib/print-bridge/dispatch.ts` `dispatchOneJob` | 解析 printer 後取 `copies = max(1, floor(copies??1))`，native/companion/relay 各 `for(i<copies)` 發送；任份失敗整單 failed |
| ① Salon 套用 | `src/lib/salon/print.ts` `dispatchPrint` | 同款 copies 迴圈（平行入口） |
| ① 測試打印 | `src/components/device-settings.tsx` `testPrint` | native / companion 兩分支各 `for(i<copies)`；狀態提示加「（N 份）」 |
| ② 桌台 UI | `src/components/device-settings.tsx` | 每桌 `capacity` 輸入框本就 `min=1` 無上限，10 已支援；無需改設定邏輯（預設維持 4） |
| ② 占用顯示 | `src/components/pos-app.tsx` 桌台總覽卡片 | 改用 `已坐 {seatedCount}/{total}`（無人 `0/10`、capacity 缺失 `0/—`）；狀態徽章維持語意 |
| ③ 菜品明細 | 無 | 確認沿用 `kitchen-ticket-preview.tsx` 現有 `PrintJob.items` 格式，零改動 |

驗證：`npx tsc --noEmit` 僅 layout.tsx `LayoutProps` 已知 standalone 誤報（Vercel build 無礙），實作相關 0 error；`eslint` 0 error（7 個預存 warning 與本次無關）。

