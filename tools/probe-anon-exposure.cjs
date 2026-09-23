/** 臨時：用 anon key 逐表探測曝光面（唯讀，只睇狀態碼 + 行數）。 */
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

(async () => {
  const H = "https://iyrywzormzisyppkokbi.supabase.co";
  let K = process.argv[2];
  if (!K) {
    const base = "https://macau-pos-system.vercel.app";
    const chunks = new Set();
    for (const p of ["/", "/pos", "/orders", "/login"]) {
      try {
        const r = await get(base + p);
        (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
      } catch { /* ignore */ }
    }
    for (const s of chunks) {
      try {
        const r = await get(base + s);
        const m = r.body.match(JWT);
        if (m && m.length) { K = m[0]; break; }
      } catch { /* ignore */ }
    }
    console.log("自動抽取 key:", K ? K.slice(0, 20) + "…" + K.length : "失敗");
  }
  const tables = [
    "pos_egress_daily", "pos_release_versions", "pos_sessions", "pos_print_agents",
    "pos_orders", "pos_print_jobs", "pos_queue_events", "pos_device_configs",
    "pos_print_templates", "pos_shifts", "pos_store_status", "pos_bootstrap_config",
    "pos_note_presets", "pos_soldout", "pos_online_order_settings",
  ];
  for (const t of tables) {
    const r = await get(`${H}/rest/v1/${t}?select=*&limit=2000&apikey=${K}`);
    let n = "-";
    try { const j = JSON.parse(r.body); if (Array.isArray(j)) n = j.length; } catch { n = String(r.body).slice(0, 90); }
    console.log(String(r.status).padEnd(6), String(n).padEnd(6), t);
  }
  // 統計 pos_orders 可見範圍
  const r = await get(`${H}/rest/v1/pos_orders?select=id,store_id,status,total,created_at&order=created_at.desc&limit=2000&apikey=${K}`);
  try {
    const j = JSON.parse(r.body);
    if (Array.isArray(j) && j.length) {
      console.log("pos_orders 可取 2000 上限內:", j.length, "最早:", j[j.length - 1].created_at, "最新:", j[0].created_at);
      const stores = [...new Set(j.map((x) => x.store_id))];
      console.log("涉及 store 數:", stores.length);
    }
  } catch { /* */ }
})();
