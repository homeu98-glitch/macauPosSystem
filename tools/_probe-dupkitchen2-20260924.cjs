/** 唯讀：核實 pos_print_jobs anon 窗口有冇截斷 + 逐店統計 + 搵 007 嘅所有 job。 */
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
const out = []; const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const fs = require("node:fs");
const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) { try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {} }
  let K = "";
  for (const s of chunks) { try { const r = await req(base + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {} }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const g = (p, extra) => req(`${H}/rest/v1/${p}`, "GET", { ...h, ...(extra || {}) });

  // 1) 全表 count（anon 窗口內）
  const c1 = await g("pos_print_jobs?select=id&limit=1", { Prefer: "count=exact", Range: "0-0" });
  log("count(全部 anon 可見) =", (c1.headers["content-range"] || "").split("/")[1], "| status", c1.status);

  // 2) store 8291f843 近 24h
  const c2 = await g("pos_print_jobs?select=id&store_id=eq.8291f843-9def-4956-9d0b-1cfef2598306&limit=1", { Prefer: "count=exact", Range: "0-0" });
  log("count(store 8291f843) =", (c2.headers["content-range"] || "").split("/")[1]);

  // 3) 有冇其他店
  const all = await g("pos_print_jobs?select=store_id&limit=1000");
  const set = {};
  try { for (const x of JSON.parse(all.body)) set[x.store_id] = (set[x.store_id] || 0) + 1; } catch {}
  log("store 分佈 =", JSON.stringify(set));

  // 4) 逐格搵 007（receipt）
  for (const q of ["order_no=eq.007", "order_no=like.*007*"]) {
    const r = await g(`pos_print_jobs?select=id,order_no,table_name,ticket_type,printer_group,printer_name,status,once_key,created_at,finished_at&${q}&order=created_at.desc&limit=30`);
    log(`\n--- ${q} ---`);
    try { for (const x of JSON.parse(r.body)) log(`  ${x.id} no=${x.order_no} tbl=${x.table_name} tt=${x.ticket_type} grp=${x.printer_group} printer=${x.printer_name} st=${x.status} once=${x.once_key ?? "-"} created=${mac(x.created_at)} fin=${mac(x.finished_at)}`); } catch { log("  " + String(r.body).slice(0, 200)); }
  }

  // 5) 今日全部 job 嘅 printer_name 分佈（睇裝置有幾部機）
  const r5 = await g("pos_print_jobs?select=printer_name,printer_group,kind&store_id=eq.8291f843-9def-4956-9d0b-1cfef2598306&limit=1000");
  const pn = {};
  try { for (const x of JSON.parse(r5.body)) { const k = `${x.printer_name} / ${x.printer_group} / ${x.kind ?? "-"}`; pn[k] = (pn[k] || 0) + 1; } } catch {}
  log("\nprinter_name|group|kind 分佈 =", JSON.stringify(pn, null, 1));

  fs.writeFileSync("tools/_probe-dupkitchen2-20260924.out.txt", out.join("\n"));
})();
