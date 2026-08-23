# 48 · Macau POS Desktop Shell 架構（Electron 包 Vercel 網頁 + 內嵌打印代理）

> 目標：將 POS 變成一個「雙撃就開嘅桌面 app」，唔使瀏覽器、唔使 Sunmi 中端，
> 經 USB / LAN / 藍芽打印；網頁更新只 `git push` 去 Vercel，**唔使重打包 exe**。

## 1. 核心原則（先講清楚，避免誤解）

1. **網頁（前端 + Next.js API）唔落 exe。** BrowserWindow 直接 `loadURL(Vercel)`。
   網頁任何改動 → Vercel 重建 → 用戶下次開 exe 自動係新版。**呢部分已經係「熱更新」，
   唔使任何按鈕、唔使重打包。**
2. **exe 只包：Electron runtime（Chromium + Node）+ companion 源碼 + 自動配對邏輯。**
3. **唯一要重打包嘅情形**：companion / runtime 本身改動（例如加 USB / BT 支援、改端口、
   改協議）。呢啲先需要「檢查更新」拉新安裝包覆蓋安裝。
4. **冇「運行中 hot-patch」**：Windows 落緊嘅 exe 被鎖，唔能原地替換 binary。
   「更新」= 下載最新 installer → 執行 → NSIS 覆蓋安裝 → 重啟（electron-updater / Squirrel 模式）。

## 2. 架構圖

```
┌─ macau-pos-desktop.exe (Electron) ───────────────────────────┐
│                                                                 │
│  main process                                                   │
│   ├─ startCompanionServer()  → localhost:9311 (loopback 雙棧)   │
│   ├─ tray icon（顯示 / 檢查更新 / 退出）                         │
│   └─ electron-updater（檢查更新、下載、quitAndInstall）         │
│                                                                 │
│  BrowserWindow (Chromium)                                       │
│   └─ loadURL(DESKTOP_POS_URL || https://macau-pos-system.vercel.app) │
│                                                                 │
│  status.html（獨立視窗，更新用；平時唔開）                       │
└───────────────────────────────────────────────┬─────────────┘
                                                  │ fetch http://127.0.0.1:9311/api/print
                                                  ▼
                                       Companion 用 OS 權限打 LAN:9100 / USB / BT
                                                  │
                                                  ▼
                                      打印機（同 LAN 或本機 USB / BT）

        ▲ 網頁（Vercel）本身獨立更新，唔經 exe
        │ git push → Vercel rebuild → 用戶下次開 exe 載到新版
```

## 3. 打印點整合進 Electron

- POS 網頁嘅 `companion-transport.ts` 已經 `fetch('http://127.0.0.1:9311/api/print')`
  （見 `src/lib/print-bridge/companion-transport.ts`）。呢個協議**不變**，網頁側零改動。
- Electron main process 起跑 `startCompanionServer()`（嚟自 `companion-server.mjs`），
  佢喺 localhost:9311 聽，按 `printer.connectionType` 分派：
  - **LAN** ✅ 已做：`net.connect(ip, 9100)` 送 ESC/POS。
  - **USB** ❌ stub → 要加 `usb` / `node-usb`，將 `connectionType==='usb'` 分支變真實
    `outEndpoint.transfer(escPosBuffer)`。
  - **藍芽** ❌ stub → 兩條路：
    - (a) Windows 將配對咗嘅 BT 打印機當虛擬 COM port → 經 `serialport` 打（最穩、最常用）；
    - (b) `bluetooth-hci-socket` / `noble` 直接講 BT。
- 網頁**完全唔使知** USB/BT 點打——佢只 `fetch` 去 companion，所有硬件邏輯留喺 companion。
  所以 USB/BT 實作＝companion 側嘅 Node 依賴，網頁零改動（但呢次加完就要重打包 exe）。

## 4. 網頁 ↔ Electron 分離（更新唔使重打包）

| 層 | 喺邊 | 更新方式 | 要唔要重打包 exe |
|---|---|---|---|
| 前端 React 頁面 | Vercel | `git push` | ❌ 唔使 |
| Next.js API routes | Vercel（Serverless） | `git push` | ❌ 唔使 |
| Supabase 資料 | Supabase 雲 | 雲端 migration | ❌ 唔使 |
| Electron 殼 + Chromium | exe | electron-updater 拉 installer | ✅ 要 |
| companion（打印代理） | exe 入面 | 同上（同一個 installer） | ✅ 要 |

- `DESKTOP_POS_URL` 環境變數可切換載邊個網址（開發 `http://localhost:3000`，預設 Vercel）。
- 協議穩定化：(`/api/print` request/response) 寫成 contract，網頁同 companion 各自遵守，
  兩邊可獨立發佈。改協議先需要協調雙方 + 重打包。

## 5. 自動更新（檢查更新）實作

- 依賴：`electron-updater` + `update-electron-app`。
- 發佈後端：**generic provider**（= 一個 HTTPS 靜態檔案伺服器，放 `latest.yml` +
  `macau-pos-desktop-setup-x.y.z.exe`）。`package.json` 嘅 `build.publish.url` 預設：
  `https://macau-pos.example.com/releases/${os}/${arch}/${version}`（**要換成你真正嘅 host**）。
  可選替代：GitHub Releases（將 provider 改 `"github"`，`owner/repo`）、或者 S3/Cloudflare R2。
- 流程：
  1. 你 `npm run dist` 產 `dist/macau-pos-desktop-setup.exe` + `dist/latest.yml`。
  2. 將佢哋上傳去 publish url（例如 `https://你的host/releases/win/x64/0.2.0/`）。
  3. 用戶 APP 內撳「檢查更新」→ `autoUpdater.checkForUpdates()` → 有新版就下載 →
     `update-downloaded` → 撳「安裝並重啟」→ `autoUpdater.quitAndInstall()` →
     NSIS 覆蓋安裝 → 重啟。
  4. `latest.yml` 嘅 `sha512` 做完整性校驗；建議加 `publisherName` 做程式碼簽署（Smartscreen 唔彈警告）。
- `version` 喺 `package.json` 升咗先會觸發更新；記得每次發佈 bump version。

### 關鍵代碼位（已實作）
- `electron/main.js`：`updateElectronApp({...})` 自動後台探更新；`ipcMain.handle('check-update' /
  'quit-and-install' / 'get-app-version')`；tray「檢查更新」；啟動 3 秒後自動探一次。
- `electron/preload.js`：暴露 `companionShell.getVersion / checkUpdate / quitAndInstall / onUpdateStatus`。
- `electron/status.html`：更新 UI（版本、狀態點、檢查鈕、安裝鈕），由 `update-status` IPC 驅動。

## 6. 開發 vs 生產
- `npm start`：dev，跳過自動更新（`app.isPackaged` false）。想喺 dev 試更新設 `ELECTRON_UPDATE_DEV=1`
  且 publish url 要有檔。
- `npm run dist`：打包 NSIS installer（`perMachine: true` 俾覆蓋安裝順啟）；`dist/` 出
  `macau-pos-desktop-setup.exe` + `latest.yml`。

## 7. 注意 / 限制
- **冇真正 hot-patch**：更新＝落 installer 覆蓋。呢個係 Windows 嘅必然，唔係缺陷。
- **網頁要網絡**：Vercel 網頁要連網先載到（你要「更新只 push 網頁」即係接受呢點）。
  若要完全離線開 POS，要 PWA service worker 緩存 static（另一層，未做）。
- **SERVICE_ROLE_KEY 唔落 exe**：所有密鑰留雲端（Supabase anon key 本來公開、RLS 保護）。
- **程式碼簽署**：正式發佈建議加 cert（`build.win.certificateSubjectName` 或 `cscLink`），否則用戶會見 Smartscreen 警告。
- **USB/BT 仲係 stub**：呢次 shell 做到「載網頁 + LAN 打印 + 檢查更新」；USB/BT 要再落 companion
  實作（屬 P2.2 / P2.3，未做）。

## 8. 下一步（未做）
- 加 USB / BT 實作（`usb` / `serialport`）。
- 接你真正嘅 release host（將 `build.publish.url` 換掉）+ 程式碼簽署。
- 可選：用 `latest.yml` 喺狀態頁顯示「目前 / 最新版本」對比。
- 可選：PWA offline 緩存令完全離線都開到 POS 網頁。
