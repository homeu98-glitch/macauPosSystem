# Macau POS Print Bridge

本機 **LAN / USB ESC/POS** 打印橋接服務。POS 瀏覽器無法直接連打印機，需在本機收銀 PC 執行此服務。

## 安裝

```powershell
cd print-bridge
npm install
npm start
```

預設監聽：`http://127.0.0.1:9222`

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/health` | 心跳 |
| GET | `/printers/system` | 列出 Windows 系統印表機（USB 用） |
| POST | `/config` | POS 推送 `{ deviceConfig }` |
| POST | `/print` | `{ job, printer?, meta? }` |
| POST | `/test-print` | `{ printerId?, printerName?, printer? }` |

## 打印機設定

### LAN（廚房／收據）

- 設置頁填 **IP 地址**
- 端口預設 **9100**（Raw TCP / JetDirect）
- 支援 EPSON / Star 等 ESC/POS 80mm、58mm

### USB

- 設置頁 **USB 標籤** 填 Windows **印表機名稱**（與「設定 → 印表機」一致）
- 可先 `GET http://127.0.0.1:9222/printers/system` 查看名稱

## POS 環境變數

在 POS 專案 `.env.local`：

```env
# 本機收銀 PC（bridge 與瀏覽器同一台）
NEXT_PUBLIC_PRINT_BRIDGE_URL=http://127.0.0.1:9222

# iPad / Android 平板（bridge 跑在店內另一台固定設備，填該設備 LAN IP）
# NEXT_PUBLIC_PRINT_BRIDGE_URL=http://192.168.1.50:9222
```

> 橋接預設監聽 **`0.0.0.0:9222`**，同一 WiFi 內的平板可連。勿暴露到公網。

## 平板店鋪（iPad / Android）建議架構

瀏覽器 **無法** 直接連 LAN/USB 打印機（安全限制），因此仍需店內有一個 **打印中繼**：

| 方案 | 說明 |
|------|------|
| **A. 店內小主機（推薦）** | 樹莓派 / 舊手機 Termux / 迷你 PC 常開 `print-bridge`；所有平板指向 `http://192.168.x.x:9222` |
| **B. 收銀 PC** | 若店內仍有電腦，同 A |
| **C. 純平板、無中繼** | ❌ 無法 ESC/POS 廚房單；只能用瀏覽器「列印」對話框（不適合熱廚房） |

**打印機連接方式（均支援，只要 bridge 能連到打印機）：**

| 打印機接法 | 誰連 | 設定 |
|------------|------|------|
| **LAN 網線** | bridge → 打印機 IP:9100 | 設置頁填 IP + 端口 |
| **WiFi** | 同上（打印機取得 LAN IP 即可） | 同 LAN |
| **USB** | bridge 所在那台機器的 USB | `usbLabel` = Windows 印表機名稱；**平板本身 USB 不行** |

點餐機用 WiFi/LAN 沒問題；打印請求走 HTTP 到 bridge，bridge 再轉發到打印機。

## 雲端 HTTPS POS 連 LAN bridge（Path ②）

若 POS 部署在 **HTTPS** 網站（如 Vercel），瀏覽器有 mixed content 限制，**不能 `fetch` HTTP 的 LAN bridge**，會報 `Failed to fetch`、health 紅色。

解法：bridge 改開 **HTTPS（Let's Encrypt 證書，DNS-01 發出，公眾信任）**，POS 機零配置。

1. 擁有一個 domain，用 `scripts/issue-cert.sh`（DNS-01）發證書；
2. 店內 DNS 將 `bridge.yourdomain.com` 覆寫指向 bridge 的 LAN IP（如 `192.168.31.106`）；
3. `.env` 設 `PRINT_BRIDGE_TLS=1` + 證書路徑 + `PRINT_BRIDGE_TLS_PORT=8443`，用 `bash start.sh` 啟動；
4. POS 設定頁「橋接 URL」填 `https://bridge.yourdomain.com:8443`。

完整步驟、店內 DNS 覆寫做法、續期與排錯見 **`docs/33-print-bridge-https-lan.md`**。

server.mjs 已支援 `node:https`：由 `PRINT_BRIDGE_TLS` 控制啟用，`startHttps()` 讀 `PRINT_BRIDGE_TLS_CERT` / `PRINT_BRIDGE_TLS_KEY` 起 HTTPS；`PRINT_BRIDGE_ALSO_HTTP=1` 可同時開 HTTP 9222 做本地除錯。

## 開機自啟（可選）

建立 Windows 工作排程器，登入時執行：

```powershell
node C:\dev\macauPos\macauPosSystem\print-bridge\src\server.mjs
```

## 故障排除

| 問題 | 檢查 |
|------|------|
| POS 顯示橋接離線 | 服務是否啟動、`9222` 是否被占用 |
| LAN 無輸出 | ping IP、防火牆、打印機是否開啟 9100 |
| USB 無輸出 | `usbLabel` 是否與系統印表機名稱完全一致 |
| 中文亂碼 | 打印機需支援 GB18030 / 簡體中文碼頁 |
