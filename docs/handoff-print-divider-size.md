# 交接：分格線（divider）字體大小契約（2026-09-09）

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
val divider = "-".repeat(cols)
val dividerBlock = template.blocks.firstOrNull { it.id == "divider" }
val dividerOff = dividerBlock != null && !dividerBlock.visible
val fixedDividerSize = dividerBlock?.takeIf { it.visible }?.size
fun rule() {
    if (dividerOff) return
    fixedDividerSize?.let { buf.style(it, false) }   // 有 divider 區塊 → 明確 size
    buf.line(divider)                                 // 舊模板 → 唔 call style()，沿用繼承
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

desktop-companion（`companion-server.mjs`）等價改法：

```js
const dividerBlock = (snap.blocks || []).find((b) => b.id === "divider");
const dividerOff = !!dividerBlock && !dividerBlock.visible;
const fixedDividerSize = dividerBlock && dividerBlock.visible ? (dividerBlock.size || "s") : null;
const rule = () => {
  if (dividerOff) return;
  if (fixedDividerSize) setStyle(fixedDividerSize, false, false);
  // 舊模板（fixedDividerSize == null）→ 唔好 call setStyle，維持繼承
  push(encodeText(RULE, charset));
  push(Buffer.from([0x0a]));
};
```

## 預覽點樣模擬（本 repo `escpos-preview.tsx`）

`DividerRows` 用**文字 dash** 而唔係 CSS border，並按實體放大倍數模擬：

- 基準（`s`）：48 個 dash 排滿紙闊 → `baseFontPx = paperInnerPx / 48 / 0.6`
- `m`：雙闊 → **48 個 dash 會 wrap 成 2 個物理行**（每行 24 個），用 `scale(2, 1)`
- `l`：2×2 → 2 行 + `scale(2, 2)`（行距實機係 `ESC 3 60`，呢度用 row height ×2 表達）

所以預覽見到嘅 dash 大細 / 行數，同出紙係同一套計算。

## 已知取捨

- 升級後，`items` size 唔係 `m` 嘅舊店（例如自訂咗 `l`），分格線會由「繼承 items size」
  變成模板嘅 `divider.size`（預設 `m`） —— 一次性改變，之後可以由設計頁自己揀。
- `m` / `l` 喺 80mm 紙上必然係**兩行** dash（48 格 ÷ 雙闊）。想要單行幼線就揀 `s`。
