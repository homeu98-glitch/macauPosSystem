// probe v15：判斷 UI 會顯示邊個 store 嘅心跳
//   resolveStoreId() = loadAuthSession().merchantId （登入嘅 store）
//   三個 store 都有未完成 job；邊個係「你哋正在用」？
//   線索：今日（09-16）新建嘅 job 屬邊個 store + 邊個 agent 有今日 claim
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}
const toMC = (s) => s ? new Date(new Date(s).getTime() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "NULL";
const ago = (s) => s ? Math.round((Date.now() - new Date(s).getTime()) / 60000) + " 分" : "NULL";

(async () => {
  const home = await req("GET", SITE + "/prints", { "user-agent": "Mozilla/5.0" });
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await req("GET", SITE + p, { "user-agent": "Mozilla/5.0" });
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) { try { const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8")); if (pl.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; } } catch {} }
  }
  if (!anonKey) { console.log("搵唔到 anon key"); return; }
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  console.log("═══ ① 今日（09-16）新建嘅 job 屬邊個 store ═══");
  const r1 = await req("GET", `${base}/pos_print_jobs?select=store_id,created_at,status,attempts,printer_name&created_at=gte.2026-09-15T16:00:00Z&order=created_at.desc&limit=40`, h);
  let today = [];
  try { today = JSON.parse(r1.body); } catch { console.log("  HTTP", r1.status, r1.body.slice(0, 200)); }
  const cnt = {};
  today.forEach((x) => { cnt[x.store_id] = (cnt[x.store_id] || 0) + 1; });
  Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s}  →  ${n} 張`));

  console.log("\n═══ ② 最近 20 張 job（睇 printer_name 判係邊間店嘅設備）═══");
  today.slice(0, 20).forEach((x) =>
    console.log(`  ${toMC(x.created_at)} | ${x.status.padEnd(8)} att=${String(x.attempts ?? 0).padStart(2)} | ${(x.printer_name || "-").padEnd(28)} | store=${x.store_id.slice(0, 8)}`)
  );

  console.log("\n═══ ③ 三個 store 嘅 pair-status 並排（重點：UI 顯示邊個）═══");
  for (const s of ["d564b932-0c91-45e9-86fd-0ec8e2711f13", "f6ec837a-03d9-48f0-ae05-f1fbc3483221", "8291f843-9def-4956-9d0b-1cfef2598306"]) {
    const r = await req("GET", `${SITE}/api/pos/print-agent/pair-status?storeId=${s}`, { "user-agent": "curl/8" });
    let j = null; try { j = JSON.parse(r.body); } catch {}
    const mins = j?.lastSeenAt ? Math.round((Date.now() - new Date(j.lastSeenAt).getTime()) / 60000) : null;
    console.log(`  ${s.slice(0, 8)}… lastSeen=${toMC(j?.lastSeenAt)}  ≈ ${mins} 分前  agent=${(j?.agentId || "-").slice(0, 20)}`);
  }
  console.log("\n  🔎 你截圖寫「1138 分鐘前」⇒ 對得上邊個？");
  console.log("     8291f843 = 1154 分 ← 最接近（差 16 分 ≈ 截圖到現在嘅時間差）");
  console.log("     d564b932 = 68 分");
})();
