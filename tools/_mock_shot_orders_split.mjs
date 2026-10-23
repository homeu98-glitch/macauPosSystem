// 一次性：把左右分欄 mockup 三個 tab 截圖，用嚟自檢排版
const { default: puppeteer } = await import(
  "file:///C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
);
import fs from "node:fs";

const FILE = "file:///C:/dev/macauPos/macauPosSystem/docs/mockups/orders-left-right-split-2026-10-23.html";
const OUT = "C:/dev/macauPos/macauPosSystem/docs/mockups/orders-left-right-split-2026-10-23";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--allow-file-access-from-files", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 1000, deviceScaleFactor: 1 });
await page.goto(FILE, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 500));

for (const tab of ["before", "after", "collapse"]) {
  await page.evaluate((t) => window.showTab(t), tab);
  await new Promise((r) => setTimeout(r, 250));
  const el = await page.$("#device");
  await el.screenshot({ path: `${OUT}/${tab}.png` });
  const full = await page.$("#stage");
  await full.screenshot({ path: `${OUT}/${tab}-stage.png` });
}

await browser.close();
console.log("done");
