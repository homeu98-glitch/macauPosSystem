/**
 * 2026-09-21 唯讀探測：訂單 001 為咩一次過出咗 4 張收據。
 *
 * 做法：由已部署網站抽出公開 anon key（POS 專案 iyrywzormzisyppkokbi），
 * 直接唯讀查 pos_print_jobs，列出今日 10:50 之後嘅行，睇：
 *   · 4 行係咪同一個 order_id（＝同一張單）／唔同 order_id（＝兩張單）
 *   · printer_id 有幾多個（＝一單出幾部收據機）
 *   · table_name 真身（A01 vs 堂食）
 *   · created_at 精確到毫秒（＝幾個獨立事件）
 *   · queue payload 有冇重複事件
 *
 * 全部唯讀，唔寫任何嘢。
 * 用法：node tools/_probe-dup-receipt-20260921.cjs
 */
const https = require("https");

const SITE = process.env.POS_SITE || "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";

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
  // ── 1. 抽 anon key ──────────────────────────────────────────────
  const home = await get(SITE + "/prints");
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await get(SITE + p);
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const payload = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (payload.ref === REF) {
          anonKey = m[0];
          break;
        }
      } catch {}
    }
  }
  if (!anonKey) {
    console.log("搵唔到 POS anon key（網站可能改咗），只做程式碼側分析。");
    return;
  }
  console.log(`anon key OK（ref=${REF}）\n`);

  const base = `https://${REF}.supabase.co/rest/v1`;
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

  // ── 2. 今日 10:40 之後嘅 print jobs ────────────────────────────
  // 澳門 10:40 = UTC 02:40
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const q =
    `${base}/pos_print_jobs?select=*` +
    `&created_at=gte.${since}&order=created_at.asc&limit=200`;
  const r = await get(q, h);
  console.log("=== pos_print_jobs（近 3 小時，按時間升序）HTTP " + r.status + " ===");
  let rows = [];
  try {
    rows = JSON.parse(r.body);
  } catch {
    console.log(r.body.slice(0, 600));
    return;
  }
  if (!Array.isArray(rows)) {
    console.log(JSON.stringify(rows).slice(0, 600));
    return;
  }

  const cols = ["created_at", "order_no", "table_name", "kind", "ticket_type", "printer_id", "printer_name", "status"];
  console.log(cols.join(" | "));
  for (const row of rows) {
    console.log(
      cols
        .map((c) => (c === "created_at" ? MACAU(row[c]) : String(row[c] ?? "-")).slice(0, 26))
        .join(" | "),
    );
  }

  // ── 3. 分組統計 ────────────────────────────────────────────────
  const byOrderId = {};
  for (const row of rows) {
    const k = row.order_id ?? "(null)";
    byOrderId[k] = byOrderId[k] || [];
    byOrderId[k].push(row);
  }
  console.log(`\n=== 按 order_id 分組：${Object.keys(byOrderId).length} 個 order_id ===`);
  for (const [k, list] of Object.entries(byOrderId)) {
    const printers = [...new Set(list.map((x) => x.printer_id ?? x.printer_name ?? "-"))];
    const tables = [...new Set(list.map((x) => x.table_name ?? "-"))];
    const kinds = [...new Set(list.map((x) => x.kind ?? "-"))];
    const times = list.map((x) => x.created_at);
    console.log(
      `\norder_id=${k}\n  張數=${list.length}  打印機=${JSON.stringify(printers)}  table_name=${JSON.stringify(
        tables,
      )}  kind=${JSON.stringify(kinds)}\n  最早=${MACAU(times[0])}  最晚=${MACAU(times[times.length - 1])}`,
    );
    for (const x of list) {
      console.log(`    ${MACAU(x.created_at)}  id=${x.id}  status=${x.status}  copies=${x.copies ?? "-"}`);
    }
  }

  // ── 4. 睇埋 pos_orders 同一個時段（確認有幾張 001）─────────────
  const r2 = await get(
    `${base}/pos_orders?select=id,local_order_no,table_id,table_name,status,source,total,created_at,updated_at,settled_at&created_at=gte.${since}&order=created_at.asc&limit=100`,
    h,
  );
  console.log("\n=== pos_orders（近 3 小時）HTTP " + r2.status + " ===");
  try {
    const orders = JSON.parse(r2.body);
    if (Array.isArray(orders)) {
      for (const o of orders) {
        console.log(
          `${MACAU(o.created_at)}  no=${o.local_order_no}  id=${o.id}  table=${o.table_name}(${o.table_id})  status=${o.status}  source=${o.source}  total=${o.total}  updated=${MACAU(o.updated_at)}`,
        );
      }
    } else {
      console.log(JSON.stringify(orders).slice(0, 400));
    }
  } catch {
    console.log(r2.body.slice(0, 300));
  }

  console.log("\n完（全部唯讀）。");
})();
