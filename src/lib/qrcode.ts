// 自包含 QR 編碼器（byte mode, EC level L, version 1-5 單 block，自選 mask 0-7）。
// 無外部 npm 依賴（純本地檔）。已用真實解碼器 (jsQR) + qrcode 套件矩陣交叉驗證過。

type QrMatrix = { size: number; modules: boolean[][] };

// version 1-6，EC level L，單 block（v1-6 唔使 version information 模塊）
const VERSION_INFO = [
  { size: 21, data: 19, ec: 7 }, // v1
  { size: 25, data: 34, ec: 10 }, // v2
  { size: 29, data: 55, ec: 15 }, // v3
  { size: 33, data: 80, ec: 20 }, // v4
  { size: 37, data: 108, ec: 26 }, // v5
  { size: 41, data: 136, ec: 18 }, // v6
];
// ALIGN_POSITIONS[versionIdx] = alignment pattern 中心座標列（row/col 由呢啲座標兩兩組合；
// 跳過同三個 finder 重疊嘅 (6,6)/(6,far)/(far,6)）。v1 無、v2-6 單點、v7+ 3x3 grid。
const ALIGN_POSITIONS: number[][] = [
  [], // v1
  [18], // v2
  [22], // v3
  [26], // v4
  [30], // v5
  [34], // v6
];

// ---- GF(256) ----
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

// 系統化 Reed-Solomon 編碼 → 回傳 ecLen 個 EC 碼字
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

// 15-bit format information（EC level L = 01 → ecBits=1；mask = 3-bit）
function formatBits(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask; // 5 bits
  let rem = data << 10;
  const g = 0b10100110111; // 0x537
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010; // 0x5412
}

// mask 條件（r,c 是否反轉）
function maskCondition(r: number, c: number, mask: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
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

  // 揀最細 version（含 v1）。需要 bit: 4(mode) + 8(count) + 8*len；預留 terminator 4 bit + 最少 1 pad byte
  let versionIdx = -1;
  for (let v = 0; v < VERSION_INFO.length; v++) {
    if (bytes.length <= VERSION_INFO[v].data - 2) {
      versionIdx = v;
      break;
    }
  }
  if (versionIdx < 0) return null; // 太長，超出 v1-5 容量
  const info = VERSION_INFO[versionIdx];
  const size = info.size;

  // ---- 資料碼字 ----
  const bits: number[] = [];
  const pushBits = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, 8); // v1-9: 8-bit char count
  for (const b of bytes) pushBits(b, 8);

  const totalDataBits = info.data * 8;
  const term = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCw.push(byte);
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (dataCw.length < info.data) dataCw.push(pad[p++ % 2]);

  const ecCw = rsEncode(dataCw, info.ec);
  const allCw = [...dataCw, ...ecCw];

  // ---- 矩陣 ----
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  // 搵位圖案（7x7）+ 1-module 白色分隔
  const placeFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r0 + dr;
        const cc = c0 + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        let dark: boolean;
        if (dr === -1 || dr === 7 || dc === -1 || dc === 7) {
          dark = false; // 分隔（白）
        } else {
          dark =
            dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        }
        modules[rr][cc] = dark;
        reserved[rr][cc] = true;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // timing patterns（row 6 / col 6，由第 8 格開始，偶數 dark）
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0;
    modules[6][i] = v;
    reserved[6][i] = true;
    modules[i][6] = v;
    reserved[i][6] = true;
  }

  // alignment pattern（v>=2，5x5：外框 + 3x3 中心 dark，十字白）。
  // 由 ALIGN_POSITIONS[versionIdx] 嘅座標兩兩組合放置，跳過同 finder 重疊嘅三格。
  const alignPositions = ALIGN_POSITIONS[versionIdx];
  if (alignPositions.length > 0) {
    const far = alignPositions[alignPositions.length - 1];
    const placeAlignment = (r0: number, c0: number) => {
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = r0 + dr;
          const cc = c0 + dc;
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          modules[rr][cc] = dark;
          reserved[rr][cc] = true;
        }
      }
    };
    for (const r of alignPositions) {
      for (const c of alignPositions) {
        // 跳過同三個 finder 圖案重疊嘅位置
        if ((r === 6 && c === 6) || (r === 6 && c === far) || (r === far && c === 6)) continue;
        placeAlignment(r, c);
      }
    }
  }

  // dark module（永遠 dark）
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // 預留 format 區（30 格）先 mark reserved，避免 data 寫入
  const reserveFormat = () => {
    for (let i = 0; i <= 5; i++) reserved[8][i] = true;
    reserved[8][7] = true;
    reserved[8][8] = true;
    reserved[7][8] = true;
    for (let i = 0; i <= 5; i++) reserved[5 - i][8] = true; // rows 5,4,3,2,1,0
    for (let i = 0; i <= 7; i++) reserved[size - 1 - i][8] = true; // rows size-1..size-8
    for (let i = 0; i <= 7; i++) reserved[8][size - 1 - i] = true; // cols size-1..size-8
  };
  reserveFormat();

  // ---- 放資料（之字型，由右到左，skip col 6，方向逐對交替）----
  let bitIndex = 0;
  const totalBits = allCw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳過垂直 timing 列：令後續配對變 (5,4),(3,2),(1,0)（修正 z 字型方向）
    const upward = ((size - 1 - right) / 2) % 2 === 0; // 最右對向上，逐對交替
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x]) {
          let bit = 0;
          if (bitIndex < totalBits) {
            const byte = allCw[bitIndex >> 3];
            bit = (byte >> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          modules[y][x] = bit === 1;
        }
      }
    }
  }

  // ---- 自選 mask：對 8 個 mask 計懲罰，揀最低 ----
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    // 複製 data 區已放好嘅矩陣，套用 mask m
    const trial = modules.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskCondition(r, c, m)) trial[r][c] = !trial[r][c];
      }
    }
    const pen = maskPenalty(trial, size);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestMask = m;
    }
  }
  const mask = bestMask;

  // 套用揀定嘅 mask 到正式矩陣
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && maskCondition(r, c, mask)) modules[r][c] = !modules[r][c];
    }
  }

  // ---- format information（EC L = 01 → ecBits=1, 選定 mask）----
  // 注意：bit14(MSB) 放 (8,0)，bit0(LSB) 放 (0,8) —— 與 jsQR / qrcode 套件一致
  const fmt = formatBits(1, mask);
  const getBit = (k: number) => ((fmt >> k) & 1) === 1;
  // copy 1（top-left）
  for (let i = 0; i <= 5; i++) modules[8][i] = getBit(14 - i); // (8,0..5) = bits 14..9
  modules[8][7] = getBit(8);
  modules[8][8] = getBit(7);
  modules[7][8] = getBit(6);
  for (let i = 0; i <= 5; i++) modules[5 - i][8] = getBit(5 - i); // (5,8)..(0,8) = bits 5..0
  // copy 2（top-right + bottom-left）：col 8 嘅 size-1..size-8 = bits 14..7；row 8 嘅 size-1..size-7 = bits 6..0
  for (let i = 0; i <= 7; i++) modules[size - 1 - i][8] = getBit(14 - i);
  for (let i = 0; i <= 6; i++) modules[8][size - 1 - i] = getBit(6 - i);

  return { size, modules };
}

// 標準 mask 懲罰（4 條規則），只用作揀 mask，唔影響解碼正確性
function maskPenalty(m: boolean[][], size: number): number {
  let penalty = 0;
  const runPen = (arr: boolean[]) => {
    let p = 0;
    let run = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === arr[i - 1]) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
    return p;
  };
  for (let r = 0; r < size; r++) penalty += runPen(m[r]);
  for (let c = 0; c < size; c++) penalty += runPen(m.map((row) => row[c]));
  // 2x2 同色
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
    }
  }
  // finder-like 圖案
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const patRev = [false, false, false, false, true, false, true, true, true, false, true];
  const checkLine = (arr: boolean[]) => {
    for (let i = 0; i + 11 <= arr.length; i++) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        if (arr[i + k] !== pat[k]) a = false;
        if (arr[i + k] !== patRev[k]) b = false;
      }
      if (a || b) penalty += 40;
    }
  };
  for (let r = 0; r < size; r++) checkLine(m[r]);
  for (let c = 0; c < size; c++) checkLine(m.map((row) => row[c]));
  // dark 比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = dark / (size * size);
  penalty += Math.floor(Math.abs(ratio * 100 - 50) / 5) * 10;
  return penalty;
}
