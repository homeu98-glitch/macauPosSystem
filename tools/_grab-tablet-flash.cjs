/* 抽幀：桌台最後只閃一下（6.4s、720x1280 直倒、HEVC→H.264 再 CDP 截圖） */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const SRC =
  "C:/Users/surface/Documents/xwechat_files/wxid_0607766078222_e695/temp/RWTemp/2026-09/9e20f478899dc29eb19741386f9343c8/55975d45c53c68a72816ab375cecf84d.mp4";
const DIR = "C:/Users/surface/AppData/Local/Temp/mp4frames2";
const OUT = path.join(DIR, "shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FFMPEG = "C:/Users/surface/AppData/Local/Programs/TRAE SOLO/resources/app/bin/ffmpeg.exe";
const VW = 720;
const VH = 1280;
const PORT_HTTP = 8793;
const PORT_CDP = 9225;

fs.mkdirSync(OUT, { recursive: true });

// 1. 轉 H.264
const conv = path.join(DIR, "conv.mp4");
if (!fs.existsSync(conv)) {
  execFileSync(FFMPEG, [
    "-y", "-v", "error", "-i", SRC,
    "-vf", `fps=30,scale=${VW}:${VH}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", conv,
  ]);
}
console.log("conv size", fs.statSync(conv).size);

const STEP = 0.2;
const TIMES = [];
for (let t = 0; t <= 6.4 + 1e-6; t += STEP) TIMES.push(Math.round(t * 100) / 100);

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#000;overflow:hidden}
      video{display:block;width:${VW}px;height:${VH}px}
    </style></head><body>
      <video id="v" src="/conv.mp4" muted preload="auto" playsinline></video>
      <script>window.__ready=false;const v=document.getElementById('v');
        v.addEventListener('loadeddata',()=>{window.__ready=true});</script>
    </body></html>`);
    return;
  }
  const file = path.join(DIR, decodeURIComponent(url.replace(/^\//, "")));
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    res.writeHead(206, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
  fs.createReadStream(file).pipe(res);
});

const profile = path.join(DIR, "chrome-profile");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=" + PORT_CDP,
    `--window-size=${VW},${VH}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url) {
  return new Promise((resolve, reject) => {
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
}

async function main() {
  await new Promise((r) => server.listen(PORT_HTTP, "127.0.0.1", r));
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await getJson(`http://127.0.0.1:${PORT_CDP}/json/list`);
      if (targets.length) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!targets) throw new Error("CDP 未啟動");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid);
          reject(new Error("timeout " + method));
        }
      }, 30000);
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: VW + 20,
    height: VH + 20,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT_HTTP}/index.html` });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "window.__ready===true && document.getElementById('v').readyState>=2",
      returnByValue: true,
    }).catch(() => ({ result: { value: false } }));
    if (r.result && r.result.value === true) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) throw new Error("影片載入失敗");
  const dur = (await send("Runtime.evaluate", { expression: "document.getElementById('v').duration", returnByValue: true }))
    .result.value;
  console.log("ready, duration =", dur);

  for (const t of TIMES) {
    const expr = `(async()=>{const v=document.getElementById('v');v.pause();
      await new Promise(r=>{v.readyState>=2?r():v.addEventListener('loadeddata',r,{once:true})});
      if(Math.abs(v.currentTime-${t})>0.005){await new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=${t}})};
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {ct:Math.round(v.currentTime*100)/100,rs:v.readyState};})()`;
    try {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const name = `t${String(Math.round(t * 100)).padStart(4, "0")}.png`;
      fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, "base64"));
      console.log("saved", name, JSON.stringify(r.result.value));
    } catch (e) {
      console.log("FAIL t=" + t, e.message);
    }
  }
}

main()
  .then(() => console.log("DONE"))
  .catch((e) => console.log("ERROR", e.message))
  .finally(() => {
    try {
      chrome.kill();
    } catch (e) {}
    try {
      server.close();
    } catch (e) {}
    setTimeout(() => process.exit(0), 500);
  });
