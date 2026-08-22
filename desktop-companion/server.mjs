// Macau POS Desktop Companion —— 最小可跑骨架（見 docs/47）。
//
// 喺 POS 終端機（Windows/macOS/Linux）跑，綁 127.0.0.1，俾瀏覽器開嘅 POS 網頁
// 經 localhost HTTP 交打印 job，由 OS 權限出單（LAN:9100 / USB / BT）。
//
// 跑法：
//   cd desktop-companion
//   npm install        # 裝 iconv-lite（唔裝都跑得，會 fallback utf-8）
//   node server.mjs
//
// 網頁側對應：src/lib/print-bridge/companion-transport.ts（POST /api/print）

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "companion.config.json");

// ---- 配置（companion.config.json 可覆寫）----
const cfg = { port: 9311, binding: "127.0.0.1", token: "" };
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

// ---- 按 connectionType 分派（USB/BT 骨架留 stub，見 docs/47 P2.2/P2.3）----
async function dispatch(job, printer) {
  const buf = renderEscPos(job, printer);
  if (printer.connectionType === "lan") return printLan(printer, buf);
  if (printer.connectionType === "usb")
    return { ok: false, error: "USB 打印未實作於骨架（見 docs/47 P2.2）" };
  if (printer.connectionType === "bluetooth")
    return { ok: false, error: "藍牙打印未實作於骨架（見 docs/47 P2.3）" };
  return { ok: false, error: `唔支援嘅 connectionType：${printer.connectionType}` };
}

// ---- HTTP server（loopback only）----
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-companion-token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
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
});

server.listen(cfg.port, cfg.binding, () => {
  console.log(`[macau-companion] listening on http://${cfg.binding}:${cfg.port}`);
  console.log(`[macau-companion] token ${cfg.token ? "enabled" : "disabled"}`);
});
