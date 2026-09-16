// probe v7：釐清「配對失敗：POS 雲端未設定」到底是哪一關卡的
//   已知：ag-0590816d 的 GET /pair 回 status=paired + 兩欄有值 ⇒ 不是 :33/:36
//   待查：
//     A) 新 App 用的 agentId 是否與 ag-0590816d 不同（→ 新 agentId 回 pending → :21「配對尚未完成」）
//     B) 若 status=pending，那 PosRelaySession 顯示的是「配對尚未完成」而非「POS 雲端未設定」
//     C) 是否有第三個 agentId（新裝的）尚未 POST /pair
//   手法：掃全部 agentId（由 jobs 抽 + 由 agents 表試）+ 對每個打 GET /pair
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}
const toMC = (s) =>
  s ? new Date(new Date(s).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "NULL";

(async () => {
  const home = await req("GET", SITE + "/prints", { "user-agent": "Mozilla/5.0" });
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await req("GET", SITE + p, { "user-agent": "Mozilla/5.0" });
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (pl.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; }
      } catch {}
    }
  }
  if (!anonKey) { console.log("搵唔到 anon key"); return; }
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  // 拿全部 agentId 線索：由任何行（包括 NULL）取 claimed_by
  const rall = await req("GET", `${base}/pos_print_jobs?select=claimed_by,created_at&order=created_at.desc&limit=300`, h);
  const ids = new Set();
  try {
    JSON.parse(rall.body).forEach((r) => { if (r.claimed_by) ids.add(r.claimed_by); });
  } catch {}
  // 由先前 probe 已知的
  ids.add("ag-f38b08c1d2fec7111c4d5f03054d7d69");
  ids.add("ag-0590816d9f60e8d2f55a16cf721042dd");
  ids.add("ag-a466746da8946cd1421916043eb643e1");

  console.log("① 對每個已知 agentId 打 GET /pair：\n");
  for (const aid of ids) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${aid}`, { "user-agent": "curl/8" });
    let note = "";
    try {
      const j = JSON.parse(r.body);
      if (j.status !== "paired") note = `⇒ 會顯示「${j.error || "配對尚未完成"}」`;
      else if (!j.supabaseUrl || !j.anonKey) note = "⇒ :33 兩欄空（真。POS 雲端未設定）";
      else if (j.supabaseUrl.includes("zymdemjflsckicwcinxl")) note = "⇒ :36 撞正 Ledger";
      else note = "⇒ ✅ 兩欄齊全 + 非 Ledger ⇒ 配對應該成功";
    } catch {}
    console.log(`  ${aid}`);
    console.log(`    HTTP ${r.status}  ${r.body.slice(0, 190)}`);
    console.log(`    ${note}\n`);
  }

  console.log("② 最近 8 張 job（判新 App 用邊個 agentId）：");
  const rj = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,last_error&order=created_at.desc&limit=8`, h);
  try {
    JSON.parse(rj.body).forEach((r) =>
      console.log(`  ${toMC(r.created_at)} | ${r.status} att=${r.attempts} | claimed_by=${r.claimed_by || "NULL"} | ${(r.last_error || "").slice(0, 40)}`)
    );
  } catch { console.log("  HTTP", rj.status, rj.body.slice(0, 200)); }
})();
