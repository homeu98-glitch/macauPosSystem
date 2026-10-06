/**
 * 驗證：PostgREST 分辨「表唔存在（PGRST205）」vs「表存在但無 grant（42501）」。
 * 2026-10-06
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
  for (const p of ["/prints", "/pos", "/orders", "/"]) {
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
  for (const key of keys) {
    if (!key.startsWith("eyJ")) continue;
    let ref = "";
    try { ref = JSON.parse(Buffer.from(key.split(".")[1], "base64").toString()).ref || ""; } catch {}
    if (ref !== POS_REF) continue;
    posKey = key;
  }
  if (!posKey) { console.log("❌ 搵唔到 POS anon key"); return; }
  console.log("✅ POS anon key 已確認（ref=iyrywzormzisyppkokbi）\n");

  const H = { apikey: posKey, authorization: `Bearer ${posKey}`, prefer: "count=exact" };
  const base = `https://${POS_REF}.supabase.co/rest/v1`;

  const targets = [
    ["① 一定唔存在", "zz_definitely_not_a_table_20261006"],
    ["② grabber inbox", "pos_grabber_inbox"],
    ["③ grabber capability", "pos_grabber_capability"],
    ["④ push log (0062)", "pos_grabber_push_log"],
    ["⑤ 對照 pos_orders", "pos_orders"],
  ];
  for (const [label, t] of targets) {
    const r = await get(`${base}/${t}?select=*&limit=1`, H);
    let code = "";
    try {
      const j = JSON.parse(r.body);
      code = `${j.code || ""} ${j.message || j.hint || ""}`.trim();
    } catch { code = String(r.body).slice(0, 80); }
    console.log(`${label.padEnd(22)} → ${String(r.status).padEnd(4)} ${code.slice(0, 95)}`);
  }
})();
