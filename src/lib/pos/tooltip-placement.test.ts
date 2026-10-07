import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeTooltipPlacement,
  parseCssPixels,
  type AnchorRect,
  type PlacementViewport,
} from "./tooltip-placement.ts";

/**
 * 守衛測試（2026-10-07）。
 *
 * 設計原則（見 MEMORY §6.1）：**守行為不變量，唔守代碼字串**。
 * 呢度守嘅係「氣泡一定完整落喺可視區內」＋「右側錨點會向左翻、左側錨點唔會亂翻」
 * 呢啲**產品契約**，唔係實作細節。
 */

const INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** 1080×800 嘅普通視窗（無 safe area）。 */
function viewport(width = 1080, height = 800, overrides: Partial<PlacementViewport> = {}): PlacementViewport {
  return { width, height, offsetTop: 0, offsetLeft: 0, insets: INSETS, ...overrides };
}

function anchor(left: number, top: number, width = 22, height = 22): AnchorRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const BUBBLE = { width: 300, height: 160 };

test("預設位置擺得落 → 唔翻，維持下方靠左", () => {
  const p = computeTooltipPlacement({ anchor: anchor(300, 200), bubble: BUBBLE, viewport: viewport() });
  assert.equal(p.side, "bottom");
  assert.equal(p.align, "left");
  assert.equal(p.left, 300);
  assert.equal(p.top, 200 + 22 + 8);
  assert.equal(p.flippedX, false);
  assert.equal(p.flippedY, false);
});

test("🔴 右側錨點向右就會出界 → 自動改為向左伸展（align=right）", () => {
  // 球喺 x=1000，氣泡闊 300 ⇒ 向右伸到 1300 > 1080 出界。
  const p = computeTooltipPlacement({ anchor: anchor(1000, 200), bubble: BUBBLE, viewport: viewport() });
  assert.equal(p.align, "right", "應該改為靠右對齊（氣泡右緣貼球右緣）");
  assert.equal(p.left, 1000 + 22 - 300);
  assert.equal(p.left + BUBBLE.width <= 1080, true, "氣泡右緣必須喺視窗內");
  assert.equal(p.side, "bottom", "水平唔使郁就唔應該連帶翻上");
});

test("🔴 左側錨點唔會因為右邊有其他球而亂翻（每顆球獨立判斷）", () => {
  const left = computeTooltipPlacement({ anchor: anchor(40, 200), bubble: BUBBLE, viewport: viewport() });
  const right = computeTooltipPlacement({ anchor: anchor(1000, 200), bubble: BUBBLE, viewport: viewport() });
  assert.equal(left.align, "left");
  assert.equal(right.align, "right");
  assert.notEqual(left.align, right.align, "兩顆球嘅水平方向必須各自判斷");
});

test("先水平、後垂直：水平翻完垂直唔應該再郁（除非真係擺唔落）", () => {
  // 球喺右下角：水平要向左翻，垂直有位（下面仲有 800-450=350px）。
  const p = computeTooltipPlacement({ anchor: anchor(1000, 400), bubble: BUBBLE, viewport: viewport(1080, 800) });
  assert.equal(p.align, "right");
  assert.equal(p.side, "bottom");
});

test("下面擺唔落 → 翻到上面，水平對齊維持不變", () => {
  const p = computeTooltipPlacement({ anchor: anchor(300, 700), bubble: BUBBLE, viewport: viewport(1080, 800) });
  assert.equal(p.side, "top");
  assert.equal(p.align, "left", "只翻垂直，唔應該連水平都反轉");
  assert.equal(p.top + BUBBLE.height <= 800, true, "氣泡底必須喺視窗內");
});

test("右下角：水平向左 + 垂直向上，兩者同時生效", () => {
  const p = computeTooltipPlacement({ anchor: anchor(1000, 700), bubble: BUBBLE, viewport: viewport(1080, 800) });
  assert.equal(p.align, "right");
  assert.equal(p.side, "top");
  assert.equal(p.flippedX, true);
  assert.equal(p.flippedY, true);
  assert.equal(p.clampedX, false);
  assert.equal(p.clampedY, false);
});

test("🔴 螢幕闊度不足（氣泡闊過剩餘空間）→ 夾入而唔係出界", () => {
  // 320px 闊嘅手機，氣泡 300px，右邊只剩 40px。
  const p = computeTooltipPlacement({ anchor: anchor(260, 200), bubble: BUBBLE, viewport: viewport(320, 640) });
  assert.equal(p.clampedX, true, "應該用夾位（clamp）");
  assert.equal(p.left >= 0, true, "左緣唔可以離開視窗");
  assert.equal(p.left + p.maxWidth <= 320, true, "右緣唔可以離開視窗");
});

test("🔴 maxWidth 會被可視區闊度收窄（唔會出界）", () => {
  const p = computeTooltipPlacement({
    anchor: anchor(10, 100),
    bubble: { width: 320, height: 100 },
    viewport: viewport(300, 600),
  });
  assert.equal(p.maxWidth <= 300, true, `maxWidth 應該被收窄至視窗內，實際 ${p.maxWidth}`);
});

test("safe area 四邊都會收窄可用範圍", () => {
  const withInsets = computeTooltipPlacement({
    anchor: anchor(1000, 200),
    bubble: BUBBLE,
    viewport: viewport(1080, 800, { insets: { top: 24, right: 24, bottom: 34, left: 24 } }),
  });
  assert.equal(withInsets.left + BUBBLE.width <= 1080 - 24, true, "右邊要避 safe area");
  // 頂部：safe area 24 + padding 8 ⇒ 氣泡上緣最少 32。
  const top = computeTooltipPlacement({
    anchor: anchor(100, 700),
    bubble: BUBBLE,
    viewport: viewport(1080, 800, { insets: { top: 24, right: 0, bottom: 0, left: 0 } }),
  });
  assert.equal(top.top >= 24 + 8, true, "翻到上面都要避開頂部 safe area");
});

test("visual viewport 偏移（iOS 鍵盤彈起）都會入算", () => {
  // 鍵盤彈起：可視區只剩 400px 高，offsetTop = 300。
  const p = computeTooltipPlacement({
    anchor: anchor(300, 650),
    bubble: BUBBLE,
    viewport: viewport(1080, 400, { offsetTop: 300 }),
  });
  assert.equal(p.top + BUBBLE.height <= 300 + 400, true, "氣泡唔可以擺喺鍵盤底下");
});

test("不變量：任何錨點位置，氣泡都完整落喺可視區內", () => {
  // 掃過整個視窗嘅網格，兩種闊度 × 兩種高度都試。
  for (const vw of [320, 768, 1080]) {
    for (const vh of [480, 800]) {
      for (let x = 0; x <= vw - 22; x += 37) {
        for (let y = 0; y <= vh - 22; y += 41) {
          for (const bw of [180, 300, 420]) {
            for (const bh of [60, 160, 400]) {
              const vp = viewport(vw, vh);
              const p = computeTooltipPlacement({ anchor: anchor(x, y), bubble: { width: bw, height: bh }, viewport: vp });
              // 實際會用 maxWidth／maxHeight 收窄，所以驗收用收窄後嘅尺寸。
              const w = Math.min(bw, p.maxWidth);
              const h = Math.min(bh, p.maxHeight);
              const ctx = `vw=${vw} vh=${vh} x=${x} y=${y} bw=${bw} bh=${bh}`;
              assert.equal(p.left >= 8 - 0.5, true, `左緣出界（${ctx}）：left=${p.left}`);
              assert.equal(p.left + w <= vw - 8 + 0.5, true, `右緣出界（${ctx}）：right=${p.left + w}`);
              assert.equal(p.top >= 8 - 0.5, true, `上緣出界（${ctx}）：top=${p.top}`);
              assert.equal(p.top + h <= vh - 8 + 0.5, true, `下緣出界（${ctx}）：bottom=${p.top + h}`);
            }
          }
        }
      }
    }
  }
});

test("邊界值：氣泡剛好等於可用空間時唔應該被判定為出界", () => {
  // 可用寬 = 1080 - 16 = 1064；氣泡闊 1064 放喺 x=8 應該恰好夾得落。
  const p = computeTooltipPlacement({
    anchor: anchor(8, 200),
    bubble: { width: 1064, height: 100 },
    viewport: viewport(1080, 800),
  });
  assert.equal(p.left, 8);
  assert.equal(p.left + 1064 <= 1080, true);
});

test("🔴 氣泡過高 → maxHeight 收窄至可視區（唔會無論點擺都出界）", () => {
  const p = computeTooltipPlacement({
    anchor: anchor(100, 200),
    bubble: { width: 200, height: 900 },
    viewport: viewport(1080, 400),
  });
  assert.equal(p.maxHeight <= 400 - 16, true, `maxHeight 應該被收窄，實際 ${p.maxHeight}`);
  assert.equal(p.top + p.maxHeight <= 400, true, "收窄後必須完整落在可視區內");
});

test("parseCssPixels：calc()/env() 讀唔到就當 0，唔可以變 NaN", () => {
  assert.equal(parseCssPixels("12px"), 12);
  assert.equal(parseCssPixels("0px"), 0);
  assert.equal(parseCssPixels("min(320px, calc(100vw - 24px))"), 0, "calc 值解析唔到就當 0");
  assert.equal(parseCssPixels(undefined), 0);
  assert.equal(parseCssPixels(null), 0);
  assert.equal(Number.isNaN(parseCssPixels("auto")), false, "永遠唔可以回 NaN");
});
