// 驗證部署：GitHub 遠端 sha + Vercel deployment 狀態
const https = require("https");
function get(path) {
  return new Promise((res, rej) => {
    https.get({ host: "api.github.com", path, headers: { "User-Agent": "probe", Accept: "application/vnd.github+json" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch (e) { rej(new Error(d.slice(0, 300))); } });
    }).on("error", rej);
  });
}
(async () => {
  const repo = "/repos/homeu98-glitch/macauPosSystem";
  const main = await get(repo + "/commits/main");
  const sha = main.body.sha;
  console.log("remote main sha:", sha, "| date:", main.body.commit.committer.date);
  const st = await get(repo + "/commits/" + sha + "/status");
  (st.body.statuses || []).forEach((s) => console.log("status:", s.context, "|", s.state, "|", s.description, "|", s.updated_at));
  const dep = await get(repo + "/deployments?per_page=5");
  for (const d of (dep.body || [])) {
    console.log("deploy:", d.id, d.environment, d.sha.slice(0, 7), d.created_at);
    const ds = await get(repo + "/deployments/" + d.id + "/statuses");
    (ds.body || []).slice(0, 1).forEach((x) => console.log("   ->", x.state, x.environment_url || "", x.updated_at));
  }
})();
