import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.APP_DIST || path.join(__dirname, "app-dist");
const PORT = Number(process.env.APP_PORT || 3000);
const HOST = process.env.APP_HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(DIST, urlPath);
    if (!filePath.startsWith(DIST)) return send(res, 403, "Forbidden");
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        // SPA fallback: extension-less routes serve index.html (client-side routing)
        if (!path.extname(urlPath)) {
          fs.readFile(path.join(DIST, "index.html"), (e2, data) => {
            if (e2) return send(res, 404, "Not found");
            send(res, 200, data, MIME[".html"]);
          });
          return;
        }
        return send(res, 404, "Not found");
      }
      fs.readFile(filePath, (e3, data) => {
        if (e3) return send(res, 500, "Error");
        const ext = path.extname(filePath) || ".html";
        send(res, 200, data, MIME[ext] || "application/octet-stream");
      });
    });
  } catch {
    send(res, 500, "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[macau-pos-app] static server on http://${HOST}:${PORT} (dist: ${DIST})`);
});
