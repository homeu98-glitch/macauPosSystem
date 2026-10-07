/**
 * 檢查 2026-10-07 新單的落庫情形（含重複/狀態），唯讀 anon。
 */
const https = require("node:https");

const SITE = "https://macau-pos-system.vercel.app";
const POS_REF = "iyrywzormzisyppkokbi";

function get(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) }, timeout: 25000 },
      (s) => {
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("end", () => res({ status: s.statusCode, body: d }));
      }
    );
    r.on("error", (e) => res({ status: "ERR", body: String(e.message) }));
    r.on("timeout", () => { r.destroy(); res({ status: "TIMEOUT", body: "" }); });
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

  console.log("── 全部 mfood 單（按 external_order_id 分組）──");
  const o = await get(
    `${base}/pos_orders?select=id,local_order_no,status,external_order_id,source,created_at,settled_at,total,platform_net_amount&source=eq.mfood&order=created_at.desc&limit=30`,
    H
  );
  console.log(`status=${o.status}`);
  try {
    const rows = JSON.parse(o.body);
    console.log(`共 ${rows.length} 筆`);
    const byExt = {};
    for (const r of rows) {
      const k = r.external_order_id || "(null)";
      (byExt[k] = byExt[k] || []).push(r);
    }
    for (const [ext, list] of Object.entries(byExt)) {
      console.log(`\n ext=${ext}`);
      for (const r of list) {
        console.log(`   ${String(r.local_order_no).padEnd(16)} ${String(r.status).padEnd(10)} created=${r.created_at} settled=${r.settled_at || "-"} total=${r.total}`);
      }
    }
  } catch (e) {
    console.log("parse err", e.message, o.body.slice(0, 400));
  }
})();
