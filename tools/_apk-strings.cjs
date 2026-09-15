// 解 APK 內 classes*.dex（inflate）之後掃字串 —— 判定邊個 APK 係咪含該錯誤文案
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function readCString(buf, off, len) { return buf.toString("utf8", off, off + len); }

function listZipEntries(buf) {
  // 1) 搵 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("搵唔到 EOCD（唔係 zip？）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = readCString(buf, off + 46, nameLen);
    out.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extractEntry(buf, e) {
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const dataOff = e.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataOff, dataOff + e.compSize);
  return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

const NEEDLES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["dispatch failed", "RelayState", "POS 雲端未設定", "androidReady"];

const apks = [];
(function walk(d, dep) {
  let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (["node_modules", ".git"].includes(e.name)) continue; if (dep > 6) continue; walk(p, dep + 1); }
    else if (/\.apk$/i.test(e.name)) apks.push(p);
  }
})("C:/dev", 0);

for (const apk of apks) {
  let buf;
  try { buf = fs.readFileSync(apk); } catch (e) { console.log("ERR read " + apk); continue; }
  let entries;
  try { entries = listZipEntries(buf); } catch (e) { console.log(path.basename(apk) + " → " + e.message); continue; }
  const dexes = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  if (!dexes.length) { console.log(path.basename(apk) + " → 冇 dex"); continue; }
  let blob = Buffer.alloc(0);
  for (const d of dexes) {
    try { blob = Buffer.concat([blob, extractEntry(buf, d)]); } catch (e) { console.log("  inflate fail " + d.name + ": " + e.message); }
  }
  const ver = (entries.find((e) => e.name === "AndroidManifest.xml") ? "" : "");
  const res = NEEDLES.map((s) => s + "=" + (blob.includes(Buffer.from(s, "utf8")) ? "Y" : "n"));
  console.log(
    path.basename(apk).padEnd(40) +
      " dex=" + dexes.map((d) => d.name + "(" + Math.round(d.uncompSize / 1024) + "KB)").join(",") +
      "  " + res.join("  ")
  );
}
