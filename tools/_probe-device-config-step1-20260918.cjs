/**
 * Step 1 驗收探測（唯讀，2026-09-18）。
 *
 * 驗商戶 App 交接單裡「部署後一起驗」表格中**可自動化**嘅部分：
 *   ① 匿名 + storeId            → 401        [已可驗]
 *   ② 本店真 agent              → 200 + printers 有內容   [需真憑證]
 *   ③ 甲店 agent 打乙店         → 401        [需真憑證]
 *   ④ revoke 咗嘅 agent         → 401        [需真憑證]
 *   ⑤ 商米重啟後落單印得出       → 人手驗
 *
 * 「真憑證」嘅來源：agent token 明文**只喺配對一刻**經 HTTPS 交一次，
 * DB 只存 sha256 ⇒ 任何人都無法由 DB 還原出一個可用 token。
 * 所以 ②③④ 冇得純自動驗，要由營運者喺商米 App 內拎（或由 POS DB 側另作旁證）。
 * 本腳本會做：
 *   · ①②③④ 用「有冇帶 x-agent-id/x-agent-token」對照，證明閘係 agent-aware；
 *   · 由線上 bundle 抽 POS 專案 anon key，直讀 `pos_print_agents` 睇有咩 agent/店
 *     （anon 有冇 SELECT 權限本身亦係一條重要情報）；
 *   · 檢查 agent 表嘅 revoked_at / token_hash 欄位狀態。
 *
 * 全部 GET / 唯讀，唔會改任何嘢。
 */

const BASE = process.argv[2] || "https://macau-pos-system.vercel.app";

async function probe(label, path, init) {
  const url = BASE + path;
  try {
    const res = await fetch(url, { ...init, redirect: "manual" });
    let body = "";
    try {
      body = (await res.text()).slice(0, 260).replace(/\s+/g, " ");
    } catch {
      body = "(無法讀取 body)";
    }
    console.log(`\n── ${label}`);
    console.log(`   ${init?.method || "GET"} ${path}`);
    if (init?.headers) console.log(`   headers: ${JSON.stringify(init.headers)}`);
    console.log(`   → HTTP ${res.status}`);
    console.log(`   → ${body}`);
    return res.status;
  } catch (e) {
    console.log(`\n── ${label}`);
    console.log(`   → 網絡錯誤: ${e.message}`);
    return null;
  }
}

/** 由線上 bundle 抽 POS 專案嘅 url + anon key（技法同 _probe-store-health 一致）。 */
async function extractPosConfig() {
  const roots = ["/login", "/staff", "/"];
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
  let anonKey = null;
  for (const cu of chunkUrls) {
    let js;
    try {
      js = await (await fetch(BASE + cu)).text();
    } catch {
      continue;
    }
    const jwts = js.match(jwtRe);
    if (jwts) {
      const cand = jwts.find((j) => {
        try {
          const p = JSON.parse(
            Buffer.from(j.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
          );
          return String(p?.role ?? "") === "anon" && String(p?.ref ?? "").startsWith("iyrywzormz");
        } catch {
          return false;
        }
      });
      if (cand) {
        anonKey = cand;
        break;
      }
    }
  }
  return anonKey;
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
  console.log("═".repeat(72));
  console.log("Step 1 驗收探測（device-config 接受 agent 憑證）");
  console.log("BASE =", BASE);
  console.log("═".repeat(72));

  const FAKE_STORE = "00000000-0000-0000-0000-000000000000";

  // ── ① 匿名 + storeId ⇒ 401（brief 表第 1 行）──
  await probe("① 匿名 + storeId（期望 401）", `/api/pos/device-config?storeId=${FAKE_STORE}`);

  // ── ② 帶亂造嘅 agent 憑證 + storeId ⇒ 401（證明閘會睇 agent header）──
  await probe("② 假 agent 憑證（期望 401，證明有讀 agent header）", `/api/pos/device-config?storeId=${FAKE_STORE}`, {
    headers: { "x-agent-id": "00000000-0000-0000-0000-0000000000aa", "x-agent-token": "deadbeef".repeat(8) },
  });

  // ── ③ 冇 storeId ⇒ 200 + null（early-return，刻恴設計，唔應該變 401）──
  await probe("③ 冇 storeId（期望 200 + deviceConfig:null）", "/api/pos/device-config");

  // ── ④ 對照：deploy 可達性 ──
  await probe("④ 部署可達（對照）", "/manifest.webmanifest");

  // ── ⑤ 用公開 anon key 直讀 pos_print_agents ──
  console.log("\n" + "─".repeat(72));
  console.log("⑤ 由線上 bundle 抽 POS 專案 anon key，直讀 agent 表");
  const anonKey = await extractPosConfig();
  if (!anonKey) {
    console.log("   ❌ 抽唔到 POS 專案 anon key（chunk 未載入或已改名）");
    return;
  }
  const projectRef = refOf(anonKey);
  const dbBase = `https://${projectRef}.supabase.co`;
  console.log(`   anon key ref: ${projectRef}`);
  console.log(`   配對 base   : ${dbBase}`);

  const agents = await rest(
    dbBase,
    anonKey,
    "pos_print_agents?select=agent_id,store_id,name,revoked_at,last_seen_at,created_at&order=created_at.desc&limit=10",
  );
  console.log(`\n   pos_print_agents  HTTP ${agents.status}`);
  if (Array.isArray(agents.body)) {
    console.log(`   共 ${agents.body.length} 條：`);
    agents.body.forEach((a) =>
      console.log(
        `     agent=${String(a.agent_id).slice(0, 8)}…  store=${String(a.store_id).slice(0, 8)}…  ` +
          `name=${a.name ?? "-"}  revoked=${a.revoked_at ? String(a.revoked_at).slice(0, 19) : "NULL"}`,
      ),
    );
  } else {
    console.log("   ", JSON.stringify(agents.body).slice(0, 400));
  }

  const cfg = await rest(
    dbBase,
    anonKey,
    "pos_device_configs?select=store_id,terminal_name,updated_at&order=updated_at.desc&limit=10",
  );
  console.log(`\n   pos_device_configs  HTTP ${cfg.status}`);
  if (Array.isArray(cfg.body)) {
    console.log(`   共 ${cfg.body.length} 條：`);
    cfg.body.forEach((c) =>
      console.log(
        `     store=${String(c.store_id).slice(0, 8)}…  terminal=${c.terminal_name ?? "-"}  updated=${String(c.updated_at).slice(0, 19)}`,
      ),
    );
  } else {
    console.log("   ", JSON.stringify(cfg.body).slice(0, 400));
  }

  console.log("\n" + "═".repeat(72));
  console.log("判讀：");
  console.log("  ① 401 + ② 401 ⇒ 閘已 enforcing，且係 agent-aware（唔會因為帶假 header 就放行）");
  console.log("  ③ 200        ⇒ early-return 冇被閘污染（刻意設計，保持不變）");
  console.log("  ⑤ 42501 permission denied ⇒ ✅ 好嘅：agent / device_configs 兩表 anon 冇 SELECT");
  console.log("     （對比 pos_orders / pos_print_jobs 有 anon SELECT，係 docs/113 記錄嘅殘留洞）");
  console.log("  ②③④（真憑證 200 / 跨店 401 / revoked 401）要人手用真 agent token 驗。");
  console.log("═".repeat(72));
})();
