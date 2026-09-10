# 列印模板預覽改「固定版面＋靜態範例資料」（2026-09-10）

## 一、改咗啲乜（一句講晒）

設計頁（`/prints`）五個模板嘅預覽，**唔再讀任何真實訂單**，一律用 `src/lib/preview-fixtures.ts`
嘅固定範例單；同時預覽會**強制顯示全部區塊**（包括商家熄咗、或者範例資料本身會隱形嘅區塊），
等商家一開設計頁就見到完整最終版面。真實出紙行為**一件都冇改**。

## 二、點解要改

| 問題 | 改之前 |
|---|---|
| 預覽用真單 | `print-center.tsx` `sampleOrder = orders[0] ?? SYNTHETIC_SAMPLE_ORDER` → 有單就用最新果張真單 |
| 可選欄位隱形 | 真單通常無折扣／無服務費／無稅／無抹零／無備註 → 呢啲區塊全部唔顯示，商家以為「我個模板少咗嘢」 |
| 版面重現唔到 | 唔同店、唔同時段開設計頁見到嘅嘢唔同，報 bug 對唔上 |
| 資料外洩 | 真單桌號／備註／金額會入咗設計頁截圖 |

## 三、改動清單

### 3.1 新增（1 個檔案）

**`src/lib/preview-fixtures.ts`** —— 唯一靜態資料源：

- `PREVIEW_RECEIPT_ORDER`（收據 / 自助點餐機 / 標籤共用）
- `PREVIEW_KITCHEN_ORDER`、`PREVIEW_LABEL_ITEM`、`SHIFT_PREVIEW_SAMPLE`（由 `escpos-template.ts` 搬過嚟）
- `PREVIEW_STORE_NAME` / `PREVIEW_STORE_TEL` / `PREVIEW_SERVER_NAME` / `PREVIEW_QR_URL`

**原則：fixture 淨係一張普通 `PosOrder`**，照樣餵入原有 `buildReceiptContent` /
`buildKitchenContent` / `buildLabelContent` → 欄位格式、兩欄對齊、折扣計算**自動同源**，
第日改 builder 唔使再維護多一組假字串。

⚠️ 收據金額係手砌、**必須對得住數**（`buildReceiptContent` 有雙軌對帳，對唔到會喺 dev 噴 warning
兼自動取細值）：

```
原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額
  142    +  14   + 7 −  1  −  14       ===  148
```

改任何一個數都要重新對一次。

### 3.2 移除真實訂單依賴（`print-center.tsx`）

| 位置 | 改動 |
|---|---|
| `SYNTHETIC_SAMPLE_ORDER` | 刪除（改用 fixture） |
| `usingSampleOrder` / `sampleOrder` | 刪除（`orders` 本身保留，重打整單仲用緊） |
| 「需要最少一個菜品嚟預覽標籤」分支 | 刪除（fixture 一定有 item） |

### 3.3 全部區塊一律顯示

`buildPreviewLines()` 砌一份 `visible` 全 `true` 嘅 **snapshot clone** 餵畀同一個
`renderEscPosLines()`：

```ts
const previewSnapshot = {
  ...snapshot,
  blocks: snapshot.blocks.map((b) => (b.id === "divider" ? b : { ...b, visible: true })),
};
```

- **點解唔直接改 `if (!text) continue`**：`escpos-render.ts`、`companion-server.mjs`、
  `EscPosRenderer.kt` 三邊有**完全相同**嘅嗰一行，改咗會同時改埋真實出紙（真單會多咗一堆空行）。
- **點解唔改 `visible` 預設**：改咗會影響現有店嘅真實出紙。
- `divider` 例外：佢「熄」係有即時可見效果嘅商家選擇（全張單唔印分格線），要尊重。

### 3.4 dev-only coverage guard

`assertPreviewCoverage(kind, content)`：assert 每個 `SECTION_META` id 喺 preview content
都有非空值（`divider` / `items` / `qr_code` 三個唔係純文字區塊，跳過）。
日後有人加咗新區塊但漏咗喺 fixture 填值 → console 即刻報。production 直接 return（零成本）。

### 3.5 共用 `toPrintItemLines()`（消除第二個分歧源）

`PosOrder.items → PrintItemLine[]` 以前 `print-jobs.ts`（出紙）同 `print-center.tsx`（預覽）
**各抄一份** —— 同當年交班單 `shiftDetailToLines` / `buildShiftPrintLines` 兩份 builder 分歧
同一個死法。而家兩邊都 call `escpos-render.ts` 嘅 `toPrintItemLines()`。

### 3.6 廚房模板剷走死區塊

`server`（店員）／`customer_count`（人數）：`buildKitchenContent` 一路回硬編 `""`、
`print-jobs.ts` 亦從來冇傳過資料 → **連真實出紙都印唔到**（撳「顯示」冇反應嘅死開關）。

改咗：`types.ts` `KitchenSectionId` / `KITCHEN_SECTION_META` / `KITCHEN_BLOCK_DEFAULTS` /
`buildKitchenContent` / `mock-data.ts` 全部移除。
`mergeTemplateOrder()` 本身會 filter 未知 id，舊雲端 record 殘留嗰兩個 id 會自動清走。
三個下游 repo 只 loop `snapshot.blocks` → **唔使改**。

### 3.7 紙寬：58 / 80mm 手動切 + 標籤 7 個尺寸

- 收據 / 廚房 / 交班：設計頁加「預覽紙寬」下拉（58 / 80mm）。
- 標籤：`LabelTemplate.paperSize` 新增欄位，7 個常用尺寸 + 保留 62mm：

| id | 尺寸 | 字／行 | 用途 |
|---|---|---|---|
| `40x30` | 40 × 30 | 21 | 細標籤 / 條碼 |
| `50x30` | 50 × 30 | 28 | 零售價籤、商品標示 |
| `58x40` | 58 × 40 | 32 | 收銀機標準價籤 |
| `60x40` | 60 × 40 | 34 | 飲品杯貼、成份表 |
| `70x50` | 70 × 50 | 41 | 外帶袋、備料標籤 |
| `80x50` | 80 × 50 | 48 | 後廚叫號、大標籤 |
| `100x75` | 100 × 75 | 61 | 外送箱、物流面單 |
| `62mm` | 62 mm | 36 | 舊系統預設（非業界標準，僅供沿用） |

**查證：62mm 唔係熱感標籤業界標準闊度** —— 佢只出現喺(1) 收銀熱敏紙卷闊度列表
（37/50/57/58/60/62/70/80mm）同 (2) Brother DK 62×100mm 呢類 niche 標籤。
歐洲供應商標示嘅「58×62×12」其實係 闊 58mm / **直徑** 62mm（收銀紙卷），好大機會係當年
由紙卷規格誤植做標籤闊度。62mm 降為選填保留項，唔直接剷（怕踢爛手上真係有 62mm 卷嘅商戶）。

⚠️ `paperSize` **唔使 migration**（`label` 係 jsonb 整體存），但 `normalizePosLocalSettings()`
係**逐欄重建** `label`（唔係展開合併）→ 一定要手動加白名單，否則一 reload 就被剷走
（同當年 `receipt.qrUrl` 同一個坑）。

### 3.8 預覽紙闊由「每行字數」反推（修預覽 ≠ 出紙）

`EscPosPreview` 嘅 `paperWidthMm` prop 改做 `columns`：

```ts
const CHAR_PX = SIZE_PX.s * DASH_WIDTH_RATIO;   // 11 × 0.6 = 6.6
const paperPx = Math.round(columns * CHAR_PX) + 16;
```

以前係 `mm × 3.2` → 80mm 紙得 ~36 個字位，但實體機印到 48 字 → 預覽會**提早換行**，
排版對唔上出紙。而家紙闊由字數反推，換行位同實體機一致；分格線亦由
`"-".repeat(cols)` 出（以前寫死 48）。

### 3.9 snapshot 帶 `cols`：統一四個 repo

`EscPosTemplateSnapshot` 加 `cols?: number`，由 POS `buildSnapshot()` 計一次寫入，
下游**直接讀**，唔好再各自判斷 `printer.paperSize`。

| 通道 | 改之前 | 改之後 |
|---|---|---|
| POS `escpos-render.ts` | 硬編 48 | `snapshot.cols ?? 48` |
| desktop-companion | 永遠 48，**完全冇 58 判斷**；分格線寫死 32 dash | `snap.cols`（fallback 48） |
| `print hub` APK | `paperColumns(printer)`（58→32） | `template.cols ?: paperColumns(printer)` |
| `print-relay` / `print-agent-android` | 同上 | 同上 |

計法：`paperColumnsFromSize(paperSize)` = `contains("58") ? 32 : 48`（58mm→32 / 80mm→48
兩點同 `EscPosRenderer.kt` 既有常數對齊）；標籤 = `min(紙尺寸 preset columns, 機頭 columns)`。

出紙路徑逐**打印機**計（`buildTemplateReceiptJobs` / `buildKitchenPrintJobs` /
`buildLabelPrintJobs` 嘅 snapshot 搬咗入 loop）—— 收據機 80mm、廚房機 58mm 唔會再共用同一個欄寬。

## 四、預覽 vs 出紙：差異同驗證

**兩者只差 `content` / `items` payload**，其餘同源：

1. 同一個 `buildXxxContent`（fixture 都係普通 `PosOrder`）
2. 同一個 `renderEscPosLines`
3. 同一個欄寬計法（`paperColumnsFromSize` / `labelPaperPreset`）

**差異（刻意保留）**：預覽 = 版面樣本（靜態資料 + force-visible）；出紙 = 真實資料，
空值區塊會被 `if (!text) continue` 跳過。設計頁有琥珀色提示條講明呢點。

**驗證方式**：

1. **coverage guard**：dev 開設計頁，console 唔應該出現「預覽範例資料缺內容」。
2. **紙寬對照**：設計頁揀 58mm，分格線應該 32 個 dash、每行位數明顯窄過 80mm；
   同一張單分別經 desktop-companion 同 hub APK 出紙，分格線闊度要一致。
3. **真單校對（建議加，未做）**：設計頁可以選一張歷史單用**真資料**渲染同一個模板，
   出嚟嘅畫面就等同當年嗰張紙，可以直接同實物對照。

## 五、已知未做 / 待跟進

- **未喺真機印過紙**：四個 repo 嘅 `cols` 分支只做咗靜態核實，建議驗收時 58mm 同 80mm 各印一次。
- **未加「真單校對模式」**（上面驗證方式第 3 點）。
- **CJK 換行位仍有少少誤差**：等寬字堆入面 CJK 字寬 ≈ 1em、ASCII ≈ 0.6em，
  比例 1.67；實體機係 CJK = 2 col、ASCII = 1 col（比例 2）。所以中文長句會比實體機多排 ~17% 字。
  要精準需要一只 CJK 闊度 = 2× ASCII 嘅等寬字型，屬獨立優化。
- **`print-center.tsx` 既有 `react-hooks/refs` 誤報 16 個**：改動前基線已係同一組
  （offlineMode unused / immutability / exhaustive-deps / refs×3 位置），
  行號 +68 一致 → 無新增。唔阻 build（Next 16 唔喺 build 時跑 ESLint）。
