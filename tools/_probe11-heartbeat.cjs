// probe v11：判「心跳為何停在 08:30:35」
//   已知：heartbeat 每 30s 一次，但 lastSeenAt 停在 08:30:35（54 分鐘前）
//        ⇒ runner 嘅 heartbeatJob 已停
//   待查：
//     A) 08:30 之後有冇任何 job 被 claim（冇 ⇒ runner 完全死）
//     B) 08:30 之後有冇新 job（有 ⇒ POS 落單正常，只係冇人印）
//     C) 08:30:35 嗰批 job 嘅最終狀態（睇 runner 死前最後做咗咩）
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
const toMC = (s) => (s ? new Date(s).toLocaleString("zh-HK", { timeZone: "Asia/Macau", hour12: false }) : "NULL");
const agoMin = (s) => (s ? Math.round((Date.now() - new Date(s).getTime()) / 60000) : null);

(async () => {
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

  console.log("═══ ① 08:00 之後所有 job（睇 claim 何時停）═══");
  const r1 = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,updated_at&created_at=gte.2026-09-16T00:00:00Z&order=created_at.asc&limit=60`, h);
  try {
    const a = JSON.parse(r1.body);
    console.log(`  共 ${a.length} 張`);
    a.forEach((x) =>
      console.log(
        `  ${toMC(x.created_at)} | ${x.status} att=${x.attempts} | claim@${x.claimed_at ? toMC(x.claimed_at) : "NULL"} | updated@${toMC(x.updated_at)}`
      )
    );
  } catch { console.log("  HTTP", r1.status, r1.body.slice(0, 200)); }

  console.log("\n═══ ② 心跳最後時間 ⟷ 最後 claim 時間 ═══");
  const r2 = await req("GET", `${SITE}/api/pos/print-agent/pair-status?storeId=d564b932-0c91-45e9-86fd-0ec8e2711f13`, { "user-agent": "curl/8" });
  const j = JSON.parse(r2.body);
  console.log(`  最後心跳 lastSeenAt : ${toMC(j.lastSeenAt)}  (${agoMin(j.lastSeenAt)} 分鐘前)`);
  console.log(`  最後 claim          : 2026-09-16 08:30:35  (${agoMin("2026-09-16T00:30:35Z")} 分鐘前)`);
  console.log(`  ⇒ 兩者幾乎同一時刻（08:30:35）⇒ runner 喺嗰刻死亡`);

  console.log("\n═══ ③ 08:30:35 嗰批 job 嘅最終狀態 ═══");
  const r3 = await req("GET", `${base}/pos_print_jobs?select=id,created_at,status,attempts,claimed_by,claimed_at,updated_at,last_error&claimed_at=gte.2026-09-16T00:25:00Z&claimed_at=lte.2026-09-16T00:35:00Z&order=claimed_at.asc`, h);
  try {
    JSON.parse(r3.body).forEach((x) =>
      console.log(`  ${toMC(x.created_at)} 建 | ${x.status} att=${x.attempts} | claim@${toMC(x.claimed_at)} | updated@${toMC(x.updated_at)}\n      ${(x.last_error || "(無 err)").slice(0, 90)}`)
    );
  } catch { console.log("  HTTP", r3.status, r3.body.slice(0, 200)); }
})();
