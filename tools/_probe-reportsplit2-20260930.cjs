/**
 * 唯讀取證（2026-09-30）· 第二輪：驗證「平台單 created_at 偏移」假說。
 *
 * 第一輪已確認：總覽 21 張 / 報表 20 張，差嘅係一張 `澳覓#2`（MOP 113）：
 *   created_at = 澳門 09-30 03:47:07
 *   settled_at = 澳門 09-29 20:23:02   ← 結帳竟然「早過」下單 7h24m
 *
 * 假說：插件抓到嘅平台「下單時間」係**澳門本地時間字串**，但被當 UTC 存
 * ⇒ 澳門顯示時 +8h ⇒ 傍晚單漂到第二日凌晨。
 *
 * 驗證方法：逐張列出 `settled − created` 嘅分鐘差 + 原始 UTC 字串。
 *   正常 = 正數（幾分鐘至幾小時）；異常 = 負數或 ≈ −480 分鐘（−8h）。
 */
const https = require("node:https");

function get(url, headers) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { "user-agent": "Mozilla/5.0", ...(headers || {}) } }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res({ status: r.statusCode, body: d }));
      })
      .on("error", rej);
  });
}

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const SITE = "https://macau-pos-system.vercel.app";
const REF = "iyrywzormzisyppkokbi";
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";
const SINCE = "2026-09-28T16:00:00Z";

/** UTC ISO → 澳門「MM-DD HH:mm:ss」。 */
const mac = (s) =>
  s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19).replace("T", " ") : "-";

(async () => {
  const chunks = new Set();
  for (const p of ["/prints", "/pos"]) {
    try {
      const r = await get(SITE + p);
      (r.body.match(/\/_next\/static\/[^"'\\\s]+\.js/g) || []).forEach((s) => chunks.add(s));
    } catch {}
  }
  let K = "";
  for (const s of chunks) {
    try {
      const r = await get(SITE + s);
      const m = r.body.match(JWT);
      if (m && m.length) {
        K = m[0];
        break;
      }
    } catch {}
  }
  const H = { apikey: K, authorization: `Bearer ${K}` };

  const sel =
    "id,local_order_no,status,total,created_at,updated_at,reopened_at,settled_at," +
    "online_order_id,source,external_order_id";
  const url =
    `https://${REF}.supabase.co/rest/v1/pos_orders?select=${sel}` +
    `&store_id=eq.${STORE}` +
    `&or=(created_at.gte.${SINCE},updated_at.gte.${SINCE})` +
    `&order=created_at.asc&limit=500`;
  const r = await get(url, H);
  if (r.status >= 400) {
    console.log("❌", r.status, r.body.slice(0, 300));
    return;
  }
  const rows = JSON.parse(r.body);

  console.log(`共 ${rows.length} 張\n`);
  console.log(
    "created(澳門)      settled(澳門)      diff(min)  source  單號          金額    ext_id",
  );
  console.log("-".repeat(112));

  const abnormal = [];
  for (const o of rows) {
    const c = o.created_at ? Date.parse(o.created_at) : 0;
    const s = o.settled_at ? Date.parse(o.settled_at) : 0;
    const diff = c && s ? Math.round((s - c) / 60000) : null;
    const bad = diff !== null && diff < 0;
    if (bad) abnormal.push(o);
    console.log(
      `${mac(o.created_at)}   ${mac(o.settled_at)}   ` +
        `${String(diff === null ? "-" : diff).padStart(8)}  ` +
        `${String(o.source || "-").padEnd(7)} ${String(o.local_order_no).padEnd(13)}` +
        `${String(o.total).padStart(7)}   ${o.external_order_id || "-"}${bad ? "   ⚠️ 負數" : ""}`,
    );
  }

  console.log(`\n=== settled < created（不可能）共 ${abnormal.length} 張 ===`);
  for (const o of abnormal) {
    const diff = Math.round((Date.parse(o.settled_at) - Date.parse(o.created_at)) / 60000);
    console.log(
      `  ${o.local_order_no}  ${o.source}  ${o.total}  ` +
        `created=${o.created_at} settled=${o.settled_at} updated=${o.updated_at}  ` +
        `diff=${(diff / 60).toFixed(2)}h  ext=${o.external_order_id}`,
    );
  }

  // 按 source 統計「created 同 settled 嘅澳門日是否同一日」
  const bySrc = {};
  for (const o of rows) {
    const k = o.source || "-";
    bySrc[k] = bySrc[k] || { n: 0, crossDay: 0 };
    bySrc[k].n += 1;
    const cd = mac(o.created_at).slice(0, 5);
    const sd = o.settled_at ? mac(o.settled_at).slice(0, 5) : cd;
    if (cd !== sd) bySrc[k].crossDay += 1;
  }
  console.log("\n=== 按 source：created 澳門日 ≠ settled 澳門日 嘅張數 ===");
  for (const [k, v] of Object.entries(bySrc)) {
    console.log(`  ${k.padEnd(8)} ${v.crossDay} / ${v.n}`);
  }
})();
