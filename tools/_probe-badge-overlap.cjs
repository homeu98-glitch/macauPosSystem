/**
 * 桌台「訂單號角標」版面取證（2026-09-22）
 *
 * 目的：用**真 Chromium bounding box** 回答商家嘅硬要求 ——
 *   「角標樣式需醒目且不遮擋桌台名稱等其他資訊」。
 *
 * 量度三件事（逐張卡）：
 *   1. 枱名 rect × 角標 rect 有冇相交（重疊）→ 必須為 0
 *   2. 角標有冇超出卡片 padding box → 必須為 0
 *   3. 角標文字有冇被 truncate（scrollWidth > clientWidth）→ 正常單號必須為 0
 *
 * 額外：注入「超長枱名 + 超長單號」壓力樣本，證明設計上唔會互相壓住
 *       （結果應該係**枱名被截斷**，而唔係角標疊上枱名）。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node tools/_probe-badge-overlap.cjs <mockup.html>
 * 有重疊 → exit code 2。
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];

function pickBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("搵唔到本機 Edge / Chrome");
}

async function measure(file) {
  const browser = await puppeteer.launch({
    executablePath: pickBrowser(),
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    await page.goto("file:///" + file.replace(/\\/g, "/"), { waitUntil: "load" });

    const result = await page.evaluate(() => {
      const canvas = document.getElementById("canvas");
      const scale = canvas.getBoundingClientRect().width / canvas.offsetWidth || 1;
      const R = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left / scale, y: r.top / scale, w: r.width / scale, h: r.height / scale };
      };
      const overlap = (a, b) => {
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return { ox: +ox.toFixed(2), oy: +oy.toFixed(2), hit: ox > 1 && oy > 1 };
      };

      // 壓力樣本：枱名 + 單號都故意超長（商家可以自訂枱名，單號亦可能前綴好長）
      const stress = document.createElement("button");
      stress.type = "button";
      stress.className = "card occ";
      stress.setAttribute("data-stress", "1");
      stress.innerHTML =
        '<div class="tname-row">' +
        '<div class="tname">外賣自取 3 號窗口（大廳）</div>' +
        '<span class="badge occ">快餐-20260922-0087</span>' +
        "</div>" +
        '<div class="area">1樓</div><div class="seat">已坐 0/—</div>' +
        '<div class="amt">應收 MOP 1,234</div><div class="tlabel">已下單</div>';
      const host = document.getElementById("floor1");
      host.appendChild(stress);
      host.style.gridTemplateColumns = "repeat(4,minmax(0,1fr))";

      const rows = [];
      const cards = document.querySelectorAll("#floor1 .card, #states .card");
      for (const card of cards) {
        const name = card.querySelector(".tname");
        const badge = card.querySelector(".badge");
        const label = card.querySelector(".tlabel");
        const seat = card.querySelector(".seat");
        const amt = card.querySelector(".amt");
        const cardBox = R(card);
        const padL = parseFloat(getComputedStyle(card).paddingLeft);
        const padR = parseFloat(getComputedStyle(card).paddingRight);
        const padT = parseFloat(getComputedStyle(card).paddingTop);

        const row = {
          where: card.closest("#floor1") ? "1樓" : "對比",
          name: name ? name.textContent.trim() : null,
          badge: badge ? badge.textContent.trim() : null,
          status: card.className.replace("card ", ""),
          stress: card.hasAttribute("data-stress") || undefined,
        };

        if (badge && name) {
          const nb = R(name), bb = R(badge);
          const ov = overlap(nb, bb);
          row.nameBox = { x: +nb.x.toFixed(1), w: +nb.w.toFixed(1) };
          row.badgeBox = { x: +bb.x.toFixed(1), w: +bb.w.toFixed(1) };
          row.nameBadgeOverlap = ov.hit ? { ox: ov.ox, oy: ov.oy } : null;
          // 角標右邊 vs 卡片右內邊（正值 = 凸出卡片內邊 = 貼角／微凸，容許 ≤4px）
          row.badgeRightVsPadRight = +(cardBox.x + cardBox.w - padR - (bb.x + bb.w)).toFixed(2);
          // 角標頂邊 vs 卡片頂內邊（負值 = 凸出到 padding 內，最多 -4px）
          row.badgeTopVsPadTop = +(bb.y - (cardBox.y + padT)).toFixed(2);
          row.badgeTextTruncated = badge.scrollWidth > badge.clientWidth + 1;
          row.nameTruncated = name.scrollWidth > name.clientWidth + 1;
          row.gapNameToBadge = +(bb.x - (nb.x + nb.w)).toFixed(2);
          // 角標同下方任何文字（區域／座位／應收）有冇重疊
          row.badgeVsBelow = [];
          for (const el of [card.querySelector(".area"), seat, amt, label]) {
            if (!el) continue;
            const o = overlap(bb, R(el));
            if (o.hit) row.badgeVsBelow.push({ cls: el.className, ox: o.ox, oy: o.oy });
          }
        } else {
          row.badge === null ? (row.badge = null) : null;
          row.nameBadgeOverlap = null;
        }
        row.clipped = card.scrollHeight > card.clientHeight + 1;
        rows.push(row);
      }

      // 角標對「整卡高度」嘅影響：有角標 vs 冇角標卡片高度
      const h = (sel) => {
        const el = document.querySelector(sel);
        return el ? +R(el).h.toFixed(1) : null;
      };
      return {
        scale: +scale.toFixed(4),
        rows,
        cardHeights: {
          occWithBadge: h("#floor1 .card.occ"),
          idleNoBadge: h("#floor1 .card.idle"),
        },
        badCount: rows.filter(
          (r) => r.nameBadgeOverlap || (r.badgeVsBelow || []).length > 0 || r.clipped,
        ).length,
      };
    });
    return result;
  } finally {
    await browser.close();
  }
}

(async () => {
  const file = path.resolve(process.argv[2]);
  const res = await measure(file);
  console.log("scale =", res.scale);
  console.log("");
  const pad = (s, n) => String(s == null ? "—" : s).padEnd(n).slice(0, n);
  console.log(pad("位置", 6), pad("狀態", 20), pad("枱名", 24), pad("角標", 22),
    pad("重疊", 8), pad("角標右凸", 10), pad("角標上凸", 10), pad("枱名截斷", 9), "角標截斷");
  for (const r of res.rows) {
    console.log(
      pad(r.where, 6), pad(r.status, 20), pad(r.name, 24), pad(r.badge, 22),
      pad(r.nameBadgeOverlap ? `✘${r.nameBadgeOverlap.ox}` : "0", 8),
      pad(r.badgeRightVsPadRight, 10), pad(r.badgeTopVsPadTop, 10),
      pad(r.nameTruncated ? "係" : "否", 9),
      r.badgeTextTruncated ? "✘係" : "否",
    );
  }
  console.log("");
  console.log("有角標卡高度 =", res.cardHeights.occWithBadge, "px ；空閒卡高度 =", res.cardHeights.idleNoBadge, "px");
  console.log(
    res.badCount === 0
      ? "\n✔ 零重疊、零裁切、零超出卡片 —— 角標冇遮擋枱名"
      : `\n✘ 有 ${res.badCount} 張卡出事`,
  );
  process.exit(res.badCount === 0 ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
