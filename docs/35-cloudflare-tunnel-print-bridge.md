> ⚠️ **已取代（Deprecated）**：本文件嘅 Cloudflare Tunnel 打印橋接方案（手機跑 `cloudflared` 暴露 `:9222`）已經被 **Native Print Agent（`print-agent-android`）** 完全取代——POS 喺 Android WebView 外殼跑，`PosNative.printJob` 直接 raw socket `:9100` ESC/POS 出單，無 Tunnel、無自簽證書、斷網照印。見 [`docs/36-native-print-agent.md`](./36-native-print-agent.md) 同 [`docs/37-apk-native-bridge-print-format.md`](./37-apk-native-bridge-print-format.md)。以下內容只作歷史參考。

# 35 · Cloudflare Tunnel 打印橋接（Path X，店主零操作）

> 目標：讓部署在 **Vercel（HTTPS）** 的 POS，能夠連到 **店內 Android 手機**上跑的 print-bridge，
> 而 **唔使 domain、唔使 DNS、唔使 SSL 證書、店主零操作**。斷線開單靠現有 offline mode。

---

## 0. 為什麼用 Tunnel（Path X）

Vercel 係 HTTPS 網頁，瀏覽器有 **mixed content** 限制，唔可以 `fetch` 店內 `http://192.168.x.x:9222`
嘅 bridge，會報 `Failed to fetch`、健康檢查紅色。

解決方法有三條：

| 路徑 | 做法 | 店主操作量 | 斷網照印？ | 備註 |
|------|------|-----------|-----------|------|
| ② 自管 HTTPS | bridge 自己開 HTTPS（Let's Encrypt DNS-01 證書）+ 店內 DNS 覆寫 | 重：發證書、續期、逐部裝 | 否（仍靠 Vercel） | 見 docs/33 |
| 34 on-prem | POS app 同 bridge 都搬落店內手機跑本地 HTTP | 中：搬 static app + app-server | **是** | 見 docs/34 |
| **X Tunnel ✅** | 手機跑 `cloudflared`，將本地 `:9222` 暴露成公眾 `https://*.trycloudflare.com` | **零**：裝一次、之後開機自啟 | 否（斷網靠 offline mode 開單） | **本文件** |

**點解 Tunnel 夠用**：你個 project 已經有 **offline mode**——Vercel / 互聯網斷咗，POS 照樣開單（localStorage / IndexedDB）。
所以「斷網照印」嘅硬需求被大幅弱化：斷網時你係開緊單、未到打印嗰步；網一回來，Tunnel 就恢復，打印正常出。
（如果你想「完全斷網都照印」，要行 docs/34 on-prem；但對單店店主，Tunnel + offline mode 已經最抵。）

---

## 1. 前置條件

- 一台 **常開嘅 Android 手機**（你已經喺度跑 bridge App 嗰部），裝咗 **Termux**。
- 部手機同打印機同一 WiFi（bridge 連打印機 `IP:9100`）。
- 手機能夠上網（Tunnel 需要互聯網；呢點同 offline mode 互補）。
- 電腦：將 `print-bridge/` 成個目錄複製到手機 Termux home（`~/print-bridge`）。

---

## 2. 喺 Android Termux 裝 cloudflared

> ⚠️ **唔好**用 `pkg install cloudflared`（Termux 官方 repo 冇或版本舊）。用預編譯二進制。

```bash
# 喺 Termux 入面
pkg update && pkg upgrade -y
pkg install -y curl wget

# 下載 Termux 專用嘅 cloudflared（arm64）最新版
cd ~
wget https://github.com/igrek51/cloudflared-termux/releases/latest/download/cloudflared -O cloudflared
chmod +x cloudflared
install cloudflared $PREFIX/bin/        # 之後任何目錄都用到 cloudflared

# 驗證
cloudflared --version
```

> 如果 `igrek51/cloudflared-termux` 嘅 asset 名唔係 `cloudflared`，改用官方 arm64 二進制：
> `wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -O cloudflared`
> 兩者喺 Termux 都可用；igrek51 版係專門為 Termux patch 過。

**Quick Tunnel 唔使登入 Cloudflare 帳號**，零配置，可以直接試。

---

## 3. 複製 print-bridge 到手機並裝 dependency

```bash
# 喺電腦用 adb / scp / Termux 自己 git clone 都得，總之令手機有：
#   ~/print-bridge/
#     ├── src/server.mjs
#     ├── scripts/start-tunnel.sh
#     ├── package.json
#     └── .env.example

# 喺 Termux：
cd ~/print-bridge
cp .env.example .env          # 用預設就夠（TLS=0，Tunnel 模式）
npm install                   # 裝 iconv-lite / printer / dotenv
```

> 手機只做「橋接 + Tunnel」，唔使裝打印機驅動（LAN 打印機直接連 IP:9100）。
> `printer` 依賴裝唔到都唔緊要，LAN 打印唔靠佢。

---

## 4. 一鍵起 Tunnel，取得 public URL

```bash
cd ~/print-bridge
bash scripts/start-tunnel.sh
```

你會見到類似：

```
[tunnel] 起 print-bridge (HTTP :9222) ...
[tunnel] bridge ready (http://127.0.0.1:9222)
[tunnel] 起 quick tunnel → http://localhost:9222（唔使 domain，URL 每次重開都變）
==================================================================
 bridge 公眾 URL（複製落 POS 設定 → 橋接 URL）：
   https://XXXX-XXXX.trycloudflare.com
==================================================================
[tunnel] 已寫入 /data/data/com.termux/files/home/print-bridge/.tunnel-url.txt
```

**複製呢條 `https://....trycloudflare.com` URL。**

> Quick Tunnel 嘅 URL **每次重開都會變**（例如手機重啟）。試用無妨；
> 想固定 URL 見第 7 節 named tunnel。
> URL 亦會自動寫入 `.tunnel-url.txt`，方便你 `cat .tunnel-url.txt` 抄。

---

## 5. POS 設定：貼入橋接 URL

1. 開 POS（Vercel 網址）→ 設定 → 設備設定。
2. 「橋接 URL」欄貼入 `https://XXXX-XXXX.trycloudflare.com`（唔使加 `/health` 等路徑）。
3. 健康檢查應變 **綠色「已連線」**，顯示 bridge 版本同打印機數量。
4. 做一張測試單 → 廚房／收據打印機出紙即代表通咗。

> POS 端 `getPrintBridgeUrl()` 接受任何 `https://` URL，無 scheme 限制，Tunnel URL 直接過到
> `/health`、`/config`、`/print`、`/test-print` 全部路由。

---

## 6. 斷線／重啟行為

| 情況 | 結果 |
|------|------|
| Vercel / 互聯網斷 | offline mode 照開單；打印暫留隊列，網一回來 Tunnel 恢復即補印 |
| 手機熄唔關 Tunnel（重啟） | quick URL 變咗，要將新 URL 再貼入 POS；或行第 7 節固定 URL |
| 打印機關機 | bridge 連唔到 `IP:9100`，POS 顯示橋接離線，開單照常 |

---

## 7. 固定 URL（named tunnel，可選 · 需要 domain）

Quick Tunnel URL 會變，對「店主零操作」係個小麻煩。如果你想 **固定 URL**，要有一個 domain（任何 registrar 都行，
最簡單喺 Cloudflare 買，DNS 一併搞掂）：

```bash
# 1) 登入 Cloudflare（只做一次，要 domain 喺 Cloudflare 託管）
cloudflared login        # 彈出瀏覽器授權，揀你嘅 domain

# 2) 喺 print-bridge/.env 設：
#    PRINT_BRIDGE_TUNNEL_MODE=named
#    PRINT_BRIDGE_TUNNEL_NAME=macau-pos-bridge
#
# 3) 喺 Cloudflare Dashboard → Zero Trust → Networks → Tunnels
#    建立 tunnel（名 macau-pos-bridge），加 Public Hostname：
#      bridge.你嘅domain.com  →  http://localhost:9222
#    （或者 start-tunnel.sh 會用 --url 自動幫你 create）

# 4) 再起（named 模式會用固定 URL）
bash scripts/start-tunnel.sh
# → POS 設定填 https://bridge.你嘅domain.com （固定，永遠唔使再改）
```

---

## 8. 開機自啟（Termux:Boot，店主零日常操作）

1. 安裝 **Termux:Boot** APK（F-Droid / GitHub releases）。
2. 喺 Termux 建立 boot script：

```bash
mkdir -p ~/.termux/boot
cat << 'EOF' > ~/.termux/boot/start-print-tunnel.sh
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/print-bridge
bash scripts/start-tunnel.sh
EOF
chmod +x ~/.termux/boot/start-print-tunnel.sh
```

3. 手機重啟 → Termux:Boot 自動跑，bridge + Tunnel 自己起。
   （named tunnel 模式 URL 固定，重啟都唔使再貼 POS；quick 模式重啟 URL 會變，要再貼一次。）

---

## 9. 排錯 FAQ

**Q: `cloudflared: command not found`**
A: 第 2 節未裝好，或者 `install cloudflared $PREFIX/bin/` 冇成功。重做第 2 節，`cloudflared --version` 有嘢出先算。

**Q: 起咗 Tunnel 但 POS 健康檢查紅色／`Failed to fetch`**
A: 檢查
- 手機本身上唔上到網（Tunnel 要互聯網）；
- URL 有冇連錯（唔好加 `http://` 前綴，直接 `https://....trycloudflare.com`）；
- 手機 Termux 入面 `curl https://....trycloudflare.com/health` 睇下有冇 JSON 返出嚟。

**Q: URL 可以開但 `/print` 冇反應**
A: bridge 連唔到打印機。檢查打印機同手機同一 WiFi、IP 正確、端口 9100 開放、打印機開咗機。

**Q: Quick Tunnel 好慢／節點遠**
A: 免費 quick tunnel 節點隨機。按 `Ctrl+C` 重跑 `start-tunnel.sh` 會換新 URL + 新節點，試到滿意。
想穩定快，行第 7 節 named tunnel（可揀離澳門近嘅節點）。

**Q: 手機要唔要 root？**
A: 唔使。Termux + cloudflared 喺 user space 跑就夠。

**Q: 安全嗎？**
A: Tunnel 只開 **出站** 連線（bridge → Cloudflare），唔使喺防火牆開入站 port。
URL 係隨機長字串，等於一把匙；想再穩陣可以用 named tunnel + Cloudflare Access 加密。

---

## 10. 與其他文檔關係

- `docs/33-print-bridge-https-lan.md` — Path ② 自管證書（店主太重，唔推薦但合法）
- `docs/34-on-prem-single-shop-deployment.md` — on-prem（斷網照印，但要搬 app，備用）
- `print-bridge/README.md` — 總覽，含本 Path X 摘要
- `print-bridge/scripts/start-tunnel.sh` — 本方案一鍵腳本
- `src/lib/print-bridge/client.ts` — POS 端 `getPrintBridgeUrl()` 已接受任何 `https://` URL
