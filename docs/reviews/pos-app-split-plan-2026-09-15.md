# `pos-app.tsx` 分拆計劃（7,649 行）+ UI 回歸測試

> **日期**：2026-09-15
> **現況**：`src/components/pos-app.tsx` = **7,649 行**、**55 個 `useState`**、**25 個 `useEffect`**、32 個 `useMemo`、1 個 `useCallback`、3 個 `useRef`
> **關聯**：[`decisions-2026-09-15.md`](./decisions-2026-09-15.md)、[`dining-optimization-2026-09-15.md`](./dining-optimization-2026-09-15.md)
> **回歸工具**：`tools/verify-pos-app-split.cjs`（本批已建立並跑出基線）

---

## 0. 為何唔可以一次過拆（先講風險，再講做法）

| 風險 | 具體後果 |
|---|---|
| **無限 re-render** | 父傳子 object / array / function 字面量 prop ⇒ 子層 effect 依賴變動 ⇒ setState 回父層 ⇒ 循環。`/orders` 頁**中過一次**，整個 tab 卡死、連側欄都撳唔到（docs/113） |
| **面板功能靜默失效** | 大量面板靠「父層自覺把 prop memo 化」。抄漏一個 `useCallback` ⇒ 唔會報錯，只係行為異常 |
| **`AuthGuard` / `KioskModeGate` 條件錯** | 改動 JSX 樹時誤改條件 ⇒ 白屏或登入迴圈 |
| **`button { font: inherit }` 陷阱** | `globals.css` 有一條**無 layer** 的 `font: inherit`，會壓過所有 Tailwind `text-*`。拆元件時若把字級寫在按鈕本身 ⇒ **靜默變大**（11px → 16px，實案） |
| **版面幾何漂移** | 標題列控件簇、`grid-cols-5` KPI 帶等對寬度極敏感，改結構就會爆行（實案：多個 mockup 版本反覆重畫） |
| **`tsc` 捉唔到** | 以上全部係「編譯綠燈但行為錯」。⇒ **必須有 UI 回歸測試** |

### 結論

**唔可以一次過改。** 必須：先建立回歸基線 → 逐個子樹抽離 → 每步都跑同一套斷言 → 斷言結果必須與基線**完全一致**才可合併。

---

## 1. 階段 0：回歸基線（✅ **已完成**）

### 1.1 工具

`tools/verify-pos-app-split.cjs` —— 真 Chromium（puppeteer-core）+ localStorage 種子，
**唔需要 Supabase / Ledger 後端**（方法論沿用技能 `pos-ui-live-verify`）。

```bash
# 1) 開 dev server（本機 npm 跑唔到，要用全路徑 node）
C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe \
  node_modules/next/dist/bin/next dev -p 3017

# 2) 跑回歸（🔴 NODE_PATH 要指向 workspace/node_modules）
NODE_PATH=C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules \
C:/Users/surface/.workbuddy/binaries/node/versions/22.22.2-3/node.exe \
  tools/verify-pos-app-split.cjs --port 3017 --out docs/mockups/<新folder名>
```

退出碼 `0` = 全通過；`1` = 有失敗（逐項列出）。結果同時寫入 `<out>/assertions.json`。

### 1.2 🔴 兩個必須知道的實測事實（唔知就會寫錯斷言）

1. **一定要用 `localhost`，唔可以 `127.0.0.1`** —— Next 16 dev 會封鎖跨來源 dev 資源（JS chunk 全部 403）⇒
   React 完全唔 hydrate，畫面永遠停喺「正在載入頁面…」，而且 **`pageerror` 一個都唔報**（極誤導）。
2. **dev 冇 Supabase 時，`/api/pos/bootstrap` 會回 mock 並覆寫 localStorage 種子** ⇒
   畫面係 **mock 資料**：3 張枱（A01/A02/A03）、類別 飯類/粉麵/飲品、**商品為空**。
   ⇒ 斷言一律針對**結構 / 幾何 / 流程**，唔針對種子內容（反而更穩定）。
   ⇒ 商品為空 ⇒ 購物車加減掣唔會出現，斷言寫成「**若存在則必須 ≥40px**」。

### 1.3 已跑出的基線（2026-09-15，**17/17 通過**）

| # | 斷言 | 基線實測值 |
|---|---|---|
| 1 | 已過 `AuthGuard`（停留喺 `/`） | ✅ |
| 2 | 唔會卡喺 `ClientOnly` fallback | ✅ |
| 3 | 唔會卡喺「正在載入門店設定」 | ✅ |
| 4 | 冇「今日未開工」彈窗（已開工種子生效） | ✅ |
| 5 | **桌台卡數量** | **3** |
| 6 | **標題列高度**（未爆行） | **828×71**（容差 ±8） |
| 7 | 撳枱後出現「開桌」彈窗 | ✅（人數掣 12 個） |
| 8 | 入座人數快速掣 ≥ 10 個 | 12 |
| 9 | 開桌後進入點餐介面 | ✅（有「返回桌台」） |
| 10 | 點餐介面有「訂單明細」區 | ✅ |
| 11 | 有「下單」掣 | ✅ 高 48px |
| 12 | 有「去結帳」掣 | ✅ 高 48px |
| 13 | 主要動作掣 ≥ 40px | 48 / 48 |
| 14 | 購物車加減掣：若存在則 ≥ 40px | （mock 無商品 ⇒ 未出現，屬正常） |
| 15 | 可以「返回桌台」回到桌台總覽 | ✅ 枱卡 3 |
| 16 | **冇 `pageerror`** | ✅ |
| 17 | **冇無限 re-render（`Maximum update depth`）** | ✅ |

> #16 / #17 係最重要嘅兩項 —— 佢哋就係「分拆最容易整出嚟、而 `tsc` 捉唔到」嘅錯誤指紋。

**基線檔案**：`docs/mockups/pos-app-split-baseline-2026-09-15/`（`01-tables.png` / `02-open-table-modal.png` / `03-ordering.png` / `assertions.json`）

---

## 2. 分拆順序（由零風險到高風險）

抽離原則：**先抽「純呈現、唔碰主 state」**，最後才碰「擁有主 state 寫入權」的核心。

### A 級 · 純呈現（只食 props，零 callback 進出）— 風險最低

| 目標 | 內容 | 為何安全 |
|---|---|---|
| A1 | 桌台卡片（單張枱） | 只讀 `table` + 顯示狀態，事件回呼由父層傳入 |
| A2 | 訂單明細行（單行） | 純顯示 + 一個回呼 |
| A3 | KPI 小卡 / 統計帶 | 純顯示；⚠️ 注意 `grid-cols-5` 固定欄數（改 grid 必須刪對應 `</div>`，實案中過） |
| A4 | 空狀態 / 提示條 | 純顯示 |

**驗收**：`tsc` 0 error、761 單元測試全綠、`eslint` 0 **新增** error、回歸 17/17 與基線一致。

### B 級 · 有自己 local state 的彈窗／面板（唔寫主 state）

| 目標 | 內容 | 注意 |
|---|---|---|
| B1 | 開桌／入座人數彈窗 | 已驗證有 12 個人數掣；local state 為主 |
| B2 | 同步健康彈窗、列印預覽 | 已多數抽離（`sync-health-modal.tsx`、`receipt-ticket-preview.tsx`） |
| B3 | 快捷操作欄（`快捷操作` 卡片） | 純展示 + 導覽 |

**驗收**：同上，**另加**：彈窗開／關／取消三個動作都要人手截圖核對（`getComputedStyle().transform` 驗動畫有行）。

### C 級 · 核心工作區（擁有主 state 讀寫）— 風險最高，**建議獨立一批**

| 目標 | 為何高風險 |
|---|---|
| C1 | 購物車面板 | 直接讀寫 `cartItems`、共用 `updateQuantity` 等高頻回呼 |
| C2 | 商品區／分類篩選 | 讀 `bootstrap` + 寫購物車 |
| C3 | 結帳 / 折扣 / 會員彈窗 | 牽涉付款閘、`resolveSettleTargetOrder()`、多個守門 |
| C4 | 快餐模式訂單列 | `quick-mode-orders-bar` 與堂食分支互斥，改結構易錯 |

**C 級前置（缺一不可）**：
1. 所有傳落子層的 object / array / function **必須** stable identity（`useMemo` / `useCallback` / 模組層定義常數）。
2. 每次只抽**一個**面板，抽完即刻跑回歸 + 人手核對該面板的截圖。
3. 若同一批要動 ≥ 2 個 C 級面板 ⇒ **拆成多個 PR**，唔好一次過。

---

## 3. 每階段固定的合併門檻（Definition of Done）

```
[ ] tsc --noEmit → 0 error
[ ] node --test（收集全部 *.test.ts）→ 761 pass / 0 fail
[ ] eslint <改動檔> → 0 error（唔可以有新增 error）
[ ] tools/verify-pos-app-split.cjs → 17/17 與基線一致（換新 --out folder，親眼睇截圖）
[ ] 若動到 C 級面板 → 該面板人手截圖前後對比
[ ] 若動到按鈕字級 → 記住 globals.css 的無 layer `button { font: inherit }`，
    字級必須寫在按鈕的**仔元素**（唔係按鈕本身）
[ ] PR 只做一個階段，唔混合 A/B/C
```

**「唔通過就唔合併」** —— 任一項紅燈即回退該步，唔靠「下次再修」。

---

## 4. 為何本批**未執行**分拆（誠實說明）

分拆涉及 7,649 行的重構，而「確保通過」需要 **每一步都跑 UI 回歸 + 人手核對截圖**。
呢個係 **多個 session 的工作**（粗估：A 級 1-2 批、B 級 1-2 批、C 級每面板 1 批）。

我今批做嘅係 **最關鍵、亦最容易被跳過嘅前置**：
1. ✅ 建立並**實跑**通過回歸工具（17/17），令「確保通過」變成**可量化的機械檢查**，而唔係口頭承諾。
2. ✅ 釘死兩個會令驗證失效嘅環境坑（`localhost` vs `127.0.0.1`、mock bootstrap 覆寫種子）。
3. ✅ 定出 A/B/C 風險分級與每階段合併門檻。

**唔未經回歸就動 7,649 行** —— 咁樣正好違反你「不得影響現有功能」嘅要求。

### 開工建議

> 由 **A1（桌台卡片）** 開始：單一檔案、props 介面清晰、
> 而且回歸斷言已經覆蓋（桌台卡數量 + 撳枱流程 + 返回桌台）。
> 抽完跑一次回歸，17/17 一致就合併。**每批一個 PR。**

---

## 5. 附：本批同時修好、與分拆相關的兩件事

| 項目 | 內容 |
|---|---|
| 購物車加減掣 | `h-7 w-7`（28px）→ `h-10 w-10`（40px）+ `shrink-0`。**分拆 C1 時要保留**，回歸已加「若存在則 ≥40px」斷言 |
| 標題列幾何 | 現時 828×71（1084 寬 iPad 橫向）。**分拆時若把標題列拆出去，幾何會漂移，回歸第 6 項會即刻捉到** |
