/**
 * 全盤搜尋：有無任何 APK 係「macau-pos 網頁的 Android 外殼」。
 *
 * 判斷方法：解 APK（zip）→ 掃：
 *   1. resources.arsc / AndroidManifest.xml / dex → 搵 macau-pos 特徵字串
 *      （vercel 網址、supabase project ref、package 名）
 *   2. assets/ 下面有無嵌住 macau-pos 的網頁
 *
 * 用法：node tools/_find-macau-pos-apk.cjs
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const NEEDLES = [
  "macau-pos-system",
  "macau-pos",
  "macau_pos",
  "macauPos",
  "vercel.app",
  "iyrywzormzisyppkokbi", // POS supabase ref
  "zymdemjflsckicwcinxl", // Ledger supabase ref
  "PosNative",
  "com.macau.pos",
  "com.posdemo",
  "com.macau.printhub",
];

const ROOTS = [
  "C:/dev",
  "C:/Users/surface/Desktop",
  "C:/Users/surface/Downloads",
  "C:/Users/surface/Documents",
];

const SKIP = new Set([
  "node_modules", ".next", ".git", "Windows", "Program Files",
  "Program Files (x86)", "ProgramData", "AppData", "$Recycle.Bin",
  "System Volume Information", "Windows.old", ".gradle", ".cache",
]);

/** 讀 zip 內所有 entry，回傳 [{name, size, data}]（只解 < 8MB 的檔） */
function readZip(buf) {
  const out = [];
  // 由尾搵 EOCD
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

    if (usize > 0 && usize < 8 * 1024 * 1024) {
      try {
        const lnlen = buf.readUInt16LE(lho + 26);
        const lelen = buf.readUInt16LE(lho + 28);
        const dataStart = lho + 30 + lnlen + lelen;
        const raw = buf.subarray(dataStart, dataStart + csize);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
        if (data) out.push({ name, size: usize, data });
      } catch (e) { /* 個別 entry 解唔到就跳過 */ }
    }
    off += 46 + nlen + elen + clen;
  }
  return out;
}

function scanApk(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  const entries = readZip(buf);
  if (!entries.length) return null;

  const found = new Map(); // needle -> [檔案名]
  for (const ent of entries) {
    const isText = /\.(xml|html|js|json|txt|css|kt|java|properties)$/i.test(ent.name);
    const isBinary = /\.(dex|arsc|so)$/i.test(ent.name);
    if (!isText && !isBinary) continue;

    const hay = ent.data.toString("latin1");
    for (const nd of NEEDLES) {
      if (hay.includes(nd)) {
        if (!found.has(nd)) found.set(nd, new Set());
        found.get(nd).add(ent.name);
      }
    }
  }
  return { entries, found };
}

// ── 主流程 ──────────────────────────────────────────────
const apks = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of es) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.apk$/i.test(e.name)) apks.push(p);
  }
}
for (const r of ROOTS) walk(r, 0);

console.log(`掃描 ${apks.length} 個 APK...\n`);

const summary = [];
for (const f of apks) {
  const r = scanApk(f);
  const st = (() => { try { return fs.statSync(f); } catch (e) { return null; } })();
  if (!r) {
    summary.push({ f, size: st?.size, mtime: st?.mtime, error: "解 zip 失敗" });
    continue;
  }
  const assets = r.entries.filter((e) => e.name.startsWith("assets/")).map((e) => e.name);
  const hasPosUrl = r.found.has("macau-pos-system") || r.found.has("vercel.app");
  summary.push({
    f, size: st?.size, mtime: st?.mtime,
    found: r.found, assets, hasPosUrl,
  });
}

summary.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

let posShellCount = 0;
for (const s of summary) {
  const rel = s.f.replace(/^C:\\dev\\/, "dev/").replace(/^C:\\Users\\surface\\/, "~/");
  const flag = s.hasPosUrl ? "  ★★★ 含 macau-pos 網址" : "";
  if (s.error) { console.log(`[!] ${rel}  (${s.error})`); continue; }
  if (flag) posShellCount++;
  console.log(`${rel}${flag}`);
  if (s.assets.length) console.log(`      assets: ${s.assets.join(", ")}`);
  if (s.found && s.found.size) {
    const hits = [];
    for (const [k, v] of s.found) hits.push(`${k}(${[...v].slice(0, 3).join("|")})`);
    console.log(`      命中: ${hits.join("  ")}`);
  }
  console.log();
}

console.log("═".repeat(60));
console.log(`總結：${summary.length} 個 APK 之中，含 macau-pos 網址的有 ${posShellCount} 個。`);
