// ⚠️ ESM 唔食 NODE_PATH，而且 Windows 絕對路徑要用 file:// URL
// （puppeteer-core 嘅實際入口係 lib/puppeteer/，唔係 lib/esm/puppeteer/）
const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);
import fs from "node:fs";

const BASE = "http://localhost:3017";
const OUT = "C:/dev/macauPos/macauPosSystem/docs/mockups/i18n-verify-2026-10-08";
fs.mkdirSync(OUT, { recursive: true });

const MID = "66123456";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

function buildSeed(lang, minimal = false) {
  const seed = {
    "pos.uiLang": lang,
    "macau-pos/auth-session": JSON.stringify({
      account: MID, name: "表嫂美食", role: "manager", merchantId: MID,
      ledgerAccessToken: "demo", ledgerRefreshToken: "demo",
      permissions: {}, loggedInAt: now.toISOString(),
    }),
    [`macau-pos/stores/${MID}/bootstrap`]: JSON.stringify({
      storeId: MID, storeName: "表嫂美食", currency: "MOP",
      tables: [
        { id: "t-a01", name: "A01", area: "大堂", capacity: 4, status: "occupied", orderId: "o-1001" },
        { id: "t-a02", name: "A02", area: "大堂", capacity: 4, status: "occupied", orderId: "o-1002" },
        { id: "t-a03", name: "A03", area: "大堂", capacity: 6 },
        { id: "t-a04", name: "A04", area: "大堂", capacity: 2 },
        { id: "t-b01", name: "B01", area: "卡座", capacity: 8 },
        { id: "t-b02", name: "B02", area: "卡座", capacity: 6 },
      ],
      menuItems: [
        { id: "m-1", name: "凍檸茶", price: 22, categoryId: "c-1" },
        { id: "m-2", name: "絲襪奶茶", price: 25, categoryId: "c-1" },
        { id: "m-3", name: "西多士", price: 32, categoryId: "c-2" },
        { id: "m-4", name: "牛扒餐", price: 128, categoryId: "c-3" },
        { id: "m-5", name: "沙律", price: 48, categoryId: "c-2" },
        { id: "m-6", name: "咖啡", price: 20, categoryId: "c-1" },
      ],
      categories: [
        { id: "c-1", name: "飲品" },
        { id: "c-2", name: "小食" },
        { id: "c-3", name: "主食" },
      ],
      rules: { serviceChargeRate: 0, taxRate: 0 },
    }),
    [`macau-pos/stores/${MID}/orders`]: JSON.stringify([
      // 🔴 `status` 一定要用 **真嘅 `PosOrder` enum**（`src/lib/types.ts:1231`）。
      //    以前寫 `"open"` —— 唔存在嘅值 ⇒ 報表「狀態分佈」會 render 出原始
      //    `open 2 張`（英文/中文都一樣），令截圖唔似真實畫面，仲掩蓋咗
      //    `POS_ORDER_STATUS_LABELS` 嘅翻譯（2026-10-08 修）。
      {
        id: "o-1001", storeId: MID, tableId: "t-a01", tableName: "A01",
        type: "dine-in", status: "sent_to_kitchen", items: [
          // 🔴 欄位名係 `quantity`（`src/lib/types.ts` OrderItem），唔係 `qty`。
          //    寫錯會令訂單摘要 render 成「牛扒餐×undefined · 咖啡×undefined」，
          //    仲會因為字串變長而觸發假嘅「窄屏被裁」警報（2026-10-08 實測）。
          { id: "i-1", menuItemId: "m-1", name: "凍檸茶", price: 22, quantity: 2, note: "少冰" },
          { id: "i-2", menuItemId: "m-3", name: "西多士", price: 32, quantity: 1 },
        ],
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
      {
        id: "o-1002", storeId: MID, tableId: "t-a02", tableName: "A02",
        type: "dine-in", status: "sent_to_kitchen", items: [
          { id: "i-3", menuItemId: "m-4", name: "牛扒餐", price: 128, quantity: 1 },
          { id: "i-4", menuItemId: "m-6", name: "咖啡", price: 20, quantity: 2 },
        ],
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
    ]),
    [`macau-pos/stores/${MID}/shift`]: JSON.stringify({ openedAt: now.toISOString() }),
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
  if (minimal) {
    /**
     * 🔴 落單頁（step 2）**唔可以**種 `bootstrap`／`orders`。
     *
     * 種咗之後菜品區會變「沒有符合條件的商品」——種子嘅 `menuItems`
     * 用 `categoryId: c-1/c-2/c-3`，但畫面上嘅分類 tab 係 server 嘅
     * `飯類 / 粉麵 / 飲品`，兩邊對唔上 ⇒ 篩選完 0 件 ⇒ 撳唔到「加入」
     * ⇒ 12（餐牌面板）／13（結帳）出唔到（2026-10-08 實測）。
     * 唔種就用返 server 真實菜單（store 66123456 有 叉燒飯／酸菜魚／餐蛋治）。
     */
    for (const k of Object.keys(seed)) {
      if (k.includes("/bootstrap") || k.includes("/orders")) delete seed[k];
    }
  }
  return seed;
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  // 🔴 `/pos` 係 8670 行 + 圖片，`page.evaluate` 量 bounding box 會超過預設 180s protocolTimeout。
  protocolTimeout: 600000,
});

const errors = [];
async function newPage(lang, vp = { width: 1280, height: 900 }, minimal = false) {
  const page = await browser.newPage();
  // 🔴 首次 goto 某個 route 會觸發 Next dev 即場 compile（可以 >30s）⇒ 預設 30s timeout 會炸。
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);
  await page.setViewport({ ...vp, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`[${lang}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|503/.test(m.text())) {
      errors.push(`[${lang}] console: ${m.text().slice(0, 200)}`);
    }
  });
  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, buildSeed(lang, minimal));
  return page;
}

/** 撳掣：中文或英文都試（中英可能差少少），成功返 true */
async function click(page, zh, en) {
  return await page.evaluate((a) => {
    const want = [a.zh, a.en].filter(Boolean).map((s) => s.replace(/\s+/g, ""));
    const b = Array.from(document.querySelectorAll("button,a")).find((x) => {
      const s = (x.textContent || "").replace(/\s+/g, "").trim();
      return want.includes(s) && x.getBoundingClientRect().height > 0;
    });
    if (b) { b.click(); return true; }
    return false;
  }, { zh, en });
}

/**
 * 撳 `<button>`：textContent **以 prefix 開頭**。
 *
 * 🔴 桌台卡片係 `<button>`，`textContent` ＝「`A01`」＋區域＋「`已坐 0/—`」＋狀態
 * （例：`A011樓已坐 0/—空閒`）⇒ 上面嘅 `click()` 用 exact match **永遠撳唔到**
 * （2026-10-08 實測 `clickA01=false`，連帶 12／13 都出唔到）。
 */
async function clickStartsWith(page, prefix) {
  return await page.evaluate((p) => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => {
      const s = (x.textContent || "").replace(/\s+/g, "").trim();
      return s.startsWith(p) && x.getBoundingClientRect().height > 0;
    });
    if (b) { b.click(); return true; }
    return false;
  }, prefix);
}

/**
 * 撳 `<button>`：textContent **符合其中一個 regex**。
 *
 * 用於「文字前面仲有品名／價錢」嘅卡片掣，例如菜品卡＝`叉燒飯MOP48加入`
 * ⇒ `clickRegex(["加入$"])`。
 */
async function clickRegex(page, patterns) {
  return await page.evaluate((ps) => {
    const res = ps.map((p) => new RegExp(p));
    const b = Array.from(document.querySelectorAll("button")).find((x) => {
      const s = (x.textContent || "").replace(/\s+/g, "").trim();
      return res.some((r) => r.test(s)) && x.getBoundingClientRect().height > 0;
    });
    if (b) { b.click(); return true; }
    return false;
  }, patterns);
}

/**
 * 量頁面所有「被裁字」嘅細節。
 *
 * 🔴 唔可以用 `getComputedStyle` 逐個查 —— `/pos` 有幾千個 DOM 節點，
 * 每次 `getComputedStyle` 都係同步 layout 計算 ⇒ 頁面大時會 **>120s** 直接
 * 觸發 navigation timeout（2026-10-08 實測）。改用純幾何 + 數量上限。
 */
async function measureClip(page) {
  return await page.evaluate(() => {
    const bad = [];
    const all = document.querySelectorAll("span,div,button,a,td,th,label");
    const n = Math.min(all.length, 800); // 限量：頭 800 個夠覆蓋 navbar / header
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (el.children.length > 0) continue;
      const s = (el.textContent || "").trim();
      if (!s || s.length > 30) continue;
      if (el.clientWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        // 🔴 排除**刻意**裁：`truncate`（`text-overflow: ellipsis`）本身就會
        //    scrollWidth > clientWidth，係設計唔係 bug（例：訂單卡嘅品項摘要）。
        //    幾何篩選先行（平），只對少量入圍者查 computedStyle（貴）—— 保住效能。
        if (getComputedStyle(el).textOverflow === "ellipsis") continue;
        bad.push({ t: s, sw: el.scrollWidth, cw: el.clientWidth });
      }
    }
    return bad.slice(0, 12);
  });
}

async function enterWorkbench(page, lang) {
  const ok = await click(page, "堂食收銀台", "Dine-in register");
  await sleep(5500);
  return ok;
}

/** 開頁（包 try：某頁 compile 失敗唔應該炸成輪） */
async function open(page, path) {
  try {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
    return true;
  } catch (e) {
    console.log(`  ❌ goto ${path}: ${e.message.slice(0, 100)}`);
    return false;
  }
}

/**
 * 只做一個 step 就 exit（用 `node tools/_i18n-shots2.mjs <step>` 逐個跑）。
 *
 * 🔴 點解要咁：dev server 首次 compile `/pos`（8670 行 + 圖片）要 >2 分鐘，
 * 一個慢頁會拖死成輪、甚至觸發 protocolTimeout。
 * 逐個 process 跑 = 每個 step 有自己嘅 timeout，掛咗只掛嗰個。
 */
const ONLY = process.argv[2] || null;
const ONLY_LANG = process.argv[3] || null;
const wantStep = (id) => !ONLY || ONLY === id;
const wantLang = (l) => !ONLY_LANG || ONLY_LANG === l;

/** 統一流程：截圖 + 量裁字 + 抽可見文字（只抽有中文嘅，用嚟搵漏翻譯） */
async function shotAndReport(page, name, lang, note = "") {
  try {
    await page.screenshot({ path: `${OUT}/${name}-${lang}.png` });
    const clip = await measureClip(page);
    /**
     * ⚠️ 預設只出頭 6 行（console 太長睇唔到）。
     * 但「頭 6 行」會令下面嘅漏翻譯**完全隱形** —— 做 i18n 清尾時
     * 一定要 `I18N_CJK_ALL=1` 睇全量，否則會以為已經清完（2026-10-08 實測）。
     */
    const cjkLimit = process.env.I18N_CJK_ALL ? 0 : 6;
    const cjk = await page.evaluate((limit) => {
      const t = document.body.innerText || "";
      // 搵仍然含中文嘅行（排除純數字/符號）
      const lines = t.split("\n").map((s) => s.trim()).filter((s) => /[一-鿿]/.test(s));
      return limit > 0 ? lines.slice(0, limit) : lines;
    }, cjkLimit);
    console.log(`\n### ${name} [${lang}] ${note}`);
    console.log("  clip:", JSON.stringify(clip));
    console.log(
      `  中文殘留${cjkLimit ? `(前${cjkLimit}行)` : `(全部 ${cjk.length} 行)`}:`,
      JSON.stringify(cjk),
    );
  } catch (e) {
    console.log(`\n### ${name} [${lang}] ${note}  ❌ ${e.message.slice(0, 120)}`);
  }
}

// ─────────────────────────────────────────────
// 1. 收銀台：桌台總覽
// ─────────────────────────────────────────────
if (wantStep("pos")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang);
  await open(page, "/pos");
  await sleep(8000);
  const w = await enterWorkbench(page, lang);
  await shotAndReport(page, "10-pos-tables", lang, `workbench=${w}`);
  await page.close();
}

// ─────────────────────────────────────────────
// 2. 收銀台：已開枱嘅單（點 A01 落單）
// ─────────────────────────────────────────────
if (wantStep("order")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang, { width: 1280, height: 900 }, true);
  await open(page, "/pos");
  await sleep(8000);
  await enterWorkbench(page, lang);
  // 🔴 桌卡係 <button>，textContent ＝ 枱名＋區域＋「已坐 N/—」＋狀態
  //    ⇒ 一定要用 prefix 匹配（見 clickStartsWith 註解）。
  const t = await clickStartsWith(page, "A01");
  await sleep(3000);
  // 🔴 空閒枱唔會直接入點餐介面：先彈「開桌」窗揀入座人數，撳「開桌」先確認。
  const opened = await click(page, "開桌", "Open table");
  await sleep(4500);
  await shotAndReport(page, "11-pos-order-a01", lang, `clickA01=${t} openTable=${opened}`);
  // 加一個菜品：菜品卡 = 「品名＋價錢＋加入」⇒ 用 regex 收尾匹配
  const add = await clickRegex(page, ["加入$", "Add$"]);
  await sleep(2500);
  await shotAndReport(page, "12-pos-menu-panel", lang, `addItem=${add}`);
  // 🔴 一定要先「下單」（送廚房）：結帳閘 `resolveSettleTargetOrder()` 只認
  //    `sent_to_kitchen` / `reopened` / 已付款線上單；未落單撳「去結帳」只會彈提示，
  //    截圖會同 12 一模一樣（2026-10-08 實測）。
  const sent = await click(page, "下單", "Place order");
  await sleep(4000);
  // 結帳掣
  const pay = await click(page, "去結帳", "Go to checkout");
  if (pay) { await sleep(3000); await shotAndReport(page, "13-pos-checkout", lang, `send=${sent} checkout`); }
  else console.log(`  (${lang}) 搵唔到結帳掣`);
  await page.close();
}

// ─────────────────────────────────────────────
// 3. 訂單頁（線上 + 線下）
// ─────────────────────────────────────────────
if (wantStep("orders")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang);
  await open(page, "/orders");
  await sleep(8000);
  await shotAndReport(page, "20-orders", lang);
  await page.close();
}

// ─────────────────────────────────────────────
// 4. 交班頁
// ─────────────────────────────────────────────
if (wantStep("shift")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang);
  await open(page, "/shift");
  await sleep(9000);
  await shotAndReport(page, "30-shift", lang);
  await page.close();
}

// ─────────────────────────────────────────────
// 5. 報表頁
// ─────────────────────────────────────────────
if (wantStep("reports")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang);
  await open(page, "/reports");
  await sleep(9000);
  await shotAndReport(page, "40-reports", lang);
  await page.close();
}

// ─────────────────────────────────────────────
// 6. 設置頁 —— 逐個 tab
// ─────────────────────────────────────────────
const SETTINGS_TABS = [
  { file: "50-settings", zh: "打印機", en: "Printer" },
  { file: "51-settings-menu", zh: "菜單", en: "Menu" },
  { file: "52-settings-floors", zh: "樓層與桌台", en: "Floors & tables" },
  { file: "53-settings-payment", zh: "支付方式", en: "Payment methods" },
  { file: "54-settings-online", zh: "線上接單", en: "Online orders" },
  { file: "55-settings-qr", zh: "掃碼點餐", en: "QR self-order" },
];
if (wantStep("settings")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang);
  await open(page, "/settings");
  await sleep(8500);
  for (const tab of SETTINGS_TABS) {
    const ok = await click(page, tab.zh, tab.en);
    await sleep(2200);
    await shotAndReport(page, tab.file, lang, `tab=${ok}`);
  }
  // 語言切換區（scroll 落去）
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div"))
      .find((d) => ["介面語言", "Interface language", "UILanguage"].includes((d.textContent || "").replace(/\s+/g, "").trim()));
    if (el) { el.scrollIntoView({ block: "center" }); }
  });
  await sleep(900);
  await shotAndReport(page, "56-settings-language", lang);
  await page.close();
}

// ─────────────────────────────────────────────
// 7. 會員 / 庫存 / 沽清（側欄其餘入口）
// ─────────────────────────────────────────────
if (wantStep("misc")) for (const [file, path] of [["60-members", "/members"], ["61-inventory", "/inventory"], ["62-soldout", "/soldout"]]) {
  for (const lang of ["zh-Hant", "en"]) {
    if (!wantLang(lang)) continue;
    const page = await newPage(lang);
    await open(page, path);
    await sleep(8500);
    await shotAndReport(page, file, lang, path);
    await page.close();
  }
}

// ─────────────────────────────────────────────
// 8. 移動底欄（390×844）
// ─────────────────────────────────────────────
if (wantStep("mobile")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  const page = await newPage(lang, { width: 390, height: 844 });
  await open(page, "/pos");
  await sleep(8000);
  await enterWorkbench(page, lang);
  await shotAndReport(page, "70-mobile-pos", lang);
  const hOver = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    innerW: window.innerWidth,
    lgMatches: window.matchMedia("(min-width: 1024px)").matches,
    // 🔴 用嚟分辨「390px 佈局真係爛」定係「harness 冇套 mobile 模擬」
    grids: Array.from(document.querySelectorAll(".grid"))
      .slice(0, 6)
      .map((g) => getComputedStyle(g).gridTemplateColumns),
  }));
  console.log(`  [${lang}] 390px scrollW=${hOver.scrollW} clientW=${hOver.clientW} innerW=${hOver.innerW} lg=${hOver.lgMatches}`);
  console.log(`  [${lang}] grid-cols: ${JSON.stringify(hOver.grids)}`);
  await page.close();
}

// ─────────────────────────────────────────────
// 9. 窄屏掃描（390×844）：逐 route 搵「被榨死」元素
// ─────────────────────────────────────────────
// 用途：`flex-nowrap` ＋ grid `auto` 欄呢種「保證唔掉行」嘅寫法，
// 喺英文（一定比中文長）之下會榨死左邊欄。2026-10-08 就係咁樣喺桌台總覽捉到。
// 呢個 step 一次掃全部 route，有問題先出圖（`narrow-2026-10-08/`）。
const SWEEP_ROUTES = [
  ["pos", "/pos", true],
  ["orders", "/orders", false],
  ["shift", "/shift", false],
  ["reports", "/reports", false],
  ["settings", "/settings", false],
  ["members", "/members", false],
  ["inventory", "/inventory", false],
  ["soldout", "/soldout", false],
];
if (wantStep("sweep")) for (const lang of ["zh-Hant", "en"]) {
  if (!wantLang(lang)) continue;
  for (const [name, path, needWorkbench] of SWEEP_ROUTES) {
    const page = await newPage(lang, { width: 390, height: 844 });
    if (!(await open(page, path))) { await page.close(); continue; }
    await sleep(8000);
    if (needWorkbench) await enterWorkbench(page, lang);
    const clip = await measureClip(page);
    const over = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    const bad = clip.length > 0 || over.scrollW > over.clientW + 1;
    console.log(
      `  [${lang}] ${name.padEnd(10)} clip=${JSON.stringify(clip)} ` +
        `scrollW=${over.scrollW}/${over.clientW} ${bad ? "❌" : "✅"}`,
    );
    // 預設只出「有問題」嘅圖；`I18N_SWEEP_SAVE=all` 就連正常嘅都出（做窄屏中英對照全套）。
    if (bad || process.env.I18N_SWEEP_SAVE === "all") {
      const dir = `${OUT}/narrow-2026-10-08`;
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${name}-${lang}.png` });
    }
    await page.close();
  }
}

console.log("\n=== 真 ERRORS (" + errors.length + ") ===");
console.log(errors.slice(0, 25).join("\n") || "(冇)");
await browser.close();