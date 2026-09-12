/**
 * 零售收據區塊內容 —— **純函式，零 runtime 依賴**。
 *
 * 【為何要抽出嚟】`escpos-template.ts` 有 runtime import（`@/lib/format`、`@/lib/escpos-render`）
 * → `node --test` 載入唔到，所以歷來冇任何單測覆蓋收據內容建構。
 * 呢四個新區塊嘅**格式化邏輯**（多行、空值抑制、金額格式）係易錯位，
 * 所以抽出嚟做純函式，令 `buildReceiptContent()` 只負責「call + spread」。
 *
 * 🔑 **呢四個都係「靜態文字區塊」** → 下游三端（Companion / APK / print-hub）
 * 只 loop `snapshot.blocks` 再印 `content[id]`，**唔使識呢啲 id 都印得出**，
 * 所以加佢哋**零跨 repo 改動**（唔似 `PrintJob.items[]` 嗰類逐項資料）。
 *
 * 🔴 **空字串 = 區塊自動略過**（同 `qr_code` 冇網址時一樣）→ 餐飲單 / 舊單零影響。
 * 呢個係本檔每個 builder 都必須守住嘅契約：冇資料就回 ""，**唔可以回標題 + 空白**。
 */

/** 金額格式化由呼叫端注入（保持本檔零依賴；`escpos-template` 傳 `formatMoney` 入嚟） */
export type AmountFormatter = (amount: number) => string;

/** 少於半分視為 0（避免 FP 誤差印出 `$0.00` 一行） */
const isZeroAmount = (v: number) => !Number.isFinite(v) || Math.abs(v) < 0.004;

/**
 * 拆分付款逐筆明細（多行）。
 *
 * 格式：每筆一行 `<標籤>: <金額>`，**唔另加標題行** ——
 * 同 `discount_breakdown` 嘅既有手法一致（每行自我描述）。
 *
 * - 0 金額嘅筆數略過（退貨沖正 / 手誤留空）
 * - 全部略過 → 回 `""`（區塊唔會出）
 */
export function buildSplitPaymentLines(
  splitPayments: ReadonlyArray<{ label: string; amount: number }> | undefined,
  formatAmount: AmountFormatter,
): string {
  const rows = (splitPayments ?? [])
    .filter((p) => p && !isZeroAmount(p.amount))
    .map((p) => `${String(p.label ?? "").trim() || "付款"}: ${formatAmount(p.amount)}`);
  return rows.join("\n");
}

/**
 * 會員積分行。
 *
 * 三種情況：
 * - 兩個都有 → `會員積分: 本單 +449 / 結餘 1729`
 * - 只有賺取 → `會員積分: 本單 +449`
 * - 只有結餘 → `會員積分: 結餘 1729`
 * - 兩個都冇（或都係 0）→ `""`
 *
 * ⚠️ 賺取 0 分**唔算有資料**（冇會員 / 未登入）→ 唔應該出一行「本單 +0」。
 */
export function buildPointsEarnedLine(
  pointsEarned: number | undefined,
  pointsBalanceAfter: number | undefined,
): string {
  const hasEarned = typeof pointsEarned === "number" && Number.isFinite(pointsEarned) && pointsEarned !== 0;
  const hasBalance =
    typeof pointsBalanceAfter === "number" && Number.isFinite(pointsBalanceAfter);
  if (!hasEarned && !hasBalance) return "";

  const parts: string[] = [];
  if (hasEarned) parts.push(`本單 ${pointsEarned > 0 ? "+" : ""}${pointsEarned}`);
  if (hasBalance) parts.push(`結餘 ${pointsBalanceAfter}`);
  return `會員積分: ${parts.join(" / ")}`;
}

/**
 * 換貨單原單號行。空白 → `""`（非換貨單唔會出）。
 */
export function buildExchangeOfLine(exchangeOf: string | undefined | null): string {
  const s = String(exchangeOf ?? "").trim();
  return s ? `換貨單: 原單 ${s}` : "";
}

/**
 * 退換貨條款（模板層級自由文字）。
 *
 * ⚠️ **一定要 trim**：商家喺 textarea 打咗幾個空格 / 換行就當「冇填」，
 * 否則會出一行空白（同「狀態唔准靜默」同一個原則：冇內容就唔應該佔一行紙）。
 */
export function buildReturnPolicyText(returnPolicyText: string | undefined | null): string {
  return String(returnPolicyText ?? "").trim();
}

/** 零售四個區塊嘅內容（key 對應 `ReceiptSectionId`） */
export function buildRetailReceiptBlocks(
  order: {
    splitPayments?: ReadonlyArray<{ label: string; amount: number }>;
    pointsEarned?: number;
    pointsBalanceAfter?: number;
    exchangeOf?: string;
  },
  opts: { formatAmount: AmountFormatter; returnPolicyText?: string },
): Record<"split_payment" | "points_earned" | "exchange_of" | "return_policy", string> {
  return {
    split_payment: buildSplitPaymentLines(order.splitPayments, opts.formatAmount),
    points_earned: buildPointsEarnedLine(order.pointsEarned, order.pointsBalanceAfter),
    exchange_of: buildExchangeOfLine(order.exchangeOf),
    return_policy: buildReturnPolicyText(opts.returnPolicyText),
  };
}
