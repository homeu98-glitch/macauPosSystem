// Macau POS Desktop Companion —— standalone CLI 入口。
//
// 真正嘅伺服器邏輯喺 companion-server.mjs（俾 Electron 共用）。
// 跑法：
//   cd desktop-companion
//   npm install        # 裝 iconv-lite（唔裝都跑得，會 fallback utf-8）
//   node server.mjs    # 或 npm start
//
// 想打包成 exe 安裝檔 → 見 README「打包成安裝檔」一節（electron-builder）。

import { startCompanionServer } from "./companion-server.mjs";

startCompanionServer();
