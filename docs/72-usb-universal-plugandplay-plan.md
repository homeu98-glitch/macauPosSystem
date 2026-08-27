# 72 · 通用即插即用 USB 打印方案（Meituan 式「接上就用、唔使裝 driver」）

> 日期：2026-08-27
> 範圍：3 repo 共用 — `desktop-companion`（Windows/macOS/Linux Electron）、`print-agent-android`（USB Host）、`macauPosSystem` web（device-settings UI + printer-models.ts）
> 狀態：**方案（分析 + 計劃，先出 plan，confirm 先落碼）**
> 目標：令商家「插 USB 就印」，唔使裝第三方 driver、唔使手填 VID/PID；必要時頂多喺 UI 揀機型 refine。

---

## 1. 先拆穿「唔使裝 driver」嘅技術含義

「即插即用 / 唔使裝 driver」唔係魔法，而係 **打印機點樣向 OS 暴露自己** 決定嘅。熱敏 ESC/POS 機接 USB 通常有 3 種姿態：

| 姿態 | OS 點處理 | 我哋點打 | 算唔算 driverless |
|---|---|---|---|
| **A. USB Printer Class（interface class = 0x07）** | Windows `usbprint.sys` / macOS `usblp` / Linux `usblp` —— **OS 內建 inbox driver**，無第三方 code | 經 OS 打印後台 RAW 直通寫 ESC/POS byte[] | ✅ 真·driverless |
| **B. Vendor bulk interface + WinUSB** | Windows 靠 **Microsoft OS Descriptor** 自動 load `WinUSB`（Win8+ inbox）；macOS/Linux libusb 直接 claim | libusb / node-usb / Android USB Host 直接 bulkTransfer | ✅ driverless（靠 OS Descriptor，無第三方 driver） |
| **C. Vendor COM port（CH34x / FTDI / CP210x）** | 要裝對應 **serial driver**（CH341 等）先出 COMx | `serialport` 打 COMx | ❌ 必須 user 裝一次 driver |

> **關鍵前提（決定成敗）**：「唔使裝 driver」只對 A / B 成立。若部機純 C（好似好多平價國產機附嘅「USB 驅動」其實係 CH34x），咁無論美團定我哋都**解唔到真正 driverless**，頂多係「幫 user 自動裝 / 預載 driver」。
> 用家嘅 **商頌 POS-80** 個 Downloads 有 `S1820 USB驱动` 文件夾 → 高機率係 CH34x（C 姿態）。但多數國產 ESC/POS 機**同時**暴露 A（USB Printer Class）+ C（COM），所以要探測描述符確認有冇 A。有 A 就行 A/B driverless；純 C 就 fallback 到 serialport（user 裝一次 CH34x）。

**Meituan 嘅真實做法推測（回應用家兩個假設）：**
- 假設一「用通用協議」→ **中**。ESC/POS 本身就係事實標準協議（大多數機 90% 指令相同），佢哋唔係發明協議，而係**統一經 USB Printer Class / WinUSB bulk 打 ESC/POS**。
- 假設二「封裝晒所有 driver」→ **基本唔係**。封裝晒 driver 會好肥又脆；佢哋係靠 **OS inbox driver（A）+ WinUSB（B）+ 龐大機型 profile DB**（處理細微指令差異）。「揀機型」本質就係揀 **command profile**，唔係揀 driver。
- 結論：Meituan = **通用 ESC/POS 協議 + OS 內建驅動通道 + 按 VID/PID 自動配對機型 profile**。我哋可以用相同思路達到近似「接上就用」。

---

## 2. 我哋而家嘅底子（已經有，唔使由零起）

> ⚠️ **現狀核對（2026-08-27 實際 check 過 repo）**：下面分「已實作」同「只係計劃」。

- **web `macauPosSystem`（本 repo，已實作）**：
  - `components/device-settings.tsx`：`connectionType` 下拉已有 `lan / usb / bluetooth`；usb 顯示 VID/PID 欄；`charset` 下拉（約 909-976 行）。
  - `src/lib/print-bridge/printer-models.ts`：`USB_PRINTER_DB`（VID→brand/model/charset/paperSize）+ `resolveUsbMeta()` + `KNOWN_USB_PRINTER_VIDS` —— **Meituan 式 VID/PID 自動配對雛形已有**。
  - `src/lib/print-bridge/native.ts`：`isNativeBridgeAvailable` / `dispatchJobToNative` / `listNativeUsbPrinters` 已有；`src/lib/print-bridge/companion.ts` 已 expect Companion 後端 `/api/usb` 枚舉（node-usb）。
- **Android `print-agent-android`（本 repo，**目前無 USB 實作代碼**）**：
  - doc 52 規劃嘅 `net/UsbPrinter.kt` / `usb/UsbController.kt`（枚舉 `USB_CLASS_PRINTER(7)` → requestPermission → openDevice → claim → bulkTransfer）**只係計劃，未落碼**（目錄目前無 Kotlin 實作）。要達到「接上就用」必須喺呢層實作 —— 呢正係 Android USB Host 嘅 driverless 通道。
- **Desktop Companion（`desktop-companion` repo，非本 checkout）**：
  - 按 docs 47-52 應有 node-usb 枚舉 + `printUsb()` bulkTransfer（B 通道）；本 repo 嘅 `print-relay/server.mjs` 只係雲端 WebSocket relay，**並非 USB 打印驅動**，唔好混淆。Companion 實際代碼需喺該 repo 確認。

**所以真正缺嘅係三件事：**
1. **Android USB 實作**：`print-agent-android` 未落碼，要按 doc 52 寫 Kotlin USB Host（Android 端 driverless 核心）。
2. **Windows Driverless transport 唔穩（Companion 側）**：若 Companion 現時淨係 B 通道（libusb claim + detach），A 姿態機（usbprint.sys 搶 interface）detach 會 flaky，CH34x（C）機 B 通道 claim 唔到。要加 **A 通道（spooler RAW 直通，優先）** + **C fallback（serialport）**。
3. **Model profile 太薄**：而家 DB 得 charset/paperSize，處理唔到「中文倍大用 FS! 定 GS!」「切紙指令」「錢箱」「點陣/位圖」等差異 —— 呢啲正正係「揀機型」要解決嘅（商頌 POS-80 中文倍大要 GS! 而唔係 FS!，呢個就係 profile 差異，來源見 §11 / 相關測試）。

---

## 3. 可採取嘅做法（分析）

### 做法 A — OS USB Printer Class + 打印後台 RAW 直通（推薦，最 universal）
- Companion 經 OS 內建 class driver，將 ESC/POS byte[] 當 **RAW datatype** 寫入 spooler：
  - Windows：`node-printer`（`printer` npm，底層 `WritePrinter` spooler API）／ 或 `print /D:USB001 file.bin` ／ 或 PowerShell `Out-Printer -Raw`。
  - macOS / Linux：`lp -o raw` 對 `usblp` 設備。
- **優點**：真正 driverless；任何暴露 A 姿態嘅機即插即用；唔使 claim interface、唔使 detach driver、唔使煩 WinUSB。
- **缺點**：依賴 OS 打印後台服務（Windows Print Spooler）開咗；純 C 姿態機（無 A interface）唔行。

### 做法 B — libusb / node-usb 直打 vendor bulk（我哋而家嘅，保留做 fallback）
- 已經有 `printUsb()`。要喺 Windows driverless，就要確保該 interface 綁咗 **WinUSB**（靠機嘅 Microsoft OS Descriptor 自動，或 ship 一個通用 `WinUSB` INF 指去該 VID/PID）。
- **優點**：繞過 spooler，完全控制時序；Android 同上（USB Host bulkTransfer）。
- **缺點**：Windows 上若 A 姿態畀 usbprint.sys 搶咗要 detach（我哋 code 已做）；純 C（CH34x）機 claim 唔到 → 要 C fallback。

### 做法 C — WebUSB（瀏覽器原生，零安裝）
- 網頁 `navigator.usb.requestDevice()` 直接打。但 **Windows 上 A 姿態畀 usbprint.sys claim → WebUSB 冇法 claim**（安全限制）；要 B 姿態 + WinUSB 先得。Android Chrome WebUSB 亦有限。
- **結論**：WebUSB 唔係 Windows USB-class 機嘅 universal 答案；適合特定 vendor-bulk 機型。我哋而家 web 行 Companion 代理，唔使靠 WebUSB，反而更穩。

### 做法 D — 預載 / 自動裝 CH34x driver（只為 C 姿態機）
- 若確認目標機純 C（如商頌 POS-80 只出 COM），唯一「接上就用」係將 CH341 driver **打包入 installer** 或首次接機時靜默裝。呢點先係「封裝 driver」嘅真正場景，但只覆蓋 C 機，唔係 universal。
- **優點**：覆蓋最平價國產機。
- **缺點**：installer 變大、要簽名、要 admin 權限；唔算純 driverless。

---

## 4. 推薦方案：雙層架構（Transport 層 universal + Model Profile 層）

### 4.1 Transport 層：三通道自動選，driverless 優先
接機後 Companion / Android 按以下優先序自動選通道（唔使 user 知技術細節）：

1. **A 通道（USB Printer Class + spooler RAW）** —— 優先，真 driverless（Windows/macOS/Linux）。
2. **B 通道（vendor bulk + libusb/WinUSB）** —— A 唔到就用（多數機靠 OS Descriptor 自動 WinUSB，仍 driverless）。
3. **C 通道（vendor COM + serialport）** —— 得純 CH34x 機先到呢層，**呢層 user 要裝一次 CH34x driver**（或我哋 installer 預載）。
4. **LAN / 藍牙** —— 已有，照舊。

> 用家體感：A/B 機「插上就印」；C 機「插上 → 彈咗話要裝 CH34x → 裝一次 → 之後即插即用」。呢個已經等同美團體驗（美團都係針對有 A/B 嘅機做到零 driver）。

### 4.2 Model Profile 層（「揀機型」嘅本質）
擴充而家 `USB_PRINTER_DB` → `PrinterModelProfile`：
```ts
interface PrinterModelProfile {
  vid: string; pid?: string;          // pid 空缺 = 該品牌通用 profile
  brand: string; model: string;
  charset: "gb18030"|"gbk"|"big5"|"utf-8";
  paperSize: "58mm"|"80mm"|"100x75mm";
  kanjiEnlarge: "FS!" | "GS!";        // ← §11 學到：商頌 POS-80 要 GS!，標準機要 FS!
  cut: "GSV" | "ESCi" | "none";       // 切紙指令方言
  drawer: "ESCp" | "none";            // 錢箱踢
  image: "raster" | "bitimage";       // 位圖列印方式
  init?: number[];                    // 可選初始化序列
}
```
- **自動配對**：插機 → 讀 VID/PID → 命中 profile → 自動套 charset/kanjiEnlarge/cut…；**未命中 → 用 generic ESC/POS profile**（涵蓋 90% 指令：ESC@ / ESC a / ESC ! / GS ! / GS V / FS & / GS( L 位圖）確保基本能印，再俾 user 喺 UI 手揀機型 refine。
- 呢層我哋已經有雛形（USB_PRINTER_DB），重點係**補 kanjiEnlarge / cut / drawer / image 三個差異維度**，令「揀機型」真係解決指令方言，而唔係得 charset。

### 4.3 三端落點（沿用而家 code，增量擴）
- **Companion**：`enumerateUsbPrinters` 已 VID/PID 自動偵測 → 加 **A 通道 spooler RAW**（新增 `printUsbClass()`）排 `printUsb()` 之前；profile 擴充後傳入 renderer。
- **Android**：`print-agent-android` 目前無實作 → 先按 doc 52 落 `UsbPrinter.kt`（枚舉 `USB_CLASS_PRINTER(7)` → requestPermission → openDevice → claim → bulkTransfer，即 A 姿態 driverless），再接 `PrinterModelProfile`（kanjiEnlarge 等）注入 `EscPosRenderer`；權限彈窗流程隨 doc 52 一齊做。
- **web**：`device-settings.tsx` usb 區加「機型」下拉（載 profile DB，自動由 VID/PID 預選）；未命中顯示「未收錄 → 用通用 ESC/POS / 手揀」。

---

## 5. 所需條件 / 前置

1. **（必做 P1）描述符探測**：確認目標機（商頌 POS-80）係 A / B / C 邊種。做法：用家 Device Manager 睇「USB Printing Support」定「USB-SERIAL CH340 (COMx)」；或跑我出咗嘅 `tools/usb-printer-probe.mjs`（**零依賴 Windows 模式**：PowerShell `Get-PnpDevice` 直接睇 FriendlyName；可選 `--libusb` 模式列舉 vid/pid + 每個 interface 嘅 `bInterfaceClass`）。→ 決定行 A 定 B 定要 C fallback。
2. **Companion rebuild（Electron）**：加 spooler RAW 通道（A）；可揀加 `node-printer` 原生模組（多一個 build 依賴）或純 shell `print /D:` / `lp -o raw`（零新增依賴，推薦先用 shell 試）。
3. **Windows 簽名**：若 B 通道要 ship 通用 WinUSB INF → 要 code signing；若靠機嘅 Microsoft OS Descriptor 自動 WinUSB → 唔使 INF、唔使簽名。
4. **Android**：USB 權限彈窗 + profile 注入；已經差唔多，缺嘅係 profile 擴充。
5. **web**：`printer-models.ts` 與 Companion DB 同步擴充；device-settings UI 加機型下拉。

---

## 6. 實施階段（建議，confirm 先落碼）

- **P1 描述符探測（決策用）**：出 `usb-printer-probe.mjs` 或用家 Device Manager 截圖 → 定 A/B/C 路徑。先呢步，因為佢決定後面通道優先序。
- **P2 Model Profile 擴充**：`USB_PRINTER_DB` → `PrinterModelProfile`（加 kanjiEnlarge/cut/drawer/image）；三端共用同一份（Companion 內聯 + web printer-models.ts 鏡像）；補 商頌 POS-80 條目（`kanjiEnlarge:"GS!"`，嚟自 §11）。
- **P3 Companion Transport**：加 `printUsbClass()`（A 通道 spooler RAW，Windows `print /D:USB00x` / macOS·Linux `lp -o raw`）→ 排 `printUsb()`（B）之前；C 通道靠而家 serialport（已有）。分派邏輯：A 成功就用 A，失敗 fallback B，再失敗 fallback C。
- **P4 Android 實作 + Profile**：按 doc 52 先落 `UsbPrinter.kt`（目前空目錄未做）做到 attach 即列舉 + 權限彈窗順，再接 `PrinterModelProfile` 注入 renderer（kanjiEnlarge 等）。
- **P5 web UI**：device-settings usb 區加機型下拉（自動預選 + 手動 override）；未收錄顯示通用 ESC/POS 提示。
- **P6 回歸**：商頌 POS-80（A 或 C）+ 另一部機（Epson/Xprinter 做 A/B）× 各通道，確認「插上就印」+ 中文倍大正確（GS!）。

---

## 7. 關鍵風險

- **CH34x 純 C 機**：無 A/B → 必須 user 裝一次 CH34x（或 installer 預載）。呢點美團都解唔到真正 driverless；我哋做到「裝一次之後即插即用」已經係極限。
- **Windows Print Spooler 停用**：A 通道失敗 → 自動 fallback B（libusb）。兩者都唔到先到 C。
- **Windows A 姿態 detach 衝突**：若用 A 通道就唔使 detach（spooler  own 個 interface）；只有 B 通道先 detach。兩通道互斥揀，避免搶 interface。
- **WebUSB 唔係 Windows USB-class 答案**：我哋 web 經 Companion 代理唔靠 WebUSB，反而避咗呢個坑。

---

## 8. 一句總結畀用家

「唔使裝 driver」嘅秘密 = **ESC/POS 係通用協議 + OS 內建 USB 打印驅動（A/B 通道）+ 按 VID/PID 自動配對機型 profile**；我哋已經有 auto-detect 骨架同 B 通道，補 **A 通道（spooler RAW）** 同 **機型 profile 擴充（kanjiEnlarge/cut/drawer/image）** 就做到美團式「接上就用」。純 CH34x 機例外，要裝一次 driver。

### 下一步
- 用家跑 **P1 描述符探測**（Device Manager 截圖 / 我出 `usb-printer-probe.mjs`）→ 我按結果定 A/B/C 優先序，再落 P2–P6。

---

## 9. P1 結果（2026-08-27 用家確認）

- **商頌 POS-80 插 Windows USB → 喺「通用序列匯流排控制器」下顯示為「Printer POS-80」** → 確認係 **USB Printer Class（interface class = 0x07）** 設備。Windows 經 inbox `usbprint.sys` 自動認到（**真·driverless，A 姿態**），會建立虛擬埠（通常 `USB001`）。唔使裝 CH34x COM driver。
- **平台**：用家確認 **Windows Companion + Android 兩者都要**。
- **推導（修正優先序）**：
  - **Android 已基本完成 USB driverless**：`UsbPrinter.kt` 已經枚舉 `USB_CLASS_PRINTER(7)` → `bulkTransfer` 直打（Android 無 spooler，行 libusb 式 bulk，本身 driverless）。Android 剩嘅係 **P4 接 `PrinterModelProfile`**（kanjiEnlarge 等）注入 renderer。
  - **Windows Companion 係主要新做嘅位**：而家得 B 通道（libusb claim + detach），要**加 A 通道 `printUsbClass()`（spooler RAW 直通，優先）**。做法：`print /D:USB001 file.bin`（Windows）／ `lp -o raw`（macOS·Linux）。A 成功用 A；A 失敗（spooler 停用 / 無 class 設備）才 fallback B（libusb）。
  - 純 C（CH34x）機：今次目標機唔屬此類，但保留 serialport fallback 俾其他平價機。
- **結論**：A 姿態 + 兩平台 → 落 P2（profile 擴充，含商頌 POS-80 `kanjiEnlarge:"GS!"`）→ P3（Companion A 通道）→ P4（Android profile）→ P5（web 機型下拉）→ P6 回歸（商頌 POS-80 + 另一部機）。
