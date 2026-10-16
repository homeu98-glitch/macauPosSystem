/** 唯讀探測 v5：21:30 之後嘅最新 job 狀態（確認「又印到」） */
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
const out = []; const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };
const macau = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  log("===== d564b932 全部 job（今日，含 21:30 後）=====");
  const pj = await g(`pos_print_jobs?select=id,order_no,printer_name,printer_id,status,attempts,last_error,created_at,claimed_at,finished_at&store_id=eq.d564b932-0c91-45e9-86fd-0ec8e2711f13&created_at=gte.2026-10-15T00:00:00Z&order=created_at.desc&limit=50`);
  let rows = [];
  try { rows = JSON.parse(pj.body); } catch { log("HTTP " + pj.status); }
  log("筆數 =", rows.length);
  for (const r of rows) log(`${macau(r.created_at)} | no=${r.order_no} | ${r.printer_name} (${r.printer_id}) | st=${r.status} att=${r.attempts} | claim=${macau(r.claimed_at)} done=${macau(r.finished_at)} | err=${r.last_error || "-"}`);

  log("\n===== d564b932 今日訂單 =====");
  const po = await g(`pos_orders?select=id,local_order_no,source,status,table_name,total,created_at&store_id=eq.d564b932-0c91-45e9-86fd-0ec8e2711f13&created_at=gte.2026-10-15T00:00:00Z&order=created_at.desc&limit=50`);
  try { for (const r of JSON.parse(po.body)) log(`${macau(r.created_at)} | ${r.id} | no=${r.local_order_no} | src=${r.source} | ${r.status} | tbl=${r.table_name} | total=${r.total}`); } catch { log("HTTP " + po.status); }

  fs.writeFileSync("tools/_probe-printfail5-20261015.out.txt", out.join("\n"));
})();
