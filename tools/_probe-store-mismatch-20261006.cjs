/**
 * 追查：APK 實際送去邊間店？pos_orders 寫入嘅 store_id 對唔對得上？
 * 2026-10-06 · 用戶報告「登入 60000002 但單入咗另一間店」
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

  // ① 全部 print agent（睇 agent → store 綁定）
  console.log("═══ ① pos_print_agents（agent → store 綁定）═══");
  const a = await get(`${base}/pos_print_agents?select=*&limit=50`, H);
  console.log(`status=${a.status}`);
  try {
    const rows = JSON.parse(a.body);
    if (!Array.isArray(rows)) console.log(String(a.body).slice(0, 250));
    else if (!rows.length) console.log("(冇 agent)");
    else
      for (const r of rows) {
        console.log(
          `  agent=${String(r.agent_id).slice(0, 12)}… store=${r.store_id}` +
            ` revoked=${r.revoked_at ? "YES" : "no"} last_seen=${r.last_seen_at || "-"}`
        );
      }
  } catch { console.log(String(a.body).slice(0, 250)); }

  // ② 搵 60000002 對應邊個 uuid（pos_orders / pos_store_status 都試）
  console.log("\n═══ ② 搵 merchant 60000002 嘅 store uuid ═══");
  for (const t of ["pos_orders", "pos_store_status"]) {
    const r = await get(`${base}/${t}?select=*&limit=1`, H);
    let keys2 = [];
    try { const j = JSON.parse(r.body); if (Array.isArray(j) && j[0]) keys2 = Object.keys(j[0]); } catch {}
    console.log(`  ${t} → ${r.status} 欄位: ${keys2.join(",").slice(0, 300)}`);
  }

  // ③ 全部有 mfood 單嘅 store（已知 8291f843…）
  console.log("\n═══ ③ pos_orders 全部 store_id（近 7 日）═══");
  const o = await get(
    `${base}/pos_orders?select=store_id,source,created_at&created_at=gte.2026-09-29T00:00:00Z&order=created_at.desc&limit=200`,
    H
  );
  const m = {};
  try {
    for (const r of JSON.parse(o.body)) {
      const k = `${r.store_id}`;
      m[k] = m[k] || {};
      m[k][r.source || "?"] = (m[k][r.source || "?"] || 0) + 1;
    }
  } catch {}
  for (const [k, v] of Object.entries(m)) console.log(`  ${k} → ${JSON.stringify(v)}`);

  // ④ agent 綁嘅 store 有冇 mfood 單
  console.log("\n═══ ④ agent store 有冇單 ═══");
  const o2 = await get(`${base}/pos_orders?select=store_id&source=eq.mfood&limit=200`, H);
  const s2 = new Set();
  try { for (const r of JSON.parse(o2.body)) s2.add(r.store_id); } catch {}
  console.log(`  有 mfood 單嘅 store: ${[...s2].join(", ")}`);
})();
