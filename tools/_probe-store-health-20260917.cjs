/**
 * 店舖健康探測（唯讀）—— 用**公開** anon key 直接查 POS 專案。
 *
 * 原理（項目既有技法）：
 *   `NEXT_PUBLIC_POS_SUPABASE_ANON_KEY` 係 **public** env ⇒ 會打包進瀏覽器 bundle
 *   ⇒ 任何人都抽得到（唔算洩密）。而 0016 §3a / 0021 migration 已經開咗
 *   `pos_orders` anon SELECT（近 14 日）、`pos_print_jobs` anon SELECT（近 24 小時）。
 *   ⇒ 用佢做**唯讀**健康檢查，唔需要任何帳號憑證。
 *
 * 回答嘅問題：「鑑權閘開咗之後，店舖係咪仍然正常收單 / 出紙？」
 */

const BASE = process.argv[2] || "https://macau-pos-system.vercel.app";

/** 由 bundle 抽 POS 專案嘅 url + anon key。 */
async function extractPosConfig() {
  const roots = ["/login", "/staff", "/"];
  const chunkUrls = new Set();

  for (const r of roots) {
    try {
      const html = await (await fetch(BASE + r)).text();
      for (const m of html.matchAll(/\/_next\/static\/[^"'\\\s]+\.js/g)) {
        chunkUrls.add(m[0]);
      }
    } catch {
      /* ignore */
    }
  }
  console.log(`  由 ${roots.length} 個入口頁抽到 ${chunkUrls.size} 個 JS chunk`);

  const found = { url: null, anonKey: null };
  // JWT（anon key 一定係 eyJ… 三段）
  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

  for (const cu of chunkUrls) {
    let js;
    try {
      js = await (await fetch(BASE + cu)).text();
    } catch {
      continue;
    }
    // supabaseUrl 通常同 JWT 一齊出現，就近搵
    if (!found.anonKey) {
      const jwts = js.match(jwtRe);
      if (jwts && jwts.length) {
        found.anonKey = jwts.find((j) => {
          try {
            const payload = JSON.parse(
              Buffer.from(j.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
            );
            return String(payload?.role ?? "") === "anon";
          } catch {
            return false;
          }
        }) ?? jwts[0];
      }
    }
    if (!found.url) {
      const urls = js.match(/https:\/\/[a-z0-9]{15,}\.supabase\.co/g);
      if (urls && urls.length) found.url = urls[0];
    }
    if (found.url && found.anonKey) break;
  }
  return found;
}

function refOf(jwt) {
  try {
    const p = JSON.parse(
      Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return p?.ref ?? "(未知)";
  } catch {
    return "(解唔到)";
  }
}

async function rest(base, key, path) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = "(非 JSON)";
  }
  return { status: res.status, body };
}

(async () => {
  console.log("═".repeat(70));
  console.log("店舖健康探測（唯讀，用公開 anon key）");
  console.log("BASE =", BASE);
  console.log("═".repeat(70) + "\n");

  console.log("── 1. 由線上 bundle 抽 POS 專案設定");
  const cfg = await extractPosConfig();
  console.log("   supabaseUrl:", cfg.url ?? "❌ 抽唔到");
  console.log("   anonKey   :", cfg.anonKey ? cfg.anonKey.slice(0, 28) + "…" : "❌ 抽唔到");
  if (cfg.anonKey) console.log("   project ref:", refOf(cfg.anonKey));

  if (!cfg.url || !cfg.anonKey) {
    console.log("\n⚠️ 抽唔到設定，無法繼續。可能 chunk 未載入或變數改名。");
    return;
  }

  console.log("\n── 2. 🔴 最近訂單（睇店舖係咪仍然收單）");
  // 🔴 URL 一定要由 anon key 嘅 `ref` 推導，唔可以靠掃到嘅第一個 *.supabase.co。
  // bundle 同時載有**兩個專案**嘅 URL（Ledger 係 NEXT_PUBLIC_SUPABASE_URL、
  // POS 係 NEXT_PUBLIC_POS_SUPABASE_URL），亂配會 401 "Invalid API key"。
  const projectRef = refOf(cfg.anonKey);
  const base = `https://${projectRef}.supabase.co`;
  console.log(`   （配對：${base}）`);
  const orders = await rest(
    base, cfg.anonKey,
    "pos_orders?select=local_order_no,status,source,store_id,created_at,updated_at&order=created_at.desc&limit=8",
  );
  console.log("   HTTP", orders.status);
  if (Array.isArray(orders.body)) {
    console.log(`   共 ${orders.body.length} 張（anon 只可見近 14 日）`);
    orders.body.forEach((o) =>
      console.log(
        `     ${String(o.created_at).slice(0, 19)}  ${o.local_order_no ?? "?"}  ${o.status}  src=${o.source}  store=${String(o.store_id).slice(0, 8)}`,
      ),
    );
  } else {
    console.log("   ", JSON.stringify(orders.body).slice(0, 300));
  }

  console.log("\n── 3. 最近打印任務（睇出紙鏈路）");
  const jobs = await rest(
    base, cfg.anonKey,
    "pos_print_jobs?select=order_no,status,printer_group,created_at&order=created_at.desc&limit=8",
  );
  console.log("   HTTP", jobs.status);
  if (Array.isArray(jobs.body)) {
    console.log(`   共 ${jobs.body.length} 張（anon 只可見近 24 小時）`);
    jobs.body.forEach((j) =>
      console.log(
        `     ${String(j.created_at).slice(0, 19)}  ${j.order_no ?? "?"}  ${j.status}  grp=${j.printer_group}`,
      ),
    );
  } else {
    console.log("   ", JSON.stringify(jobs.body).slice(0, 300));
  }

  const now = Date.now();
  const latestOrderAt = Array.isArray(orders.body) && orders.body[0] ? Date.parse(orders.body[0].created_at) : null;
  const latestJobAt = Array.isArray(jobs.body) && jobs.body[0] ? Date.parse(jobs.body[0].created_at) : null;
  const mins = (t) => (t ? Math.round((now - t) / 60000) : null);

  console.log("\n" + "═".repeat(70));
  console.log("判讀：");
  console.log(`  最近一張訂單：${latestOrderAt ? mins(latestOrderAt) + " 分鐘前" : "（查唔到 / 冇）"}`);
  console.log(`  最近一張打印任務：${latestJobAt ? mins(latestJobAt) + " 分鐘前" : "（查唔到 / 冇）"}`);
  console.log("");
  console.log("  ⚠️ 注意：anon 讀得到**唔代表**終端寫得入（寫入要 POS 憑證）。");
  console.log("     但若最近有訂單／打印任務 → 至少證明**寫入鏈路仍然運作**。");
  console.log("═".repeat(70));
})();
