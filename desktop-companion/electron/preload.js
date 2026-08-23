// Electron preload —— 喺狀態網頁同 main process 之間提供安全橋接。
// contextIsolation: true，所以用 contextBridge 暴露有限 API。

import { contextBridge, shell, app } from "electron";

contextBridge.exposeInMainWorld("companionShell", {
  // 一鍵配對：喺用戶預設瀏覽器開 POS（帶 ?companion= 參數，POS 會自動寫入配對）
  openExternal: (url) => {
    if (url && typeof url === "string") shell.openExternal(url);
  },
  // 由狀態頁退出整個 Companion
  quit: () => app.quit(),
});
