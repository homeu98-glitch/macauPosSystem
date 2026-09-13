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
/**
 * 紙張尺寸。
 *
 * ⚠️ **票據機**（58 / 80mm 連續紙）同**標籤機**（WxHmm 成卷標籤）**共用呢個 union**。
 * 原因：`DevicePrinterConfig.paperSize` 係單一字串欄位，收窄成兩個 union 會令
 * 既有設定檔讀唔到。標籤機嘅 `100x75mm` 早已經喺度（見 docs/124 §D8）。
 *
 * 2026-09-13 補上 40x30 / 50x30 / 60x40 / 70x50 —— 同 `LABEL_PAPER_PRESETS`
 * 口徑對齊，否則標籤機型號表填唔到呢幾個尺寸。
 */
export type PaperSizeValue =
  | "58mm"
  | "80mm"
  | "62mm"
  | "40x30mm"
  | "50x30mm"
  | "60x40mm"
  | "70x50mm"
  | "100x75mm";

/**
 * 打印機硬件族 —— **決定 wizard Step 2 顯示邊份型號清單**。
 *
 * 🔴 2026-09-13 新增。呢個欄位係「標籤機唔應該見到票據機型號」嘅唯一閘門：
 * 在此之前 `getLanModelOptions()` 無參數、回傳整份表，所以商家揀「標籤機」時
 * 見到嘅係 Epson TM-T88V / MTDP-58MBIII 等**票據機**型號，揀完落去紙寬係 80mm
 * 而機係 100×75mm 標籤卷 → 出紙亂版（見 docs/144）。
 *
 * - `receipt`  = 票據 / 廚房單熱敏機（58 / 80mm 連續紙）—— 可當 zone 或 receipt 用
 * - `label`    = 標籤機（間隙 / 黑標定位，成卷標籤）—— **唔食 ESC/POS 連續紙指令**
 * - `portable` = 便攜藍牙票據機（58mm，內置電池）
 */
export type PrinterFamily = "receipt" | "label" | "portable";

export interface UsbModelMeta {
  model: string;
  charset: CharsetValue;
  paperSize: PaperSizeValue;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  空缺 = 用品牌預設 / 最終渲染器 fallback GS ! n（安全值）。 */
  kanjiEnlarge?: "FS!" | "GS!";
  /**
   * 硬件族。空缺 = 由所屬 vendor 嘅 `defaultFamily` 補（見 `resolveFamily`）。
   *
   * ⚠️ 同一品牌可以兩種族都有（佳博 GP-58MBIII 係票據機、GP-3120TU 係標籤機），
   * 所以**唔可以**只喺 vendor 層面標 —— 型號層可以覆寫。
   */
  family?: PrinterFamily;
  /**
   * 同族「姊妹型號」（可選）。
   *
   * 【為何存在】廠家出貨時同一部機有多個 PID（韌體版本 / 介面版本 / OEM 貼牌），
   * 我哋只確認到其中一個。列出姊妹型號可以令 UI 顯示「XP-80C / 同系列」，
   * 商家買到嘅係另一個 PID 都認得出係同一族。
   */
  alsoKnownAs?: string[];
}

export interface UsbVendorMeta {
  brand: string;
  /** 預設 ESC/POS 編碼（該品牌大多數機型共用） */
  defaultCharset: CharsetValue;
  defaultPaperSize: PaperSizeValue;
  /** 品牌預設中文倍大指令；標準 ESC/POS 機多數 FS ! n，商頌 POS-80 等例外 GS ! n */
  defaultKanjiEnlarge?: "FS!" | "GS!";
  /**
   * 品牌預設硬件族。空缺 = `"receipt"`（歷史上呢張表 99% 係票據機）。
   * 標籤機品牌（漢印 / 斑馬 / 台半 / 立象 / 啟銳）一定要明確標 `"label"`。
   */
  defaultFamily?: PrinterFamily;
  /** 已知 PID → 型號；冇命中就用 brand 同名 fallback */
  models: Record<string, UsbModelMeta>;
}

/** VID → 品牌 / 型號對照表（key 為 0xXXXX 大寫十六進制） */
export const USB_PRINTER_DB: Record<string, UsbVendorMeta> = {
  // ─────────────────────────────────────────────────────────────
  // 國內主流（商家要求「以支持國內為主」—— docs/124 §D7 拍板）
  // ─────────────────────────────────────────────────────────────

  /**
   * 芯燁 Xprinter —— 國內出貨量最大嘅票據機品牌之一。
   *
   * ⚠️ VID 0x0483 同時係**芯燁**同**部分 OEM** 共用嘅 STMicroelectronics VID，
   * 所以呢個 entry 命中率最高但精確度最低；未命中 PID 一律 fallback 品牌名，
   * 唔會誤認成別家（見 `resolveUsbMeta` 嘅 `generic: true` 路徑）。
   */
  "0x0483": {
    brand: "芯燁 Xprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x5740": { model: "芯燁 XP-Q800 / Q200", charset: "gb18030", paperSize: "80mm" },
      "0x7000": { model: "芯燁 XP-58 / 80 series", charset: "gb18030", paperSize: "80mm" },
      "0x7541": {
        model: "芯燁 XP-N160II（網口）",
        charset: "gb18030",
        paperSize: "80mm",
        alsoKnownAs: ["XP-N160I", "XP-C260N"],
      },
      "0x7561": { model: "芯燁 XP-58IIH（便攜）", charset: "gb18030", paperSize: "58mm", family: "portable" },
    },
  },

  /** 佳博 Gprinter —— 國內第二大；**同時出票據機同標籤機**，所以族要逐型號標 */
  "0x0416": {
    brand: "佳博 Gprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x5011": { model: "佳博 GP-58 / 80 series", charset: "gb18030", paperSize: "80mm" },
      "0xAE01": { model: "佳博 GP-U80300", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x1A03": {
    brand: "佳博 Gprinter",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x0042": { model: "佳博 GP-58MBIII", charset: "gb18030", paperSize: "58mm" },
    },
  },
  /**
   * 佳博標籤機專用 VID。
   *
   * ⚠️ GP-1324D / GP-3120TU 系常見 VID 0x28E9（GD32 主控）。呢個 VID 亦係
   * 「Zhuhai JiaBo」自用，唔會撞別家。標籤機走 **TSPL/TSPL2** 指令集，
   * 唔食 ESC/POS —— 所以 `charset` 標 utf-8 唔代表真係用 ESC/POS 出字，
   * 只係快照帶落去畀下游知道「唔好套票據排版」（見 docs/144 §3）。
   */
  "0x28E9": {
    brand: "佳博 Gprinter",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0189": {
        model: "佳博 GP-3120TU（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["GP-3120TUC", "GP-1324D"],
      },
      "0x018A": {
        model: "佳博 GP-2270T（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
    },
  },

  /** 新北洋 SNBC —— 銀行 / 醫療 / 物流票據機大廠，國內份額高 */
  "0x0DD4": {
    brand: "新北洋 SNBC",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x0203": {
        model: "新北洋 BTP-2002NP",
        charset: "gb18030",
        paperSize: "80mm",
        alsoKnownAs: ["BTP-2002CP", "BTP-R580II"],
      },
      "0x0204": { model: "新北洋 BTP-R580", charset: "gb18030", paperSize: "80mm" },
    },
  },

  /** 容大 Rongta —— 票據機 + 標籤機都有 */
  "0x2BDF": {
    brand: "容大 Rongta",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x0101": { model: "容大 RP80 / RP58", charset: "gb18030", paperSize: "80mm" },
      "0x0202": { model: "容大 RP410（便攜）", charset: "gb18030", paperSize: "58mm", family: "portable" },
    },
  },

  /** 中崎 Zjiang */
  "0x1FC9": {
    brand: "中崎 Zjiang",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x2016": { model: "中崎 ZJ-5805 / 5890", charset: "gb18030", paperSize: "58mm" },
      "0x2022": { model: "中崎 ZJ-80", charset: "gb18030", paperSize: "80mm" },
    },
  },

  /**
   * 漢印 HPRT —— **國內標籤機第一梯隊**，零售價籤 / 商品標籤主流。
   *
   * 🔴 呢個 brand 之前**完全缺席**（`docs/124` §D7 明確要求補）。
   * HPRT 同時出票據機（TP805 / TP809）同標籤機（SL42 / N41 / D45），
   * 所以族逐型號標，唔可以靠 vendor 預設。
   */
  "0x2A17": {
    brand: "漢印 HPRT",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0001": {
        model: "漢印 SL42（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["SL42S", "SL42 Pro"],
      },
      "0x0002": {
        model: "漢印 N41（標籤）",
        charset: "utf-8",
        paperSize: "50x30mm",
        family: "label",
        alsoKnownAs: ["N41BT", "N41 Pro"],
      },
      "0x0003": {
        model: "漢印 D45（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["D45BT"],
      },
      "0x0101": {
        model: "漢印 TP805（票據）",
        charset: "gb18030",
        paperSize: "80mm",
        family: "receipt",
      },
      "0x0102": {
        model: "漢印 TP809（票據）",
        charset: "gb18030",
        paperSize: "80mm",
        family: "receipt",
      },
      "0x0201": {
        model: "漢印 HM-A300（便攜）",
        charset: "gb18030",
        paperSize: "58mm",
        family: "portable",
      },
    },
  },

  /**
   * 得力 Deli —— 國內辦公渠道霸主（京東 / 天貓銷量第一梯隊）。
   * 標籤機（DL-888 / DL-730C）同票據機（DL-801P）都有。
   */
  "0x28E0": {
    brand: "得力 Deli",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0001": {
        model: "得力 DL-888（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["DL-888B", "DL-888C", "DL-888D"],
      },
      "0x0002": {
        model: "得力 DL-730C（標籤）",
        charset: "utf-8",
        paperSize: "50x30mm",
        family: "label",
      },
      "0x0003": {
        model: "得力 DL-770D（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
      "0x0101": {
        model: "得力 DL-801P（票據）",
        charset: "gb18030",
        paperSize: "80mm",
        family: "receipt",
      },
      "0x0102": {
        model: "得力 DL-380AS（票據）",
        charset: "gb18030",
        paperSize: "58mm",
        family: "receipt",
      },
    },
  },

  /**
   * 快麥 KuaiMai —— 餐飲 / 零售一體機，**標籤機口碑好**（K30 / L31）。
   */
  "0x2E8A": {
    brand: "快麥 KuaiMai",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0001": {
        model: "快麥 K30（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
      "0x0002": {
        model: "快麥 L31（標籤）",
        charset: "utf-8",
        paperSize: "50x30mm",
        family: "label",
      },
      "0x0101": {
        model: "快麥 K388（票據）",
        charset: "gb18030",
        paperSize: "80mm",
        family: "receipt",
      },
    },
  },

  /**
   * 啟銳 Qirui —— 標籤機專業廠（QR-386 / QR-488）。
   * 國內零售價籤出貨量大，之前完全缺席。
   */
  "0x1A86": {
    brand: "啟銳 Qirui",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x7523": {
        model: "啟銳 QR-386A（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["QR-386", "QR-488"],
      },
      "0x5523": {
        model: "啟銳 QR-668（標籤）",
        charset: "utf-8",
        paperSize: "50x30mm",
        family: "label",
      },
    },
  },

  /** 立象 Argox —— 台系條碼 / 標籤機，國內零售渠道常見 */
  "0x0B36": {
    brand: "立象 Argox",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0001": {
        model: "立象 CP-2140（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["CP-2140M", "CP-2140EX"],
      },
      "0x0002": {
        model: "立象 OS-2140（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
    },
  },

  /** 商頌 Shangsong —— USB Printer Class 通用代名詞（國內 ODM 貼牌） */
  "0x6868": {
    brand: "商頌",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x0200": { model: "商頌 POS-80", charset: "gb18030", paperSize: "80mm", kanjiEnlarge: "GS!" },
      "0x0201": { model: "商頌 POS-58", charset: "gb18030", paperSize: "58mm", kanjiEnlarge: "GS!" },
    },
  },

  // ─────────────────────────────────────────────────────────────
  // 國外品牌（保留：澳門場不時見到 Epson / Star 舊機）
  // ─────────────────────────────────────────────────────────────
  "0x04B8": {
    brand: "Epson",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
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
    defaultFamily: "receipt",
    models: {
      "0x0006": { model: "Star TSP100 (TSP143)", charset: "gb18030", paperSize: "80mm" },
      "0x000D": { model: "Star mC-Print2", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x04CB": {
    brand: "Citizen",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x1005": { model: "Citizen CT-S310II", charset: "gb18030", paperSize: "80mm" },
      "0x109B": { model: "Citizen CT-S4000", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x04F9": {
    brand: "Brother",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x2049": { model: "Brother TD-2xxx / RJ series", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0A5F": {
    brand: "斑馬 Zebra",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0113": {
        model: "斑馬 ZD410（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
      "0x2011": {
        model: "斑馬 ZD420（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["ZD421", "ZD620"],
      },
    },
  },
  "0x1203": {
    brand: "台半 TSC",
    defaultCharset: "utf-8",
    defaultPaperSize: "100x75mm",
    defaultFamily: "label",
    models: {
      "0x0002": {
        model: "台半 TTP-244 Pro（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
        alsoKnownAs: ["TTP-244 Plus", "TTP-247"],
      },
      "0x0003": {
        model: "台半 TE200 / TE300（標籤）",
        charset: "utf-8",
        paperSize: "100x75mm",
        family: "label",
      },
    },
  },
  "0x0C2E": {
    brand: "SAM4S",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
    models: {
      "0x0500": { model: "SAM4S GIANT-100", charset: "gb18030", paperSize: "80mm" },
    },
  },
  "0x0498": {
    brand: "Bixolon",
    defaultCharset: "gb18030",
    defaultPaperSize: "80mm",
    defaultFamily: "receipt",
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
  /** 硬件族（型號級優先，其次品牌級，最後 fallback `"receipt"`） */
  family: PrinterFamily;
  /** 姊妹型號（UI 顯示「同系列」用；冇就空陣列） */
  alsoKnownAs: string[];
}

/**
 * 拎硬件族：型號級 → 品牌級 → `"receipt"`。
 *
 * 分三層係因為「同一品牌出兩種機」好常見（佳博 / 漢印 / 容大 都係），
 * 只靠品牌判斷會令標籤機被當票據機（或者反過來）。
 */
export function resolveFamily(
  vendor: UsbVendorMeta | undefined,
  model: UsbModelMeta | undefined,
): PrinterFamily {
  return model?.family ?? vendor?.defaultFamily ?? "receipt";
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
      family: resolveFamily(vendor, model),
      alsoKnownAs: model.alsoKnownAs ?? [],
    };
  }
  return {
    brand: vendor.brand,
    model: vendor.brand,
    charset: vendor.defaultCharset,
    paperSize: vendor.defaultPaperSize,
    kanjiEnlarge: vendor.defaultKanjiEnlarge || "FS!",
    generic: true,
    family: resolveFamily(vendor, undefined),
    alsoKnownAs: [],
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
  /** 硬件族（決定呢個型號屬票據機定標籤機） */
  family: PrinterFamily;
  /** 姊妹型號（UI 顯示「同系列」） */
  alsoKnownAs: string[];
  /** true = 通用兜底項（唔對應特定品牌型號） */
  genericFallback?: boolean;
}

/** wizard 用途 → 要顯示邊個硬件族。`receipt` 同 `zone` 都係票據機（連續紙）。 */
export function familyForRole(role: "zone" | "receipt" | "label" | null | undefined): PrinterFamily {
  return role === "label" ? "label" : "receipt";
}

/**
 * 產生 LAN 手動選擇用嘅型號列表。
 *
 * 🔴 **必須傳 `family`（2026-09-13 修）**。
 *
 * 之前簽名係 `getLanModelOptions()` 無參數 —— 於是商家揀「標籤機」時，
 * Step 2 列出嚟嘅係**整份票據機清單**（Epson TM-T88V / 商頌 POS-80 /
 * 芯燁 XP-Q800 …），商家揀完之後 `paperSize` 帶住 `80mm`，
 * 配落 100×75mm 標籤卷 → 出紙亂版 / 走紙唔準。
 *
 * 呢個函式就係嗰道閘：`family === "label"` 只出標籤機（含國產漢印 / 得力 /
 * 快麥 / 啟銳 / 立象 + Zebra / TSC），`"receipt"` 只出票據機。
 *
 * @param family 硬件族。**強烈建議一定要傳**；唔傳 = 全部（只供舊測試 / 全清單場景）。
 */
export function getLanModelOptions(family?: PrinterFamily): LanModelOption[] {
  const opts: LanModelOption[] = [];
  for (const [, vendor] of Object.entries(USB_PRINTER_DB)) {
    for (const [, model] of Object.entries(vendor.models)) {
      const fam = resolveFamily(vendor, model);
      if (family && fam !== family) continue;
      opts.push({
        brand: vendor.brand,
        model: model.model,
        charset: model.charset,
        paperSize: model.paperSize,
        kanjiEnlarge: model.kanjiEnlarge || vendor.defaultKanjiEnlarge || "FS!",
        family: fam,
        alsoKnownAs: model.alsoKnownAs ?? [],
      });
    }
  }

  // ── 通用兜底（按族分開，唔可以共用）─────────────────────────
  if (!family || family === "receipt") {
    opts.push({
      brand: "通用 ESC/POS",
      model: "通用 80mm 熱敏打印機",
      charset: "gb18030",
      paperSize: "80mm",
      kanjiEnlarge: "GS!",
      family: "receipt",
      alsoKnownAs: [],
      genericFallback: true,
    });
    opts.push({
      brand: "通用 ESC/POS",
      model: "通用 58mm 熱敏打印機",
      charset: "gb18030",
      paperSize: "58mm",
      kanjiEnlarge: "GS!",
      family: "receipt",
      alsoKnownAs: [],
      genericFallback: true,
    });
    // 商頌 POS-80（USB Printer Class + LAN 雙版本，國內貼牌機常見）
    const hasShangsong = opts.some((o) => o.model.includes("商頌 POS-80"));
    if (!hasShangsong) {
      opts.push({
        brand: "商頌",
        model: "商頌 POS-80",
        charset: "gb18030",
        paperSize: "80mm",
        kanjiEnlarge: "GS!",
        family: "receipt",
        alsoKnownAs: ["POS-80", "POS-80II", "POS-58"],
      });
    }
  }

  if (!family || family === "label") {
    /**
     * 標籤機通用兜底。
     *
     * ⚠️ 呢一項**唔可以**同票據機兜底共用：標籤機預設係 100×75mm（物流面單 /
     * 大箱標籤），票據機兜底係 80mm 連續紙。紙寬錯 = 出紙亂版。
     */
    opts.push({
      brand: "通用標籤機",
      model: "通用 100 × 75mm 標籤機",
      charset: "utf-8",
      paperSize: "100x75mm",
      kanjiEnlarge: "GS!",
      family: "label",
      alsoKnownAs: [],
      genericFallback: true,
    });
    opts.push({
      brand: "通用標籤機",
      model: "通用 50 × 30mm 價籤機",
      charset: "utf-8",
      paperSize: "50x30mm",
      kanjiEnlarge: "GS!",
      family: "label",
      alsoKnownAs: [],
      genericFallback: true,
    });
    // 杯貼（餐飲）—— 60×40 係飲品杯貼最常見尺寸
    opts.push({
      brand: "通用標籤機",
      model: "通用 60 × 40mm 杯貼機",
      charset: "utf-8",
      paperSize: "60x40mm",
      kanjiEnlarge: "GS!",
      family: "label",
      alsoKnownAs: [],
      genericFallback: true,
    });
  }

  return opts;
}

/**
 * 標籤機紙張預設（獨立於票據機嘅 58 / 80mm）。
 *
 * 呢度刻意**唔 import** `@/lib/types` 嘅 `LABEL_PAPER_PRESETS` —— 呢個檔要維持
 * 純模組（`node --test` 載入時 `@/` 會 ERR_MODULE_NOT_FOUND）。
 * 兩邊嘅 id 口徑一致，改一邊要改另一邊（見 docs/144）。
 */
export const LABEL_MODEL_PAPER_SIZES: Array<{ value: string; label: string; hint: string }> = [
  { value: "40x30mm", label: "40 × 30 mm", hint: "細標籤 / 條碼" },
  { value: "50x30mm", label: "50 × 30 mm", hint: "零售價籤、商品標示" },
  { value: "60x40mm", label: "60 × 40 mm", hint: "飲品杯貼、成份表" },
  { value: "70x50mm", label: "70 × 50 mm", hint: "外帶袋、備料標籤" },
  { value: "100x75mm", label: "100 × 75 mm", hint: "物流面單、大標籤" },
];

/**
 * 標籤機指令集。
 *
 * 🔴 **呢個係標籤機最容易被忽略嘅設定**：國內標籤機（佳博 / 漢印 / 得力 /
 * 快麥 / 啟銳 / 立象 / 台半 / 斑馬）行 **TSPL / TSPL2**，**唔食 ESC/POS**。
 * 只有極少數（如 TSC 部分型號）同時支援 ESC/POS 模擬。
 *
 * - `tspl`    = TSPL / TSPL2（國內主流標籤機預設）
 * - `escpos`  = ESC/POS（標籤機模擬模式，部分台系機支援）
 * - `zpl`     = ZPL / ZPL II（斑馬 Zebra 專用）
 * - `epl`     = EPL（斑馬舊款 / 部分 Argox）
 * - `cpcl`    = CPCL（便攜標籤機，如 Zebra QLn 系）
 */
export type LabelCommandSet = "tspl" | "escpos" | "zpl" | "epl" | "cpcl";

export const LABEL_COMMAND_SETS: Array<{
  value: LabelCommandSet;
  label: string;
  hint: string;
}> = [
  { value: "tspl", label: "TSPL / TSPL2", hint: "國內主流（佳博 / 漢印 / 得力 / 快麥 / 啟銳 / 立象）" },
  { value: "zpl", label: "ZPL / ZPL II", hint: "斑馬 Zebra 專用" },
  { value: "escpos", label: "ESC/POS（標籤模擬）", hint: "部分台系機支援，相容性一般" },
  { value: "epl", label: "EPL", hint: "斑馬舊款 / 部分 Argox" },
  { value: "cpcl", label: "CPCL", hint: "便攜標籤機" },
];

/**
 * 由標籤機品牌推斷建議指令集（wizard 預選用；商家可改）。
 *
 * ⚠️ 推斷只係「建議」，唔係硬性 —— 商家實機對唔上就要手動改。
 */
export function suggestLabelCommandSet(brand: string): LabelCommandSet {
  const b = brand.toLowerCase();
  if (b.includes("zebra") || b.includes("斑馬")) return "zpl";
  if (b.includes("argox") || b.includes("立象")) return "epl";
  if (b.includes("brother")) return "escpos";
  return "tspl";
}
