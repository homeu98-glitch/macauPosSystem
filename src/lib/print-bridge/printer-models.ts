/**
 * 打印機型號表（Meituan 式自動偵測）。
 *
 * 當 Companion 桌面代理經 node-usb 枚舉到 USB 打印機，會回傳 vendorId / productId，
 * 呢度按 VID/PID 對照出品牌、型號、預設 ESC/POS 編碼同紙張尺寸，令商家唔使手填 VID/PID。
 *
 * 同 desktop-companion/companion-server.mjs 嘅 USB_PRINTER_DB 保持大致一致；
 * 客戶端呢份主要用於 UI 下拉預設值同 fallback（server 已經resolve 咗就優先用 server 嘅）。
 */

export type CharsetValue = "gb18030" | "gbk" | "big5" | "utf-8";
export type PaperSizeValue = "58mm" | "80mm" | "62mm" | "100x75mm";

export interface UsbModelMeta {
  model: string;
  charset: CharsetValue;
  paperSize: PaperSizeValue;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  空缺 = 用品牌預設 / 最終渲染器 fallback GS ! n（安全值）。 */
  kanjiEnlarge?: "FS!" | "GS!";
}

export interface UsbVendorMeta {
  brand: string;
  /** 預設 ESC/POS 編碼（該品牌大多數機型共用） */
  defaultCharset: CharsetValue;
  defaultPaperSize: PaperSizeValue;
  /** 品牌預設中文倍大指令；標準 ESC/POS 機多數 FS ! n，商頌 POS-80 等例外 GS ! n */
  defaultKanjiEnlarge?: "FS!" | "GS!";
  /** 已知 PID → 型號；冇命中就用 brand 同名 fallback */
  models: Record<string, UsbModelMeta>;
}

/** VID → 品牌 / 型號對照表（key 為 0xXXXX 大寫十六進制） */
export const USB_PRINTER_DB: Record<string, UsbVendorMeta> = {
  "0x04B8": {
    brand: "Epson",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0202": { model: "Epson TM-T88IV", charset: "gb18030", paperSize: "80mm" },
      "0x0E03": { model: "Epson TM-T88V", charset: "gb18030", paperSize: "80mm" },
      "0x0E15": { model: "Epson TM-T88VI", charset: "gb18030", paperSize: "80mm" },
      "0x0203": { model: "Epson TM-T81II", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0519": {
    brand: "Star",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0006": { model: "Star TSP100 (TSP143)", charset: "gb18030", paperSize: "80mm" },
      "0x000D": { model: "Star mC-Print2", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x04CB": {
    brand: "Citizen",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x1005": { model: "Citizen CT-S310II", charset: "gb18030", paperSize: "80mm" },
      "0x109B": { model: "Citizen CT-S4000", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0483": {
    brand: "Xprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x5740": { model: "Xprinter XP-Q800 / Q200", charset: "gb18030", paperSize: "80mm" },
      "0x7000": { model: "Xprinter XP-58 / 80 series", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0416": {
    brand: "Gprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x5011": { model: "Gprinter GP-58 / 80 series", charset: "gb18030", paperSize: "80mm" },
      "0xAE01": { model: "Gprinter GP-U80300", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x1A03": {
    brand: "Gprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0042": { model: "Gprinter GP-58MBIII", charset: "gb18030", paperSize: "58mm" },
    },
  },
  "0x1FC9": {
    brand: "Zjiang",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x2016": { model: "Zjiang ZJ-5805 / 5890", charset: "gb18030", paperSize: "58mm" },
      "0x2022": { model: "Zjiang ZJ-80", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x2BDF": {
    brand: "Rongta",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0101": { model: "Rongta RP80 / RP58", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x04F9": {
    brand: "Brother",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x2049": { model: "Brother TD-2xxx / RJ series", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0A5F": {
    brand: "Zebra",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    models: {
      "0x0113": { model: "Zebra ZD410 (label)", charset: "utf-8", paperSize: "100x75mm" },
      "0x2011": { model: "Zebra ZD420 (label)", charset: "utf-8", paperSize: "100x75mm" },
    },
  },
  "0x1203": {
    brand: "TSC",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    models: {
      "0x0002": { model: "TSC TTP-244 Pro (label)", charset: "utf-8", paperSize: "100x75mm" },
    },
  },
  "0x0C2E": {
    brand: "SAM4S",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0500": { model: "SAM4S GIANT-100", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0498": {
    brand: "Bixolon",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    models: {
      "0x0672": { model: "Bixolon SRP-350III", charset: "gb18030", paperSize: "80mm" },
    },
  },
};

/** 已知嘅打印機 VID 集合（用嚟判斷枚舉到嘅 USB 設備係咪打印機） */
export const KNOWN_USB_PRINTER_VIDS = new Set(Object.keys(USB_PRINTER_DB));

/** 將各種格式嘅 VID/PID 歸一化為 "0xXXXX" 大寫十六進制字串 */
export function toHexId(raw: string | number | undefined | null): string {
  if (raw == null) return "";
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const s = String(raw).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      n = parseInt(s, 16);
    } else if (/^\d+$/.test(s)) {
      n = parseInt(s, 10);
    } else {
      return "";
    }
  }
  if (!Number.isFinite(n) || n <= 0) return "";
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

export interface ResolvedUsbMeta {
  brand: string;
  model: string;
  charset: CharsetValue;
  paperSize: PaperSizeValue;
  /** 中文倍大指令：標準機 FS ! n / 商頌 POS-80 等 GS ! n；渲染器最終 fallback GS ! n */
  kanjiEnlarge: "FS!" | "GS!";
  /** true = VID/PID 命中型號表；false = 認到 VID 但未有精確型號（用品牌預設） */
  generic: boolean;
}

/**
 * 由 vendorId / productId 解析出品牌、型號、編碼、紙張尺寸。
 * 未命中任何已知 VID 時返回 null（認唔到，唔係打印機或資料庫未收錄）。
 */
export function resolveUsbMeta(
  vendorId: string | number | undefined | null,
  productId: string | number | undefined | null,
): ResolvedUsbMeta | null {
  const vid = toHexId(vendorId);
  if (!vid || !KNOWN_USB_PRINTER_VIDS.has(vid)) return null;
  const vendor = USB_PRINTER_DB[vid];
  const pid = toHexId(productId);
  const model = pid ? vendor.models[pid] : undefined;
  if (model) {
    return {
      brand: vendor.brand,
      model: model.model,
      charset: model.charset,
      paperSize: model.paperSize,
      kanjiEnlarge: model.kanjiEnlarge || vendor.defaultKanjiEnlarge || "FS!",
      generic: false,
    };
  }
  return {
    brand: vendor.brand,
    model: vendor.brand,
    charset: vendor.defaultCharset,
    paperSize: vendor.defaultPaperSize,
    kanjiEnlarge: vendor.defaultKanjiEnlarge || "FS!",
    generic: true,
  };
}

/** 由品牌拎預設編碼同紙張尺寸（未命中型號表 fallback 用） */
export function resolveModelDefaults(brand: string): {
  charset: CharsetValue;
  paperSize: PaperSizeValue;
} {
  const found = Object.values(USB_PRINTER_DB).find((v) => v.brand === brand);
  if (found) return { charset: found.defaultCharset, paperSize: found.defaultPaperSize };
  return { charset: "gb18030", paperSize: "80mm" };
}

export const PAPER_SIZE_OPTIONS: PaperSizeValue[] = ["58mm", "80mm", "62mm", "100x75mm"];

export const CHARSET_OPTIONS: Array<{ value: CharsetValue; label: string }> = [
  { value: "gb18030", label: "GB18030（簡/繁中，預設）" },
  { value: "gbk", label: "GBK（簡中）" },
  { value: "big5", label: "Big5（繁中）" },
  { value: "utf-8", label: "UTF-8（通用，標籤機常用）" },
];

/** 冇自動偵測到紙張/編碼時嘅安全預設 */
export const DEFAULT_CHARSET: CharsetValue = "gb18030";
export const DEFAULT_PAPER_SIZE: PaperSizeValue = "80mm";

// ─────────────────────────────────────────────────────────────
// LAN 型號列表（Meituan 式 Wizard Step 2 用）
// ─────────────────────────────────────────────────────────────

export interface LanModelOption {
  brand: string;
  model: string;
  charset: CharsetValue;
  paperSize: PaperSizeValue;
  kanjiEnlarge: "FS!" | "GS!";
}

/**
 * 產生 LAN 手動選擇用嘅型號列表。
 * 扁平化 USB_PRINTER_DB + 通用兜底 + 商頌 POS-80 明確列出。
 */
export function getLanModelOptions(): LanModelOption[] {
  const opts: LanModelOption[] = [];
  for (const [, vendor] of Object.entries(USB_PRINTER_DB)) {
    for (const [, model] of Object.entries(vendor.models)) {
      opts.push({
        brand: vendor.brand,
        model: model.model,
        charset: model.charset,
        paperSize: model.paperSize,
        kanjiEnlarge: model.kanjiEnlarge || vendor.defaultKanjiEnlarge || "FS!",
      });
    }
  }
  // 通用兜底（商頌 POS-80 等 USB Printer Class 設備，LAN 版本同型號）
  opts.push({
    brand: "通用 ESC/POS",
    model: "通用 80mm 熱敏打印機",
    charset: "gb18030",
    paperSize: "80mm",
    kanjiEnlarge: "GS!",
  });
  opts.push({
    brand: "通用 ESC/POS",
    model: "通用 58mm 熱敏打印機",
    charset: "gb18030",
    paperSize: "58mm",
    kanjiEnlarge: "GS!",
  });
  // 商頌 POS-80 明確列出（如果 Gprinter GP-U80300 已喺表度就唔重複加）
  const hasShangsong = opts.some((o) => o.brand === "Gprinter" && o.model.includes("GP-U80300"));
  if (!hasShangsong) {
    opts.push({
      brand: "商頌",
      model: "POS-80",
      charset: "gb18030",
      paperSize: "80mm",
      kanjiEnlarge: "GS!",
    });
  }
  return opts;
}
