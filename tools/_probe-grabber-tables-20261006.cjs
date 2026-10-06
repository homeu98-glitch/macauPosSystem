/**
 * 唯讀：抽 POS 專案 anon key，探測 grabber 新表（migration 0064）是否已落地。
 * 2026-10-06
 */
const https = require("node:https");

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

const SITE = "https://macau-pos-system.vercel.app";
const PK = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const JW = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const POS_REF = "iyrywzormzisyppkokbi";

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos", "/orders", "/login", "/"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  const keys = new Set();
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      (r.body.match(PK) || []).forEach((t) => keys.add(t));
      (r.body.match(JW) || []).forEach((t) => keys.add(t));
    } catch {}
  }
  console.log(`chunks=${chunks.size} keys=${keys.size}`);

  let posKey = null;
  for (const key of keys) {
    // 先確認係 POS 專案（decode JWT payload.ref）
    let ref = "?";
    if (key.startsWith("eyJ")) {
      try {
        ref = JSON.parse(Buffer.from(key.split(".")[1], "base64").toString()).ref || "?";
      } catch {}
    }
    const r = await get(`https://${POS_REF}.supabase.co/rest/v1/pos_store_status?select=*&limit=1`, {
      apikey: key,
      authorization: `Bearer ${key}`,
    });
    console.log(`key ${key.slice(0, 26)}… ref=${ref} → pos_store_status=${r.status}`);
    if (r.status === 200 && !posKey) posKey = key;
  }

  if (!posKey) {
    console.log("\n❌ 搵唔到 POS anon key");
    return;
  }
  console.log(`\n✅ 用 POS anon key 探測 grabber 新表（migration 0064）`);
  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  for (const t of ["pos_grabber_inbox", "pos_grabber_capability", "pos_grabber_push_log"]) {
    const r = await get(`${base}/${t}?select=*&limit=1`, H);
    console.log(`  ${t} → ${r.status}  ${String(r.body).replace(/\s+/g, " ").slice(0, 160)}`);
  }

  // 對照：已知一定存在的表
  const ctl = await get(`${base}/pos_orders?select=id&limit=1`, H);
  console.log(`  [對照] pos_orders → ${ctl.status}`);
})();
