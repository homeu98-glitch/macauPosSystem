/**
 * 線上訂單反結改價確認稿 —— 量度 + 截圖驗證（一次性工具）
 * 用法：NODE_PATH=<managed node workspace>/node_modules node tools/_verify-online-reopen-mockup.cjs
 * 每個畫面重新 goto() + 撳頁籤，避免上一個畫面嘅 modal 殘留蓋住下一個。
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const HTML = "file:///" + "C:/dev/macauPos/macauPosSystem/docs/mockups/online-order-reopen-reprice-2026-10-19.html".replace(/\\/g, "/");
const OUT = "C:/dev/macauPos/macauPosSystem/docs/mockups/online-reopen-verify-2026-10-19";
const SCREENS = ["scr-flow", "scr-entry", "scr-reopen", "scr-workspace", "scr-settle", "scr-done"];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1280, height: 1000 },
  });
  const page = await browser.newPage();
  let fail = 0;

  for (const sid of SCREENS) {
    await page.goto(HTML, { waitUntil: "load" });
    await page.evaluate((id) => {
      const b = document.querySelector('#rtabs button[data-tab="' + id + '"]');
      if (b) b.click();
    }, sid);
    await new Promise((r) => setTimeout(r, 120));

    const report = await page.evaluate((id) => {
      const wrap = document.getElementById(id);
      const canvas = document.getElementById("canvas");
      const out = { scroll: [], beyond: [], trunc: [], wrapOverflow: 0 };
      const wr = wrap.getBoundingClientRect();
      // screenwrap 本身唔可以滾動：內容超高會靜靜被 canvas 切走
      out.wrapOverflow = wrap.scrollHeight - wrap.clientHeight;
      // 逐個捲動容器：需要滾動 = 內容過高
      wrap.querySelectorAll("*").forEach((el) => {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "hidden") {
          const d = el.scrollHeight - el.clientHeight;
          if (d > 1) out.scroll.push({ sel: el.className || el.tagName, d });
        }
        // 文字截斷（ellipsis 係刻意嘅除外）
        const st = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && st.textOverflow !== "ellipsis" && el.children.length === 0) {
          out.trunc.push({ sel: el.className || el.tagName, d: el.scrollWidth - el.clientWidth, text: (el.textContent || "").slice(0, 24) });
        }
      });
      // 任何元素超出畫布邊界（缩放下嘅 rect，除以 scale）
      const cr = canvas.getBoundingClientRect();
      const scale = cr.width / 1180 || 1;
      wrap.querySelectorAll("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const right = (r.right - cr.left) / scale;
        const bottom = (r.bottom - cr.top) / scale;
        if (right > 1181 || bottom > 821) {
          out.beyond.push({ sel: (el.className || el.tagName).toString().slice(0, 40), right: Math.round(right), bottom: Math.round(bottom) });
        }
      });
      return out;
    }, sid);

    const problems = [];
    if (report.wrapOverflow > 1) problems.push(`畫面本身溢出 ${report.wrapOverflow}px（會被畫布切走）`);
    if (report.scroll.length) problems.push(`需要滾動: ${report.scroll.map((s) => `${s.sel}+${s.d}`).join(", ")}`);
    if (report.trunc.length) problems.push(`文字截斷: ${report.trunc.map((s) => `${s.sel}+${s.d}:"${s.text}"`).join(", ")}`);
    if (report.beyond.length) problems.push(`超出畫布: ${report.beyond.slice(0, 5).map((s) => `${s.sel}@${s.right},${s.bottom}`).join(", ")}`);

    const el = await page.$("#" + sid);
    const shot = path.join(OUT, `scr-${sid}.png`);
    await el.screenshot({ path: shot });
    console.log(`${problems.length ? "✘" : "✓"} ${sid} ${problems.length ? problems.join(" | ") : "乾淨"} → ${path.basename(shot)}`);
    if (problems.length) fail++;
  }

  // 差額處理分派器：逐個選項撳落去，驗證 diffout 文案真的切換
  await page.goto(HTML, { waitUntil: "load" });
  await page.evaluate(() => document.querySelector('#rtabs button[data-tab="scr-settle"]').click());
  const texts = [];
  for (const k of ["diff-topup", "diff-cash", "diff-none"]) {
    const t = await page.evaluate((key) => {
      const b = document.querySelector('#scr-settle [data-k="' + key + '"]');
      b.click();
      const out = document.querySelector("#scr-settle .diffout");
      const on = document.querySelector('#scr-settle .opt.on');
      return { text: out ? out.textContent.slice(0, 18) : null, onKey: on ? on.getAttribute("data-k") : null };
    }, k);
    texts.push(`${k} → ${t.onKey} | ${t.text}`);
  }
  const okDispatch = texts.every((t) => !t.includes("null"));
  console.log(`${okDispatch ? "✓" : "✘"} 差額分派器: ${texts.join(" ; ")}`);
  if (!okDispatch) fail++;

  await browser.close();
  console.log(fail === 0 ? "全部通過" : `${fail} 個畫面有問題`);
  process.exit(fail === 0 ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
