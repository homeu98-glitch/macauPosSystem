/** 唯讀：試用 Ledger publishable key 直接調 RPC list_merchant_orders（睇 anon 有無 execute 權）。 */
const https = require("node:https");

function post(url, body, headers) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "user-agent": "Mozilla/5.0", ...headers } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ status: r.statusCode, body: d })); }
    );
    req.on("error", rej);
    req.write(data);
    req.end();
  });
}

const KEY = "sb_publishable_WpIr6L4VRjOaKEP8RgFExQ_MQZ6g8Dc";
const LEDGER_BASE = "https://zymdemjflsckicwcinxl.supabase.co";
const H = { apikey: KEY, authorization: `Bearer ${KEY}` };

(async () => {
  const trials = [
    ["list_merchant_orders", { p_merchant_id: "8291f843-9def-4956-9d0b-1cfef2598306", p_status: null, p_limit: 200, p_since: "2026-09-23T16:00:00.000Z", p_since_id: null }],
  ];
  for (const [fn, body] of trials) {
    const r = await post(`${LEDGER_BASE}/rest/v1/rpc/${fn}`, body, H);
    console.log(`[${fn}] status=${r.status}`);
    console.log(String(r.body).slice(0, 1200));
    console.log("---");
  }
})();
