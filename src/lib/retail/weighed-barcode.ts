/**
 * 變重條碼（price-embedded EAN-13）解析 —— **純函式，零 runtime 依賴**。
 *
 * 【背景】零售賣菜 / 散裝商品嘅重量點入 POS 有兩條路：
 *   ① POS 統一印標籤（2026-09-12 商家定案）→ 秤只需要出重量；
 *   ② 客人已貼「條碼標籤秤」自己出嘅標籤 → POS 掃返個條碼就要解析到 PLU + 重量/金額。
 * 呢個檔就係 ② 嘅解析層。**唔整合都掃得到**，係兼容路徑（見 docs/124 §2.5）。
 *
 * 【為何規則要可配置】各品牌出廠規則唔同：
 *   - 前綴用 `2` 定 `02`（13 位 vs 12 位）
 *   - 尾 5 位係「重量（克）」定「金額（分）」
 *   - 有冇校驗位
 *   - PLU 由第幾位開始、幾多位
 * 所以一律由 `WeighedBarcodeRule` 描述，**唔可以寫死喺代碼**。
 */

import type { WeighedBarcodeHit, WeighedBarcodeRule } from "@/lib/retail/types";

/** 淨重保留 3 位小數（克 → kg 會有 FP 誤差，例如 350/1000 = 0.35） */
const roundKg = (v: number) => Math.round(v * 1000) / 1000;
/** 金額保留 2 位小數 */
const roundMoney = (v: number) => Math.round(v * 100) / 100;

/**
 * 正規化掃入嘅原始字串。
 *
 * 掃碼槍可能帶：
 *   - 頭尾空白 / `\r` `\n` `\t`（結尾字元）
 *   - 部分型號出廠加前綴（`~`、`%`、`#`）—— **呢度剝**，因為前綴屬 ScannerProfile 嘅職責，
 *     唔應該污染條碼本身。若商家將前綴配成「唔剝」，ScannerProfile 會先剝咗才交入嚟。
 */
export function normalizeScanInput(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).replace(/[\s\r\n\t]+/g, "").replace(/^[~%#]+/, "");
}

/** 純數字檢查（空字串 = false） */
export function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/**
 * EAN-13 校驗位：由首 12 位算出第 13 位。
 * 奇數位（1-indexed）×1、偶數位 ×3，總和嘅補數 mod 10。
 * 非法輸入回 `null`（唔回 0 —— 0 係合法校驗位，靜默回 0 會造成假通過）。
 */
export function ean13CheckDigit(first12: string): number | null {
  const s = normalizeScanInput(first12);
  if (!/^[0-9]{12}$/.test(s)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = s.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** 驗證 13 位 EAN-13 嘅校驗位 */
export function isValidEan13(code: string): boolean {
  const s = normalizeScanInput(code);
  if (!/^[0-9]{13}$/.test(s)) return false;
  const expected = ean13CheckDigit(s.slice(0, 12));
  if (expected === null) return false;
  return expected === s.charCodeAt(12) - 48;
}

/**
 * 揀出命中嘅規則。
 *
 * **長前綴優先**：若商家同時配咗 `"2"` 同 `"21"`，`2101234…` 一定要行 `"21"` 嗰條，
 * 否則 `"2"` 會搶先命中 → PLU 位數錯 → 解出嚟嘅商品碼全錯。
 * 同前綴長度時**先配先贏**（陣列次序），所以設定頁要提供排序。
 */
export function matchWeighedRule(
  code: string,
  rules: readonly WeighedBarcodeRule[],
): WeighedBarcodeRule | null {
  const s = normalizeScanInput(code);
  if (!s) return null;
  let best: WeighedBarcodeRule | null = null;
  let bestLen = -1;
  for (const rule of rules ?? []) {
    for (const p of rule.prefixes ?? []) {
      const prefix = normalizeScanInput(p);
      if (!prefix || !s.startsWith(prefix)) continue;
      if (prefix.length > bestLen) {
        best = rule;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/** 係唔係變重碼（只判斷前綴，唔解析內容） */
export function isWeighedBarcode(
  code: string,
  rules: readonly WeighedBarcodeRule[],
): boolean {
  return matchWeighedRule(code, rules) !== null;
}

/** 每條規則最少要幾多位（PLU 尾 + 數值尾 + 校驗位） */
export function minLengthOf(rule: WeighedBarcodeRule): number {
  return Math.max(
    rule.pluStart + rule.pluLength,
    rule.payloadStart + rule.payloadLength,
  ) + (rule.hasCheckDigit ? 1 : 0);
}

/**
 * 解析變重碼。
 *
 * 校驗位只喺**長度剛好 13** 時驗（EAN-13 標準）；12 位或 11 位嘅自家格式唔強驗，
 * 因為各品牌算法唔同 —— 寧可放行由條碼規則承擔，都唔好誤殺真標籤。
 * 長度唔夠 / 數值欄位非數字 → 回 `null`（呼叫端應該當「唔係變重碼」處理，唔好靜默當 0）。
 */
export function parseWeighedBarcode(
  code: string,
  rules: readonly WeighedBarcodeRule[],
): WeighedBarcodeHit | null {
  const s = normalizeScanInput(code);
  if (!s) return null;

  const rule = matchWeighedRule(s, rules);
  if (!rule) return null;

  if (!isDigits(s)) return null;
  if (s.length < minLengthOf(rule)) return null;

  // 校驗位：只喺標準 13 位 + 規則要求驗時檢查
  if (rule.hasCheckDigit && s.length === 13 && !isValidEan13(s)) return null;

  const plu = s.slice(rule.pluStart, rule.pluStart + rule.pluLength);
  if (!isDigits(plu)) return null;

  const raw = s.slice(rule.payloadStart, rule.payloadStart + rule.payloadLength);
  if (!isDigits(raw)) return null;

  const divisor = Number.isFinite(rule.divisor) && rule.divisor > 0 ? rule.divisor : 1;
  const value = parseInt(raw, 10) / divisor;

  if (rule.payloadKind === "weight_g" || rule.payloadKind === "weight_kg") {
    return { plu, weightKg: roundKg(value), ruleId: rule.id };
  }
  return { plu, price: roundMoney(value), ruleId: rule.id };
}

/**
 * 內建起點規則（**唔係自動生效**，商家要喺設定頁揀一條再微調）。
 *
 * 業界常見格式（來源：CAS CL 系列 / StoreTender 文件）：
 *   - `02 lllll PPPPP C`（13 位）：`02` 前綴、5 位商品碼、5 位金額（分）、校驗位
 *   - 同一個 `02` 前綴亦可以係 5 位**重量（克）**——邊一種係**秤端設定**，唔喺條碼裡面，
 *     所以商家一定要自己揀正確嘅 payloadKind（呢個係最常見嘅出錯位）。
 *   - `2 lllll PPPP C`（12 位）：舊式 4 位金額。
 *   - 21 / 22 分碼：21 = 重量（克）、22 = 金額（分）。
 */
export const WEIGHED_RULE_PRESETS: WeighedBarcodeRule[] = [
  {
    id: "preset-02-price",
    name: "標準 02（商品碼 5 位 + 金額 5 位）",
    prefixes: ["02"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "price_cents",
    divisor: 100,
    hasCheckDigit: true,
  },
  {
    id: "preset-02-weight",
    name: "標準 02（商品碼 5 位 + 重量 5 位·克）",
    prefixes: ["02"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "weight_g",
    divisor: 1000,
    hasCheckDigit: true,
  },
  {
    id: "preset-21-weight",
    name: "21 = 重量（商品碼 5 位 + 重量 5 位·克）",
    prefixes: ["21"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "weight_g",
    divisor: 1000,
    hasCheckDigit: true,
  },
  {
    id: "preset-22-price",
    name: "22 = 金額（商品碼 5 位 + 金額 5 位·分）",
    prefixes: ["22"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "price_cents",
    divisor: 100,
    hasCheckDigit: true,
  },
  {
    id: "preset-2-price-12",
    name: "舊式 2（商品碼 5 位 + 金額 4 位·分，12 位）",
    prefixes: ["2"],
    pluStart: 1,
    pluLength: 5,
    payloadStart: 6,
    payloadLength: 4,
    payloadKind: "price_cents",
    divisor: 100,
    hasCheckDigit: false,
  },
];

/** 顯示用描述（設定頁 / 除錯用；唔參與解析） */
export function describeWeighedRule(rule: WeighedBarcodeRule): string {
  const kind =
    rule.payloadKind === "weight_g"
      ? "重量（克）"
      : rule.payloadKind === "weight_kg"
        ? "重量（公斤）"
        : rule.payloadKind === "price_cents"
          ? "金額（分）"
          : "金額（元）";
  const total =
    Math.max(rule.pluStart + rule.pluLength, rule.payloadStart + rule.payloadLength) +
    (rule.hasCheckDigit ? 1 : 0);
  return `${rule.prefixes.join(" / ")} · 商品碼第 ${rule.pluStart + 1}–${
    rule.pluStart + rule.pluLength
  } 位 · ${kind} · 約 ${total} 位${rule.hasCheckDigit ? " · 有校驗位" : ""}`;
}
