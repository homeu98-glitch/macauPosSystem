const path = require("path");
const puppeteer = require("puppeteer-core");

const FILE = process.argv[2];
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => require("fs").existsSync(p));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--allow-file-access-from-files"],
    defaultViewport: { width: 1400, height: 1300 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("file:///" + path.resolve(FILE).replace(/\\/g, "/"), { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300));

  const snap = () =>
    page.evaluate(() => {
      const rows = document.querySelectorAll("#scroll tbody tr");
      let dataRows = 0;
      rows.forEach((r) => {
        if (!r.classList.contains("dayrow")) dataRows++;
      });
      return {
        info: document.getElementById("pinfo").textContent.trim(),
        days: document.querySelectorAll("#scroll tbody tr.dayrow").length,
        dataRows,
        buttons: Array.from(document.querySelectorAll("#pright button")).map(
          (b) => b.textContent.trim() + (b.disabled ? "[disabled]" : ""),
        ),
      };
    });

  const a = await snap();
  console.log("初始      :", JSON.stringify(a, null, 0));

  await page.click("#moreBtn");
  await new Promise((r) => setTimeout(r, 250));
  const b = await snap();
  console.log("撳查看更多:", JSON.stringify(b, null, 0));

  await page.click("#lessBtn");
  await new Promise((r) => setTimeout(r, 250));
  const c = await snap();
  console.log("撳收起    :", JSON.stringify(c, null, 0));

  await page.select("#emp", "陳小明");
  await new Promise((r) => setTimeout(r, 250));
  const d = await snap();
  console.log("篩員工    :", JSON.stringify(d, null, 0));

  const pass =
    a.days === 10 &&
    b.days === 20 &&
    c.days === 10 &&
    d.days <= 10 &&
    a.buttons.some((s) => s.indexOf("查看更多") === 0) &&
    b.buttons.some((s) => s.indexOf("收起") === 0);
  console.log(pass ? "\n✅ 分頁 / 查看更多 / 收起 / 篩選 全部行為正常" : "\n❌ 有行為唔符合預期");
  await browser.close();
  process.exit(pass ? 0 : 2);
})();
