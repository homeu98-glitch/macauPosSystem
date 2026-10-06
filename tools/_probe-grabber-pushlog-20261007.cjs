/**
 * 查 pos_grabber_push_log（含 rejected_detail）—— anon 視角若 RLS 允許。
 * 只讀，唔寫。2026-10-07
 */
const https = require("node:https");
const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";
const STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers })); }
    );
    r.on("error", (e) => res({ status: "ERR", body: String(e.message), headers: {} }));
    r.on("timeout", () => { r.destroy(); res({ status: "TIMEOUT", body: "", headers: {} }); });
  });
}
const PK = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const JW = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/orders", "/"]) {
    const r = await get(SITE + p);
    (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
  }
  const keys = new Set();
  for (const s of chunks) {
    const r = await get(SITE + s);
    (r.body.match(PK) || []).forEach((t) => keys.add(t));
    (r.body.match(JW) || []).forEach((t) => keys.add(t));
  }
  let posKey = null;
  for (const k of keys) {
    if (!k.startsWith("eyJ")) continue;
    let ref = ""; try { ref = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref === POS_REF) posKey = k;
  }
  if (!posKey) { console.log("❌ no key"); return; }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  console.log("── pos_grabber_push_log（最新）──");
  const a = await get(`${base}/pos_grabber_push_log?select=*&order=captured_at.desc&limit=6`, H);
  console.log(`status=${a.status}`);
  try {
    const arr = JSON.parse(a.body);
    if (!Array.isArray(arr)) console.log(String(a.body).slice(0, 400));
    else for (const r of arr) {
      console.log(`\n[${r.captured_at}] source=${r.source} recv=${r.received_count} created=${r.created_count} skipped=${r.skipped_count} rejected=${r.rejected_count}`);
      console.log(`  rejected_detail = ${JSON.stringify(r.rejected_detail)}`);
      console.log(`  local_order_nos = ${JSON.stringify(r.local_order_nos)}`);
    }
  } catch { console.log(String(a.body).slice(0, 400)); }

  console.log("\n── pos_grabber_inbox（最新 10，睇 reject_reason）──");
  const b = await get(`${base}/pos_grabber_inbox?select=platform,kind,dedup_key,local_order_no,parse_ok,reject_reason,captured_at,projected_at&order=captured_at.desc&limit=10`, H);
  console.log(`status=${b.status}`);
  try {
    const arr = JSON.parse(b.body);
    if (!Array.isArray(arr)) console.log(String(b.body).slice(0, 400));
    else for (const r of arr) {
      console.log(`  [${r.captured_at}] ${r.platform}/${r.kind} ${r.dedup_key} lo=${r.local_order_no} ok=${r.parse_ok} reason=${r.reject_reason} proj=${r.projected_at}`);
    }
  } catch { console.log(String(b.body).slice(0, 400)); }
})();
