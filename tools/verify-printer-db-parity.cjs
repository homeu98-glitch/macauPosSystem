/**
 * 驗證：POS 側 `printer-models.ts` 同 Companion 側 `companion-server.mjs`
 * 嘅 USB_PRINTER_DB **VID / PID / family 三重一致**。
 *
 * 為何要呢個：兩份表各自硬編，加新品牌時極容易只改一邊。改一邊唔會 throw，
 * 只會令「網站認到嘅機」同「Companion 認到嘅機」唔同 → 商家見到嘅型號名唔一致。
 *
 * 做法：唔用 regex 硬拆（太脆），而係把 object literal 由源碼切出嚟、
 * 用 `new Function` 求值成真 JS object，再逐欄比對。
 *
 * 跑法：node tools/verify-printer-db-parity.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const POS_SRC = path.resolve(__dirname, "../src/lib/print-bridge/printer-models.ts");
const COMPANION_SRC = path.resolve("C:/dev/desktop-companion/companion-server.mjs");

/** 由源碼切出 `{ ... }` 物件字面量（由第一個 `{` 起，用括號配對找收尾） */
function sliceObjectLiteral(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`搵唔到 ${startMarker}`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, k + 1);
    }
  }
  throw new Error(`括號唔配對（${startMarker}）`);
}

/** 求值成 object。物件字面量只含字串/數字/巢狀物件，冇函式 → 安全。 */
function evalLiteral(literal) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

/**
 * TS 側有 `export const USB_PRINTER_DB: Record<...> = {` 類型標註，
 * 切出嚟嘅 literal 本身係純 object，可以直接求值。
 */
function loadPosDb() {
  const src = fs.readFileSync(POS_SRC, "utf8");
  const literal = sliceObjectLiteral(src, "export const USB_PRINTER_DB");
  return evalLiteral(literal);
}

function loadCompanionDb() {
  const src = fs.readFileSync(COMPANION_SRC, "utf8");
  const literal = sliceObjectLiteral(src, "const USB_PRINTER_DB =");
  return evalLiteral(literal);
}

function main() {
  const posDb = loadPosDb();
  const compDb = loadCompanionDb();

  const posVids = Object.keys(posDb).sort();
  const compVids = Object.keys(compDb).sort();
  const posModelCount = posVids.reduce((n, v) => n + Object.keys(posDb[v].models || {}).length, 0);
  const compModelCount = compVids.reduce((n, v) => n + Object.keys(compDb[v].models || {}).length, 0);

  console.log(`POS 側　　　：${posVids.length} VID / ${posModelCount} 型號`);
  console.log(`Companion 側：${compVids.length} VID / ${compModelCount} 型號`);

  const onlyPos = posVids.filter((v) => !compVids.includes(v));
  const onlyComp = compVids.filter((v) => !posVids.includes(v));
  assert.equal(onlyPos.length, 0, `POS 有但 Companion 冇：${onlyPos.join(", ")}`);
  assert.equal(onlyComp.length, 0, `Companion 有但 POS 冇：${onlyComp.join(", ")}`);
  console.log("✅ VID 集合完全一致");

  const mismatches = [];
  for (const vid of posVids) {
    const a = posDb[vid];
    const b = compDb[vid];
    if (a.brand !== b.brand) mismatches.push(`${vid} brand：POS="${a.brand}" vs Comp="${b.brand}"`);
    const famA = a.defaultFamily || "receipt";
    const famB = b.defaultFamily || "receipt";
    if (famA !== famB) mismatches.push(`${vid} defaultFamily：POS="${famA}" vs Comp="${famB}"`);

    const pidsA = Object.keys(a.models || {});
    const pidsB = Object.keys(b.models || {});
    for (const pid of pidsA) {
      if (!pidsB.includes(pid)) {
        mismatches.push(`${vid}/${pid} 型號只喺 POS 有（${a.models[pid].model}）`);
        continue;
      }
      const mA = a.models[pid];
      const mB = b.models[pid];
      const mFamA = mA.family || famA;
      const mFamB = mB.family || famB;
      if (mFamA !== mFamB) {
        mismatches.push(`${vid}/${pid} family：POS="${mFamA}" vs Comp="${mFamB}"（${mA.model}）`);
      }
    }
    for (const pid of pidsB) {
      if (!pidsA.includes(pid)) mismatches.push(`${vid}/${pid} 型號只喺 Companion 有（${b.models[pid].model}）`);
    }
  }
  assert.equal(mismatches.length, 0, `\n不一致項：\n  ${mismatches.join("\n  ")}`);
  console.log("✅ 品牌 / defaultFamily / PID 集合 / 逐型號 family 全部一致");

  // 標籤機品牌必須兩邊都 defaultFamily === "label"
  const labelBrands = ["漢印 HPRT", "得力 Deli", "快麥 KuaiMai", "啟銳 Qirui", "立象 Argox", "斑馬 Zebra", "台半 TSC"];
  const missing = [];
  for (const brand of labelBrands) {
    const inPos = Object.values(posDb).some((v) => v.brand === brand && v.defaultFamily === "label");
    const inComp = Object.values(compDb).some((v) => v.brand === brand && v.defaultFamily === "label");
    if (!inPos || !inComp) missing.push(`${brand}（POS:${inPos} Comp:${inComp}）`);
  }
  assert.equal(missing.length, 0, `標籤機品牌未同步：${missing.join(", ")}`);
  console.log(`✅ 標籤機品牌兩邊都 defaultFamily="label"（${labelBrands.length} 個）`);

  // 標籤機型號唔可以用連續紙尺寸
  const badPaper = [];
  for (const [vid, vendor] of Object.entries(posDb)) {
    for (const [pid, m] of Object.entries(vendor.models || {})) {
      const fam = m.family || vendor.defaultFamily || "receipt";
      if (fam !== "label") continue;
      if (m.paperSize === "58mm" || m.paperSize === "80mm") {
        badPaper.push(`${vid}/${pid} ${m.model}=${m.paperSize}`);
      }
    }
  }
  assert.equal(badPaper.length, 0, `標籤機用咗連續紙尺寸：${badPaper.join(", ")}`);
  console.log("✅ 標籤機型號全部用標籤紙尺寸（無 58/80mm 連續紙）");

  console.log("\n════════════════════════════════════");
  console.log("  兩份型號表完全同步");
  console.log("════════════════════════════════════");
}

try {
  main();
} catch (e) {
  console.error("❌ 失敗：", e.message);
  process.exit(1);
}
