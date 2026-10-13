/* 輪詢線上 x-pos-build，等新部署落地。臨時檔，用完刪。 */
const https = require("node:https");

const TARGET = process.argv[2] || "59f60ba";
const MAX_MS = Number(process.argv[3] || 420000);

function probe() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "macau-pos-system.vercel.app",
        path: "/api/pos/shift",
        method: "GET",
        headers: { "user-agent": "build-poll" },
        timeout: 15000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ build: res.headers["x-pos-build"] || "", status: res.statusCode }));
      },
    );
    req.on("error", () => resolve({ build: "", status: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ build: "", status: 0 });
    });
    req.end();
  });
}

(async () => {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < MAX_MS) {
    const r = await probe();
    if (r.build && r.build !== last) {
      last = r.build;
      console.log(`${new Date().toISOString()}  x-pos-build = ${r.build}${r.build === TARGET ? "   <== 新版本已上線" : ""}`);
    }
    if (r.build === TARGET) {
      console.log("DONE: 部署完成");
      return;
    }
    await new Promise((res) => setTimeout(res, 20000));
  }
  console.log(`TIMEOUT: 等咗 ${Math.round((Date.now() - started) / 1000)}s，最後見到 = ${last || "(讀唔到)"}`);
})();
