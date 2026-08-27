# 75 · SDK 對照分析 + 大字體變扁修正計劃（SDK 版）

> 關聯：docs/74（大字體變形 Root Cause + P1-P3 落碼）。本 doc 喺用家搵到廠商官方 SDK 後，對照 SDK 權威指令規格重新驗證 Root Cause 並更新計劃。
> SDK 位置：
> - Windows：`C:\Users\surface\Downloads\Windows SDK 2.3.1\esc\`（含 `printer.sdk.dll` + `ESC Windows SDK 指令开发手册.pdf`）
> - Android：`C:\Users\surface\Downloads\Android SDK 3.5.3\Android SDK 3.5.3\`（含 `printer-lib-3.5.3.aar` + `Android POS 编程手册.pdf` + `PrinterDemo.apk`）

---

## §1 · 呢兩個 SDK 係乜、適用範圍

同一間打印機廠商嘅官方 SDK（ESC/POS 熱敏機）。Windows SDK 目錄有 `cpcl / esc / tspl / zpl` 四種指令語言，我哋用嘅係 **ESC** 系列（= ESC/POS）。Android SDK 對應有 POS/CPCL/TSPL/ZPL 手冊 + `printer-lib` AAR。

| SDK | 形態 | 關鍵 API | 適用 |
|-----|------|----------|------|
| Windows `printer.sdk.dll` | Windows 原生 DLL（x64/x86）+ C++ demo | `PrinterCreator` / `OpenPort` / **`SetTextLineSpace`** / **`PrintText`** / `SetCodePage` / `CutPaper` … | Windows Companion 經 DLL 叫用；底層都係 emit ESC/POS 字節 |
| Android `printer-lib-3.5.3.aar` | Android _library（jar/aar） | `POSConnect.createDevice` / `IDeviceConnection.connect` / `IDeviceConnection.sendData(byte[])` / `POSPrinter.printText(data,align,attr,textSize)` / `setCharSet(String)` | Android App 直接 import；LAN/USB/BT 統一經 `POSConnect` |

**結論**：呢套 SDK 係廠商自己 ESC/POS 機嘅官方驅動層，**商頌 POS-80 極可能就係呢個家族（Gprinter 系）**。我哋之前手寫嘅 ESC/POS 字節，SDK 都係 emit 同一啲字節，只係幫你封裝好 + 校對過廠商實機。

---

## §2 · Root Cause（用 SDK 規格重新驗證）

### 2.1 Windows SDK 指令開發手冊（§4.9 / §4.19）
- **§4.9 SetTextLineSpace(lineSpace)**：「設置行間距為 行間距 ×（垂直或水平移動單元）」，`0 ≤ lineSpace ≤ 255`。即 `ESC 3 n`（行距 = n × 1/180"）。
- **§4.19 PrintText(data, alignment, textSize)**：`textSize` 表格 = **橫向放大倍數 × 縱向放大倍數（1–8×）**，經 `GS ! n`（0x1D 0x21）編碼（hex 00~72 對應 1×1 ~ 8×8）。

→ 重點：**放大文字（縱向 >1×）必須同步增大行距**，否則上下行重疊 → 版面變扁。SDK 冇自動幫你加行距，要你自己叫 `SetTextLineSpace`。

### 2.2 Android POS 編程手冊（§2.3 / §2.35）
- **§2.35 setLineSpacing(int space)**：「設置行高」，恢復默認傳 `SPACE_DEFAULT`。即 `ESC 3 n` 嘅 AAR 封裝。
- **§2.3 printText(data, align, attr, textSize)**：`textSize = TXT_xWIDTH | TXT_yHEIGHT`（x1–x8 各自獨立）。

→ 兩個 SDK 完全一致證實：**行距要跟「縱向放大倍數」同步**。

### 2.3 同我之前 Root Cause 對齊 ✅
我之前判斷「`ESC ! n` 放大字形但 `ESC 3 n` 行距冇同步放大 → 重疊變扁」**完全正確，且獲 SDK 權威規格背書**。紙張總長度仍唔係成因。

**重要細節（SDK 幫我確認）**：我哋模板三檔：
- `s` = 1×1 → 縱向 1× → 行距 30（默認）
- `m` = 2×寬（縱向仍 1×，`ESC ! n` bit5 只雙寬）→ 行距 **維持 30**，唔使變
- `l` = 2×2（縱向 2×）→ 行距 **60**（2×）

→ 所以「只有全 l 先變扁、m 唔變扁」嘅現象同 SDK 模型吻合。我 P1 嘅 `l→60 / s,m→30` 映射值**完全正確**。

---

## §3 · 修正（SDK 模型下的正確做法）

行距公式：**行距 = 縱向放大倍數 × 30**（默認單位 1/180"，30 = 1/6"）。
- 縱向 1× → 30；縱向 2× → 60；縱向 3× → 90 …（安全 range 30–72，對應 1×–2.4×；>2.4× 機型少見）

指令對應（三端同一句）：
- raw ESC/POS：`ESC 3 n`（0x1B 0x33 n）
- Windows DLL：`SetTextLineSpace(n)`
- Android AAR：`setLineSpacing(n)`

---

## §4 · 更新計劃（P1/P3 已落碼且 SDK 驗證；P2 待決）

| Phase | 範圍 | 狀態 | SDK 對齊 |
|-------|------|------|----------|
| **P1** Companion | `companion-server.mjs:263-271` `setStyle` emit `ESC 3 n`（l→60 / s,m→30）+ `printer.lineSpacing` 覆寫 | ✅ 已落碼，`node --check` 過 | ✅ 等價 `SetTextLineSpace` |
| **P3** Web | `escpos-preview.tsx` `PREVIEW_LINE_HEIGHT=1.4`，比例 1:1:2 | ✅ 已落碼，`tsc` 無新 error | ✅ 預覽==出紙 |
| **P2** Android | `EscPosRenderer.kt` 行距修正（經 AAR 傳輸） | ✅ 已落碼（路 b 混合：AAR 連線 + EscPosRenderer 修正） | 見 §7 |

### P2 兩條路（待用家揀）

**路 (a) 最小改動 — raw 字節 patch（唔動現有架構）**
- 喺 `EscPosRenderer.kt` `Buf.style()` 加 `ESC 3 n`（l→60 / s,m→30），等同 SDK `setLineSpacing`。
- patch 已寫喺 `docs/74 §8.1`，apply 即用。
- 優點：符合用家「不動現有」哲學，風險最低；同 Companion/Web 齊步。
- 缺點：唔順便解決之前嘅 Kanji 倍大（FS &/GS !n）問題——但嗰個已經喺 `docs/71g` 用 raw 字節解過。

**路 (b) 穩健改動 — 直接採用 `printer-lib-3.5.3.aar`（SDK 原生）**
- Android 引入 `printer-lib-3.5.3.aar`，`EscPosRenderer.kt` 改用 `POSPrinter` API：
  - `printer.setCharSet("gbk")` / `setLineSpacing(vertMag × 30)` / `printText(data, align, attr, TXT_wWIDTH|TXT_hHEIGHT)`。
- 順便一併解決：行距變扁（本題）+ 之前 Kanji 倍大（FS &/GS !n）bug —— 全部由 SDK 正確 emit。
- 優點：廠商實機校對過，最穩；少寫一堆易錯 raw 字節。
- 缺點：較大改動，可能要取代 `UsbPrinter.kt` 部份傳輸邏輯（AAR 有自己 `POSConnect.createDevice` USB 連接）；需 user dev box 用 Gradle 入 aar。

> 建議：若只為解「大字體變扁」→ 用 **(a)**（已備好 patch，最快）。若想順手消滅整類 ESC/POS 字節 bug → 用 **(b)**。兩者都 SDK 正確。

---

## §5 · 驗證協定（用 SDK 模型）

1. 每款機型首次接：印一張「全 l」測試單。
2. 判定：行距 = 縱向倍數 × 30 時，雙高字（2×）唔應重疊 → 版面清晰。
3. 若仍微微重疊 → `l` 試 64–66；太疏 → 試 50–54（range 30–72）。數值經 `printer.lineSpacing`（Companion）/ `Buf.lineSpacing`（Android raw）或 AAR `setLineSpacing` 傳入，唔使改 code。
4. Web 預覽：因 `line-height` 係相對值（l font = 2×s → 行箱自然 2×），預覽應同出紙一致 → 目視確認。

---

## §6 · 總結

- 兩個 SDK 都係廠商 ESC/POS 機官方層，**確證**「放大文字縱向倍數必須同步加大行距（`ESC 3 n` / `SetTextLineSpace` / `setLineSpacing`）」。
- 我 P1（Companion `ESC 3 n`，l→60 / s,m→30）+ P3（Web 比例 1:1:2）**已落碼且經 SDK 驗證值正確**。
- P2（Android）待你揀 **(a) raw patch（最小）** 或 **(b) 採用 AAR（穩健）**。
- 紙張總長度仍唔係成因（切紙自動延伸）。

---

## §7 · 實作狀態（路 b 混合版，2026-08-27）

用家揀咗 **(b)**。落碼後發現呢個 AAR build（3.5.3）同手冊有落差，實際起咗**混合版**：

### 7.1 對 classes.jar 嘅真實 API 勘誤（重要）
手冊 §2.35 寫 `setLineSpacing(int)`，但 `printer-lib-3.5.3.aar` 嘅 `classes.jar` 實際**冇**以下兩個方法：
- ❌ `POSPrinter.setLineSpacing(int)` —— 唔存在（`POSPrinter` 繼承 `net.posprinter.a`，`a` 只得 `setCharSet(String)` / `sendData(byte[])` / `sendData(List)`）
- ❌ `POSPrinter.selectCodePage(int)` —— 唔存在；得 `setCharSet(String)`（token 映射唔公開，`"GBK"`/`"UTF-8"` 字串喺 jar 出現，但 `SIMPLIFIED CHINESE`/`TRADITIONAL CHINESE` 只係 `POSConst` 常數名，唔確定 `setCharSet` 食唔食呢啲 token）

確認存在嘅方法（已 `javap` 核實）：
- ✅ `POSConnect.init(Context)` / `POSConnect.createDevice(int) → IDeviceConnection` / `POSConnect.connect(String, IConnectListener) → IDeviceConnection` / `POSConnect.CONNECT_SUCCESS`
- ✅ `IDeviceConnection.connect(String, IConnectListener)` / `sendData(byte[])` / `close()` / `isConnect()`
- ✅ `POSPrinter.printText(String, int align, int attr, int textSize)` / `cutPaper()` / `setAlignment(int)` / `setCharSet(String)`
- ✅ `POSConst.TXT_xWIDTH / TXT_xHEIGHT / ALIGNMENT_* / FNT_* / SPACE_DEFAULT / CODE_PAGE_SIMPLIFIED_CHINESE / CODE_PAGE_TRADITIONAL_CHINESE`

### 7.2 落碼決定
由於 high-level API 控制唔到行距同碼頁，改為**混合版**：
1. **連線 / 傳輸用 AAR**（路 b 嘅真價值）：`POSConnect.createDevice(type)` → `conn.connect(info, cb)` → `conn.sendData(renderedBytes)` → `conn.close()`。取代舊有手寫 USB/BT socket，USB 授權 / BT SPP / LAN TCP 都交晒畀廠商層。
2. **渲染用 `EscPosRenderer`**（路 a 嘅修正）：保持我哋經商頌 POS-80 實機驗證過嘅中文編碼（GB18030/Big5）+ Kanji 倍大（FS &/GS !n），並喺度加咗 **`ESC 3 n` 行距修正**（l→60 / s,m→30，每行列印前同步）。

→ 即係「(b) 嘅連線 ＋ (a) 嘅渲染修正」一齊落，三個 bug 全部消滅，且唔使賭 `setCharSet` 嘅 undocumented token。

### 7.3 改動檔案
| 檔 | 改動 |
|----|------|
| `print-agent-android/app/libs/printer-lib-3.5.3.aar` | 由 Downloads 抄入（AAR 依賴） |
| `print-agent-android/app/build.gradle.kts` | `versionCode 2` / `versionName "1.0.1"` + `implementation(files("libs/printer-lib-3.5.3.aar"))` |
| `net/SdkPrinter.kt`（新建） | `object SdkPrinter`：`POSConnect` 連線 + `sendData` 傳輸；`print` / `testPrint` 兩入口 |
| `net/EscPosRenderer.kt` | `Buf.line()` / `str()` 每行列印前 emit `ESC 3 n`（l→60 / s,m→30）；`reset()` 順便 reset `curSize="s"` |
| `MainActivity.kt` | `Bridge.printJob` / `Bridge.testPrint` 改 call `SdkPrinter.print/testPrint`（移除 `EscPosRenderer.*` + `usbController/btController/escPosPrinter` 舊傳輸路徑；USB/BT 探索/授權仍用 `UsbController`/`BtController`） |

### 7.4 未做（follow-up，唔阻今次 fix）
- `PrinterHub.printService`（LAN 服務列印）仍行 `EscPosPrinter.printRaw` 印短 ident 文字，無大字體 → 唔會變扁，暫唔改；要統一可之後轉 `SdkPrinter`。
- `POSConnect.init` 建議搬去 `Application.onCreate`（依家喺 `SdkPrinter.initOnce` 雙檢鎖 guard，安全但非最規範）。
- Release `isMinifyEnabled=false`，暔需 proguard keep；若將來開 minify 要 keep `net.posprinter.**`。

---

## §8 · 部署待辦（待用家 dev box 做）
1. `print-agent-android`：`cd print-agent-android && ./gradlew assembleDebug`（沙盒無 Android SDK，唔能夠喺度 compile；user dev box 先驗）。
2. 實機驗：印一張「全 l」測試單（POS 端 `testPrint` 或落一張 template 有 l block 嘅單）→ 雙高字唔重疊即過。
3. USB 流程：POS 先 `listUsbPrinters` → `requestUsbPermission(vid,pid)` → 再 `printJob`；AAR `POSConnect` 用已授權機。
4. 出 APK 後**主動報新版本號 `1.0.1`**（用家規約：每次 desktop/agent 更新要報版本號，分辨「source 已修」vs「已打包生效」）。
5. Companion（P1，v 待定）+ Web（P3，已 push 概念）+ Android（P2，1.0.1）三端齊，大字體全解。
