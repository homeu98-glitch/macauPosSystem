# 交接：分格線（divider）字體大小契約（2026-09-09）

> ⚠️ **2026-09-10 更新（重要）**：本文 §「新契約」講「`m` / `l` 會 wrap 成兩行係正常」**已經作廢**。
> 實紙證明嗰個「兩行」就係門店投訴嘅 bug（一條線變兩條，見 **docs/114**）。
> 最新契約：**① 印線前一定要清 `GS !` / `ESC !` / `FS !` 放大殘留；② dash 數量 =
> `dividerDashCount(size, cols)`（`m`/`l` 減半）→ 任何 size 都只佔一行，`size` 淨係控制粗細。**
> 下面 §「新契約」嘅 `"-".repeat(cols)` 寫法同 §「已知取捨」嘅「m/l 必然兩行」請以 docs/114 為準。

## 背景：點解要改

實體分格線唔係圖形線，而係**一行 `-` 字符**（各 renderer 都係 `"-".repeat(cols)`）。
ESC/POS 嘅放大狀態（`ESC ! n` / `GS ! n`）係 **sticky** 嘅，而 renderer 印分格線前**冇 reset style**
→ 分格線會繼承上一行嘅字體大小：

- 廚房單：菜品主行係 `m`／`l` → 每件菜下面嗰條 `-----` 會跟住放大（`m` = 雙闊、`l` = 2×2）
- 網頁預覽（`escpos-preview.tsx`）以前係一條固定 1px 嘅 CSS `border-dashed` → **永遠唔會放大**

結果：「實紙跟字體放大、模板預覽唔放大」，設計介面 == 預覽 == 出紙 斷咗。

## 新契約：模板 `divider` 區塊（設定型）

`ReceiptSectionId` / `KitchenSectionId` 新增 `"divider"`。標籤模板（62mm）**冇**呢個區塊（標籤紙冇分格線）。

| 欄位 | 意義 |
|---|---|
| `visible: false` | 全張單**唔印任何**分格線（菜品明細前後 + card 每件菜之間） |
| `visible: true` | 印，並用 `size` 作為分格線嘅字體大小 |
| `size: "s" \| "m" \| "l"` | `s` = 1×（48 個 dash 啱啱一行）；`m` = 雙闊；`l` = 2×2 |

⚠️ **`divider` 係設定型區塊：renderer 遇到 `b.id == "divider"` 要 `continue`，唔好 emit 任何行**
（唔係會多咗條線／去 `content["divider"]` 搵唔到嘢而印空行）。

### 向後兼容（舊模板）

舊模板冇 `divider` 區塊 → **`fixedDividerSize == null` → 唔好 call `style()`**，
維持「繼承上一行 size」嘅舊行為，出紙零影響。

POS 端（本 repo）`normalizePosLocalSettings` 會自動將新區塊 merge 落舊設定
（`mergeTemplateBlocks` / `mergeTemplateOrder`），所以舊店 reload 一次就會見到「分格線」區塊，
`size` 預設 `"m"`（對齊而家大部份店嘅實際出紙）。

## 三邊實作現況

| 端 | 檔案 | 狀態 |
|---|---|---|
| POS（本 repo，設計 + 預覽） | `src/lib/escpos-render.ts`、`src/lib/escpos-template.ts`、`src/components/escpos-preview.tsx`、`src/components/print-center.tsx` | ✅ 已改 |
| print-relay APK（正式出紙通道） | `C:\dev\print-relay\app\...\EscPosRenderer.kt` `renderTemplateTicket()` | ✅ 已改 |
| print hub APK（同上嘅舊副本） | `C:\dev\print hub\app\...\EscPosRenderer.kt` | ✅ 已改 |
| desktop-companion | `companion-server.mjs` `divider()`（而家強制 `setStyle("s")`） | ⬜ 未改（見下面片段） |
| print-agent-android | `EscPosRenderer.kt` `renderTemplateTicket()` | ⬜ 未改（見下面片段） |

未改嗰兩個通道：**舊模板行為不變**（Companion 繼續印細線、print-agent 繼續繼承），
只係唔認新嘅 `divider` size —— 要用嗰陣照下面片段落就得。

## Renderer 改法（Kotlin，print-relay 已落地嘅版本）

```kotlin
// ⚠️ 2026-09-10 修正版（見 docs/114）：
//   ① 印線前清放大殘留（GS! / ESC! / FS!）——唔清就會繼承上一行（菜品名）嘅放大 → 折行變兩條
//   ② dash 數量放大就減半 → 永遠一行
val dividerBlock = template.blocks.firstOrNull { it.id == "divider" }
val dividerOff = dividerBlock != null && !dividerBlock.visible
val fixedDividerSize = dividerBlock?.takeIf { it.visible }?.size
fun rule() {
    if (dividerOff) return
    buf.clearMagnify()                                   // GS! 0 / ESC! 0 / FS! 0
    val size = fixedDividerSize ?: buf.currentSize()      // 舊模板 → 沿用繼承語義
    val dashes = if (size == "s") cols else (cols + 1) / 2
    buf.style(size, false)
    buf.line("-".repeat(dashes))                          // 永遠一行
}
for (b in template.blocks) {
    if (!b.visible) continue
    if (b.id == "divider") continue                   // 設定型區塊：唔 emit 行
    if (b.id == "items") {
        rule()                                        // 明細前
        ...
        rule()                                        // card 每件菜之間（紧跟主行）
        ...
        rule()                                        // 明細後
    }
}
```

desktop-companion（`companion-server.mjs`）等價改法（2026-09-10 修正版）：

```js
const dividerBlock = (snap.blocks || []).find((b) => b.id === "divider");
const dividerOff = !!dividerBlock && !dividerBlock.visible;
const fixedDividerSize = dividerBlock && dividerBlock.visible ? (dividerBlock.size || "s") : null;
const rule = () => {
  if (dividerOff) return;
  push(Buffer.from([0x1d, 0x21, 0x00]));   // GS ! 0 ← 清中文放大殘留（關鍵）
  push(Buffer.from([0x1b, 0x21, 0x00]));   // ESC ! 0
  push(Buffer.from([0x1c, 0x21, 0x00]));   // FS ! 0
  const size = fixedDividerSize || "s";
  setStyle(size, false, false);
  const dashes = size === "s" ? paperCols : Math.ceil(paperCols / 2);  // 永遠一行
  push(encodeText("-".repeat(dashes), charset));
  push(Buffer.from([0x0a]));
};
```

## 預覽點樣模擬（本 repo `escpos-preview.tsx`）

`DividerRows` 用**文字 dash** 而唔係 CSS border，並按實體放大倍數模擬（2026-09-10 修正版）：

- 基準（`s`）：`cols` 個 dash 排滿紙闊 → `baseFontPx = paperInnerPx / cols / 0.6`
- `m`：雙闊 → dash **數量減半**（`dividerDashCount()`），用 `scale(2, 1)` → **仍然一行**（線粗一倍）
- `l`：2×2 → dash 數量減半 + `scale(2, 2)` → 仍然一行

所以預覽見到嘅 dash 大細 / 粗細 / 行數，同出紙係同一套計算（`dividerDashCount` 係跨 repo 契約）。

## 已知取捨

- 升級後，`items` size 唔係 `m` 嘅舊店（例如自訂咗 `l`），分格線會由「繼承 items size」
  變成模板嘅 `divider.size` —— 一次性改變，之後可以由設計頁自己揀。
- `size` 由「字體大小」改為理解成「粗細」：`m` / `l` 印同一條線但用雙闊字（睇落粗一倍），
  **任何 size 都只佔一行**。想最幼就揀 `s`（預設）。

