/* 放大指定 PNG 嘅指定區域（用 Chrome 3x 渲染再截圖） */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIR = "C:/Users/surface/AppData/Local/Temp/mp4frames2";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT_HTTP = 8795;
const PORT_CDP = 9227;

// [檔名, 裁切 x, y, w, h, 倍數]
const JOBS = [
  ["shots/t0000.png", 0, 300, 700, 260, 3, "zoom_t0000_band"],
];

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const box = JOBS.map(
      (j, i) =>
        `<div id="b${i}" style="position:absolute;left:0;top:${i * 1500}px;width:${j[3]}px;height:${j[4]}px;overflow:hidden">
           <img src="/${j[0]}" style="position:absolute;left:${-j[1] * j[5]}px;top:${-j[2] * j[5]}px;width:${720 * j[5]}px;height:${1280 * j[5]}px">
         </div>`,
    ).join("");
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#222}</style></head><body>${box}</body></html>`);
    return;
  }
  const file = path.join(DIR, decodeURIComponent(url.replace(/^\//, "")));
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "Content-Type": "image/png" });
  fs.createReadStream(file).pipe(res);
});

const profile = path.join(DIR, "chrome-profile2");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + PORT_CDP,
    "--window-size=1200,1200",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });

(async () => {
  await new Promise((r) => server.listen(PORT_HTTP, "127.0.0.1", r));
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await getJson(`http://127.0.0.1:${PORT_CDP}/json/list`);
      if (targets.length) break;
    } catch (e) {}
    await sleep(400);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
    }
  };
  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => pending.has(mid) && (pending.delete(mid), reject(new Error("timeout"))), 20000);
    });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT_HTTP}/` });
  await sleep(1200);
  for (const j of JOBS) {
    const rect = (await send("Runtime.evaluate", {
      expression: `(()=>{const e=document.getElementById('b${JOBS.indexOf(j)}');const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
      returnByValue: true,
    })).result.value;
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
    const out = path.join(DIR, `${j[6]}.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("saved", out);
  }
})()
  .catch((e) => console.log("ERR", e.message))
  .finally(() => {
    try {
      chrome.kill();
    } catch (e) {}
    try {
      server.close();
    } catch (e) {}
    setTimeout(() => process.exit(0), 400);
  });
