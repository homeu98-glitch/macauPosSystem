/** 唯讀：睇該店 device_config 有幾部收據機 / 廚房機（判斷 once_key 撞鍵係「同一部機重複」定「兩部機同鍵」）。 */
const https = require("node:https");
function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: method || "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers }));
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
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const fs = require("node:fs");
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = (p) => req(`${H}/rest/v1/${p}`, "GET", h);

  const dc = await g(`pos_device_configs?select=device_id,terminal_name,store_id,printers,updated_at&store_id=eq.${STORE}&limit=5`);
  log("pos_device_configs status =", dc.status);
  try {
    for (const row of JSON.parse(dc.body)) {
      log(`\n=== device ${row.device_id} / ${row.terminal_name} / updated ${row.updated_at} ===`);
      log("printers =", JSON.stringify(row.printers, null, 1));
    }
  } catch { log(String(dc.body).slice(0, 300)); }

  // 交班單 / 收據 job 嘅 once_key 現況（非 NULL 全部列出）
  const pj = await g(`pos_print_jobs?select=id,order_id,order_no,ticket_type,printer_group,printer_name,status,once_key,created_at&store_id=eq.${STORE}&once_key=not.is.null&order=created_at.desc&limit=100`);
  log("\n=== once_key 非 NULL 嘅行（全部）===");
  try {
    const rows = JSON.parse(pj.body);
    log("筆數 =", rows.length);
    const keys = {};
    for (const r of rows) keys[r.once_key] = (keys[r.once_key] || 0) + 1;
    const dup = Object.entries(keys).filter(([, n]) => n > 1);
    log("重複鍵 =", JSON.stringify(dup));
    for (const r of rows.slice(0, 40)) log(`  ${r.id} no=${r.order_no} ${r.ticket_type}/${r.printer_group} ${r.printer_name} st=${r.status} once=${r.once_key}`);
  } catch { log(String(pj.body).slice(0, 300)); }

  fs.writeFileSync("tools/_probe-dupkitchen3-20260924.out.txt", out.join("\n"));
})();
