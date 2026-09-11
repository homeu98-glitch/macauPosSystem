/**
 * 用真實 Chromium 量度 KDS 原型嘅版面幾何，找出「卡片重疊／被裁切」嘅真正原因。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/2026-09-11-measure-kds-layout.js <file.html> [tab]
 *
 * 會輸出：
 *   1. .kbody 嘅 computed style（display / grid-template-* / align-*）
 *   2. 每張 .card 嘅 offsetTop / offsetHeight / scrollHeight / clientHeight
 *   3. 兩兩卡片嘅 bounding box 重疊檢測
 *   4. 一張 screenshot 到 tools/_kds-shot.png
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const file = process.argv[2];
const tab = process.argv[3] || "kitchen";
if (!file) {
  console.error("usage: node measure-kds-layout.js <file.html> [tab]");
  process.exit(1);
}
const abs = path.resolve(file);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--allow-file-access-from-files", "--font-render-hinting=none"],
    defaultViewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text());
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto("file:///" + abs.replace(/\\/g, "/"), { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300));

  // 切到指定 tab
  await page.evaluate((t) => {
    const btn = document.querySelector('.review .tabs button[data-tab="' + t + '"]');
    if (btn) btn.click();
  }, tab);
  await new Promise((r) => setTimeout(r, 500));

  const report = await page.evaluate(() => {
    const out = {};
    const body = document.getElementById("kbody");
    if (!body) return { error: "no #kbody" };

    const cs = getComputedStyle(body);
    out.body = {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      gridAutoRows: cs.gridAutoRows,
      alignContent: cs.alignContent,
      alignItems: cs.alignItems,
      gap: cs.gap,
      height: cs.height,
      clientHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      overflowY: cs.overflowY,
    };

    const canvas = document.getElementById("canvas");
    if (canvas) {
      out.canvas = {
        transform: getComputedStyle(canvas).transform,
        rect: canvas.getBoundingClientRect().toJSON(),
        scrollHeight: canvas.scrollHeight,
        clientHeight: canvas.clientHeight,
      };
    }

    const cards = Array.from(body.querySelectorAll(".card"));
    const cb = body.getBoundingClientRect();
    out.cards = cards.map((c) => {
      const r = c.getBoundingClientRect();
      const lines = c.querySelector(".lines");
      return {
        no: (c.querySelector(".ono") || {}).textContent || "?",
        row: Math.round((r.top - cb.top) / 1), // 相對 kbody 頂部
        left: Math.round(r.left - cb.left),
        w: Math.round(r.width),
        h: Math.round(r.height),
        // 內容 vs 盒：scrollHeight > clientHeight 即係被裁切
        boxScrollH: c.scrollHeight,
        boxClientH: c.clientHeight,
        linesH: lines ? lines.getBoundingClientRect().height : null,
        linesScrollH: lines ? lines.scrollHeight : null,
        rect: {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          left: Math.round(r.left),
          right: Math.round(r.right),
        },
      };
    });

    // 兩兩重疊檢測（真正嘅 overlap，唔計純粹貼邊）
    out.overlaps = [];
    for (let i = 0; i < out.cards.length; i++) {
      for (let j = i + 1; j < out.cards.length; j++) {
        const a = out.cards[i].rect, b = out.cards[j].rect;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) {
          out.overlaps.push({
            a: out.cards[i].no, b: out.cards[j].no,
            overlapX: Math.round(ox), overlapY: Math.round(oy),
          });
        }
      }
    }

    // 逐行量度：卡片被 stretch 拉高之後，多出嘅空間有無把行距拉散
    out.lineGeom = cards.map((c) => {
      const cr = c.getBoundingClientRect();
      const ln = Array.from(c.querySelectorAll(".line"));
      return {
        card: (c.querySelector(".ono") || {}).textContent,
        cardH: Math.round(cr.height),
        lines: ln.map((l) => {
          const lr = l.getBoundingClientRect();
          return {
            item: ((l.querySelector(".lname") || {}).textContent || "").trim(),
            top: Math.round(lr.top - cr.top),
            h: Math.round(lr.height),
          };
        }),
        tailGap: ln.length
          ? Math.round(cr.bottom - ln[ln.length - 1].getBoundingClientRect().bottom)
          : null,
      };
    });

    // 逐行檢查 .line 有無被 card 裁掉
    out.clippedLines = [];
    cards.forEach((c) => {
      const cr = c.getBoundingClientRect();
      Array.from(c.querySelectorAll(".line")).forEach((ln) => {
        const lr = ln.getBoundingClientRect();
        if (lr.bottom > cr.bottom + 0.5) {
          out.clippedLines.push({
            card: (c.querySelector(".ono") || {}).textContent,
            item: (ln.querySelector(".lname") || {}).textContent,
            overflowPx: Math.round(lr.bottom - cr.bottom),
          });
        }
      });
    });

    return out;
  });

  console.log(JSON.stringify(report, null, 2));

  fs.mkdirSync(path.join(path.dirname(abs), "..", "tools"), { recursive: true });
  const shotDir = path.resolve(__dirname, "_shots");
  fs.mkdirSync(shotDir, { recursive: true });
  const base = path.basename(abs, ".html");

  const canvasEl = await page.$("#canvas");
  if (canvasEl) {
    await canvasEl.screenshot({ path: path.join(shotDir, base + "-canvas.png") });
    console.log("\n[canvas shot] tools/_shots/" + base + "-canvas.png");
  }
  await page.screenshot({ path: path.join(shotDir, base + "-full.png") });
  console.log("[full shot]   tools/_shots/" + base + "-full.png");

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
