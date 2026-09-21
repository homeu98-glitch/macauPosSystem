/**
 * 2026-09-21 唯讀探測（第二輪）：睇 pos_print_jobs 完整欄位 + 訂單內容，
 * 分辨嗰 4 張係「收據」定「廚房單」，同埋係咪同一版本嘅訂單。
 *
 * 用法：node tools/_probe-dup-receipt2-20260921.cjs
 */
const https = require("https");
const REF = "iyrywzormzisyppkokbi";
const SITE = process.env.POS_SITE || "https://macau-pos-system.vercel.app";

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
const MACAU = (iso) =>
  iso ? new Date(iso).toLocaleString("zh-HK", { timeZone: "Asia/Macau", hour12: false }) : "-";

(async () => {
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        if (JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8")).ref === REF) {
          anonKey = m[0];
          break;
        }
      } catch {}
    }
  }
  if (!anonKey) return console.log("搵唔到 anon key");
  const base = `https://${REF}.supabase.co/rest/v1`;
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  // 1) 4 張 job 完整內容
  const r = await get(
    `${base}/pos_print_jobs?order_id=eq.ledger-e26fa77b-df1d-4e67-978d-2358c2574c67&order=created_at.asc`,
    h,
  );
  const rows = JSON.parse(r.body);
  console.log(`=== 同一張單嘅全部 job：${rows.length} 行 ===`);
  console.log("欄位：", Object.keys(rows[0] || {}).join(", "), "\n");
  for (const row of rows) {
    console.log("─".repeat(70));
    console.log(`created_at = ${MACAU(row.created_at)}   printer = ${row.printer_id} / ${row.printer_name}`);
    console.log(`table_name = ${row.table_name}   order_no = ${row.order_no}   status = ${row.status}`);
    // 印出所有「細」欄位（唔印大 blob）
    for (const [k, v] of Object.entries(row)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (s && s.length < 300) console.log(`   ${k} = ${s}`);
      else console.log(`   ${k} = <${s ? s.length : 0} chars>`);
    }
  }

  // 2) 訂單本體
  const r2 = await get(
    `${base}/pos_orders?id=eq.ledger-e26fa77b-df1d-4e67-978d-2358c2574c67`,
    h,
  );
  console.log("\n=== pos_orders 同一張單 ===");
  try {
    const orders = JSON.parse(r2.body);
    if (Array.isArray(orders) && orders[0]) {
      const o = orders[0];
      for (const [k, v] of Object.entries(o)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        console.log(`   ${k} = ${s && s.length > 400 ? s.slice(0, 400) + "…" : s}`);
      }
    } else console.log(r2.status, r2.body.slice(0, 300));
  } catch {
    console.log(r2.status, r2.body.slice(0, 300));
  }

  // 3) 同一部打印機（printer-22a790b1）今日所有 job → 睇係咪成日都咁
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r3 = await get(
    `${base}/pos_print_jobs?select=created_at,order_id,order_no,table_name,printer_id,status&printer_id=eq.printer-22a790b1&created_at=gte.${since}&order=created_at.asc&limit=200`,
    h,
  );
  const r3rows = JSON.parse(r3.body);
  console.log(`\n=== printer-22a790b1 近 24 小時：${Array.isArray(r3rows) ? r3rows.length : "?"} 行 ===`);
  if (Array.isArray(r3rows)) {
    for (const row of r3rows) {
      console.log(
        `${MACAU(row.created_at)}  ${row.order_no}  ${row.table_name}  order_id=${String(row.order_id).slice(0, 22)}  ${row.status}`,
      );
    }
  } else console.log(r3.status, r3.body.slice(0, 300));
})().catch((e) => console.error("失敗：", e.message));
