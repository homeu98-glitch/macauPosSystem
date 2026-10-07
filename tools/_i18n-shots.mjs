// ⚠️ ESM 唔食 NODE_PATH，而且 Windows 絕對路徑要用 file:// URL
// （puppeteer-core 嘅實際入口係 lib/puppeteer/，唔係 lib/esm/puppeteer/）
const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);
import fs from "node:fs";

const BASE = "http://localhost:3017";
const OUT = "C:/dev/macauPos/macauPosSystem/docs/mockups/i18n-verify-2026-10-07";
fs.mkdirSync(OUT, { recursive: true });

const MID = "66123456";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSeed(lang) {
  return {
    "pos.uiLang": lang,
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
    [`macau-pos/stores/${MID}/shift`]: JSON.stringify({ openedAt: new Date().toISOString() }),
    [`macau-pos/stores/${MID}/device-config`]: JSON.stringify({
      printers: [
        { id: "p1", name: "斑馬 ZD421（收銀）", role: "receipt", connectionType: "lan",
          ipAddress: "192.168.1.110", model: "ZD421", enabled: true, id_prefix: "p" },
        { id: "p2", name: "立象 XP-235B（廚房）", role: "zone", connectionType: "lan",
          ipAddress: "192.168.1.111", model: "XP-235B", enabled: true, zoneId: "z1" },
        { id: "p3", name: "漢印 N33（標籤）", role: "label", connectionType: "usb",
          usbVendorId: "0x0416", model: "N33", enabled: false, paperSize: "60x40mm" },
      ],
    }),
    [`macau-pos/stores/${MID}/local-settings`]: JSON.stringify({
      printZones: [{ id: "z1", name: "廚房" }, { id: "z2", name: "水吧" }],
    }),
    "macau-pos/offline-mode": "1",
  };
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const errors = [];
async function newPage(lang) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`[${lang}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${lang}] console: ${m.text().slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, buildSeed(lang));
  return page;
}

// ── 1. 選擇工作台頁 ──
for (const lang of ["zh-Hant", "en"]) {
  const page = await newPage(lang);
  await page.goto(BASE + "/select-workbench", { waitUntil: "domcontentloaded" });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/01-select-workbench-${lang}.png` });
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 200));
  console.log(`[${lang}] <html lang>=${htmlLang}`);
  console.log(`[${lang}] text: ${txt.replace(/\n/g, " | ").slice(0, 160)}`);
  await page.close();
}

// ── 2. 設置頁（打印機列表 tab + 往下掃到語言區／打印開關）──
for (const lang of ["zh-Hant", "en"]) {
  const page = await newPage(lang);
  await page.goto(BASE + "/settings", { waitUntil: "domcontentloaded" });
  await sleep(8000);
  // 撳「打印機列表」次層 tab
  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => {
        const s = (x.textContent || "").replace(/\s+/g, "");
        return s === "打印機列表" || s === "打印機列表" || s === "Printerlist";
      });
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/02a-settings-printers-top-${lang}.png` });
  // 打印機卡逐張截（睇英文長文案排版）
  await page.screenshot({ path: `${OUT}/02a2-settings-printer-cards-${lang}.png`, fullPage: false });

  // helper：撳／捲到標題文字（面板唔係 tab，係同一頁面嘅 section ⇒ 靠 scroll）
  const gotoHeading = async (zh, en) => {
    return await page.evaluate((a) => {
      const want = [a.zh, a.en].map((s) => s.replace(/\s+/g, ""));
      const nodes = Array.from(document.querySelectorAll("div,h2,h3,span"));
      const hit = nodes.find((d) => {
        const s = (d.textContent || "").replace(/\s+/g, "").trim();
        return want.includes(s) && d.getBoundingClientRect().height > 0;
      });
      if (!hit) return false;
      hit.scrollIntoView({ block: "start" });
      window.scrollBy(0, -20);
      return true;
    }, { zh, en });
  };

  // ── 打印開關設置（AutoAcceptPill 區）──
  const togFound = await gotoHeading("打印開關設置", "Automatic print switches");
  await sleep(900);
  await page.screenshot({ path: `${OUT}/02c-settings-toggles-${lang}.png` });
  const toggleRows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("button[aria-pressed]").forEach((b) => {
      out.push({ aria: b.getAttribute("aria-label"), state: (b.textContent || "").trim() });
    });
    return out.slice(0, 14);
  });
  console.log(`[${lang}] togglesFound=${togFound} rows=${JSON.stringify(toggleRows)}`);

  // ── 雲端列印中繼（relay-pairing-panel）──
  const relayFound = await gotoHeading("雲端列印中繼（relay）", "雲端列印中繼（relay）");
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/02f-settings-relay-${lang}.png` });
  const relayBlock = await page.evaluate(() => {
    // 抽 relay 面板附近嘅 innerText（由標題起 900 字）
    const nodes = Array.from(document.querySelectorAll("div"));
    const hit = nodes.find((d) => {
      const s = (d.textContent || "").replace(/\s+/g, "");
      return (s === "雲端列印中繼（relay）" || s === "雲端列印中繼(relay)") && d.getBoundingClientRect().height > 0;
    });
    return hit ? (hit.parentElement?.innerText || "").slice(0, 700) : "(heading not found)";
  });
  console.log(`[${lang}] relayFound=${relayFound} panel=\n${relayBlock}`);
  // 向下捲到語言區 + 打印開關設置
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div"))
      .find((d) => (d.textContent || "").replace(/\s+/g, "") === "介面語言");
    if (el) el.scrollIntoView({ block: "center" });
  });
  await sleep(800);
  await page.screenshot({ path: `${OUT}/02b-settings-language-${lang}.png` });
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div"))
      .find((d) => ["打印開關設置", "Automaticprintswitches"].includes((d.textContent || "").replace(/\s+/g, "")));
    if (el) el.scrollIntoView({ block: "start" });
  });
  await sleep(800);
  await page.screenshot({ path: `${OUT}/02c-settings-toggles-${lang}.png` });

  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  const tabList = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").replace(/\s+/g, "").trim())
      .filter((s) => s && s.length <= 24).slice(0, 40));
  console.log(`[${lang}] settings clicked=${clicked} htmlLang=${htmlLang}`);
  console.log(`[${lang}] buttons: ${JSON.stringify(tabList)}`);
  await page.close();
}

// ── 3. 收銀台（側欄 + 桌台總覽）──
for (const lang of ["zh-Hant", "en"]) {
  const page = await newPage(lang);
  await page.goto(BASE + "/pos", { waitUntil: "domcontentloaded" });
  await sleep(9000);
  // 過埋「選擇工作台」閘
  const w = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => ["堂食收銀台", "Dine-in register"].includes((x.textContent || "").replace(/\s+/g, "").trim()));
    if (b) { b.click(); return true; }
    return false;
  });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/03-pos-sidebar-${lang}.png` });
  const info = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("span,a,div"))
      .filter((n) => (n.textContent || "").trim().length > 0 && (n.textContent || "").trim().length <= 4)
      .filter((n) => n.getBoundingClientRect().width > 0)
      .map((n) => ({ t: (n.textContent || "").trim(), w: Math.round(n.getBoundingClientRect().width) }));
    return { htmlLang: document.documentElement.lang, sample: nodes.slice(0, 24) };
  });
  console.log(`[${lang}] pos workbenchClicked=${w} htmlLang=${info.htmlLang}`);
  console.log(`[${lang}] short labels: ${JSON.stringify(info.sample)}`);
  await page.close();
}

// ── 4. 移動底欄（390×844）──
for (const lang of ["zh-Hant", "en"]) {
  const page = await newPage(lang);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(BASE + "/pos", { waitUntil: "domcontentloaded" });
  await sleep(9000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => ["堂食收銀台", "Dine-in register"].includes((x.textContent || "").replace(/\s+/g, "").trim()));
    if (b) b.click();
  });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/04-pos-mobile-${lang}.png` });
  // 量底欄每格：睇有冇文字溢出
  const overflow = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll("*").forEach((el) => {
      if (el.children.length > 0) return;
      const s = (el.textContent || "").trim();
      if (!s || s.length > 20) return;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        bad.push({ t: s, sw: el.scrollWidth, cw: el.clientWidth });
      }
    });
    return bad.slice(0, 20);
  });
  console.log(`[${lang}] mobile overflow: ${JSON.stringify(overflow)}`);
  await page.close();
}

console.log("\n=== ERRORS (" + errors.length + ") ===");
console.log(errors.slice(0, 25).join("\n"));
await browser.close();