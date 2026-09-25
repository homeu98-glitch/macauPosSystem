/** 唯讀：由已部署 bundle 抽 Ledger 憑證，查兩張線上單嘅時間戳 */
const https = require("node:https");
const fs = require("node:fs");
function req(url, method, headers, body) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: method || "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}
const out = []; const log = (...a) => { const s = a.map(String).join(" "); out.push(s); console.log(s); };
function refOf(jwt) { try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString()).ref; } catch { return "?"; } }
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const chunks = new Set();
  for (const p of ["/pos", "/orders", "/prints"]) {
    try { const r = await req(base + p); (r.body.match(/\/_next\/static\/[^"'\s]+\.js/g) || []).forEach((s) => chunks.add(s)); } catch {}
  }
  log("chunks =", chunks.size);
  const found = new Map();  // ref -> key
  const urls = new Set();
  for (const s of chunks) {
    try {
      const r = await req(base + s);
      for (const m of r.body.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || []) {
        const ref = refOf(m); if (!found.has(ref)) found.set(ref, m);
      }
      for (const m of r.body.match(/https:\/\/[a-z0-9]+\.supabase\.co/g) || []) urls.add(m);
    } catch {}
  }
  log("bundle 內 supabase 網址：", [...urls].join(", "));
  log("JWT refs：", [...found.keys()].map((r) => r + "(" + (found.get(r).split(".")[2].includes("anon") || true ? "" : "") + ")").join(", "));
  for (const [ref, k] of found) {
    try {
      const p = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString());
      log(`  ref=${ref} role=${p.role} iat=${new Date(p.iat * 1000).toISOString().slice(0, 10)}`);
    } catch {}
  }

  // 對 Ledger（zymdemjflsckicwcinxl）試查
  const ledgerKey = found.get("zymdemjflsckicwcinxl");
  if (!ledgerKey) { log("❌ bundle 冇 Ledger 專案 key（前端可能唔直接連 Ledger）"); fs.writeFileSync("tools/_probe-ledger-20260925.out.txt", out.join("\n")); return; }
  const h = { apikey: ledgerKey, Authorization: `Bearer ${ledgerKey}`, "user-agent": "Mozilla/5.0" };
  const get = (p) => req(`https://zymdemjflsckicwcinxl.supabase.co/rest/v1/${p}`, "GET", h);
  const r1 = await get(`orders?select=*&id=in.(b2aa7a13-5c68-415c-87ff-f476e564c202,c5a19d31-1dc5-4cf3-a013-e502390901cb)`);
  log("\n=== Ledger orders（anon）status", r1.status, "===");
  log(String(r1.body).slice(0, 1200));
  fs.writeFileSync("tools/_probe-ledger-20260925.out.txt", out.join("\n"));
})();
