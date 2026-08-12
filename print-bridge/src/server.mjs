import http from "node:http";
import { dispatchPrintJob, dispatchTestPrint } from "./dispatch.mjs";
import { listSystemPrinters } from "./usb-printer.mjs";

const PORT = Number(process.env.PRINT_BRIDGE_PORT ?? 9222);
const HOST = process.env.PRINT_BRIDGE_HOST ?? "0.0.0.0";

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

const server = http.createServer(async (req, res) => {
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
        port: PORT,
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
});

server.listen(PORT, HOST, () => {
  console.log(`[macau-pos-print-bridge] listening on http://${HOST}:${PORT}`);
});
