// 唯讀探測（2026-09-22 19:40）：查 #19 到底喺唔喺雲端、打印 job 狀態如何。
// 手法同 tools/_probe-jobs-20260916.cjs 一致：由部署 bundle 抽公開 anon key（POS 專案）。
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

(async () => {
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const payload = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (payload.ref === "iyrywzormzisyppkokbi") {
          anonKey = m[0];
          break;
        }
      } catch {}
    }
  }
  if (!anonKey) {
    console.log("NO_ANON_KEY");
    return;
  }
  console.log("anon key OK (iyrywzormzisyppkokbi)\n");

  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const q = async (path, label) => {
    const r = await get(base + path, h);
    console.log(`=== ${label} === HTTP ${r.status} len=${(r.body || "").length}`);
    if (r.error) console.log("ERR", r.error);
    try {
      const rows = JSON.parse(r.body);
      if (Array.isArray(rows)) {
        console.log(`rows=${rows.length}`);
        console.log(JSON.stringify(rows, null, 1).slice(0, 6000));
      } else {
        console.log(r.body.slice(0, 800));
      }
    } catch (e) {
      console.log((r.body || "").slice(0, 600));
    }
    console.log("");
  };

  // 1. 今日全部訂單（輕量欄位）
  await q(
    `/pos_orders?store_id=eq.${STORE}&created_at=gte.2026-09-22T00:00:00%2B08:00&select=local_order_no,status,fulfillment_status,table_name,total,source,online_order_id,created_at,updated_at&order=created_at.asc`,
    "今日 pos_orders",
  );

  // 2. 專搵 19 / 23
  await q(
    `/pos_orders?store_id=eq.${STORE}&or=(local_order_no.eq.%E8%A8%82%E5%96%AE19,local_order_no.eq.%E8%A8%82%E5%96%AE23,local_order_no.eq.19,local_order_no.eq.23,local_order_no.like.*19)&select=*&limit=20`,
    "搵 19/23",
  );

  // 3. 今日打印 job
  await q(
    `/pos_print_jobs?store_id=eq.${STORE}&created_at=gte.2026-09-22T00:00:00%2B08:00&select=order_no,kind,ticket_type,printer_name,printer_group,status,attempts,claimed_by,finished_at,last_error,created_at,updated_at&order=created_at.desc&limit=200`,
    "今日 pos_print_jobs",
  );

  // 4. print job 欄位統計（status null 有幾多）
  await q(
    `/pos_print_jobs?store_id=eq.${STORE}&created_at=gte.2026-09-22T00:00:00%2B08:00&select=status&limit=1000`,
    "status 分佈原始",
  );
})();
