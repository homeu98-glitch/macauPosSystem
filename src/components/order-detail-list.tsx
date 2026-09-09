"use client";

// 訂單明細列表（共用）：逐筆顯示已結帳訂單
// 每筆訂單係一張豎排卡片：
//   第一列     訂單號（如「訂單22」）＋ 取餐碼（線上單先有，如「取餐碼 005」）
//   中間列     餐台 · 收款類型 · 收銀員 · 結賬時間（順序不變）
//   倒數第二列  應收金額
//   最後一列   實收金額（強調色）
// 用喺：交班頁（今日摘要）+ 餐飲日報（支付方式分項上方）。
// 口徑同「支付方式分項」一致：應收 = 原價合計 + 服務費 + 稅；實收 = order.total。

import { formatMacauDateTime, formatMoney } from "@/lib/format";

export interface OrderDetailRow {
  id: string;
  /** 訂單號（POS localOrderNo，本身已帶「訂單」前綴，如「訂單22」）。缺省顯示「線上單」。 */
  orderNo?: string;
  /** 取餐碼（Ledger 線上單先有，如「005」）。 */
  pickupCode?: string;
  /** 餐台名（快餐 / 線上單為「外賣」「自取」「線上·堂食」等標籤）。 */
  table: string;
  /** 應收金額（原價合計 + 服務費 + 稅）。 */
  receivable: number;
  /** 實收金額（= order.total / 線上單 paidAmount）。 */
  paid: number;
  /** 收款類型（order.paymentMethod / paymentModeLabel）。 */
  method: string;
  /** 收銀員（結帳操作人；舊單 / 線上單可能「未記錄」）。 */
  cashier: string;
  /** 結賬時間（ISO；空字串 = 未記錄）。 */
  settledAt: string;
}

/** 卡片內一列：label 靠左固定闊（對齊），value 靠右。 */
function DetailRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "green";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="w-16 shrink-0 text-xs text-slate-500">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-sm ${
          tone === "green" ? "font-semibold text-emerald-700" : "font-medium text-slate-700"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function OrderDetailList({
  rows,
  emptyText = "暫無已結帳訂單。",
}: {
  rows: OrderDetailRow[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <div className="text-sm text-slate-500">{emptyText}</div>;
  }
  const totalReceivable = rows.reduce((s, r) => s + r.receivable, 0);
  const totalPaid = rows.reduce((s, r) => s + r.paid, 0);
  return (
    <div className="grid gap-2">
      {rows.map((row) => (
        <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-3">
          {/* 第一列：訂單號 + 取餐碼 */}
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-bold text-slate-900">
              {row.orderNo ?? "線上單"}
            </span>
            {row.pickupCode ? (
              <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700">
                取餐碼 {row.pickupCode}
              </span>
            ) : null}
          </div>
          {/* 中間列 → 倒數第二列（應收）→ 最後一列（實收） */}
          <div className="mt-2 grid gap-1.5 border-t border-slate-100 pt-2">
            <DetailRow label="餐台" value={row.table} />
            <DetailRow label="收款類型" value={row.method} />
            <DetailRow label="收銀員" value={row.cashier} />
            <DetailRow label="結賬時間" value={row.settledAt ? formatMacauDateTime(row.settledAt) : "未記錄"} />
            <DetailRow label="應收金額" value={formatMoney(row.receivable)} />
            <DetailRow label="實收金額" value={formatMoney(row.paid)} tone="green" />
          </div>
        </div>
      ))}
      {/* 合計：方便同「支付方式分項」對數 */}
      <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
        <span className="shrink-0">合計（{rows.length} 張）</span>
        <span className="flex min-w-0 items-center gap-4">
          <span className="shrink-0">應收 {formatMoney(totalReceivable)}</span>
          <span className="shrink-0 text-emerald-700">實收 {formatMoney(totalPaid)}</span>
        </span>
      </div>
    </div>
  );
}
