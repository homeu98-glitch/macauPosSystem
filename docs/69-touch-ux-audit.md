# 69 · 觸控 UX 全面審計（Touch-UX Audit）

> 日期：2026-08-26
> 目標：全面找出系統內所有 **touch-unfriendly** 問題（熱區過小、點擊目標難操作、輸入方式唔適合觸控），按模組/頁面分類，列出位置 + 具體不友善之處 + 嚴重度 + 建議修法。
> 本文件**只列清單 + 建議，唔改碼**。下一階段先 confirm 修復範圍再落碼。
> 觸控場景：平板收銀機 / 美容院終端 / 客人 kiosk，主要經手指操作，多數無物理鍵盤。

---

## 0. 摘要（TL;DR）

- **系統已經有優秀嘅觸控數字鍵盤基建**：`numeric-keypad.tsx` / `input-pad-modal.tsx` / `fixed-number-pad.tsx`。但**分佈唔均**——salon 結帳已經用咗（`FixedNumberPad` 實收、`InputPadModal` 折扣），**餐飲 `pos-app.tsx` 結帳卻冇用**，仍然靠 OS 鍵盤。呢個係已知題③嘅核心。
- **三大類共性問題**（一次做 component 可以改多處）：
  1. **A. 數字輸入冇保證大鍵盤**：金額 / 數量 / 人數 / 電話 input 仍然係純 `<input>`，靠 OS 鍵盤（POS WebView 未必可靠彈出、且細）。
  2. **B. 原生 `<select>` 下拉約 20+ 處**：選項細、觸控難撳，應改 bottom-sheet / 按鈕群。
  3. **C. checkbox / radio / stepper / icon 按鈕熱區過細（<44px）**：尤其 `device-settings.tsx` 有 `h-3.5 w-3.5`（**14px!**）嘅 checkbox。
- **已知 3 題全部確認**，並擴散出餐飲 / 美容兩邊嘅同款問題。
- **D/E/F 次類**：`title=` hover tooltip 冇觸控等效（約 12 處）、modal 關閉鈕過細、列表行距不足。

---

## 1. 已知 3 題（詳細確認）

### ① 開桌「入座人數」選擇操作不便 — `pos-app.tsx:2849-2857`
- **現狀**：`<input type="number" min={1} className="...py-2 text-sm">` 純數字輸入框。
- **唔友善之處**：枱位入座人數通常係 1–10 嘅小整數，但員工要**逐字打數字**；`type="number"` 喺觸控上只係細 spinner arrow，喺平板上難撳；冇「+1 / −1」加減、冇常用人數（1/2/3/4/5/6+）快捷鈕 → 開枱步驟慢、易錯。
- **嚴重度**：HIGH（高頻路徑，每日每枱一次）。
- **建議**：改為 `− 人數 +` stepper（±按鈕 ≥44px）+ 常用人數 chip 一行（1–6 / 大檯）；或直接接 `NumericKeypad`。美容 walk-in（`booking-form.tsx` 人數）同款要一齊做。

### ② 設置 > 菜品打印設置 選項過小、難以選取 — `print-center.tsx:401-428, 463-468`
- **現狀**：
  - `:401-405` 每個區塊嘅「顯示」係**原生 `<input type="checkbox">`**（預設 ~16px，無縮放、無 padding label）。
  - `:413-428` 區塊「↑ / ↓」重排按鈕 `className="rounded px-1 text-slate-500"` — **`px-1` + 單箭頭 glyph**，熱區極細（≈20px 闊）。
  - `:463-468` 「粗體」checkbox 同樣原生細。
- **唔友善之處**：設置頁要頻繁撳 checkbox 同 ↑↓ 重排，但目標得 16–20px，喺平板上極易撳錯 / 撳唔中。
- **嚴重度**：HIGH（打印設置係商家常改嘅地方）。
- **建議**：checkbox 包 `px-3 py-3` 嘅 `<label>` 或加 `scale-[1.5]` / 改用大 toggle switch；↑↓ 按鈕加大到 `px-3 py-2` 且至少 40–44px 闊，或改拖拽排序。

### ③ 結帳「折扣金額」「實收金額」無法呼叫數字鍵盤 — `pos-app.tsx:4262-4279`
- **現狀**：兩個 input 有 `inputMode="decimal"`，但係**純 `<input>` 欄位**，靠 OS 彈出數字鍵盤。
- **唔友善之處**：喺 POS 終端 / Android WebView 場景，OS 鍵盤**未必可靠自動彈出**（modal 內 focus 行為、kiosk 全屏模式常擋鍵盤），且 OS 鍵盤細、遮住金額摘要。對比 salon 結帳已用大粒 `FixedNumberPad`（`:1515` 實收）/ `InputPadModal`（折扣 `:1102`），餐飲呢邊明顯落後、不一致。
- **嚴重度**：HIGH（收銀最高頻、最直接影響金錢輸入）。
- **建議**：餐飲結帳折扣 / 實收**接去現有 `FixedNumberPad` / `InputPadModal`**（同 salon 一致），保證一定有個大粒觸控數字鍵盤、自動計找零，唔再依賴 OS 鍵盤。

---

## 2. 跨模組共性（優先做呢啲，一次改多處）

> 呢 6 類係「做一個共用 component 就修一大片」嘅高回報項。建議修復階段優先起呢幾個 wrapper：

| 類別 | 共性問題 | 影響處數 | 統一修法 |
| --- | --- | --- | --- |
| **A** | 數字 input 冇大鍵盤 | ~15 | 新建 `<NumberField>`：金額/數量/人數/電話/郵遞區號統一接 `FixedNumberPad`/`InputPadModal`/`NumericKeypad`；純文字欄位至少加 `inputMode` |
| **B** | 原生 `<select>` 難撳 | ~22 | 新建 `<TouchSelect>`（bottom-sheet / 按鈕群 picker）取代所有原生 select |
| **C** | checkbox/radio/stepper/icon 熱區 <44px | ~20 | 新建 `<TouchCheckbox>`/`<TouchSwitch>`（大熱區）+ 全局 stepper ≥44px 規範 |
| **D** | `title=` hover tooltip 冇觸控等效 | ~12 | 改可見 label / 圖示按鈕，或 tap 才顯 bubble |
| **E** | modal 關閉鈕過細 | ~5 | `responsive-modal` 關閉鈕 ≥44px；或點遮罩關閉 |
| **F** | 列表行距 / 小文字按鈕 | 多 | `text-xs` 可點擊項改 `text-sm` + `py-2`+ |

---

## 3. 按模組分類清單

> 嚴重度：HIGH = 高頻 / 直接阻礙操作；MID = 可用但難用；LOW = 偶發 / 後台。

### 3.1 餐飲核心

#### `pos-app.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:2849-2857` | 開桌「入座人數」`type="number"` | 要逐字打、冇加減/快捷 | HIGH | 見題①：stepper + 人數 chip / NumericKeypad |
| `:4262-4279` | 結帳折扣/實收 `inputMode="decimal"` 純 input | 靠 OS 鍵盤、WebView 未必彈 | HIGH | 見題③：接 `FixedNumberPad`/`InputPadModal` |
| `:3229, :3241` | 購物車數量 +/− stepper `h-7 w-7` (28px) | 加減鍵太細 | HIGH | ≥44px（`h-11 w-11`）或 `FixedNumberPad` |
| `:4333` | 核銷獎賞券 `type="checkbox"` 原生 | 16px box | HIGH | padded `<label>` / `scale-[1.5]` |
| `:3020,:3028,:3036` | 快餐/kiosk 動作（查看/接單/完成）`text-xs px-2 py-1.5` | 細文字鈕 | MID | `text-sm py-2`+ |
| `:3154-3173` | 快餐單類（堂食/外送/自取）`text-xs px-3 py-2` | <44px | MID | `text-sm py-3` |
| `:3082,:3130,:3334,:3354,:3375` | 返結/備註/退款 `text-xs px-3 py-2` | 細文字鈕 | MID | `text-sm py-3` |
| `:2820` | 「開桌」`title=` hover | 冇觸控等效 | MID | 可見 label |

#### `print-center.tsx`（菜品打印設置）
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:401-405` | 區塊「顯示」checkbox 原生 | 16px | HIGH | padded label / scale / switch |
| `:413-428` | ↑/↓ 重排 `px-1` 箭頭 | ≈20px 闊 | HIGH | ≥44px 或拖拽排序 |
| `:463-468` | 「粗體」checkbox 原生 | 16px | HIGH | padded label / switch |
| `:441,:453,:476` | 字型/對齊/規格大小 `<select>` | 原生下拉 | MID | `TouchSelect` 按鈕群 |

#### `device-settings.tsx`（設定最多 input，重點）
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:867,:880,:899,:924,:996,:1311,:1327,:1482,:1718,:1823,:1894,:1916,:2455,:2515` | 14× 原生 `<select>`（用途/分區/連接/紙寬/編碼/分類/打印分區/規格組/時價…） | 下拉難撳 | HIGH | `TouchSelect` bottom-sheet |
| `:842` | 打印機「啟用」checkbox 原生 | 16px | HIGH | padded label / switch |
| `:1424,:1474` | 菜品打印表內 checkbox（`<td>` 內） | 16px + 密行 | HIGH | padded label / 加大行熱區 |
| `:1870,:1888` | 「時價菜」「客人可點」checkbox `h-3.5 w-3.5` (**14px!**) | 極細 | HIGH | `scale-[1.5]` / switch |
| `:2543` | 規格組「必選」checkbox 原生 | 16px | HIGH | padded label / switch |
| `:2065` | 樓層桌台「座位數」`type="number"` | OS spinner + 冇 pad | HIGH | `inputMode="numeric"` + `NumericKeypad` |
| `:2603` | 規格「加價」`type="number"` | 冇 `inputMode` | HIGH | `inputMode="decimal"` + pad |
| `:1011` | 「每次打單張數」`type="number"` | OS spinner | MID | `inputMode="numeric"` + stepper |
| （ok） | `:951` IP `inputMode="numeric"` ✓；`:1187/:1200` radio 大 label ✓；`:2261` checkbox 大 label ✓ | — | — | 保留 |

#### 其他餐飲
| 檔案:行 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `printer-companion-panel.tsx:434,:464,:505,:521,:538,:553` | 6× `<select>`（USB/BT/type/zone/paper/charset）`px-2 py-1.5` | 下拉 + <44px | HIGH | `TouchSelect` |
| `printer-companion-panel.tsx:401` | 「連接埠」input 冇 `inputMode` | 冇數字鍵盤 | HIGH | `inputMode="numeric"` + `py-2` |
| `printer-companion-panel.tsx:392` | 「IP 位址」input `px-2 py-1.5` | ~32px | MID | ≥44px |
| `printer-companion-panel.tsx:411,:418` | 加入/取消 `text-xs px-3 py-1.5` | 細鈕 | MID | `text-sm py-2`+ |
| `shift-page.tsx:663` | 交班歷史「全部員工」`<select>` | 下拉 | HIGH | `TouchSelect` |
| `shift-page.tsx:814` | 「確認交班」`title=` | 冇觸控等效 | MID | 可見 label |
| `shift-page.tsx:738` | 「補錄備註」input `text-xs py-2` | 細 + 細字 | MID | `text-sm py-3` |
| `local-orders-panel.tsx:427` | 返結帳原因 `<select>` | 下拉 | HIGH | `TouchSelect` |
| `local-orders-panel.tsx:359,:420,:457,:492` | 訂單動作 `title=` | 冇觸控等效 | MID | 可見 label |
| `soldout-page.tsx:349` | 「售罄」checkbox（行已 padded） | 16px box | LOW | 可選 switch |
| `online-orders.tsx:725,:771,:796` | 安排桌台/餘額不足/詳情 `title=` | 冇觸控等效 | MID | 可見 label |
| `admin-accounts-page.tsx:495,:507` | 角色/權限 `<select>` | 下拉 | HIGH | `TouchSelect` |
| `admin-accounts-page.tsx:460,:708,:729` | 修改/刪除 `title=` | 冇觸控等效 | MID | 可見 label |
| `member-topup-panel.tsx:151` | 「會員充值審核」`title=` | 冇觸控等效 | MID | 可見 label |
| `reports-dashboard.tsx:324` | 「訂單明細」`title=` | 冇觸控等效 | MID | 可見 label |

---

### 3.2 美容院模組（salon）

> 亮點：salon 結帳已用大鍵盤（實收 `FixedNumberPad :1515`、折扣 `InputPadModal :1102`、會員電話 `NumericKeypad :1392`）→ **呢啲唔使修**，但小費/積分/分拆仲用純 input。

#### `salon/checkout.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:1329-1335` | 小費總池 `type="number"` | 冇 keypad | HIGH | 接 `FixedNumberPad`/`InputPadModal`（同實收） |
| `:1351-1357` | 每技師小費 `type="number"` | 冇 keypad | HIGH | 同上 |
| `:1257-1269` | 積分兌換 `type="number"` | 冇 keypad | HIGH | `NumericKeypad` |
| `:1248-1252` | 「用積分兌換」checkbox `h-4 w-4` (16px) | 細 | HIGH | padded label / switch |
| `:1607-1646` | 分拆/數量 Stepper `h-7 w-7` (28px) | 細 | HIGH | ≥44px |
| `:1471-1481` | 分拆付款「方式」`<select>` | 下拉 | MID | `TouchSelect` |
| `:1482-1488` | 分拆付款「金額」`type="number"` | 冇 keypad | MID | `FixedNumberPad` |
| `:890-903` | 返結原因 `<select>` | 下拉 | MID | bottom-sheet |

#### `salon/booking-form.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:658,:668` | 服務 stepper `h-6 w-6` (24px) | 極細 | HIGH | ≥44px |
| `:672-678,:704-722` | ✕ / − / ＋ `px-2 py-0.5 text-xs` | ≈20px | HIGH | 大 stepper |
| `:504` | 會員 `<select>` | 下拉 | MID | 會員 picker bottom-sheet |
| `:604` | 時間 `<select>`（32 項） | 下拉 | MID | 時間 wheel / sheet |
| `:624` | 房型/椅 `<select>` | 下拉 | MID | 按鈕群 |
| `:730` | 每項銷售 `<select>` `px-2 py-1 text-xs` | 細原生 | MID | bottom-sheet |
| `:340` | 關閉 `px-3 py-1.5` | ~32px | LOW | ≥44px |

#### `salon/service-runner.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:442-448` | modal 關閉 ✕ `px-2 py-1 text-sm` | ~24px | HIGH | ≥44px 關閉鈕 |
| `:328,:342` | 主技師 / 房型 `<select>` | 下拉 | MID | 按鈕群 |
| `:466-476` | 草稿員工 `<select>` `px-2 py-1.5 text-xs` | 細原生 | MID | bottom-sheet |

#### `salon/calendar-board.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:480` | BookingBlock `title=` | 冇觸控等效 | MID | tap 顯詳情（本身 link 已跳） |
| `:178-196` | 日/週 toggle `px-3 py-1 text-xs` | ~24px | MID | ≥44px |
| `:148-168` | ◀/今天/▶ `px-3 py-1.5` | ~32px | LOW | ≥44px |

#### `salon/customer-profile.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:389,:441,:461,:580` | 推薦人/膚質/髮質/執行技師 `<select>` | 下拉 | MID | bottom-sheet |
| `:335-342,:490-497` | tag / 過敏 remove ✕（裸文字無 padding） | 極細 | HIGH | padding ≥44px |
| `:729` | topup modal 關閉 `px-3 py-1.5` | ~32px | LOW | ≥44px |
| `:800` | BuyPackage 套票 `<select>` | 下拉 | MID | bottom-sheet |

#### `salon/online/page.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:116,:130,:151` | 負責師傅 / 房間工位 / 各項服務 `<select>` ×3 | 下拉 | MID | bottom-sheet |
| `:110` | modal 關閉（裸文字） | 極細 | HIGH | ≥44px 關閉鈕 |
| `:401-414` | filter pills `px-3 py-1.5 text-xs` | ~32px | LOW | `text-sm py-2` |

#### `salon/staff-detail.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:328,:364` | 刪除 leave/shift（`text-xs hover:underline` 裸） | 細 | MID | padded 鈕 ≥44px |
| `:240-253` | 狀態 toggle `px-3 py-1 text-xs` | ~28px | LOW | ≥44px |
| `:299-342` | date/time input 靠 OS picker | 平板笨拙 | LOW | 可接受 / 後續優化 |

#### `salon/settings.tsx`（通用 FormModal / CrudSection）
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:137-147`（用於 `:727,:737,:755...`） | 所有 `<select>`（員工 level/status/role 等）原生 | 下拉 | MID | `TouchSelect` |
| `:120-127` | `type="number"`（sortOrder/price/points/duration/capacity/multiplier…）靠 OS 鍵盤 | 冇 pad | MID | `NumericKeypad`/`InputPadModal` |
| `:345-368` | CrudSection 啟用/✎/🗑 `px-2 py-1 text-xs` | ≈24px | MID | 加大 edit/delete |
| `:924-935` | 工資 `type="number"` `px-2 py-1` | 細 | LOW | keypad |
| `:1129-1227` | loyalty number inputs 靠 OS 鍵盤 | 冇 pad | LOW | keypad（後台） |

#### `salon/package-templates.tsx`
| 位置 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `:324-334` | 服務項 `<select>` | 下拉 | MID | bottom-sheet |
| `:335-341` | 節數 `type="number"` `w-20` | 細 | MID | stepper / `NumericKeypad` |
| `:343` | 移除 ✕ `px-2 py-1 text-xs` | 細 | LOW | ≥44px |
| `:286,:359` | price/validity/bonus `type="number"` | 冇 pad | LOW | keypad（後台） |

#### 美容低風險（僅記錄，可後置）
- `workbench.tsx:180,:225` 動作 link `text-xs` ~24px（LOW）
- `reports.tsx:210` 範圍 pills `text-xs`（LOW）
- `salon-sidebar.tsx:85` 登出 `text-xs`（LOW）
- `prints-content.tsx:68,:115` 重新整理/重印 ~32px（LOW）
- `customers-list.tsx` / `staff-list.tsx` 行係大 `Link` 卡，電話 input 已 `inputMode="numeric"` ✓ 無問題

---

### 3.3 Kiosk 客人端 / 登入

| 檔案:行 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `login-screen.tsx` | 行業分流 mode 鈕 / 兩個 input | 已 `inputMode="numeric"`、鈕大 | — | **無問題** ✓ |
| `app/menu/page.tsx`, `app/order/page.tsx`, `use-kiosk-order.ts` | 客人落單 UI | 手機外賣 App 風、大鈕 | — | **無問題** ✓ |
| `kiosk-qr-panel.tsx:105` | host input（文字，非數字） | 非數字，細影響 | LOW | 可加大 |

---

### 3.4 共用元件 / 後台

| 檔案:行 | 控制 | 唔友善 | 嚴重 | 建議 |
| --- | --- | --- | --- | --- |
| `app-sidebar.tsx:139` | 網絡狀態 `title=` | 冇觸控等效 | LOW | 可見狀態文字 |
| `responsive-modal.tsx` | 關閉鈕（多處 modal 依賴） | 個別頁面關閉鈕細 | MID/E | 全局關閉鈕 ≥44px；允許點遮罩關閉 |
| `backoffice-*` | 搜尋 input 已 OK；其餘多數後台管理，觸控場景少 | — | LOW | 視需要 |

---

## 4. 修復路線建議（待 confirm）

**階段 1 — 起共用 component（一次修一大片）**
1. `<TouchSelect>`：bottom-sheet / 按鈕群 picker → 解決類 B（~22 處 select）。
2. `<TouchCheckbox>` / `<TouchSwitch>`：大熱區 → 解決類 C checkbox/radio。
3. `<NumberField>`：金額/數量/人數/電話/郵遞區號統一接 `FixedNumberPad`/`InputPadModal`/`NumericKeypad` → 解決類 A（~15 處）。
4. 全局 stepper ≥44px 規範 + `<ResponsiveModal>` 關閉鈕 ≥44px（類 C/E）。
5. `title=` hover → 可見 label / tap-bubble（類 D）。

**階段 2 — 已知 3 題 + 高頻路徑**
- 題③ 餐飲結帳折扣/實收接 `FixedNumberPad`（追上 salon）。
- 題① 開桌入座人數改 stepper + 人數 chip。
- 題② print-center checkbox/↑↓ 加大。
- `device-settings.tsx` 14 select + 細 checkbox（含 14px 嗰個）優先。

**階段 3 — 其餘 MID/LOW**
- salon booking/checkout 小費/積分/分拆 input 接 keypad。
- 各 `title=` tooltip、細文字鈕、list 行距。

---

## 5. 嚴重度統計（粗略）
- HIGH：~35 處（開桌人數、結帳數字鍵盤、print-center、device-settings 全部細 checkbox/select、salon stepper/小費/積分、modal 關閉）
- MID：~40 處（各 `<select>`、細文字鈕、`title=` tooltip、部分 `type=number`）
- LOW：~15 處（後台 number、sidebar tooltip、list pills）

> 共約 90 項。大多可經階段 1 嘅 3–4 個共用 component 一次性解決，唔使逐項改。
