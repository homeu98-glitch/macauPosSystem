// Macau POS Desktop —— Electron 殼（見 docs/48-desktop-shell-architecture.md）。
//
// 職責：
//   1) 主進程起跑 companion-server（localhost:9311，俾網頁經 OS 權限打印 LAN/USB/BT）
//   2) BrowserWindow 直接載 Vercel 上嘅 POS 網頁（網頁唔落 exe → 更新只 push Vercel，唔使重打包）
//   3) tray（顯示 / 檢查更新 / 退出）
//   4) 內建「檢查更新」：經 electron-updater 拉最新安裝包並覆蓋安裝（runtime/companion 更新先需要）
//
// 環境變數：
//   DESKTOP_POS_URL  —— 想載嘅 POS 網址（開發用 http://localhost:3000；預設 Vercel）

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCompanionServer } from "../companion-server.mjs";
import { updateElectronApp } from "update-electron-app";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POS_URL = process.env.DESKTOP_POS_URL || "https://macau-pos-system.vercel.app";
const APP_VERSION = app.getVersion();

let win = null;
let tray = null;
let updateState = { status: "idle", info: "" };

// ---- 內建自動更新（electron-updater；prod 先生效，dev 跳過）----
// 想喺開發版試更新：設 ELECTRON_UPDATE_DEV=1
if (!app.isPackaged && !process.env.ELECTRON_UPDATE_DEV) {
  console.log("[macau-pos] 開發模式：跳過自動更新（prod 先生效）");
} else {
  updateElectronApp({
    updateInterval: "1 hour",
    logger: {
      info: (m) => console.log("[updater]", m),
      warn: (m) => console.warn("[updater]", m),
      error: (m) => console.error("[updater]", m),
    },
    notifyUser: false, // 我哋自己經 IPC 顯示狀態，唔用預設彈窗
  });
}

// 1x1 透明 PNG fallback（用家可自行放 icon.png 覆蓋）
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function pushUpdateStatus(status, info) {
  updateState = { status, info: info || "" };
  if (win && !win.isDestroyed()) {
    win.webContents.send("update-status", updateState);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Macau POS",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 載 Vercel 網頁；server 未 ready 就重試，避免空白
  let loadAttempts = 0;
  const loadPos = () => {
    loadAttempts += 1;
    win.loadURL(POS_URL);
  };
  win.webContents.on("did-fail-load", () => {
    if (loadAttempts < 6) setTimeout(loadPos, 600);
  });
  loadPos();
  win.once("ready-to-show", () => win.show());
  // 關窗唔退出，收去 tray（companion 繼續跑）
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
  if (!img || img.isEmpty()) img = nativeImage.createFromDataURL(FALLBACK_ICON);
  tray = new Tray(img);
  tray.setToolTip("Macau POS Desktop");
  tray.on("click", () => (win ? win.show() : null));
  const ctx = Menu.buildFromTemplate([
    { label: "顯示 Macau POS", click: () => win && win.show() },
    { label: "檢查更新", click: () => checkForUpdates() },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(ctx);
}

// ---- 檢查更新 IPC（由 status 頁 / tray 觸發）----
function checkForUpdates() {
  pushUpdateStatus("checking", "正在檢查更新…");
  // update-electron-app 內部用 autoUpdater；手動 check 靠佢註冊嘅事件
  // electron-updater 冇直接 check() export，呢度用 autoUpdater.checkForUpdates()
  try {
    // dynamic import 避免 dev 未裝時報錯
    import("electron-updater")
      .then(({ autoUpdater }) => {
        autoUpdater.on("update-available", (i) =>
          pushUpdateStatus("available", `有更新 ${i.version || ""}`),
        );
        autoUpdater.on("update-not-available", () =>
          pushUpdateStatus("latest", "已經係最新版本"),
        );
        autoUpdater.on("download-progress", (p) =>
          pushUpdateStatus("downloading", `下載中 ${Math.round((p.percent || 0))}%`),
        );
        autoUpdater.on("update-downloaded", () =>
          pushUpdateStatus("downloaded", "下載完成，可安裝"),
        );
        autoUpdater.on("error", (e) => pushUpdateStatus("error", e?.message || "更新失敗"));
        autoUpdater.checkForUpdates();
      })
      .catch((e) => pushUpdateStatus("error", "更新模組未載入：" + e.message));
  } catch (e) {
    pushUpdateStatus("error", String(e));
  }
}

ipcMain.handle("get-app-version", () => APP_VERSION);
ipcMain.handle("check-update", () => {
  checkForUpdates();
  return updateState;
});
ipcMain.handle("quit-and-install", () => {
  try {
    import("electron-updater").then(({ autoUpdater }) => autoUpdater.quitAndInstall());
  } catch {
    app.quit();
  }
});

app.whenReady().then(() => {
  startCompanionServer();
  createWindow();
  createTray();
  // 首次啟動自動探一次更新（prod）
  if (app.isPackaged || process.env.ELECTRON_UPDATE_DEV) {
    setTimeout(checkForUpdates, 3000);
  }
});

app.on("window-all-closed", (e) => e.preventDefault()); // keep alive，用 tray 退出
app.on("activate", () => win && win.show());
