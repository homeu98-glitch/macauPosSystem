/** 唯讀探測：2026-10-15 打印失敗取證
 *  1) pos_print_jobs 最近兩日（全部 store，睇睇有冇 RLS 限制）
 *  2) pos_print_agents（中繼機狀態）
 *  3) pos_device_configs（打印機設定）
 *  4) 按 order_no=取餐01/自取01 反查 store
 */
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
  log("bundle chunks =", chunks.size, " key =", K ? K.slice(0, 30) + "…" : "(冇)");
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = async (p) => { const r = await req(`${H}/rest/v1/${p}`, "GET", h); return r; };

  // ① 最近兩日全部 print jobs（試唔加 store filter）
  log("\n===== pos_print_jobs（2026-10-14 16:00Z 起，全部 store）=====");
  const pj = await g(`pos_print_jobs?select=id,store_id,order_id,order_no,table_name,ticket_type,printer_group,printer_id,printer_name,status,attempts,last_error,created_at,claimed_at,finished_at,claimed_by&created_at=gte.2026-10-14T16:00:00Z&order=created_at.desc&limit=100`);
  log("status", pj.status);
  let rows = [];
  try { rows = JSON.parse(pj.body); } catch { log(String(pj.body).slice(0, 600)); }
  log("筆數 =", rows.length);
  for (const r of rows) {
    log(`${macau(r.created_at)} | store=${String(r.store_id).slice(0, 8)} | no=${r.order_no} tbl=${r.table_name || "-"} | ${r.ticket_type}/${r.printer_group} | printer=${r.printer_name} (id=${r.printer_id}) | st=${r.status} att=${r.attempts} | claim=${macau(r.claimed_at)} by=${String(r.claimed_by || "-").slice(0, 18)} done=${macau(r.finished_at)} | err=${r.last_error || "-"}`);
  }

  // ② 從上面搵出涉及嘅 store，再查 agents + device configs
  const stores = [...new Set(rows.map((r) => r.store_id).filter(Boolean))];
  log("\n涉及 store =", JSON.stringify(stores));

  log("\n===== pos_print_agents（全部）=====");
  const ag = await g(`pos_print_agents?select=*&order=last_seen_at.desc&limit=50`);
  log("status", ag.status);
  let ags = [];
  try { ags = JSON.parse(ag.body); } catch { log(String(ag.body).slice(0, 600)); }
  log("筆數 =", ags.length);
  for (const a of ags) log(JSON.stringify(a));

  for (const s of stores) {
    log(`\n===== pos_device_configs（store=${s}）=====`);
    const dc = await g(`pos_device_configs?select=*&store_id=eq.${s}&order=updated_at.desc&limit=10`);
    log("status", dc.status);
    try {
      const dcs = JSON.parse(dc.body);
      log("筆數 =", dcs.length);
      for (const d of dcs) log(JSON.stringify(d).slice(0, 3000));
    } catch { log(String(dc.body).slice(0, 600)); }
  }

  fs.writeFileSync("tools/_probe-printfail-20261015.out.txt", out.join("\n"));
})();
