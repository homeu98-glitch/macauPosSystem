/**
 * 嚴格判別：邊個 APK 真係「macau-pos 網頁外殼」。
 *
 * 假陽性警告：`membership-driver-*` 都命中 `vercel.app`，但嗰個係佢自己嘅後端 API，
 * 唔係載入 macau-pos 網頁。所以「命中字串」≠「外殼」。
 *
 * 嚴格判據（三條同時成立才算外殼）：
 *   1. dex 同時含 `macau-pos-system.vercel.app`（完整 POS 網址）
 *   2. dex 含 `PosNative`（WebView bridge 名）
 *   3. dex 含 `addJavascriptInterface` 或 `WebView`（真係用 WebView 載網頁）
 *
 * 並列出每個 APK 嘅「完整 URL 字串」抽樣，睇佢載入邊個網址。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const APKS = [
  "C:/Users/surface/Desktop/macau-print-hub-v1.1.5.apk",
  "C:/dev/print-agent-android/app/build/outputs/apk/debug/app-debug.apk",
  "C:/dev/print-hub-v1.1.1.apk",
  "C:/dev/print-agent-android/print-agent-1.1.1-debug-HARDENED.apk",
  "C:/dev/print-agent-android-debug.apk",
  "C:/Users/surface/Desktop/membershipDeliveryDriver/membership-driver-1.0.8-manual-download-fixed.apk",
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
    if (usize > 0 && usize < 12 * 1024 * 1024) {
      try {
        const lnlen = buf.readUInt16LE(lho + 26);
        const lelen = buf.readUInt16LE(lho + 28);
        const dataStart = lho + 30 + lnlen + lelen;
        const raw = buf.subarray(dataStart, dataStart + csize);
        let data = method === 0 ? raw : zlib.inflateRawSync(raw);
        if (data) out.push({ name, data });
      } catch (e) {}
    }
    off += 46 + nlen + elen + clen;
  }
  return out;
}

/** 由 latin1 字串抽完整 http(s) URL */
function extractUrls(hay) {
  const set = new Set();
  const re = /https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{4,120}/g;
  let m;
  while ((m = re.exec(hay))) {
    let u = m[0].replace(/[.,;)\]]+$/, "");
    if (u.includes("schemas.android.com")) continue;
    if (u.includes("w3.org")) continue;
    if (u.includes("apache.org")) continue;
    if (u.includes("example.com")) continue;
    set.add(u);
  }
  return [...set];
}

for (const f of APKS) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { console.log(`[讀不到] ${f}`); continue; }
  const entries = readZip(buf);
  const dexes = entries.filter((e) => /\.dex$/.test(e.name));

  let allText = "";
  for (const d of dexes) allText += d.data.toString("latin1");

  // 命中的網頁資產
  const webAssets = entries.filter((e) =>
    /^assets\/.*\.html?$/i.test(e.name) ||
    /^assets\/.*\.(js|json)$/i.test(e.name)
  ).map((e) => e.name);

  const hasFullPosUrl = allText.includes("macau-pos-system.vercel.app");
  const hasPosNative = allText.includes("PosNative");
  const hasAddJsInterface = allText.includes("addJavascriptInterface");
  const hasWebView = allText.includes("WebView");
  const hasLoadUrl = allText.includes("loadUrl");
  const isShell = hasFullPosUrl && hasPosNative && (hasAddJsInterface || hasWebView);

  const urls = extractUrls(allText)
    .filter((u) => !/android|google|kotlin|jetbrains|github|bouncycastle|json\.org|square/i.test(u))
    .slice(0, 12);

  console.log("═".repeat(70));
  console.log(path.basename(f));
  console.log("  ▸ 完整 POS 網址 (macau-pos-system.vercel.app) : " + (hasFullPosUrl ? "YES" : "no"));
  console.log("  ▸ PosNative bridge                            : " + (hasPosNative ? "YES" : "no"));
  console.log("  ▸ addJavascriptInterface                      : " + (hasAddJsInterface ? "YES" : "no"));
  console.log("  ▸ WebView / loadUrl                           : " + (hasWebView ? "Y" : "n") + " / " + (hasLoadUrl ? "Y" : "n"));
  console.log("  ▸ 內建網頁資產                                 : " + (webAssets.length ? webAssets.join(", ") : "（無）"));
  console.log("  ▸ 抽取到的網址:");
  urls.forEach((u) => console.log("       " + u));
  console.log("  ★ 判定：" + (isShell ? "【是 macau-pos 網頁外殼】" : "不是外殼"));
  console.log();
}
