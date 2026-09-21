/**
 * 真實瀏覽器流程驗證（2026-09-21 egress 優化之後）。
 *
 * 目的：確認「點餐 / 打印 / 設置 / 報表 / 其他」冇被改動影響。
 * 做法：本機 dev server + Chrome headless（唔需要 Supabase／Ledger 後端）。
 *
 * 用法：
 *   NODE_PATH=C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules \
 *   node tools/_verify-flows-20260921.cjs
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE = "http://localhost:3017"; // 🔴 一定要 localhost，唔可以 127.0.0.1（Next 16 封鎖跨來源 dev 資源）
const OUT = "docs/mockups/egress-opt-verify-2026-09-21";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/** 需要巡嘅路由（按用戶要求分組）。 */
const ROUTES = [
  { path: "/", label: "01-收銀台-工作台選擇", gate: true },
  { path: "/", label: "02-點餐-桌台總覽", after: async () => {} },
  { path: "/settings", label: "03-設置" },
  { path: "/reports", label: "04-報表" },
  { path: "/prints", label: "05-打印中心" },
  { path: "/orders", label: "06-訂單" },
  { path: "/members", label: "07-會員" },
  { path: "/soldout", label: "08-沽清" },
  { path: "/shift", label: "09-交班" },
  { path: "/inventory", label: "10-庫存" },
  { path: "/menu", label: "11-線上菜單" },
  { path: "/kitchen", label: "12-後廚屏" },
  { path: "/expo", label: "13-出餐台屏" },
  { path: "/quick", label: "14-快餐模式" },
  { path: "/order", label: "15-客人點餐頁" },
  { path: "/topup", label: "16-會員充值" },
  { path: "/login", label: "17-登入頁" },
];

/** 呢啲文字出現 = 卡死（唔應該喺任何頁面見到）。 */
const STUCK_MARKERS = ["正在載入頁面…", "正在載入門店設定…", "Application error"];

/** mock 模式下**預期**嘅網絡錯誤（唔算回歸）。 */
function isExpectedNetworkNoise(text) {
  return (
    /Failed to fetch|net::ERR_|Load failed|503|401|AbortError|NetworkError/i.test(text) ||
    /socket|websocket|realtime/i.test(text)
  );
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });

  const results = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // ── 收集錯誤（每個 route 重置）──
  let consoleErrors = [];
  let consoleWarns = [];
  let pageErrors = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (msg.type() === "error") consoleErrors.push(t);
    else if (msg.type() === "warning") consoleWarns.push(t);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  // ── localStorage 種子（見 pos-ui-live-verify skill）──
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
      tables: [
        { id: "t-a01", name: "A01", area: "大堂", capacity: 4 },
        { id: "t-a02", name: "A02", area: "大堂", capacity: 2 },
      ],
      menuItems: [
        { id: "m-1", name: "凍檸茶", price: 22, categoryId: "c-1", printerGroup: "kitchen" },
        { id: "m-2", name: "豬扒包", price: 38, categoryId: "c-2", printerGroup: "kitchen" },
      ],
      categories: [
        { id: "c-1", name: "飲品" },
        { id: "c-2", name: "小食" },
      ],
      rules: { serviceChargeRate: 0, taxRate: 0 },
    }),
    [`macau-pos/stores/${MID}/orders`]: "[]",
    [`macau-pos/stores/${MID}/shift`]: JSON.stringify({}),
    "macau-pos/offline-mode": "1",
  };
  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, seed);

  for (const route of ROUTES) {
    consoleErrors = [];
    consoleWarns = [];
    pageErrors = [];

    let status = "?";
    try {
      const resp = await page.goto(BASE + route.path, { waitUntil: "domcontentloaded", timeout: 45000 });
      status = resp ? resp.status() : "no-response";
    } catch (err) {
      status = "goto-failed:" + String(err.message).slice(0, 60);
    }
    await sleep(route.path === "/" ? 9000 : 4500);

    // 過「工作台選擇」閘
    if (route.gate) {
      const clicked = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) =>
          (x.textContent || "").includes("堂食收銀台"),
        );
        if (b) {
          b.click();
          return b.textContent.trim();
        }
        return null;
      });
      route.gateClicked = clicked;
      await sleep(5000);
    }

    const info = await page.evaluate((markers) => {
      const text = document.body.innerText || "";
      const stuck = markers.filter((m) => text.includes(m));
      const navTexts = Array.from(document.querySelectorAll("a,[role=button],[role=tab],button,div,span"))
        .map((n) => (n.textContent || "").trim())
        .filter((t) => t.length > 0 && t.length <= 6);
      return {
        textLen: text.length,
        stuck,
        head: text.slice(0, 160).replace(/\n+/g, " | "),
        navSample: [...new Set(navTexts)].slice(0, 40),
      };
    }, STUCK_MARKERS);

    const shot = path.join(OUT, route.label + ".png");
    await page.screenshot({ path: shot });

    const realErrors = pageErrors.filter((e) => !isExpectedNetworkNoise(e));
    const realConsoleErrors = consoleErrors.filter((e) => !isExpectedNetworkNoise(e));

    results.push({
      label: route.label,
      path: route.path,
      status,
      gateClicked: route.gateClicked,
      textLen: info.textLen,
      stuck: info.stuck,
      pageErrors: pageErrors.length,
      realErrors,
      consoleErrors: consoleErrors.length,
      realConsoleErrors,
      head: info.head,
      navSample: info.navSample,
      shot,
    });
  }

  await browser.close();

  // ── 報告 ──
  console.log("================ 流程驗證結果 ================");
  let problems = 0;
  for (const r of results) {
    const bad = r.stuck.length > 0 || r.realErrors.length > 0 || r.realConsoleErrors.length > 0;
    if (bad) problems += 1;
    console.log(
      `${bad ? "❌" : "✅"} ${r.label.padEnd(22)} http=${String(r.status).padEnd(4)} 文字=${String(r.textLen).padStart(5)} pageError=${r.pageErrors} consoleErr=${r.consoleErrors}` +
        (r.gateClicked ? ` 過閘="${r.gateClicked}"` : "") +
        (r.stuck.length ? ` 卡死標記=${JSON.stringify(r.stuck)}` : ""),
    );
    if (r.realErrors.length) console.log(`     🔴 真 pageerror：${r.realErrors.slice(0, 3).join(" ‖ ")}`);
    if (r.realConsoleErrors.length)
      console.log(`     🔴 真 console.error：${r.realConsoleErrors.slice(0, 3).map((s) => s.slice(0, 160)).join(" ‖ ")}`);
    console.log(`     開頭文字：${r.head.slice(0, 110)}`);
  }
  console.log(`\n有問題嘅頁面數：${problems} / ${results.length}`);
  console.log(`截圖目錄：${OUT}`);

  // 側欄文案（供人手核對導覽項）
  const home = results.find((r) => r.label.includes("點餐-桌台"));
  if (home) console.log(`\n側欄／可見短文案樣本：${home.navSample.join(" ")}`);
})().catch((err) => {
  console.error("驗證腳本爆咗：", err);
  process.exit(1);
});
