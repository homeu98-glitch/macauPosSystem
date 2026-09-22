// 唯讀：今日 queue events + 訂單 id + 收據 job 對照
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
  iso ? new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "";

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
      return { __status: r.status, __body: (r.body || "").slice(0, 300) };
    }
  };

  console.log("### A. 今日訂單 id / 單號 / 狀態");
  const rows = await q(
    `/pos_orders?store_id=eq.${STORE}&created_at=gte.2026-09-21T16:00:00Z&select=id,local_order_no,status,total,table_name,created_at,updated_at&order=created_at.asc&limit=300`,
  );
  if (Array.isArray(rows)) {
    const seen = {};
    rows.forEach((o) => {
      console.log(
        `${String(o.id).padEnd(18)} | ${String(o.local_order_no).padEnd(7)} | ${String(o.status).padEnd(16)} | ${String(
          o.table_name,
        ).padEnd(11)} | ${String(o.total).padStart(5)} | 落單=${macau(o.created_at)} | 更新=${macau(o.updated_at)}`,
      );
      const k = o.local_order_no;
      seen[k] = (seen[k] || 0) + 1;
    });
    console.log("count=" + rows.length);
    console.log(
      "重複單號:",
      JSON.stringify(
        Object.entries(seen)
          .filter(([, n]) => n > 1)
          .reduce((a, [k, v]) => ((a[k] = v), a), {}),
      ),
    );
  } else console.log(rows);

  console.log("\n### B. 今日 pos_queue_events（type / status）");
  const evs = await q(
    `/pos_queue_events?store_id=eq.${STORE}&created_at=gte.2026-09-21T16:00:00Z&select=id,type,entity_id,status,created_at,payload&order=created_at.asc&limit=500`,
  );
  if (Array.isArray(evs)) {
    const g = {};
    evs.forEach((e) => {
      const k = `${e.type} / ${e.status}`;
      g[k] = (g[k] || 0) + 1;
    });
    console.log("分佈:", JSON.stringify(g, null, 1));
    const printEvts = evs.filter((e) => String(e.type).startsWith("PRINT_"));
    console.log("PRINT_* 事件數:", printEvts.length);
    printEvts.slice(0, 60).forEach((e) => {
      const p = e.payload || {};
      console.log(
        `  ${String(e.type).padEnd(20)} status=${String(e.status).padEnd(10)} order=${p.orderNo ?? p.order_no ?? "-"} kind=${
          p.kind ?? "-"
        } printer=${p.printerName ?? "-"} 建=${macau(e.created_at)}`,
      );
    });
    const orderEvts = evs.filter((e) => String(e.type).startsWith("ORDER_"));
    console.log("ORDER_* 事件數:", orderEvts.length);
    orderEvts.slice(-40).forEach((e) => {
      const p = e.payload || {};
      console.log(
        `  ${String(e.type).padEnd(20)} status=${String(e.status).padEnd(10)} 單號=${p.localOrderNo ?? "-"} status=${
          p.status ?? "-"
        } 建=${macau(e.created_at)}`,
      );
    });
  } else console.log(evs);

  console.log("\n### C. 全部 receipt 類 job（不限日期）");
  const rc = await q(
    `/pos_print_jobs?store_id=eq.${STORE}&printer_group=eq.receipt&select=order_no,printer_name,status,finished_at,created_at,once_key&order=created_at.desc&limit=60`,
  );
  console.log(JSON.stringify(rc, null, 1));

  console.log("\n### D. 訂單22 / 24 / 27 嘅所有 print job（含 kitchen）");
  const jj = await q(
    `/pos_print_jobs?store_id=eq.${STORE}&or=(order_no.eq.%E8%A8%82%E5%96%AE22,order_no.eq.%E8%A8%82%E5%96%AE24,order_no.eq.%E8%A8%82%E5%96%AE27,order_no.eq.%E8%A8%82%E5%96%AE19,order_no.eq.%E8%A8%82%E5%96%AE20)&select=order_no,order_id,kind,ticket_type,printer_name,printer_group,status,created_at,finished_at&order=created_at.desc&limit=120`,
  );
  console.log(JSON.stringify(jj, null, 1));
})();
