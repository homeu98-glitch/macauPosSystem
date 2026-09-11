/**
 * 全畫面版面驗證：對每個 tab（＋後廚屏每個工位）量度卡片 bounding box，
 * 檢測有無互相重疊、有無元素被容器裁切。
 *
 * 用法： NODE_PATH=<ws>/node_modules node tools/2026-09-11-verify-kds-screens.js <file.html>
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const abs = path.resolve(process.argv[2]);
const shotDir = path.resolve(__dirname, "_shots");
fs.mkdirSync(shotDir, { recursive: true });
const base = path.basename(abs, ".html");

const VIEWS = [
  { name: "登入", tab: "login" },
  { name: "揀崗位", tab: "pick" },
  // 崗位係鎖喺設備度，所以要先撳揀崗位卡，再入後廚屏
  { name: "後廚-廚房", tab: "pick", drives: ['.pcard[data-st="kitchen"]'] },
  { name: "後廚-水吧", tab: "pick", drives: ['.pcard[data-st="drinks"]'] },
  { name: "設定卡", tab: "pick", drives: ['.pcard[data-st="kitchen"]', "#kSetBtn"] },
  { name: "出餐台屏", tab: "expo" },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--allow-file-access-from-files"],
    defaultViewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto("file:///" + abs.replace(/\\/g, "/"), { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300));

  let bad = 0;

  for (const v of VIEWS) {
    await page.evaluate((v) => {
      const tb = document.querySelector('.review .tabs button[data-tab="' + v.tab + '"]');
      if (tb) tb.click();
    }, v);
    await new Promise((r) => setTimeout(r, 200));
    for (const d of v.drives || []) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.click();
      }, d);
      await new Promise((r) => setTimeout(r, 220));
    }
    await new Promise((r) => setTimeout(r, 250));

    const r = await page.evaluate(() => {
      // 每個畫面嘅「卡片」容器：後廚 article.card / 出餐台 .qi,.rline,.bigbtn / 登入 .lmode,.ldev
      const sel = "#v-kitchen .card, #v-expo .qi, #v-expo .rline, #v-expo .bigbtn, " +
        "#v-login .modes button, #v-login .ldev, #v-pick .pcard";
      const els = Array.from(document.querySelectorAll(sel)).filter((e) => e.offsetParent !== null);
      const boxes = els.map((e) => {
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          tag: e.className.split(/\s+/)[0],
          label: (e.textContent || "").trim().slice(0, 14),
          l: b.left, t: b.top, r: b.right, bo: b.bottom,
          ow: e.scrollWidth - e.clientWidth,
          oh: e.scrollHeight - e.clientHeight,
          vis: cs.visibility, op: cs.opacity,
        };
      });
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const oy = Math.min(a.bo, b.bo) - Math.max(a.t, b.t);
          if (ox > 1 && oy > 1)
            overlaps.push(`${a.label} ↔ ${b.label} (${Math.round(ox)}×${Math.round(oy)})`);
        }
      return { n: boxes.length, overlaps, boxes };
    });

    const clipped = r.boxes.filter((b) => b.oh > 1).map((b) => `${b.label || b.tag} 內容溢出 ${b.oh}px`);
    const status = r.overlaps.length || clipped.length ? "❌" : "✅";
    if (r.overlaps.length || clipped.length) bad++;
    console.log(`${status} ${v.name.padEnd(10)} 元素 ${String(r.n).padStart(2)} 個` +
      (r.overlaps.length ? `\n     重疊: ${r.overlaps.join("; ")}` : "") +
      (clipped.length ? `\n     溢出: ${clipped.join("; ")}` : ""));

    if (v.tab !== "login") {
      const el = await page.$("#canvas");
      if (el) await el.screenshot({ path: path.join(shotDir, `${base}--${v.name}.png`) });
    }
  }

  console.log(bad ? `\n結果：${bad} 個畫面有問題` : "\n結果：全部畫面版面正常");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
