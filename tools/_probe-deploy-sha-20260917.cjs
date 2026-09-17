/**
 * 一次性（唯讀）：確認 GitHub main 的 HEAD sha 同 Vercel 部署狀態。
 * 用法：node tools/_probe-deploy-sha-20260917.cjs
 */
const https = require("https");

function get(url, extraHeaders) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: Object.assign(
          { "User-Agent": "abu-probe/1.0", Accept: "application/vnd.github+json", "cache-control": "no-cache" },
          extraHeaders || {},
        ),
      },
      (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: "ERR " + e.message }));
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
  });
}

const REPO = "homeu98-glitch/macauPosSystem";
const API = `https://api.github.com/repos/${REPO}`;

(async () => {
  const head = await get(`${API}/commits/main`);
  let sha = null;
  try {
    sha = JSON.parse(head.body).sha;
  } catch {
    console.log("commits/main raw:", head.status, head.body.slice(0, 200));
  }
  console.log("GitHub main HEAD :", sha ? sha.slice(0, 7) : "(unknown)", "| http", head.status);
  if (sha) {
    const c = JSON.parse(head.body).commit;
    console.log("  committed_at   :", c && c.committer && c.committer.date);
  }

  if (sha) {
    const st = await get(`${API}/commits/${sha}/status`);
    try {
      const j = JSON.parse(st.body);
      const s = (j.statuses || [])[0];
      console.log("commit status    :", j.state, s ? `— ${s.context}: ${s.description}` : "(no statuses)");
    } catch {
      console.log("commit status raw:", st.status, st.body.slice(0, 160));
    }
  }

  const dep = await get(`${API}/deployments?per_page=5`);
  try {
    const arr = JSON.parse(dep.body);
    if (!Array.isArray(arr)) throw new Error("not array");
    console.log(`=== deployments (${arr.length}) ===`);
    for (const d of arr) {
      console.log(
        `  ${d.environment} | ref=${String(d.ref).slice(0, 7)} | sha=${String(d.sha || "").slice(0, 7)} | created=${d.created_at}`,
      );
    }
  } catch {
    console.log("deployments raw  :", dep.status, dep.body.slice(0, 160));
  }

  const site = await get("https://macau-pos-system.vercel.app/?nocache=" + Date.now());
  console.log("=== site ===");
  console.log(
    "  status:",
    site.status,
    "| x-vercel-cache:",
    site.headers["x-vercel-cache"],
    "| age:",
    site.headers["age"],
    "| x-vercel-id:",
    site.headers["x-vercel-id"],
  );
})();
