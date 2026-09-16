// probe v18：用 heartbeat 端點窺探 agent 身份（不需 service_role）
//   heartbeat 需要 x-agent-id + x-agent-token → 但錯誤訊息可能洩漏 agent 是否存在
//   另：/pair?agentId= 對已 revoke 嘅 agent 會點？試多幾個可能嘅 agentId 格式
//   重點：ag-a466746d 係咩？佢 store 係邊？
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  console.log("═══ ① GET /pair 對唔存在 agentId 嘅行為（基線）═══");
  const fake = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=ag-doesnotexist000000000000000000000`, { "user-agent": "curl/8" });
  console.log(`  HTTP ${fake.status} ${fake.body.slice(0, 200)}`);

  console.log("\n═══ ② 用 agentId 撞 heartbeat（睇錯誤訊息會唔會洩漏）═══");
  for (const a of ["ag-0590816d9f60e8d2f55a16cf721042dd", "ag-a466746d", "ag-f38b08c1d2fec7111c4d5f03054d7d69"]) {
    const r = await req("POST", `${SITE}/api/pos/print-agent/heartbeat`, {
      "content-type": "application/json",
      "user-agent": "curl/8",
      "x-agent-id": a,
      "x-agent-token": "wrong-token-probe",
    }, "{}");
    console.log(`  ${a.padEnd(34)} → HTTP ${r.status} ${r.body.slice(0, 160)}`);
  }

  console.log("\n═══ ③ /pair 帶唔同 prefix（睇 agent id 命名規則）═══");
  for (const a of ["ag-a466746d0000000000000000000000", "ag-0000000000000000000000000000000"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair?agentId=${a}`, { "user-agent": "curl/8" });
    console.log(`  ${a} → HTTP ${r.status} ${r.body.slice(0, 120)}`);
  }

  console.log("\n═══ ④ pair-status 帶 storeId=表嫂美食 可能值（fuzzy）═══");
  for (const s of ["biaosao-meishi", "表嫂美食", "biaosao"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair-status?storeId=${encodeURIComponent(s)}`, { "user-agent": "curl/8" });
    let j = null; try { j = JSON.parse(r.body); } catch {}
    console.log(`  "${s}" → HTTP ${r.status} paired=${j?.paired} agent=${j?.agentId ?? "-"} lastSeen=${j?.lastSeenAt ?? "-"}`);
  }
})();
