// 唯讀：今日全部訂單（精簡）+ 專門解構 訂單19 + 打印 job 全清單
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
const macau = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
};

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
  if (!anonKey) return console.log("NO_ANON_KEY");
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const q = async (path) => {
    const r = await get(base + path, h);
    try {
      return JSON.parse(r.body);
    } catch {
      return { __err: r.status, body: (r.body || "").slice(0, 300) };
    }
  };

  console.log("### A. 今日訂單（澳門時間，按落單排序）");
  const rows = await q(
    `/pos_orders?store_id=eq.${STORE}&created_at=gte.2026-09-21T16:00:00Z&select=local_order_no,status,fulfillment_status,table_name,total,payment_method,source,online_order_id,created_at,updated_at,sent_to_kitchen_at,served_at,reopen_count,comp_note&order=created_at.asc&limit=300`,
  );
  if (Array.isArray(rows)) {
    rows.forEach((o) => {
      console.log(
        [
          String(o.local_order_no).padEnd(7),
          String(o.status).padEnd(16),
          String(o.table_name).padEnd(11),
          String(o.total).padStart(5),
          String(o.payment_method ?? "-").padEnd(9),
          "src=" + (o.source ?? "-"),
          o.online_order_id ? "online=" + String(o.online_order_id).slice(0, 8) : "offline",
          "落單=" + macau(o.created_at),
          "更新=" + macau(o.updated_at),
          o.sent_to_kitchen_at ? "落廚=" + macau(o.sent_to_kitchen_at) : "",
          o.served_at ? "出餐=" + macau(o.served_at) : "",
          o.reopen_count ? "reopen=" + o.reopen_count : "",
        ].join(" | "),
      );
    });
    console.log("count=" + rows.length);
  } else console.log(rows);

  console.log("\n### B. 所有 local_order_no = 訂單19（不限日期）");
  const b = await q(
    `/pos_orders?store_id=eq.${STORE}&local_order_no=eq.%E8%A8%82%E5%96%AE19&select=id,local_order_no,status,table_name,total,payment_method,created_at,updated_at,reopen_count,online_order_id&order=created_at.asc`,
  );
  console.log(JSON.stringify(b, null, 1));

  console.log("\n### C. 今日 pos_print_jobs（收據類 vs 廚房類）");
  const j = await q(
    `/pos_print_jobs?store_id=eq.${STORE}&created_at=gte.2026-09-21T16:00:00Z&select=order_no,kind,ticket_type,printer_name,printer_group,status,attempts,claimed_by,finished_at,last_error,created_at,once_key&order=created_at.asc&limit=300`,
  );
  if (Array.isArray(j)) {
    j.forEach((r) => {
      console.log(
        [
          String(r.order_no).padEnd(7),
          String(r.printer_group).padEnd(8),
          String(r.printer_name).padEnd(30),
          String(r.ticket_type).padEnd(8),
          String(r.status).padEnd(8),
          "att=" + r.attempts,
          "claim=" + (r.claimed_by ? String(r.claimed_by).slice(0, 12) : "-"),
          "建=" + macau(r.created_at),
          r.finished_at ? "完成=" + macau(r.finished_at) : "未完成",
          r.last_error ? "ERR=" + r.last_error : "",
        ].join(" | "),
      );
    });
    console.log("count=" + j.length);
    const byGroup = {};
    j.forEach((r) => {
      const k = `${r.printer_group}/${r.status}`;
      byGroup[k] = (byGroup[k] || 0) + 1;
    });
    console.log("分組統計:", JSON.stringify(byGroup));
  } else console.log(j);

  console.log("\n### D. 今日收據類 job（printer_group=receipt）");
  const d = await q(
    `/pos_print_jobs?store_id=eq.${STORE}&printer_group=eq.receipt&created_at=gte.2026-09-21T16:00:00Z&select=order_no,printer_name,status,attempts,claimed_by,finished_at,last_error,created_at&order=created_at.asc&limit=300`,
  );
  console.log(JSON.stringify(d, null, 1));
})();
