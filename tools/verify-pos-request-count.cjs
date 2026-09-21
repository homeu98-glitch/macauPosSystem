/**
 * 驗證 herd 合併效果（2026-09-21）：開 `/pos` 之後數**實際請求次數**。
 *
 * 改動前（實測）：`online-order-settings` ×5、`store-status` ×3（同一秒）。
 * 改動後應該：各 **1**。
 *
 * 用法：NODE_PATH=... node tools/verify-pos-request-count.cjs
 */
const puppeteer = require("puppeteer-core");

const BASE = "http://localhost:3017";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MID = "66123456";
const seed = {
  "macau-pos/auth-session": JSON.stringify({
    account: MID,
    name: "表嫂美食",
    role: "manager",
    merchantId: MID,
    ledgerAccessToken: "demo",
    ledgerRefreshToken: "demo",
    permissions: {},
    loggedInAt: new Date().toISOString(),
  }),
  [`macau-pos/stores/${MID}/bootstrap`]: JSON.stringify({
    storeId: MID,
    storeName: "表嫂美食",
    currency: "MOP",
    tables: [{ id: "t-a01", name: "A01", area: "大堂", capacity: 4 }],
    menuItems: [{ id: "m-1", name: "凍檸茶", price: 22, categoryId: "c-1" }],
    categories: [{ id: "c-1", name: "飲品" }],
    rules: { serviceChargeRate: 0, taxRate: 0 },
  }),
  [`macau-pos/stores/${MID}/orders`]: "[]",
  [`macau-pos/stores/${MID}/shift`]: JSON.stringify({}),
  "macau-pos/offline-mode": "1",
  // 強制用「上次使用過」嘅工作台，令流程同真人一樣
  "macau-pos/last-workbench": JSON.stringify({ mode: "tables", at: new Date().toISOString() }),
};

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const counts = new Map();
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("/api/")) return;
    const p = url.replace(BASE, "").split("?")[0];
    counts.set(p, (counts.get(p) || 0) + 1);
  });

  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, seed);

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(9000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      (x.textContent || "").includes("堂食收銀台"),
    );
    if (b) b.click();
  });
  await sleep(6000);

  // 再模擬「切去别的 tab 再返嚟」→ 睇 visibilitychange 會唔會又爆幾次
  const before = new Map(counts);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(300);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(4000);

  await browser.close();

  const relevant = ["/api/online-order-settings", "/api/pos/store-status"];
  console.log("================ 開頁後嘅 API 請求次數 ================");
  for (const [p, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = n > 1 ? "（含切前景 +1）" : "";
    console.log(`  ${String(n).padStart(2)}  ${p} ${flag}`);
  }

  console.log("\n================ herd 目標項（分兩個階段驗）================");
  console.log("階段① 開頁：目標 1 次（改動前：online-order-settings ×5、store-status ×3）");
  console.log("階段② 切返前景：目標 +1 次（改動前：各 +5／+3，因為每個 mount 各掛一個 listener）");
  let failed = 0;
  for (const p of relevant) {
    const atLoad = before.get(p) || 0;
    const total = counts.get(p) || 0;
    const onReturn = total - atLoad;
    const ok = atLoad === 1 && onReturn === 1;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "✅" : "❌"} ${p}\n     階段① 開頁 ${atLoad} 次（目標 1）｜階段② 切返前景 +${onReturn} 次（目標 1）`,
    );
  }
  console.log(`\n合計：${relevant.length - failed} / ${relevant.length} 達標`);
  if (failed > 0) process.exitCode = 1;
})();
