# 114 · 收據「分隔線變兩條 + 菜品名字體異常」根因與修法（2026-09-10）

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

### 3.3 print-relay APK（正式出紙通道）— ⬜ 待改

`app/src/main/java/com/macau/printhub/net/EscPosRenderer.kt`

```kotlin
// Buf 內新增：只清放大，不動行距
fun clearMagnify() = apply {
    cmd(GS, 0x21, 0x00)
    cmd(ESC, 0x21, 0x00)
    cmd(FS, 0x21, 0x00)
}

// rule() 改為：
fun rule() {
    if (dividerOff) return
    buf.clearMagnify()                                  // ① 清殘留（關鍵）
    val size = fixedDividerSize ?: buf.currentSize()     // ② 舊模板：沿用「繼承」語義
    val dashes = if (size == "s") cols else (cols + 1) / 2  // ③ 永遠一行
    buf.style(size, false)
    buf.line("-".repeat(dashes))
}
```

同時 `renderKitchenTicket()` / `renderReceiptTicket()` 嘅 `separator(width, cs)`
（`"-".repeat(width)`）亦要喺前面 `buf.clearMagnify()`。

### 3.4 print hub（舊副本）/ print-agent-android — ⬜ 待改

同 §3.3 一樣嘅三點；print hub 若仍係 docs/99 之前嘅版本（`style()` 每次帶 `ESC !` 放大位 +
`KANJI_SIZE_BYTE` 用咗 `ESC !` 嘅值），**必須先套 docs/99**，否則菜品名會 2×3 變形（「字體異常」嘅元兇之一）。

### 3.5 desktop-companion — ⬜ 待改

`companion-server.mjs`：

```js
const divider = () => {
  setAlign("center");
  push(Buffer.from([0x1d, 0x21, 0x00]));   // GS ! 0  ← 清中文放大殘留（關鍵）
  push(Buffer.from([0x1b, 0x21, 0x00]));   // ESC ! 0
  push(Buffer.from([0x1c, 0x21, 0x00]));   // FS ! 0
  const size = dividerSize || "s";
  setStyle(size, false, false);
  const dashes = size === "s" ? paperCols : Math.ceil(paperCols / 2);
  push(encodeText("-".repeat(dashes), charset));
  push(Buffer.from([0x0a]));
};
```

---

## §4 · 驗收

1. **Byte 級**：`C:\dev\print-relay\verify-escpos-bytes.mjs` 加案例——
   分隔線前**必須**見到 `1D 21 00`；揀「中」時 dash 數量 = `cols/2`。
2. **實紙**：收據模板分格線揀 細 / 中 / 大 各印一次，**每次都只可以有一行線**；
   菜品名下面唔會再多一條。
3. **廚房單對照**：同一張單同時印收據 + 廚房單，兩邊每個位置線數一致。
4. **預覽對照**：設計頁（`/prints`）嘅分格線行數 / 粗細同實紙一致。
5. ⚠️ 改完要**重新 build APK 並裝落機**；iPad / POS 端要**強制 reload** 先會帶新模板（見 docs/113）。

---

## §5 · 待跟進

- **預覽 CJK 字寬唔準**：預覽用等寬字型模擬（CJK ≈ 1em、ASCII ≈ 0.6em，比例 1.67），
  實機係 CJK 2 格 / ASCII 1 格（比例 2）→ 中文長句換行位差 ~17%，
  亦係「菜品名字體睇落唔同」嘅次要來源。要精準要換一只 CJK 闊度 = 2× ASCII 嘅等寬字型。
- **`ESC !` × `GS !` 相乘**：長期正解係「GS! 路線下所有行都用 `ESC ! 0x00` + `GS !`」，
  而家只係喺分隔線前清狀態（最小改動、零回歸）。
- 確認門店實際跑邊個通道 / 邊個 build（擰 version 或印測試頁睇行為），
  避免「改咗 print-relay 但門店其實用 desktop-companion」。
