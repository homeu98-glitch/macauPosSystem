/**
 * 驗證「紙張尺寸 → 每行字數」（2026-09-13 修嘅 bug）。
 *
 * 🔴 修之前：`paperColumnsFromSize("60x40mm")` 回 48（80mm 票據機欄數），
 * 但 60mm 標籤紙實際係 34 字 → `Math.min()` 截頂失效 → 出紙亂版。
 *
 * ⚠️ 被測模組 `src/lib/paper-columns.ts` 係**純模組**（只 import `./types.ts`，
 * 而 types.ts 只有 `import type` → type-strip 抹掉）。所以可以直接載入。
 * 若果日後有人喺嗰邊加 `@/lib/...` runtime import，呢個測試會即刻爆 —— 好事。
 *
 * 跑法：node --experimental-strip-types --no-warnings tools/verify-label-paper-columns.cjs
 */
const assert = require("node:assert");

async function main() {
  const pc = await import("../src/lib/paper-columns.ts");
  const {
    RECEIPT_PAPER_COLUMNS,
    RECEIPT_PAPER_COLUMNS_58MM,
    findLabelPaperPreset,
    isLabelPaperSize,
    labelPaperColumns,
    labelPaperPresetId,
    labelPaperWidthMmOf,
    paperColumnsFromSize,
  } = pc;

  const types = await import("../src/lib/types.ts");
  const { LABEL_PAPER_PRESETS, DEFAULT_LABEL_PAPER_ID } = types;

  const models = await import("../src/lib/print-bridge/printer-models.ts");
  const { LABEL_MODEL_PAPER_SIZES } = models;

  // ── 1. 收據常數冇走樣 ──
  assert.equal(RECEIPT_PAPER_COLUMNS, 48, "80mm 票據機 = 48 字");
  assert.equal(RECEIPT_PAPER_COLUMNS_58MM, 32, "58mm 票據機 = 32 字");
  console.log("✅ 收據常數正確（80mm→48 / 58mm→32）");

  // ── 2. id 歸一化 ──
  assert.equal(labelPaperPresetId("60x40mm"), "60x40", "WxH+mm 要剝 mm");
  assert.equal(labelPaperPresetId("40x30MM"), "40x30", "大小寫都要處理");
  assert.equal(labelPaperPresetId("60x40"), "60x40", "已經冇 mm 就唔郁");
  assert.equal(labelPaperPresetId("62mm"), "62mm", "🔴 62mm 唔可以剝！");
  assert.equal(labelPaperPresetId("58mm"), "58mm", "🔴 58mm（收據）唔可以剝！");
  assert.equal(labelPaperPresetId("80mm"), "80mm", "🔴 80mm（收據）唔可以剝！");
  assert.equal(labelPaperPresetId(""), "");
  assert.equal(labelPaperPresetId(undefined), "");
  console.log("✅ id 歸一化正確（62mm / 58mm / 80mm 唔會被剝 mm）");

  // ── 3. isLabelPaperSize 分支 ──
  assert.equal(isLabelPaperSize("60x40mm"), true);
  assert.equal(isLabelPaperSize("60x40"), true);
  assert.equal(isLabelPaperSize("62mm"), true);
  assert.equal(isLabelPaperSize("58mm"), false, "🔴 58mm 係收據紙，唔係標籤");
  assert.equal(isLabelPaperSize("80mm"), false, "🔴 80mm 係收據紙，唔係標籤");
  assert.equal(isLabelPaperSize(""), false);
  console.log("✅ isLabelPaperSize 正確（收據 58/80mm 唔會誤判為標籤）");

  // ── 4. 🔴 核心迴歸：paperColumnsFromSize 真實回傳值 ──
  const table = [
    // [paperSize, 期望 cols, 說明]
    ["80mm", 48, "票據機 80mm"],
    ["58mm", 32, "票據機 58mm"],
    ["", 48, "空字串 → 票據機預設"],
    [undefined, 48, "undefined → 票據機預設"],
    ["58x40", 32, "標籤 58×40（含 58 但係標籤）"],
    ["58x40mm", 32, "標籤 58×40mm"],
    ["30x20mm", 14, "標籤 30×20（原本回 48 🔴）"],
    ["40x30mm", 21, "標籤 40×30（原本回 48 🔴）"],
    ["50x30mm", 28, "標籤 50×30（原本回 48 🔴）"],
    ["50x40mm", 28, "標籤 50×40（原本回 48 🔴）"],
    ["60x40mm", 34, "標籤 60×40 ← XP-235B（原本回 48 🔴）"],
    ["70x50mm", 41, "標籤 70×50（原本回 48 🔴）"],
    ["100x75mm", 61, "標籤 100×75（原本回 48 🔴）"],
    ["62mm", 36, "標籤 62mm 舊預設"],
    ["60x40", 34, "標籤 60×40（無 mm 寫法）"],
    ["100x75", 61, "標籤 100×75（無 mm 寫法）"],
  ];
  let bad = 0;
  console.log("\n  paperSize        實際   期望   狀態");
  console.log("  ──────────────────────────────────────");
  for (const [size, want, note] of table) {
    const got = paperColumnsFromSize(size);
    const ok = got === want;
    if (!ok) bad++;
    console.log(
      `  ${String(size).padEnd(16)} ${String(got).padStart(4)} ${String(want).padStart(6)}   ${ok ? "✅" : "🔴"}  ${note}`,
    );
  }
  assert.equal(bad, 0, `有 ${bad} 個 case 唔正確`);
  console.log("✅ paperColumnsFromSize 全部正確（標籤唔再一律回 48）");

  // ── 5. min() 截頂真正生效（print-jobs.ts 嘅用法） ──
  // 模板 100×75（61 字）＋ 一部 60mm 標籤機 → 應該截到 34
  const templateCols = labelPaperColumns("100x75");
  const printerCols = paperColumnsFromSize("60x40mm");
  assert.equal(Math.min(templateCols, printerCols), 34, "應該截到 60mm 嘅 34 字");
  assert.notEqual(Math.min(templateCols, printerCols), 48, "修之前會錯誤地截到 48");
  // 模板 40×30（21 字）＋ 60mm 機 → 應該用 21（模板更窄）
  assert.equal(Math.min(labelPaperColumns("40x30"), paperColumnsFromSize("60x40mm")), 21);
  console.log("✅ Math.min(模板, 打印機) 截頂真正生效（100×75 模板 + 60mm 機 → 34 字）");

  // ── 6. 未知 / 亂打 → 安全 fallback ──
  assert.equal(labelPaperColumns(undefined), 36, "未知 → 62mm 預設 36");
  assert.equal(labelPaperColumns("亂咁打"), 36);
  assert.equal(labelPaperColumns(undefined), labelPaperColumns(DEFAULT_LABEL_PAPER_ID));
  console.log("✅ 未知標籤尺寸 → fallback 62mm（舊設定向後兼容）");

  // ── 7. 兩種寫法都搵到 preset ──
  for (const p of LABEL_PAPER_PRESETS) {
    assert.ok(findLabelPaperPreset(p.id), `${p.id} 應該搵到`);
    if (/^\d+x\d+$/.test(p.id)) {
      assert.ok(findLabelPaperPreset(`${p.id}mm`), `${p.id}mm 應該搵到`);
    }
  }
  assert.equal(findLabelPaperPreset("唔存在"), undefined);
  console.log(`✅ 兩種寫法都搵到（${LABEL_PAPER_PRESETS.length} 個尺寸）`);

  // ── 8. 闊度查詢 ──
  assert.equal(labelPaperWidthMmOf("60x40mm"), 60);
  assert.equal(labelPaperWidthMmOf("100x75mm"), 100);
  assert.equal(labelPaperWidthMmOf("62mm"), 62);
  assert.equal(labelPaperWidthMmOf("唔存在"), undefined, "未知 → undefined，唔可以扮 0");
  console.log("✅ 闊度查詢正確");

  // ── 9. 🔴 兩張表一致性（防止 id 寫法唔同步再次發生） ──
  const missing = [];
  for (const opt of LABEL_MODEL_PAPER_SIZES) {
    const p = findLabelPaperPreset(opt.value);
    if (!p) {
      missing.push(`${opt.value}（canonical 表搵唔到）`);
      continue;
    }
    if (p.widthMm !== opt.widthMm) {
      missing.push(`${opt.value} 闊度唔一致：preset=${p.widthMm} vs 型號表=${opt.widthMm}`);
    }
  }
  assert.equal(missing.length, 0, `型號表有尺寸對唔上 canonical 表：\n  ${missing.join("\n  ")}`);
  console.log(`✅ 兩張表一致（型號表 ${LABEL_MODEL_PAPER_SIZES.length} 個尺寸全對得上）`);

  // ── 10. columns 公式 ──
  const formulaMismatch = [];
  for (const p of LABEL_PAPER_PRESETS) {
    const want = Math.floor((p.widthMm - 8) / 1.5);
    if (Math.abs(p.columns - want) > 1) {
      formulaMismatch.push(`${p.id}: columns=${p.columns} vs 公式=${want}`);
    }
  }
  assert.equal(formulaMismatch.length, 0, `欄數唔跟公式：\n  ${formulaMismatch.join("\n  ")}`);
  console.log("✅ 欄數跟公式 floor((闊−8)/1.5)（±1 容差）");

  console.log("\n════════════════════════════════════");
  console.log("  紙張欄數 10 項斷言全過");
  console.log("════════════════════════════════════");
}

main().catch((e) => {
  console.error("❌ 測試失敗：", e.message);
  process.exit(1);
});
