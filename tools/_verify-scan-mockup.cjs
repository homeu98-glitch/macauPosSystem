// 掃碼點餐確認稿驗收：逐手機截圖 + 溢出/裁切檢測（只量度、唔截圖以外都做）
const path = require("path");
const puppeteer = require("puppeteer-core");

const FILE = "file:///" + path.resolve(process.argv[2]).replace(/\\/g, "/");
const OUT = process.argv[3];
const SEL = process.argv[4] || "#ph1,#ph2,#ph3,#ph4,#ph5,.notes";

(async () => {
  const fs = require("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-sandbox", "--force-device-scale-factor=1"],
    defaultViewport: { width: 1420, height: 1000 },
  });
  const page = await browser.newPage();
  await page.goto(FILE, { waitUntil: "load" });
  await page.evaluate(() => {
    const c = document.getElementById("canvas");
    if (c) c.style.transform = "none"; // 量度/截圖用 1:1，唔駛縮
  });
  await new Promise((r) => setTimeout(r, 250));

  const ids = SEL.split(",");
  let bad = 0;
  for (const id of ids) {
    const name = id.replace(/[#.]/g, "");
    const r = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { err: "not found: " + sel };
      const er = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cut = el.scrollHeight - el.clientHeight; // overflow:hidden 容器内容高出 = 被切
      // 任何後代右／下／左／上超出容器 3px 以上
      let over = [];
      el.querySelectorAll("*").forEach((d) => {
        const b = d.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) return;
        const dx = Math.max(er.left - b.left, b.right - er.right, 0);
        const dy = Math.max(er.top - b.top, b.bottom - er.bottom, 0);
        if (dx > 3 || dy > 3) over.push(d.className + " +" + Math.round(dx) + "/" + Math.round(dy));
      });
      // 內部滾動容器若有 overflow-y 都列出（資訊用）
      const scrollers = [];
      el.querySelectorAll("*").forEach((d) => {
        const oy = getComputedStyle(d).overflowY;
        if ((oy === "auto" || oy === "scroll") && d.scrollHeight - d.clientHeight > 1) {
          scrollers.push((d.className || d.id) + ":" + (d.scrollHeight - d.clientHeight));
        }
      });
      return { w: Math.round(er.width), h: Math.round(er.height), cut, over: over.slice(0, 6), scrollers: scrollers.slice(0, 6), oy: cs.overflowY };
    }, id);
    const shot = path.join(OUT, name + ".png");
    const el = await page.$(id);
    if (el) await el.screenshot({ path: shot });
    const flag = r.err || r.cut > 1 || r.over.length ? "✘" : "✔";
    if (flag === "✘") bad++;
    console.log(flag, id, r.err ? r.err : `size=${r.w}x${r.h} contentOverflow=${r.cut} overflowY=${r.oy}`);
    if (r.over && r.over.length) console.log("   超出:", r.over.join(" | "));
    if (r.scrollers && r.scrollers.length) console.log("   可滾動容器(資訊):", r.scrollers.join(" | "));
    console.log("   截圖:", shot);
  }
  await browser.close();
  console.log(bad === 0 ? "全部 ✔" : `有 ${bad} 格要處理`);
  process.exit(bad === 0 ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
