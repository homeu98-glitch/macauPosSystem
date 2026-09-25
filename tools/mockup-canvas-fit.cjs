// 確認稿（固定畫布 mockup）畫布貼合量度器 —— 只量度、唔一定截圖。
//
// 為什麼唔直接用 skill 嘅 check-canvas-fit.js：
//   佢量完會 `el.screenshot()`，而主頁籤切換係 `display:none → flex`，
//   一旦切換／量度之間有時序差就會拋 "Node is either not visible" ⇒ **中途中斷**，
//   後面幾個畫面完全冇量到（但 exit code 只係 1，好易誤判）。
//   本腳本逐個畫面重新 goto()＋click()，唔截圖，跑得完亦唔會拋。
//
// 用法：
//   NODE_PATH=<managed node workspace>/node_modules \
//   node tools/mockup-canvas-fit.cjs docs/mockups/xxx.html [--shots] [--out <dir>]
//
// 檢查三件事：① 每個畫面內嘅捲動容器有冇溢出（內容被切）② 有冇元素超出畫布邊界
//             ③ `--shots` 會逐個畫面元素截圖（唔用 page.screenshot，避免視窗高度切邊）
// exit code：0 = 全部通過；2 = 有畫面要修（修法係加高畫布或減內容，唔係加 overflow）。
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error("用法: node tools/mockup-canvas-fit.cjs <mockup.html> [--shots] [--out <dir>]");
  process.exit(1);
}
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(os.tmpdir(), "mockup-fit-" + Date.now());
const wantShots = args.includes("--shots");

(async function () {
  const puppeteer = require("puppeteer-core");
  const url = "file:///" + path.resolve(file).replace(/\\/g, "/");

  const browser = await puppeteer.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1320, height: 1060, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "load" });

  const screens = await page.evaluate(function () {
    const tabs = document.querySelectorAll("[data-tab]");
    const ids = [];
    for (let i = 0; i < tabs.length; i++) ids.push(tabs[i].getAttribute("data-tab"));
    return ids;
  });

  let bad = 0;
  for (const id of screens) {
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(function (sid) {
      const b = document.querySelector('[data-tab="' + sid + '"]');
      if (b) b.click();
    }, id);
    await new Promise(function (r) { setTimeout(r, 150); });

    const r = await page.evaluate(function (sid) {
      const canvas = document.querySelector(".canvas") || document.body;
      const cr = canvas.getBoundingClientRect();
      const scale = cr.width / canvas.offsetWidth || 1;
      const scroll = [];
      const over = [];
      const nodes = document.querySelectorAll("#" + sid + " *");
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        // ⚠️ 只計真正嘅捲動容器：overflow:visible 嘅 ink 邊界超出唔算問題
        if ((oy === "auto" || oy === "scroll" || oy === "hidden") && el.scrollHeight - el.clientHeight > 1) {
          scroll.push({ el: String(el.className || el.id).slice(0, 34), over: el.scrollHeight - el.clientHeight });
        }
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) {
          const right = (b.right - cr.left) / scale;
          const bottom = (b.bottom - cr.top) / scale;
          if (right > canvas.offsetWidth + 1 || bottom > canvas.offsetHeight + 1) {
            over.push({ el: String(el.className || el.id).slice(0, 34), right: Math.round(right), bottom: Math.round(bottom) });
          }
        }
      }
      return { canvas: [canvas.offsetWidth, canvas.offsetHeight], scale: scale, scroll: scroll, over: over.slice(0, 8) };
    }, id);

    console.log("=== " + id + " （畫布 " + r.canvas.join("x") + "・scale " + r.scale.toFixed(3) + "）");
    console.log("  捲動容器溢出 : " + (r.scroll.length ? "✘ " + JSON.stringify(r.scroll) : "零 ✔"));
    console.log("  超出畫布邊界 : " + (r.over.length ? "✘ " + JSON.stringify(r.over) : "零 ✔"));
    if (r.scroll.length || r.over.length) bad++;

    if (wantShots) {
      fs.mkdirSync(outDir, { recursive: true });
      const el = await page.$("#" + id);
      if (el) await el.screenshot({ path: path.join(outDir, id + ".png") });
    }
  }

  await browser.close();
  if (wantShots) console.log("shots: " + outDir);
  console.log(bad === 0 ? "全部畫面：零滾動 / 零超出畫布 ✔" : "有 " + bad + " 個畫面要修（加高畫布或減內容，唔係加 overflow）");
  process.exit(bad === 0 ? 0 : 2);
})().catch(function (e) {
  console.error("ERR " + e.message);
  process.exit(1);
});
