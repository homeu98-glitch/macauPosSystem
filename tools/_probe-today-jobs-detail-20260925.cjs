/** 唯讀：dump 今日兩條 job 嘅完整 content + 對應訂單 */
const https = require("node:https");
const fs = require("node:fs");
function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: method || "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const out = []; const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = (p) => req(`${H}/rest/v1/${p}`, "GET", h);

  const pj = await g(`pos_print_jobs?id=in.(print-a973f43f,print-03e343b5)&select=*`);
  log("=== 今日兩條 job 全文 ===");
  try { log(JSON.stringify(JSON.parse(pj.body), null, 1)); } catch { log(String(pj.body).slice(0, 800)); }

  log("\n=== 相關 pos_orders ===");
  const po = await g(`pos_orders?or=(id.in.(ledger-b2aa7a13-5c68-415c-87ff-f476e564c202,ledger-c5a19d31-1dc5-4cf3-a013-e502390901cb),online_order_id.in.(b2aa7a13-5c68-415c-87ff-f476e564c202,c5a19d31-1dc5-4cf3-a013-e502390901cb))&select=id,local_order_no,status,created_at,updated_at,settled_at,total,online_order_id,table_name,items,note&limit=10`);
  try { log(JSON.stringify(JSON.parse(po.body), null, 1)); } catch { log(String(po.body).slice(0, 800)); }

  fs.writeFileSync("tools/_probe-today-jobs-detail-20260925.out.txt", out.join("\n"));
})();
