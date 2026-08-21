// 自包含 QR 編碼器（byte mode, EC level L, version 1-5, mask 0）。
// 無外部依賴，滿足「唔引入新依賴」約定。掃碼點餐 URL 通常很短（< 50 字），v1-5 容量足夠。
// ⚠️ 部署前請實際掃一次驗證；若掃唔到，URL 文字複製仍然可用，再換成已驗證 encoder / qrcode 依賴。

type QrMatrix = { size: number; modules: boolean[][] };

const VERSION_INFO = [
  { size: 21, total: 26, data: 19, ec: 7 }, // v1
  { size: 25, total: 44, data: 34, ec: 10 }, // v2
  { size: 29, total: 70, data: 55, ec: 15 }, // v3
  { size: 33, total: 100, data: 80, ec: 20 }, // v4
  { size: 37, total: 134, data: 108, ec: 26 }, // v5
];
const ALIGN_CENTER = [0, 0, 18, 22, 26, 30];

// GF(256) 乘法表
const GF_EXP = new Array<number>(256).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GF_EXP[255] = GF_EXP[0];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

function rsGeneratorPoly(ecLen: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < gen.length - 1; i++) {
        res[i] ^= gfMul(factor, gen[i + 1]);
      }
    }
  }
  return res;
}

function formatBits(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask; // 5 bits
  let rem = data << 10;
  const g = 0b10100110111; // 0x537
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010; // 0x5412
}

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

export function encodeQrMatrix(text: string): QrMatrix | null {
  const bytes = utf8Bytes(text);
  const version = VERSION_INFO.findIndex((v, idx) => idx >= 1 && bytes.length <= v.data - 2);
  if (version < 1 || version > 5) return null; // 太長，超出 v1-5 byte 容量
  const info = VERSION_INFO[version];
  const size = info.size;

  // 建資料碼字
  const bitBuffer: number[] = [];
  const pushBits = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bitBuffer.push((value >> i) & 1);
  };
  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, 8); // char count (v1-9: 8 bits)
  for (const b of bytes) pushBits(b, 8);
  const totalBits = info.data * 8;
  // terminator
  const term = Math.min(4, totalBits - bitBuffer.length);
  for (let i = 0; i < term; i++) bitBuffer.push(0);
  while (bitBuffer.length % 8 !== 0) bitBuffer.push(0);
  const dataCodewords: number[] = [];
  for (let i = 0; i < bitBuffer.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bitBuffer[i + j];
    dataCodewords.push(byte);
  }
  // pad
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (dataCodewords.length < info.data) {
    dataCodewords.push(padBytes[p % 2]);
    p++;
  }

  const ecCodewords = rsEncode(dataCodewords, info.ec);
  const finalBytes = [...dataCodewords, ...ecCodewords];

  // 矩陣
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFinder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inFinder =
          (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) ||
          (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) ||
          (Math.max(Math.abs(dr - 3), Math.abs(dc - 3)) <= 2);
        modules[rr][cc] = inFinder;
        reserved[rr][cc] = true;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // timing
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0;
    if (!reserved[6][i]) {
      modules[6][i] = v;
      reserved[6][i] = true;
    }
    if (!reserved[i][6]) {
      modules[i][6] = v;
      reserved[i][6] = true;
    }
  }

  // alignment
  if (version >= 2) {
    const c = ALIGN_CENTER[version];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = c + dr;
        const cc = c + dc;
        const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        modules[rr][cc] = on;
        reserved[rr][cc] = true;
      }
    }
  }

  // dark module
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // 預留 format 區（之後寫）
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i++) {
      if (!(i === 6)) {
        reserved[i][8] = true;
        reserved[8][i] = true;
      }
    }
    for (let i = 0; i <= 8; i++) {
      reserved[i][size - 1 - (i === 6 ? -1 : 0)] = true;
    }
    // 簡化：直接標記 top-right / bottom-left 15 格
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) reserved[8][size - 1 - i] = true;
      if (i !== 6) reserved[size - 1 - i][8] = true;
    }
  };
  reserveFormat();

  // 放資料（之字型）
  let bitIndex = 0;
  let dir = -1;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) col--;
    for (let row = dir === -1 ? size - 1 : 0; row >= 0 && row < size; row += dir) {
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (!reserved[row][cc]) {
          const byte = finalBytes[bitIndex >> 3];
          const bit = (byte >> (7 - (bitIndex & 7))) & 1;
          modules[row][cc] = bit === 1;
          bitIndex++;
        }
      }
    }
    dir = -dir;
    col -= 2;
  }

  // mask 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) modules[r][c] = !modules[r][c];
    }
  }

  // format info（EC level L = 01, mask 0）
  const fmt = formatBits(1, 0);
  const bit = (k: number) => ((fmt >> k) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(14 - i);
  modules[7][8] = bit(8);
  modules[8][8] = bit(7);
  modules[8][7] = bit(6);
  for (let i = 0; i <= 5; i++) modules[8][5 - i] = bit(5 - i);
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = bit(14 - i);
  for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = bit(6 - i);

  return { size, modules };
}
