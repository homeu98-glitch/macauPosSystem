/** 唯讀：部署後（21:03 HKT = 13:03 UTC）pos_print_jobs 嘅 once_key 格式 + receipt:0 阻塞行 */
const https = require("node:https");
function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: method || "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej);
    r.setTimeout(20000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const fs = require("node:fs");
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  if (!K) { log("!! 抽唔到 anon key"); process.exit(1); }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = (p) => req(`${H}/rest/v1/${p}`, "GET", h);

  // 1) 部署後（13:03 UTC 之後）新插入嘅 print jobs
  const after = await g(`pos_print_jobs?select=id,order_id,order_no,ticket_type,printer_name,status,once_key,created_at&store_id=eq.${STORE}&created_at=gte.2026-09-24T13:00:00Z&order=created_at.desc&limit=50`);
  log("=== 部署後（>=13:00 UTC / 21:00 HKT）新 print jobs ===  status", after.status);
  try {
    const rows = JSON.parse(after.body);
    log("count =", rows.length);
    for (const r of rows) log(`  ${r.created_at}  ${String(r.ticket_type).padEnd(10)} ${String(r.status).padEnd(9)} once_key=${r.once_key === null ? "NULL" : JSON.stringify(r.once_key)}  order=${r.order_no || r.order_id}`);
  } catch { log(String(after.body).slice(0, 400)); }

  // 2) receipt:0 阻塞行仲喺唔喺度（注意 24h 窗口限制 —— 09-21 建立嘅行已經睇唔到，只可以睇新嘅）
  const blocker = await g(`pos_print_jobs?select=id,order_id,status,once_key,created_at&store_id=eq.${STORE}&once_key=eq.receipt:0`);
  log("\n=== once_key='receipt:0' 嘅行（24h 窗口內）===  status", blocker.status);
  log(blocker.body.slice(0, 600));

  // 3) 而家有冇「receipt:0」以外嘅 raw 短 key（冇 | 嘅）
  const raw = await g(`pos_print_jobs?select=id,ticket_type,status,once_key,created_at&store_id=eq.${STORE}&once_key=not.is.null&created_at=gte.2026-09-24T13:00:00Z&order=created_at.desc&limit=50`);
  log("\n=== 部署後 once_key 格式統計 ===");
  try {
    const rows = JSON.parse(raw.body);
    let composed = 0, rawKey = 0, nul = 0;
    for (const r of rows) { if (r.once_key == null) nul++; else if (String(r.once_key).includes("|")) composed++; else { rawKey++; log("  RAW:", r.once_key, r.ticket_type, r.created_at); } }
    log(`composed(含|)=${composed}  raw(唔含|)=${rawKey}`);
  } catch { log(String(raw.body).slice(0, 400)); }

  fs.writeFileSync("C:/dev/macauPos/macauPosSystem/tools/_probe-postdeploy-20260924.out.txt", out.join("\n"));
})();
