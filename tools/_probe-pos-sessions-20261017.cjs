/**
 * pos_sessions 生產庫唯讀探測（2026-10-17）—— 回答「點解 admin 頁塞爆」。
 *
 * 用公開 anon key（打包喺 bundle，任何人都拎得到）直查 POS 專案。
 * 只讀：唔寫、唔刪。
 */

const BASE = "https://macau-pos-system.vercel.app";

async function extractPosConfig() {
  const roots = ["/prints", "/login", "/"];
  const chunkUrls = new Set();
  for (const r of roots) {
    try {
      const html = await (await fetch(BASE + r)).text();
      for (const m of html.matchAll(/\/_next\/static\/[^"'\\\s]+\.js/g)) chunkUrls.add(m[0]);
    } catch {
      /* ignore */
    }
  }
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const found = { url: null, anonKey: null };
  for (const cu of chunkUrls) {
    let js;
    try {
      js = await (await fetch(BASE + cu)).text();
    } catch {
      continue;
    }
    if (!found.anonKey) {
      const jwts = js.match(jwtRe);
      if (jwts && jwts.length) {
        found.anonKey = jwts.find((j) => {
          try {
            const p = JSON.parse(
              Buffer.from(j.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
            );
            return String(p?.role ?? "") === "anon" && String(p?.ref ?? "") === "iyrywzormzisyppkokbi";
          } catch {
            return false;
          }
        });
      }
    }
    if (!found.url) {
      // 只接受 **POS 專案**個 URL（project ref 已知）；Ledger 個 URL 唔要用
      const posUrl = js.match(/https:\/\/iyrywzormzisyppkokbi\.supabase\.co/g);
      if (posUrl && posUrl.length) found.url = posUrl[0];
    }
    if (found.url && found.anonKey) break;
  }
  return found;
}

const main = async () => {
  const { url, anonKey } = await extractPosConfig();
  if (!url || !anonKey) {
    console.log("RESULT: 抽唔到 anon key（網站可能掛咗）");
    return;
  }
  console.log(`base=${url}`);

  const h = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const base = `${url}/rest/v1`;

  // 1) 總行數（PostgREST count）
  const countRes = await fetch(`${base}/pos_sessions?select=id`, {
    headers: { ...h, Prefer: "count=exact", Range: "0-0" },
  });
  console.log(`total rows: ${countRes.headers.get("content-range")}`);

  // 2) 拉全部 row（輕表，逐行分析）
  const res = await fetch(
    `${base}/pos_sessions?select=id,store_id,account,role,build_id,opened_at,last_seen_at,revoked_at,revoked_by,closed_at,ip,user_agent&order=last_seen_at.desc&limit=2000`,
    { headers: h },
  );
  if (!res.ok) {
    console.log(`RESULT: anon 讀 pos_sessions 失敗 HTTP ${res.status}: ${await res.text()}`);
    return;
  }
  const rows = await res.json();
  const now = Date.now();

  const byStore = new Map();
  let revoked = 0;
  let closedClient = 0;
  let live = 0;
  let idle = 0;
  let off = 0;
  let noBuild = 0;
  let olderThan30d = 0;
  for (const r of rows) {
    byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + 1);
    if (r.revoked_at) revoked++;
    if (r.closed_at) closedClient++;
    if (!r.build_id) noBuild++;
    const age = now - Date.parse(r.last_seen_at);
    if (age <= 6 * 60_000) live++;
    else if (age <= 30 * 60_000) idle++;
    else off++;
    if (Date.parse(r.last_seen_at) < now - 30 * 86_400_000) olderThan30d++;
  }

  console.log(`rows returned: ${rows.length}`);
  console.log(`by state (last_seen): live<=6m=${live} idle6-30m=${idle} off>30m=${off}`);
  console.log(`revoked_at NOT NULL: ${revoked}`);
  console.log(`closed_at NOT NULL: ${closedClient}`);
  console.log(`build_id NULL: ${noBuild}`);
  console.log(`last_seen older than 30d: ${olderThan30d}`);
  console.log("by store:");
  for (const [s, n] of [...byStore].sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);

  // 3) revoked 但 5 分鐘內仍有 last_seen？recreated？抽樣睇 opened vs revoked
  const revRecent = rows.filter((r) => r.revoked_at && now - Date.parse(r.revoked_at) < 24 * 3600_000);
  console.log(`revoked in last 24h: ${revRecent.length}`);
  for (const r of revRecent.slice(0, 10)) {
    console.log(
      `  rev ${r.store_id} ${r.account ?? "-"} last_seen=${r.last_seen_at} revoked=${r.revoked_at} opened=${r.opened_at}`,
    );
  }

  // 4) 最舊 10 行
  console.log("oldest by last_seen:");
  for (const r of [...rows].sort((a, b) => Date.parse(a.last_seen_at) - Date.parse(b.last_seen_at)).slice(0, 10)) {
    console.log(`  ${r.store_id} opened=${r.opened_at} last_seen=${r.last_seen_at} revoked=${r.revoked_at ?? "-"}`);
  }
};

main().catch((e) => console.log("ERR", e.message));
