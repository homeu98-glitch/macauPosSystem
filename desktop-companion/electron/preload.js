// Electron preload —— 狀態頁同 main process 之間嘅安全橋接。
// contextIsolation: true，所以用 contextBridge 暴露有限 API。

import { contextBridge, shell, app, ipcRenderer } from "electron";

// 注意：本 preload 同時服務「POS 網頁」（BrowserWindow 載 Vercel）同「status.html」。
// 兩者都用到 companionShell.* API（openExternal / quit / 更新）；POS 網頁額外用 getVersion/checkUpdate 等。

contextBridge.exposeInMainWorld("companionShell", {
  // 開外部瀏覽器（備用；一般唔使，因為視窗已經載 POS）
  openExternal: (url) => {
    if (url && typeof url === "string") shell.openExternal(url);
  },
  // 退出整個 app
  quit: () => app.quit(),
  // 讀 App 版本
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  // 手動檢查更新 → 返更新狀態（含 updateInfo / progress）
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  // 觸發下載（checkUpdate 返 status="available" 後用家撳「下載」）
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  // 下載完成後安裝並重啟
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  // main 推送更新狀態（autoUpdater 事件）
  onUpdateStatus: (cb) => {
    if (typeof cb === "function") {
      ipcRenderer.on("update-status", (_e, state) => cb(state));
    }
  },
});
