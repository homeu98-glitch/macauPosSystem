/**
 * 唯讀取證（2026-09-30）：admin「店鋪總覽」今日單數 21 vs「營業報表」訂單數 20
 * 到底差喺邊一張單／邊個口徑。
 *
 * 兩邊嘅代碼口徑（已核實）：
 *   · 店鋪總覽  /api/admin/merchants → loadPosStats()
 *       status ∈ {settled,paid} AND created_at >= 澳門今日 00:00（下單時間、無上限）
 *   · 營業報表  RestaurantDailyReport
 *       isSaleCountable(o)（settled/paid）AND orderMatchesReportRange(o,"today")
 *       orderEventInstant(o) = settled_at → reopened_at → original_settled_at
 *                              → updated_at → created_at   （結帳時間優先）
 *
 * 呢個腳本用同一批雲端 row 分別跑兩個 predicate，印出：
 *   ① 各口徑張數
 *   ② 「總覽有、報表冇」嘅差集（＝最可疑嗰張）
 *   ③ 「報表有、總覽冇」嘅差集
 *   ④ 每張單嘅四個時間戳（澳門時間）以供肉眼核對
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
/** 表嫂美食（沿用 _probe-reportcount-20260924.cjs 已確認嘅 store_id）。 */
const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

/** 澳門今日 = 2026-09-30；由 09-28T16:00Z 起拉，保證覆蓋「昨日開單今日結帳」。 */
const SINCE = "2026-09-28T16:00:00Z";
const MACAU_DAY = "09-30";

const mac = (s) => (s ? new Date(Date.parse(s) + 8 * 3600e3).toISOString().slice(5, 19) : "-");
const macDay = (s) => (s ? mac(s).slice(0, 5) : "");
const countable = (o) => o.status === "settled" || o.status === "paid";

/** orderEventInstant 嘅雲端口徑（前端同款鏈）。 */
function eventInstant(o) {
  return o.settled_at || o.reopened_at || o.updated_at || o.created_at || "";
}

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
  console.log("anon key:", K ? K.slice(0, 24) + "…" : "❌ 抽唔到");
  const H = { apikey: K, authorization: `Bearer ${K}` };

  // settled_at 係 0057 欄位；未跑 migration 會 42703 → 降級唔揀佢。
  const base = "id,local_order_no,status,total,created_at,updated_at,reopened_at,online_order_id,source";
  let select = base + ",settled_at";
  const url = (sel) =>
    `https://${REF}.supabase.co/rest/v1/pos_orders?select=${sel}` +
    `&store_id=eq.${STORE}` +
    `&or=(created_at.gte.${SINCE},updated_at.gte.${SINCE})` +
    `&order=created_at.asc&limit=500`;

  let r = await get(url(select), H);
  if (r.status >= 400 && /42703|settled_at/i.test(r.body)) {
    console.log("⚠️ settled_at 欄位不存在（0057 未跑）→ 降級唔揀佢\n");
    select = base;
    r = await get(url(select), H);
  }
  if (r.status >= 400) {
    console.log("❌ 查詢失敗", r.status, r.body.slice(0, 400));
    return;
  }
  const rows = JSON.parse(r.body);

  const overview = rows.filter((o) => countable(o) && macDay(o.created_at) === MACAU_DAY);
  const report = rows.filter((o) => countable(o) && macDay(eventInstant(o)) === MACAU_DAY);

  console.log(`拉取 ${rows.length} 張（created_at 或 updated_at ≥ ${SINCE}）\n`);
  const byStatus = {};
  for (const o of rows) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  console.log("狀態分佈:", JSON.stringify(byStatus));

  console.log(`\n① 店鋪總覽口徑（可計 + created_at ∈ 澳門 ${MACAU_DAY}）⇒ ${overview.length} 張`);
  console.log(`② 營業報表口徑（可計 + eventInstant ∈ 澳門 ${MACAU_DAY}）⇒ ${report.length} 張`);

  const idsOverview = new Set(overview.map((o) => o.id));
  const idsReport = new Set(report.map((o) => o.id));
  const onlyOverview = overview.filter((o) => !idsReport.has(o.id));
  const onlyReport = report.filter((o) => !idsOverview.has(o.id));

  const dump = (label, list) => {
    console.log(`\n=== ${label} ${list.length} 張 ===`);
    for (const o of list) {
      console.log(
        `  ${String(o.local_order_no).padEnd(12)} ${String(o.status).padEnd(9)} ${String(o.total).padStart(7)}` +
          `  created=${mac(o.created_at)}  updated=${mac(o.updated_at)}` +
          `  reopened=${mac(o.reopened_at)}  settled=${mac(o.settled_at)}` +
          `  ${o.online_order_id ? "線上" : "線下"} src=${o.source || "-"}`,
      );
    }
  };
  dump("🔴 總覽有 · 報表冇", onlyOverview);
  dump("🟡 報表有 · 總覽冇", onlyReport);

  console.log(`\n=== 報表口徑全部 ${report.length} 張（eventInstant 倒序）===`);
  for (const o of [...report].sort((a, b) => Date.parse(eventInstant(b)) - Date.parse(eventInstant(a)))) {
    console.log(
      `  ${mac(eventInstant(o))}  ${String(o.local_order_no).padEnd(12)} ${String(o.status).padEnd(9)}` +
        ` ${String(o.total).padStart(7)}  ${o.online_order_id ? "線上" : "線下"}`,
    );
  }
  const sum = report.reduce((s, o) => s + Number(o.total || 0), 0);
  const sumOv = overview.reduce((s, o) => s + Number(o.total || 0), 0);
  console.log(`\n報表口徑金額合計 ${sum.toFixed(2)} · 總覽口徑金額合計 ${sumOv.toFixed(2)}`);
})();
