# 80 · 「揀大但出細 + 排版嚴重變形」Root Cause 與三端修正合約

> 現象（用家 2026-08-28）：喺 `/print-center` 模板設計揀「大」字型，出紙**冇跟設定放大**，而且**排版嚴重變形**。
> 關聯：`docs/55`（Android 模板驅動化，checklist 一直 unchecked）、`docs/74`（大字變扁）、
> `docs/75`（SDK 行距驗證）、`docs/60`（設計 == 預覽 == 出紙）、`docs/70`（字體倍大對照）。

---

## §1 · 結論先行（三個獨立 bug，要一齊解）

| # | Bug | 徵狀 | 位置 | 狀態 |
|---|-----|------|------|------|
| **B1** | **模板快照根本冇送去 APK** | 揀「大」出紙冇變大（設定完全無效） | `src/lib/print-bridge/native.ts` | ✅ **本輪已修** |
| **B2** | **`ESC ! n` 與 `GS ! n` 同時發 → 倍率相乘** | 中/英混排放大倍數唔同 → 版面撕裂變形 | APK `EscPosRenderer.kt` | ⚠️ **APK 側要改（§4.2）** |
| **B3** | **行距 `ESC 3 n` 冇跟縱向倍數同步** | 大字上下行重疊「壓扁」 | APK / Companion | APK 1.0.1 已落；Companion 需 repackage |

**B1 係「設定無效」嘅唯一主因**——設定值連 APK 門口都入唔到，所以點揀都一樣。
**B2 係「嚴重變形」最可疑嘅元兇**——見 §4.2，之前一直未有人對過呢條數。

---

## §2 · B1 Root Cause（詳細）

### 2.1 模板係有正確產生嘅

`src/lib/print-jobs.ts` 三個 builder 全部有 attach 快照：

| Builder | 行 | `template` | `content` |
|---------|----|-----------|-----------|
| `buildReceiptPrintJobs` | :60 / :59 | ✅ `buildSnapshot("receipt", …)` | ✅ |
| `buildKitchenPrintJobs` | :99 / :112 | ✅ `buildSnapshot("kitchen", …)` | ✅ |
| `buildLabelPrintJobs` | :156 / :164 | ✅ `buildSnapshot("label", …)` | ✅ |

即係 **localStorage 入面嘅 job 係完整嘅**，字型大小（細/中/大）、粗體、對齊、區塊順序全部喺 `job.template.blocks[]`。

### 2.2 但去到 APK 嗰一跳被丟棄

`dispatchJobToNative()` 冇直接 serialize `PrintJob`，而係**重新砌一個 payload**，舊版只抄咗 10 個欄位：

```ts
// ❌ 舊版（native.ts:46-63）
job: { id, orderNo, tableName, orderId, printerGroup, ticketType,
       printerId, printerName, items, createdAt }   // ← 冇 template / content
```

對比 Companion 通道（`companion.ts:184-201`）係 `JSON.stringify({ job, printer })`，
**成個 job 原封不動送出** → Companion 收到 template → 模板驅動渲染正常。

結果：

```
print-center 設定 ──► localStorage job.template ✅
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
  Companion（完整 job）            native.ts（重新砌 payload）
   有 template ✅                     無 template ❌
   字型大小生效 ✅                  APK fallback 硬編碼渲染
                                     字型大小永遠唔生效 ❌
```

而按 `docs/36`／memory：「完全取代策略——只有 Android 裝置能打印」，
即係**主力（甚至唯一）通道就係呢條冇 template 嘅路**。

### 2.3 已落嘅修正（本輪）

- `native.ts` payload.job 加 `template: job.template ?? null` / `content: job.content ?? null`
- 舊版 APK 認唔到呢兩個欄位會自動忽略 → **向後兼容，零 regression**
- `dispatch.ts` 嘅 dev warning（`:33-41`）日後可以直接睇到邊張 job 冇快照

---

## §3 · B3 Root Cause（行距）—— 已知並已落碼

`ESC ! n` 放大字形，但 `LF` 嘅進紙量由 `ESC 3 n`（單位 1/180"）決定，兩者**互不相干**。
`l` = 2×2 → 字形高約 60/180"，但 `ESC 3` 預設 30 → 下一行疊上半身 → 視覺「壓扁」。

行距公式（經 `docs/75` 廠商 SDK 手冊驗證）：

```
行距 = 縱向放大倍數 × 30
s（1×1）→ 30   m（2闊×1高）→ 30   l（2×2）→ 60
```

Companion `setStyle` 已落 `ESC 3 n`（`docs/74 §8` P1 ✅）；
Android `EscPosRenderer` 已落（`docs/75 §7.2`，APK 1.0.1）。

**但未 repackage / 未 rebuild 就等於未生效**——見 §5 部署。

### 3.1 新增：逐機型行距覆寫（本輪）

`DevicePrinterConfig` 加咗 `lineSpacing?: { s?, m?, l? }`，並隨 native payload 帶過去：

```ts
lineSpacing: opts.printer.lineSpacing ?? null,
```

用途：個別機型實測若仍微微重疊 → `l` 試 64–66；太疏 → 試 50–54（安全 range 30–72）。
**改呢個唔使 rebuild APK**——設喺打印機設定度，下次 flush 即刻帶過去。
（暫未加 UI，避免同「美團式簡單設定」方向衝突；需要時先加。）

---

## §4 · APK 側要做嘅嘢（用家 dev box）

### 4.1 讀 `job.template` 改為模板驅動（解 B1）

`EscPosRenderer.renderReceiptTicket` / `renderKitchenTicket` 加分支（同 Companion `renderEscPos` 一致）：

```kotlin
val snap = job.template
if (snap != null && snap.blocks.isNotEmpty()) {
    val kind = snap.kind            // "receipt" | "kitchen" | "label" ← 權威，唔好用 payload.kind
    val title = when (kind) {
        "receipt" -> "＊＊＊ 收據 ＊＊＊"
        "kitchen" -> "＊＊＊ 廚房 ＊＊＊"
        else      -> ""             // label 唔印抬頭
    }
    if (title.isNotEmpty()) textLine(title, EscPosSize.M, true, Align.CENTER)

    for (b in snap.blocks) {
        if (!b.visible) continue
        if (b.id == "items") {
            divider()
            for ((i, it) in items.withIndex()) {
                textLine("${i + 1}. ${it.name}  x${it.qty}", b.size, b.bold, b.align)
                divider()
                for (s in it.specs) textLine("  $s", b.subSize ?: S, false, b.align)
                if (it.note.isNotBlank()) textLine("  注：${it.note}", b.subSize ?: S, false, b.align)
                textLine("")
            }
            divider()
        } else {
            val text = job.content?.get(b.id) ?: continue
            if (text.isBlank()) continue
            textLine(text, b.size, b.bold, b.align)
        }
    }
    feed(3); cut()
    return
}
// 冇 template → 保留舊硬編碼 fallback，唔好拆
```

Kotlin data class（對應 `src/lib/types.ts`）：

```kotlin
enum class EscPosSize { S, M, L }
enum class EscPosAlign { LEFT, CENTER, RIGHT }
data class EscPosBlockSnapshot(
    val id: String, val visible: Boolean, val size: EscPosSize,
    val bold: Boolean, val align: EscPosAlign,
    val subSize: EscPosSize?, val layout: String?
)
data class EscPosTemplateSnapshot(
    val kind: String, val blocks: List<EscPosBlockSnapshot>
)
// PrintJob 加：val template: EscPosTemplateSnapshot?, val content: Map<String,String>?
```

> ⚠️ 未知欄位要容忍（`template` / `content` / `lineSpacing` 舊版 APK 收到會忽略，
> 呢個係刻意嘅向後兼容設計，唔好因為多咗欄位就 parse fail）。

### 4.2 ⚠️ 關鍵：字型放大指令唔可以同時發 `ESC ! n` + `GS ! n`（解 B2）

**呢條之前一直冇對過，係「嚴重變形」最可疑嘅元兇。**

ESC/POS 放大有兩套機制，作用對象唔同：

| 指令 | 作用對象 | 備註 |
|------|---------|------|
| `ESC ! n`（0x1B 0x21） | **只影響 ASCII / 半形** | bit5=雙闊(0x20)、bit6=雙高(0x40) |
| `FS ! n`（0x1C 0x21） | **只影響 Kanji / 全形中文** | 傳統配 `ESC !` 一齊用，兩者唔相乘 |
| `GS ! n`（0x1D 0x21） | **ASCII + Kanji 一律影響** | 寬高各 1–8×（n 低 3 位=寬、高 3 位=高） |

**地雷**：喺 Epson / Gprinter 系（商頌 POS-80 屬呢個家族），`ESC !` 同 `GS !` 係**相乘**而唔係後者蓋前者。
如果 renderer 為咗「大小」同時發：

```
ESC ! 0x60        （ASCII 雙闊雙高 = 2×2）
GS  ! 0x11        （全部字符 2×2）
→ ASCII 實際變成 4×4，中文只係 2×2
→ 同一行入面「珍珠奶茶 x2」嘅中文正常、數字/英文爆 4 倍
→ 版面撕裂、互相重疊 = 「排版嚴重變形」
```

**正確做法（二選一，視 `printer.kanjiEnlarge`）**：

- `kanjiEnlarge == "FS!"`（標準 ESC/POS 機）：
  發 `ESC ! n`（管 ASCII）**＋** `FS ! n`（管中文）。兩者作用對象唔同，**唔會相乘**。
  - `FS !` 值：0x00 = 1×1、0x04 = 雙闊、0x08 = 雙高、0x0C = 2×2
- `kanjiEnlarge == "GS!"`（商頌 POS-80 呢類）：
  **淨發 `GS ! n`**，唔好再發 `ESC ! n` 嘅放大 bit。
  - `GS !` 值：`n = (h-1)<<4 | (w-1)`，即 1×1=0x00、2闊=0x01、2高=0x10、2×2=0x11

即係：**`ESC !` 與 `GS !` 二選一，`FS !` 只作 `ESC !` 嘅補充。**

> 現有 `SIZE_BYTE = { s: 0x00, m: 0x20, l: 0x60 }`（`docs/55 §2`）係 `ESC !` 嘅值，
> 只有喺 `FS!` 路線先直接用；`GS!` 路線要改用 `GS_SIZE_BYTE = { s: 0x00, m: 0x01, l: 0x11 }`。

### 4.3 行距跟縱向倍數（解 B3）

每次 `textLine` 前按當前 size emit `ESC 3 n`：

```
s → 30   m → 30   l → 60        （若有 printer.lineSpacing 覆寫則優先用）
```

單據完／`reset()` 時要 emit `ESC 3 30` 還原，否則下一張單行距會殘留。

---

## §5 · 部署（source 改完 ≠ 生效）

| 端 | 動作 | 版本號（要主動報） |
|----|------|------------------|
| Web（本 repo） | `next build` + push Vercel（B1 / label kind 修正即生效） | — |
| Companion | `npm run dist` 重新打包 exe（P1 行距修要 repackage） | ⬜ 待報 |
| Android APK | `./gradlew assembleDebug`（§4.1 + §4.2 + §4.3） | ⬜ 待報（前版 1.0.1） |

> 用家規約：每次更新 desktop / APK 要主動報版本號，用嚟分「source 已修」vs「已打包生效」。

### 5.1 驗收步驟

1. Web push 後，Android 開 POS → `/print-center` 揀「大」→ 儲存。
2. 未 rebuild APK 前印一張：**應該仍然係舊樣**（因為 APK 仲未讀 template）——呢個係預期，用嚟確認 B1 唔係 regression。
3. APK rebuild 後再印同一張：**字型大小要跟設定**，且中英文放大倍數一致。
4. 印一張「全 l」測試單：雙高字**唔重疊**即 B3 過。若仍微微重疊 → 設 `lineSpacing.l = 64~66`；太疏 → `50~54`。
5. 標籤機：杯標籤**唔應該**再出現「＊＊＊ 廚房 ＊＊＊」抬頭（本輪 `PrintKind` 加咗 `label`）。

---

## §6 · 本輪已落碼清單（本 repo）

| 檔案 | 改動 |
|------|------|
| `src/lib/print-bridge/native.ts` | payload.job 加 `template` / `content`；payload.printer 加 `lineSpacing` |
| `src/lib/print-bridge/dispatch.ts` | `kind` 改以 `job.template.kind` 為權威（label 機唔再當 kitchen）；native 通道發 legacy `receipt/kitchen` 保舊 APK 兼容；import `PrintKind` / `NativePrintKind` |
| `src/lib/types.ts` | `DevicePrinterConfig.lineSpacing?`；`PrintKind` 加 `"label"` |

驗證：`npx tsc --noEmit` → 只剩已知 `layout.tsx` LayoutProps 誤報（Next build 會生成 `.next/types` 後消失）。
`npx eslint` 兩個改動檔 → 0 error / 0 warning。

---

## §7 · 已知未做（follow-up）

- `printer.lineSpacing` 暫冇 UI（避免同「美團式簡單設定」方向衝突）；要逐機校準時先加。
- `docs/55 §5` checklist：本 repo 嗰項（payload 加 template/content）**本輪已完成**，可剔；其餘 APK 側待用家。
- 標籤「每杯一張」粒度（`docs/79`）尚未開工，同本題獨立。
- Meituan 式簡化打印機設定（IP 只填 IP、USB 自動 detect）另案，唔屬於本題。
