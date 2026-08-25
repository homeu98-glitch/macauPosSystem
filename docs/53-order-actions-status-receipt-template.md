# 53 · 點餐介面按鈕排版 + 訂單狀態標籤配色 + 收據模板菜品行重構

> 目的：① 點餐介面「全部退菜 / 退桌」並排；② 訂單內狀態標籤按狀態套色統一識別；③ 收據模板菜品明細：份數標示 + 細項（規格 / 加料 / 備註）拆為獨立 sub-element。
> 狀態：**已實作（2026-08-25）**。tsc 零新 error（layout.tsx LayoutProps 為 standalone tsc 已知誤報，Vercel build 唔受影響）。web-only，Vercel push 即生效，**唔使 rebuild exe/apk、唔使升桌面版本號**。

---

## 一、點餐介面按鈕排版

**改動**：`src/components/pos-app.tsx` 邊欄底部嘅「全部退菜」+「退桌」+「全單備註 / 編輯」三段 UI 重新排版。

### Before
- 「全部退菜」一個 `mb-3 flex justify-end` div 獨佔一行
- 「退桌」另一個 `mb-3 flex justify-end` div 獨佔一行
- 「全單備註 / 編輯」一個 row

兩個按鈕垂直堆疊，視覺散亂。

### After
- 「全部退菜」+「退桌」**並排**喺 `mb-3 flex flex-wrap justify-end gap-2` 同一 row（用 `flex-wrap` 防止窄屏擠爆自動換行）
- 「全單備註 / 編輯」另一 row 維持不變
- 兩個按鈕同樣 `bg-red-50 / text-red-700 / ring-red-200`，視覺一致

### 實作關鍵
- 唔再兩個 wrapper div，將兩顆 button 直接 render 喺同一個 `flex flex-wrap justify-end gap-2` 內
- 每顆 button 仍包獨立 ternary condition（一個係 `isAddOnOrder` 條件、另一個係 `findVoidableTableOrder` 條件），所以單獨一顆出現時仍對齊右邊
- 兩顆同時出現時由 `gap-2` 隔開

---

## 二、訂單狀態標籤配色統一

**改動**：新增 `getOrderStatusBadge(order)` helper 喺 `src/lib/pos-order-filters.ts`，所有「訂單內」狀態標籤統一用呢個 helper 出顏色。

### 配色 token（商家可一眼辨識）
| 狀態 | label | bg | text | dot |
|---|---|---|---|---|
| `draft` | 點單中 | slate-100 | slate-700 | slate-500 |
| `sent_to_kitchen` | 製作中 | amber-50 | amber-700 | amber-500 |
| `paid`（一般） | 已付款 | blue-50 | blue-700 | blue-500 |
| `paid` + `fulfillmentStatus === "ready"` | 待取餐 | sky-50 | sky-700 | sky-500 |
| `settled` | 已完成 | emerald-50 | emerald-700 | emerald-500 |
| `cancelled` | 已取消 | slate-200 | slate-600 | slate-400 |
| `refunded` | 已退款 | red-50 | red-700 | red-500 |
| `partially_refunded` | 部分退款 | orange-50 | orange-700 | orange-500 |
| `reopened` | 已返結 | indigo-50 | indigo-700 | indigo-500 |
| 快餐 counter `paid+ready` | 用 `quickCompletionLabel` | sky | sky | sky |
| 快餐 counter `paid` / `sent_to_kitchen` | 製作中 | amber | amber | amber |

### 套用位置
- **`pos-app.tsx` viewing modal（line ~4078）**：原本係 7 個 hardcoded ternary + 4 種顏色，現在用 `getOrderStatusBadge(viewingOrder)` 一行解決；保留「待完成」amber badge 作為「已付未結」嘅副標籤（除 settled / refunded / partially_refunded 外仍加「待完成」）。
- **`local-orders-panel.tsx` 訂單卡（line ~269）**：原本只有 paid+ready=sky / 其他=slate 兩種；改用 helper 統一 9 種狀態 + 對應圓點顏色。
- **`local-orders-panel.tsx` viewing modal（line ~339）**：description 文字同 inline status chip（`isQuickCounterOrder` 時）都用 helper 出 label + 配色。

### 移除 / 保留
- 移除 `localOrderStatusLabel` 同 `quickCompletionLabel` 由 `local-orders-panel.tsx` 嘅 import（已經用唔到），改 import `getOrderStatusBadge`。
- `pos-app.tsx` import 加 `getOrderStatusBadge`，原本個 switch 邏輯刪除。

### 設計原則
- **快餐 counter**：用 `quickCompletionLabel` 顯示「客人取餐編號」類資訊（如 `A01`），唔係純狀態，所以保留原本嘅 helper 路徑。
- **dot indicator**：每個 badge 內加 `h-2 w-2 rounded-full` 小圓點（card 視圖用 `h-4 w-4`），圓點同 bg 同色系但更深一階，視覺層次更清楚。

---

## 三、收據模板菜品明細重構

**改動**：`receipt-ticket-preview.tsx` 同 `print-center.tsx` 嘅「菜品明細」section render 邏輯改為結構化。

### Before
- `items` section 嘅內容係 `string[]`，每個菜品 join 成一行 `"牛筋麵 · 麵體：蕎麥麵 · 加購：紅燒牛腩"`
- 份數 x1 / x5 完全冇顯示
- 細項（spec / note）唔可以分開處理

### After
- `items` 改為 `ReceiptItemLine[]` 結構化陣列：
  ```ts
  type ReceiptItemLine =
    | { kind: "dish"; name: string; quantity: number }
    | { kind: "spec"; label: string }
    | { kind: "note"; text: string };
  ```
- 每個菜品 = 一個 `{ kind: "dish", name, quantity }` + N 個 `{ kind: "spec" }`（每個 selectedSpec 一個）+ 可選 `{ kind: "note" }`（一個）
- 渲染：
  - **dish 主行**：flex `justify-between`，左菜名（font-weight 600）右 `x{quantity}`（font-extrabold）
  - **spec sub-element**：`pl-3 text-[0.85em] opacity-80`，前綴 `· `
  - **note sub-element**：`pl-3 text-[0.85em] font-semibold text-red-700`，前綴 `注：`
- 排序：每個 dish 行先 render，spec/note sub-element 緊接其下垂直堆疊（per item group）

### 套用位置
- **`receipt-ticket-preview.tsx`**：export 咗 `ReceiptItemLine` type（俾 print-center 共用），`buildReceiptBlocks` 改為返 `ReceiptBlocks`（items 係 `ReceiptItemLine[]`、其他 section 係 `string[]`），render loop 喺 items section special-case。
- **`print-center.tsx`**：`receiptPreviewBlocks` 改用 `Partial<Record<id, string[] | ReceiptItemLine[]>>` type（Partial 因為 `sampleOrder` 為空時返 `{}`），items 一樣結構化；designer canvas 嘅 `sectionOrder.map` 喺 `section === "items"` 時 special-case render。

### 拖移範圍（interpretation）
- 用戶講「獨立可拖移的元素」。現有 print-center drag 系統只支援 **top-level section**（store_name / order_no / ... / items / ... / footer），sub-line 唔可以獨立拖。
- **今次實作**：sub-line 喺 items section 內**視覺獨立**（縮入、不同字級、note 紅色），但**繼承 items section 嘅 position/size**。即係話：可以拖成個 items section block 去唔同位置、可以改大小；唔可以單獨拖一個 spec 行出嚟。
- 如要做到 per-line drag 必須改 `printTemplates.receipt` schema 支援 nested sections（sub-element 有自己嘅 `x/y/width/height/style`），係大改。本期先做結構化 render + 份數顯示。

### 「順序輸出預覽」不受影響
- `print-center.tsx` 嘅「順序輸出預覽」section（line 1600+）係直接讀 `receiptPreviewJob.items`（已係結構化 data），唔經 `receiptPreviewBlocks`，所以唔使改。佢本來就係結構化 render：菜名 + x份數頂行、specs / note 喺下。**今次改動只影響 designer canvas 內嘅 items section 渲染**。

---

## 四、改動檔案清單

| 檔案 | 改動 |
|---|---|
| `src/lib/pos-order-filters.ts` | + `getOrderStatusBadge(order) → { label, bgClass, textClass, dotClass }` |
| `src/components/pos-app.tsx` | import + 邊欄按鈕 row 合併；viewing modal 狀態 badge 改用 helper |
| `src/components/local-orders-panel.tsx` | import + 卡片 badge / viewing modal 狀態 chip 改用 helper；清理 unused import |
| `src/components/receipt-ticket-preview.tsx` | export `ReceiptItemLine`；`buildReceiptBlocks` 結構化；items render special-case |
| `src/components/print-center.tsx` | import `ReceiptItemLine`；`receiptPreviewBlocks` 結構化；designer canvas items render special-case |

---

## 五、未做 / 後續可考慮

- **per-line drag**：要 schema 改 nested sections，先可拖單個 spec / note。預估工作量 1.5–2 週。
- **快捷操作列（quick action bar）嘅狀態 chip**：`quick-local-orders-strip.tsx` 用緊硬編碼 `"製作中"` / `completionLabel(order)`，非「訂單內」狀態 chip，且位置非常 compact。如要統一可後續做。
- **salon 訂單狀態**：salon 模組用自己嘅 `appointmentStatus`（`booked / arrived / in_service / done / no_show`），唔同餐飲；如要統一設計 token 再獨立做。
