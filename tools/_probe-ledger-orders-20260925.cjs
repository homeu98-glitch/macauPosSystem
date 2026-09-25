/** 唯讀：用 bundle 內 Ledger publishable key 查兩張線上單 */
const https = require("node:https");
function req(url, headers) {
  return new Promise((res, rej) => {
    const r = https.request(url, { method: "GET", headers: headers || { "user-agent": "Mozilla/5.0" } }, (s) => {
      let d = ""; s.on("data", (c) => (d += c));
      s.on("end", () => res({ status: s.statusCode, body: d }));
    });
    r.on("error", rej); r.setTimeout(20000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}
(async () => {
  const base = "https://macau-pos-system.vercel.app";
  const t = await new Promise((res, rej) => { https.get(base + "/pos", { headers: { "user-agent": "Mozilla/5.0" } }, (s) => { let d = ""; s.on("data", (c) => (d += c)); s.on("end", () => res(d)); }).on("error", rej); });
  const chunks = [...new Set(t.match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let KEY = "";
  for (const c of chunks) {
    const body = await new Promise((res, rej) => { https.get(base + c, { headers: { "user-agent": "Mozilla/5.0" } }, (s) => { let d = ""; s.on("data", (x) => (d += x)); s.on("end", () => res(d)); }).on("error", rej); });
    const m = body.match(/sb_publishable_[A-Za-z0-9_\-]+/);
    if (m) { KEY = m[0]; break; }
  }
  console.log("Ledger key =", KEY || "(冇)");
  const L = "https://zymdemjflsckicwcinxl.supabase.co";
  const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, "user-agent": "Mozilla/5.0" };
  const IDS = "b2aa7a13-5c68-415c-87ff-f476e564c202,c5a19d31-1dc5-4cf3-a013-e502390901cb";
  const r1 = await req(`${L}/rest/v1/orders?select=*&id=in.(${IDS})`, h);
  console.log("orders status", r1.status);
  console.log(r1.body.slice(0, 2000));
  const r2 = await req(`${L}/rest/v1/orders?select=id,status,created_at,updated_at,pickup_code,total_avos&id=in.(${IDS})`, h);
  console.log("\n精簡 status", r2.status);
  console.log(r2.body.slice(0, 1200));
})();
