/**
 * 2026-09-21 唯讀探測（第四輪）：過去 7 日「每張單出幾多張紙」統計，
 * 睇「同一張單短時間內多張同類單」係系統性問題定一次性。
 * 用 printer_group 分辨 kitchen / receipt。
 * 用法：node tools/_probe-dup-receipt4-20260921.cjs
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

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await get(
    `${base}/pos_print_jobs?select=created_at,order_id,order_no,table_name,printer_group,printer_id,status` +
      `&created_at=gte.${since}&order=created_at.asc&limit=1000`,
    h,
  );
  const rows = JSON.parse(r.body);
  if (!Array.isArray(rows)) return console.log(r.status, r.body.slice(0, 400));
  console.log(`近 7 日共 ${rows.length} 張 job\n`);

  // 按 (order_id, printer_group) 分組，計「同一張單同一類單」出現次數
  const groups = {};
  for (const row of rows) {
    const k = `${row.order_id}||${row.printer_group ?? "?"}`;
    (groups[k] = groups[k] || []).push(row);
  }
  const dup = Object.entries(groups).filter(([, list]) => list.length > 1);
  console.log(`=== 同一訂單 × 同一類單出現多過一次：${dup.length} 組 ===`);
  for (const [k, list] of dup) {
    const [orderId, group] = k.split("||");
    const tables = [...new Set(list.map((x) => x.table_name ?? "-"))];
    const t0 = Date.parse(list[0].created_at);
    const tN = Date.parse(list[list.length - 1].created_at);
    console.log(
      `\n${group.padEnd(8)} ×${list.length}  單號=${list[0].order_no}  order_id=${orderId}` +
        `\n    table_name=${JSON.stringify(tables)}  時間跨度=${((tN - t0) / 1000).toFixed(1)}s`,
    );
    for (const x of list) console.log(`      ${MACAU(x.created_at)}  ${x.printer_id}  ${x.status}`);
  }

  console.log("\n=== 每張單嘅出紙張數（整體）===");
  const perOrder = {};
  for (const row of rows) {
    perOrder[row.order_id] = perOrder[row.order_id] || { kitchen: 0, receipt: 0, other: 0, no: row.order_no };
    const g = row.printer_group === "kitchen" ? "kitchen" : row.printer_group === "receipt" ? "receipt" : "other";
    perOrder[row.order_id][g] += 1;
  }
  for (const [k, v] of Object.entries(perOrder)) {
    console.log(`  ${v.no}  kitchen=${v.kitchen}  receipt=${v.receipt}  other=${v.other}  (${k.slice(0, 24)})`);
  }
})().catch((e) => console.error("失敗：", e.message));
