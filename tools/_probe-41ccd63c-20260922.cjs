// 唯讀：查 order-41ccd63c ＋ 最近 2 小時訂單 ＋ 今日狀態分佈 ＋ 最近 print jobs
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
function get(url, headers = {}) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { "user-agent": "Mozilla/5.0", ...headers } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      })
      .on("error", (e) => resolve({ status: 0, error: e.message }));
  });
}
const macau = (iso) =>
  iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "";

(async () => {
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (pl.ref === "iyrywzormzisyppkokbi") {
          anonKey = m[0];
          break;
        }
      } catch {}
    }
  }
  if (!anonKey) return console.log("NO_ANON_KEY");
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const q = async (path) => {
    const r = await get(base + path, h);
    try {
      return JSON.parse(r.body);
    } catch {
      return { __s: r.status, __b: (r.body || "").slice(0, 300) };
    }
  };
  const line = (o, extra = "") =>
    [
      String(o.local_order_no).padEnd(7),
      String(o.status).padEnd(16),
      String(o.table_name).padEnd(11),
      String(o.total).padStart(5),
      String(o.payment_method ?? "-").padEnd(9),
      "落單=" + macau(o.created_at),
      "更新=" + macau(o.updated_at),
      o.client_updated_at ? "client=" + macau(o.client_updated_at) : "",
      extra,
    ].join(" | ");

  console.log("### A. order-41ccd63c 完整");
  const a = await q(`/pos_orders?id=eq.order-41ccd63c&select=*`);
  console.log(JSON.stringify(a, null, 1).slice(0, 3000));

  console.log("\n### B. 最近 2 小時有動靜嘅訂單（updated_at >= 19:00 澳門 → 11:00Z）");
  const b = await q(
    `/pos_orders?store_id=eq.${STORE}&updated_at=gte.2026-09-22T11:00:00Z&select=id,local_order_no,status,table_name,total,payment_method,created_at,updated_at,client_updated_at,source,online_order_id&order=updated_at.desc&limit=100`,
  );
  (Array.isArray(b) ? b : []).forEach((o) => console.log(line(o), "| id=" + o.id));

  console.log("\n### C. 今日狀態分佈");
  const c = await q(
    `/pos_orders?store_id=eq.${STORE}&created_at=gte.2026-09-21T16:00:00Z&select=status,local_order_no&limit=500`,
  );
  const g = {};
  (Array.isArray(c) ? c : []).forEach((o) => (g[o.status] = (g[o.status] || 0) + 1));
  console.log(JSON.stringify(g));
  console.log("今日總數 =", Array.isArray(c) ? c.length : c);
  console.log(
    "未結帳（draft/sent_to_kitchen/paid/reopened）:",
    JSON.stringify((Array.isArray(c) ? c : []).filter((o) => /draft|sent_to_kitchen|paid|reopened/.test(o.status))),
  );

  console.log("\n### D. 最近 2 小時 pos_print_jobs");
  const d = await q(
    `/pos_print_jobs?store_id=eq.${STORE}&created_at=gte.2026-09-22T11:00:00Z&select=order_no,order_id,printer_group,printer_name,status,once_key,created_at,finished_at,last_error&order=created_at.desc&limit=60`,
  );
  (Array.isArray(d) ? d : []).forEach((r) =>
    console.log(
      [
        String(r.order_no).padEnd(7),
        String(r.printer_group).padEnd(8),
        String(r.printer_name).padEnd(30),
        String(r.status).padEnd(8),
        "建=" + macau(r.created_at),
        r.finished_at ? "完成=" + macau(r.finished_at) : "未完成",
        r.once_key ? "once=" + r.once_key.slice(0, 40) : "once=-",
        r.last_error ? "ERR=" + r.last_error : "",
      ].join(" | "),
    ),
  );
  console.log("count=", Array.isArray(d) ? d.length : d);
})();
