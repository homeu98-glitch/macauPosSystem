/**
 * 驗證 print-agent APK 內是否真帶 docs/114 的修正特徵。
 * 重點：唔可以淨睇源碼 —— 要證明「byte 真係入咗 APK」（docs/114 教訓：改好代碼 ≠ 行為改變）。
 */
const fs = require("fs");
const zlib = require("zlib");

const APK = process.argv[2] || "C:/dev/print-agent-android/app/build/outputs/apk/debug/app-debug.apk";

/** 必要特徵（缺一即 = 修正未入包） */
const REQUIRED = [
  ["1.1.4", "版本字串（驗收錨點）"],
  ["clearMagnify", "每行清放大殘留（修『分格線一條變兩條』）"],
  ["GS_SIZE_BYTE", "GS ! nibble 語意表（修『菜名字體拉長變形』）"],
  ["FS_SIZE_BYTE", "FS ! 正確放大位元"],
  ["emitLine", "逐行 emit 字型指令"],
  ["PosNative", "WebView bridge（收銀台外殼憑據）"],
];

/** 舊版殘留（應該 = 冇） */
const FORBIDDEN = [
  ["KANJI_SIZE_BYTE", "舊版誤用 ESC! 位元值做 Kanji 放大的常數名"],
];

function readZip(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    if (usize > 0 && usize < 16 * 1024 * 1024) {
      try {
        const lnlen = buf.readUInt16LE(lho + 26);
        const lelen = buf.readUInt16LE(lho + 28);
        const ds = lho + 30 + lnlen + lelen;
        const raw = buf.subarray(ds, ds + csize);
        let data = method === 0 ? raw : zlib.inflateRawSync(raw);
        if (data) out.push({ name, data });
      } catch (e) {}
    }
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const buf = fs.readFileSync(APK);
const st = fs.statSync(APK);
const entries = readZip(buf);

// dex 內容要解壓（APK 內 dex 係 DEFLATE）
const dexText = entries
  .filter((e) => /\.dex$/.test(e.name))
  .map((e) => e.data.toString("latin1"))
  .join("\n");
const assetText = entries
  .filter((e) => /^assets\/.*\.(html|js)$/i.test(e.name))
  .map((e) => e.data.toString("utf8"))
  .join("\n");

const hay = dexText + "\n" + assetText;

console.log("═".repeat(66));
console.log("APK :", APK.replace("C:/dev/print-agent-android/", ""));
console.log("大小:", st.size, "bytes");
console.log("時間:", st.mtime.toISOString());
console.log("dex 檔數:", entries.filter((e) => /\.dex$/.test(e.name)).length);
console.log("=" .repeat(66));
console.log("\n▸ 必要特徵（必須全部 = YES）\n");
let pass = true;
for (const [needle, why] of REQUIRED) {
  const ok = hay.includes(needle);
  if (!ok) pass = false;
  console.log(`  ${ok ? "[YES]" : "[NO ]"}  ${needle.padEnd(18)} ${why}`);
}

console.log("\n▸ 舊版殘留（應該 = NO）\n");
for (const [needle, why] of FORBIDDEN) {
  const found = hay.includes(needle);
  if (found) pass = false;
  console.log(`  ${found ? "[⚠ 有殘留]" : "[乾淨]" }  ${needle.padEnd(18)} ${why}`);
}

console.log("\n" + "═".repeat(66));
console.log(pass ? "★ 全部通過：docs/114 修正確實在 APK 入面" : "✗ 有項目未通過");
process.exit(pass ? 0 : 1);
