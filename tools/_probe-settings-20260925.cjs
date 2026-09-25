/** 唯讀：讀線上接單開關 + 店狀態 + 中繼機清單 + 今日 print job 覆核 */
const https = require("node:https");
function req(url, headers) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: "GET", headers }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const macau = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) : "-";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/pos", "/prints"]) { const r = await req(base + p, { "user-agent": "Mozilla/5.0" }); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); }
  let K = "";
  for (const s of chunks) { const r = await req(base + s, { "user-agent": "Mozilla/5.0" }); const m = r.body.match(JWT); if (m && m.length) { K = m[0]; break; } }
  const h = { apikey: K, Authorization: `Bearer ${K}`, "user-agent": "Mozilla/5.0" };
  const show = async (label, path) => {
    const r = await req(`${H}/rest/v1/${path}`, h);
    console.log(`\n--- ${label} → ${r.status}`);
    console.log(r.body.slice(0, 1200));
  };

  await show("online_order_settings（自動接單）", `pos_online_order_settings?select=*&store_id=eq.${STORE}`);
  await show("store_status（線下開關）", `pos_store_status?select=*&store_id=eq.${STORE}`);
  await show("kiosk_settings（自助點餐）", `pos_kiosk_settings?select=*&store_id=eq.${STORE}`);
  await show("print_agents（中繼機）", `pos_print_agents?select=agent_id,name,last_seen_at,revoked_at&store_id=eq.${STORE}&order=last_seen_at.desc`);
  await show("shifts（最近開工）", `pos_shifts?select=id,store_id,opened_at,closed_at,operator&store_id=eq.${STORE}&order=opened_at.desc&limit=5`);
  await show("今日 print jobs（全欄位 count）", `pos_print_jobs?select=id,order_no,status,created_at,once_key,claimed_by&store_id=eq.${STORE}&created_at=gte.2026-09-24T16:00:00Z&order=created_at.asc`);
})();
