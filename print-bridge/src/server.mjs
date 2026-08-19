import "dotenv/config";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { dispatchPrintJob, dispatchTestPrint } from "./dispatch.mjs";
import { listSystemPrinters } from "./usb-printer.mjs";

const PORT = Number(process.env.PRINT_BRIDGE_PORT ?? 9222);
const HOST = process.env.PRINT_BRIDGE_HOST ?? "0.0.0.0";

// === Path ②：雲端 HTTPS POS 要連 LAN bridge，bridge 必須係 HTTPS ===
// Let's Encrypt 證書經 DNS-01 發出（公眾信任，POS 機唔使逐部裝證書）。
const TLS_ENABLED = process.env.PRINT_BRIDGE_TLS === "1";
const TLS_PORT = Number(process.env.PRINT_BRIDGE_TLS_PORT ?? 8443);
const TLS_CERT = process.env.PRINT_BRIDGE_TLS_CERT ?? "";
const TLS_KEY = process.env.PRINT_BRIDGE_TLS_KEY ?? "";
const ALSO_HTTP = process.env.PRINT_BRIDGE_ALSO_HTTP === "1";

/** @type {import('./types.mjs').BridgeDeviceConfig | null} */
let cachedDeviceConfig = null;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function resolvePrinter(printerId, printerName) {
  const printers = cachedDeviceConfig?.printers ?? [];
  return (
    printers.find((row) => row.id === printerId) ??
    printers.find((row) => row.name === printerName) ??
    null
  );
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "macau-pos-print-bridge",
        version: "0.1.0",
        tls: TLS_ENABLED,
        port: TLS_ENABLED ? TLS_PORT : PORT,
        hasConfig: Boolean(cachedDeviceConfig),
        printerCount: cachedDeviceConfig?.printers?.length ?? 0,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/printers/system") {
      sendJson(res, 200, { ok: true, printers: listSystemPrinters() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/config") {
      const body = await readJson(req);
      cachedDeviceConfig = body.deviceConfig ?? body;
      sendJson(res, 200, { ok: true, printerCount: cachedDeviceConfig?.printers?.length ?? 0 });
      return;
    }

    if (req.method === "POST" && url.pathname === "/print") {
      const body = await readJson(req);
      const job = body.job;
      const printer = body.printer ?? resolvePrinter(job?.printerId, job?.printerName);
      if (!job || !printer) {
        sendJson(res, 400, { ok: false, error: "缺少 print job 或 printer 設定。" });
        return;
      }
      await dispatchPrintJob({
        job,
        printer,
        deviceConfig: cachedDeviceConfig,
        meta: body.meta ?? {},
      });
      sendJson(res, 200, { ok: true, jobId: job.id });
      return;
    }

    if (req.method === "POST" && url.pathname === "/test-print") {
      const body = await readJson(req);
      const printer = body.printer ?? resolvePrinter(body.printerId, body.printerName);
      if (!printer) {
        sendJson(res, 400, { ok: false, error: "找不到指定打印機。" });
        return;
      }
      await dispatchTestPrint({ printer, deviceConfig: cachedDeviceConfig });
      sendJson(res, 200, { ok: true, printerId: printer.id });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Bridge internal error",
    });
  }
}

function startHttp() {
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    console.log(`[macau-pos-print-bridge] HTTP listening on http://${HOST}:${PORT}`);
  });
}

function startHttps() {
  let cert;
  let key;
  try {
    cert = fs.readFileSync(TLS_CERT);
    key = fs.readFileSync(TLS_KEY);
  } catch (error) {
    console.error(
      `[macau-pos-print-bridge] 讀取 TLS 證書失敗（${TLS_CERT} / ${TLS_KEY}）：${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
  const server = https.createServer({ cert, key }, handle);
  server.listen(TLS_PORT, HOST, () => {
    console.log(`[macau-pos-print-bridge] HTTPS listening on https://${HOST}:${TLS_PORT}`);
  });
}

if (TLS_ENABLED) {
  if (!TLS_CERT || !TLS_KEY) {
    console.error(
      "[macau-pos-print-bridge] PRINT_BRIDGE_TLS=1 但缺 PRINT_BRIDGE_TLS_CERT / PRINT_BRIDGE_TLS_KEY，請先發證書（見 docs/33-print-bridge-https-lan.md）。",
    );
    process.exit(1);
  }
  startHttps();
  if (ALSO_HTTP) startHttp();
} else {
  startHttp();
}
