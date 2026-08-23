// Electron preload —— 狀態頁同 main process 之間嘅安全橋接。
// contextIsolation: true，所以用 contextBridge 暴露有限 API。

import { contextBridge, shell, app, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("companionShell", {
  // 開外部瀏覽器（備用；一般唔使，因為視窗已經載 POS）
  openExternal: (url) => {
    if (url && typeof url === "string") shell.openExternal(url);
  },
  // 退出整個 app
  quit: () => app.quit(),
  // 讀 App 版本
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  // 手動檢查更新 → 返更新狀態
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  // 下載完成後安裝並重啟
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  // main 推送更新狀態（由 update-electron-app / autoUpdater 事件）
  onUpdateStatus: (cb) => {
    if (typeof cb === "function") {
      ipcRenderer.on("update-status", (_e, state) => cb(state));
    }
  },
});
