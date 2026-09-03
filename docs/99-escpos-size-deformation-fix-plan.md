# 99 · Hub 打印格式變形修復方案（對比 + 動手前確認）

> **日期**：2026-09-03
> **性質**：**修復方案已應用 + 已 build 驗證**（2026-09-03 確認後動手；同日 `compileDebugKotlin` 同 `assembleDebug` 均 **BUILD SUCCESSFUL**，APK 出喺 `C:\dev\print-relay\app\build\outputs\apk\debug\app-debug.apk`）。核心改 `EscPosRenderer.kt` 嘅 `Buf` 類，順帶把 `kanjiEnlarge` 從雲端路由配置帶落選機。另加 `verify-escpos-bytes.mjs` 做 byte 級回皈驗證（全 8 情形零相乘）。
> **現象**：打印功能已通，但**只有「細」字型正常，中／大字全部變形**（拉長、重疊、中英放大倍數唔一）。
> **涉及 repo**：`C:\dev\print-relay`（macau-print-hub，Android，要改）、`C:\dev\desktop-companion`（參考實作，唔使改）、`C:\dev\macauPos\macauPosSystem`（docs 參考）
> **配套**：本問題 = `docs/80` 嘅 **B2 bug** 喺 Hub 端重現；Companion 已按 `docs/81 P0-A` 修好，下面係把嗰套權威字節移植去 Hub。

---

## §1 · 根因（同 docs/80 B2 一模一樣）

ESC/POS 有兩套放大指令，作用對象唔同：

| 指令 | 作用對象 | 語意 |
|------|---------|------|
| `ESC ! n`（1B 21） | **淨 ASCII / 半形** | bit 0x20=雙闊、0x10=雙高；`s=0x00 m=0x20 l=0x30` |
| `FS ! n`（1C 21） | **淨 Kanji / 全形中文** | bit 0x04=雙闊、0x08=雙高；`s=0x00 m=0x04 l=0x0C` |
| `GS ! n`（1D 21） | **ASCII + Kanji 一律** | nibble：`n=((h-1)<<4)\|(w-1)`；`s=0x00 m=0x01 l=0x11` |

**地雷（docs/80 §4.2 / companion-server.mjs:249）**：Epson / Gprinter 系（商頌 POS-80 屬呢個家族），`ESC !` 同 `GS !` 係**相乘**而唔係後者蓋前者。renderer 若為咗「放大」同時發 `ESC! 0x30` + `GS! 0x30` → ASCII 實際 4×4、中文 2×2 → 版面撕裂、互相重疊 = 「排版嚴重變形」。

Companion 嘅實機 A/B 測試（`desktop-companion/test-kanji-size.mjs`）已釘死：

```
F-2  GS!0x11 + ESC!0x00 (修正後 CJK 行) → PASS ✅   ← 呢個係正確做法
F-3  GS!0x11 + ESC!0x30 (冇做互斥)     → FAIL ❌   ← 相乘
F-4  GS!0x30 + ESC!0x30 (舊 bug)       → FAIL ❌   ← 0x30 係寫錯（nibble=寬×4）
```

---

## §2 · 當前 Hub（變形）vs Companion（正常）逐行對比

### Hub 而家嘅寫法（`net/EscPosRenderer.kt`）

```kotlin
// line 21-22 —— KANJI 用錯語意（用咗 ESC! 嘅值，唔係 GS!/FS! 嘅值）
private val SIZE_BYTE     = mapOf("s" to 0x00, "m" to 0x20, "l" to 0x30)
private val KANJI_SIZE_BYTE = mapOf("s" to 0x00, "m" to 0x20, "l" to 0x30)  // ❌ 應係 0x01/0x11 或 0x04/0x0C

// line 170-174 —— style() 永遠發 ESC! 放大位，而且唔知呢行係咪 CJK
fun style(size: String, bold: Boolean) = apply {
    curSize = size
    cmd(ESC, 0x21, SIZE_BYTE[size] ?: 0x00)   // ❌ 每次都帶 0x20/0x30 放大位
    cmd(ESC, 0x45, if (bold) 1 else 0)
}

// line 148-155 —— str() 對 CJK 行發 kanjiCmd（= GS 或 FS）但用錯嘅 KANJI_SIZE_BYTE
fun str(s: String) = apply {
    cmd(ESC, 0x33, if (curSize == "l") 60 else 30)
    val cjk = hasCJK(s)
    if (cjk) cmd(FS, 0x26)
    if (cjk) cmd(kanjiCmd, 0x21, KANJI_SIZE_BYTE[curSize] ?: 0x00)  // ❌ GS!0x20 = nibble 寬×1 高×3 → 變形
    out.write(encode(s, cs))
    if (cjk) cmd(FS, 0x2E)
}
```

**點解「只細字正常」**：`s` → `ESC!0x00` + `GS!0x00` = 零放大 → 正常。
- `m`（中）：ASCII `ESC!0x20`（雙闊，拉橫）；CJK `GS!0x20`（nibble：闊 1×、高 3×，拉直）→ 同一行中英各自變形。
- `l`（大）：ASCII `ESC!0x30`（2×2，啱）；CJK `GS!0x30`（nibble：闊 1×、高 4×）→ 中文變 1×4 長條。
→ 除咗 `s` 之外全部變形，同你描述 100% 吻合。

### Companion 正常嘅寫法（`desktop-companion/companion-server.mjs:257-343`，要移植嘅權威版）

```js
const SIZE_BYTE     = { s: 0x00, m: 0x20, l: 0x30 };   // ESC ! （ASCII）
const GS_SIZE_BYTE  = { s: 0x00, m: 0x01, l: 0x11 };   // GS !  nibble
const FS_SIZE_BYTE  = { s: 0x00, m: 0x04, l: 0x0C };   // FS !  （Kanji, 標準 ESC/POS）
const useGs = printer.kanjiEnlarge !== "FS!";          // 缺省 GS!（安全值，商頌實機證實）

const setStyle = (size, bold, isCjkLine) => {
  // GS! 路線 + CJK 行：ESC! 唔帶放大 bit（避免同 GS! 相乘）
  const escByte = (useGs && isCjkLine) ? 0x00 : (SIZE_BYTE[size] || 0x00);
  push([0x1b, 0x21, escByte]);                 // ESC !
  push([0x1b, 0x45, bold ? 1 : 0]);            // ESC E
  push([0x1b, 0x33, size === "l" ? 60 : 30]); // ESC 3 行距跟縱向倍數
};
// textLine 入面：if (cjk) { FS& ; push([...kanjiEnlargePrefix, useGs ? GS_SIZE_BYTE[size] : FS_SIZE_BYTE[size]]); ... FS. }
```

核心差異：**放大指令嘅決定權落去「每行係咪 CJK」身上**，唔係統一發。

---

## §3 · 修復方案（待你確認後動手）

### 3.1 重寫 `EscPosRenderer.kt` 嘅 `Buf` 內部類（唯一要改嘅渲染邏輯）

```kotlin
// ① 加兩個 size 表，移除錯嘅 KANJI_SIZE_BYTE
private val SIZE_BYTE     = mapOf("s" to 0x00, "m" to 0x20, "l" to 0x30)  // ESC ! (ASCII)
private val GS_SIZE_BYTE  = mapOf("s" to 0x00, "m" to 0x01, "l" to 0x11)  // GS !  nibble
private val FS_SIZE_BYTE  = mapOf("s" to 0x00, "m" to 0x04, "l" to 0x0C)  // FS !  (Kanji)

// ② Buf 改為「每行」決定 ESC!/GS!/FS!（同 companion setStyle 對齊）
private class Buf(private val cs: Charset, kanjiEnlarge: String? = null) {
    private val useGs = kanjiEnlarge != "FS!"   // 缺省 GS!（同 companion）
    private var curSize = "s"
    private var curBold = false

    fun style(size: String, bold: Boolean) = apply { curSize = size; curBold = bold }  // 淨記錄，唔發 ESC!
    fun align(a: String) = apply { /* ESC a 照舊 sticky 發 */ }

    private fun emitLine(s: String, withLf: Boolean, inverse: Boolean = false) {
        val cjk = hasCJK(s)
        // ESC ! 字型大小：GS! 路線 + CJK 行唔帶放大 bit（解 B2，避免相乘）
        val escByte = if (useGs && cjk) 0x00 else (SIZE_BYTE[curSize] ?: 0x00)
        cmd(ESC, 0x21, escByte)
        cmd(ESC, 0x45, if (curBold) 1 else 0)
        cmd(ESC, 0x33, if (curSize == "l") 60 else 30)   // 行距跟縱向倍數（docs/74 B3）
        if (cjk) {
            cmd(FS, 0x26)                                 // FS & 入 Kanji mode
            if (useGs) cmd(GS, 0x21, GS_SIZE_BYTE[curSize] ?: 0x00)
            else        cmd(FS, 0x21, FS_SIZE_BYTE[curSize] ?: 0x00)
        }
        if (inverse) cmd(ESC, 0x7B, 0x01)
        out.write(encode(s, cs))
        if (inverse) cmd(ESC, 0x7B, 0x00)
        if (withLf) out.write(LF)
        if (cjk) cmd(FS, 0x2E)
    }
    fun str(s: String) = apply { emitLine(s, false) }     // 死代碼，順手修一致
    fun line(s: String = "", inverse: Boolean = false) = apply { emitLine(s, true, inverse) }
    fun reset() = apply { curSize = "s"; curBold = false; cmd(ESC, 0x45, 0x00); cmd(ESC, 0x61, 0x00) }
    fun resetMagnify() = apply { curSize = "s"; curBold = false; cmd(GS, 0x21, 0x00); cmd(ESC, 0x21, 0x00); cmd(ESC, 0x33, 30) }
}
```

> `str()` 目前全檔無人調用（死代碼），一併改埋確保兩個路徑都啱。
> `resetMagnify()` 已經係 `GS!0x00` + `ESC!0x00` + `ESC3 30`，**唔使改**（qrRaster 用佢清狀態，啱）。

### 3.2（推薦）把 `kanjiEnlarge` 從雲端配置帶落路由選機

上一輪加嘅 `RelayApi.fetchDeviceConfig()` 解析 `RoutingPrinter` 時**冇 map `kanjiEnlarge`**（line 236-244），所以經路由選嘅打印機 `kanjiEnlarge` 永遠 null → 雖然會落到安全嘅 GS! 路線（今次 fix 後正常），但**逐機設定嘅 FS! 機型會失效**。要讓 web POS 嘅 `kanjiEnlarge` 設定對 Hub 生效：

- `relay/RelayState.kt` `RoutingPrinter` 加 `val kanjiEnlarge: String? = null`
- `relay/RelayApi.kt:236` `RoutingPrinter(...)` 加 `kanjiEnlarge = p.optString("kanjiEnlarge").takeIf { it.isNotBlank() }`
- `relay/JobRunner.kt` `resolvePrinter()` 路由分支 `PrinterCfgDto(...)` 加 `kanjiEnlarge = routed.kanjiEnlarge`

> 呢步唔影響「變形修復」本身（冇 map 都會用 GS! 安全路線），但係令路由配置完整，建議一齊做。

---

## §4 · 改動清單

| 檔案 | 動作 | 必要性 |
|------|------|--------|
| `print-relay/.../net/EscPosRenderer.kt` | 重寫 `Buf` 類（§3.1） | **必須**（解變形） |
| `print-relay/.../relay/RelayState.kt` | `RoutingPrinter` 加 `kanjiEnlarge` | 推薦 |
| `print-relay/.../relay/RelayApi.kt` | `fetchDeviceConfig` 解析 `kanjiEnlarge` | 推薦 |
| `print-relay/.../relay/JobRunner.kt` | 路由分支 `PrinterCfgDto` 帶 `kanjiEnlarge` | 推薦 |

**唔使改**：`PrinterCfgDto.fromJson`（line 208 已讀 `kanjiEnlarge`）、`escpos-render.ts`（web 預覽，冇問題）、`desktop-companion`（已正確）。

---

## §5 · 驗證（動手後）

### 5.1 實機最快（推薦，複用 companion 測試思路）
落一張「全 l（大）」嘅收據／廚房單 → Hub 出紙：
- 中文同英文放大倍數**一致**（唔再 4×4 vs 2×2）
- 大字**唔重疊**（行距 l→60）
- 中字係真 2×2（唔係 1×4 長條）

### 5.2 精確 A/B（可選，對照 companion 測試）
Hand 抄 `desktop-companion/test-kanji-size.mjs` 嘅 F-1~F-5 去 Hub 打印機 IP，預期 F-2 PASS、F-3/F-4 FAIL。

### 5.3 行距邊界
若某機型大字微微重疊 → 暫無 `lineSpacing` UI（Hub 嘅 `PrinterCfgDto` 冇呢個 field），先喺 `emitLine` 把 `l` 試 64~66；太疏試 50~54（安全 range 30–72）。要永久生效就要加 `lineSpacing` 欄位 + web 設定 UI（另案）。

### 5.4 部署（已做）
```bash
# 本環境實際有 SDK（C:\Users\surface\AppData\Local\Android\Sdk）+ JDK 21（Android Studio JBR）
# → 已直接 build，唔使用戶本機跑：
cd C:/dev/print-relay && ./gradlew assembleDebug
# 產物：app/build/outputs/apk/debug/app-debug.apk（3.5 MB，可直接 adb install 落真機）
```
Companion 唔使動（已正確），Web 唔使動（預覽冇問題）。
回皈測試用：`node C:/dev/print-relay/verify-escpos-bytes.mjs`（變形復發時先跑，確認 byte 冇相乘）。

---

## §6 · 一句講晒

**Hub 嘅 `Buf` 係「統一發 `ESC!` 放大位 + Kanji 用錯語意值」→ 觸發 docs/80 B2 相乘變形。**
**修法＝把 companion 已驗證嘅「每行按 CJK 決定 ESC!/GS!/FS!、GS! 路線 CJK 行 ESC! 發 0x00」移植去 `Buf`。**
變形只影響「中／大」字（小字 0x00 本來就正常），同你見到嘅現象完全一致。
