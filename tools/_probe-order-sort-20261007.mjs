// 唯讀查 pos_orders 的 created_at / local_order_no / external_order_id 排序實況
import fs from "node:fs";
import path from "node:path";

const POS_REF = "iyrywzormzisyppkokbi";
const STORE = "d564b932-0c91-45e9-86fd-0ec8e2711f13";

// 由已部署 bundle 或 env 抽 anon key（沿用既有 probe 做法）
function findAnonKey() {
  const cands = [
    ".env.local", ".env.production", ".env",
    "tools/_probe-grabber-e2e-20261006.cjs",
  ];
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, "utf8");
    const m = t.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    if (m) return m[0];
  }
  return null;
}

const key = findAnonKey();
if (!key) { console.log("找唔到 anon key"); process.exit(1); }

const url = `https://${POS_REF}.supabase.co/rest/v1/pos_orders?store_id=eq.${STORE}&source=eq.mfood&select=local_order_no,external_order_id,created_at,updated_at,status,subtotal,total&order=created_at.asc`;

const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
console.log("HTTP", res.status);
const arr = await res.json();
console.log("共", arr.length, "張 mfood 單（created_at 升序）");
for (const o of arr) {
  console.log(
    `${(o.local_order_no || "").padEnd(14)} ext=${String(o.external_order_id).padEnd(22)} created_at=${o.created_at} status=${o.status} total=${o.total}`,
  );
}
