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
  | "30x20mm"
  | "40x30mm"
  | "50x30mm"
  | "50x40mm"
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
  /**
   * 標籤機**介質幅寬上限**（mm，可選）。
   *
   * 🔴 為何要：標籤紙係「成卷」嘅，紙寬超出機器導軌就**根本放唔落**。
   * 例：Xprinter XP-235B 介質幅寬 20–60mm → 100×75mm 面單用唔到。
   * 冇呢個值 = 未知，UI 唔會攔（但會提示「請自行核對紙寬」）。
   *
   * ⚠️ 呢個係**紙寬**（含底紙），唔係「打印寬度」—— 兩者差 2–4mm。
   * 廠商 spec 通常寫「介質幅寬 / Media Width」，要抄嗰個。
   */
  maxLabelWidthMm?: number;
  /** 標籤機介質幅寬下限（mm）。空缺 = 唔檢查下限。 */
  minLabelWidthMm?: number;
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

/**
 * **LAN 專用型號目錄**（2026-09-13 新增）。
 *
 * 【為何要另開一張表】`USB_PRINTER_DB` 係 `VID → PID → 型號` 嘅**自動偵測**表，
 * 每加一個型號就要一個**確認過嘅 PID**。但：
 *
 *   - LAN 連接**完全唔經 VID/PID**（商家憑機身標籤揀），根本唔需要 PID
 *   - 有啲常見機我哋知道型號同規格，但**未確認 PID**（韌體版本多）
 *
 * 硬塞入 `USB_PRINTER_DB` 就要**作一個 PID** —— 咁樣第日真機插上 USB 反而會
 * **認錯型號**（比認唔到更差）。所以另開呢張表：只餵 LAN 手動清單，
 * **絕對唔參與 USB 自動偵測**。
 *
 * 🔴 加新項目前問自己：我係咪確認過 PID？確認咗 → 入 `USB_PRINTER_DB`。
 * 未確認 → 入呢度（LAN 手動揀得到，USB 靠 `resolveUsbMeta` 嘅品牌 fallback）。
 */
export interface LanOnlyModel {
  brand: string;
  model: string;
  charset: CharsetValue;
  paperSize: PaperSizeValue;
  kanjiEnlarge?: "FS!" | "GS!";
  family: PrinterFamily;
  alsoKnownAs?: string[];
  /** 標籤機介質幅寬上限（mm） */
  maxLabelWidthMm?: number;
  /** 標籤機介質幅寬下限（mm） */
  minLabelWidthMm?: number;
  /** 點解要手動列出（畀未來自己 / 同事睇） */
  note?: string;
}

export const LAN_ONLY_MODELS: LanOnlyModel[] = [
  {
    /**
     * Xprinter XP-235B —— 商家（J）手上嘅標籤機。
     *
     * 規格來源：珠海芯燁官網 `xprinter.net/product/482.html`（2026-09-13 查證）
     *   - 介質幅寬 **20mm ~ 60mm**   ← 決定 `maxLabelWidthMm: 60`
     *   - 打印寬度 ≥56mm（標籤模式）／48mm（票據模式）
     *   - 接口 USB / USB+串口 / USB+藍牙 / **USB+網口**
     *   - 203 DPI、29 種一維條碼 + QR Code、自動光感測紙
     *
     * 🔴 呢部機**同時支援「熱敏標籤模式」同「熱敏票據模式」**（一機兩用）。
     * 即係佢理論上可以同時做 `label` + `receipt`（見 `retail/printer-roles.ts`
     * 嘅 `roles?: PrinterRole[]`）。而家 wizard 只寫單一 `role`，
     * 需要一機兩用嘅話要另外喺打印機列表改角色。
     *
     * ⚠️ **紙寬 20–60mm** 係硬限制：100×75mm 物流面單、70×50mm 外帶袋標籤
     * **放唔落呢部機**。UI 會自動剔除超出範圍嘅尺寸（見 `labelPaperFitsModel`）。
     */
    brand: "芯燁 Xprinter",
    model: "芯燁 XP-235B（標籤／票據兩用）",
    charset: "utf-8",
    paperSize: "60x40mm",
    kanjiEnlarge: "GS!",
    family: "label",
    alsoKnownAs: ["XP-235B", "XP-234B", "XP-236B"],
    maxLabelWidthMm: 60,
    minLabelWidthMm: 20,
    note: "介質幅寬 20-60mm；未確認 USB PID，故只入 LAN 目錄",
  },
  {
    /**
     * 芯燁 XP-365B —— XP-235B 嘅升級款，國內零售 / 餐飲常見。
     * 紙寬 20–72mm（比 235B 闊少少，食得到 70×50）。
     */
    brand: "芯燁 Xprinter",
    model: "芯燁 XP-365B（標籤）",
    charset: "utf-8",
    paperSize: "70x50mm",
    kanjiEnlarge: "GS!",
    family: "label",
    alsoKnownAs: ["XP-365B"],
    maxLabelWidthMm: 72,
    note: "未確認 USB PID，故只入 LAN 目錄",
  },
  {
    /** 佳博 GP-1324D —— 國內標籤機出貨量前列；紙寬 20–104mm */
    brand: "佳博 Gprinter",
    model: "佳博 GP-1324D（標籤）",
    charset: "utf-8",
    paperSize: "100x75mm",
    kanjiEnlarge: "GS!",
    family: "label",
    alsoKnownAs: ["GP-1324D", "GP-1324DII"],
    maxLabelWidthMm: 104,
    note: "未確認 USB PID，故只入 LAN 目錄",
  },
  {
    /** 漢印 HPRT SL42 —— 零售價籤主流；紙寬 20–110mm */
    brand: "漢印 HPRT",
    model: "漢印 SL42（標籤／LAN 版）",
    charset: "utf-8",
    paperSize: "100x75mm",
    kanjiEnlarge: "GS!",
    family: "label",
    alsoKnownAs: ["SL42S", "SL42 Pro"],
    maxLabelWidthMm: 110,
    note: "USB PID 已收錄（0x2A17/0x0001）；呢項係網口版本嘅 LAN 手動入口",
  },
  {
    /**
     * 商頌 POS-80 —— USB Printer Class 通用票據機（國內 ODM 貼牌），
     * 冇確認 PID（好多貼牌機共用同一顆晶片但 PID 各異）。
     * 原本硬編喺 `getLanModelOptions()` 入面，搬到呢度統一管理。
     */
    brand: "商頌",
    model: "商頌 POS-80",
    charset: "gb18030",
    paperSize: "80mm",
    kanjiEnlarge: "GS!",
    family: "receipt",
    alsoKnownAs: ["POS-80", "POS-80II", "POS-58"],
    note: "USB Printer Class 通用機，PID 未確認，故只入 LAN 目錄",
  },
];

/**
 * 標籤紙寬度檢查 —— 呢張紙放唔放得落呢部機？
 *
 * 規則：`minLabelWidthMm ≤ 紙寬 ≤ maxLabelWidthMm`。
 * 機器**冇**標寬度限制（`max` 同 `min` 都係 undefined）→ 一律 `true`
 * （唔好因為資料缺失就攔住商家，但要喺 UI 提示自行核對）。
 *
 * @param paperWidthMm 紙嘅寬度（mm）
 * @param minWidthMm 機器下限（空缺 = 唔檢查）
 * @param maxWidthMm 機器上限（空缺 = 唔檢查）
 */
export function labelPaperFitsModel(
  paperWidthMm: number,
  minWidthMm?: number,
  maxWidthMm?: number,
): boolean {
  if (minWidthMm != null && paperWidthMm < minWidthMm) return false;
  if (maxWidthMm != null && paperWidthMm > maxWidthMm) return false;
  return true;
}


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
  /** 標籤機介質幅寬上限（mm）；undefined = 未知（UI 唔攔，只提示自行核對） */
  maxLabelWidthMm?: number;
  /** 標籤機介質幅寬下限（mm）；undefined = 未知 */
  minLabelWidthMm?: number;
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
      maxLabelWidthMm: model.maxLabelWidthMm,
      minLabelWidthMm: model.minLabelWidthMm,
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
    // 未命中型號 → 唔知紙寬限制（唔可以用品牌預設亂估）。
    maxLabelWidthMm: undefined,
    minLabelWidthMm: undefined,
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
  /** 標籤機介質幅寬上限（mm）；undefined = 未知（UI 唔攔，只提示） */
  maxLabelWidthMm?: number;
  /** 標籤機介質幅寬下限（mm）；undefined = 未知 */
  minLabelWidthMm?: number;
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
        maxLabelWidthMm: model.maxLabelWidthMm,
        minLabelWidthMm: model.minLabelWidthMm,
      });
    }
  }

  /**
   * LAN 專用型號目錄（未有確認 PID 嘅常見機）。
   *
   * 🔴 呢批**只**入 LAN 清單 —— 因為 LAN 唔靠 VID/PID，商家憑機身標籤揀。
   * 混入 `USB_PRINTER_DB` 就要作 PID，第日真機插 USB 會認錯型號。
   * 詳見 `LAN_ONLY_MODELS` 嘅 JSDoc。
   */
  for (const m of LAN_ONLY_MODELS) {
    if (family && m.family !== family) continue;
    opts.push({
      brand: m.brand,
      model: m.model,
      charset: m.charset,
      paperSize: m.paperSize,
      kanjiEnlarge: m.kanjiEnlarge || "FS!",
      family: m.family,
      alsoKnownAs: m.alsoKnownAs ?? [],
      maxLabelWidthMm: m.maxLabelWidthMm,
      minLabelWidthMm: m.minLabelWidthMm,
    });
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
 * 標籤紙選項（含**實際尺寸**，唔止 label 字串）。
 *
 * 🔴 `widthMm` 係硬需要 —— 標籤紙係成卷嘅，**紙寬超出機器導軌就放唔落**。
 * 冇呢個值，UI 就攔唔到「用 100×75 餵一部 20-60mm 機」呢種錯
 * （商家要印到先知，浪費紙 + 時間）。
 *
 * ⚠️ 呢度刻意**唔 import** `@/lib/types` 嘅 `LABEL_PAPER_PRESETS` —— 呢個檔要維持
 * 純模組（`node --test` 載入時 `@/` 會 ERR_MODULE_NOT_FOUND）。
 * 兩邊嘅 id 口徑一致，改一邊要改另一邊（見 docs/144）。
 */
export interface LabelPaperOption {
  value: PaperSizeValue;
  label: string;
  /** 紙寬（mm，含底紙）。機器導軌限制就係比呢個。 */
  widthMm: number;
  /** 紙高 / 標籤長（mm） */
  heightMm: number;
  hint: string;
}

export const LABEL_MODEL_PAPER_SIZES: LabelPaperOption[] = [
  { value: "30x20mm", label: "30 × 20 mm", widthMm: 30, heightMm: 20, hint: "迷你標籤 / 試管貼" },
  { value: "40x30mm", label: "40 × 30 mm", widthMm: 40, heightMm: 30, hint: "細標籤 / 條碼" },
  { value: "50x30mm", label: "50 × 30 mm", widthMm: 50, heightMm: 30, hint: "零售價籤、商品標示" },
  { value: "50x40mm", label: "50 × 40 mm", widthMm: 50, heightMm: 40, hint: "商品標示（較高）" },
  { value: "60x40mm", label: "60 × 40 mm", widthMm: 60, heightMm: 40, hint: "飲品杯貼、成份表" },
  { value: "70x50mm", label: "70 × 50 mm", widthMm: 70, heightMm: 50, hint: "外帶袋、備料標籤" },
  { value: "100x75mm", label: "100 × 75 mm", widthMm: 100, heightMm: 75, hint: "物流面單、大標籤" },
  { value: "62mm", label: "62 mm", widthMm: 62, heightMm: 40, hint: "舊系統預設（非業界標準，僅供沿用）" },
];

/** 由 value 拎標籤紙選項（搵唔到 → undefined） */
export function labelPaperOptionOf(value: string | undefined | null): LabelPaperOption | undefined {
  if (!value) return undefined;
  return LABEL_MODEL_PAPER_SIZES.find((p) => p.value === value);
}

/** 紙寬（mm）。未知尺寸 → undefined（唔可以用 0 代替，否則會被當「永遠合格」） */
export function labelPaperWidthMm(value: string | undefined | null): number | undefined {
  return labelPaperOptionOf(value)?.widthMm;
}

/**
 * 標籤紙**最終 fallback**（連型號表建議值都冇 / 唔合格時用）。
 *
 * 揀 60×40 而唔係 100×75（物流面單）：**60mm 係小型標籤機常見上限**
 * （Xprinter XP-235B 就係 20–60mm）。若果 default 揀 100×75，
 * 大多數細機身上會「放唔落」── 而商家第一次設定時根本唔知要改。
 *
 * 寧可預設細（放得落但可能唔夠位），都好過預設大到放唔落。
 */
export const FALLBACK_LABEL_PAPER: PaperSizeValue = "60x40mm";

/**
 * 為一部**有紙寬限制**嘅機器揀最合適嘅預設標籤紙。
 *
 * 挑選次序：
 *   1. 型號表自帶嘅 `preferred` —— 若果喺（已知）範圍內 → 用佢
 *   2. 已知**上限**（受約束）→ 範圍內**最闊**嗰款（資訊量最大；
 *      例 20–60mm → 60×40mm。排除 62mm 舊預設，佢係「沿用舊設定」唔係好選擇）
 *   3. 都唔得 → `FALLBACK_LABEL_PAPER`（保守 60×40mm）
 *
 * 🔴 點解「無限制」時**唔**揀最闊：冇限制 = 我哋**唔知**，唔係「無限大」。
 * 呢個時候揀 100×75 係賭博 —— 猜錯就係商家放唔落紙。
 *
 * @param maxWidthMm 機器紙寬上限；undefined = 未知
 * @param minWidthMm 機器紙寬下限；undefined = 未知
 * @param preferred 型號表建議值
 */
export function defaultLabelPaperFor(
  maxWidthMm?: number,
  minWidthMm?: number,
  preferred?: string,
): string {
  const fits = (p: LabelPaperOption) => labelPaperFitsModel(p.widthMm, minWidthMm, maxWidthMm);

  if (preferred) {
    const p = labelPaperOptionOf(preferred);
    if (p && fits(p)) return p.value;
  }
  // 只有喺**已知上限**（真正受約束）時，才敢揀範圍內最闊。
  if (maxWidthMm != null) {
    const widest = LABEL_MODEL_PAPER_SIZES.filter((p) => fits(p) && p.value !== "62mm").sort(
      (a, b) => b.widthMm - a.widthMm,
    )[0];
    if (widest) return widest.value;
  }
  return FALLBACK_LABEL_PAPER;
}

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

// ─────────────────────────────────────────────────────────────
// 品牌層分組 / 篩選（2026-09-13 新增）
// ─────────────────────────────────────────────────────────────

/**
 * 「其他」分組嘅顯示名。
 *
 * 🔴 商家要求：**冇對應品牌嘅項目（通用兜底類）一律歸入「其他」**。
 * 唔可以散落喺清單入面扮成一個品牌 —— 商家會以為「通用標籤機」係一個牌子。
 */
export const OTHER_BRAND = "其他";

/** 需要歸入「其他」嘅品牌名（通用兜底項嘅 `brand` 值）。 */
const GENERIC_BRAND_NAMES = new Set(["通用 ESC/POS", "通用標籤機", "通用", "USB 打印機", ""]);

/**
 * 拎一個型號屬於邊個品牌分組。
 *
 * 規則（商家口徑）：
 *   - `genericFallback === true` → `「其他」`
 *   - 品牌名係通用字眼（通用 ESC/POS / 通用標籤機 / USB 打印機 / 空白）→ `「其他」`
 *   - 其餘 → 用 `brand` 原文（**保留「中文 + 英文」**，商家喺機身見到嘅係中文）
 */
export function brandGroupOfModel(opt: LanModelOption): string {
  if (opt.genericFallback) return OTHER_BRAND;
  const b = (opt.brand ?? "").trim();
  if (GENERIC_BRAND_NAMES.has(b)) return OTHER_BRAND;
  return b || OTHER_BRAND;
}

export interface BrandGroup<T> {
  /** 分組名（品牌名，或 `「其他」`） */
  brand: string;
  /** 該組有幾項 —— UI 顯示喺 chip 上，商家一眼知邊個牌子有幾多型號 */
  count: number;
  items: T[];
}

/**
 * 按品牌分組，**保序**：
 *   1. 跟原本清單嘅出現次序（= `USB_PRINTER_DB` 嘅插入序，即國內品牌行先）
 *   2. **「其他」永遠排最後** —— 佢係兜底，唔應該擋喺前面
 *
 * 同時適用於：
 *   - LAN 手動型號清單（`LanModelOption[]`）
 *   - USB 自動偵測結果（`{ brand }` 物件），見 `brandGroupOfCandidate()`
 *
 * @param options 已按族過濾好嘅清單
 * @param brandOf 拎品牌名嘅存取器（LAN / USB 用唔同欄位）
 */
export function groupByBrand<T>(options: readonly T[], brandOf: (item: T) => string): BrandGroup<T>[] {
  const groups: BrandGroup<T>[] = [];
  const index = new Map<string, BrandGroup<T>>();
  for (const item of options) {
    const brand = brandOf(item) || OTHER_BRAND;
    let g = index.get(brand);
    if (!g) {
      g = { brand, count: 0, items: [] };
      index.set(brand, g);
      groups.push(g);
    }
    g.items.push(item);
    g.count++;
  }
  // 「其他」沉底：穩定排序，其餘保持原序
  return groups.sort((a, b) => {
    const aOther = a.brand === OTHER_BRAND ? 1 : 0;
    const bOther = b.brand === OTHER_BRAND ? 1 : 0;
    return aOther - bOther;
  });
}

/** `groupByBrand()` 嘅 LAN 版糖衣 */
export function groupModelsByBrand(options: readonly LanModelOption[]): BrandGroup<LanModelOption>[] {
  return groupByBrand(options, brandGroupOfModel);
}

/**
 * USB 偵測結果嘅品牌名。
 *
 * ⚠️ USB 候選項嘅 `brand` 係 Companion 由 VID/PID 解析出嚟嘅 **型號名**
 * （`resolveUsbMeta()` 未命中型號時會 fallback 成品牌名，例如 `"漢印 HPRT"`）。
 * 所以呢度**唔可以**直接當 `LanModelOption` 用 —— 但要遵守同一條「其他」規則。
 *
 * 若候選項帶 `family`，而且品牌係已知品牌之一，就照該品牌分組；
 * 認唔到（`model` 係「USB 打印機 0xXXXX」之類）一律歸「其他」。
 */
export function brandGroupOfCandidate(c: {
  brand?: string;
  model?: string;
  name?: string;
  family?: string;
}): string {
  const raw = (c.brand ?? c.model ?? c.name ?? "").trim();
  if (!raw) return OTHER_BRAND;
  if (GENERIC_BRAND_NAMES.has(raw)) return OTHER_BRAND;
  // Companion 認唔到型號時會回 "USB 打印機" / "通用 ESC/POS (USB Printer Class)"
  if (raw.startsWith("USB 打印機") || raw.includes("USB Printer Class")) return OTHER_BRAND;
  // Companion 命中已知品牌但冇精確型號 → brand 就係品牌名（例："漢印 HPRT"）
  return raw;
}

/** 「全部」篩選 chip 嘅哨兵值（唔可以同真實品牌名撞） */
export const BRAND_FILTER_ALL = "__all__";

/**
 * 一個品牌 chip 要用邊個 label。
 *
 * 有 `count` 就帶埋數量（`佳博 Gprinter 2`），令商家一眼睇到邊個牌子有幾多型號。
 */
export function brandChipLabel(brand: string, count: number): string {
  return brand === BRAND_FILTER_ALL ? `全部 ${count}` : `${brand} ${count}`;
}

/**
 * 由品牌分組清單抽出所有 chip（含開頭嘅「全部」）。
 *
 * 只有一個品牌時**唔應該**顯示 chip 列（篩選無意義，徒增視覺噪音）——
 * 所以 UI 要判 `groups.length > 1` 才 render。
 *
 * ⚠️ 參數刻意收窄成 `{ brand, count }`（唔用 `BrandGroup<T>`）—— 因為 LAN 型號表
 * 同 USB 偵測結果係兩種唔同嘅 `T`，UI 要可以傳任何一種。
 */
export function brandChipsOf(
  groups: readonly { brand: string; count: number }[],
): Array<{ brand: string; count: number }> {
  const total = groups.reduce((n, g) => n + g.count, 0);
  return [{ brand: BRAND_FILTER_ALL, count: total }, ...groups.map((g) => ({ brand: g.brand, count: g.count }))];
}
