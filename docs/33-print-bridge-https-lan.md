> ⚠️ **已取代（Deprecated）**：本文件描述嘅舊 Node `print-bridge`（雲端 HTTPS POS + LAN bridge + 自簽證書）架構，已經被 **Native Print Agent（`print-agent-android`：WebView 外殼載入 POS + `window.PosNative` JS bridge，經 raw socket `:9100` ESC/POS）** 完全取代。相關文件：[`docs/36-native-print-agent.md`](./36-native-print-agent.md)（配對 / Hub fallback）、[`docs/37-apk-native-bridge-print-format.md`](./37-apk-native-bridge-print-format.md)（native 打印格式）。POS 而家喺 Android WebView 入面跑，唔使再處理 mixed content / Cloudflare Tunnel / 自簽證書。以下內容只作歷史參考。

# 33 · 雲端 HTTPS POS 連 LAN print-bridge（Path ②）

## 背景：點解要 HTTPS？

你嘅 POS 部署喺 **HTTPS** 網站（例如 `https://macau-pos-system.vercel.app`）。
瀏覽器有 **mixed content** 安全限制：**HTTPS 頁面唔可以 `fetch` 一個 HTTP（LAN）資源**。

- 你之前見到 `Failed to fetch` + health 紅色，正正係呢個原因。
- bridge 本身無問題（CORS 已開 `*`），係瀏覽器擋咗 HTTP 請求。

解法有兩條，你揀咗 **Path ②：keep Vercel，幫 bridge 加 HTTPS**。

> 另一條路（Path ①）係將 POS 本身都跑喺店內 HTTP（on-prem），咁就無 mixed content 問題。
> 但既然你要 keep Vercel，就必須行 Path ② —— bridge 要提供 HTTPS。
> 有 domain 就用 Let's Encrypt（公眾信任，POS 機零配置）；**無 domain** 就用 **方案 B 自簽證書 + 逐部機裝信任**。

---

## 方案概覽

```
  POS 瀏覽器 (HTTPS)               店內 LAN
  ┌──────────────────┐
  │ macau-pos-...    │   https://bridge.yourdomain.com:8443
  │ (Vercel HTTPS)   │ ───────────────────────────────┐
  └──────────────────┘                                │
                                                      ▼
                                            ┌────────────────────┐
                                            │  print-bridge      │  開 HTTPS (8443)
                                            │  （常開設備）        │
                                            │  192.168.31.106    │
                                            └─────────┬──────────┘
                                                      │  Raw TCP :9100 (ESC/POS)
                                                      ▼
                                            ┌────────────────────┐
                                            │  廚房 / 收銀打印機   │
                                            │  192.168.31.38:9100 │
                                            └────────────────────┘
```

關鍵：**證書由 Let's Encrypt 經 DNS-01 發出**（公眾信任），所以 POS 機零配置。
DNS-01 唔需要 bridge 對外開 80 port，非常適合 LAN 內部機。

---

## 前置條件

1. **你要 own 一個 domain**（例如 `yourdomain.com`），DNS 交畀下面其中一個提供商管：
   - Cloudflare（推薦，API 最簡單）
   - Aliyun / 騰訊雲 DNSPod / GoDaddy / …（acme.sh 全部支援）
2. **一部長開嘅設備** 跑 print-bridge（你已經用舊手機 Termux 做咗，IP `192.168.31.106`）。
3. 部設備嘅 **8443 port 喺店內 LAN 可被 POS 機連到**（防火牆放行）。
4. 唔可以對 raw IP 發 Let's Encrypt 證書，**一定要有 domain**。

---

## Step 1 · 準備域名 + DNS

你只需要兩條 DNS 記錄：

### (a) 公網 DNS（畀 Let's Encrypt 驗證用，DNS-01 唔 check host 是否可達）

喺你嘅 DNS 提供商加一條 A 記錄（指向唔重要，甚至可以暫時指去 `127.0.0.1`，驗證靠 TXT）：

```
bridge.yourdomain.com   A   127.0.0.1     (或任何值，DNS-01 唔 reach 呢個 IP)
```

> DNS-01 驗證係靠 `_acme-challenge.bridge.yourdomain.com` 嘅 **TXT 記錄**，acme.sh 會自動加／刪。
> 所以 bridge 本身**唔使**對公網開放，公網 A 記錢填乜都好。

### (b) 【店內 DNS 覆寫】—— 呢步最關鍵

POS 機要連 `https://bridge.yourdomain.com`，但證書係真·公眾 CA，瀏覽器 accept；
而家 DNS 要將呢個名 **喺店內解析返去 bridge 嘅 LAN IP `192.168.31.106`**。

你喺**店內**做一層 DNS override（唔影響公網）：

| 做法 | 適用 | 設定 |
|------|------|------|
| **店內路由器 DNS 覆寫**（最推薦） | 大部份智能路由器（ASUS / MikroTik / OpenWrt / Ubiquiti） | 喺「DNS / 自訂主機名」加 `bridge.yourdomain.com → 192.168.31.106`，全店裝置自動生效 |
| **Pi-hole / AdGuard Home / dnsmasq** | 店內有跑呢啲 | 加一條 `address=/bridge.yourdomain.com/192.168.31.106` |
| **逐部機 hosts 檔**（臨時 / 無路由器權限） | 單機測試 | 見下「逐部機 hosts」 |

**逐部機 hosts（最後手段）：**

- Windows：`C:\Windows\System32\drivers\etc\hosts` 加 `192.168.31.106 bridge.yourdomain.com`
- macOS / Linux：`/etc/hosts` 加同上
- Android / iOS：要 root / 越獄，或靠上面嘅路由器 DNS 覆寫（推薦）

> ✅ 做完呢步，店內所有 POS 機 `ping bridge.yourdomain.com` 都會返 `192.168.31.106`，
> 但證書係 Let's Encrypt 公眾信任，瀏覽器唔會報唔安全。

---

## Step 2 · 發 Let's Encrypt 證書（DNS-01）

喺跑 bridge 嗰部設備（舊手機 Termux / 迷你 PC）上面：

```bash
# 1) 裝 acme.sh（一次過）
curl https://get.acme.sh | sh
source ~/.bashrc   # 或重開 terminal

# 2) 按你嘅 DNS 提供商匯入 API token（示例：Cloudflare）
export CF_Token="你的_CF_API_Token"
export CF_Account_ID="你的_CF_Account_ID"
#    Aliyun  → Ali_Key / Ali_Secret
#    Tencent → DP_Id / DP_Key
#    GoDaddy → GD_Key / GD_Secret
#    其餘見 https://github.com/acmesh-official/acme.sh/wiki/dnsapi

# 3) 發證書
cd /path/to/macauPosSystem/print-bridge
BRIDGE_DOMAIN=bridge.yourdomain.com \
CERT_OUT_DIR=/etc/print-bridge \
bash scripts/issue-cert.sh
```

證書會落到 `/etc/print-bridge/`：

```
bridge.yourdomain.com.cer
bridge.yourdomain.com.key
bridge.yourdomain.com.fullchain.cer
```

（腳本已幫你指定 `--fullchain-file`，bridge 用呢個做 `cert` 就得。）

> ⚠️ 如果 `/etc/print-bridge` 寫唔入（Android Termux / 權限），改 `CERT_OUT_DIR` 去你有權嘅路徑，
> 例如 `$HOME/print-bridge-certs`，再喺 `.env` 指過去就得。

---

## Step 3 · 配置 print-bridge `.env`

複製 `print-bridge/.env.example` 做 `.env`：

```bash
cd /path/to/macauPosSystem/print-bridge
cp .env.example .env
```

編輯 `.env`：

```env
PRINT_BRIDGE_HOST=0.0.0.0
PRINT_BRIDGE_PORT=9222

# ===== Path ②：開 HTTPS =====
PRINT_BRIDGE_TLS=1
PRINT_BRIDGE_TLS_CERT=/etc/print-bridge/bridge.yourdomain.com.fullchain.cer
PRINT_BRIDGE_TLS_KEY=/etc/print-bridge/bridge.yourdomain.com.key
PRINT_BRIDGE_TLS_PORT=8443

# 可選：同時開 HTTP 9222 做店內本地除錯（POS 請用 HTTPS）
PRINT_BRIDGE_ALSO_HTTP=0
```

> 記得 `PRINT_BRIDGE_TLS_CERT` / `PRINT_BRIDGE_TLS_KEY` 路徑要同 Step 2 实際落證書位置一致。

---

## Step 4 · 啟動 bridge

```bash
cd /path/to/macauPosSystem/print-bridge

# 推薦：用 start.sh（自動載入 .env）
bash start.sh

# 或者（已加 dotenv 依賴，npm start 都會自動載 .env）
npm install
npm start
```

開機自啟（舊手機 Termux 可以用 `termux-boot` / `termux-services` 跑 `bash start.sh`；
Linux 用 systemd；Windows 用工作排程器）。

---

## Step 5 · 驗證 HTTPS 起咗

```bash
curl -k https://192.168.31.106:8443/health
```

（用 IP + `-k` 只係本地驗證；POS 機會用域名 `bridge.yourdomain.com` 連，先會驗證證書。）

預期返回 `tls: true`、`port: 8443`：

```json
{
  "ok": true,
  "service": "macau-pos-print-bridge",
  "tls": true,
  "port": 8443,
  "hasConfig": false,
  "printerCount": 0,
  "uptimeSec": 12
}
```

再喺店內一部機用瀏覽器開 `https://bridge.yourdomain.com:8443/health`，
**地址欄要顯示鎖頭（證書 OK）** 先算過關。

---

## Step 6 · POS 後台改橋接 URL

1. 開 POS → 設定 → 設備（`/settings`，device tab）。
2. 「橋接 URL」填上：

   ```
   https://bridge.yourdomain.com:8443
   ```

   > ⚠️ **一定要有 `https://` 前綴**（你之前試過唔加就變相對路徑，報 `Unexpected token '<'`）。
   > port `8443` 要同 `.env` 嘅 `PRINT_BRIDGE_TLS_PORT` 一致。
3. 存檔 → 狀態應該變 **綠色「已連線」**。mixed content 紅色問題消失。

（設置頁輸入框接受 `http://` 同 `https://`，無 scheme 限制；純 LAN 部署繼續用 `http://192.168.1.50:9222` 都得。）

---

## 證書續期

Let's Encrypt 證書 90 日過期。acme.sh 安裝時已經幫你加咗 cron / systemd timer，**一般唔使手動**。

手動續期：

```bash
~/.acme.sh/acme.sh --renew -d bridge.yourdomain.com
```

如證書路徑冇變，bridge 唔使重啟（Node 喺 `startHttps()` 時讀一次；要攞新證書就 restart `bash start.sh`）。
想自動 reload，喺 `issue-cert.sh` 嘅 `--reloadcmd` 加 `pkill -HUP node` 之類（視你點跑 service）。

---

## 常見問題

| 情況 | 原因 / 解決 |
|------|------------|
| 改咗 `https://...` 仍然紅 | 域名喺店內**未**解析去 `192.168.31.106`（Step 1b DNS 覆寫未做 / 未生效）；`ping bridge.yourdomain.com` 查吓 |
| 行 Let's Encrypt 方案時瀏覽器報「唔安全」 | 證書未正確安裝 / 域名解析錯；Let's Encrypt 係公眾 CA 唔應該報。如行**自簽方案 B**，報「唔安全」係正常，要將 `.cer` 裝入該機受信任根 CA（見方案 B Step B4） |
| `TLS cert/key 讀取失敗` 起唔到 | `.env` 路徑錯 / 證書未發 / 權限唔夠讀 `/etc/print-bridge` |
| 店內連到但公網連唔到 | 正常！bridge 只服務 LAN，唔使對公網開 8443（亦**唔建議**對公網開） |
| 想本地 debug | 暫時 `PRINT_BRIDGE_ALSO_HTTP=1` 開多個 HTTP 9222，但 POS 請用 HTTPS |
| 8443 被佔用 | 改 `PRINT_BRIDGE_TLS_PORT`，對應改 POS 橋接 URL 個 port |

---

## 安全提醒

- bridge **只係 LAN 服務**，唔好將 8443 對公網（NAT/防火牆）開放。
- 證書係公眾信任，但域名只會喺店內 DNS 覆寫後指向 LAN IP，公網解析到嘅係你 Step 1a 填嘅假值，冇影響。
- `PRINT_BRIDGE_TLS_KEY`（私鑰）只留喺跑 bridge 嗰部設備，唔好上載 repo。

---

## 方案 B · 自簽證書（無 domain 頂住先）

如果你冇 domain（例如純 Vercel 無 DNS 提供商），可以用 **自簽證書** 頂住：
對住 bridge 個 LAN IP 出一份自簽證書，POS 填 `https://192.168.31.106:8443`，
**但每部 POS 機要將 `.cer` 裝入「受信任根 CA」**，否則瀏覽器 `fetch` 會因證書不受信任而失敗（無得 click-through）。

> 優點：唔使 domain、唔使 DNS 覆寫、即出即用。
> 缺點：每部新 POS 機都要手動裝一次證書；bridge IP 一變（DHCP）就要重出證書。

### 前置

1. `openssl` 已裝：Termux 跑 `pkg install openssl`；macOS/Linux 通常內建；Windows 用 Git Bash 或 WSL。
2. **bridge 部機建議設 DHCP 固定 IP**（router 綁 MAC → `192.168.31.106`），否則 IP 變咗證書 SAN 唔 match。
3. 證書只係公開嘅 `.cer`（無私鑰），可以安全抄去各部機。

### Step B1 · 出證書

喺跑 bridge 嗰部機：

```bash
cd /path/to/macauPosSystem/print-bridge
BRIDGE_IP=192.168.31.106 \
CERT_OUT_DIR=$HOME/print-bridge-certs \
bash scripts/issue-selfsigned.sh
```

落到 `$HOME/print-bridge-certs/bridge-selfsigned.cer` + `.key`（SAN = IP `192.168.31.106`）。

### Step B2 · `.env` 用自簽路徑

```env
PRINT_BRIDGE_TLS=1
PRINT_BRIDGE_TLS_CERT=$HOME/print-bridge-certs/bridge-selfsigned.cer
PRINT_BRIDGE_TLS_KEY=$HOME/print-bridge-certs/bridge-selfsigned.key
PRINT_BRIDGE_TLS_PORT=8443
PRINT_BRIDGE_ALSO_HTTP=0
```

### Step B3 · 起 bridge + 驗證

```bash
bash start.sh
curl -k https://192.168.31.106:8443/health   # 睇到 tls:true 就掂
```

### Step B4 · 逐部 POS 機裝證書（最關鍵）

將 `bridge-selfsigned.cer` 抄去該機，裝入 **「受信任的根憑證授權單位 / Trusted Root CA」**：

| 平台 | 做法 |
|------|------|
| **Windows** | 雙撃 `.cer` → 「安裝憑證」→ 本機電腦 → 將所有憑證放入下列存放區 → 受信任的根憑證授權單位。Chrome / Edge 跟系統 store |
| **macOS** | 雙撃 `.cer` → 鑰匙圈存取 → 系統 → 取得該證書 → 顯示簡介 → 信任 → 使用此憑證時：永遠信任。Safari/Chrome 跟系統 store |
| **Linux (Chrome)** | `sudo cp bridge-selfsigned.cer /usr/local/share/ca-certificates/ && sudo update-ca-certificates`；Firefox 要自己 Options → Privacy & Security → View Certificates → Authorities → Import 同埋剔「信任呢個 CA 辨識網站」 |
| **Android** | 設定 → 安全性 → 安裝憑證 → CA 憑證 → 選 `.cer`。裝完 Chrome 會信任（user-installed CA） |
| **iPad / iOS** | 用 AirDrop/郵件收 `.cer` → 設定 → 已下載的描述檔 → 安裝 → 再 設定 → 一般 → 關於本機 → 憑證信任設定 → 開啟該證書嘅完整信任 |

> ⚠️ 只裝「使用者」層級而唔係「根 CA」嘅話，瀏覽器 `fetch` 仍會當不受信任。一定要入去「受信任根 CA」。
> 裝完要 **重開瀏覽器**（最好重啟部機）先生效。

### Step B5 · POS 填 URL

設定 → 設備 → 橋接 URL 填：

```
https://192.168.31.106:8443
```

狀態變綠色即過關。

### 證書續期 / 換 IP

自簽證書預設 825 日。IP 變咗或要換：

```bash
rm $HOME/print-bridge-certs/bridge-selfsigned.cer $HOME/print-bridge-certs/bridge-selfsigned.key
BRIDGE_IP=新IP bash scripts/issue-selfsigned.sh
bash start.sh   # 重啟生效
# 每部機要重新裝新 .cer（舊嘅可留可刪，建議刪走避免混淆）
```
