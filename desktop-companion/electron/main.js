// Macau POS Desktop —— Electron 殼（見 docs/48-desktop-shell-architecture.md）。
//
// 職責：
//   1) 主進程起跑 companion-server（localhost:9311，俾網頁經 OS 權限打印 LAN/USB/BT）
//   2) BrowserWindow 直接載 Vercel 上嘅 POS 網頁（網頁唔落 exe → 更新只 push Vercel，唔使重打包）
//   3) tray（顯示 / 檢查更新 / 退出）
//   4) 內建「檢查更新」：經 electron-updater 拉最新安裝包並覆蓋安裝（runtime/companion 更新先需要）
//   5) 下載觸發：用家撳「檢查更新」→ 有更新 → 撳「下載」→ autoUpdater.downloadUpdate() →
//      download-progress 推百分比 → update-downloaded → 撳「安裝並重啟」→ quitAndInstall()
//
// 環境變數：
//   DESKTOP_POS_URL  —— 想載嘅 POS 網址（開發用 http://localhost:3000；預設 Vercel）

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCompanionServer } from "../companion-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POS_URL = process.env.DESKTOP_POS_URL || "https://macau-pos-system.vercel.app";
const APP_VERSION = app.getVersion();

let win = null;
let tray = null;
let updateState = { status: "idle", info: "", updateInfo: null, progress: 0 };
let autoUpdater = null; // 懶載入，dev 唔裝都唔會報錯

// ---- 內建自動更新（electron-updater；prod 先生效，dev 跳過）----
// 用 autoUpdater 直接 API（唔用 update-electron-app，避免佢自己註冊 listener 同我哋手動 check 打架）。
// 想喺開發版試更新：設 ELECTRON_UPDATE_DEV=1
function setupAutoUpdater() {
  if (!app.isPackaged && !process.env.ELECTRON_UPDATE_DEV) {
    console.log("[macau-pos] 開發模式：跳過自動更新（prod 先生效）");
    return;
  }
  import("electron-updater")
    .then(({ autoUpdater: au }) => {
      autoUpdater = au;
      // 開發時設咗才喺本地 generic server 試；prod 用 package.json 嘅 publish
      autoUpdater.autoDownload = false; // 手動「檢查更新」先落，唔背後偷落
      autoUpdater.autoInstallOnAppQuit = true; // 落咗就喺 app 退出時裝
      autoUpdater.logger = {
        info: (m) => console.log("[updater]", m),
        warn: (m) => console.warn("[updater]", m),
        error: (m) => console.error("[updater]", m),
      };
      autoUpdater.on("update-available", (i) => {
        pushUpdateStatus("available", `有更新 v${i.version || ""}`, {
          updateInfo: {
            version: i.version || "",
            releaseNotes: i.releaseNotes || "",
            releaseDate: i.releaseDate || "",
          },
        });
      });
      autoUpdater.on("update-not-available", () =>
        pushUpdateStatus("latest", "已經係最新版本"),
      );
      autoUpdater.on("download-progress", (p) => {
        const pct = Math.round(p.percent || 0);
        pushUpdateStatus("downloading", `下載中 ${pct}%`, { progress: pct });
      });
      autoUpdater.on("update-downloaded", () =>
        pushUpdateStatus("downloaded", "下載完成，可安裝"),
      );
      autoUpdater.on("error", (e) =>
        pushUpdateStatus("error", e?.message || "更新失敗"),
      );
      console.log("[macau-pos] autoUpdater 已註冊（url =", autoUpdater.getFeedURL?.() || "(publish)", ")");
    })
    .catch((e) => console.warn("[macau-pos] autoUpdater 未載入：", e.message));
}

// 1x1 透明 PNG fallback（用家可自行放 icon.png 覆蓋）
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function pushUpdateStatus(status, info, extra = {}) {
  // 保留之前已有嘅 updateInfo / progress（除非今次明確傳咗新值）
  updateState = {
    status,
    info: info || "",
    updateInfo: extra.updateInfo !== undefined ? extra.updateInfo : updateState.updateInfo ?? null,
    progress: extra.progress !== undefined ? extra.progress : (updateState.progress ?? 0),
  };
  if (win && !win.isDestroyed()) {
    win.webContents.send("update-status", updateState);
  }
}

function createWindow() {
  // 收銀機 / POS 終端機模式：全屏 kiosk，唔使標題列、唔使關閉鈕（用 tray 退出）。
  // 想喺開發版試非全屏：設 DESKTOP_POS_URL 同時設 KIOSK=0（或 ELECTRON_UPDATE_DEV=1 都唔會 kiosk）。
  const kiosk = !(process.env.KIOSK === "0");
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Macau POS",
    show: false,
    kiosk, // 全屏鎖定，收銀專用
    autoHideMenuBar: true, // 隱藏 menu bar（F10/F12 都冇開發者工具入口）
    fullscreen: kiosk, // 雙重保險：真·全屏
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false, // 關死開發者工具（prod 一定 off）
    },
  });
  // 關死右鍵選單（唔俾 inspect / view source）
  win.setMenuBarVisibility(false);
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

// ---- 管理員退出捷徑（kiosk 模式冇標題列，留一個後備退出通道）----
// Ctrl+Shift+Q / Cmd+Shift+Q：直接退出（管理員先知，員工唔會撳）。
// 唔係「開發者工具」，純粹收銀機維護出口。
function registerAdminShortcuts() {
  import("electron")
    .then(({ globalShortcut }) => {
      const ok = globalShortcut.register("CommandOrControl+Shift+Q", () => {
        app.isQuiting = true;
        app.quit();
      });
      if (!ok) console.warn("[macau-pos] 註冊退出捷徑失敗（可能已被佔用）");
    })
    .catch(() => {});
}

// ---- 檢查更新 IPC（由 POS 內「檢查更新」面板 / tray 觸發）----
function checkForUpdates() {
  pushUpdateStatus("checking", "正在檢查更新…");
  if (!autoUpdater) {
    import("electron-updater")
      .then(({ autoUpdater: au }) => {
        autoUpdater = au;
        autoUpdater.checkForUpdates();
      })
      .catch(() => pushUpdateStatus("error", "更新模組未載入"));
    return;
  }
  autoUpdater.checkForUpdates();
}

ipcMain.handle("get-app-version", () => APP_VERSION);
ipcMain.handle("check-update", () => {
  checkForUpdates();
  return updateState;
});
ipcMain.handle("download-update", () => {
  if (!autoUpdater) {
    pushUpdateStatus("error", "更新模組未載入");
    return { ok: false, error: "autoUpdater 未載入" };
  }
  pushUpdateStatus("downloading", "開始下載…");
  autoUpdater.downloadUpdate();
  return { ok: true };
});
ipcMain.handle("quit-and-install", () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
  else app.quit();
});

app.whenReady().then(() => {
  setupAutoUpdater();
  startCompanionServer();
  createWindow();
  createTray();
  registerAdminShortcuts();
  // 首次啟動自動探一次更新（prod）；有更新就會推狀態去 POS，用家自行決定裝
  if (app.isPackaged || process.env.ELECTRON_UPDATE_DEV) {
    setTimeout(checkForUpdates, 3000);
  }
});

app.on("window-all-closed", (e) => e.preventDefault()); // keep alive，用 tray 退出
app.on("activate", () => win && win.show());
