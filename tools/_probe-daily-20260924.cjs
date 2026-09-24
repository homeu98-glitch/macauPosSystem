/**
 * 2026-09-24 唯讀取證：用已部署 bundle 抽出嘅 anon key 直查 PostgREST，
 * 統計每個澳門日嘅訂單數（＝把 egress 換算成「每張單幾多 MB」）。
 * 唔寫任何資料。
 */
const https = require("node:https");
function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const H = "https://iyrywzormzisyppkokbi.supabase.co";

(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/", "/pos", "/orders", "/login"]) {
    try {
      const r = await get(base + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch { /* ignore */ }
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await get(base + s);
      const m = r.body.match(JWT);
      if (m && m.length) { K = m[0]; break; }
    } catch { /* ignore */ }
  }
  console.log("anon key:", K ? K.slice(0, 18) + "…len=" + K.length : "抽取失敗");
  if (!K) return;

  // 1) 訂單：按澳門日統計
  const r = await get(`${H}/rest/v1/pos_orders?select=id,store_id,status,created_at,updated_at&order=created_at.desc&limit=2000&apikey=${K}`);
  let orders = [];
  try { orders = JSON.parse(r.body); } catch { console.log("pos_orders 讀取失敗:", String(r.body).slice(0, 200)); }
  console.log("pos_orders status=", r.status, Array.isArray(orders) ? "(array)" : String(r.body).slice(0, 220));
  if (Array.isArray(orders)) {
    console.log(`pos_orders 可見 ${orders.length} 筆（anon 72h 窗口）；範圍 ${orders[orders.length - 1]?.created_at} → ${orders[0]?.created_at}`);
    const macDay = (iso) => iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10) : "-";
    const byDay = {};
    const byDayStore = {};
    const byStatus = {};
    for (const o of orders) {
      const d = macDay(o.created_at);
      byDay[d] = (byDay[d] || 0) + 1;
      byDayStore[d] = byDayStore[d] || {};
      byDayStore[d][o.store_id] = (byDayStore[d][o.store_id] || 0) + 1;
      byStatus[d] = byStatus[d] || {};
      byStatus[d][o.status] = (byStatus[d][o.status] || 0) + 1;
    }
    console.log("\n=== 按澳門日（建立日）===");
    for (const d of Object.keys(byDay).sort()) {
      console.log(`  ${d}  訂單 ${String(byDay[d]).padStart(4)}   店: ${JSON.stringify(byDayStore[d])}`);
      console.log(`          狀態: ${JSON.stringify(byStatus[d])}`);
    }
    const storeCount = {};
    for (const o of orders) storeCount[o.store_id] = (storeCount[o.store_id] || 0) + 1;
    console.log("\n=== 按店 ===", JSON.stringify(storeCount, null, 1));
  }

  // 2) 逐日 egress（若 admin 才可讀會 401）
  const e = await get(`${H}/rest/v1/pos_egress_daily?select=*&order=day.desc&limit=10&apikey=${K}`);
  console.log("\npos_egress_daily status=", e.status, String(e.body).slice(0, 400));

  // 3) 營業狀態 / 中繼機
  for (const t of ["pos_store_status?select=*", "pos_print_agents?select=*&limit=20"]) {
    const x = await get(`${H}/rest/v1/${t}&apikey=${K}`);
    console.log(`\n${t.split("?")[0]} status=${x.status}`, String(x.body).slice(0, 400));
  }
})();
