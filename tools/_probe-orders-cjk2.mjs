const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);
const BASE = "http://localhost:3017";
const MID = "66123456";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const seed = {
  "pos.uiLang": "en",
  "macau-pos/auth-session": JSON.stringify({
    account: MID, name: "表嫂美食", role: "manager", merchantId: MID,
    ledgerAccessToken: "demo", ledgerRefreshToken: "demo",
    permissions: {}, loggedInAt: now.toISOString(),
  }),
  [`macau-pos/stores/${MID}/bootstrap`]: JSON.stringify({
    storeId: MID, storeName: "表嫂美食", currency: "MOP",
    tables: [{ id: "t-a01", name: "A01", area: "大堂", capacity: 4 }],
    menuItems: [], categories: [], rules: { serviceChargeRate: 0, taxRate: 0 },
  }),
  [`macau-pos/stores/${MID}/orders`]: JSON.stringify([]),
};
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 760 });
await page.evaluateOnNewDocument((s) => {
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
}, seed);
await page.goto(`${BASE}/orders`, { waitUntil: "networkidle2" });
await sleep(2500);
const r = await page.evaluate(() => {
  const el = [...document.querySelectorAll("div")].find((d) =>
    (d.className || "").includes("mt-1 text-xs text-slate-500 sm:text-sm"),
  );
  const txt = el ? el.textContent : "(not found)";
  return { txt, cps: [...txt].slice(0, 8).map((c) => c.codePointAt(0).toString(16)) };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
