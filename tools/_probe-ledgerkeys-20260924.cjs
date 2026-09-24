/**
 * 唯讀：抽 Ledger publishable key，查 Ledger 線上單（2026-09-24）。
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res({ status: r.statusCode, body: d }));
    }).on("error", rej);
  });
}

const SITE = "https://macau-pos-system.vercel.app";
const PK = /sb_publishable_[A-Za-z0-9_-]{10,}/g;
const JW = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

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
  console.log("bundle keys:", [...keys].map((k) => k.slice(0, 40) + "…").join("\n  "));

  const refs = [
    ["Ledger", "zymdemjflsckicwcinxl"],
    ["POS", "iyrywzormzisyppkokbi"],
  ];
  for (const [name, ref] of refs) {
    for (const key of keys) {
      const base = `https://${ref}.supabase.co/rest/v1`;
      const H = { apikey: key, authorization: `Bearer ${key}` };
      const r = await get(`${base}/orders?select=*&limit=1`, H);
      const ok = r.status === 200;
      console.log(`\n[${name}] ${key.slice(0, 30)}… → orders status=${r.status}${ok ? " ✓" : ""}`);
      if (ok) {
        let rows = [];
        try { rows = JSON.parse(r.body); } catch {}
        if (Array.isArray(rows) && rows[0]) console.log("  欄位:", Object.keys(rows[0]).join(","));
        else console.log("  回應:", String(r.body).slice(0, 200));
      } else {
        console.log("  ", String(r.body).slice(0, 200));
      }
    }
  }
})();
