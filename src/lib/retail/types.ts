/**
 * 零售（Retail）專屬型別。
 *
 * 【為何獨立成檔而唔放入 `@/lib/types`】
 * 零售型別係**全新**嘅，冇任何現存代碼依賴 → 放埋一齊只會令 `types.ts` 更巨型，
 * 亦增加誤改既有 union / `Record<>` 嘅風險（一改就四端出紙都要跟）。
 * 需要**改動既有結構**嘅欄位（`OrderItem` / `PosOrder` 加零售欄）仍然寫喺 `@/lib/types`。
 *
 * 🔴 **本檔必須保持零 runtime 依賴**（只有 type + 純函式）。
 * 測試用 `node --test` 直接載入 `.ts`（相對路徑），任何 runtime import 都會令載入失敗。
 */

// ─────────────────────────────────────────────────────────────
// 商品
// ─────────────────────────────────────────────────────────────

/**
 * 商品三層結構（2026-09-12 商家定案）：
 *
 * ```
 * SPU（RetailProduct）—「純棉圓領T恤」
 *   └── Variant（顏色 × 尺碼）— 各自有 barcode / sku / stockQty
 *         └── Serial（序號 / IMEI）— 只有 isSerialized 才需要，售出時綁定訂單行
 * ```
 *
 * ⚠️ 稱重商品**唔行變體**（秤端只認 PLU）→ `isWeighed` 直接掛 `plu`。
 */
export interface RetailVariant {
  id: string;
  /** 顯示用：「黑 / L」。商家自己嘅詞彙，唔可以寫死成固定選項。 */
  label: string;
  /** 結構化屬性 `{ 顏色: "黑", 尺碼: "L" }`（供篩選 / 排序 / 批量生成用） */
  attributes: Record<string, string>;
  barcode?: string;
  sku?: string;
  /** 缺省 = 繼承母體 SPU 嘅 `price` */
  price?: number;
  stockQty?: number;
  /**
   * 該變體自己嘅補貨警戒線。缺省 = 繼承母體 SPU 嘅 `reorderLevel`。
   * 服裝每個尺碼嘅走貨速度差好遠（M / L 走得快、S 慢），所以逐個變體設更準。
   */
  reorderLevel?: number;
  isActive?: boolean;
}

export interface RetailProduct {
  id: string;
  storeId?: string;
  name: string;
  categoryId: string;

  // ── 識別 ──
  /** 主條碼（EAN-13 / UPC）。有變體時可空（變體各自有條碼）。 */
  barcode?: string;
  /**
   * 額外條碼：一商品可以有多個（廠碼 + 店內自編碼 + 舊包裝碼），
   * **掃到任何一個都要認得**。索引係 `barcode → productId`（多對一）。
   */
  extraBarcodes?: string[];
  /** 店內 PLU（稱重商品必填，5 位）。秤只需要出重量，PLU 由 POS 統一分配。 */
  plu?: string;
  sku?: string;

  // ── 價格 ──
  price: number;
  /** 原價（畫刪除線用；冇設就當 price 已經係原價） */
  originalPrice?: number;
  /** 成本（毛利報表用） */
  cost?: number;
  /** 件 / kg / 包 / 盒 */
  unit: string;
  /** 稅碼（澳門多數免稅，保留擴充位） */
  taxCode?: string;

  // ── 庫存（即時扣減，2026-09-12 商家定案） ──
  trackStock: boolean;
  /** 有變體時：母體數值只作參考，真實庫存以變體為準 */
  stockQty?: number;
  reorderLevel?: number;

  // ── 形態 ──
  /** 稱重商品（賣菜 / 散裝）：以重量計價，PLU 必填 */
  isWeighed?: boolean;
  /** 序號商品（IMEI / 機身號）：售出時要登記，退貨可反查 */
  isSerialized?: boolean;
  /** 年齡限制（便利店煙酒）：掃到即彈年齡確認 */
  minAge?: number;
  /** 藥房：受管制 / 需登記（簿冊 / 處方） */
  requiresRecord?: boolean;
  /** 批次（藥房 / 生鮮） */
  batchNo?: string;
  /** 有效日期（藥房 / 生鮮，ISO date） */
  expiryDate?: string;

  /** 有值 = 本體係 SPU，**唔可直接賣**，要揀變體 */
  variants?: RetailVariant[];

  image?: string;
  isActive?: boolean;
}

/** 商品係咪要揀變體才可以入購物車 */
export function needsVariantChoice(product: Pick<RetailProduct, "variants">): boolean {
  return Array.isArray(product.variants) && product.variants.length > 0;
}

/** 商品嘅所有條碼（主 + 額外 + 變體），去重去空 */
export function allBarcodesOf(product: RetailProduct): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(product.barcode);
  for (const b of product.extraBarcodes ?? []) push(b);
  for (const v of product.variants ?? []) push(v.barcode);
  return out;
}

/** 商品（或指定變體）嘅實際售價：變體價優先，缺省繼承母體 */
export function priceOf(product: RetailProduct, variantId?: string): number {
  if (variantId) {
    const v = (product.variants ?? []).find((x) => x.id === variantId);
    if (v && typeof v.price === "number") return v.price;
  }
  return product.price;
}

/** 商品（或指定變體）嘅實際可售庫存 */
export function stockOf(product: RetailProduct, variantId?: string): number | undefined {
  if (variantId) {
    const v = (product.variants ?? []).find((x) => x.id === variantId);
    if (v) return v.stockQty;
  }
  return product.stockQty;
}

// ─────────────────────────────────────────────────────────────
// 掃碼槍
// ─────────────────────────────────────────────────────────────

export type ScannerSuffix = "enter" | "tab" | "none";

/**
 * 掃碼槍設定檔。
 *
 * HID 掃碼槍本質係鍵盤 wedge → **瀏覽器讀唔到型號**（冇 USB descriptor API），
 * 所以有兩條路：① 經 Companion / Android 代理讀 VID/PID → 型號庫配對；
 * ② 純瀏覽器 → 用 `learnProfile()` 由實際輸入特徵反推。
 */
export interface ScannerProfile {
  id: string;
  name: string;
  /** 出廠前綴（部分型號加 `~`、`%`、`#`） */
  prefix?: string;
  /** 結尾字元 */
  suffix: ScannerSuffix;
  /**
   * 掃碼完成嘅超時閾值（ms）。
   * 掃碼槍 5–15ms/鍵 vs 人手 ~150ms/鍵 → 30–50 係安全區。
   * 預設 50。
   */
  timeoutMs: number;
  minLength?: number;
  maxLength?: number;
  charset?: "digits" | "alnum";
  source: "model-db" | "auto-learn" | "manual";
}

/**
 * 一次掃描嘅原始輸入樣本（自動學習嚮導收集）。
 *
 * ⚠️ 要同時量到「前綴」就**必須掃唔同嘅條碼** ——
 * 若 3 次都掃同一個條碼，共同前綴會等於整個條碼，無法分離出裝置前綴。
 */
export interface ScanSample {
  /** 每個字元嘅 keydown 時間戳（ms，單調遞增） */
  keyTimestamps: number[];
  /** 收到嘅字元（未去前綴 / 結尾） */
  chars: string;
  /** 有冇收到結尾字元 */
  terminatedBy?: ScannerSuffix;
}

export interface ScannerModelOption {
  brand: string;
  model: string;
  profile: Omit<ScannerProfile, "id" | "name" | "source">;
}

// ─────────────────────────────────────────────────────────────
// 變重條碼（條碼標籤秤 / price-embedded EAN-13）
// ─────────────────────────────────────────────────────────────

/**
 * 變重條碼解析規則。
 *
 * 業界標準格式（EAN-13，13 位）：
 * ```
 * 2   01234   00350   X
 * │   │       │       └─ 校驗位
 * │   │       └───────── 重量(克) 或 金額(分)，5 位
 * │   └───────────────── PLU / 商品碼，5 位
 * └───────────────────── 前綴 20-29（店內變重碼）；21=重量碼、22=金額碼
 * ```
 * ⚠️ 各品牌出廠規則唔同（前綴 `2` vs `02`、克 vs 千克、有冇校驗位、位數分配）
 * → 一律由呢個 struct 描述，**唔可以寫死喺代碼**。
 */
export interface WeighedBarcodeRule {
  id: string;
  name: string;
  /** 前綴清單，例如 `["21", "22"]` 或 `["2"]`。比對時**長前綴優先**。 */
  prefixes: string[];
  /** PLU 起始位（0-based）同長度 */
  pluStart: number;
  pluLength: number;
  /** 數值欄位位置 */
  payloadStart: number;
  payloadLength: number;
  payloadKind: "weight_g" | "weight_kg" | "price_cents" | "price";
  /**
   * 換算除數（條碼欄位嘅刻度）。
   * - `weight_g` → 1000（克 → kg）
   * - `price_cents` → 100（分 → 元）
   * - `weight_kg` / `price` → 表示欄位本身嘅刻度：`1` = 整數、`10` = 一位小數、`100` = 兩位小數…
   *   例如 `weight_kg` + `divisor: 10`，條碼 `00035` = 3.5 kg。
   */
  divisor: number;
  hasCheckDigit: boolean;
}

/** 變重條碼解析結果 */
export interface WeighedBarcodeHit {
  plu: string;
  /** 淨重（kg）— `payloadKind` 係 `weight_*` 時有值 */
  weightKg?: number;
  /** 金額（元）— `payloadKind` 係 `price_*` 時有值 */
  price?: number;
  /** 命中嘅規則 id（供對帳 / 除錯） */
  ruleId: string;
}

// ─────────────────────────────────────────────────────────────
// 掃碼解析結果
// ─────────────────────────────────────────────────────────────

export type ScannedHit =
  | {
      kind: "product";
      code: string;
      product: RetailProduct;
      /** 掃到變體條碼時有值 */
      variant?: RetailVariant;
    }
  | {
      kind: "weighed";
      code: string;
      weighed: WeighedBarcodeHit;
      /** 依 PLU 對得中商品時有值（對唔中都要照收，因為價錢已經喺條碼） */
      product?: RetailProduct;
    }
  | { kind: "unknown"; code: string };

// ─────────────────────────────────────────────────────────────
// 付款方式（結構化）
// ─────────────────────────────────────────────────────────────

/**
 * 零售付款方式。
 *
 * ⚠️ 舊 `PosRules.paymentMethods` 係自由文字 `string[]`（有存量門店設定），
 * **唔可以直接換型別**，否則現有商戶嘅付款方式會消失（同 `label.paperSize` 當年同一個坑）。
 * 新欄位用 `PosRules.retailPaymentMethods?`（選填，有值優先），
 * 由 `normalizeRetailPaymentMethods()` 兼容讀舊字串。
 */
export interface RetailPaymentMethod {
  id: string;
  label: string;
  kind: "cash" | "card" | "ewallet" | "voucher" | "member_balance" | "other";
  /** 現金：要輸入實收、要找零 */
  requiresTendered?: boolean;
  /** 現金：開錢箱 */
  openDrawer?: boolean;
  /** 是否接支付終端（人手記帳 = false） */
  integrated?: boolean;
}

/** 拆分付款嘅一筆 */
export interface SplitPaymentEntry {
  methodId: string;
  label: string;
  /** 呢一筆計入應收嘅金額（元） */
  amount: number;
  /** 現金：顧客實際畀嘅錢（唔填 = amount） */
  tendered?: number;
  /** 現金：找零 = max(0, tendered − amount) */
  change?: number;
}

// ─────────────────────────────────────────────────────────────
// 標籤紙
// ─────────────────────────────────────────────────────────────

/**
 * 自訂標籤紙。
 *
 * 🔴 `columns` **由系統計，唔畀商家手填** —— 填錯就會出紙歪 / 折行。
 * 公式同 `LABEL_PAPER_PRESETS` 一致：`floor((widthMm − 8) / 1.5)`（203dpi font A）。
 */
export interface CustomLabelPaper {
  /** `custom-<時間戳>`；⚠️ 唔可以顯示畀用戶（一律顯示 `label`） */
  id: string;
  /** 商家自己打嘅名，例如「自家價籤」 */
  label: string;
  widthMm: number;
  heightMm: number;
  columns: number;
}
