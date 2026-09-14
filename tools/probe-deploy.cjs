const https = require("https");

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "probe", "cache-control": "no-cache" } }, (r) => {
      let d = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (d += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: "ERR " + e.message }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHA = "f9f8981cb1720e65488a31f870b0fbbea92d6a7d";
const API = "https://api.github.com/repos/homeu98-glitch/macauPosSystem";

(async () => {
  const deadline = Date.now() + 5 * 60 * 1000;
  let verdict = null;

  while (Date.now() < deadline) {
    const st = await get(`${API}/commits/${SHA}/status`);
    let j = null;
    try {
      j = JSON.parse(st.body);
    } catch {
      /* ignore */
    }
    if (j && j.statuses && j.statuses.length) {
      const s = j.statuses[0];
      console.log(`[${new Date().toISOString()}] ${s.state} — ${s.description}`);
      if (s.state !== "pending") {
        verdict = s;
        break;
      }
    } else {
      console.log(`[${new Date().toISOString()}] no status yet (http ${st.status})`);
    }
    await wait(15000);
  }

  console.log("=== VERDICT ===");
  console.log(verdict ? `${verdict.state} — ${verdict.description}` : "timeout: still pending after 5 min");

  const dep = await get(`${API}/deployments?per_page=3`);
  try {
    const arr = JSON.parse(dep.body);
    console.log("=== LATEST DEPLOYMENTS ===");
    for (const d of arr) {
      console.log(` ${d.environment} | ref=${String(d.ref).slice(0, 7)} | created=${d.created_at}`);
    }
  } catch {
    console.log("deployments raw:", dep.status);
  }

  const site = await get("https://macau-pos-system.vercel.app/?nocache=" + Date.now());
  console.log("=== SITE (cache-busted) ===");
  console.log("status:", site.status, "| x-vercel-cache:", site.headers["x-vercel-cache"], "| age:", site.headers["age"]);
})();
