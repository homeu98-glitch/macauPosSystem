// probe v10：釐清「1138 分鐘」vs「53 分鐘」矛盾 + 找真兇
//   矛盾：用戶截圖（09:23）顯示「最後心跳 1138 分鐘前」≈ 19 小時
//         但 pair-status 實時回 lastSeenAt = 53 分鐘前
//   → 兩者唔一致 ⇒ 可能 UI 讀嘅係另一個來源，或截圖係舊 cache
//   目的：把 1138 分鐘前反推成絕對時間，再對照 DB 搵嗰個時刻發生咩事
const https = require("https");
const SITE = "https://macau-pos-system.vercel.app";

function req(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}
const toMC = (x) => new Date(x).toLocaleString("zh-HK", { timeZone: "Asia/Macau", hour12: false });

(async () => {
  // 1) 反推「1138 分鐘前」= 咩時間
  const shotAt = new Date("2026-09-16T09:23:00+08:00");
  const min1138 = new Date(shotAt.getTime() - 1138 * 60000);
  console.log("═══ 時間反推 ═══");
  console.log(`  截圖時間         : ${toMC(shotAt)} (澳門)`);
  console.log(`  -1138 分鐘 ⇒     : ${toMC(min1138)} (澳門)  ← UI 聲稱的最後心跳`);
  console.log(`  實測 lastSeenAt  : 2026-09-16 08:30:35 (澳門) = 53 分鐘前`);
  console.log(`  ⇒ 兩者相差 ${Math.round((new Date("2026-09-16T08:30:35+08:00") - min1138) / 60000)} 分鐘 ⇒ 唔一致`);

  // 2) 對照 09-15 14:25 前後有咩事（1138 分鐘前 ≈ 09-15 14:25）
  const home = await req("GET", SITE + "/prints", { "user-agent": "Mozilla/5.0" });
  const js = [...new Set((home.body || "").match(/\/_next\/static\/[^"'\s]+\.js/g) || [])];
  let anonKey = null;
  for (const p of js) {
    const r = await req("GET", SITE + p, { "user-agent": "Mozilla/5.0" });
    const m = (r.body || "").match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    if (m) {
      try {
        const pl = JSON.parse(Buffer.from(m[0].split(".")[1], "base64").toString("utf8"));
        if (pl.ref === "iyrywzormzisyppkokbi") { anonKey = m[0]; break; }
      } catch {}
    }
  }
  if (!anonKey) { console.log("搵唔到 anon key"); return; }
  const base = "https://iyrywzormzisyppkokbi.supabase.co/rest/v1";
  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "content-type": "application/json" };

  console.log("\n═══ 09-15 13:00–16:00 澳門（= 1138 分鐘前附近）嘅 job ═══");
  const r = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,finished_at&created_at=gte.2026-09-15T05:00:00Z&created_at=lte.2026-09-15T08:00:00Z&order=created_at.asc&limit=40`, h);
  try {
    const a = JSON.parse(r.body);
    console.log(`  共 ${a.length} 張`);
    a.forEach((x) =>
      console.log(`  ${toMC(x.created_at)} | ${x.status} att=${x.attempts} | claimed_by=${(x.claimed_by||"NULL").slice(0,14)} | claim@${x.claimed_at?toMC(x.claimed_at):"NULL"} | fin@${x.finished_at?toMC(x.finished_at):"NULL"}`)
    );
  } catch { console.log("  HTTP", r.status, r.body.slice(0,200)); }

  // 3) 最後一次成功打印（finished_at 有值）係幾時
  console.log("\n═══ 最後 5 次成功打印（finished_at 有值）═══");
  const r3 = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,claimed_by,finished_at,printer_name&finished_at=not.is.null&order=finished_at.desc&limit=5`, h);
  try {
    JSON.parse(r3.body).forEach((x) =>
      console.log(`  fin@${toMC(x.finished_at)} | 單建於 ${toMC(x.created_at)} | ${x.status} | ${x.printer_name || "-"}`)
    );
  } catch { console.log("  HTTP", r3.status, r3.body.slice(0,200)); }
})();
