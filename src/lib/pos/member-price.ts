import type { MenuItem } from "@/lib/types";

/**
 * 會員價計價（2026-10-20，掃碼點餐「會員價」功能）。
 *
 * ## 規則（J 拍板）
 * 1. **逐項各自計**：每件菜有冇單品會員價，各自決定用邊種算法。
 * 2. 有 `memberPrice`（單品會員價，絕對金額）→ **用佢**（override 全店百分比）。
 * 3. 冇 → 用 `原價 × memberDiscountRate / 100`（全店會員折扣）。
 * 4. 兩者都冇 → 收原價（等同非會員）。
 * 5. 最後**加總**，唔係「先加總再打折」。
 *
 * ## 為何要抽成純函式
 * 同一條公式要喺**四個地方**跑，唔可以各寫一份：
 * - 客人手機端（顯示會員價、購物車合計）
 * - 落單時寫 `OrderItem.memberPrice` 快照
 * - 伺服器 `scan-debit/quote|commit`（**核價真源**，唔信 client）
 * - POS 前台（下一步）
 *
 * 抄四份 = 四份會各自漂移，客人見到一個價、收銀收另一個價。
 *
 * ## rate 語義
 * 同 `@/lib/pos/discount` 一致：百分比數字 0-100，`95` = 95 折（收原價 95%）。
 * `100` / `0` / `undefined` / 負數 = 冇會員折扣。
 *
 * 零 runtime import（只 `import type`）→ 可以被 `node --test` 直接覆蓋。
 */

/** 有效嘅會員折扣率（1–99 才算；100 = 冇折扣，0 或負數 = 資料異常）。 */
export function isValidMemberDiscountRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 100;
}

/**
 * 單品會員價是否有效：必須 `> 0` 且**嚴格細於**原價。
 *
 * 等於原價 = 冇優惠（唔顯示「會員價 MOP 38.00」呢啲廢話）；
 * 大於原價 = 設定錯（例如原價由 38 減到 28 但會員價仲係 30）→ 一律當冇設，
 * 寧可跟全店折扣，都唔可以收貴過原價。
 */
export function isValidMemberPrice(
  memberPrice: number | null | undefined,
  basePrice: number,
): memberPrice is number {
  return (
    typeof memberPrice === "number" &&
    Number.isFinite(memberPrice) &&
    memberPrice > 0 &&
    Number.isFinite(basePrice) &&
    memberPrice < basePrice
  );
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 由「原價 + 單品會員價 + 全店率」算出**單件**會員價。
 *
 * @param basePrice 原價單價（**未含**規格加價）
 * @param memberPrice 單品會員價（絕對金額）；`undefined` = 冇設
 * @param memberDiscountRate 全店會員折扣百分比
 * @param specDelta 規格加價（唔打折，直接加）
 */
export function memberUnitPrice(
  basePrice: number,
  memberPrice: number | undefined,
  memberDiscountRate: number | undefined,
  specDelta = 0,
): number {
  const base = Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0;
  const delta = Number.isFinite(specDelta) ? specDelta : 0;

  // ① 單品會員價優先（override 全店百分比）
  if (isValidMemberPrice(memberPrice, base)) {
    return roundMoney(memberPrice + delta);
  }
  // ② 全店會員折扣
  if (isValidMemberDiscountRate(memberDiscountRate)) {
    return roundMoney((base * memberDiscountRate) / 100 + delta);
  }
  // ③ 冇任何會員優惠 → 原價
  return roundMoney(base + delta);
}

/** 客人端用：由 `MenuItem` 直接算該菜（未計規格）嘅會員價。 */
export function memberUnitPriceForMenuItem(
  item: Pick<MenuItem, "price" | "memberPrice">,
  memberDiscountRate: number | undefined,
): number {
  return memberUnitPrice(item.price, item.memberPrice, memberDiscountRate);
}

/**
 * 呢件菜有冇「會員優惠」可以顯示？
 *
 * 用於決定餐牌要唔要顯示「原價 MOP X　會員 MOP Y」——冇優惠就唔應該顯示
 * （否則會出現「原價 38、會員 38」呢種令人以為有折但其實冇嘅寫法）。
 */
export function hasMemberBenefit(
  item: Pick<MenuItem, "price" | "memberPrice">,
  memberDiscountRate: number | undefined,
): boolean {
  return memberUnitPriceForMenuItem(item, memberDiscountRate) < roundMoney(item.price);
}

export type MemberTotalsLine = {
  price: number;
  quantity: number;
  /** 落單時快照嘅會員單價（含規格加價）；`undefined` = 該行冇會員價 */
  memberPrice?: number;
};

export type MemberOrderTotals = {
  /** 原價合計（price × quantity） */
  original: number;
  /** 會員價合計（逐項：memberPrice 快照 → 否則 × 全店率） */
  member: number;
  /** 共慳（original − member，最少 0） */
  saving: number;
};

/**
 * 整張單嘅會員價合計（**逐項各自計＋加總**）。
 *
 * ⚠️ 唔可以寫成 `original × rate`：咁樣有單品會員價嘅項會被重複打折
 * （先套單品價、再乘全店率），客人會發現「計出嚟平過我見到嘅價」。
 */
export function memberOrderTotals(
  lines: readonly MemberTotalsLine[],
  memberDiscountRate: number | undefined,
): MemberOrderTotals {
  let original = 0;
  let member = 0;
  for (const line of lines) {
    const qty = Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const unitOriginal = Number.isFinite(line.price) ? line.price : 0;
    original += unitOriginal * qty;

    // 有快照（落單時已計好，含規格加價）就用快照；冇就即場用全店率算。
    const unitMember = isValidMemberPrice(line.memberPrice, unitOriginal)
      ? line.memberPrice
      : isValidMemberDiscountRate(memberDiscountRate)
        ? (unitOriginal * memberDiscountRate) / 100
        : unitOriginal;
    member += unitMember * qty;
  }
  const roundedOriginal = roundMoney(original);
  const roundedMember = roundMoney(member);
  return {
    original: roundedOriginal,
    member: roundedMember,
    saving: Math.max(0, roundMoney(roundedOriginal - roundedMember)),
  };
}
