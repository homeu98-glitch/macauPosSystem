/**
 * 驗證標籤機紙寬限制（2026-09-13，商家 Xprinter XP-235B 情境）。
 *
 * 商家手上：Xprinter XP-235B（珠海芯燁）—— **介質幅寬 20–60mm**。
 * 呢個測試就係釘死「100×75 唔可以餵一部 60mm 上限嘅機」。
 *
 * 跑法：node --experimental-strip-types tools/verify-label-paper-width.cjs
 */
const assert = require("node:assert");

async function main() {
  const mod = await import("../src/lib/print-bridge/printer-models.ts");
  const {
    LAN_ONLY_MODELS,
    LABEL_MODEL_PAPER_SIZES,
    defaultLabelPaperFor,
    getLanModelOptions,
    labelPaperFitsModel,
    labelPaperOptionOf,
    labelPaperWidthMm,
  } = mod;

  // ── 1. 每個尺寸都有 widthMm / heightMm，且合理 ──
  for (const p of LABEL_MODEL_PAPER_SIZES) {
    assert.equal(typeof p.widthMm, "number", `${p.value} 缺 widthMm`);
    assert.ok(p.widthMm >= 20 && p.widthMm <= 110, `${p.value} widthMm 唔合理：${p.widthMm}`);
    assert.equal(typeof p.heightMm, "number", `${p.value} 缺 heightMm`);
  }
  console.log(`✅ ${LABEL_MODEL_PAPER_SIZES.length} 個標籤紙尺寸都有 widthMm / heightMm`);

  // ── 2. labelPaperWidthMm / labelPaperOptionOf ──
  assert.equal(labelPaperWidthMm("60x40mm"), 60);
  assert.equal(labelPaperWidthMm("100x75mm"), 100);
  assert.equal(labelPaperWidthMm("唔存在"), undefined, "未知尺寸要返 undefined");
  assert.equal(labelPaperWidthMm(null), undefined, "null 要返 undefined");
  assert.ok(labelPaperOptionOf("40x30mm"), "40x30mm 應該搵到");
  console.log("✅ 紙寬查詢正確（未知尺寸返 undefined，唔會扮 0）");

  // ── 3. 🔴 核心：XP-235B 20–60mm ──
  const xp235 = LAN_ONLY_MODELS.find((m) => m.model.includes("XP-235B"));
  assert.ok(xp235, "LAN 目錄應該有 XP-235B");
  assert.equal(xp235.brand, "芯燁 Xprinter");
  assert.equal(xp235.family, "label");
  assert.equal(xp235.maxLabelWidthMm, 60, "XP-235B 紙寬上限應該係 60mm");
  assert.equal(xp235.minLabelWidthMm, 20);
  console.log(`✅ XP-235B 已收錄：${xp235.brand} / ${xp235.model}`);
  console.log(`   紙寬限制 ${xp235.minLabelWidthMm}–${xp235.maxLabelWidthMm} mm`);

  // ── 4. 放得落 vs 放唔落 ──
  const fitCases = [
    ["30x20mm", true],
    ["40x30mm", true],
    ["50x30mm", true],
    ["50x40mm", true],
    ["60x40mm", true],
    ["62mm", false], // 62 > 60
    ["70x50mm", false],
    ["100x75mm", false], // 🔴 商家原本預設值 —— 必須攔
  ];
  for (const [value, expect] of fitCases) {
    const w = labelPaperWidthMm(value);
    const ok = labelPaperFitsModel(w, xp235.minLabelWidthMm, xp235.maxLabelWidthMm);
    assert.equal(ok, expect, `${value}（${w}mm）應該係 ${expect ? "放得落" : "放唔落"}`);
  }
  console.log("✅ XP-235B 紙寬判斷：30-60mm 合格；62/70/100mm 一律攔");

  // ── 5. 下限：20mm 以下唔得 ──
  assert.equal(labelPaperFitsModel(15, 20, 60), false, "15mm 低於下限 20mm");
  assert.equal(labelPaperFitsModel(20, 20, 60), true, "20mm 剛好喺下限");
  assert.equal(labelPaperFitsModel(60, 20, 60), true, "60mm 剛好喺上限");
  assert.equal(labelPaperFitsModel(61, 20, 60), false, "61mm 超出上限");
  console.log("✅ 邊界值正確（20 同 60 都係 inclusive）");

  // ── 6. 🔴 未知限制 → 一律放行（唔可以因為資料缺失攔人） ──
  assert.equal(labelPaperFitsModel(100, undefined, undefined), true);
  assert.equal(labelPaperFitsModel(1000, undefined, undefined), true);
  assert.equal(labelPaperFitsModel(100, undefined, 60), false, "有上限就要檢查");
  assert.equal(labelPaperFitsModel(10, 20, undefined), false, "有下限就要檢查");
  console.log("✅ 未知限制 → 放行（唔會因為資料缺失攔住商家）");

  // ── 7. 🔴 預設紙張必須喺範圍內 ──
  const def = defaultLabelPaperFor(60, 20, "100x75mm");
  assert.ok(def, "應該揀到預設");
  assert.notEqual(def, "100x75mm", "唔可以用超出範圍嘅型號表預設");
  assert.equal(def, "60x40mm", "20-60mm 機應該揀範圍內最闊嘅 60×40mm");
  console.log(`✅ 預設紙張：XP-235B → ${def}（範圍內最闊）`);

  // 型號表預設喺範圍內 → 就用佢
  assert.equal(defaultLabelPaperFor(110, undefined, "50x30mm"), "50x30mm", "型號表預設合格就用佢");
  // 無限制 → 用較保守嘅 60×40mm（唔揀 62mm 舊預設、唔揀 100×75 面單）
  assert.equal(defaultLabelPaperFor(undefined, undefined, undefined), "60x40mm");
  console.log("✅ 預設揀選次序正確（型號表預設 → 範圍內最闊 → 保守 60×40mm）");

  // ── 8. 62mm 舊預設唔會成為自動預設（但手動仍可揀） ──
  assert.notEqual(defaultLabelPaperFor(110, undefined, undefined), "62mm", "62mm 唔應該被自動選中");
  assert.ok(labelPaperOptionOf("62mm"), "62mm 仍然可以被手動揀（唔可以剷走）");
  console.log("✅ 62mm 舊預設：唔會自動選中，但商家手動仍可揀");

  // ── 9. LAN 清單帶到 width 去 UI ──
  const labelOpts = getLanModelOptions("label");
  const fromCatalog = labelOpts.find((o) => o.model.includes("XP-235B"));
  assert.ok(fromCatalog, "getLanModelOptions('label') 應該包含 XP-235B");
  assert.equal(fromCatalog.maxLabelWidthMm, 60, "width 要帶到 LanModelOption");
  assert.equal(fromCatalog.family, "label");
  // 票據機清單唔應該有 XP-235B
  const receiptOpts = getLanModelOptions("receipt");
  assert.ok(!receiptOpts.some((o) => o.model.includes("XP-235B")), "XP-235B 唔應該出現喺票據機清單");
  console.log("✅ LAN 清單帶到紙寬限制，且只出現喺標籤機清單");

  // ── 10. LAN_ONLY_MODELS 唔會混入 USB 自動偵測表 ──
  const usbVids = Object.keys(mod.USB_PRINTER_DB);
  assert.ok(usbVids.length > 0);
  // XP-235B 冇確認 PID → 唔可以出現喺任何 models 入面
  for (const [vid, vendor] of Object.entries(mod.USB_PRINTER_DB)) {
    for (const [, m] of Object.entries(vendor.models)) {
      assert.ok(!m.model.includes("XP-235B"), `XP-235B 唔應該有 PID（出現喺 ${vid}）`);
    }
  }
  console.log("✅ XP-235B 冇作 PID，只入 LAN 目錄（USB 靠品牌 fallback）");

  console.log("\n════════════════════════════════════");
  console.log("  紙寬限制 10 項斷言全過");
  console.log("════════════════════════════════════");
}

main().catch((e) => {
  console.error("❌ 測試失敗：", e.message);
  process.exit(1);
});
