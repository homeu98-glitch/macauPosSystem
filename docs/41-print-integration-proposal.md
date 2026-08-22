# 41 · 整合性離線打印方案（WiFi / LAN / USB）調查與提案

> **日期**：2026-08-22  
> **性質**：調查 + 提案（**只改文檔，不動代碼**）  
> **背景**：現時打印全採「LAN 線下」方案（Native APK bridge + Printer Hub HTTP fallback），用家回報問題較多，要求調查並比較可連接**線下 WiFi / LAN / USB** 打印機嘅替代方案，提出一個整合性方案。

---

## 1. 核心約束（為何打印係難題）

Web POS 跑喺瀏覽器／WebView，而瀏覽器**天生唔可以直接**：

- 開 raw TCP socket 去打印機 `IP:9100`（ESC/POS 標準端口）；
- 直接攞 USB 熱敏打印機設備（WebUSB 例外，見 §3.3，但限制極大）。

即係話，**網頁 JS 永遠需要一個「本地代理」幫佢把 job 送到物理打印機**。所有方案嘅本質差異，只係「呢個代理喺邊、點樣同網頁溝通、支援咩物理傳輸」。

呢點解釋咗點解而家一定有「Native bridge」或「Hub HTTP」兩條路——佢哋都係本地代理，只係形式唔同。

---

## 2. 現狀方案（已落地，doc 36/37）回顧

| 路徑 | 做法 | 優點 | 問題 |
|------|------|------|------|
| **A · Native Print Agent APK**（主力） | POS 喺 Android WebView 外殼跑，`window.PosNative.printJob(json)` → Kotlin → raw socket `:9100` ESC/POS | 無 mixed content、無 Tunnel、無證書、**斷網照印**、格式完整（EscPosRenderer） | ① 只限 Android／Sunmi，桌面 Windows 終端用唔到；② USB 打印機完全唔支援（只 `:9100`）；③ APK 係同事維護、唔喺我哋 repo，存在 bus factor |
| **B · Printer Hub HTTP fallback** | 無 native bridge 時，POS → `http://HubIP:8787` → raw `:9100`；HTTPS POS 用 `<img>` beacon 過 mixed content | 普通瀏覽器都用到 | ① 需要**另一部常開 Android 設備**跑 Hub APK，單點故障；② mixed content beacon 係 fragile hack；③ 格式係純文字（非完整 ESC/POS，doc 37 提過漂移風險）；④ 同一 LAN 發現／靜態 IP 痛點 |

### 用家回報「問題較多」嘅真實成因

1. **依賴單一常開 Android 設備**（Hub 那部），佢重啟／冧機／換機，成間店打印就停。
2. **LAN 可達性**：打印機要同設備同網段、要綁靜態 IP（DHCP 一變 `:9100` 就斷）；掃描發現複雜。
3. **Mixed-content beacon hack** 脆弱，HTTPS POS 同 HTTP Hub 溝通隨時被瀏覽器擋。
4. **兩條代碼路徑**（native vs Hub）格式會漂移（doc 37 已見收據漏印問題）。
5. **完全唔支援 USB 打印機**——大量平價熱敏機係 USB-only 或 USB+Bluetooth。
6. **桌面 Windows POS 終端**除咗瀏覽器打 Hub 設備外，無更好選擇。

> 歷史已淘汰方案（僅供參考）：doc 33 自管 HTTPS（要 domain＋證書續期＋逐部裝證書）、doc 35 Cloudflare Tunnel（要互聯網、quick URL 重啟變、依賴第三方）、WebUSB（Chrome 限定）、browser `window.print`（無 ESC/POS、無切紙、無法指定廚房機）。

---

## 3. 可連接線下 WiFi / LAN / USB 打印機嘅方案比較

### 3.1 雲端中繼（Tunnel / VPS / ngrok）— ❌ 不採用
- 原理：打印機→本地代理→公網 tunnel→雲端 POS。
- 問題：**要互聯網**先印到（違反離線優先），依賴第三方 tunnel，延遲／節點隨機，quick URL 重啟變。已於 doc 35 淘汰。

### 3.2 打印機自帶 HTTP / WebSocket API（Epson ePOS、Star mC-Print 等）— ⚠️ 輔助
- 原理：部打印機本身係 HTTP server，POS POST ESC/POS 或高階指令；部分支援 mDNS 發現，免 raw socket。
- 優點：唔使 raw socket、發現容易、格式穩定。
- 問題：① **只適用支援型號**，平價機無；② 雲端 HTTPS POS 直打打印機 HTTP 一樣有 mixed content（除非經本地代理）；③ 唔解決 USB／Bluetooth 機。

### 3.3 WebUSB 直連 USB 打印機 — ⚠️ 選配（局限大）
- 原理：Chrome/Edge 經 WebUSB 直接開 USB 熱敏機。
- 優點：理論上瀏覽器可直接打 USB，唔使本地代理。
- 問題：① **只 Chrome/Edge**，Safari/iOS/Android WebView 全唔支援（我哋主力係 Android WebView，直接 GG）；② 要 user gesture＋權限彈窗；③ ESC/POS raw 要廠商特定 USB class，兼容差；④ 唔解決 LAN 機。
- 結論：**唔適合作主力**，只可日後做桌面 Chrome 場景嘅選配。

### 3.4 本地 Native 代理（Android APK）—— ✅ 現有主力，擴充 USB/BT
- 即而家嘅 Print Agent APK。擴充點：用 Android **USB Host API** 打 USB 打印機、用 **Bluetooth SPP** 打藍牙機，`connectionType` 由 `lan` 增 `usb` / `bluetooth`，APK 按 type 選 OS 傳輸。
- 優點：同一部 POS 機、斷網照印、格式完整。
- 問題：只 Android；APK 係同事 repo。

### 3.5 本地 Native 代理（桌面 companion service）—— ✅ 新增，補 Windows 終端
- 原理：喺 POS 終端機**同一部機**跑一個輕量本地服務（localhost HTTP，唔使 HTTPS、唔使證書、唔使 Tunnel），網頁 POS 打 `http://127.0.0.1:PORT`。服務內部用 OS API 打：
  - **LAN/WiFi**：raw socket `:9100`（同現有）；
  - **USB**：`node-usb` / OS 打印後台（廠商驅動）；
  - **Bluetooth**（可選）：OS BT SPP。
- 實作選項：
  - **QZ Tray**：成熟跨平台、簽名 WebSocket applet，瀏覽器直接打 USB/網絡/藍牙熱敏機，商用作為「本地代理」最穩。
  - **Electron / Tauri 外殼**：等同 Android APK 嘅桌面版，載入 POS 網頁＋滿血 Node serial/usb/network，最統一但開發量最大。
  - **迷你 Node/Go localhost service**：最輕，複用舊 `print-bridge` 代碼但改跑喺終端機 localhost（唔使 HTTPS）。
- 優點：**同一部機**、無 mixed content（localhost 不受 HTTPS 頁面 mixed-content 限制）、無證書、無 Tunnel、斷網照印、支援 USB。

### 3.6 方案對比一覽

| 方案 | 離線照印 | 支援 LAN | 支援 USB | 支援 BT | 桌面 Win | Android | 維運痛點 |
|------|---------|---------|---------|--------|---------|---------|---------|
| 雲端 Tunnel | 否 | ✅ | 經代理 | 經代理 | ✅ | ✅ | 要互聯網／第三方 |
| 打印機自帶 HTTP | 視型號 | ✅(型號限) | ❌ | ❌ | ✅ | ✅ | 型號限制／mixed content |
| WebUSB | 視瀏覽器 | ❌ | ✅(Chrome) | ❌ | 部分 | ❌(WebView) | 平台限制大 |
| Native APK（現） | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | 只 Android／同事 repo |
| **本地代理＋全傳輸（提案）** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 要裝一次本地代理 |

---

## 4. 推薦：整合性「本地打印代理」方案

**核心思想**：把「Android APK」同「桌面 companion service」統一成一個概念——**Macau POS Print Agent（本地打印代理）**——佢**跑喺 POS 終端機本身**（唔係另一部設備），對網頁 POS 只暴露**一個本地介面**（localhost HTTP ＋/或 JS bridge），內部按 `connectionType` 選 OS 原生傳輸，支援 **LAN/WiFi（raw `:9100`）、USB、Bluetooth** 三種物理打印機。

```
           網頁 POS（任何平台）
                │  localhost HTTP  /  window.PosNative bridge
                ▼
   ┌──────────────────────────────────┐
   │  Macau POS Print Agent（終端機本地）│
   │  dispatch by connectionType:      │
   │   ├─ lan      → raw socket :9100  │──▶ LAN/WiFi 熱敏機
   │   ├─ usb      → USB Host / OS spool│──▶ USB 熱敏機
   │   └─ bluetooth→ BT SPP            │──▶ 藍牙機（可選）
   └──────────────────────────────────┘
```

### 4.1 兩個 build，一套合約

| 平台 | 代理形態 | 狀態 |
|------|---------|------|
| **Android / Sunmi** | 現有 `print-agent-android` APK（WebView 外殼＋`PosNative` bridge） | 已有，擴 `usb`/`bluetooth` type |
| **桌面 Windows/Linux/macOS** | QZ Tray 或迷你 localhost service（Electron 備選） | **新增** |

網頁 POS 側 `dispatch.ts` 嘅路由邏輯已經啱（native bridge 優先 → Hub/localhost HTTP fallback），只要把「**Hub 係另一部設備**」嘅概念換成「**代理跑喺同一部終端機**」，並喺 `DevicePrinterConfig.connectionType` 增加 `usb` / `bluetooth` 維度（而家只有 `lan`），由代理按 type 解析到正確 OS 傳輸。

### 4.2 解決咗乜

- **單點故障**：代理同 POS 同一部機，無「另一部常開設備」依賴。
- **Mixed content**：localhost（或同 process bridge）不受 HTTPS 頁面 mixed-content 限制，beacon hack 可退役。
- **USB 打印機**：Android USB Host ＋ 桌面 OS spooler／`node-usb` 直接打 USB 機。
- **桌面 Windows 終端**：有正規本地代理，唔使靠瀏覽器打 Hub 設備。
- **格式統一**：一條 ESC/POS renderer（doc 37 嘅 EscPosRenderer）對齊所有路徑，消除 native vs Hub 漂移。

### 4.3 仍要處理嘅細節

1. **發現（discovery）**：LAN 打印機用 **mDNS / Bonjour（Zeroconf）** 自動發現＋記錄，減少手填 IP；USB 用 OS 列舉。
2. **靜態 IP**：LAN 機仍建議 router 綁 MAC→固定 IP，或靠 mDNS 名解析。
3. **Charset**：每台 `charset`（gb18030/gbk/big5/utf-8）已經喺 `printer.charset` 帶，代理 apply 即可（doc 37 §3.2）。
4. **安裝體驗**：桌面代理要「一鍵安裝＋開機自啟」；Android 就係裝 APK。
5. **權限**：Android USB Host 要 `USB_PERMISSION`；桌面要安裝廠商 USB 驅動（或用 OS spooler 經驅動打印）。

---

## 5. 實施階段（提案，未動手）

| Phase | 內容 | 輸出 |
|-------|------|------|
| P1 | 定義統一 `connectionType = lan \| usb \| bluetooth` 合約；`dispatch.ts` 按 type 分派 | 類型＋路由 |
| P2 | Android APK 增 USB Host / BT SPP 傳輸（擴 `native.ts` payload） | APK 改動需求書（類 doc 37） |
| P3 | 桌面 companion service（優先 QZ Tray 評估；或迷你 localhost service 複用舊 bridge 代碼） | Windows 終端可用 |
| P4 | mDNS 發現＋USB 列舉 UI；退役 Hub HTTP beacon hack | 設置頁簡化 |
| P5 | 統一 ESC/POS renderer 對齊全路徑 | 格式零漂移 |

---

## 6. 結論

- 「網頁直接打線下打印機」本身不可行，必須有**本地代理**。
- 最穩、最整合嘅方案＝**終端機本地打印代理**，一套合約支援 **LAN + USB + Bluetooth**，Android 用現有 APK 擴充、桌面用 companion service 補齊。
- 雲端 Tunnel／自管 HTTPS／WebUSB 都唔適合作主力（分別係要互聯網、要證書、平台限制大）。
- 打印機自帶 HTTP API 可作型號限定嘅輔助（尤其發現／免 raw socket），但唔解決 USB 同桌面統一。

> 本文件純屬調查與提案，尚未改動任何代碼。落實前建議先同 APK 同事對齊 P2 嘅 USB/BT 改動範圍。
