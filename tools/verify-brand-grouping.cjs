/**
 * 驗證品牌層分組 / 篩選（2026-09-13 商家要求）。
 *
 * 規則：
 *   1. 先依品牌分組
 *   2. 冇對應品牌（通用兜底類）一律歸「其他」
 *   3. 「其他」永遠排最後
 *   4. 分組保序（國內品牌行先）
 *   5. chip 含「全部」
 *
 * 跑法：node --experimental-strip-types tools/verify-brand-grouping.cjs
 */
const assert = require("node:assert");

async function main() {
  const mod = await import("../src/lib/print-bridge/printer-models.ts");
  const {
    BRAND_FILTER_ALL,
    OTHER_BRAND,
    brandChipLabel,
    brandChipsOf,
    brandGroupOfCandidate,
    brandGroupOfModel,
    getLanModelOptions,
    groupModelsByBrand,
  } = mod;

  // ── 1. 「其他」哨兵值唔可以同真實品牌撞 ──
  const allModels = getLanModelOptions();
  const realBrands = new Set(allModels.filter((o) => !o.genericFallback).map((o) => o.brand));
  assert.ok(!realBrands.has(OTHER_BRAND), `「其他」唔可以係真實品牌名`);
  assert.ok(!realBrands.has(BRAND_FILTER_ALL), `「${BRAND_FILTER_ALL}」唔可以同真實品牌撞`);
  console.log(`✅ 哨兵值安全（真實品牌 ${realBrands.size} 個）`);

  // ── 2. 通用兜底項一律歸「其他」 ──
  const genericItems = allModels.filter((o) => o.genericFallback);
  assert.ok(genericItems.length > 0, "應該有通用兜底項");
  for (const g of genericItems) {
    assert.equal(brandGroupOfModel(g), OTHER_BRAND, `${g.model} 應該歸「其他」`);
  }
  console.log(`✅ ${genericItems.length} 個通用兜底項全部歸「其他」`);

  // ── 3. 真實品牌唔會被誤歸「其他」 ──
  for (const o of allModels.filter((x) => !x.genericFallback)) {
    assert.equal(brandGroupOfModel(o), o.brand, `${o.model} 應該喺「${o.brand}」組`);
  }
  console.log("✅ 真實品牌全部落返自己嘅組");

  // ── 4. 分組：數量守恆 + 「其他」沉底 ──
  const groups = groupModelsByBrand(allModels);
  const grouped = groups.reduce((n, g) => n + g.count, 0);
  assert.equal(grouped, allModels.length, "分組後總數要等於原本總數");
  assert.equal(groups[groups.length - 1].brand, OTHER_BRAND, "「其他」要排最後");
  assert.equal(groups.filter((g) => g.brand === OTHER_BRAND).length, 1, "「其他」只可以有一個");
  console.log(`✅ 分組守恆（${allModels.length} 項 → ${groups.length} 組，「其他」沉底）`);

  // ── 5. 保序：國內品牌行先（第一個非通用組應該係國內品牌） ──
  const firstGroup = groups.find((g) => g.brand !== OTHER_BRAND);
  assert.ok(
    /芯燁|佳博|新北洋|容大|中崎|漢印|得力|快麥|啟銳|立象/.test(firstGroup.brand),
    `第一組應該係國內品牌，實際係「${firstGroup.brand}」`,
  );
  console.log(`✅ 保序：國內品牌行先（首組 = ${firstGroup.brand}）`);

  // ── 6. 標籤機清單嘅分組（商家截圖嗰個場景） ──
  const labelGroups = groupModelsByBrand(getLanModelOptions("label"));
  const labelBrandNames = labelGroups.map((g) => g.brand);
  console.log(`\n   標籤機分組（${labelGroups.length} 組）：`);
  for (const g of labelGroups) {
    console.log(`     ${g.brand.padEnd(18, " ")} ${String(g.count).padStart(2, " ")} 個`);
  }
  assert.equal(labelBrandNames[labelBrandNames.length - 1], OTHER_BRAND, "標籤機「其他」要沉底");
  // 標籤機唔應該有「其他」以外嘅通用品牌名混入
  assert.ok(!labelBrandNames.includes("通用標籤機"), "「通用標籤機」唔應該獨立成組");
  assert.ok(!labelBrandNames.includes("通用 ESC/POS"), "「通用 ESC/POS」唔應該獨立成組");
  console.log("✅ 標籤機：「通用標籤機」已併入「其他」，唔會獨立成組");

  // ── 7. chip 清單 ──
  const chips = brandChipsOf(labelGroups);
  assert.equal(chips[0].brand, BRAND_FILTER_ALL, "第一個 chip 要係「全部」");
  assert.equal(chips[0].count, labelGroups.reduce((n, g) => n + g.count, 0), "「全部」數量要啱");
  assert.equal(chips.length, labelGroups.length + 1, "chip 數 = 分組數 + 1（全部）");
  console.log(`✅ chip：${brandChipLabel(chips[0].brand, chips[0].count)} + ${chips.length - 1} 個品牌 chip`);

  // ── 8. USB 候選項嘅品牌判斷 ──
  assert.equal(
    brandGroupOfCandidate({ brand: "漢印 HPRT", model: "漢印 SL42（標籤）" }),
    "漢印 HPRT",
    "認得嘅品牌要保留",
  );
  assert.equal(
    brandGroupOfCandidate({ brand: "USB 打印機", model: "通用 ESC/POS (USB Printer Class)" }),
    OTHER_BRAND,
    "USB Printer Class 通用機要歸「其他」",
  );
  assert.equal(
    brandGroupOfCandidate({ name: "USB 打印機 0x1234" }),
    OTHER_BRAND,
    "認唔到嘅 USB 設備要歸「其他」",
  );
  assert.equal(brandGroupOfCandidate({}), OTHER_BRAND, "空物件要歸「其他」");
  console.log("✅ USB 候選項品牌判斷正確（認得 → 品牌；認唔到 → 其他）");

  // ── 9. 篩選邏輯：揀單一品牌只出嗰個 ──
  const target = labelGroups.find((g) => g.brand === "漢印 HPRT");
  assert.ok(target, "應該有漢印 HPRT 組");
  const filtered = labelGroups.filter((g) => g.brand === "漢印 HPRT");
  assert.equal(filtered.length, 1, "篩選後應該只有一組");
  assert.equal(filtered[0].items.length, target.count, "篩選後型號數要等於組內數");
  for (const it of filtered[0].items) {
    assert.equal(it.brand, "漢印 HPRT", "篩選後唔可以有其他品牌混入");
  }
  console.log(`✅ 篩選正確：漢印 HPRT → ${filtered[0].items.length} 個型號，零混入`);

  console.log("\n════════════════════════════════════");
  console.log("  品牌分組 9 項斷言全過");
  console.log("════════════════════════════════════");
}

main().catch((e) => {
  console.error("❌ 測試失敗：", e.message);
  process.exit(1);
});
