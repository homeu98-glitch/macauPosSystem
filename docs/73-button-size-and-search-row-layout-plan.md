# 73 · 兩按鈕尺寸異常 + 搜尋列佈局 修復計畫

> 日期：2026-08-27
> 範圍：`macauPosSystem/src/components/pos-app.tsx`（staff POS 收銀主頁，Kiosk/online 共用 layout）
> 狀態：**計劃（先出 plan，confirm 先落碼）**
> 症狀：① 兩按鈕寬高 / 字體異常（與其他標準按鈕唔一致）；② 點「搜尋商品」後品類位移 / 換行；③ 品類 + 搜尋 + 清除必須**同行、同高、同基線**。

---

## 1. 問題定位（從圖實測）

| # | 對象 | 位置 | 症狀 | 同頁「標準按鈕」對照 |
|---|---|---|---|---|
| **A** | **「返結帳」badge**（橙色大圓） | `pos-app.tsx:3106`（reopened 單） 同 `3127`（已結帳單） | `text-[22px]` 過大；`rounded-full` + 被右側文字擠壓 → 文字逐字垂直換行「返 / 結 / 帳」 | 其他 badge 用 `text-sm`（14px），同頁 `+ / -` 用 `text-sm`、返回桌台 `text-xs` |
| **B** | **「清除」button**（搜尋列右） | `pos-app.tsx:3441` | 被 input `w-full` 擠壓；`rounded-2xl` + 無 `whitespace-nowrap` → 變高窄 pill「清 / 除」 | 同列 input `text-sm`；同頁類別按鈕 `text-sm`、高度 `py-2` |
| (C) | 「編輯備註」button | `pos-app.tsx:3263` | 同一根因：`rounded-full` 畀 `flex flex-wrap` 容器擠壓 → 折成兩行「編輯備 / 註」 | 字體 `text-xs` 已標準；純 layout bug |

> **「兩個尺寸異常的按鈕」主要係 A 同 B**（最明顯嘅字體過大 / 被擠變形）；C 同根因，一齊順手修。

**佈局問題（第三項要求）**：
- D. 品類（`全部` + 分類）同搜尋列喺 `flex flex-col xl:flex-row` 兩組，xl 下 input focus 由 `w-40` 變 `w-72` → search 容器變闊 → **偷走品類空間** → 品類 reflow / 換行。
- E. 品類容器 `flex flex-wrap` 容許換行；`清除` 冇 `shrink-0` 會被壓到 0 寬。
- F. 三者高度未統一（badge / 類別 / 搜尋 `py-2` vs 編輯備註 `py-1`）→ 基線唔齊。

---

## 2. 根因（共同模式）

所有「尺寸異常」按鈕都係同一個 flex 陷阱：

> **`rounded-full` / `rounded-2xl` button 缺少 `whitespace-nowrap` + `shrink-0`，被 flex 兄弟擠壓後，CJK 逐字換行 → 高度暴增 → 橢圓 / 高窄 pill。**

疊加：
- A 額外中招：`text-[22px]` 遠超標準（`text-sm` = 14px），就算不被擠都已經 oversized。
- B 額外中招：input 嘅 focus 寬度動態變化（`w-32 → w-full` / `w-40 → w-72`）係**直接成因**——focus 時偷走兄弟空間。
- C 額外中招：外層 `flex flex-wrap` 允許斷行；同容器內右側「備註：…」文字擠壓。

---

## 3. 修復方向

### 3.1 按鈕尺寸（A / B / C）

| 按鈕 | 現 class（關鍵部分） | 改為 | 理由 |
|---|---|---|---|
| **返結帳 badge**（3106） | `inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1 text-[22px] font-bold text-white` | `… whitespace-nowrap shrink-0 rounded-xl … text-sm font-bold …` | font 22→14 同其他 badge 齊；`whitespace-nowrap` 防逐字折行；`rounded-full`→`rounded-xl` 避免變大圓；`shrink-0` 保住自身寬度 |
| **已結帳 badge**（3127） | 同上灰版 | 同修 | 同 |
| **清除 button**（3441） | `rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700` | 加 `whitespace-nowrap shrink-0` | 字體高度本來標準；只欠「唔好畀人縮」 |
| **編輯備註 button**（3263） | `rounded-full bg-white px-3 py-1 text-xs font-semibold …` | 加 `whitespace-nowrap shrink-0` | 同根因 |
| **退菜紅色 button**（3276） | `rounded-full bg-red-50 px-3 py-1 text-xs …` | 同加 `whitespace-nowrap shrink-0` | 同根因 |

旁邊嘅描述文字（3106 右側「此單為返結單…」）要加 **`min-w-0 flex-1`** 令佢可截斷 / 換行，**唔好**反過來擠 badge。

### 3.2 搜尋列佈局（D / E / F）

目標：品類 + 搜尋 + 清除 **永遠同行、同高、同基線**，**focus 搜尋唔可以郁品類**。

兩個取捨方向（**推薦方向 ②**，改動最少、最穩）：

**方向 ① — 三件合一 row（最徹底）**：
```tsx
<div className="flex items-center gap-2">  {/* 改為單 row */}
  <div className="flex flex-1 min-w-0 items-center gap-2 overflow-x-auto">  {/* 品類橫向滾動，不換行 */}
    {/* 全部 + 各分類 button：每個加 whitespace-nowrap shrink-0 */}
  </div>
  <div className="flex shrink-0 items-center gap-2">  {/* 搜尋 + 清除固定寬度容器 */}
    <input className="h-10 w-40 rounded-2xl … focus:w-72" />  {/* 寬度變化只影響此容器內部，唔影響品類 */}
    <button className="h-10 whitespace-nowrap shrink-0 …">清除</button>
  </div>
</div>
```
優點：物理上保證同行同高；缺點：拆 `flex-col xl:flex-row` 嘅響應式，mobile 可能要再調。

**方向 ② — 保留兩組，但 search+clear 容器固定寬度（推薦，改動最小）**：
```tsx
<div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
  <div className="flex flex-nowrap items-center gap-2 overflow-x-auto min-w-0">
    {/* 品類 button：每個加 whitespace-nowrap shrink-0；容器去 flex-wrap 改 nowrap + overflow-x-auto */}
  </div>
  <div className="flex shrink-0 items-center gap-2">  {/* 關鍵：shrink-0 + 固定概念，input 寬度變化唔偷品類空間 */}
    <input className="h-10 w-40 rounded-2xl … focus:w-72" />
    <button className="h-10 whitespace-nowrap shrink-0 rounded-2xl …">清除</button>
  </div>
</div>
```
- 品類容器：`flex-wrap` → `flex-nowrap overflow-x-auto min-w-0`（橫向 scroll，永不換行；多咗嘅分類可橫滑）。
- search+clear 容器加 **`shrink-0`** —— 確保 input focus 變闊時，容器本身寬度由內容決定，**唔會**反過來擠品類（因為品類 flex-1 min-w-0 會自己縮 / scroll，但呢層要配合外層 `xl:justify-between` 行為再微調；最穩係 search 容器設 `w-72` 固定寬度，內部 input `w-full`）。
- **統一高度 `h-10`**：badge / 類別 / 搜尋 / 清除 全部 `h-10`（≈ `py-2 + text-sm` 嘅 line-height），外層 `items-center` → 基線自然齊。
- input focus 行為可保留（`focus:w-72`），因為 search 容器固定寬，input 變闊只係內部填充。

### 3.3 結構 / 樣式細節

- **baseline 對齊**：外層 `flex items-center`（已有 / 加返）。所有 child 設同一 `h-10` + `items-center`（button 內部 `inline-flex items-center`）。
- **字體統一**：badge / 類別 / 搜尋 / 清除 / 編輯備註 全部用 `text-sm`（編輯備註 維持 `text-xs` 都可以，但若想完全統一可升 `text-sm`；建議保留 `text-xs` 因為佢係次要 action）。
- **間距**：gap-2（8px）一致。
- **可選優化**：搜尋 input focus 改寬度嘅 transition 改用 `transition-all duration-150`（已有），但因為容器固定，唔再有 layout jump。

---

## 4. 具體修改（diff 摘要）

全部喺 `src/components/pos-app.tsx`：

| 行 | 改動 |
|---|---|
| 3106 | 返結帳 badge：`rounded-full … text-[22px]` → `rounded-xl whitespace-nowrap shrink-0 … text-sm` |
| 3106 右側描述 | 描述文字 `<span>` 改 `<div className="min-w-0 flex-1 …">` 或加 `min-w-0 flex-1` |
| 3127 | 已結帳 badge 同 3106 改法 |
| 3131 | 「唯讀預覽…」描述同加 `min-w-0 flex-1` |
| 3263 | 編輯備註 button 加 `whitespace-nowrap shrink-0` |
| 3260 | 容器 `flex flex-wrap` → `flex flex-nowrap`（避免 button 斷行）；右側 note 文字加 `min-w-0 truncate` |
| 3276 | 退菜紅 button 加 `whitespace-nowrap shrink-0` |
| 3395–3447 | 搜尋列重構：品類容器 `flex-nowrap overflow-x-auto`，每個 button 加 `whitespace-nowrap shrink-0`；search+clear 容器 `shrink-0` + 固定寬度 `w-72`；input 內 `w-full`；button 加 `h-10 whitespace-nowrap shrink-0` |
| 3410 | 類別 button 全部加 `whitespace-nowrap shrink-0` |

---

## 5. 驗證

- `tsc --noEmit` 零新 error。
- 視覺（同 standard 按鈕對齊）：
  - 返結帳 / 已結帳 badge：**一行**、字體同其他 badge `text-sm` 一致、不再大圓。
  - 清除 button：自然寬、文字一行、不再高窄。
  - 編輯備註 / 退菜 button：文字一行。
  - 搜尋列：品類 + 搜尋 + 清除**永遠同行**、**同高**（`h-10`）、**基線齊**。
  - 點擊搜尋：input 內部變闊，**品類位置 / 換行唔變**（多餘分類橫滑）。
  - 螢幕寬度：手機（< xl）兩組上下疊時，每組內部仍同行同高。

---

## 6. 風險 / 注意

- 改 `rounded-full` → `rounded-xl` 喺 badge 上係**視覺改動**（由「膠囊」變「圓角方」），若你喜歡保留膠囊樣，可改 `rounded-full` 但加 `whitespace-nowrap shrink-0` + 縮 font 已經夠——膠囊樣會保留但唔再大。
- 品類容器由 `flex-wrap` 改 `flex-nowrap overflow-x-auto` → 多咗嘅分類**唔再換行**而係**橫向 scroll**。如果想保留換行 fallback（窄屏），可加 `min-[某寬]:flex-nowrap`。
- 搜尋列方向 ② 嘅 `xl:justify-between` 同 search 容器固定寬可能少少 conflict（justify-between 會把品類推左、search 推右），可保留 `justify-between` 唔變，因為 search 容器固定寬後 justify-between 仲 work。

---

## 7. 一句總結

兩按鈕異常 + 搜尋跳格 = **同一個 flex 陷阱**（rounded button 冇 `whitespace-nowrap`/`shrink-0` + 動態寬度偷空間）。修法：button 全部加 `whitespace-nowrap shrink-0`、返結帳 font 22→14、品類容器 `flex-nowrap overflow-x-auto`、搜尋容器固定寬度 + `h-10` 統一高度 baseline。
