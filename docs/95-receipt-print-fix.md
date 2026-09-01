# 95 — 收據打印五項修正（價錢 / 二維碼 / 折扣底色 / 文字變形 / 付款標籤）

> **文件編號**：95
> **版本**：v1.0
> **最後更新**：2026-09-01
> **範圍**：三倉同改 —— `macauPosSystem`（web POS）、`desktop-companion`（PC 電子殼）、`print-agent-android`（Android APK）
> **原則**：設計介面 == 螢幕預覽 == 實際出紙

---

## 0. 一句講晒

五個問題入面，**第 1 項（價錢印唔出）唔係 CSS、唔係模版，而係「renderer 合約冇同步」**：
`PrintItemLine.price` 一早就算好、傳好、預覽畫到，但 **Companion 同 APK 兩個 ESC/POS renderer 由始至終冇讀過呢個欄位**。
所以「改咗幾次都印唔出」。呢次係第一次動到 renderer。

---

## 1. 第 1 項：菜品價錢印唔出

### 1.1 根本原因（data binding → template → renderer 逐層排查）

| 層 | 位置 | 有冇價錢 |
| --- | --- | --- |
| ① 資料綁定 | `src/lib/print-jobs.ts` `buildTemplateReceiptJobs()` | ✅ 有（`PrintItemLine.price` = 折後單價 × 數量） |
| ② payload 轉發 | `src/lib/print-bridge/native.ts` | ✅ 有（轉發畀 APK） |
| ③ 網頁預覽 | `src/components/escpos-preview.tsx` | ✅ 有（畫到出嚟） |
| ④ **Companion renderer** | `companion-server.mjs` items branch | ❌ **淨讀 `name` + `quantity`** |
| ⑤ **APK renderer** | `EscPosRenderer.kt` items branch | ❌ **淨讀 `name` + `quantity`** |
| ⑥ APK DTO | `PrintDtos.kt` `Item` | ❌ **連 `price` 欄位都冇宣告** |

第 ⑥ 點係最致命：JSON parse 階段個價錢就已經被掉咗，後面點改都冇用。

### 1.2 點解「廚房單打冇問題」，但收據有問題？

**同一個原因嘅兩面。**

廚房單需要嘅欄位係 `name / quantity / specs / note` —— 全部都係 renderer 一早支援嘅舊欄位，所以出紙正常。
收據需要嘅 `price / discountRate / savingAmount` 係後加（docs/82 §17、docs/90），
但 **`docs/55 §2.2` 嘅 renderer 合約一直冇跟住更新** → 「廚房正常」唔係證明 renderer 冇事，
反而證實咗「renderer 淨支援到廚房單需要嘅舊欄位」。

### 1.3 修正

**Android**

- `PrintDtos.kt` `PrintJobDto.Item` 新增 `price` / `discountRate` / `originalUnitPrice` / `discountedUnitPrice` / `savingAmount`
- `PrintDtos.kt` 新增 `optDouble()` 讀 optional 數字
  - ⚠️ **唔可以用 `optDouble(key, 0.0)`**：會令「冇價錢」同「價錢 0」撈亂，舊 payload 冇呢啲欄位時會印出「$0」
- `EscPosRenderer.kt` items branch 改為兩欄排版（見 §1.4）

**Companion**

- `companion-server.mjs` items branch 同上

**共用約束**：`isReceipt = template.kind === "receipt"`

> 價錢同折扣 **淨對收據生效**。廚房單同標籤單要同客人／廚房溝通嘅係「乜嘢菜、幾多份」，
> 價錢係收據先有嘅資訊 → kitchen / label 出紙 byte-for-byte 維持原樣（對應「唔好影響其他單據」）。

### 1.4 兩欄對齊（熱敏機冇 flex）

熱敏機冇 flexbox，要靠空格 padding 先做到「品名靠左 / 數量+價錢靠右」：

```ts
export const RECEIPT_PAPER_COLUMNS = 48;   // 80mm 熱敏紙 font A 每行格數（576 dots ÷ 12）
```

- **中文字佔 2 格、ASCII 佔 1 格**，所以要用 `displayWidth()` 而唔係 `text.length`
- 否則「珍珠奶茶」(4 字 = 8 格) 會當 4 格計，對齊全部歪晒
- `twoColumn(left, right)`：pad 到 48 格；太窄就退化成兩個空格分隔（**唔會削名**）

三個 repo 各有一份 `twoColumn` / `displayWidth` 實作（JS / Kotlin），邏輯逐段對齊。

### 1.5 數字格式化坑（Kotlin 專屬）

```kotlin
// Kotlin Double.toString()：30.0 → "30.0"
// JS   template literal ：30.0 → "30"
private fun num(v: Double): String =
    "%.2f".format(Locale.US, v).trimEnd('0').trimEnd('.').ifEmpty { "0" }
```

唔統一會出紙多咗個 `.0`，同螢幕預覽對唔上。

---

## 2. 第 2 項：收據二維碼（自訂 URL）

### 2.1 設計決定：POS 端 encode 一次，三個 repo 共用

```
用戶輸入 URL（模版設定）
  → encodeQrPayload()   ← src/lib/escpos-qr.ts，POS 端做一次
  → PrintJob.qr = { size, bits }
  → Companion / APK 淨負責「點陣 → ESC/POS 點陣圖」
```

好處：三個 repo 用**同一個矩陣**，出紙必然 == 預覽；renderer 唔使各自實作 QR 編碼（Kotlin 冇內建 QR）。

### 2.2 資料模型（`src/lib/types.ts`）

```ts
export interface QrPayload {
  size: number;   // modules 邊長（未計 quiet zone），v1=21 … v6=41
  bits: string;   // 逐行 bit 字串，長度 = size × size；'1' = 黑點
}
```

- `ReceiptTemplate.qrUrl?: string` —— **per-slot**：收據同自助點餐收據各自獨立
- `PrintJob.qrUrl?` + `PrintJob.qr?`
- `ReceiptSectionId` 新增 `"qr_code"`（排喺 `footer` 之前）
- `qr_code` **淨屬收據類模版**，廚房單 / 標籤單唔會出現

### 2.3 空白 URL 唔顯示

`encodeQrPayload("")` 返 `null` → `PrintJob.qr` 係 `undefined` → renderer 遇 `qr_code` block 直接 `continue`
（三邊一致：web `renderEscPosLines`、Companion、APK）。

### 2.4 點陣圖而唔係原生 QR 指令

用 `GS v 0`（1D 76 30）點陣圖，**唔用** `GS ( k` 原生 QR：

- 舊機 / 平價機未必支援原生 QR，會印亂碼
- 點陣圖係所有 ESC/POS 機都識嘅基本指令

```ts
export const QR_QUIET_MODULES = 4;              // QR 規範要求嘅靜區
scale = clamp(floor(160 / (size + 8)), 2, 6)     // 點陣圖維持 ~160 點（≈20mm）
```

⚠️ 印圖前一定要 `resetMagnify()`（`GS ! 0x00` + `ESC ! 0x00` + `ESC 3 30`）：
放大狀態會令 `GS v 0` 嘅闊度計錯 → 圖變形 / 甩出紙邊。

### 2.5 舊設定向前相容

舊 localStorage 嘅 `ReceiptTemplate.order` 冇 `qr_code`。
`ensureReceiptSections()` 做「缺乜補乜」：插落 `footer` 之前（收據底部、頁尾之上），
並 backfill block style。`buildSnapshot()` 對 `kind === "receipt"` 自動 call。

> ⚠️ **TS 5.5 陷阱**：唔好寫 `order.filter((id) => id !== "qr_code")` 去重。
> TS 5.5 會由 callback 推斷出 type predicate，令 `order` 元素類型收窄成 `Exclude<…,"qr_code">`，
> 之後 `splice("qr_code")` 就 compile 唔到。用顯式型別註釋 + `indexOf` 去重。

---

## 3. 第 3 項：模版入面折扣有顏色，打印變黑白

兩層原因，要分開處理：

### 3.1 第一層：瀏覽器打印會剝走背景色

`escpos-preview.tsx` 加：

```ts
const KEEP_PRINT_COLOR = {
  printColorAdjust: "exact",
  WebkitPrintColorAdjust: "exact",
};
```

### 3.2 第二層：熱敏紙物理上印唔到顏色

熱敏機係 **1-bit 單色**，顏色喺物理上無可能印出嚟。
ESC/POS 唯一表達到「底色 / 強調」嘅手段係 **反白**：`ESC { n`（`0x1B 0x7B`），n=1 = 黑底白字。

對應關係：

| 設計介面 | 熱敏出紙 |
| --- | --- |
| 琥珀色底 + 深琥珀字 | 黑底白字（反白） |

### 3.3 實作（三個 repo 一致）

```
折扣 sub-line：  折扣率 80%（原價 $30）        折讓 $6
                 ↑ ESC { 1 反白開 … ESC { 0 反白閂
```

⚠️ **一定係「文字前開、文字後閂」，唔包 LF**：
反白要先喺 `encodeText` 之前開、喺 `LF` 之前閂。
否則換行位會被反白成一條黑邊，或者反白狀態殘留去下一行。

Companion：`textLine(text, size, bold, align, inverse)` 第 5 個參數
APK：`Buf.line(s, inverse)` 第 2 個參數

---

## 4. 第 4 項：收據文字變形／拉伸

### 4.1 根本原因：synthetic bold（合成粗體）

等寬字堆（`PREVIEW_FONT_STACK`）入面嘅 CJK fallback（例如 PingFang TC）**冇真正嘅 700 / 800 字重**。
瀏覽器要出 `font-bold` / `font-extrabold` 時，會靠**水平抹開筆畫**嚟假造粗體 → 文字睇落變形、拉伸。

廚房單冇事，係因為佢嘅字重要求冇收據咁多；收據有價錢欄、折扣欄，撞中合成粗體嘅機會高好多。

### 4.2 修正（`escpos-preview.tsx`）

```ts
const CLEAN_TEXT = {
  fontSynthesis: "none",   // 禁止合成粗體 → 冇咗水平抹開
  letterSpacing: 0,        // 唔好自己加字距
  fontVariantNumeric: "tabular-nums",
};
```

- `fontSynthesis: "none"` 係根治手段
- 收據項目行 `font-extrabold` → `font-bold`（減低對合成粗體嘅依賴）
- 文字行加 `whitespace-pre-wrap`：`content` 入面嘅 `\n`（例如 `discount_breakdown` 逐項折讓）會同出紙一樣斷行

---

## 5. 第 5 項：付款方式只印「現金」

`src/lib/escpos-template.ts` `buildReceiptContent()`：

```ts
// 其他金額區塊一律係「標題: 值」（原價合計: / 結帳時間: / 服務員: …），
// 得呢一格以前淨印值（「現金」），顧客睇唔出嗰個係乜。補返「支付方式: 」前綴保持一致。
payment_method: `支付方式: ${order.paymentMethod ?? "現金"}`,
```

呢格係 `content`（靜態文字），三個 renderer 都係直接印 `content[blockId]` → **改一處，三邊同時生效，唔使改 renderer**。

---

## 6. 改動清單（檔案級）

### `macauPosSystem`

| 檔案 | 改動 |
| --- | --- |
| `src/lib/types.ts` | `QrPayload` interface；`ReceiptSectionId` 加 `"qr_code"`；`ReceiptTemplate.qrUrl`；`PrintJob.qrUrl` / `PrintJob.qr` |
| `src/lib/escpos-qr.ts` | **新增** —— `encodeQrPayload()` / `QR_QUIET_MODULES` / `qrModuleScale()` |
| `src/lib/escpos-render.ts` | `EscPosLine` 加 `qr` 分支；`EscPosRenderExtras`；`RECEIPT_PAPER_COLUMNS` |
| `src/lib/escpos-template.ts` | `qr_code` 區塊元資料 + 預設值；`ensureReceiptSections()`；`payment_method` 加標籤 |
| `src/lib/print-jobs.ts` | `encodeQrPayload()` → `PrintJob.qr` |
| `src/lib/print-bridge/native.ts` | 轉發 `qrUrl` / `qr`（optional，舊 APK 唔受影響） |
| `src/components/escpos-preview.tsx` | `KEEP_PRINT_COLOR` / `CLEAN_TEXT` / `QrBlock` |
| `src/components/receipt-ticket-preview.tsx` | 傳 `{ qr }` extras |
| `src/components/kitchen-ticket-preview.tsx` | 傳 `{ qr }` extras |
| `src/components/print-center.tsx` | QR URL 輸入框 + 「網址太長」警告 + `ensureReceiptSections` |
| `src/lib/mock-data.ts` | 收據 / 自助收據模版補 `qr_code` 區塊 |

### `desktop-companion`

`companion-server.mjs`：`textLine()` 加 `inverse`；`twoColumn()` / `displayWidth()`；
`qrRaster()`；items branch 價錢 + 折扣反白；`qr_code` block 分支。

### `print-agent-android`

| 檔案 | 改動 |
| --- | --- |
| `model/PrintDtos.kt` | `Item` 加 5 個金額欄位；`QrPayload` data class；`PrintJobDto` 加 `qrUrl` / `qr`；`optDouble()` |
| `net/EscPosRenderer.kt` | `RECEIPT_PAPER_COLUMNS` / `isWideChar()` / `displayWidth()` / `twoColumn()` / `num()` / `discountLine()`；`Buf.line(inverse)`；`Buf.resetMagnify()`；`qrRaster()`；items branch 價錢 + 折扣反白；`qr_code` block 分支 |
| `app/build.gradle.kts` | `versionCode 2 → 3`、`versionName 1.0.1 → 1.0.2` |

---

## 7. 冇 regression 嘅保證

| 顧慮 | 點樣守 |
| --- | --- |
| 廚房單出紙變樣 | items branch 全部改動包喺 `isReceipt` 入面；kitchen / label 行原程式路徑 |
| 標籤單出紙變樣 | 同上；`qr_code` 區塊淨屬收據類模版，`mock-data.ts` 冇加落 kitchen |
| 舊 APK 收到多出嚟嘅欄位 | `native.ts` 用 optional 轉發（`...(job.qr ? { qr: job.qr } : {})`）；Kotlin data class 有 default value |
| 舊 localStorage 模版設定冇 `qr_code` | `ensureReceiptSections()` 自動補；`buildSnapshot()` 對 receipt 自動 call |
| 冇 template 嘅舊 job | Companion / APK 嘅 fallback 硬編路徑完全冇改 |
| 反白狀態殘留去下一行 | `ESC { 0` 喺 `LF` **之前**發；單據尾 `resetMagnify()` |
| QR 前殘留放大狀態 | `qrRaster()` 第一步就 `resetMagnify()` |
| 網址太長 encode 唔到 | `encodeQrPayload()` 返 `null` → 三個 renderer 都唔印；UI 顯示「⚠️ 網址太長，無法生成二維碼（請用短網址）」 |

---

## 8. 版本號 / 生效狀態

| 產物 | 版本 | 狀態 |
| --- | --- | --- |
| Web POS（`macauPosSystem`） | — | ✅ source 已改、`tsc --noEmit` 乾淨；**要 deploy 先生效** |
| Desktop Companion | `package.json` `0.1.16` | ⚠️ source 已改、`node --check` 通過；**要 `npm run dist` 重新打包 exe 先生效** |
| Android APK | `versionCode 3` / `versionName 1.0.2` | ✅ 已 rebuild → `print-agent-android/print-agent-1.0.2-debug.apk`；**要重新派版裝機先生效** |

> ⚠️ 沿用既有規約：**source 改完唔等於生效**。Companion 要 repackage、APK 要 rebuild + 裝機。
