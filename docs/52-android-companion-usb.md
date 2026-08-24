# 52 · Android APK USB / 藍牙打印支援開發計劃與實作

> 目標機型：美團（Meituan）Android POS 終端。
> 範圍：喺現有 `print-agent-android` WebView 外殼（載 Vercel POS + 注入 `window.PosNative`）之上，
> 增設 **外接 USB ESC/POS 打印機** 同 **藍牙（SPP）打印機** 嘅原生打印通道。
> 確認日期：2026-08-24。決策：外接多品牌 USB 機（通用 USB Printer Class bulk transfer）、
> 插機 auto-add + 手動揀機並存、open-per-print、USB 同藍牙都做。

---

## 1. 現狀差距分析（USB / BT）

| 關注點 | 現有 | USB / BT 缺咗乜 |
|---|---|---|
| 傳輸層 | `net/EscPosPrinter.kt` 只有 `printRaw(ip, port)` raw socket `:9100` | 無 USB / 無 BT 傳輸 |
| `Bridge.printJob` | 只 branch `ipAddress` / `lanPort`，無 `connectionType` | 無 `usb` / `bluetooth` 分支 |
| `Bridge.testPrint` | 硬編 `printer.ipAddress` | 無 USB / BT 分支 |
| `resolvePrinterFromHub` | hardcode `connectionType="lan"` | fallback 不支援 USB/BT |
| `model/PrintDtos.kt` `PrinterCfgDto` | 有 `usbLabel`，無 `usbVendorId`/`usbProductId` | 已補 `usbVendorId`/`usbProductId`/`bluetoothAddress` |
| `EscPosRenderer` | `renderTestPage` 已識 `conn != "lan"` → 印 "USB: label" | ✅ renderer 已 USB-aware |
| `AndroidManifest.xml` | INTERNET / FG service / POST_NOTIFICATIONS | 缺 `android.hardware.usb.host`、缺 `USB_DEVICE_ATTACHED` filter、缺 BT 權限 |

Web 側已 ready：PC 手動 USB/BT fallback 令 `DevicePrinterConfig` 已帶 `usbVendorId`/`usbProductId`/`bluetoothAddress`，
`native.ts` 嘅 `dispatchJobToNative` 已經將成個 `printer`（含 `connectionType` + VID/PID + address）轉去 `PosNative.printJob`。
所以 web → native 通道已通，只係 native 側要識 branch。

---

## 2. 權限 / Manifest

`app/src/main/AndroidManifest.xml` 新增：

```xml
<!-- 藍牙（Android 12+ 需要 runtime 授權） -->
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<!-- USB Host：外接 ESC/POS（required=false 令唔支援嘅機都裝到 app） -->
<uses-feature android:name="android.hardware.usb.host" android:required="false" />
```

`MainActivity` intent-filter + meta-data（插機彈授權 / auto-add）：

```xml
<intent-filter>
  <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
</intent-filter>
<meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
             android:resource="@xml/device_filter" />
```

新增 `res/xml/device_filter.xml`：匹配 USB Printer Class（`class="7"`）+ 常見 ESC/POS 廠牌 VID
（Epson / Star / Citizen / Bixolon / Seiko / Xprinter / Gprinter / FTDI / Prolific / QinHeng）。

BT runtime 權限：`MainActivity.maybeRequestBtPermissions()` 喺 `onCreate` 對 API 31+ 彈 `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`；
結果經 `onRequestPermissionsResult(REQ_BT_PERMS)` → `callJs("onBtPermissionResult", ...)` 回 web。

---

## 3. USB 偵測 + 連線 + 打印流程

**枚舉**：`UsbManager.getDeviceList()` → filter `deviceClass == USB_CLASS_PRINTER (7)` 或任何 interface `interfaceClass == 7`
→ 建 `UsbPrinterCandidate(vendorId, productId, deviceName, productName, serialNumber, key, brandLabel, hasPermission)`。
`brandLabel` 優先 `productName` → 已知 VID 對照（Epson/Star/Citizen/Bixolon/Seiko/Xprinter…）→ `deviceName` → 兜底 "USB 打印機"。

**授權**：`if (!usbManager.hasPermission(device)) usbManager.requestPermission(device, pi)`；
授權結果經 `UsbManager.ACTION_USB_PERMISSION` 廣播（由 `UsbController` 接收）。

**連線（open-per-print）**：每次打印 `openDevice` → `claimInterface` → 揾 bulk-OUT endpoint
（`type == USB_ENDPOINT_XFER_BULK && direction == USB_DIR_OUT`）→ `bulkTransfer` 寫 ESC/POS byte[]（分 8KB chunk）→ release + close。
唔快取連線，簡單、唔使處理 detach 失效；detach 後設備自然喺 `getDeviceList` 消失，下次打印會報錯俾 POS。

**打印流程**：
1. Web POS `PosNative.printJob({ job, printer:{ connectionType:"usb", usbVendorId, usbProductId, ... }, kind })`
2. `Bridge.printJob` 按 `target.connectionType` 分支 → `UsbPrinter.printBytes(UsbKey(vid,pid), bytes)`
   （bytes 由 `EscPosRenderer` 產，同 LAN 一樣）
3. `bulkTransfer` 喺 `Dispatchers.IO` 跑，結果經 `evalJs(__posNativePrintResult)` 回 web
4. **未授權**：`printBytes` 返 `"USB_PRINTER_NEEDS_PERMISSION"` → bridge 回 `err` → POS 叫 `requestUsbPermission(vid,pid)` 再試

**插機 auto-add**：`UsbController` 監聽 `ACTION_USB_DEVICE_ATTACHED` → 自動 `requestPermission` + `postJs("if(window.onUsbPrinterAttached)onUsbPrinterAttached(...)")`，
Web 刷新 USB 清單（手動 + 自動並存）。

---

## 4. 藍牙偵測 + 連線 + 打印流程

**枚舉 / 探索**：`BluetoothAdapter.getBondedDevices()` 列已配對；`startDiscovery()` + `ACTION_FOUND` 收未配對。
結果經 `onBtPrinterFound(raw)` 回 web（`BtController` 持有 discovery receiver）。

**連線（open-per-print）**：`adapter.getRemoteDevice(address)` → `createRfcommSocketToServiceRecord(SPP_UUID 00001101-0000-1000-8000-00805F9B34FB)`
→ `connect()` → 寫 `outputStream`（分 4KB chunk）→ close。未配對會掟 IOException，錯誤訊息提示先去系統配對。

**打印流程**：同 USB，`Bridge.printJob` 分支 `connectionType=="bluetooth"` → `BtPrinter.printBytes(address, bytes)`；
缺 address 返 `"BT_NEEDS..."` 提示先揀機。

**權限**：API 31+ 需要 `BLUETOOTH_CONNECT`（print）同 `BLUETOOTH_SCAN`（discovery）runtime 授權，
由 `maybeRequestBtPermissions()` 處理；探索前會先確認 `hasScanPermission()`，無就 `onBtPermissionNeeded()`。

---

## 5. 模組設計

### 新增檔案
- `net/UsbKey.kt` — `data class UsbKey(vendorId, productId, serial?)` + `stableKey()` / `parse()`
- `model/UsbPrinterCandidate.kt` — 枚舉 DTO + `VENDOR_NAMES` 已知廠牌對照 + `toJson()`
- `net/UsbPrinter.kt` — `UsbManager` 封裝：`enumerate()` / `requestPermission()` / `hasPermission()` / `printBytes()`（open-per-print bulk transfer）
- `usb/UsbController.kt` — 擁有 `UsbPrinter` + 監聽 `ACTION_USB_PERMISSION` / `ATTACHED` / `DETACHED` + 經 `postJs` 回 web（`onUsbPrinterAttached` / `onUsbPrinterDetached` / `onUsbPermissionResult`）
- `model/BtPrinterCandidate.kt` — `data class BtPrinterCandidate(address, name, bonded)` + `toJson()`
- `net/BtPrinter.kt` — `BluetoothManager/Adapter` 封裝：`isSupported()` / `hasConnectPermission()` / `enumerateBonded()` / `printBytes()`（SPP socket）
- `bt/BtController.kt` — discovery receiver（`ACTION_FOUND` / `ACTION_DISCOVERY_FINISHED`）+ `startDiscovery()` / `stopDiscovery()` + 經 `postJs` 回 web（`onBtPrinterFound` / `onBtDiscoveryFinished`）

### 修改檔案
- `model/PrintDtos.kt` — `PrinterCfgDto` 加 `usbVendorId: Int = 0` / `usbProductId: Int = 0` / `bluetoothAddress: String?`，`fromJson` 讀取（VID/PID default 0，address 兼容 `bluetoothName`）
- `MainActivity.kt` — `onCreate` 初始化 `UsbController` / `BtController` + `register()` + `maybeRequestBtPermissions()`；`onDestroy` `unregister()`；
  `Bridge.printJob` / `testPrint` 加 `usb` / `bluetooth` 分支；新增 JS method：`listUsbPrinters` / `requestUsbPermission(vid,pid)` / `listBtPrinters` / `scanBtPrinters` / `stopBtScan` / `requestBtPermission`；`resolvePrinterFromHub` 維持 LAN（USB/BT 經 POS payload）；`callJs()` 安全呼叫 web 全局函數
- `AndroidManifest.xml` — 見 §2
- `res/xml/device_filter.xml` — 見 §2

### Web 側 hooks（task #29）
- `lib/print-bridge/native.ts` 加 `listNativeUsbPrinters()` / `requestNativeUsbPermission()` / `listNativeBtPrinters()` / `scanNativeBtPrinters()` / `requestNativeBtPermission()`，包裝 `PosNative` 對應 method
- `components/printer-companion-panel.tsx` — `AddPrinterWizard` 當 `isNativeBridgeAvailable()` 時，USB 掃描 / 手動 USB / 手動 BT / 「+ 藍牙打印機」改走 native 發現；`useEffect` 接收 `onBtPrinterFound` / `onUsbPrinterAttached`；`submit()` 寫 `base.bluetoothAddress`

---

## 6. 美團機注意事項 / 風險

- **內置打印機**：好多美團 / Sunmi 終端嘅內置熱敏機 **唔經 USB Host**（唔會出現喺 `getDeviceList`），要 vendor SDK（AIDL）先用到。
  本計劃嘅 generic USB Host 只 cover **外接** USB ESC/POS 機（加廚房 / 加 Bathroom 機嘅常見場景）。內置機 vendor SDK 留待 P6 另議。
- **USB Host 可用性**：標準 Android 有 `UsbManager`；`MainActivity` 用 `hasUsbHostFeature()` 運行期探測，無就提示「此設備不支援 USB 打印機」並 fallback LAN。
- **授權 UX**：首次 USB 打印彈系統對話框；deny → 優雅返錯 + POS 可 retry。
- **Doze / 電池**：單次 `bulkTransfer` 亞秒級，on-demand 打印唔使 FGS；若以後要背景緩存連線，再搬入 `PrintHubService` + `connectedDevice` FGS type。
- **VID/PID 穩定性**：用 `vid:pid`（+serial 如有）做穩定 key；部份平價機報 `0x0000/0x0000` → fallback `deviceName`+serial。

---

## 7. Build & Test（必須喺用家 dev box）

沙盒無 Android SDK，APK build 要喺有 Android SDK 嘅機跑（同 Windows exe 一樣）：

```bash
cd print-agent-android
./gradlew assembleDebug      # 需要 local.properties 嘅 sdk.dir
# 真機測試（Android emulator 唔支援 USB Host）：
#   插 USB ESC/POS 機 → PosNative.listUsbPrinters() 返到 → PosNative.printJob({connectionType:"usb",...}) 出單
#   藍牙：系統先配對 → listBtPrinters() / scanBtPrinters() → printJob({connectionType:"bluetooth",...})
```

Release 簽名要 keystore（`assembleRelease`）。

---

## 8. 實作順序（已確認後執行）

- P0 Manifest + `device_filter.xml` + USB host feature + 運行期能力探測
- P1 `UsbKey` + `UsbPrinter`（枚舉 / open / bulkTransfer / chunk）+ `UsbPrinterCandidate`
- P2 `PrintDtos.kt` 加 VID/PID/address；`Bridge.printJob` / `testPrint` USB 分支；`resolvePrinterFromHub` 維持 LAN
- P3 `UsbController` + 授權 / attach / detach 廣播 receiver
- P4 暴露 `PosNative.listUsbPrinters()` / `requestUsbPermission()`；web 打印面板揀 USB 機（web 已帶 VID/PID，只差揀機 UI）
- P5 dev box build + 真機美團測試
- P6（可選）內置機 vendor SDK 路徑

---

## 9. 已確認決策（用家答問）

1. **目標** = 外接 USB ESC/POS（多品牌，揀常見廠牌做 VID 對照）
2. **加機方式** = auto-add（插機 auto-add）+ 手動揀機 並存
3. **連線策略** = open-per-print
4. **通道** = USB + 藍牙 都做
