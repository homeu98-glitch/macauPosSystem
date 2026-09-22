// 唯讀：唔加 store 過濾，睇 pos_print_jobs 最近 80 行（確認收據 job 係唔係寫落另一個 store_id）
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

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

  console.log("### 最近 80 行 pos_print_jobs（無 store 過濾）");
  const rows = await q(
    `/pos_print_jobs?select=store_id,order_no,order_id,printer_group,printer_name,ticket_type,status,created_at&order=created_at.desc&limit=80`,
  );
  if (Array.isArray(rows)) {
    const byStore = {};
    rows.forEach((r) => {
      byStore[r.store_id] = (byStore[r.store_id] || 0) + 1;
      console.log(
        `${String(r.store_id).slice(0, 8)} | ${String(r.order_no).padEnd(20)} | ${String(r.printer_group).padEnd(
          8,
        )} | ${String(r.printer_name).padEnd(28)} | ${String(r.status).padEnd(8)} | ${macau(r.created_at)}`,
      );
    });
    console.log("count=" + rows.length, JSON.stringify(byStore));
    console.log("最早:", macau(rows[rows.length - 1]?.created_at), " 最新:", macau(rows[0]?.created_at));
  } else console.log(rows);
})();
