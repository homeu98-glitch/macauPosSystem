// tools/verify-pos-app-split.cjs
//
// pos-app.tsx 分拆重構的【UI 回歸測試】—— 真 Chromium（puppeteer-core）+ localStorage 種子，
// 唔需要 Supabase / Ledger 後端。用法見 docs/reviews/pos-app-split-plan-2026-09-15.md 階段 0。
//
// 跑法（先開 dev server）：
//   NODE_PATH=C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules \
//   node tools/verify-pos-app-split.cjs --port 3017 --out docs/mockups/<folder>
//
// 退出碼：0 = 全部通過；1 = 有失敗（逐項列出）。
// 🔴 分拆前後都要跑同一支腳本，結果必須一致 —— 呢個就係「行為等價」嘅證據。
//
// ⚠️ 已知限制（實測，唔係 bug）：
//   dev 冇 Supabase 時，`/api/pos/bootstrap` 會回 mock 並覆寫 localStorage 種子
//   ⇒ 畫面係 **mock 資料**（3 張枱 A01/A02/A03、類別 飯類/粉麵/飲品、商品為空）。
//   所以斷言一律針對「結構 / 幾何 / 流程」，唔針對種子內容 —— 反而更穩定。
//   商品為空 ⇒ 購物車加減掣唔會出現；斷言寫成「若存在則必須 ≥40px」。

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = { port: "3017", out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = args.port;
const BASE = `http://localhost:${PORT}`; // 🔴 localhost，唔可以 127.0.0.1（Next 16 dev 會 403）
const OUT = args.out || path.join("docs", "mockups", `pos-app-split-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(OUT, { recursive: true });

const MID = "66123456";

// 種子：`offline-mode=1` 唔等後端；`shift` 已開工（{} = 未開工，會被「今日未開工」彈窗擋住）
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
      { id: "t-a02", name: "A02", area: "大堂", capacity: 4 },
      { id: "t-b01", name: "B01", area: "貴賓房", capacity: 8 },
    ],
    menuItems: [],
    categories: [],
    rules: { serviceChargeRate: 0, taxRate: 0 },
  }),
  [`macau-pos/stores/${MID}/orders`]: "[]",
  [`macau-pos/stores/${MID}/print-jobs`]: "[]",
  [`macau-pos/stores/${MID}/local-settings`]: JSON.stringify({}),
  [`macau-pos/stores/${MID}/device-config`]: JSON.stringify({ printers: [] }),
  [`macau-pos/stores/${MID}/sold-out`]: "[]",
  [`macau-pos/stores/${MID}/sync-queue`]: "[]",
  [`macau-pos/stores/${MID}/shift`]: JSON.stringify({ openedAt: new Date().toISOString() }),
  "macau-pos/offline-mode": "1",
};

// 基線（2026-09-15 實測，分拆前）：容差見各項
const BASELINE = { tableCards: 3, headerHeight: 71, headerHeightTolerance: 8 };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? `   → ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = require("puppeteer-core");
  const exe = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!fs.existsSync(exe)) {
    console.error(`❌ 找不到 Chrome：${exe}`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({ executablePath: exe, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 820 }); // iPad 橫向

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.evaluateOnNewDocument((d) => {
    for (const k in d) localStorage.setItem(k, d[k]);
  }, seed);

  console.log(`\n=== pos-app 回歸基線 @ ${BASE} ===\n`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(9000); // 首次 hydrate 要等

  const g = (fn) => page.evaluate(fn);

  const boot = await g(() => ({
    url: location.pathname,
    body: document.body.innerText,
    header: (() => {
      const el = document.querySelector("header") || document.querySelector("main > div");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    tableCards: Array.from(document.querySelectorAll("button")).filter((b) => /已坐\s*\d+\//.test(b.textContent || "")).length,
  }));

  check("已過 AuthGuard（停留喺 /）", boot.url === "/");
  check("唔會卡喺 ClientOnly fallback", !boot.body.includes("正在載入頁面"));
  check("唔會卡喺「正在載入門店設定」", !boot.body.includes("正在載入門店設定"));
  check("冇「今日未開工」彈窗（已開工種子生效）", !boot.body.includes("今日未開工"));
  check(
    `桌台卡數量 = ${BASELINE.tableCards}`,
    boot.tableCards === BASELINE.tableCards,
    `實測 ${boot.tableCards}`,
  );
  check(
    `標題列高度 ≈ ${BASELINE.headerHeight}（±${BASELINE.headerHeightTolerance}，未爆行）`,
    boot.header && Math.abs(boot.header.h - BASELINE.headerHeight) <= BASELINE.headerHeightTolerance,
    boot.header ? `${boot.header.w}×${boot.header.h}` : "找不到",
  );
  await page.screenshot({ path: path.join(OUT, "01-tables.png") });

  // 撳第一張枱 → 開桌彈窗
  await g(() => {
    const card = Array.from(document.querySelectorAll("button")).find((b) => /已坐\s*\d+\//.test(b.textContent || ""));
    if (card) card.click();
  });
  await sleep(1200);
  const modal = await g(() => ({
    body: document.body.innerText,
    partyBtns: Array.from(document.querySelectorAll("button")).filter((b) => /^\d+$/.test((b.textContent || "").trim())).length,
  }));
  check("撳枱後出現「開桌」彈窗（含入座人數）", modal.body.includes("入座人數") || modal.body.includes("開桌"), `人數掣 ${modal.partyBtns} 個`);
  check("入座人數快速掣 ≥ 10 個", modal.partyBtns >= 10, `實測 ${modal.partyBtns}`);
  await page.screenshot({ path: path.join(OUT, "02-open-table-modal.png") });

  // 揀人數 2 → 開桌
  await g(() => {
    const pick = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "2");
    if (pick) pick.click();
  });
  await sleep(300);
  await g(() => {
    const ok = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "開桌");
    if (ok) ok.click();
  });
  await sleep(2000);

  const order = await g(() => {
    const btns = Array.from(document.querySelectorAll("button")).map((b) => ({
      t: (b.textContent || "").trim().replace(/\s+/g, " "),
      h: Math.round(b.getBoundingClientRect().height),
    }));
    return {
      body: document.body.innerText,
      hasBack: btns.some((b) => b.t === "返回桌台"),
      hasSubmit: btns.some((b) => b.t === "下單"),
      hasCheckout: btns.some((b) => b.t === "去結帳"),
      submitH: (btns.find((b) => b.t === "下單") || {}).h || 0,
      checkoutH: (btns.find((b) => b.t === "去結帳") || {}).h || 0,
      qtyBtns: btns.filter((b) => ["+", "-"].includes(b.t)).map((b) => b.h),
    };
  });

  check("開桌後進入點餐介面（有「返回桌台」）", order.hasBack);
  check("點餐介面有「訂單明細」區", order.body.includes("訂單明細"));
  check("有「下單」掣", order.hasSubmit, `高 ${order.submitH}px`);
  check("有「去結帳」掣", order.hasCheckout, `高 ${order.checkoutH}px`);
  check("主要動作掣 ≥ 40px", order.submitH >= 40 && order.checkoutH >= 40, `下單 ${order.submitH} / 去結帳 ${order.checkoutH}`);
  check(
    "購物車加減掣：若存在則 ≥ 40px",
    order.qtyBtns.every((h) => h >= 40),
    order.qtyBtns.length ? order.qtyBtns.join(",") : "（mock 無商品 ⇒ 未出現，屬正常）",
  );
  await page.screenshot({ path: path.join(OUT, "03-ordering.png") });

  // 回桌台：流程可逆（分拆最易整壞嘅位）
  await g(() => {
    const back = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "返回桌台");
    if (back) back.click();
  });
  await sleep(1200);
  const backOk = await g(() => ({
    body: document.body.innerText,
    cards: Array.from(document.querySelectorAll("button")).filter((b) => /已坐\s*\d+\//.test(b.textContent || "")).length,
  }));
  check("可以「返回桌台」回到桌台總覽", backOk.body.includes("桌台總覽") && backOk.cards === BASELINE.tableCards, `枱卡 ${backOk.cards}`);

  // 全域不變量
  check("冇 pageerror", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  check(
    "冇無限 re-render（Maximum update depth）",
    !consoleErrors.some((t) => /Maximum update depth/i.test(t)),
  );

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 結果：${results.length - failed.length}/${results.length} 通過 ===`);
  if (failed.length) for (const f of failed) console.log(`  ❌ ${f.name}  ${f.detail}`);
  fs.writeFileSync(
    path.join(OUT, "assertions.json"),
    JSON.stringify({ at: new Date().toISOString(), baseline: BASELINE, results, pageErrors, consoleErrors: consoleErrors.slice(0, 20) }, null, 2),
  );
  console.log(`已寫入 ${OUT}/assertions.json`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("驗證腳本拋錯：", e);
  process.exit(1);
});
