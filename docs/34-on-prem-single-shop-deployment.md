> ⚠️ **已取代（Deprecated）**：本文件嘅 on-prem 單店部署方案（POS app + bridge 都搬落店內手機跑本地 HTTP）已經被 **Native Print Agent（`print-agent-android`）** 取代——POS 直接喺 Android WebView 外殼入面跑，經 `PosNative` bridge 原生打印，斷網照印、店主零操作，唔使再搞 on-prem / mixed content / 證書。見 [`docs/36-native-print-agent.md`](./36-native-print-agent.md)。以下內容只作歷史參考。

# 34 · On-prem 單店部署（斷網照印 · 店主零操作）

## 點解係呢條路

你嘅兩個要求夾唔埋，必須二揀一：

- 「互聯網 / Vercel 斷咗都照印花」→ 打印成條鏈（連埋 POS app）一定要喺店內 LAN 內。
- 「keep Vercel 載 app」→ HTTPS app 唔可以連本地 HTTP bridge（mixed content）。

結論：**要真正斷網照印，app + bridge 都要留喺店內 LAN 用 HTTP（全 on-prem）**。Vercel 喺呢個方案只係做 build，唔再係運行依賴。呢個係唯一滿足「斷網照印」嘅做法，同時令之前搞咗嘅 HTTPS / 證書 / DNS 全部唔使做。

相關：雲端 HTTPS 方案（Vercel + bridge HTTPS）見 `docs/33-print-bridge-https-lan.md`，只適用於「網絡在就正常」嘅場景，斷網一樣印唔到。

---

## 架構（單店）

```
店內 LAN（互聯網斷咗都照跑）
┌──────────────────────────────────────────────────────────┐
│  部手機（Termux）同時跑兩個服務：                          │
│    • print-bridge   http://192.168.31.106:9222   (ESC/POS)│
│    • app-server     http://192.168.31.106:3000   (靜態)   │
└───────────────┬───────────────────┬──────────────────────┘
                │ 瀏覽器載 app       │ 打印 job
                ▼                    ▼
         Sunmi POS 終端       廚房/收銀打印機
         http://192.168...:3000  192.168.31.38:9100
                │
                │ 有網先背景 sync
                ▼
         Supabase / Ledger（雲，可選）
```

- POS app 由 `http://192.168.31.106:3000` 載（本地 HTTP，唔使 Vercel 喺運行時在）。
- Bridge 係本地 HTTP `:9222`，app 喺同一個 HTTP origin 下連佢，**無 mixed content**。
- 互聯網斷 → 開單 + 印花照常；雲端只喺有網時背景同步，數據唔會唔見。

---

## 你部機要準備咩

- 一部長開嘅設備跑伺服器：你已經用緊嘅**手機（Termux）**就最慳，bridge + app-server 都喺度跑。
- Sunmi Android POS 終端：開內置瀏覽器（或 WebView / kiosk app）去 `http://192.168.31.106:3000`。
- 打印機 `192.168.31.38:9100`（你已經 set 好）。

> 手機做伺服器要長開：裝 `termux-boot` + `termux-wake-lock`，開機自啟 `start-all.sh`。

---

## 開發者做（你部 dev box，一次過）

POS app 要可以靜態匯出，喺部機度用 `app-server.mjs` serve。Next.js 有兩個做法：

**A. 靜態匯出（最輕，推薦用手機）**
- `next.config` 加 `output: "export"`，`next build` 會出 `out/` 目錄。
- 注意：靜態匯出**唔支援 API routes**。現有 `/api/pos/device-config` 呢類要搬去 client-side（直接寫 localStorage + push 去 bridge）或改叫 Supabase Edge Function。POS 主體係 React + Supabase client-side，搬到靜態多數冇大問題。
- 匯出後 `out/` 抄去部機 `~/pos-app-dist/`。

**B. Standalone（功能齊但重啲）**
- `next.config` 加 `output: "standalone"`，build 出 `node_modules/.next/standalone`，部機用 `node server.js` 跑（要 Node）。手機跑 Next standalone 偏重，單店可以，但留意資源。

兩者選 A 就夠。匯出後 copy 去部機：

```bash
# dev box
npm run build            # output: "export" → out/
scp -r out/ phone:~/pos-app-dist    # 或用 USB / AirDroid / 雲碟抄過去
```

---

## 部機做（手機 Termux，一次過 set 好）

```bash
# 1) 入到 print-bridge 目錄（你之前個 repo）
cd ~/macauPos/print-bridge      # 按你實際路徑改

# 2) 確保有 Node（Termux）
pkg install -y nodejs-lts

# 3) 一個 command 起哂 bridge + app-server
bash start-all.sh
```

`start-all.sh` 會：
- `export PRINT_BRIDGE_TLS=0`（on-prem 用 HTTP，唔使證書）
- 起 `src/server.mjs`（bridge :9222）
- 起 `app-server.mjs`（:3000，serve `~/pos-app-dist` 或 `print-bridge/app-dist`）

出面會印住 Sunmi 要開嘅 URL，例如 `http://192.168.31.106:3000`。

---

## Sunmi 終端（一次過）

1. 開瀏覽器去 `http://192.168.31.106:3000`（建議加到主頁 / kiosk）。
2. 登入 POS，正常開單。
3. 打印 → app 自動連 `http://192.168.31.106:9222`（見下面「零配置」）→ 出廚房單。

---

## 零配置：bridge URL 自動推斷

`on-prem` 模式下，POS app 本身係由 LAN IP 載嘅。 `src/lib/print-bridge/client.ts` 嘅 `getPrintBridgeUrl()` 已加咗 fallback：

- 當 app 由 IP（例如 `192.168.31.106`）載、而無 device override 又無 `NEXT_PUBLIC_PRINT_BRIDGE_URL` 時，
  自動用 `http://<同個 IP>:9222` 做 bridge。

即係店主**完全唔使填 bridge URL**，開咗 app 就自動連到同一部機嘅 bridge。想 override 就喺 POS 設定頁填（例：`http://192.168.31.106:9222`）。

---

## 斷網 / 離線行為

| 情況 | 結果 |
|------|------|
| 互聯網斷 | 開單 + 印花照常（全 LAN 內） |
| Vercel 死 | 唔影響（app 已經由本地 :3000 載） |
| 雲端 Supabase 斷 | 本地繼續做，網返嚟自動補 sync |
| 部手機重啟 | `termux-boot` 自啟 `start-all.sh` 後恢復 |
| 打印機關 | 物理問題，與方案無關 |

---

## 更新流程（取代 Vercel 運行）

Vercel 只做 build：

1. dev box `npm run build`（output: export）→ `out/`
2. copy `out/` 去部機 `~/pos-app-dist/`
3. 部機 `pkill -f app-server.mjs && bash start-all.sh`（或 restart termux）

如果想再懶啲，可以係部機加個 `upgrade.sh` 由 GitHub Release 拉最新 `out.tar.gz` 自動覆蓋。

---

## 店主日常操作（重點：零操作）

- 部手機長開 + 已設開機自啟 → 店主乜都不用理。
- 無證書、無 DNS、無 router 設定、無逐部機裝嘢。
- 只有「部機冇電 / 重啟」先需要郁手，開咗 `start-all.sh` 就返晒嚟。

---

## 與之前 HTTPS 方案嘅關係

- `docs/33` + `server.mjs` 嘅 TLS 能力**保留**，但 on-prem 用唔到（我哋刻意 `TLS=0`）。
- 如果將來想轉返「Vercel app + 雲端 HTTPS bridge（Tunnel / Supabase 中繼）」，server 已支援，只需按 `docs/33` 開 TLS + 改 POS 用 HTTPS URL。但嗰條路斷網就印唔到，所以單店呢度揀咗 on-prem。
