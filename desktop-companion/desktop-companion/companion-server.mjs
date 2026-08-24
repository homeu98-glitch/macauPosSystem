// Macau POS Desktop Companion —— 可重用伺服器核心（見 docs/47）。
//
// 抽取自原 server.mjs，俾 standalone `node server.mjs` 同 Electron main 共用。
// 職責：綁 loopback（127.0.0.1 + ::1 雙棧），提供：
//   GET  /              → 狀態網頁介面（自動顯示連線狀態 + 一鍵開 POS 配對）
//   GET  /api/health    → { ok, version }
//   GET  /api/config    → { companionUrl, posUrl, tokenEnabled }（俾 POS 自動配對）
//   POST /api/print     → 收 ESC/POS job，經 OS 權限打到 LAN:9100 / USB（node-usb bulk）/ 藍牙（serialport SPP）
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

// ---- USB 打印機型號表（Meituan 式自動偵測；與 src/lib/print-bridge/printer-models.ts 保持一致）----
// 當 Companion 經 node-usb 枚舉到設備，按 VID/PID 對照品牌/型號/編碼/紙張，商家唔使手填 VID/PID。
const USB_PRINTER_DB = {
  "0x04B8": { brand: "Epson", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0202": { model: "Epson TM-T88IV" }, "0x0E03": { model: "Epson TM-T88V" },
      "0x0E15": { model: "Epson TM-T88VI" }, "0x0203": { model: "Epson TM-T81II" } } },
  "0x0519": { brand: "Star", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0006": { model: "Star TSP100 (TSP143)" }, "0x000D": { model: "Star mC-Print2" } } },
  "0x04CB": { brand: "Citizen", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x1005": { model: "Citizen CT-S310II" }, "0x109B": { model: "Citizen CT-S4000" } } },
  "0x0483": { brand: "Xprinter", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x5740": { model: "Xprinter XP-Q800 / Q200" }, "0x7000": { model: "Xprinter XP-58 / 80 series" } } },
  "0x0416": { brand: "Gprinter", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x5011": { model: "Gprinter GP-58 / 80 series" }, "0xAE01": { model: "Gprinter GP-U80300" } } },
  "0x1A03": { brand: "Gprinter", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0042": { model: "Gprinter GP-58MBIII", paperSize: "58mm" } } },
  "0x1FC9": { brand: "Zjiang", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x2016": { model: "Zjiang ZJ-5805 / 5890", paperSize: "58mm" }, "0x2022": { model: "Zjiang ZJ-80" } } },
  "0x2BDF": { brand: "Rongta", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0101": { model: "Rongta RP80 / RP58" } } },
  "0x04F9": { brand: "Brother", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x2049": { model: "Brother TD-2xxx / RJ series" } } },
  "0x0A5F": { brand: "Zebra", defaultCharset: "utf-8", defaultPaperSize: "100x75mm",
    models: { "0x0113": { model: "Zebra ZD410 (label)" }, "0x2011": { model: "Zebra ZD420 (label)" } } },
  "0x1203": { brand: "TSC", defaultCharset: "utf-8", defaultPaperSize: "100x75mm",
    models: { "0x0002": { model: "TSC TTP-244 Pro (label)" } } },
  "0x0C2E": { brand: "SAM4S", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0500": { model: "SAM4S GIANT-100" } } },
  "0x0498": { brand: "Bixolon", defaultCharset: "gb18030", defaultPaperSize: "80mm",
    models: { "0x0672": { model: "Bixolon SRP-350III" } } },
};
const KNOWN_USB_PRINTER_VIDS = new Set(Object.keys(USB_PRINTER_DB));

function toHexId(raw) {
  if (raw == null) return "";
  let n;
  if (typeof raw === "number") n = raw;
  else {
    const s = String(raw).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) n = parseInt(s, 16);
    else if (/^\d+$/.test(s)) n = parseInt(s, 10);
    else return "";
  }
  if (!Number.isFinite(n) || n <= 0) return "";
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

// 由 VID/PID 解析品牌/型號/編碼/紙張；未命中已知 VID 返 null（當唔係打印機或資料庫未收錄）。
function resolveUsbMeta(vendorId, productId) {
  const vid = toHexId(vendorId);
  if (!vid || !KNOWN_USB_PRINTER_VIDS.has(vid)) return null;
  const vendor = USB_PRINTER_DB[vid];
  const pid = toHexId(productId);
  const model = pid ? vendor.models[pid] : undefined;
  if (model) {
    return { brand: vendor.brand, model: model.model, charset: vendor.defaultCharset,
      paperSize: model.paperSize || vendor.defaultPaperSize, generic: false };
  }
  return { brand: vendor.brand, model: vendor.brand, charset: vendor.defaultCharset,
    paperSize: vendor.defaultPaperSize, generic: true };
}

// node-usb 枚舉所有 USB 設備，只回打印機（命中型號表者），並附 brand/model/charset/paperSize。
async function enumerateUsbPrinters() {
  if (!usbLib) return { ok: false, note: "companion 未安裝 usb 套件（USB 枚舉停用）", printers: [] };
  try {
    const devices = usbLib.getDeviceList();
    const printers = [];
    for (const dev of devices) {
      let vid, pid;
      try {
        vid = toHexId(dev.deviceDescriptor?.idVendor);
        pid = toHexId(dev.deviceDescriptor?.idProduct);
      } catch { continue; }
      if (!vid || !pid) continue;
      const meta = resolveUsbMeta(vid, pid);
      if (!meta) continue; // 唔係已知打印機 VID → 跳過（避免掃到滑鼠/鍵盤等）
      printers.push({
        vendorId: vid, productId: pid,
        brand: meta.brand, model: meta.model,
        charset: meta.charset, paperSize: meta.paperSize,
        connectionType: "usb", recognized: true,
      });
    }
    return { ok: true, printers };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : "USB 枚舉失敗", printers: [] };
  }
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
  if (!dev) return { ok: false, error: `搵唔到 USB 設備 ${printer.usbVendorId}:${printer.usbProductId}（確認已連接且驅動就緒）` };
  let claimedIface = null;
  try {
    dev.open();
    // 揀打印機 interface：優先 Printer class(7)，否則第一個有 OUT bulk endpoint 嘅 interface
    const iface =
      dev.interfaces.find((i) => i.descriptor && i.descriptor.bInterfaceClass === 7) ||
      dev.interfaces.find((i) => i.endpoints.some((e) => e.direction === "out" && e.transferType === 2)) ||
      dev.interfaces[0];
    if (!iface) throw new Error("USB 設備無可用 interface");
    // kernel 已 claim（例如 usblp）就先 detach，否則 claim 會失敗
    try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch {}
    iface.claim();
    claimedIface = iface;
    // libusb transferType: 0=control 1=isochronous 2=bulk 3=interrupt（LIBUSB_TRANSFER_TYPE_BULK=2）
    const outEp = iface.endpoints.find((e) => e.direction === "out" && e.transferType === 2);
    if (!outEp) throw new Error("USB 設備無 outbound bulk endpoint");
    await new Promise((resolveEp, rejectEp) => {
      outEp.transfer(buf, (err) => {
        if (err) rejectEp(new Error(`USB transfer 失敗：${err.errno || err.message}`));
        else resolveEp();
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "USB 打印失敗" };
  } finally {
    try {
      if (claimedIface) claimedIface.release(() => { try { dev.close(); } catch {} });
      else dev.close();
    } catch {}
  }
}

// ---- 藍牙打印（Windows 配對後當虛擬 COM port，經 serialport SPP 打；見 docs/50 P2）----
// serialport@12 冇 default export，要用具名 SerialPort。
let serialLib = null;
try {
  const sp = await import("serialport");
  serialLib = sp.SerialPort || sp.default;
} catch {
  /* 未裝 serialport：printBluetooth 會回錯 */
}

// 由 bluetoothName 解 COM port / tty 路徑：
//   1) 直接填 COM3 / /dev/cu.xxx → 直接用
//   2) 填藍牙裝置名稱 → 用 SerialPort.list() 按 friendlyName / pnpId 對照（Meituan 式，商家唔使知 COM 號）
async function resolveBtPort(printer) {
  const raw = printer.bluetoothName || "";
  const explicit = raw.match(/(COM\d+)|(\\\\.\\[^\\]+)|(\/dev\/(cu|tty)[^\s]*)/i);
  if (explicit) return explicit[0];
  if (!serialLib || typeof serialLib.list !== "function") return null;
  try {
    const ports = await serialLib.list();
    const name = raw.trim().toLowerCase();
    const hit = ports.find((p) => {
      const f = `${p.friendlyName || ""} ${p.pnpId || ""} ${p.path || ""}`.toLowerCase();
      return name && f.includes(name);
    });
    return hit ? hit.path : null;
  } catch {
    return null;
  }
}

function parseBaud(raw) {
  const m = String(raw || "").match(/@(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function printBluetooth(printer, buf) {
  if (!serialLib) return { ok: false, error: "companion 未安裝 serialport 套件（藍牙打印停用）" };
  const comPort = await resolveBtPort(printer);
  if (!comPort) {
    return { ok: false, error: "藍牙打印機請填配對後嘅 COM port（例如 COM3），或填藍牙名稱等 Companion 自動對照" };
  }
  const baud = parseBaud(printer.bluetoothName) || 9600;
  const port = new serialLib({ path: comPort, baudRate: baud, autoOpen: false });
  return new Promise((resolvePort) => {
    port.open((err) => {
      if (err) {
        resolvePort({ ok: false, error: `藍牙 COM 埠 ${comPort} 開啟失敗：${err.message}` });
        return;
      }
      port.write(buf, (wErr) => {
        port.drain(() => port.close(() => {}));
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

    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, version: "0.1.4" }));
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

    // node-usb 枚舉 USB 打印機（Meituan 式：商家唔使手填 VID/PID）
    if (req.method === "GET" && req.url === "/api/usb") {
      const r = await enumerateUsbPrinters();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r));
    }

    // 合併 LAN(mDNS) + USB(node-usb) 清單，俾前端「打印機清單」用
    if (req.method === "GET" && req.url === "/api/printers") {
      const lan = await discoverPrinters();
      const usb = await enumerateUsbPrinters();
      const notes = [!bonjourLib ? "mDNS 停用" : "", !usbLib ? "USB 停用" : ""].filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ ok: true, lan: lan || [], usb: usb.printers || [], note: notes.join("；") }),
      );
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
