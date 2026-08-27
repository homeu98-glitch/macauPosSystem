# 74 · 模板大字體列印「全部變扁」變形分析 + 修復 Plan

> 關聯：docs/70（字體倍大對照）、docs/71（商頌 POS-80 實機測試）、docs/72（USB 即插即用）。
> 現象：用家將模板**全部內容**設為大字體（l）後，出紙版面所有文字壓扁/重疊，但 web 預覽正常。

---

## §1 · Root Cause（點解設大字體會變扁）

### 1.1 ESC/POS 嘅兩個獨立維度

熱敏機有兩組**互不相干**嘅控制：

| 控制 | 指令 | 作用 | 單位 |
|------|------|------|------|
| **字符大小** | `ESC ! n`（0x1B 0x21 n） | 放大字形（高度 + 寬度） | — |
| **行距（進紙量）** | `ESC 3 n`（0x1B 0x33 n） | 每個 `LF`（0x0A）向下推幾多紙 | 1/180 吋 |

- `l` = 雙高雙寬（2×2），字形高度 ≈ 2×，即約 **60/180"**。
- 但 `LF` 嘅行距由 `ESC 3 n` 決定，**預設 n=30**（即 30/180" = 1/6"）。

### 1.2 變扁嘅機制

```
設 l（字形 2× 高）後：
  字形高度 ≈ 60/180"  ← 變大
  但 ESC 3 n 仍 = 30   ← 行距冇變（30/180"）
  → LF 只推 30/180"，而字本身要 60/180" 先放得落
  → 下一行直接疊上当前行嘅下半身
  → 全部文字互相重疊、視覺上「壓扁 / 變形」
```

**結論**：變形**唔係紙張總長度唔夠**。切紙指令（`GS V` / `ESC i`）係按「已印行數」自動延伸紙長，紙會越印越長，唔會因字大截短。真正問題係**行距冇跟字形同步放大**，相鄰行重疊。

### 1.3 點解 web 預覽冇事

web 預覽用 CSS `line-height`，字體放大時 `line-height` 會**跟 font-size 自動放大**（例如 `line-height: 1.4` 係相對值，font 大佢就大）。
但 raw ESC/POS 字節嘅行距係**固定指令值**，唔會因 `ESC ! n` 自動變。
→ 預覽（CSS 自動）≠ 出紙（行距固定）= **「設計 == 預覽 == 出紙」原則（docs/60）被違反**。

---

## §2 · Code Location（邊度要改）

### 2.1 Companion（desktop-companion）
`C:\dev\desktop-companion\companion-server.mjs`

- **`setStyle`（:263-266）**：只 emit `ESC ! n` + `ESC E`，**冇 emit `ESC 3 n`** ← 病根
- `textLine`（:267-279）：call `setStyle` 後 push `LF`，行距由全局 `ESC 3 n` 決定
- `divider`（:281-286）：同上
- 注意：模板路徑（:290+）都經 `textLine` / `setStyle`，所以一改 `setStyle` 全路徑受惠

### 2.2 Android Print Agent（print-agent-android）
`EscPosRenderer.kt` 嘅 `Buf.style(...)` 同樣只 set `ESC ! n`，冇 set `ESC 3 n` → Android 出紙都會變扁，必須一齊改。

### 2.3 Web 預覽（macauPosSystem）
`src/lib/print-bridge/...` 嘅 `renderEscPosLines`（CSS）目前 `line-height` 比例未必同 ESC/POS 行距 1:1 對齊，要校到 **s : m : l = 1 : 1 : 2**（見 §3.3）。

---

## §3 · ESC/POS 修復（setStyle 同步 emit `ESC 3 n`）

### 3.1 Companion 改法（companion-server.mjs:263-266）

```js
const setStyle = (size, bold) => {
  push(Buffer.from([0x1b, 0x21, SIZE_BYTE[size] || 0x00])); // ESC ! 字型大小
  push(Buffer.from([0x1b, 0x45, bold ? 1 : 0]));            // ESC E 粗體
  // ✅ 新增：行距跟字形同步（單位 1/180"）
  const LINE_FEED = { s: 30, m: 30, l: 60 }[size] || 30;     // l 雙高→行距 double
  push(Buffer.from([0x1b, 0x33, LINE_FEED]));               // ESC 3 n 行距
};
```

> 數值依據：s/m 字形 ≈ 30/180" 行高，`l`（2×）≈ 60/180"。`ESC 3 60` = 1/3"，正好包住雙高字。

### 3.2 Android 改法（EscPosRenderer.kt Buf.style）
同邏輯：style 切到 l 時 emit `ESC 3 60`，切回 s/m 時 emit `ESC 3 30`。

### 3.3 Web 預覽對齊（renderEscPosLines）
確保 CSS `line-height` 比例 = `s:1 / m:1 / l:2`，令預覽同出紙行距一致（docs/60 原則）。

---

## §4 · 正確嘅模板設定指引（畀用家）

1. **唔好全張設 l**。大字體（l）係 2×2，整張用會令每行都雙高、非常占紙 + 行距被逼 double，**只適合標題/總額**。
2. **建議分級**：
   - 店名 / 總額 / 「謝謝惠顧」→ `l`（大字）
   - 品名 / 數量 / 單價 → `m`（雙寬）或 `s`
   - 細則（稅號、備註）→ `s`
3. **紙張尺寸**：80mm 熱敏紙，模板寬度跟機身（57mm / 80mm），唔使因字大改紙長（切紙自動延伸）。
4. **排版參數**：左右邊距靠 `ESC a` 對齊；分隔線用固定字元（如 `--------------------------------`），唔好靠空格硬撐。
5. 改完 §3 後，**大字唔會再變扁**，但全張 l 仍然會「好大好長」——呢個係預期，唔係 bug。

---

## §5 · 執行 Phase（P1-P6）

| Phase | 範圍 | 複雜度 | 驗證 |
|-------|------|--------|------|
| **P1** | Companion `setStyle` 加 `ESC 3 n`（l→60 / s,m→30） | 低 | `node --check` + 實機印一張全 l 模板，確認唔再重疊 |
| **P2** | Android `EscPosRenderer.Buf.style` 同步行距 | 低 | Android 實機印同款模板對照 |
| **P3** | Web `renderEscPosLines` line-height 比例校 1:1:2 | 低 | 瀏覽器預覽同出紙行距目測一致 |
| **P4** | 預覽/出紙一致性自檢：加一張「設計==預覽==出紙」冒煙用例 | 中 | 同一 template 三端輸出差異比對 |
| **P5** | 文檔歸檔：更新 docs/70 §字體行距、docs/60 原則補行距條款 | 低 | — |
| **P6** | 打包 companion 新版本 + **主動報版本號**（用家規約：每次 desktop app 更新要報號） | 低 | 告知用家新 version |

> P1-P3 係核心修復，P4-P6 係硬化 + 交付。建議先過 P1-P3 俾用家實機確認，再走 P4-P6。

---

## §6 · 臨時 Workaround（未改 code 前）

- 暫時**唔好全張設 l**：標題用 l、內文用 m/s，變形即消失（因為只有 l 觸發雙高行距不足）。
- 或者喺模板編輯器手動拉大「行距 / 行高」欄（若 UI 有 expose）→ 彈返够紙俾雙高字。

---

## §7 · 總結

「設大變扁」嘅 root cause = **`ESC ! n` 放大字符，但 `LF` 行距（`ESC 3 n`）冇同步放大**（`companion-server.mjs:263-266` setStyle）。
紙張總長度**唔係**成因（切紙自動延伸）。
修法 = `setStyle` 同步 emit `ESC 3 n`（l → 60、s/m → 30），**Companion + Android + web 三端一齊改**，確保「設計 == 預覽 == 出紙」。

---

## §8 · 已落碼狀態（2026-08-27，用家 confirm P1-P3 三端齊改 + 其他機 re-verify）

| 端 | 檔案 | 狀態 |
|----|------|------|
| P1 Companion | `C:\dev\desktop-companion\companion-server.mjs:263-271` `setStyle` | ✅ 已加 `ESC 3 n`（l→60 / s,m→30）+ `printer.lineSpacing` 覆寫位 |
| P3 Web | `src/components/escpos-preview.tsx` | ✅ 加 `PREVIEW_LINE_HEIGHT=1.4` 常數，文字行/菜品行顯式 `lineHeight`，比例 1:1:2 對齊 ESC 3 n |
| P2 Android | `EscPosRenderer.kt`（經 AAR `POSConnect` 連線 + `ESC 3 n` 修正，見 `docs/75 §7`/`§75b`） | ✅ 已落碼（路 b 混合） |

> `node --check companion-server.mjs` ✅。`escpos-preview.tsx` 係 type-safe 微改（`lineHeight` prop 係 CSSProperties 合法 field），`tsc --noEmit` 唔應有新 error（layout.tsx 已知誤報除外）。

### §8.1 Android 落碼 Patch（`EscPosRenderer.kt`）

本 checkout `print-agent-android/` 無 Kotlin 實作（見 memory 72e），以下 patch 喺你嘅 Android repo apply：

**定位**：`grep -rl "class EscPosRenderer" print-agent-android/` 或 `.../net/EscPosRenderer.kt`；搵 `Buf` 類入面嘅 `style(size, bold)` 方法。

**A. 加常數 + 可覆寫欄位**（ near `SIZE_BYTE` / `Buf` 類頂）：
```kotlin
// 行距跟字形同步（docs/74）：單位 1/180"，l 雙高→行距 double，避免大字重疊變扁
private val LINE_FEED: Map<EscPosSize, Int> = mapOf(
    EscPosSize.S to 30, EscPosSize.M to 30, EscPosSize.L to 60
)
// 其他機型 re-verify 用：set 咗就優先用（同 Companion printer.lineSpacing 對齊）
var lineSpacing: Map<EscPosSize, Int>? = null
```

**B. `Buf.style(...)` 加 `ESC 3 n`**（原本只 emit `ESC ! n` + `ESC E`）：
```kotlin
fun style(size: EscPosSize, bold: Boolean) {
    curSize = size
    cmd(ESC, 0x21, SIZE_BYTE[size] ?: 0x00)   // ESC ! 字型大小
    cmd(ESC, 0x45, if (bold) 1 else 0)        // ESC E 粗體
    val lf = lineSpacing?.get(size) ?: (LINE_FEED[size] ?: 30)
    cmd(ESC, 0x33, lf)                         // ESC 3 n 行距（✅ 新增）
}
```

### §8.2 其他機型 re-verify（`ESC 3 n` 重新對）

用家要求「其他也重新對」。做法 = **唔使改 code**，經 profile 覆寫 `lineSpacing`：

1. Companion：將 `printer.lineSpacing = { s: 30, m: 30, l: <試值> }` 帶入 `renderEscPos(job, printer)`。
   - 商頌 POS-80 已對：l=60 冇重疊。
   - 其他機：印一張「全 l」測試單，若仍微微重疊→ l 試 64–66；若太疏→ 試 50–54。range 安全值 30–72（1/6"–2/5"）。
2. Android：set `Buf.lineSpacing = mapOf(S to 30, M to 30, L to <同值>)`。
3. Web：預覽係相對行高，比例自動跟 SIZE_PX（l=2×s）→ 唔使逐機調，只用來目視確認。

> 建議：每款機型首次接，跑一次「全 l 測試單」當做 profile 校準步驟，數值記入 `USB_PRINTER_DB` 嘅 `lineSpacing` 維度（可沿用 `kanjiEnlarge` 同款結構）。

### §8.3 部署待辦（standing）
- Companion `npm run dist` → **主動報新版本號**（含 §8 `ESC 3 n` 修）。
- Android `./gradlew assembleDebug`（含 §8.1 patch；沙盒無 SDK，用家 dev box）。
- Web `next build` + push Vercel（P3 即生效）。
- 三端齊咗先算「大字體」問題全解。
