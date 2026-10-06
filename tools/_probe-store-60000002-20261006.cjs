/**
 * 追查兩件事：
 * ① APK 實際送嘅 store_id（由 grabber SP key 已知 = d564b932…）
 * ② 60000002 對應邊個 store；同 8291f843（舊插件用緊）係咪同一間
 * ③ d564b932 有冇 mfood 單落咗（決定 2 張單係咪真入咗）
 * 2026-10-06
 */
const https = require("node:https");

const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";
const APK_STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13"; // 由 SP key grabber_cutoff_date_<id> 抽到
const PLUGIN_STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => {
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("end", () => res({ status: s.statusCode, body: d, headers: s.headers }));
      }
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
    let ref = "";
    try { ref = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref === POS_REF) posKey = k;
  }
  if (!posKey) { console.log("❌ 搵唔到 POS anon key"); return; }
  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  console.log(`APK store_id（由 SP 抽）  = ${APK_STORE}`);
  console.log(`舊插件 store_id（mfood） = ${PLUGIN_STORE}`);
  console.log(`兩者相同？ ${APK_STORE === PLUGIN_STORE ? "✅ 同一間" : "❌ 唔同店"}\n`);

  // ① APK store 全部單
  console.log(`═══ ① store ${APK_STORE.slice(0, 8)}… 全部單 ═══`);
  const r1 = await get(
    `${base}/pos_orders?select=local_order_no,source,status,total,table_name,created_at&store_id=eq.${APK_STORE}&order=created_at.desc&limit=20`,
    H
  );
  try {
    const rows = JSON.parse(r1.body);
    if (!rows.length) console.log("  (冇單)");
    else
      for (const r of rows) {
        const t = r.created_at ? new Date(r.created_at).toISOString() : "?";
        console.log(`  ${r.local_order_no || "-"} | ${r.source || "pos"} | ${r.status} | total=${r.total} | 枱=${r.table_name || "-"} | ${t}`);
      }
  } catch { console.log("  ", String(r1.body).slice(0, 200)); }

  // ② APK store 有冇 mfood
  const r2 = await get(`${base}/pos_orders?select=id&store_id=eq.${APK_STORE}&source=eq.mfood`, H);
  const cr = r2.headers["content-range"] || "?";
  let n2 = 0;
  try { n2 = JSON.parse(r2.body).length; } catch {}
  console.log(`\n═══ ② APK store 有幾多 mfood 單？═══`);
  console.log(`  rows=${n2}  content-range=${cr}  ⇒ ${cr === "0/*" || n2 === 0 ? "❌ 一張都冇入" : "✅ 有入"}`);

  // ③ 兩間店嘅 pos 單對照（睇係咪同一間實體店）
  console.log(`\n═══ ③ 舊插件 store ${PLUGIN_STORE.slice(0, 8)}… 概況 ═══`);
  const r3 = await get(
    `${base}/pos_orders?select=source,table_name,created_at&store_id=eq.${PLUGIN_STORE}&order=created_at.desc&limit=8`,
    H
  );
  try {
    for (const r of JSON.parse(r3.body)) {
      console.log(`  ${r.source || "pos"} | 枱=${r.table_name || "-"} | ${new Date(r.created_at).toISOString()}`);
    }
  } catch {}

  // ④ external_order_id 對撞測試：APK 送嘅單號 vs 插件已入嘅單號
  console.log(`\n═══ ④ 兩個 store 嘅 mfood external_order_id 有冇重疊 ═══`);
  const r4 = await get(`${base}/pos_orders?select=store_id,external_order_id&source=eq.mfood&limit=50`, H);
  try {
    const byExt = {};
    for (const r of JSON.parse(r4.body)) {
      (byExt[r.external_order_id] = byExt[r.external_order_id] || new Set()).add(r.store_id);
    }
    for (const [ext, stores] of Object.entries(byExt)) {
      console.log(`  ${ext} → ${[...stores].map((s) => s.slice(0, 8)).join(",")}`);
    }
  } catch {}
})();
