# 43 · 跨平台雙路徑打印方案（LAN 優先 ＋ 互聯網 fallback）

> **日期**：2026-08-23  
> **性質**：架構設計（**只改文檔，不動代碼**）  
> **背景**：承接 doc 41（三平台本地代理：桌面／Android／iOS，LAN/USB/BT）。現新增需求——除 LAN 區域網路打印外，當 LAN 不可用時**自動 fallback 改用互聯網**打印；兩條路徑要盡量共用同一套架構與通訊邏輯，並明確定義 LAN 失敗偵測條件、切換機制，以及三個平台各自如何實作。  
> **重要前提**：本方案**不推翻 doc 41 的離線優先主路徑**，互聯網只作 fallback；且互聯網路徑**不直接打打印機**，而是經雲端 relay 轉發到店內一台「常開代理」，由該代理在店內 LAN/USB/BT 打印（與主路徑共用同一套本地打印碼）。

---

## 1. 目標與約束

| 項目 | 要求 |
|------|------|
| 支援平台 | 桌面（Windows/macOS/Linux）、Android、iOS |
| 主路徑 | LAN 區域網路打印（doc 41 已定：raw socket `:9100` / USB / BT），離線優先 |
| 備援路徑 | LAN 不可用時，自動改互聯網打印 |
| 統一性 | 兩路徑盡量共用同一套架構、同一個 `PrintJob` 模型、同一個 coordinator 狀態機 |
| 偵測與切換 | 明確 LAN 失敗條件；切換要可回復（LAN 恢復後自動切返） |
| 安全 | 互聯網路徑必須 TLS ＋ 店級權限隔離，打印機不暴露公網 |

**與 doc 41 的關係**：doc 41 的「本地代理」＝主路徑（終端機本地打 LAN/USB/BT）。本方案在此之上**加多一層互聯網 fallback**，並把「終端機本地代理」與「店內常開代理（relay target）」統一為同一套軟件嘅兩種角色。doc 41 反對嘅「第二部機」是指**主路徑唔應該依賴第二部機**；本方案嘅「店內常開代理」**只喺你真係用互聯網 fallback 時先需要**（例如游走終端／多終端門店），單終端門店喺自己 LAN 上唔需要佢。

---

## 2. 統一架構總覽

```
                  POS Web App（任何平台，只 call 一個介面）
                          │  localhost HTTP  /  PosNative bridge
                          ▼
              ┌──────────────────────────────────┐
              │  Terminal Local Agent（終端機代理） │  ← 同一套軟件
              │  coordinator：on store LAN ?      │
              └───────────────┬──────────────────┘
                  ┌───────────┴────────────┐
          路徑 A（anchor ok）        路徑 B（anchor fail）
                  │                         │  WSS / HTTPS
                  ▼                         ▼
       打印機（LAN:9100/USB/BT）    Cloud Print Relay（TLS，只轉發）
                                          │  WSS（店級註冊連線）
                                          ▼
                                ┌──────────────────────────┐
                                │ 店內常開 Agent（always-on）│ ← 同一套軟件，relay-target 角色
                                │ 經 LAN/USB/BT 打印（=路徑 A）│
                                └──────────────────────────┘
```

**四個組件**：

1. **POS Web App**：只 call `printAgent.print(job)`（桌面走 localhost HTTP，Android/iOS 走 PosNative bridge）。永遠唔知底下係 LAN 定互聯網。
2. **Terminal Local Agent**：跑喺終端機本身（桌面 companion service／Android APK／iOS App）。負責 LAN 打印 ＋ coordinator 決策。
3. **Cloud Print Relay**：極輕量後端（HTTPS/WSS），**只做轉發，唔碰打印機**。按 `storeId` 把 job 送到對應店嘅常開代理。
4. **店內常開 Agent（Stationary Agent）**：與 Terminal Agent **同一套軟件**，但係「relay-target」角色——長期開喺店內 LAN 上、向 relay 註冊 `storeId`、收到 job 後用與路徑 A **完全相同**嘅本地打印碼印出。

---

## 3. 兩條路徑共用嘅通訊邏輯

統一點在於：**本地打印碼完全共用**，互聯網路徑只係把同一個 `PrintJob`「搬運」到店內常開代理，由佢執行同一段本地打印。

### 3.1 統一 `PrintJob` 模型（兩路徑同款）

```ts
interface PrintJob {
  jobId: string;
  storeId: string;            // 店級隔離
  printerId: string;          // 對應 DevicePrinterConfig.id
  connectionType: "lan" | "usb" | "bluetooth";  // 到店內代理後按此選 OS 傳輸
  charset: string;            // gb18030 / gbk / big5 / utf-8（doc 41 §4.3.3）
  payload: string;            // ESC/POS 位元組（base64）或高階收據模型＋renderer
  createdAt: number;
  ttl: number;                // 過期唔印（預設 60s），避免遲到單
}
```

### 3.2 `Transport` 抽象（兩種實作，同介面）

```
interface Transport { send(job: PrintJob): Promise<PrintResult>; }
├─ LanTransport   ：直接用 OS API 打 LAN:9100 / USB / BT（doc 41 各平台實作）
└─ RelayTransport ：經 WSS 把 job 送到 Cloud Relay → 店內常開代理執行 LanTransport
```

- **路徑 A（LAN）**：`LanTransport.send(job)` → 終端機本地直接打印。
- **路徑 B（互聯網）**：`RelayTransport.send(job)` → 雲端 relay 轉發 → 店內常開代理收到**同一個 `PrintJob`** → 跑**同一個 `LanTransport`** 打印。兩條路徑嘅「最後一哩」係同一段碼。

### 3.3 Relay 協議（店內常開代理與 relay 之間）

- 常開代理啟動時用 store token 開一條**長連 WSS** 並 `register({ storeId })`。
- 終端經 `RelayTransport` 送 `{ type: "print", job }`；relay 驗證 `job.storeId` 與 token 聲稱嘅 storeId 一致，轉發去該 store 嘅常開代理連線。
- 常開代理執行後回 `{ jobId, status, printedAt }`，relay 回終端。
- 全程 TLS；payload 可再用店級密鑰信封加密，令 relay 睇唔到收據內容（私隱）。

---

## 4. LAN 失敗偵測條件（精確定義）

切換決策主要睇**「終端係咪仲喺店內 LAN」**，唔係單睇打印機 socket（否則打印機死機會白做一次無用嘅雲端來回）。

### 4.1 店內 LAN anchor（核心判斷）

每間店嘅常開代理（以及喺店內 LAN 上嘅終端）廣播 mDNS：

```
_service: _macau-print._tcp.local
_txt:    storeId=<storeId>
```

終端做 mDNS browse，timeout `T_anchor`（預設 1.5s）：

- **搵到匹配 `storeId` 嘅 anchor** ＋（可選）終端本機 IP 屬店內子網 → **on store LAN**。
- 否則 → **off store LAN** → 走互聯網路徑。

> 備用／加固：店可 pin 一個「LAN anchor IP」（常開代理靜態 IP 或 gateway），終端以 connect/ping + timeout 驗證；mDNS 與 pin 任一說 on-LAN 即當 on-LAN。

### 4.2 打印機可達性（輔助判斷，唔作主切換）

當 on store LAN，對目標打印機做 TCP connect `ipAddress:lanPort`（預設 9100），timeout `T_connect`（預設 2s）：

- **anchor 在 ＋ 打印機 socket 通** → 正常 LAN 打印。
- **anchor 在 ＋ 打印機 socket 唔通** → 打印機本身離線／關機／拔線 → **呢個係打印機問題，互聯網路徑一樣打唔到該打印機** → **唔 escalate 去互聯網**，直接報「打印機離線」。
- **anchor 唔在** → 終端根本唔喺店內 LAN → 走互聯網（唔使試打印機 socket，慳時間）。

### 4.3 其他失敗訊號

- USB：OS 列舉唔到該 `printerId` 設備 → 該 USB 路徑 fail（LAN 仍在可改投 LAN 打印機）。
- Bluetooth：連線 timeout／配對丟失 → 該 BT 路徑 fail。
- 互聯網路徑自身：relay 連唔到／店內常開代理離線／無註冊 → 報「互聯網備援不可用」。

---

## 5. 切換機制（coordinator 狀態機）

每個（終端，店）維持一個狀態機；**per-printer** 記錄各打印機最後狀態（一部廚房機 off 唔好拖累收銀機）。

```
狀態： ON_LAN  ──anchor 丟失──▶  RELAY
        ▲                          │
        └──── healing 探測成功 ─────┘  （每 T_heal 重探，連續 N 次成功才切返）
```

**每次打印流程**：

1. 若 `state == ON_LAN`：
   - 先 cheap 探 anchor。anchor 丟咗 → `state = RELAY`，跳 3。
   - anchor 在 → 試 `LanTransport` 打目標打印機。
     - 成功 → 完成。
     - 失敗**且** anchor 同時丟 → `state = RELAY`，經 relay 重試。
     - 失敗**但** anchor 在 → 打印機問題 → 報錯（**唔 escalate**）。
2. 若 `state == RELAY`：
   - `RelayTransport.send(job)`。
     - 成功 → 完成（店內常開代理已印）。
     - 失敗（relay 連唔到／常開代理離線／未註冊）→ 報「無法打印：店內代理離線或網絡中斷」。
3. **Healing / 回復**：`RELAY` 狀態下每 `T_heal`（30–60s）重探 anchor；anchor 回復 ＋ 連續 `N`（預設 2）次 LAN 試印成功 → 切返 `ON_LAN`。避免喺邊緣網絡 flap。

**防 flap 參數**（建議預設，可店級調）：

| 參數 | 預設 | 作用 |
|------|------|------|
| `T_anchor` | 1.5s | mDNS/pin 探測超時 |
| `T_connect` | 2s | 打印機 socket 連線超時 |
| 轉 RELAY 條件 | anchor 丟失（或 anchor 丟＋LAN 連續 2 次失敗） | 避免打印機死機誤觸發 |
| `T_heal` | 45s | RELAY 下重探 LAN 間隔 |
| 切返 ON_LAN 條件 | 連續 2 次 LAN 探測成功 | 防抖 |
| `ttl` | 60s | job 過期唔印 |

---

## 6. 三平台實作

三平台都實作**同一個 coordinator 演算法**（同規格，各 port 一次）＋ **同一個 `LanTransport` 本地打印碼**（doc 41 已定）＋ **一個 `RelayTransport`（WSS client，各平台標準庫即可）**。Web POS 永遠只 call `print(job)`，唔知底下發生咩。

### 6.1 桌面（Windows / macOS / Linux）

| 項 | 實作 |
|----|------|
| 代理形態 | companion service（QZ Tray 或迷你 localhost Node/Go service），聽 `127.0.0.1:port` |
| LAN transport | `net` raw socket `:9100`；USB 經 `node-usb`／OS spooler；BT 經 OS（可選） |
| off-LAN 偵測 | `multicast-dns` 或 OS mDNS browse ＋（可選）pin IP connect；mDNS 唔到即 off-LAN |
| RelayTransport | Node `ws` 開 WSS 到 Cloud Relay |
| coordinator | 全部喺 service 內；Web 只 call `http://127.0.0.1:port/print`，保持「傻」 |

### 6.2 Android

| 項 | 實作 |
|----|------|
| 代理形態 | 現有 `print-agent-android` APK（WebView ＋ `PosNative` bridge） |
| LAN transport | Kotlin raw socket `:9100`；**USB Host API**；**BT SPP** |
| off-LAN 偵測 | `ConnectivityManager`／Wi-Fi SSID／`NsdManager` mDNS |
| RelayTransport | Kotlin `OkHttp` WebSocket 到 Cloud Relay |
| coordinator | 喺 Kotlin 內；WebView 只 call `PosNative.print(job)`，APK 內部決策 |

### 6.3 iOS / iPad

| 項 | 實作 |
|----|------|
| 代理形態 | iOS App（WKWebView ＋ `PosNative` 等效 bridge）；**App 本身＝代理**（iOS 冇 standalone daemon，doc 41 §3.7） |
| LAN transport | `Network.framework` raw socket `:9100`（LAN ✅）；**USB ❌**（iOS 冇 Host）；BT ⚠️ 只 BLE 或 MFi-classic |
| off-LAN 偵測 | `NWPathMonitor`／`NWBrowser` mDNS／SSID |
| RelayTransport | `URLSessionWebSocketTask` 到 Cloud Relay |
| coordinator | 喺 Swift 內；WebView 只 call bridge，App 內部決策 |

> **macOS** 跟桌面 companion service（有 USB Host、有 BT），唔使特別處理；真正 mobile 特例只得 iOS/iPad（冇 daemon、冇 USB host、BT 限 BLE/MFi）。

---

## 7. 安全模型（互聯網路徑）

- **全程 TLS**：relay 只聽 HTTPS/WSS，唔允許明文。
- **店級隔離**：終端用 store-scoped token（Ledger session / JWT 帶 `storeId` claim）；relay 強制 `job.storeId` 必須等於 token 聲稱嘅 storeId，且只轉發去該 store 註冊嘅常開代理連線。
- **打印機唔暴露公網**：relay 永遠唔直接打打印機；打印機只喺店內 LAN 被常開代理打。
- **私隱**：payload 可再用店級密鑰信封加密，relay 只轉發、睇唔到收據內容。
- **防遲到單**：job 帶 `ttl`（60s），過期 drop，唔會網絡回復後突然印舊單。
- **審計**：relay 側記 print attempt（jobId / storeId / status / time）供對帳，收據內容唔落地超過 ttl。

---

## 8. 部署前提與優雅降級

互聯網 fallback **需要**以下前提，否則自動降級：

1. 店內至少一部**常開設備**跑 Stationary Agent（尾冚 PC／Android box／Raspberry Pi），長期喺店內 LAN 並向 relay 註冊。
2. Cloud Relay 後端已部署。
3. 終端持有 relay 憑證（store token）。

**降級規則**：

- 店**未設**常開代理 → relay 路徑不可用 → 終端降為 **LAN-only**，並提示「此店未設店內常開代理，互聯網備援不可用」。
- 終端在店內 LAN 但打印機死機 → 報「打印機離線」（唔嘗試互聯網，因一樣印唔到）。
- 互聯網路徑失敗（relay 連唔到／常開代理離線）→ 報「無法打印：店內代理離線或網絡中斷」。

> 單終端門店若終端本身就喺店內 LAN，**正常主路徑唔需要常開代理**；常開代理只喺你真係要用「終端游走／多終端」嘅互聯網備援時先要。

---

## 9. 實施階段建議

| Phase | 內容 | 輸出 |
|-------|------|------|
| P0 | 定義共用 `PrintJob` ＋ relay 協議 ＋ coordinator 規格（擴 doc 41 合約，加 `storeId`/`ttl`） | 類型＋協議 |
| P1 | Cloud Relay 後端（HTTPS/WSS、store-scoped auth、ttl、審計） | relay 服務 |
| P2 | Stationary Agent 角色（同軟件，relay-target，持久 WSS 註冊） | 常開代理模式 |
| P3 | 三平台 Terminal Agent coordinator（anchor 偵測＋狀態機＋healing） | 桌面／Android／iOS |
| P4 | 打印機可達性探測＋「打印機問題 vs off-LAN」區分 | 精準切換 |
| P5 | 統一 ESC/POS renderer 對齊全路徑（doc 41 P5） | 格式零漂移 |

---

## 10. 結論

- 統一架構＝**「終端機本地代理」＋「店內常開代理」＝同一套軟件兩種角色**，中間用一個極輕 Cloud Relay 轉發。
- 兩路徑共用同一個 `PrintJob`、同一段 `LanTransport` 本地打印碼、同一個 coordinator 狀態機；平台差異只係 OS 級 `LanTransport` 後端 ＋ 一個標準庫 WSS client。
- 切換靠**店內 LAN anchor（mDNS/pin）**判斷終端在唔在店內 LAN，而非單睇打印機 socket；打印機死機唔會誤觸發互聯網。RELAY 狀態會週期重探並自動切返 ON_LAN（防 flap）。
- 互聯網路徑安全靠 TLS ＋ 店級隔離 ＋ 打印機唔暴露公網 ＋ ttl；並優雅降級（無常開代理→LAN-only）。
- 唔推翻 doc 41 離線優先主路徑；常開代理只喺互聯網備援場景才需要。

> 本文件純屬架構設計，尚未改動任何代碼。落實前建議：① 同 APK 同事對齊 P3 嘅 coordinator／relay client 範圍；② 確認 Cloud Relay 用現有 Supabase/Ledger 邊緣函數定係獨立服務。
