/**
 * 驗證 getLanModelOptions(family) 真係把「票據機」同「標籤機」分開。
 *
 * 呢個測試直接跑源碼（唔經 build），用 node --experimental-strip-types 載入 .ts。
 * 跑法：node --experimental-strip-types tools/verify-label-model-split.cjs
 */
const assert = require("node:assert");

async function main() {
  const mod = await import("../src/lib/print-bridge/printer-models.ts");
  const { getLanModelOptions, familyForRole, resolveUsbMeta, suggestLabelCommandSet } = mod;

  const receipt = getLanModelOptions("receipt");
  const label = getLanModelOptions("label");
  const all = getLanModelOptions();

  console.log(`票據機型號數：${receipt.length}`);
  console.log(`標籤機型號數：${label.length}`);
  console.log(`全部型號數　：${all.length}`);

  // 1. 兩邊唔可以重疊
  const rset = new Set(receipt.map((o) => `${o.brand}|${o.model}`));
  const lset = new Set(label.map((o) => `${o.brand}|${o.model}`));
  const overlap = [...rset].filter((k) => lset.has(k));
  assert.equal(overlap.length, 0, `票據機同標籤機清單有重疊：${overlap.join(", ")}`);
  console.log("✅ 票據機 / 標籤機清單零重疊");

  // 2. 標籤機清單唔可以有票據機型號
  const badInLabel = label.filter((o) => /TM-T88|POS-80|XP-Q800|GP-58|ZJ-80|RP80|SRP-350/i.test(o.model));
  assert.equal(badInLabel.length, 0, `標籤機清單出現票據機：${badInLabel.map((o) => o.model).join(", ")}`);
  console.log("✅ 標籤機清單冇票據機型號");

  // 3. 票據機清單唔可以有標籤機型號
  const badInReceipt = receipt.filter((o) => /ZD410|ZD420|TTP-244|SL42|N41|DL-888|K30|QR-386|CP-2140/i.test(o.model));
  assert.equal(badInReceipt.length, 0, `票據機清單出現標籤機：${badInReceipt.map((o) => o.model).join(", ")}`);
  console.log("✅ 票據機清單冇標籤機型號");

  // 4. 標籤機清單一定要有國內品牌
  const labelBrands = new Set(label.map((o) => o.brand));
  const requiredDomestic = ["漢印 HPRT", "得力 Deli", "快麥 KuaiMai", "啟銳 Qirui", "佳博 Gprinter", "立象 Argox"];
  const missing = requiredDomestic.filter((b) => !labelBrands.has(b));
  assert.equal(missing.length, 0, `標籤機清單缺國內品牌：${missing.join(", ")}`);
  console.log("✅ 標籤機清單含全部國內品牌（漢印/得力/快麥/啟銳/佳博/立象）");
  console.log(`   標籤機品牌：${[...labelBrands].join(" / ")}`);

  // 5. 標籤機紙寬唔應該係 58/80mm 連續紙
  const badPaper = label.filter((o) => o.paperSize === "58mm" || o.paperSize === "80mm");
  assert.equal(badPaper.length, 0, `標籤機用咗連續紙尺寸：${badPaper.map((o) => o.model + "=" + o.paperSize).join(", ")}`);
  console.log("✅ 標籤機全部用標籤紙尺寸（唔會誤用 58/80mm 連續紙）");

  // 6. familyForRole
  assert.equal(familyForRole("label"), "label");
  assert.equal(familyForRole("zone"), "receipt");
  assert.equal(familyForRole("receipt"), "receipt");
  assert.equal(familyForRole(null), "receipt");
  console.log("✅ familyForRole 對應正確");

  // 7. resolveUsbMeta family 推斷
  const zebra = resolveUsbMeta("0x0A5F", "0x0113");
  assert.equal(zebra?.family, "label", "Zebra ZD410 應該係 label");
  const epson = resolveUsbMeta("0x04B8", "0x0E03");
  assert.equal(epson?.family, "receipt", "Epson TM-T88V 應該係 receipt");
  const hprtLabel = resolveUsbMeta("0x2A17", "0x0001");
  assert.equal(hprtLabel?.family, "label", "漢印 SL42 應該係 label");
  const hprtReceipt = resolveUsbMeta("0x2A17", "0x0101");
  assert.equal(hprtReceipt?.family, "receipt", "漢印 TP805 應該係 receipt");
  console.log("✅ resolveUsbMeta family 推斷正確（漢印同一品牌兩種族都認得）");

  // 8. alsoKnownAs
  assert.ok((hprtLabel?.alsoKnownAs ?? []).length > 0, "漢印 SL42 應該有姊妹型號");
  console.log(`✅ 姊妹型號：漢印 SL42 → ${hprtLabel.alsoKnownAs.join(" / ")}`);

  // 9. suggestLabelCommandSet
  assert.equal(suggestLabelCommandSet("斑馬 Zebra"), "zpl");
  assert.equal(suggestLabelCommandSet("立象 Argox"), "epl");
  assert.equal(suggestLabelCommandSet("漢印 HPRT"), "tspl");
  assert.equal(suggestLabelCommandSet("佳博 Gprinter"), "tspl");
  console.log("✅ 指令集建議正確（Zebra→ZPL / Argox→EPL / 國產→TSPL）");

  console.log("\n════════════════════════════════════");
  console.log("  全部 9 項斷言通過");
  console.log("════════════════════════════════════");
}

main().catch((e) => {
  console.error("❌ 測試失敗：", e.message);
  process.exit(1);
});
