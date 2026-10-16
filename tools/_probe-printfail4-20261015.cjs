/** 唯讀探測 v4：d564b932 嘅訂單 + store status + 全部 store 打印 job 統計 */
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
const STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  log("===== pos_orders d564b932（最近兩日）=====");
  const po = await g(`pos_orders?select=id,local_order_no,source,status,table_name,total,created_at,updated_at,settled_at,online_order_id&store_id=eq.${STORE}&created_at=gte.2026-10-14T16:00:00Z&order=created_at.desc&limit=60`);
  let orows = [];
  try { orows = JSON.parse(po.body); } catch { log("HTTP " + po.status + " " + String(po.body).slice(0, 300)); }
  log("筆數 =", orows.length);
  for (const r of orows) log(`${macau(r.created_at)} | ${r.id} | no=${r.local_order_no} | src=${r.source} | ${r.status} | tbl=${r.table_name} | total=${r.total} | online=${r.online_order_id || "-"}`);

  log("\n===== pos_store_status（全部）=====");
  const ss = await g(`pos_store_status?select=*&order=updated_at.desc&limit=20`);
  try { for (const r of JSON.parse(ss.body)) log(`${r.store_id} is_open=${r.is_open} @ ${macau(r.updated_at)} by=${r.updated_by} src=${r.updated_source}`); } catch { log("HTTP " + ss.status); }

  log("\n===== 全部 store：printer_id × status 統計（近兩日）=====");
  const pj = await g(`pos_print_jobs?select=store_id,printer_id,printer_name,printer_group,status,attempts&created_at=gte.2026-10-14T16:00:00Z&limit=500`);
  let jrows = [];
  try { jrows = JSON.parse(pj.body); } catch { log("HTTP " + pj.status); }
  const agg = new Map();
  for (const r of jrows) {
    const key = `${String(r.store_id).slice(0, 8)}|${r.printer_id}|${r.printer_name}|${r.printer_group}`;
    const cur = agg.get(key) ?? { printed: 0, failed: 0, pending: 0, other: 0 };
    if (r.status === "printed") cur.printed++;
    else if (r.status === "failed") cur.failed++;
    else if (r.status === "pending") cur.pending++;
    else cur.other++;
    agg.set(key, cur);
  }
  for (const [k, v] of [...agg.entries()].sort()) log(`${k} => printed=${v.printed} failed=${v.failed} pending=${v.pending} other=${v.other}`);

  fs.writeFileSync("tools/_probe-printfail4-20261015.out.txt", out.join("\n"));
})();
