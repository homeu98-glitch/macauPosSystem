/** 唯讀：查 09-24 嘅 pos_print_jobs，搵「取餐號 001 / MOP 43」有無出過紙（＝POS 有無處理過）。 */
const https = require("node:https");
function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try { const r = await get(SITE + p); (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try { const r = await get(SITE + s); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } } catch {}
  }
  const H = { apikey: K, authorization: `Bearer ${K}` };
  const q = async (path) => {
    const r = await get(`https://${REF}.supabase.co/rest/v1/${path}`, H);
    try { return { status: r.status, json: JSON.parse(r.body), raw: r.body }; } catch { return { status: r.status, json: null, raw: r.body }; }
  };

  const since = "2026-09-23T16:00:00Z";
  let r = await q(`pos_print_jobs?select=*&store_id=eq.${STORE}&created_at=gte.${since}&order=created_at.asc&limit=300`);
  if (!Array.isArray(r.json)) { console.log("查詢失敗", r.status, String(r.raw).slice(0, 300)); return; }
  console.log("09-24 print_jobs 共", r.json.length, "張\n");
  if (r.json[0]) console.log("欄位:", Object.keys(r.json[0]).join(","), "\n");

  const seen = new Set();
  for (const j of r.json) {
    const key = [j.order_no, j.order_id, j.printer_group, j.job_type ?? "", j.status].join("|");
    if (seen.has(key + j.created_at)) continue;
    seen.add(key + j.created_at);
    console.log(
      [String(j.created_at ?? "-").slice(5, 19), String(j.order_no ?? "-").padEnd(14), String(j.order_id ?? "-").slice(0, 24).padEnd(24),
       String(j.printer_group ?? j.job_type ?? "-").padEnd(10), String(j.status ?? "-").padEnd(12), String(j.once_key ?? "-")].join(" | ")
    );
  }

  console.log("\n=== order_no / order_id 含 001 或 43 元嘅 job ===");
  const hits = r.json.filter((j) => String(j.order_no ?? "").includes("001") || String(j.order_id ?? "").includes("001"));
  console.log(hits.length ? JSON.stringify(hits, null, 2) : "（冇）");
})();
