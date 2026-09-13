/**
 * 手動秤重輸入 —— **純函式，零 runtime 依賴**。
 *
 * 【為何需要呢一層】
 * 秤有三條路（docs/124 §2.5）：W1 條碼標籤秤（印變重條碼，掃入即得）、
 * W2 藍牙秤、W3 USB HID 秤。但**三者都唔係即時可得** —— 商戶可能只有一部舊電子秤。
 * 所以一定要有「人手讀秤 + 打數字」嘅兜底（W4），否則賣菜場景完全行唔到。
 *
 * 🔴 **單價一律由 POS 算，秤端唔入商品庫** —— 免得出現「秤上價 ≠ POS 價」。
 * 呢個模組只做數學：皮重扣減、金額計算、秤標籤文字組裝。
 */

import type { RetailProduct, WeighedBarcodeRule } from "@/lib/retail/types";

const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
const round2 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

/** 常用皮重預設（容器重量，kg）。商戶可以自己加。 */
export interface TarePreset {
  id: string;
  label: string;
  kg: number;
}

/**
 * 內建皮重預設 —— 便利店 / 生鮮最常用嘅幾種容器。
 *
 * ⚠️ 呢啲係**常見值**，唔係標準值：唔同批次嘅膠袋重量都唔一樣。
 * UI 一定要畀商戶改，唔可以當成準確值硬用。
 */
export const DEFAULT_TARE_PRESETS: TarePreset[] = [
  { id: "none", label: "不扣皮", kg: 0 },
  { id: "bag-s", label: "細膠袋", kg: 0.005 },
  { id: "bag-l", label: "大膠袋", kg: 0.012 },
  { id: "box", label: "膠盒", kg: 0.03 },
  { id: "tray", label: "發泡膠盤", kg: 0.008 },
];

export interface WeighInput {
  /** 秤上讀到嘅毛重（kg） */
  grossKg: number;
  /** 皮重（kg）；唔扣就 0 */
  tareKg?: number;
  /** 每 kg 單價（元） */
  unitPrice: number;
  /**
   * 最低計價單位（kg）。低於呢個值 → 唔應該入車（避免 0.0001 kg 嘅誤觸）。
   * 缺省 0.001。
   */
  minWeightKg?: number;
}

export interface WeighResult {
  /** 淨重（kg）= max(0, 毛重 − 皮重) */
  netKg: number;
  /** 金額（元）= 淨重 × 單價，四捨五入到分 */
  amount: number;
  /** 皮重有冇超過毛重（秤未歸零 / 打錯）→ UI 要提示，唔可以靜默當 0 */
  tareExceedsGross: boolean;
  /** 淨重太輕（低於最低計價單位）→ 唔應該入車 */
  tooLight: boolean;
  /** 可以入車 */
  ok: boolean;
}

/**
 * 計淨重同金額。
 *
 * 🔴 **皮重 > 毛重** 唔可以靜靜當 0 交出去 —— 咁會出現「重量 0 但收咗錢」或者
 * 「明明磅咗但入唔到車」而店員唔知原因。一律回 `tareExceedsGross: true`。
 */
export function computeWeigh(input: WeighInput): WeighResult {
  const gross = Math.max(0, round3(input.grossKg));
  const tare = Math.max(0, round3(input.tareKg ?? 0));
  const min = Math.max(0, round3(input.minWeightKg ?? 0.001));
  const netRaw = round3(gross - tare);
  const tareExceedsGross = netRaw < 0;
  const netKg = Math.max(0, netRaw);
  const amount = round2(netKg * (Number.isFinite(input.unitPrice) ? input.unitPrice : 0));
  const tooLight = netKg < min;
  return {
    netKg,
    amount,
    tareExceedsGross,
    tooLight,
    ok: !tareExceedsGross && !tooLight && netKg > 0,
  };
}

/** 顯示重量：去掉尾隨 0（0.500 → 0.5、0.055 → 0.055） */
export function formatKg(kg: number): string {
  const n = round3(kg);
  if (n === 0) return "0";
  return n
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

// ─────────────────────────────────────────────────────────────
// 秤標籤（貼商品上，收銀掃返個條碼）
// ─────────────────────────────────────────────────────────────

export interface ScaleLabelInput {
  product: Pick<RetailProduct, "name" | "plu" | "unit">;
  /** 淨重（kg） */
  netKg: number;
  /** 金額（元） */
  amount: number;
  /** 每 kg 單價 */
  unitPrice: number;
  /** PLU 列印寬度（缺省 5） */
  pluLength?: number;
}

export interface ScaleLabel {
  /** 標籤上嘅文字行（由上至下） */
  lines: string[];
  /** 變重條碼 payload（未加校驗位）—— 供 W1 標籤秤 / 店內自編碼用 */
  barcodePayload: string | null;
}

/**
 * 組裝秤標籤內容。
 *
 * ⚠️ 條碼 payload 用**業界標準 21 前綴重量碼**（`21 + PLU(5) + 重量克(5)`），
 * 唔係跟商戶嘅自訂規則 —— 商戶自訂規則（`WeighedBarcodeRule`）係**解析用**，
 * 而呢度係**產生用**。若商戶已有自己嘅標籤秤，應該用返嗰部機出標籤，
 * 唔好兩邊都出（會撞格式）。
 */
export function buildScaleLabel(input: ScaleLabelInput): ScaleLabel {
  const pluLen = input.pluLength ?? 5;
  const plu = (input.product.plu ?? "").padStart(pluLen, "0").slice(-pluLen);
  const grams = Math.round(input.netKg * 1000);
  const hasPlu = Boolean((input.product.plu ?? "").trim());

  const lines = [
    input.product.name,
    `淨重 ${formatKg(input.netKg)} ${input.product.unit === "kg" ? "kg" : input.product.unit}`,
    `單價 $${input.unitPrice.toFixed(2)}/kg`,
    `金額 $${input.amount.toFixed(2)}`,
  ];
  if (hasPlu) lines.push(`PLU ${plu}`);

  // 只有有 PLU 才出得成標準變重碼（冇 PLU 就冇嘢可以認返商品）
  const barcodePayload = hasPlu ? `21${plu}${String(grams).padStart(5, "0").slice(-5)}` : null;
  return { lines, barcodePayload };
}

/**
 * 由金額反推重量（秤只出金額嘅舊式標籤秤）。
 *
 * 同 `docs/124 §10.3` 完全同一口徑：`weightKg = amount / unitPrice`。
 * 單價為 0 → 反推唔到（回 null，由呼叫端改用「改價」路徑）。
 */
export function weightFromAmount(amount: number, unitPrice: number): number | null {
  if (!Number.isFinite(amount) || !Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  return round3(Math.max(0, amount) / unitPrice);
}

/**
 * 檢查一個自訂變重規則係咪同商品對得上（設定頁即時預覽用）。
 * 只做**結構檢查**，唔判斷內容對錯（嗰個要真條碼才試得到）。
 */
export function describeRuleMatch(
  rule: WeighedBarcodeRule,
  product: Pick<RetailProduct, "plu">,
): { ok: boolean; reason?: string } {
  const plu = (product.plu ?? "").trim();
  if (!plu) return { ok: false, reason: "商品未填 PLU（秤端只認 PLU）" };
  if (plu.length > rule.pluLength) {
    return { ok: false, reason: `PLU「${plu}」比規則容許嘅 ${rule.pluLength} 位長` };
  }
  if (!rule.prefixes.some((p) => p.trim())) {
    return { ok: false, reason: "規則未設定前綴" };
  }
  return { ok: true };
}
