// 探測：由桌台總覽撳入落單頁，dump 所有可見按鈕／標題，用嚟定 12/13 截圖嘅撳法。
// 用法：node tools/_i18n-probe-order.mjs [en|zh-Hant]
const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);

const BASE = "http://localhost:3017";
const lang = process.argv[2] || "en";
const MID = "66123456";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();

const SEED = {
  "pos.uiLang": lang,
  "macau-pos/auth-session": JSON.stringify({
    account: MID, name: "表嫂美食", role: "manager", merchantId: MID,
    ledgerAccessToken: "demo", ledgerRefreshToken: "demo",
    permissions: {}, loggedInAt: now.toISOString(),
  }),
  [`macau-pos/stores/${MID}/shift`]: JSON.stringify({ openedAt: now.toISOString() }),
  "macau-pos/offline-mode": "1",
};

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.setDefaultNavigationTimeout(120000);
page.setDefaultTimeout(60000);
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument((d) => {
  for (const k in d) localStorage.setItem(k, d[k]);
}, SEED);

/** 撳 textContent 完全等於 want 嘅 button/a */
async function clickExact(wants) {
  return await page.evaluate((ws) => {
    const want = ws.map((s) => s.replace(/\s+/g, ""));
    const b = Array.from(document.querySelectorAll("button,a")).find((x) => {
      const s = (x.textContent || "").replace(/\s+/g, "").trim();
      return want.includes(s) && x.getBoundingClientRect().height > 0;
    });
    if (b) { b.click(); return true; }
    return false;
  }, wants);
}

/** 撳 textContent 以 prefix 開頭嘅 button（桌卡用） */
async function clickStartsWith(prefix) {
  return await page.evaluate((p) => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => {
      const s = (x.textContent || "").replace(/\s+/g, "").trim();
      return s.startsWith(p) && x.getBoundingClientRect().height > 0;
    });
    if (b) { b.click(); return true; }
    return false;
  }, prefix);
}

/** dump 所有可見 button / a 嘅文字 */
async function dumpButtons(label) {
  const out = await page.evaluate(() => {
    const seen = [];
    for (const x of document.querySelectorAll("button,a")) {
      const r = x.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) continue;
      const s = (x.textContent || "").replace(/\s+/g, " ").trim();
      if (!s || s.length > 24) continue;
      if (!seen.includes(s)) seen.push(s);
    }
    return seen;
  });
  console.log(`\n--- BUTTONS @ ${label} (${out.length}) ---`);
  console.log(JSON.stringify(out));
}

await page.goto(BASE + "/pos", { waitUntil: "domcontentloaded" });
await sleep(9000);
console.log("workbench:", await clickExact(["堂食收銀台", "Dine-in register"]));
await sleep(6000);
await dumpButtons("tables");

console.log("\nclick A01:", await clickStartsWith("A01"));
await sleep(3000);
await dumpButtons("after-A01");
const modal = await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll("div,span,h2,h3"))
    .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
    .filter((s) => /開桌|Open table|入座人數|Party size/.test(s) && s.length < 60);
  return t.slice(0, 5);
});
console.log("modal 痕跡:", JSON.stringify(modal));

console.log("\nclick 開桌:", await clickExact(["開桌", "Open table", "Open"]));
await sleep(5000);
await dumpButtons("after-open-table");
const body = await page.evaluate(() =>
  (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 40),
);
console.log("\n--- BODY TEXT (前40行) ---");
console.log(JSON.stringify(body, null, 0));

await page.screenshot({ path: "C:/dev/macauPos/macauPosSystem/docs/mockups/_probe-order.png" });
await browser.close();
