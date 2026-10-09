// 診斷：/orders 頁仲有邊啲中文殘留、喺邊個元素。
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
    menuItems: [{ id: "m-1", name: "凍檸茶", price: 22, categoryId: "c-1" }],
    categories: [{ id: "c-1", name: "飲品" }],
    rules: { serviceChargeRate: 0, taxRate: 0 },
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

const report = await page.evaluate(() => {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const out = [];
  document.querySelectorAll("*").forEach((el) => {
    if (el.children.length) return; // 只睇葉節點
    const txt = (el.textContent || "").trim();
    if (!txt || !CJK.test(txt)) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().slice(0, 60),
      text: txt.slice(0, 80),
      parent: el.parentElement ? (el.parentElement.className || "").toString().slice(0, 60) : "",
    });
  });
  return out;
});

console.log("=== 含中文嘅葉節點 ===");
for (const r of report) console.log(JSON.stringify(r, null, 0));

// 直接檢查字典
const dictProbe = await page.evaluate(() => {
  const key = "今天";
  return { note: "page context 讀唔到 TS 字典，只列出元素" };
});
console.log("---", dictProbe.note);

await browser.close();
