// Macau POS Desktop Companion —— 可重用伺服器核心（見 docs/47）。
//
// 抽取自原 server.mjs，俾 standalone `node server.mjs` 同 Electron main 共用。
// 職責：綁 loopback（127.0.0.1 + ::1 雙棧），提供：
//   GET  /              → 狀態網頁介面（自動顯示連線狀態 + 一鍵開 POS 配對）
//   GET  /api/health    → { ok, version }
//   GET  /api/config    → { companionUrl, posUrl, tokenEnabled }（俾 POS 自動配對）
//   POST /api/print     → 收 ESC/POS job，經 OS 權限打到 LAN:9100（USB/BT 係 stub）
//
// 安全：只綁 loopback，網絡其他人連唔到；唔落 DB、唔寫盤（除 companion.config.json）。

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "companion.config.json");

// ---- 配置（companion.config.json 可覆寫）----
const cfg = {
  port: 9311,
  binding: "127.0.0.1", // 只作顯示用；實際 listen 用雙棧 loopback
  token: "",
  posUrl: "https://macau-pos-system.vercel.app", // 一鍵配對時開嘅 POS 網址
};
try {
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  Object.assign(cfg, file);
} catch {
  /* 無配置檔就用預設 */
}

// ---- iconv-lite 可選（中文 charset 編碼）----
let iconv = null;
try {
  iconv = (await import("iconv-lite")).default;
} catch {
  /* 未裝 iconv-lite：fallback utf-8 */
}

// ---- mDNS 自動發現 LAN 打印機（bonjour-service，純 JS 零原生依賴，bonjour 嘅持續維護 fork）----
// 掃描 ESC/POS 打印機常見 mDNS 服務：_printer._tcp / _escpos._tcp / _pdl-datastream._tcp（HP RAW:9100）
// 見 docs/50 P1。動態 import 避免 standalone server.mjs 無裝 bonjour-service 時崩。
let bonjourLib = null;
try {
  bonjourLib = (await import("bonjour-service")).default;
} catch {
  /* 未裝 bonjour-service：/api/discover 會回空，唔影響其他功能 */
}

function discoverPrinters(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!bonjourLib) {
      resolve([]);
      return;
    }
    const bonjour = new bonjourLib();
    const found = new Map();
    const services = ["_printer._tcp.local", "_escpos._tcp.local", "_pdl-datastream._tcp.local"];
    let pending = services.length;
    const done = () => {
      if (pending <= 0) finish();
    };
    const finish = () => {
      try {
        bonjour.destroy();
      } catch {}
      resolve([...found.values()]);
    };
    const onUp = (svc) => {
      const ip = (svc.addresses || []).find((a) => !a.startsWith(":")) || svc.host;
      if (!ip) return;
      const key = `${svc.name}@${ip}`;
      if (!found.has(key)) {
        found.set(key, {
          name: svc.name || ip,
          ip,
          port: svc.port || 9100,
          type: svc.type?.replace(".local", "") || "printer",
        });
      }
    };
    for (const s of services) {
      try {
        const browser = bonjour.find({ type: s.replace(".local", ""), protocol: "tcp" });
        browser.on("up", onUp);
        browser.on("error", () => {
          pending -= 1;
          done();
        });
        setTimeout(() => {
          pending -= 1;
          done();
        }, timeoutMs);
      } catch {
        pending -= 1;
        done();
      }
    }
    if (pending <= 0) finish();
  });
}

function encodeText(str, charset) {
  if (iconv) {
    try {
      return iconv.encode(str, charset || "utf-8");
    } catch {
      /* 唔支援嘅 charset：fallback utf-8 */
    }
  }
  return Buffer.from(str, "utf-8");
}

// ---- 最小 ESC/POS renderer（生產請替換成共用模組，見 docs/47 §4）----
function renderEscPos(job, printer) {
  const charset = printer.charset || "utf-8";
  const chunks = [];
  const push = (buf) => chunks.push(buf);

  push(Buffer.from([0x1b, 0x40])); // ESC @ init

  const line = (text, { bold = false, center = false } = {}) => {
    push(Buffer.from([0x1b, 0x61, center ? 1 : 0])); // ESC a align
    push(Buffer.from([0x1b, 0x45, bold ? 1 : 0])); // ESC E bold
    push(encodeText(text, charset));
    push(Buffer.from([0x0a])); // LF
  };

  line(job.storeName || printer.name || "Macau POS", { bold: true, center: true });
  push(Buffer.from([0x1b, 0x61, 0])); // 返 left
  push(Buffer.from([0x1b, 0x45, 0])); // 返 normal

  for (const it of job.items || []) {
    const text = it.note ? `${it.name}  ${it.note}` : it.name;
    const bold = /總計|合計|Total|應收/i.test(it.name || "");
    line(text, { bold });
  }

  push(Buffer.from([0x0a, 0x0a, 0x0a])); // feed
  push(Buffer.from([0x1d, 0x56, 0x00])); // GS V cut
  return Buffer.concat(chunks);
}

// ---- LAN 直打（TCP socket → IP:9100）----
function printLan(printer, buf) {
  return new Promise((resolve) => {
    const port = printer.lanPort || 9100;
    const ip = printer.ipAddress;
    if (!ip) {
      resolve({ ok: false, error: "LAN 打印機缺 ipAddress" });
      return;
    }
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve({ ok, error });
    };
    const sock = net.connect(port, ip, () => {
      sock.write(buf, () => {
        sock.end();
        finish(true);
      });
    });
    sock.on("error", (e) => finish(false, `打印機連線失敗：${e.code || e.message}`));
    sock.setTimeout(5000, () => finish(false, "打印機連線逾時"));
  });
}

// ---- USB 打印（node-usb，見 docs/50 P2）----
// 經 VID/PID 搵 device → 開 interface → 搵 outbound endpoint → transfer ESC/POS buffer。
let usbLib = null;
try {
  usbLib = (await import("usb")).default;
} catch {
  /* 未裝 usb：printUsb 會回錯 */
}

async function printUsb(printer, buf) {
  if (!usbLib) return { ok: false, error: "companion 未安裝 usb 套件（USB 打印停用）" };
  const vid = parseInt(String(printer.usbVendorId || "").replace(/^0x/, ""), 16);
  const pid = parseInt(String(printer.usbProductId || "").replace(/^0x/, ""), 16);
  if (!vid || !pid) return { ok: false, error: "USB 打印機缺 VID/PID" };
  const dev = usbLib.findByIds(vid, pid);
  if (!dev) return { ok: false, error: `搵唔到 USB 設備 ${printer.usbVendorId}:${printer.usbProductId}（確認已連接）` };
  try {
    dev.open();
    const iface = dev.interfaces[0];
    // 如果 kernel 已 claim，先 detach
    try {
      if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    } catch {}
    iface.claim();
    const outEp = iface.endpoints.find((ep) => ep.direction === "out" && ep.transferType === usbLib?.LIBUSB_TRANSFER_TYPE_BULK);
    if (!outEp) {
      iface.release(() => dev.close());
      return { ok: false, error: "USB 設備無 outbound bulk endpoint" };
    }
    await new Promise((resolveEp, rejectEp) => {
      outEp.transfer(buf, (err) => {
        if (err) rejectEp(new Error(`USB transfer 失敗：${err.errno || err.message}`));
        else resolveEp();
      });
    });
    iface.release(() => dev.close());
    return { ok: true };
  } catch (e) {
    try { dev.close(); } catch {}
    const msg = e instanceof Error ? e.message : "USB 打印失敗";
    // LIBUSB_ERROR_NOT_SUPPORTED：Windows 通用 usbprint.sys 驅動佔住咗設備，libusb 搶唔到 interface。
    if (/NOT_SUPPORTED|LIBUSB_ERROR_NOT_SUPPORTED/i.test(msg)) {
      return {
        ok: false,
        error:
          "LIBUSB_ERROR_NOT_SUPPORTED：Windows 用通用 usbprint.sys 驅動佔住咗部打印機，libusb 搶唔到 interface。" +
          "解決：用 Zadig（zadig.akeo.ie）將呢部設備嘅驅動替換成 WinUSB（VID/PID 唔使變），再試一次；" +
          "或者改用 LAN 打印（IP:9100，免驅動）。",
      };
    }
    return { ok: false, error: `USB 打印失敗：${msg}` };
  }
}

// ---- USB 設備列舉（免手動查 VID/PID，見 docs/50 P2）----
// 前端「掃描 USB」按鈕 call 呢度，自動填入 VID/PID，用家唔使自行查。
async function listUsbDevices() {
  if (!usbLib) return { ok: true, devices: [], note: "companion 未安裝 usb 套件（USB 掃描停用）" };
  try {
    const list = usbLib.getDeviceList() || [];
    const devices = list
      .map((dev) => {
        const d = dev.deviceDescriptor || {};
        const vid = d.idVendor;
        const pid = d.idProduct;
        if (!vid || !pid) return null;
        return {
          vid: `0x${vid.toString(16).padStart(4, "0")}`,
          pid: `0x${pid.toString(16).padStart(4, "0")}`,
          bus: dev.busNumber,
          address: dev.deviceAddress,
        };
      })
      .filter(Boolean);
    return { ok: true, devices };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "USB 列舉失敗" };
  }
}

// ---- 藍牙打印（Windows 配對後當虛擬 COM port，經 serialport 打；見 docs/50 P2）----
let serialLib = null;
try {
  serialLib = (await import("serialport")).default;
} catch {
  /* 未裝 serialport：printBluetooth 會回錯 */
}

async function printBluetooth(printer, buf) {
  if (!serialLib) return { ok: false, error: "companion 未安裝 serialport 套件（藍牙打印停用）" };
  // bluetoothName 當 COM port 名（例如 "COM3"）或 bluetoothAddress 映射（平台特定）
  const comPort = (printer.bluetoothName || "").match(/COM\d+/i)?.[0];
  if (!comPort) {
    return { ok: false, error: "藍牙打印機請填 Windows 配對後嘅 COM port（例如 COM3）落「BT 名稱」" };
  }
  const port = new serialLib({ path: comPort, baudRate: 9600, autoOpen: false });
  return new Promise((resolvePort) => {
    port.open((err) => {
      if (err) {
        resolvePort({ ok: false, error: `藍牙 COM 埠開啟失敗：${err.message}` });
        return;
      }
      port.write(buf, (wErr) => {
        port.drain(() => port.close());
        if (wErr) resolvePort({ ok: false, error: `藍牙寫入失敗：${wErr.message}` });
        else resolvePort({ ok: true });
      });
    });
  });
}

// ---- 按 connectionType 分派（LAN / USB / 藍牙，見 docs/50 P2）----
async function dispatch(job, printer) {
  const buf = renderEscPos(job, printer);
  if (printer.connectionType === "lan") return printLan(printer, buf);
  if (printer.connectionType === "usb") return printUsb(printer, buf);
  if (printer.connectionType === "bluetooth") return printBluetooth(printer, buf);
  return { ok: false, error: `唔支援嘅 connectionType：${printer.connectionType}` };
}

// ---- 狀態網頁介面（GET /）----
function statusPageHtml() {
  const companionUrl = `http://127.0.0.1:${cfg.port}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Macau POS Companion</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
         background:#0f172a; color:#e2e8f0; display:flex; min-height:100vh;
         align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:380px; background:#1e293b; border:1px solid #334155;
          border-radius:16px; padding:22px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { font-size:12px; color:#94a3b8; margin-bottom:16px; }
  .row { display:flex; align-items:center; gap:8px; padding:10px 12px; background:#0f172a;
         border-radius:10px; margin-bottom:12px; font-size:13px; }
  .dot { width:10px; height:10px; border-radius:50%; background:#64748b; flex:none; }
  .dot.ok { background:#22c55e; }
  .dot.bad { background:#ef4444; }
  .url { font-size:12px; color:#7dd3fc; word-break:break-all; }
  button { width:100%; padding:12px; border:0; border-radius:10px; cursor:pointer;
           font-size:14px; font-weight:600; background:#2563eb; color:#fff; }
  button:hover { background:#1d4ed8; }
  .note { font-size:11px; color:#94a3b8; margin-top:12px; line-height:1.5; }
  code { background:#0f172a; padding:1px 5px; border-radius:4px; color:#7dd3fc; }
</style></head><body>
  <div class="card">
    <h1>Macau POS Companion</h1>
    <div class="sub">桌面打印代理（localhost）· 已自動喺背景運行</div>
    <div class="row"><span id="dot" class="dot"></span><span id="status">檢查中…</span></div>
    <div class="row"><span>配對網址</span></div>
    <div class="url" id="companionUrl">${companionUrl}</div>
    <button id="pairBtn" style="margin-top:14px;">一鍵開 POS 並自動配對</button>
    <button id="quitBtn" style="margin-top:10px; background:#475569;">退出 Companion</button>
    <div class="note">
      按鈕會喺你嘅預設瀏覽器開 POS，並自動寫入配對網址，<b>全程唔使手動改設定</b>。<br/>
      若 POS 係 https 而你嘅瀏覽器擋咗 loopback 連線，請用 localhost 開發版或睇 README。
    </div>
  </div>
<script>
  const companionUrl = ${JSON.stringify(companionUrl)};
  const posUrl = ${JSON.stringify(cfg.posUrl)};
  const dot = document.getElementById('dot');
  const status = document.getElementById('status');
  async function refresh() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const j = await r.json();
      if (j.ok) { dot.className = 'dot ok'; status.textContent = '已連線 · Companion 正常運作'; }
      else { dot.className = 'dot bad'; status.textContent = '未連線'; }
    } catch { dot.className = 'dot bad'; status.textContent = '未連線（代理可能未起動）'; }
  }
  refresh(); setInterval(refresh, 2500);
  document.getElementById('pairBtn').addEventListener('click', () => {
    const url = posUrl + '?companion=' + encodeURIComponent(companionUrl);
    if (window.companionShell && window.companionShell.openExternal) window.companionShell.openExternal(url);
    else window.open(url, '_blank');
  });
  document.getElementById('quitBtn').addEventListener('click', () => {
    if (window.companionShell && window.companionShell.quit) window.companionShell.quit();
  });
</script>
</body></html>`;
}

// ---- HTTP server（loopback only）----
function createHandler() {
  return async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-companion-token");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      // 桌面殼（Electron）嘅視窗已經載 Vercel 網頁，唔使 companion 自己 serve 狀態頁。
      // 狀態頁改由 electron/status.html 獨立提供（main 可另開視窗載佢）。
      // 純 Node（npm run serve）模式如果你自己瀏覽器開，可以改叫 /status 睇：
      if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(statusPageHtml());
      }
      res.writeHead(404);
      return res.end();
    }

    // LAN 打印機自動發現（mDNS）：返 { printers: [{name, ip, port, type}] }
    // 見 docs/50 P1。前端「掃描 LAN 打印機」按鈕 call 呢度。
    if (req.method === "GET" && req.url === "/api/discover") {
      if (!bonjourLib) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, printers: [], note: "companion 未安裝 bonjour（mDNS 掃描停用）" }));
      }
      const printers = await discoverPrinters();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, printers }));
    }

    // USB 設備列舉（免手動查 VID/PID）：前端「掃描 USB」按鈕 call 呢度。
    if (req.method === "GET" && req.url === "/api/usb-list") {
      const result = await listUsbDevices();
      res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
    }

    if (req.method === "GET" && req.url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          companionUrl: `http://127.0.0.1:${cfg.port}`,
          posUrl: cfg.posUrl,
          tokenEnabled: Boolean(cfg.token),
        }),
      );
    }

    if (req.method === "POST" && req.url === "/api/print") {
      if (cfg.token && req.headers["x-companion-token"] !== cfg.token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "token 不符" }));
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "JSON 解析失敗" }));
      }
      const { job, printer } = parsed;
      if (!job || !printer) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "缺 job / printer" }));
      }
      const result = await dispatch(job, printer);
      res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    res.writeHead(404);
    return res.end();
  };
}

// ---- 雙棧 loopback listen（IPv4 + IPv6），避免 localhost 解析到 ::1 但只綁 IPv4 嘅 mismatch ----
// ⚠️ 必須用「兩個獨立 server 實例」各綁一個 stack：喺同一個 server 實例上 call listen() 兩次會令
//    兩個 bind 都報 EADDRINUSE → 咩都冇 bind 到 → 視窗載入 http://127.0.0.1:9311/ 失敗變空白。
export function startCompanionServer() {
  const handler = createHandler();
  const hosts = ["127.0.0.1", "::1"];
  const servers = [];
  for (const host of hosts) {
    const server = http.createServer(handler);
    const onErr = (e) => {
      if (e.code === "EADDRINUSE") {
        console.warn(`[macau-companion] ${host}:${cfg.port} 已被佔用，跳過（可能已經喺度）`);
      } else {
        console.error(`[macau-companion] listen ${host}:${cfg.port} 錯誤:`, e.message);
      }
    };
    server.once("error", onErr);
    server.listen(cfg.port, host, () => {
      server.removeListener("error", onErr);
      console.log(`[macau-companion] listening on http://${host}:${cfg.port}`);
    });
    servers.push(server);
  }
  console.log(`[macau-companion] token ${cfg.token ? "enabled" : "disabled"} · POS=${cfg.posUrl}`);
  return servers;
}
