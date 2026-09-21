/**
 * 驗證線上 bundle 係唔係已經包含 2026-09-21 egress 優化嘅改動（唯讀）。
 *
 * 做法（見 vercel-deploy-triage skill §6）：
 *   · 前端字串 → 掃 `_next/static/chunks/*.js`，掃到 = 已部署。
 *   · server-only 改動 → **唔可以**用 bundle 判斷（唔會出 bundle），只可以用 commit／deployment 比對。
 *
 * 本次用嚟做版本標記嘅前端字串（只喺新版先存在）：
 *   1. `skipQueue=1`   ← `pos-app.tsx` 新加（v2 outbox 之下叫 server 跳過 queue 查詢）
 *   2. `ordersOnly=1`  ← `local-orders-panel.tsx` 新加
 *   3. `分鐘自動更新`   ← 報表標題（舊版係寫死「每 3 分鐘自動更新」，新版由常數推導）
 *
 * 用法：node tools/verify-deployed-bundle.cjs [url]
 */
const https = require("https");

const SITE = process.argv[2] || "https://macau-pos-system.vercel.app";

function get(url, extraHeaders) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: Object.assign({ "User-Agent": "abu-probe/1.0", "cache-control": "no-cache" }, extraHeaders || {}) },
      (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: "ERR " + e.message }));
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}

/** 由 HTML 抽出所有同源 script / chunk URL。 */
function extractScriptUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/["'](\/_next\/static\/[^"']+\.js)["']/g)) urls.add(m[1]);
  for (const m of html.matchAll(/["'](https:\/\/[^"']+\/_next\/static\/[^"']+\.js)["']/g)) urls.add(m[1]);
  // Next 會用 buildManifest / chunk 清單塞喺 script 內容，順手抓埋
  for (const m of html.matchAll(/static\/chunks\/[a-zA-Z0-9._\-]+\.js/g)) urls.add("/" + m[0]);
  return [...urls];
}

(async () => {
  console.log("站台：", SITE);

  const bust = "?_probe=" + Date.now();
  const home = await get(SITE + "/" + bust, { "cache-control": "no-cache" });
  console.log(`首頁 status=${home.status} cache=${home.headers["x-vercel-cache"]} age=${home.headers["age"]}`);

  // 🔴 關鍵：POS app / 報表 / 打印中心 嘅 chunk **唔會**出現喺首頁 HTML（AuthGuard 後面 lazy-load）。
  //    所以一定要逐個 route 抓，先攞得到佢哋嘅 script 清單。
  const ROUTES = ["/", "/pos", "/reports", "/prints", "/settings", "/orders", "/members", "/quick", "/login"];
  let urls = [];
  for (const r of ROUTES) {
    const res = await get(`${SITE}${r}${r.includes("?") ? "&" : "?"}_probe=${Date.now()}`, {
      "cache-control": "no-cache",
    });
    const found = extractScriptUrls(res.body);
    console.log(`  ${r.padEnd(10)} status=${res.status} chunk=${found.length}`);
    urls.push(...found);
  }
  urls = [...new Set(urls)];
  console.log(`合共 ${urls.length} 個不重複 chunk`);

  const markers = ["skipQueue=1", "skipQueue", "ordersOnly=1", "分鐘自動更新"];
  const found = Object.fromEntries(markers.map((m) => [m, []]));
  let scanned = 0;
  let bytes = 0;

  // 🔴 BFS 一層：lazy-loaded 嘅 chunk（例如 AuthGuard 後面嘅 `pos-app`）唔會出現喺 HTML，
  //    但**父 chunk 嘅程式碼裡面**會以字串形式帶著佢嘅路徑 ⇒ 由已下載嘅 chunk 再抽 URL。
  const queue = [...urls];
  const seen = new Set(queue);
  const bodies = [];

  while (queue.length > 0 && scanned < 250) {
    const u = queue.shift();
    const full = u.startsWith("http") ? u : SITE + u;
    const res = await get(full, { "cache-control": "no-cache" });
    if (res.status !== 200) continue;
    scanned += 1;
    bytes += Buffer.byteLength(res.body, "utf8");
    bodies.push([full, res.body]);

    // 抽下一層 chunk URL
    for (const m of res.body.matchAll(/\/_next\/static\/[a-zA-Z0-9._\-\/]+\.js/g)) {
      const nu = m[0];
      if (!seen.has(nu)) {
        seen.add(nu);
        queue.push(nu);
      }
    }
  }

  for (const [full, body] of bodies) {
    for (const m of markers) {
      if (body.includes(m) && found[m].length < 3) found[m].push(full.replace(SITE, ""));
    }
  }

  console.log(`\n掃描 ${scanned} 個 chunk（連 lazy chunk，共 ${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  console.log("================ 版本標記 ================");
  for (const m of markers) {
    const hits = found[m];
    console.log(`${hits.length ? "✅" : "❌"} "${m}"  ${hits.length ? hits.join(", ") : "（搵唔到）"}`);
  }

  const ok = found["skipQueue"].length > 0 || found["ordersOnly=1"].length > 0;
  console.log(
    `\n判定：${ok ? "線上 bundle 已包含 2026-09-21 改動 ✅" : "掃唔到 —— 可能係掃唔齊 chunk（唔等於未部署），要用 deployment sha 對照"}`,
  );
  console.log("（server-only 改動唔會出 bundle，只可以用 commit／deployment sha 對照。）");
})();
