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

---

## 9. 用戶反饋第二輪（2026-09-01 晚）—— 三個新問題

### 9.1 R1：加購價錢位置放錯 —— 「加購:加麵 $5」黐喺文字旁邊

**截圖**：`加購:加麵    $5`（$5 喺文字旁邊）vs 期望：`加購:加麵 ........................... $5`（同主行 `$95` 同一排右邊）

#### 根本原因

`formatSpecLine()`（`src/lib/escpos-render.ts:42`）拼 `"加購:加麵 $5"` 成單一字串，**舊 renderer 直接印個 string** → $5 黐喺文字後面。**網頁預覽**有 `splitSpecLine()` + flex `justify-between` 拆開排版，所以預覽睇落正確；**Companion / APK renderer 完全冇做呢步**，所以出紙同預覽唔一致。

> 🔴 又係「預覽同 renderer 唔同源」嘅典型 bug：預覽有 flex，renderer 冇 → 預覽永遠睇唔到出紙嘅 bug。

#### 修正

1. **`splitSpecLine()` 邏輯搬到三個 repo**（regex 逐字符對齊）：
   ```
   ^(.*?)\s+(-?\$\d+|-\d+)$
   ```
   - `$X` 保留原 prefix
   - `-$X` / `-N` 加前導空格同主行對齊（罕見但支援負數 delta）
   - 冇價錢 → price = null（spec 唔使兩欄）

2. **Companion / APK renderer items branch**：spec 行由
   ```js
   textLine(`  ${s}`, ...)  //  收埋成一個 string
   ```
   改成
   ```js
   const { label, price } = splitSpecLine(s);
   textLine(price ? twoColumn(`  ${label}`, price) : `  ${label}`, ...);
   ```
   card 版面同 list 版面都要改。

3. **網頁預覽**唔使改（已經係 flex `justify-between`）。

**驗證**：`tools/verify-receipt-totals.mjs` 模擬截圖訂單：

```
加購:加麵        → "  加購:加麵                                   $5"  (48 格)
加購:糖心蛋      → "  加購:糖心蛋                                 $5"  (48 格)
麵體:寬版拉麵    → "  麵體:寬版拉麵"                                  (15 格)
```

### 9.2 R2：原價合計算錯 —— 唔包加購

**截圖**：`原價合計: MOP 170`
**期望**：`原價合計: MOP 180`（包括加購）

| 菜 | 主行價 | 加購 | 小計 |
|---|---|---|---|
| 招牌牛三寶 | $95 | $5 | $100 |
| 牛肚麵 | $60 | $5 | $65 |
| 茉莉綠茶（原價 $15，折扣率 85%） | $15 | — | $15 |
| **合計** | | | **$180** |

#### 根本原因

`computeSubtotalBeforeDiscount()`（`src/lib/escpos-template.ts:352`）用 `unitBasePrice(it)`（`it.price - Σ specDelta`）計，會**剝走加購**。

`unitBasePrice()` 嘅設計原意係「收據主行印基價，spec row 個別加印 `$X`，避免重複收費」（見 escpos-render.ts:50-56）—— 但呢個**只應該用喺主行**，唔應該用喺「原價合计」嘅合計。

`it.price` 喺 `pos-app.tsx::priceWithSpecs()` 入面已經包埋 spec delta（折扣菜用 `originalPrice`）：

```ts
if (item.discountRate != null && ...) return (item.originalPrice ?? item.price) + specDelta;
return item.price + specDelta;
```

所以 `it.price` 就係「100% 原價（含加購）」，直接用嚟做原價合计最準。

#### 修正

```ts
export function computeSubtotalBeforeDiscount(order: PosOrder): number {
  return order.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
}
```

⚠️ **順手 audit**：改咗之後 `unitBasePrice()` 仍然有用處（單品折扣計算、收據主行基價），保留。

### 9.3 R3：優惠合計錯 —— 用咗 `rate` 唔係 `(100 - rate)`

**截圖**：`優惠合計: MOP -13`
**期望**：`優惠合計: MOP -2`（只有茉莉綠茶折讓 $2）

#### 根本原因（兩個地方都用錯）

`computeItemSavings()`（`src/lib/escpos-template.ts:360`）：
```ts
return sum + (unitBasePrice(it) * it.quantity * rate) / 100;
// ❌ rate=85 → 算成 原價 × 85% = 12.75（即折後價，唔係折讓）
// ✅ 應該  原價 × (100 - rate)% = 原價 × 15% = 2.25（即折讓）
```

**同源 bug**：`buildReceiptContent()` `discount_breakdown` 區塊（line 298）都係用 `* (rate / 100)`，同樣錯。

> 🔴 個錯誤好隱晦：`rate 80` 直覺會諗「8 折 = 收 80 / 原價 100 = 折讓 20」，但個 80 放喺公式入面會俾人誤以為「直接乘 rate」。應該永遠乘 **(100 - rate)** 先啱。

#### 修正

兩處都改：

```ts
// computeItemSavings
return sum + (unitBasePrice(it) * it.quantity * (100 - rate)) / 100;

// buildReceiptContent discount_breakdown
const saving = clampMoney(base * it.quantity * ((100 - rate) / 100));
```

#### 驗證

`tools/verify-receipt-totals.mjs` 模擬截圖訂單：

```
原價合計 : 180 (期望 180) ✅
優惠合計 : -2  (期望 -2)  ✅
對數檢查 : 180 - 2.25 ≈ 178 ✅

茉莉綠茶：原價 15 → 折後 12.75 → 折讓 2 ✅
```

---

## 10. 第二輪改動清單（附加）

### `macauPosSystem`
- `src/lib/escpos-template.ts`：
  - `computeSubtotalBeforeDiscount` 用 `it.price` 唔用 `unitBasePrice(it)`（R2）
  - `computeItemSavings` 用 `(100 - rate)` 唔用 `rate`（R3）
  - `buildReceiptContent` `discount_breakdown` saving 公式同步修正（R3）

### `desktop-companion`
- `companion-server.mjs`：
  - 加 `splitSpecLine()` helper（R1）
  - items branch card / list 兩個版面嘅 spec 行改用 `twoColumn(label, price)`（R1）

### `print-agent-android`
- `net/EscPosRenderer.kt`：
  - 加 `SpecParts` data class + `splitSpecLine()`（R1）
  - items branch card / list 兩個版面嘅 spec 行改用 `twoColumn(label, price)`（R1）
- `app/build.gradle.kts`：`versionCode 3→4`、`versionName 1.0.2→1.0.3`（renderer 行為再改）

### 驗證
- `npx tsc --noEmit` 乾淨
- `node --check companion-server.mjs` OK
- Android `./gradlew clean assembleDebug --offline` BUILD SUCCESSFUL（39 tasks executed）
- APK 版本確認：`versionCode=4 versionName=1.0.3`（`aapt dump badging`）

## 11. 第二輪生效狀態

| 產物 | 版本 | 狀態 |
| --- | --- | --- |
| Web POS | — | source 已改；**要 deploy 先生效** |
| Desktop Companion | `0.1.16` | source 已改（`node --check` OK）；**要 `npm run dist` 重新打包 exe 先生效** |
| Android APK | `versionCode 4` / `1.0.3` | ✅ clean rebuild → `print-agent-android/print-agent-1.0.3-debug.apk`；**要重新派版裝機先生效** |

---

## 12. 用戶反饋第三輪（2026-09-01 深夜）—— 「優惠合計 -81」

### 12.1 現象

> 「優惠合計，還是錯的，現在我的總金額是 150，原價合計 155，優惠合計 -81。
> 這是錯的，優惠合計應該是 5。**到底為什麼會有 -81**」

### 12.2 點解會係 -81（根因：兩個數唔同源）

收據嘅「優惠合計」原本係咁計嘅（`buildReceiptContent`）：

```
優惠合計 = order.discountAmount（全單折扣） + Σ 單品折讓
```

問題係**呢兩個加數同「原價合計 / 總金額」唔係同一個數據來源**：

| 收據格 | 數據來源 | 由邊度計出嚟 |
| --- | --- | --- |
| 原價合計 | `Σ order.items[].price × quantity` | `computeSubtotalBeforeDiscount()`（由 items 現場計） |
| 總金額 | `order.total` | 落單／結帳時寫死嘅值 |
| 優惠合計 | `order.discountAmount` + 現場計嘅折讓 | **寫死嘅值 ＋ 現場計嘅值** |

`order.discountAmount` 係一個**持久化欄位**，基數係「寫入嗰一刻嘅結帳基準」，
而唔係「而家 items 嘅原價合計」。只要寫入之後 items 變過，兩邊就對唔上。

已知兩個會令佢走樣嘅來源：

1. **本地單 stale**：`pos-app.tsx:1737` 退菜後
   `total = nextTotals.total - activeOrder.discountAmount`，
   `subtotal` 係新計，但 `discountAmount` 係**舊單殘留**、冇按新基數重計。
   加單／返結後再結帳亦同理。
2. **線上單口徑唔同**：`ledger-pos-bridge.ts:346-350` 嘅
   `discountAmount` 由 Ledger（`discount_avos`）提供，`total` 亦係 Ledger 畀，
   但 `subtotal` 係 POS 用本地 items 計——三條數嚟自兩個系統，
   基數可以完全唔同（Ledger 嘅 discount 可能包會員／券／運費減免）。

是次 -81 嘅具體數字推導（`formatMoney` 係 `Math.round`，所以 -81 實際係 -80.85 呢類值）：

```
原價合計 155  −  總金額 150  =  真實折讓 5
優惠合計 81   →  order.discountAmount ≈ 81（寫死值），遠大過真實折讓
⇒ 81 + Σ單品折讓 ≈ 81，而 155 − 81 ≠ 150  ← 收據自相矛盾
```

### 12.3 修正策略：雙軌對帳 + 取細值

**唔再靠「重計折讓」去估**，改為用收據自己印出嚟嘅數反推，兩邊對帳：

```ts
naive   = order.discountAmount + Σ 單品折讓          // 理論值
derived = 原價合計 + 服務費 + 稅 − 抹零 − 總金額      // 反推值
優惠合計 = min(naive, derived, 原價合計)              // 取細，再截頂
```

好處係**「原價合計 + 服務費 + 稅 − 抹零 − 優惠合計 === 總金額」變成收據鐵律**，
無論上游 `discountAmount` 幾離譜都唔會印出對唔到數嘅收據。
取細值亦係安全方向：寧願少報折讓，都唔好報大。

### 12.4 順便修好嘅兩個真 bug

- **`computeItemSavings` 基數錯**：舊碼用 `unitBasePrice(it)`（剝走加購 spec delta），
  但 `pos-app.tsx::orderTotals()` 摺 subtotal 係用 `it.price`（**包**加購）。
  兩邊基數唔同 → 有加購嘅折扣菜折讓會計少（例：原價 105 = 基價 100 + 加購 5，9 折
  → 真折讓 10.5，舊碼只計到 10，收據對唔返總金額）。**改用 `it.price`**。
  `unitBasePrice` 只留畀主行顯示（「原價 $X / 折後 $Y」），唔再用嚟計錢。
- **`clampMoney` 名不符實**：只做 round + 負數歸零，但註釋同 call site 當佢會截頂。
  改名做 `roundMoney`，截頂邏輯集中落 `resolveTotalDiscount()`。

### 12.5 留低嘅診斷線索

`buildReceiptContent` 喺 dev build（`NODE_ENV !== "production"`）入面，
只要 `naive` 同最終取值相差 > 0.01 就 `console.warn` 一包對帳數據：

```
{ localOrderNo, orderId, source, onlineOrderId,
  subtotalBefore, itemSavings, orderDiscount,
  serviceCharge, tax, rounding, orderTotal,
  naive, derived, used, orderSubtotal }
```

下次再見到神秘數字，開 DevTools 睇呢個 warn 就知道係「本地單 stale」定「線上單口徑」：

- `source === "pos"` 且有 `onlineOrderId` → 線上單，對 Ledger 口徑
- 否則睇 `orderSubtotal` vs `subtotalBefore`：前者大好多 → `subtotal` stale

### 12.6 結帳時服務費被丟棄 —— ✅ 已喺 §14 修好

> 本節保留做根因記錄。**用戶已拍板（「落」），修正見 §14。**

`pos-app.tsx:1056-1062` 嘅 `paymentBase` 原本係：

```ts
total: currentSettlementOrder.subtotal + currentSettlementOrder.taxAmount
```

**冇加 `serviceChargeAmount`**。但落單時（1328-1332）係
`total = subtotal + service + tax - discount`。
→ 只要 `rules.serviceChargeRate > 0`，**結帳嗰刻服務費會靜默消失**（落單收據有、結帳冇）。

呢度收據層面已經用「取細值」頂住（唔會因為服務費消失而虛報折讓），但對帳會失衡，
而且**收銀實際係收少咗錢**——所以第三輪冇自己改，留畀用戶拍板。用戶已批准，修正見 §14。

### 12.7 第三輪改動清單

### `macauPosSystem`

- `src/lib/escpos-template.ts`：
  - 新增 `resolveTotalDiscount()`（雙軌對帳 + 截頂）
  - `buildReceiptContent()` 改用雙軌對帳，並加 dev-only `console.warn` 診斷
  - `computeItemSavings()` 基數 `unitBasePrice(it)` → `it.price`
  - `discount_breakdown` 明細行同步改 `it.price`
  - `clampMoney()` → `roundMoney()`（名符其實），截頂集中落 `resolveTotalDiscount()`
  - `computeTotalDiscount()` 同步用 `resolveTotalDiscount()`
  - 移除 unused `unitBasePrice` import
- `tools/verify-receipt-totals.mjs`：改寫成 6 個實證 case（A–F）+ 加購對齊（G）

### `desktop-companion` / `print-agent-android`

**唔使改。** 三輪改動全部喺 `buildReceiptContent()` 產生嘅 `content` 字串層面，
renderer 只係照印 `discount_amount` 嗰行文字，協議無變。

### 驗證

```
node tools/verify-receipt-totals.mjs
```

| Case | 內容 | 結果 |
| --- | --- | --- |
| A | ROUND 2 客訴單（原價 180 / 折讓 2.25 / 總 177.75） | ✅ |
| B | **ROUND 3 客訴單**（原價 155 / 總 150 / stale discount 80.85） | ✅ 取 5，印「MOP -5」 |
| C | 加購菜做單品折扣（原價 105 打 9 折） | ✅ 折讓 10.5（舊碼計 10） |
| D | 健康單（全單 9 折 + 服務費 + 抹零） | ✅ |
| E | 免單（total = 0） | ✅ |
| F | 服務費被丟棄（已知上游 bug） | ⚠️ 對帳失衡但**唔虛報折讓** |
| G | 加購價錢靠右對齊 48 格 | ✅ |

`npx tsc --noEmit` 只剩已知誤報 `src/app/layout.tsx(38,50) LayoutProps`。

## 13. 第三輪生效狀態

| 產物 | 狀態 |
| --- | --- |
| Web POS | source 已改；**要 deploy 先生效** |
| Desktop Companion `0.1.16` | 唔使改（見 12.7） |
| Android APK `1.0.3` | 唔使改（見 12.7） |

## 14. 第四輪（2026-09-02 凌晨）—— 結帳時服務費被丟棄（收少錢）

用戶就 §12.6 拍板：「落」。

### 14.1 影響

只要 `bootstrap.rules.serviceChargeRate > 0`：

| 時點 | 計法 | total |
| --- | --- | --- |
| 落單（`upsertCurrentOrder`，`orderTotals()`） | `subtotal + service + tax − discount` | 有服務費 |
| 結帳（`paymentBase`） | `subtotal + tax` | **冇服務費** |

→ 落單收據有「服務費」一行、結帳單冇，**收銀實收少咗**。而且因為
`discountAmount = discountAmountFromRate(paymentBase.total, rate)`，
連**全單折扣嘅基數都跟住縮水**（落單計喺含服務費嘅數上面，結帳計喺唔含嘅數上面 → 折少咗）。

### 14.2 修正（`src/components/pos-app.tsx`）

```ts
// docs/95 §14：base 總額必須 = subtotal + 服務費 + 稅，同 orderTotals() / 落單寫入一致。
// 舊單（schema 升級前）冇 serviceChargeAmount field → `?? 0` 兜底。
const sumOrderBaseTotal = (order: PosOrder) => order.subtotal + (order.serviceChargeAmount ?? 0) + order.taxAmount;
const paymentBase = currentSettlementOrder
  ? { subtotal: …, serviceChargeAmount: currentSettlementOrder.serviceChargeAmount ?? 0,
      taxAmount: …, total: sumOrderBaseTotal(currentSettlementOrder) }
  : !isQuickMode && activeOrder && cartItems.length === 0
    ? { subtotal: …, serviceChargeAmount: activeOrder.serviceChargeAmount ?? 0,
        taxAmount: …, total: sumOrderBaseTotal(activeOrder) }
    : totals;   // ← cartItems branch，本來就啱（orderTotals() 有計服務費）
```

`paymentSummary.serviceChargeAmount` 由硬寫 `0` 改為 `paymentBase.serviceChargeAmount`。

### 14.3 邊度受影響／邊度冇事（已逐一核過）

受惠（金額變啱）：

- `confirmPayment` → `settledGrandTotal = paymentBase.total − discount − rounding`（2593）
- `completeOnlinePaidOrder` → `settledGrandTotal`（2961）
- 免單 `compedAmount`（2797）
- `discountAmount` / `payableBeforeMember` / 會員扣款上限（1074、1082）

冇雙重計風險：

- 自助點餐單 `kiosk-order.ts:135` 本身 `total = subtotal + tax + service`，同源同口徑 ✅
- **線上 Ledger 單唔會經 `paymentBase`**：`bridgeLedgerOrderToPos()` 只寫落
  `bridgedOrders` in-memory Map（契約 M3/M8「線上單唔 mirror 入 POS DB」），
  而 `currentSettlementOrder` 只從 `orders` 搵 → 永遠搵唔到 bridged 單。
  所以 `ledger-pos-bridge.ts:322` 本地計嘅 `serviceChargeAmount` 只影響廚房／收據顯示，
  **唔會影響結帳收錢**，冇雙重計。
- `service_charge_amount` 落 DB（`api/pos/sync/route.ts:211`）同讀返（`pos-order-mapper.ts:59`、
  `api/pos/state/route.ts:61`、`api/pos/orders/route.ts:37`）都係通嘅，結帳時讀得返。

### 14.4 ⚠️ 歷史資料（重要）

**fix 之前已經結帳落 DB 嘅單，`total` 係冇服務費嘅舊數，唔會自動補。**

- 唔會做 data migration（改歷史金額＝改歷史營收，風險大過收益）。
- 收據層面由 §12 嘅 `resolveTotalDiscount()` 頂住：
  `derived = 原價合計 + 服務費 + 稅 − 抹零 − 總金額` 會變成大數，
  取 `min(naive, derived)` → 照舊唔會虛報折讓（安全方向）。
- 即係舊單收據會「對唔平」，但**唔會印錯折讓金額**——呢個係刻意嘅取捨。

### 14.5 驗證

`tools/verify-receipt-totals.mjs` 嘅 Case F 拆做兩個：

| Case | 內容 | 結果 |
| --- | --- | --- |
| **F1** | 修好後：原價 100 + 服務費 10 = total 110 | ✅ 對帳平衡、折讓 0 |
| **F2** | 舊單：原價 100 + 服務費 10，total 仍係 100（fix 前落 DB） | ⚠️ 已知失衡，但折讓 0（唔虛報） |

```
node tools/verify-receipt-totals.mjs   →  ✅ 全部通過（A–G 共 8 個 case）
npx tsc --noEmit                        →  只剩已知誤報 layout.tsx(38,50) LayoutProps
```

### 14.6 第四輪生效狀態

| 產物 | 狀態 |
| --- | --- |
| Web POS | source 已改；**要 deploy 先生效** |
| Desktop Companion | 唔使改（純 Web POS 計數邏輯） |
| Android APK | 唔使改 |
