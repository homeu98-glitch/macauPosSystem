/* 臨時：真實瀏覽器驗證「單位欄顯示不全」是否已修（量實際 bounding box） */
const puppeteer = require("puppeteer-core");
const fs = require("fs");

const BASE = "http://localhost:3017";
const MID = "66123456";
const OUT = "docs/mockups/unit-select-width-verify-2026-10-07";
fs.mkdirSync(OUT, { recursive: true });

const seed = {
  "macau-pos/auth-session": JSON.stringify({
    account: MID, name: "表嫂美食", role: "manager", merchantId: MID,
    ledgerAccessToken: "demo", ledgerRefreshToken: "demo",
    permissions: {}, loggedInAt: new Date().toISOString(),
  }),
  [`macau-pos/stores/${MID}/bootstrap`]: JSON.stringify({
    storeId: MID, storeName: "表嫂美食", currency: "MOP",
    tables: [{ id: "t-a01", name: "A01", area: "大堂", capacity: 4 }],
    menuItems: [{ id: "m-1", name: "凍檸茶", price: 22, categoryId: "c-1" }],
    categories: [{ id: "c-1", name: "飲品" }],
    rules: { serviceChargeRate: 0, taxRate: 0 },
  }),
  [`macau-pos/stores/${MID}/orders`]: "[]",
  [`macau-pos/stores/${MID}/shift`]: JSON.stringify({}),
  // 🔴 關鍵：種「單位」主檔，否則會走自由輸入分支（驗唔到 select）
  [`macau-pos/stores/${MID}/local-settings`]: JSON.stringify({
    invCategories: ["肉類", "海鮮"],
    invCategoryOrder: ["肉類", "海鮮"],
    invUnits: ["公斤", "包", "罐", "盒"],
    invUnitOrder: ["公斤", "包", "罐", "盒"],
    invSupplierOrder: [],
    paymentMethods: [{ code: "cash", label: "現金", scope: "purchase" }],
  }),
  "macau-pos/offline-mode": "1",
};

const MOCK = {
  "/api/inventory/merchants": { merchants: [] },
  "/api/inventory/receipts": { receipts: [], total: 0 },
  "/api/inventory/receipt-items": { items: [] },
  "/api/inventory/products": { products: [], total: 0 },
  "/api/inventory/soldout": { items: [] },
  "/api/inventory/payment-methods": {
    methods: [{ code: "cash", label: "現金", scope: "purchase" }],
  },
  "/api/inventory/item-analysis": { rows: [], receiptCount: 0 },
  "/api/inventory/master-usage": { usage: {} },
};

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, seed);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    if (!u.includes("/api/")) return req.continue();
    const hit = Object.keys(MOCK).find((p) => u.includes(p));
    if (hit) {
      return req.respond({
        status: 200, contentType: "application/json",
        body: JSON.stringify(MOCK[hit]),
      });
    }
    return req.continue();
  });

  await page.goto(`${BASE}/inventory`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 4000));

  // 撳「＋ 新增收據」
  const opened = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => (x.textContent || "").replace(/\s+/g, "").includes("新增收據"));
    if (b) { b.click(); return true; }
    return false;
  });
  console.log("opened modal:", opened);
  await new Promise((r) => setTimeout(r, 1200));

  // 撳「＋ 品項」
  const added = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => (x.textContent || "").replace(/\s+/g, "") === "＋品項");
    if (b) { b.click(); return true; }
    return false;
  });
  console.log("added item row:", added);
  await new Promise((r) => setTimeout(r, 600));

  // 揀一個單位（用真實 DOM 改 value + dispatch change，模擬使用者揀）
  const sel = 'select[aria-label="第 1 項單位"]';
  const exists = await page.$(sel);
  console.log("select exists:", !!exists);
  if (exists) {
    await page.select(sel, "公斤");
    await new Promise((r) => setTimeout(r, 400));
  }

  // 🔴 量實際幾何：select 闊度 / 內文可見闊度 / 文字有冇被截
  const m = await page.evaluate((sel) => {
    const s = document.querySelector(sel);
    if (!s) return null;
    const r = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // native select 嘅箭咀區（Chrome ≈ 右邊 20~24px）
    const arrow = 22;
    const inner = r.width - padL - padR - arrow;
    // 用 Range 量「如果係普通文字要幾闊」—— 對 <select> 唔可行，
    // 改用 canvas 量同字號文字寬度
    const cv = document.createElement("canvas");
    const cx = cv.getContext("2d");
    cx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const textW = cx.measureText(s.value || s.options[s.selectedIndex]?.text || "").width;
    return {
      value: s.value,
      boxW: Math.round(r.width),
      padL, padR,
      innerAvail: Math.round(inner),
      textW: Math.round(textW),
      fits: textW <= inner,
      fontSize: cs.fontSize,
      overflow: s.scrollWidth > s.clientWidth,
    };
  }, sel);
  console.log("MEASURE(select):", JSON.stringify(m, null, 2));

  // 手動輸入模式（揀「其他…」）都量一次
  await page.select(sel, "__custom_unit__").catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const m2 = await page.evaluate(() => {
    const i = document.querySelector('input[aria-label="第 1 項單位"]');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    const btn = i.parentElement.querySelector("button");
    const br = btn ? btn.getBoundingClientRect() : null;
    return {
      inputW: Math.round(r.width),
      toggleW: br ? Math.round(br.width) : null,
      toggleH: br ? Math.round(br.height) : null,
      mode: "manual-input",
    };
  });
  console.log("MEASURE(manual):", JSON.stringify(m2, null, 2));

  await page.screenshot({ path: `${OUT}/01-unit-select-fixed.png` });

  // 截圖：只截 modal 內個品項 row
  const row = await page.$('input[aria-label="第 1 項品名"]');
  if (row) {
    const box = await row.evaluate((el) => {
      const r = el.closest("div.grid").getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.screenshot({
      path: `${OUT}/02-item-row.png`,
      clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 },
    });
  }

  console.log("pageerrors:", errs.length ? errs.slice(0, 5) : "none");
  await browser.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
