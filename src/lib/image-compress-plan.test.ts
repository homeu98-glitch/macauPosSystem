/**
 * 相片壓縮決策測試。
 *
 * ⚠️ 只測 `image-compress-plan.ts`（零 import 純函式）。
 *    真正嘅 canvas 壓縮喺 `image-compress.ts`，需要瀏覽器 API，
 *    `node --test` 跑唔到 —— 呢個係本專案刻意嘅分層（見該檔頂部註解）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_UPLOAD_BYTES,
  MAX_EDGE,
  QUALITY_LADDER,
  EDGE_LADDER,
  buildCompressPlan,
  clampEdge,
  fitWithin,
  isWithinLimit,
  rejectReason,
  humanSize,
} from "./image-compress-plan.ts";

/* ---------------- 硬要求：200KB ---------------- */

test("MAX_UPLOAD_BYTES 係 200KB（1024 進位）", () => {
  assert.equal(MAX_UPLOAD_BYTES, 204800);
});

test("🔴 剛好 200KB（204800）唔算達標 —— 要求係「200kb 以下」", () => {
  assert.equal(isWithinLimit(MAX_UPLOAD_BYTES), false);
  assert.equal(isWithinLimit(MAX_UPLOAD_BYTES - 1), true);
});

test("199KB 達標、201KB 唔達標", () => {
  assert.equal(isWithinLimit(199 * 1024), true);
  assert.equal(isWithinLimit(201 * 1024), false);
});

test("非有限數／負數／0 一律當唔達標（防 NaN 靜默通過）", () => {
  assert.equal(isWithinLimit(Number.NaN), false);
  assert.equal(isWithinLimit(Number.POSITIVE_INFINITY), false);
  assert.equal(isWithinLimit(0), false);
  assert.equal(isWithinLimit(-1), false);
});

test("isWithinLimit 可以自訂上限", () => {
  assert.equal(isWithinLimit(500, 1000), true);
  assert.equal(isWithinLimit(1000, 1000), false);
});

/* ---------------- 把關（最後防線） ---------------- */

test("🔴 超標要回可讀原因，唔可以回 null", () => {
  const reason = rejectReason(500 * 1024);
  assert.ok(reason);
  assert.match(String(reason), /500KB/);
  assert.match(String(reason), /200KB/);
  assert.match(String(reason), /超過/);
});

test("達標回 null（可以上傳）", () => {
  assert.equal(rejectReason(150 * 1024), null);
});

test("壓縮失敗（0 byte）回原因而唔係 null —— 唔可以照上傳原圖", () => {
  const reason = rejectReason(0);
  assert.ok(reason);
  assert.match(String(reason), /失敗/);
});

test("rejectReason 自訂上限亦要反映喺文案", () => {
  const reason = rejectReason(2048, 1024);
  assert.ok(reason);
  assert.match(String(reason), /1KB/);
});

/* ---------------- clampEdge ---------------- */

test("clampEdge 唔可以大過 MAX_EDGE（唔准放大）", () => {
  assert.equal(clampEdge(99999), MAX_EDGE);
});

test("clampEdge 下限 200（壓太細會睇唔清）", () => {
  assert.equal(clampEdge(10), 200);
  assert.equal(clampEdge(0), MAX_EDGE);
  assert.equal(clampEdge(-100), MAX_EDGE);
  assert.equal(clampEdge(Number.NaN), MAX_EDGE);
});

test("clampEdge 正常值原樣四捨五入", () => {
  assert.equal(clampEdge(1200), 1200);
  assert.equal(clampEdge(1200.6), 1201);
});

/* ---------------- 嘗試序列 ---------------- */

test("計劃長度 = 縮邊數 × 品質數", () => {
  const plan = buildCompressPlan(MAX_EDGE);
  assert.equal(plan.length, EDGE_LADDER.length * QUALITY_LADDER.length);
});

test("🔴 第一級係最高品質（先保品質、後縮邊）", () => {
  const plan = buildCompressPlan(MAX_EDGE);
  assert.deepEqual(plan[0], { maxEdge: MAX_EDGE, quality: QUALITY_LADDER[0] });
});

test("🔴 同一條邊內，quality 逐級遞減", () => {
  const plan = buildCompressPlan(MAX_EDGE, [0.9, 0.8, 0.7], [1600]);
  assert.deepEqual(plan, [
    { maxEdge: 1600, quality: 0.9 },
    { maxEdge: 1600, quality: 0.8 },
    { maxEdge: 1600, quality: 0.7 },
  ]);
});

test("🔴 quality 到底都唔得，才開始縮邊重試", () => {
  const plan = buildCompressPlan(MAX_EDGE, [0.8, 0.5], [1600, 800]);
  assert.deepEqual(plan, [
    { maxEdge: 1600, quality: 0.8 },
    { maxEdge: 1600, quality: 0.5 },
    { maxEdge: 800, quality: 0.8 },
    { maxEdge: 800, quality: 0.5 },
  ]);
});

test("自訂 maxEdge 細過 1600 時，唔會出現比佢大嘅級數", () => {
  const plan = buildCompressPlan(1000);
  assert.ok(plan.length > 0);
  for (const step of plan) assert.ok(step.maxEdge <= 1000, `maxEdge ${step.maxEdge} > 1000`);
  // 起點一定要出現（1000 唔喺 EDGE_LADDER 入面 ⇒ 要插入）
  assert.equal(plan[0].maxEdge, 1000);
});

test("自訂 maxEdge 大過 MAX_EDGE 會被夾返落嚟", () => {
  const plan = buildCompressPlan(4000);
  assert.equal(plan[0].maxEdge, MAX_EDGE);
});

test("計劃唔可以有重複級數（否則白做一次壓縮）", () => {
  const plan = buildCompressPlan(MAX_EDGE);
  const keys = plan.map((p) => `${p.maxEdge}@${p.quality}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("品質階梯由高到低、全部喺 (0,1]", () => {
  for (let i = 1; i < QUALITY_LADDER.length; i++) {
    assert.ok(QUALITY_LADDER[i] < QUALITY_LADDER[i - 1], "品質階梯必須遞減");
  }
  for (const q of QUALITY_LADDER) {
    assert.ok(q > 0 && q <= 1, `品質 ${q} 超出 (0,1]`);
  }
});

test("縮邊階梯由大至細", () => {
  for (let i = 1; i < EDGE_LADDER.length; i++) {
    assert.ok(EDGE_LADDER[i] < EDGE_LADDER[i - 1], "縮邊階梯必須遞減");
  }
});

/* ---------------- fitWithin ---------------- */

test("唔會放大：原圖細過 maxEdge 時 scale = 1", () => {
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600, scale: 1 });
});

test("橫向圖按長邊縮", () => {
  const r = fitWithin(4000, 3000, 1600);
  assert.equal(r.width, 1600);
  assert.equal(r.height, 1200);
});

test("縱向圖（iPad 直拍）按高度縮", () => {
  const r = fitWithin(3000, 4000, 1600);
  assert.equal(r.width, 1200);
  assert.equal(r.height, 1600);
});

test("正方形圖", () => {
  const r = fitWithin(2000, 2000, 1600);
  assert.deepEqual({ w: r.width, h: r.height }, { w: 1600, h: 1600 });
});

test("🔴 極端長條圖唔可以縮到 0（canvas 尺寸 0 ⇒ toBlob 回 null）", () => {
  const r = fitWithin(4000, 3, 1600);
  assert.equal(r.width, 1600);
  assert.ok(r.height >= 1, `height 縮到 ${r.height}，會令 toBlob 失敗`);
});

test("非法尺寸唔會爆（回 1×1 而唔係 NaN）", () => {
  const r = fitWithin(0, 0, 1600);
  assert.equal(r.width, 1);
  assert.equal(r.height, 1);
  const r2 = fitWithin(Number.NaN, 500, 1600);
  assert.ok(Number.isFinite(r2.width) && r2.width >= 1);
  assert.ok(Number.isFinite(r2.height) && r2.height >= 1);
});

test("scale 反映真實比例", () => {
  const r = fitWithin(3200, 1600, 1600);
  assert.equal(r.scale, 0.5);
});

/* ---------------- humanSize ---------------- */

test("humanSize 小數一位，唔會顯示 0.0KB", () => {
  assert.equal(humanSize(150 * 1024), "150KB");
  assert.equal(humanSize(1024), "1KB");
  assert.equal(humanSize(512), "0.5KB");
  assert.equal(humanSize(100), "0.1KB");
  assert.equal(humanSize(0), "0KB");
  assert.equal(humanSize(Number.NaN), "0KB");
});

test("humanSize MB 級", () => {
  assert.equal(humanSize(3 * 1024 * 1024), "3MB");
  assert.equal(humanSize(1.5 * 1024 * 1024), "1.5MB");
});
