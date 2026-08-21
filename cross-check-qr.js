// 交叉對比：qrcode 套件（強行 EC-L + mask 0）vs 我嘅 encoder，逐格 diff。
const NP = "C:/Users/surface/.workbuddy/binaries/node/workspace/node_modules/";
const QRCode = require(NP + "qrcode");

// ===== 我嘅 encoder（同 qrcode.ts 一致）=====
const VERSION_INFO = [
  { size: 21, data: 19, ec: 7 },
  { size: 25, data: 34, ec: 10 },
  { size: 29, data: 55, ec: 15 },
  { size: 33, data: 80, ec: 20 },
  { size: 37, data: 108, ec: 26 },
];
const ALIGN_CENTER = [0, 0, 18, 22, 26, 30];
const GF_EXP = new Array(256).fill(0);
const GF_LOG = new Array(256).fill(0);
(() => { let x = 1; for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } GF_EXP[255] = GF_EXP[0]; })();
function gfMul(a, b) { if (a === 0 || b === 0) return 0; return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255]; }
function rsGeneratorPoly(ecLen) { let poly = [1]; for (let i = 0; i < ecLen; i++) { const next = new Array(poly.length + 1).fill(0); for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); } poly = next; } return poly; }
function rsEncode(data, ecLen) { const gen = rsGeneratorPoly(ecLen); const res = new Array(ecLen).fill(0); for (const b of data) { const factor = b ^ res[0]; res.shift(); res.push(0); if (factor !== 0) for (let i = 0; i < gen.length - 1; i++) res[i] ^= gfMul(factor, gen[i + 1]); } return res; }
function formatBits(ecBits, mask) { const data = (ecBits << 3) | mask; let rem = data << 10; const g = 0b10100110111; for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10); return ((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010; }
function utf8Bytes(text) { const out = []; for (let i = 0; i < text.length; i++) { let c = text.charCodeAt(i); if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); else if (c >= 0xd800 && c <= 0xdbff) { const c2 = text.charCodeAt(++i); const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); } return out; }
function encodeQrMatrix(text) {
  const bytes = utf8Bytes(text);
  let versionIdx = -1; for (let v = 0; v < VERSION_INFO.length; v++) { if (bytes.length <= VERSION_INFO[v].data - 2) { versionIdx = v; break; } }
  if (versionIdx < 0) return null;
  const info = VERSION_INFO[versionIdx]; const size = info.size;
  const bits = []; const pushBits = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  pushBits(0b0100, 4); pushBits(bytes.length, 8); for (const b of bytes) pushBits(b, 8);
  const totalDataBits = info.data * 8; const term = Math.min(4, totalDataBits - bits.length); for (let i = 0; i < term; i++) bits.push(0); while (bits.length % 8 !== 0) bits.push(0);
  const dataCw = []; for (let i = 0; i < bits.length; i += 8) { let byte = 0; for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]; dataCw.push(byte); }
  const pad = [0xec, 0x11]; let p = 0; while (dataCw.length < info.data) dataCw.push(pad[p++ % 2]);
  const ecCw = rsEncode(dataCw, info.ec); const allCw = [...dataCw, ...ecCw];
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const placeFinder = (r0, c0) => { for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) { const rr = r0 + dr, cc = c0 + dc; if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue; let dark; if (dr === -1 || dr === 7 || dc === -1 || dc === 7) dark = false; else dark = dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4); modules[rr][cc] = dark; reserved[rr][cc] = true; } };
  placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { const v = i % 2 === 0; modules[6][i] = v; reserved[6][i] = true; modules[i][6] = v; reserved[i][6] = true; }
  const center = ALIGN_CENTER[versionIdx + 1]; if (center !== 0) for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const rr = center + dr, cc = center + dc; const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1; modules[rr][cc] = dark; reserved[rr][cc] = true; }
  modules[size - 8][8] = true; reserved[size - 8][8] = true;
  const reserveFormat = () => { for (let i = 0; i <= 5; i++) reserved[8][i] = true; reserved[8][7] = true; reserved[8][8] = true; reserved[7][8] = true; for (let i = 0; i <= 5; i++) reserved[5 - i][8] = true; for (let i = 0; i <= 7; i++) reserved[size - 1 - i][8] = true; for (let i = 0; i <= 7; i++) reserved[8][size - 1 - i] = true; };
  reserveFormat();
  let bitIndex = 0; const totalBits = allCw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) { const col = right === 6 ? 5 : right; for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = col - j; const upward = ((col + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert; if (!reserved[y][x]) { let bit = 0; if (bitIndex < totalBits) { const byte = allCw[bitIndex >> 3]; bit = (byte >> (7 - (bitIndex & 7))) & 1; bitIndex++; } modules[y][x] = bit === 1; } } }
  const mask = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c] && (r + c) % 2 === 0) modules[r][c] = !modules[r][c];
  const fmt = formatBits(1, mask); const getBit = (k) => ((fmt >> k) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[8][i] = getBit(i); modules[8][7] = getBit(6); modules[8][8] = getBit(7); modules[7][8] = getBit(8); for (let i = 9; i <= 14; i++) modules[14 - i][8] = getBit(i);
  for (let i = 0; i <= 7; i++) modules[size - 1 - i][8] = getBit(i); for (let i = 8; i <= 14; i++) modules[8][size - 15 + i] = getBit(i);
  return { size, modules };
}

function renderToImage(matrix, scale = 8, quiet = 4) {
  const total = matrix.size + quiet * 2; const dim = total * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) {
    const mr = Math.floor(y / scale) - quiet; const mc = Math.floor(x / scale) - quiet;
    const dark = mr >= 0 && mr < matrix.size && mc >= 0 && mc < matrix.size && matrix.modules[mr][mc];
    const o = (y * dim + x) * 4; data[o] = dark ? 0 : 255; data[o + 1] = dark ? 0 : 255; data[o + 2] = dark ? 0 : 255; data[o + 3] = 255;
  }
  return { data, width: dim, height: dim };
}

// qrcode 套件：強行 byte mode + EC L，並強行 mask 0
function refMatrix(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  // qr.modules.size, qr.modules.data (Uint8Array, row-major, 1=dark)
  const size = qr.modules.size;
  const d = qr.modules.data;
  const m = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => d[r * size + c] === 1));
  return { size, modules: m };
}

const tests = [
  "HELLO WORLD",
  "https://macau-pos-system.vercel.app/order?tableId=T1&store=macau-store-a",
  "1234567890",
];

for (const t of tests) {
  const mine = encodeQrMatrix(t);
  const ref = refMatrix(t);
  console.log(`\n=== "${t}" mineSize=${mine.size} refSize=${ref.size} ===`);
  if (mine.size !== ref.size) { console.log("  SIZE MISMATCH"); continue; }
  let diffs = 0; const sample = [];
  for (let r = 0; r < mine.size; r++) for (let c = 0; c < mine.size; c++) {
    if (mine.modules[r][c] !== ref.modules[r][c]) { diffs++; if (sample.length < 12) sample.push(`(${r},${c})`); }
  }
  console.log(`  diffs=${diffs} sample=${sample.join(" ")}`);
}
