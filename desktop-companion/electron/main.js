// Macau POS Desktop Companion —— Electron 包裝層（見 docs/47 §6）。
//
// 職責：
//   1) 喺 main process 起跑 companion-server（同 standalone node 共用核心）
//   2) 開一個 BrowserWindow 顯示 http://127.0.0.1:9311/ 狀態網頁（唔會閃退、關咗收去 tray）
//   3) 加 tray icon（顯示 / 退出），令普通用戶唔使開終端機
//
// 打包：npm run dist → electron-builder 產 desktop-companion-setup.exe（NSIS 安裝檔）。

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCompanionServer } from "../companion-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let tray = null;

// 1x1 透明 PNG fallback（用家可自行放 icon.png 覆蓋）
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 560,
    title: "Macau POS Companion",
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });
  win.loadURL("http://127.0.0.1:9311/");
  win.once("ready-to-show", () => win.show());
  // 關窗唔退出，收去 tray（代理繼續喺背景跑）
  win.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  let img;
  try {
    img = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
  } catch {
    img = null;
  }
  if (img && !img.isEmpty()) {
    // 用 icon.png
  } else {
    img = nativeImage.createFromDataURL(FALLBACK_ICON);
  }
  tray = new Tray(img);
  tray.setToolTip("Macau POS Companion");
  tray.on("click", () => (win ? win.show() : null));
  const ctx = Menu.buildFromTemplate([
    { label: "顯示 Companion", click: () => win && win.show() },
    { type: "separator" },
    {
      label: "退出 Companion",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(ctx);
}

app.whenReady().then(() => {
  startCompanionServer();
  createWindow();
  createTray();
});

app.on("window-all-closed", (e) => {
  // 唔退出，keep alive（代理繼續跑）；用 tray 退出
  e.preventDefault();
});

app.on("activate", () => {
  if (win) win.show();
});
