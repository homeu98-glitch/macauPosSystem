# 114 · 收據「分隔線變兩條 + 菜品名字體異常」根因與修法（2026-09-10）

> 🔴 **2026-09-11 更新（重要，實紙再次投訴）**：門店 09-11 19:01 嘅**廚房單**實紙，
> 菜品之間仍然係**兩條線**（菜品清單之前一條）——症狀同 §1 一模一樣。
> **根因唔係代碼，係部署**：上面五個通道嘅修正**全部只停留喺源碼，冇 build 過新 APK、冇裝落機**。
>
> - `print-relay`：`git log -1` = **09-04 14:26**，三個檔一直 `M`（未 commit）；
>   唯一 APK = `app/build/outputs/apk/debug/app-debug.apk` **2026-09-04 14:16** → 部機跑緊嘅就係呢個。
>   `git show HEAD:…EscPosRenderer.kt` 仍然係舊版 `val divider = "-".repeat(cols)`（冇清殘留）→ 必然折行。
> - 同模式：`print hub` APK 09-03、`print-agent-android` APK 09-02、`desktop-companion` 未出安裝檔。
> - **反證 POS 側係新嘅**：設計頁文案已係「dash 數量會相應減半，所以任何大小都只會佔一行」→
>   **網頁會自動更新、APK 唔會** → 所以出現「預覽一條線、實紙兩條線」。
> - **已做（09-11）**：`print-relay` `versionCode 5→6` / `versionName 1.1.3→1.1.4`（**擰版本號係驗收前提**），
>   `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug` → **BUILD SUCCESSFUL**，
>   新 APK 2026-09-11 21:04（3,616,860 bytes）；`verify-escpos-bytes.mjs` **全部契約通過**。
> - ⬜ 仲要：裝 v1.1.4 落門店部機、確認門店跑邊個通道（§5）、其餘三通道照同一份修正重出。
> - 教訓：**「代碼改好」≠「行為改變」**。呢個坑 docs/101/102/103 已中過，今次係第 N 次；
>   下次改 renderer 之後，`git log -1` 日期、APK mtime、`git status` 三個一齊睇。

> **狀態（2026-09-10 收尾）**：**五個通道全部改完**——
> POS 預覽（§3.2）、`print-relay`（§3.3）、`print hub` + `print-agent-android`（§3.4）、
> `desktop-companion`（§3.5）。三個 Kotlin repo `:app:compileDebugKotlin` 全部 BUILD SUCCESSFUL、
> `companion-server.mjs` `node --check` 通過、`verify-escpos-bytes.mjs` 契約全過。
> **仲未做**：實紙驗收 + 重 build APK 裝落機（見 §4）。

> **症狀**（實紙照片，表嫂美食 訂單 MF0004）：
> ① 菜品清單**之前**嗰條分隔線正常（一條幼線）；
> ② **每件菜名下面都變兩條線**（上面一條、下面一條，而且 dash 明顯粗一倍）；
> ③ 菜品名嘅字形比設計頁預覽**大／粗一截**（預覽同實紙唔一致）。
> 設計頁後台（`/prints`）預覽完全正常：每個位置一條幼線、菜名大小正常。
>
> **結論**：唔係模板（模板無錯），係**出紙 renderer 冇清打印機嘅中文放大殘留**——
> 分隔線係一行純 ASCII 字符，會「繼承上一行」嘅放大狀態而自動折行。

---

## §1 · 證據（照片量測，非猜測）

用像素量測實紙照片（`7387919a…jpg`），分隔線有兩種完全唔同嘅 dash：

| 位置 | dash 段長 | 段數／行 | 物理行數 |
|---|---|---|---|
| 菜品清單**之前**（`結帳時間` 之後） | **~13 px**（= 1 格） | ~41–48 | **1 行** ✅ |
| 每件菜名**之後** 第 1 行 | **~26 px**（= 2 格） | ~24（雙闊一行只裝 24 格） | **2 行** ❌ |
| 每件菜名**之後** 第 2 行 | **~26 px** | ~24 | ↑ 同一條線折出嚟 |

放大倍數 = 26 / 13 = **2×**。兩條線嘅 dash 粗細、間距完全一樣 → 佢哋係**同一條邏輯線被打印機折成兩個物理行**，
唔係 renderer 印咗兩次（如果係印兩次，兩個行嘅 dash 會同樣粗幼都係 1×）。

而 `1. 梅菜肉餅飯` 嘅字高（~55 px）≈ 標頭文字（~30 px）嘅 **1.8–2×** → 菜品名行係**放大狀態**，
後面緊接嗰條線就係「受害者」。

---

## §2 · 根因

### 2.1 分隔線係純 ASCII 行，而放大指令係「常駐狀態」

ESC/POS 有三套放大指令，作用對象唔同（docs/80 §4.2、docs/99 §1）：

| 指令 | 作用對象 | 語意 |
|---|---|---|
| `ESC ! n`（1B 21） | 淨 ASCII / 半形 | bit 0x20 = 雙闊、0x10 = 雙高 |
| `FS ! n`（1C 21） | 淨 Kanji / 全形 | bit 0x04 = 雙闊、0x08 = 雙高 |
| `GS ! n`（1D 21） | ASCII + Kanji 一律 | nibble `((h-1)<<4)|(w-1)` |

兩個關鍵事實：

1. 呢啲指令**唔係「每行一次」而係「狀態機」**——發過一次就一直有效，直到再發一次覆蓋。
2. 喺 Gprinter / 商頌 POS-80 系機器上，`ESC !` **清唔走** `GS !`；兩者係**相乘**而唔係後者蓋前者。

而四個 repo 嘅 renderer 印分隔線時，都係咁做（以 `print-relay` 為例）：

```kotlin
fun rule() {
    if (dividerOff) return
    fixedDividerSize?.let { buf.style(it, false) }   // ← 只發 ESC !（ASCII 行唔會發 GS !）
    buf.line(divider)                                // ← "-".repeat(cols) = 純 ASCII
}
```

`emitLine()` 入面 `GS !` **只喺 `if (cjk)` 分支入面發**，所以呢行 dash **永遠冇 `GS !` 0x00**。
結果：上一行係 CJK 菜品名（`items.size = m` → 發過 `GS ! 0x01`）時，
`GS !` 嘅放大狀態仍然生效 → dash 變雙闊 → 48 個 dash 一行只裝得落 24 格 →
**打印機自動折行** → 一條邏輯線變兩條實體線。

### 2.2 為何「上面一條、每件菜下面兩條」唔對稱？

| 線嘅位置 | 上一行係乜 | 上一行嘅放大狀態 | 出紙結果 |
|---|---|---|---|
| 菜品清單之前 | 標頭（`結帳時間` 等，`s`） | `GS ! 0x00`（無放大） | 48 個細 dash → **1 行** ✅ |
| 每件菜名之後 | 菜品主行（`items.size = m`） | `GS ! 0x01`（雙闊，**殘留**） | 48 個雙闊 dash → 折行 → **2 行** ❌ |

即係話：**唔係模板畫多咗一條線，係打印機嘅狀態傳染。**

### 2.3 為何廚房單正常？

兩個 renderer 係**同一份算法**，分別淨係「上一行係乜」同模板設定：

- 廚房單嘅分隔線前後，前面嗰行多數係細字（`order_no` / `time` / 或該店廚房模板嘅
  `items.size = 細`）→ `GS ! 0x00` → 冇放大殘留 → dash 一行印得落 → **正常**。
- 收據嘅菜品名係「中」（`items.size = "m"`，預設值）→ `GS ! 0x01` → 傳染落分隔線。

所以「廚房正常、收據唔正常」**唔係兩個 renderer 唔同**，而係**佢哋前面嗰行嘅放大倍數唔同**。
（如果同一間店嘅廚房模板都將菜品名設做「中」，廚房單一樣會出現雙線。）

### 2.4 字體異常

同一根源嘅另一面：

- 菜品名係 CJK 行，大小由 `GS !` 決定。呢類機 `GS ! 0x01` 係 **2×2（雙闊雙高）**，
  所以實紙嘅菜名比 1× 大一倍。
- 而設計頁預覽（`escpos-preview.tsx`）只用 `fontSize = SIZE_PX[size]`（`m` = 14px，即 **1.27×**）近似，
  完全冇模擬「CJK 雙闊 + `GS !` 相乘」嘅效果。
- 結果：商家喺後台揀「中」，預覽睇落只大少少，實紙就大咗**一倍**（仲可能有 `ESC !` × `GS !` 相乘嘅
  舊版 bug，見 docs/99 §2，會變 2×3 / 4×4 = 「拉長變形」）。

---

## §3 · 修法

### 3.1 契約（四個 repo 必須一模一樣）

1. **印任何一行之前，先清走放大殘留**，再按呢行嘅 size 明確發指令：
   ```
   GS ! 0x00 ; ESC ! 0x00 ; FS ! 0x00     ← 清殘留（唔好靠上一行）
   ESC ! SIZE_BYTE[size]                   ← ASCII 行用
   GS !  GS_SIZE_BYTE[size]                ← CJK 行用（FS! 路線就 FS !）
   ```
2. **分隔線永遠只佔一行**：dash 數量 =
   ```
   scaleX = (size == "s") ? 1 : 2;      // m / l 都係雙闊
   count  = ceil(cols / scaleX);        // 80mm：48 → s=48、m/l=24
   ```
   `size` 淨係控制條線嘅**粗細**（雙闊 = 粗一倍），唔再改變行數。
   POS 側唯一真源：`src/lib/escpos-render.ts` `dividerDashCount()`。
3. `cols` 仍然由 `EscPosTemplateSnapshot.cols` 帶落嚟（58mm → 32）。

### 3.2 POS（本 repo）— ✅ 已完成

| 檔案 | 改動 |
|---|---|
| `src/lib/escpos-render.ts` | 新增 `dividerDashCount()`；`divider` 行新增 `count`；`items` 行新增 `cols`；補契約註釋 |
| `src/components/escpos-preview.tsx` | `DividerRows` 由「模擬折成兩行」改為**永遠一行**（dash 數量跟契約、用 `scale()` 表達粗細） |
| `src/lib/escpos-template.ts` | `divider` 預設 `m` → **`s`**（一條幼線，同商家預期 / 預覽一致）；舊模板補 `divider` 亦用 `s` |
| `src/lib/mock-data.ts`、`src/lib/types.ts`、`src/components/print-center.tsx` | 文案 / 註釋由「字體大小、中大全會變兩行」改為「粗細、永遠一行」 |

### 3.3 print-relay APK（正式出紙通道）— ✅ 已完成

`app/src/main/java/com/macau/printhub/net/EscPosRenderer.kt` — `:app:compileDebugKotlin` **BUILD SUCCESSFUL**

**實際做法比原方案更徹底**：清殘留唔係只做喺 `rule()`，而係**每一行**都做——
`emitLine()` 開頭統一 call `clearMagnify()`，所以任何行（唔止分格線）都唔會繼承上一行嘅放大狀態。

```kotlin
// Buf 內新增：只清放大，不動行距
fun clearMagnify() = apply {
    cmd(GS, 0x21, 0x00)
    cmd(ESC, 0x21, 0x00)
    cmd(FS, 0x21, 0x00)
}

// emitLine() 第一句：val cjk = hasCJK(s) 之後即刻 clearMagnify()

// rule()：清殘留交畀 emitLine（唔重複），只需決定 size 同 dash 數
fun rule() {
    if (dividerOff) return
    val size = fixedDividerSize ?: buf.currentSize()   // 舊模板：沿用「繼承」語義
    buf.style(size, false)
    buf.line(dashLine(size))                            // s → cols；m / l → ceil(cols/2)
}
```

**另外改動**：`renderKitchenTicket()` / `renderReceiptTicket()` / `renderTestPage()` 原本用
top-level `separator(width, cs)` 直出 raw bytes（**繞過 `emitLine`，所以冇自動清殘留**）。
已收斂成 `Buf.sep(width)`，入面自己清一次殘留再印 `-`，`separator()` 已刪除。

> ⚠️ 唔可以只喺 `rule()` 清：`separator()` 嗰類 raw-byte 行繞過 `emitLine`，係第二條漏網路徑。

### 3.4 print hub（舊副本）/ print-agent-android — ✅ 已完成

兩個都係 docs/99 之前嘅版本（`.kt` 內 `KANJI_SIZE_BYTE` 用咗 `ESC !` 嘅位元值 `0x20 / 0x30`）。
**已先套 docs/99**（`GS_SIZE_BYTE` = `m 0x01 / l 0x11`、`FS_SIZE_BYTE` = `m 0x04 / l 0x0C`、
`emitLine()` 每行決定 `ESC !` 放大位），**再套 docs/114**（`clearMagnify()` + `dashLine()` + `sep()`）。
`:app:compileDebugKotlin` 兩邊都 **BUILD SUCCESSFUL**。

| repo | 額外修正 |
|---|---|
| `print hub` | 本身已有 `divider` 區塊處理（`rule()` 只發 `ESC !`、清唔走 `GS !`）→ 補 `clearMagnify()`；`KANJI_SIZE_BYTE` → `GS_SIZE_BYTE` + `FS_SIZE_BYTE` |
| `print-agent-android` | **完全冇讀 `divider` 區塊**（`dividerOff` / `fixedDividerSize` 都冇）→ 一併補上，同 POS / print hub 三邊一致；另加 `if (b.id == "divider") continue` |

> 💡 `print hub` 同 `print-relay` 係**同一個 App 嘅兩份檢出**（`rootProject.name` 都係 `print-hub`；
> `print hub` 冇 git remote、只有 2 個 commit，最後更新 2026-09-03）。兩邊都已同步修正，
> 但**門店究竟跑邊份 build 要人手確認**（見 §5）。

### 3.5 desktop-companion — ✅ 已完成

`desktop-companion/companion-server.mjs`（`node --check` 通過）

```js
// 新增：清三套放大殘留（唔動行距；next textLine 會自己重設 ESC 3）
const clearMagnify = () => {
  push(Buffer.from([0x1d, 0x21, 0x00])); // GS ! 0  ← 關鍵：清中文放大殘留
  push(Buffer.from([0x1b, 0x21, 0x00])); // ESC ! 0
  push(Buffer.from([0x1c, 0x21, 0x00])); // FS ! 0
};

const divider = () => {
  if (dividerOff) return;                 // ① 模板 divider 區塊 visible=false → 唔印
  clearMagnify();                         // ② 清殘留（關鍵）
  const size = dividerSize || stickySize || "s";
  setStyle(size, false, false);
  const dashes = size === "s" ? paperCols : Math.ceil(paperCols / 2); // ③ 永遠一行
  push(encodeText("-".repeat(dashes), charset));
  push(Buffer.from([0x0a]));
};
```

順帶補齊兩個同 POS 唔一致嘅位（以前只硬編 `s` + 全 `cols`）：

- `dividerSize` / `dividerOff`：由模板 `divider` 區塊讀（區塊熄咗就唔印線），同 POS 一致；
- `stickySize`：`textLine()` 記錄最後用過嘅 size，舊模板（冇 `divider` 區塊）嘅線「繼承上一行」，
  同 print-relay `buf.currentSize()` 一致；抬頭之後亦照 POS 重置做 `s`。

---

## §4 · 驗收

1. ✅ **Byte 級**：`C:\dev\print-relay\verify-escpos-bytes.mjs` 已加兩組契約檢查，`node verify-escpos-bytes.mjs`
   全部通過（任何一項唔過 → `exit code 1`）：
   - 分格線：`cols=48/32` × `size=s/m/l` 每個情形都見到 `1D 21 00`，而且
     `dash 數 × 放大倍數 = cols`（48/24/24、32/16）→ 永遠只佔一個物理行；
   - `GS_SIZE_BYTE` = `{ s:0x00, m:0x01, l:0x11 }`（nibble 語意，冇用 `ESC !` 嘅 `0x20 / 0x30`）；
   - 原有「相乘地雷」8 個情形全部仍然安全。
2. ⬜ **實紙**：收據模板分格線揀 細 / 中 / 大 各印一次，**每次都只可以有一行線**；
   菜品名下面唔會再多一條。
3. ⬜ **廚房單對照**：同一張單同時印收據 + 廚房單，兩邊每個位置線數一致。
4. ⬜ **預覽對照**：設計頁（`/prints`）嘅分格線行數 / 粗細同實紙一致。
5. ⬜ ⚠️ 改完要**重新 build APK 並裝落機**（`print-relay` / `print hub` / `print-agent-android`；
   桌面版要重新出 `desktop-companion` 安裝檔）；iPad / POS 端要**強制 reload** 先會帶新模板（見 docs/113）。

> ⚠️ **`print hub` 同 `print-agent-android` 嘅 APK 一定要重 build 並裝落機**——
> 代碼改咗但唔重裝 APK，門店行為**完全唔會變**（APK 唔會自己更新）。
> 呢個係本項目反覆中過嘅坑（docs/101、docs/102、docs/103）。

---

## §5 · 待跟進

- ⬜ **確認門店實際跑邊個通道 / 邊個 build**（擰 version 或印測試頁睇行為），
  避免「改咗 print-relay 但門店其實用 desktop-companion」。
  `print hub` 同 `print-relay` 係同名 App（`print-hub`）嘅兩份檢出，兩邊都已修，但**要確認邊份係現役**。
- **預覽 CJK 字寬唔準**：預覽用等寬字型模擬（CJK ≈ 1em、ASCII ≈ 0.6em，比例 1.67），
  實機係 CJK 2 格 / ASCII 1 格（比例 2）→ 中文長句換行位差 ~17%，
  亦係「菜品名字體睇落唔同」嘅次要來源。要精準要換一只 CJK 闊度 = 2× ASCII 嘅等寬字型。
- **`ESC !` × `GS !` 相乘**：長期正解係「GS! 路線下所有行都用 `ESC ! 0x00` + `GS !`」，
  而家 `emitLine()` 已做到呢點（GS! 路線 + CJK 行 `ESC !` 歸零）；剩低嘅係
  **`ESC !` 對純 ASCII 行仍然有用放大 bit**（正確，因為嗰行唔會發 `GS !`）。
- ⚠️ **窄邊界（已知、影響極細）**：舊模板（快照**冇** `divider` 區塊）+ `layout=card` + 2 件菜以上 時，
  結尾嗰條線嘅**粗細**：POS 預覽用 `"s"`，而四個 renderer 用「最後一行嘅 sticky size」。
  只影響粗細（**都係一行，唔會變兩條**），而且 `ensureDividerSection` 會為舊快照補 `divider` 區塊 →
  實際上幾乎唔會觸發。若要 100% 對齊，POS `renderEscPosLines` 條式要同 renderer 夾一次。
