# 44 · 三平台打包可行性評估（Android APK / PC exe / iOS App）

> **日期**：2026-08-23  
> **性質**：可行性評估（**只改文檔，不動代碼**）  
> **背景**：用家想確認三平台「將打印功能一併打包」嘅方案是否可行，並指出潛在問題。本文針對打包方式、所需工具／限制、以及「打印功能」跨平台實作差異給出明確評估。  
> **前置**：承接 doc 41（本地代理：LAN/USB/BT）、doc 43（雙路徑 LAN＋互聯網）。本文假設 POS 網頁（Next.js）為同一套 code，由原生外殼（Terminal Local Agent）承載。

---

## 1. 總評（一句結論）

| 平台 | 打包方式 | 可行性 | 最關鍵限制 |
|------|---------|--------|-----------|
| **Android** | Gradle → APK（WebView＋PosNative） | ✅ **最簡單、最完整**，推薦做主力 | APK 源碼／簽名／權限；碎片化 |
| **PC（Windows）** | Electron／Tauri → exe／msi | ✅ 可行，但運維重 | 代碼簽名（SmartScreen）、USB 驅動、自動更新 |
| **iOS** | Xcode → IPA（WKWebView＋bridge） | ⚠️ 可行但**非全功能** | **USB 完全唔得**、BT 限 BLE/MFi、App Store 審查＋企業分發成本 |

> **核心澄清**：「中間人 bridge」要分兩層——(a) **設備層中間人**（第二部常開 Hub 機）＝應移除；(b) **App 內通訊 bridge**（web↔native 打印）＝三平台都**必須有**，否則網頁打唔到打印機。所以「APK 不依賴中間人」若指 (a) 即正確且最簡；若指 (b) 則不可能（除非由零寫原生 POS，反而最複雜）。

---

## 2. Android：APK 直接打包打印功能

### 2.1 打包方式與工具
- **工具**：Android Studio ＋ Gradle；產出 APK（或上架用 AAB）。
- **結構**：APK ＝ WebView 載入 POS 網頁（遠端 URL 或離線 assets）＋ Kotlin/Java 原生打印層 ＋ `PosNative` JS bridge。打印功能**編譯進 APK**，無需第二部設備。
- **Bridge**：`addJavascriptInterface`（用 `@JavascriptInterface` 限定）或 `evaluateJavascript` 雙向；WebView 係應用內組件，唔係獨立中間人。

### 2.2 打印功能實作（全部可行）
- **LAN `:9100`**：`java.net.Socket` 開 raw TCP 寫 ESC/POS ✅
- **USB**：`UsbManager` ＋ bulk transfer（USB Host API）✅ ——Android 係唯一完整支援 USB 嘅平台
- **Bluetooth**：`BluetoothSocket`（SPP classic）✅ ——支援最廣

### 2.3 潛在問題
1. **現有 APK 係同事 repo**（doc 41 已記 bus factor）：「打包」前要確認源碼在手，或自己起一個新 APK。
2. **權限**：`INTERNET`、`ACCESS_NETWORK_STATE`、`BLUETOOTH_CONNECT`（API 31+）、`USB_PERMISSION`；`AndroidManifest` 要 declare `android.hardware.usb.host`。
3. **碎片化**：熱敏機 ESC/POS 實作参差（切紙、開錢箱、charset），要逐款機測。
4. **分發**：簽名（upload key／Play App Signing）；門店設備用 sideload 或 Managed Google Play／MDM。
5. **誤區**：若「唔要 bridge」係想由零寫原生 POS（唔使 WebView），工作量倍增，並非最簡——web＋bridge 先係最簡。

**評估**：✅ 最簡單且最完整，推薦做第一主力。

---

## 3. PC（Windows）：exe 安裝檔打包所有打印

### 3.1 打包方式與工具
- **Electron**（推薦）：Chromium＋Node 包成單一 app；`electron-builder` 產 exe／msi／nsis。Node 側做打印（LAN `net`、USB `node-usb`／COM、BT），WebView 載 POS——**真正一個 exe 包晒**。
- **Tauri**：Rust 後端＋WebView2，體積細；但 ESC/POS raw transport 要 Rust `serialport`／network crate，現成度低過 Node。
- **唔用 QZ Tray 做「單 exe」**：QZ Tray 係**獨立安裝**嘅 Java/WS applet，要同瀏覽器分開裝，唔符合「一次性打包進 exe」。若堅持單 exe，用 Electron/Tauri。

### 3.2 打印功能實作差異（vs Android）
- **LAN `:9100`**：Node `net` raw socket ✅（同 Android）
- **USB** ⚠️ **唔同**：Windows 平價熱敏機多經**廠商驅動**變 COM 口或 USB 打印類別；你要開 COM 口寫 ESC/POS bytes，或經 OS spooler（但 spooler 係 GDI 打印，唔係 ESC/POS 控制）。即 Windows USB ＝**靠驅動／COM，唔係 Android 嗰種 raw UsbManager**。部分機要 admin 裝驅動。
- **Bluetooth** ⚠️ 有限：Node BT 庫在 Windows 較飄，POS 多走 LAN/USB，BT 少用。

### 3.3 潛在問題
1. **代碼簽名（Authenticode）**：冇簽名會觸 SmartScreen 警告，用戶唔敢裝；要買證書（年費）。
2. **USB 驅動依賴**：要隨包或引導裝廠商驅動，可能要 admin——比 Android USB Host 麻煩。
3. **自動更新**：你而家改網頁 redeploy 就更新；打包成 exe 後要 `electron-updater` 等更新機制（好消息：若 exe 內 WebView 載遠端 POS URL，網頁 UI 仍由 Vercel redeploy 更新，只有 native 層才要 app 更新）。
4. **體積／維運**：Electron ~100–200MB；要自己跟 Chromium 安全補丁。

**評估**：✅ 可行，運維比 Android 重（簽名、驅動、更新），但打印邏輯本身唔難。

---

## 4. iOS：所有功能打包成一個 App

### 4.1 打包方式與工具
- **工具**：Xcode → IPA；分發經 App Store（審查）或企業／MDM（Apple Business Manager ＋ MDM，或 Enterprise Developer Program $299/年）。**冇一般 sideload**。
- **結構**：WKWebView 載 POS ＋ Swift 原生打印層 ＋ `WKScriptMessageHandler` bridge。App 本身＝Terminal Local Agent（iOS 冇 standalone daemon，doc 41 §3.7）。

### 4.2 打印功能實作差異（**硬限制**）
- **LAN `:9100`** ✅：`Network.framework`／`Stream` raw socket
- **USB** ❌ **完全唔得**：iOS 無 USB Host，熱敏機 USB 直接 GG——**「所有功能」必須剔除 USB**
- **Bluetooth** ⚠️ 只 **BLE** 或 **MFi-classic**：CoreBluetooth（BLE）或 External Accessory（MFi）；多數 ESC/POS 機係 SPP classic，要機款支援 BLE 或 MFi 先連到
- **AirPrint** ⚠️ fallback：支援 AirPrint 嘅機可 `UIPrintInteractionController` render PDF 印基本小票（非 ESC/POS，無開錢箱／精確版面）

### 4.3 潛在問題
1. **USB 硬限制**：用 USB-only 熱敏機嘅門店，iOS 唔可以做主力終端（要換 LAN 或 MFi/BLE 機）。
2. **App Store 審查風險**：純 web-wrapper 易觸 guideline 4.2／4.7（thin web view）。要突出 native 價值（打印、離線、設備整合）先過到。
3. **分發成本**：企業內部分發要 ABM＋MDM 或 Enterprise Program，設置與年費。
4. **前景限制**：打印要 app 在前台／活躍，背景打印受限。

**評估**：⚠️ 可行（LAN／BT(MFi/BLE)／AirPrint），但**非全功能**（USB 出局、BT 型號限定），且分發更嚴／更貴。建議最後做。

---

## 5. 「打印功能」跨平台實作差異（重點）

- **共用（一套 code）**：**ESC/POS renderer**（位元組生成）＝統一，平台無關（doc 41 P5）。charset（gb18030/big5/utf-8）在 renderer 處理，輸出＝bytes。
- **各自（per-OS native）**：**transport 層**（bytes 點落到打印機）三平台完全不同：
  - Android（Kotlin）：`Socket`／`UsbManager`／`BluetoothSocket`
  - Windows（Node/Rust）：`net`／`node-usb`或COM/WinUSB／OS BT
  - iOS（Swift）：`Network.framework`／CoreBluetooth·ExternalAccessory
- **結論**：你**唔可以「同一份打印 code」三平台通用**——只有 renderer 共用，設備 I/O 係各自 native。「打包」＝每個平台包各自 native transport ＋ 共用 renderer ＋ POS 網頁。對外，網頁 call **一個** `print(job)` 介面，native 側按 `connectionType` 分派。
- **平台能力差**：USB 只 Android＋Windows 有；BT Android 最廣、Windows 有限、iOS 只 BLE/MFi；LAN 三平台都有。

---

## 6. 共同潛在問題

1. **bridge 誤解**：三平台都**必須**有 in-app bridge（PosNative／localhost HTTP／WKScriptMessageHandler）；只移除設備層 Hub 中間人，唔移除通訊 bridge。
2. **USB 唔跨平台**：iOS 永久唔得；唔好假設「所有打印功能三平台一致」。
3. **簽名／分發**：Android 簽名＋Play/內部；Windows Authenticode＋SmartScreen；iOS App Store 審查＋企業成本。
4. **更新機制**：打包成 native app 後要更新機制；但 POS 網頁若載遠端 URL，UI 仍靠 redeploy，只有 native 層要 app 更新。
5. **權限／驅動**：Android BT Connect 權限（31+）、USB 權限；Windows USB 驅動要 admin 裝。
6. **實機測試**：每平台要逐款熱敏機測（charset、切紙、錢箱）。

---

## 7. 建議落地順序

1. **Android 先做**（已存在 APK，擴 LAN/USB/BT）＝最簡最完整。
2. **Windows 做 Electron exe**（LAN＋USB via 驅動/COM；處理簽名＋更新）。
3. **iOS 最後**（接受 USB 缺口，用 LAN／BT(MFi/BLE)／AirPrint；過 App Store 審查）。

> 本文件純屬可行性評估，尚未改動任何代碼。落實前建議：① 同 APK 同事確認 Android 源碼／簽名權；② 選定 Windows 用 Electron 定 Tauri；③ 評估 iOS 企業分發（ABM＋MDM）成本與門店機款（BLE/MFi 定 LAN）。
