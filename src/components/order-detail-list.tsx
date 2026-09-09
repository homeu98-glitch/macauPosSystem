"use client";

// 訂單明細列表（共用）：逐筆顯示已結帳訂單
// 欄位：餐台 · 應收金額 · 實收金額 · 收款類型 · 收銀員 · 結賬時間
// 用喺：交班頁（今日摘要）+ 餐飲日報（支付方式分項上方）。
// 口徑同「支付方式分項」一致：應收 = 原價合計 + 服務費 + 稅；實收 = order.total。

import { formatMacauDateTime, formatMoney } from "@/lib/format";

export interface OrderDetailRow {
  id: string;
  /** 餐台名（快餐 / 線上單為「外賣」「自取」「堂食」等標籤）。 */
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
    <table className="w-full border-collapse text-sm">
      <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
        <tr>
          <th className="border-b border-slate-200 px-3 py-2">餐台</th>
          <th className="border-b border-slate-200 px-3 py-2 text-right">應收金額</th>
          <th className="border-b border-slate-200 px-3 py-2 text-right">實收金額</th>
          <th className="border-b border-slate-200 px-3 py-2">收款類型</th>
          <th className="border-b border-slate-200 px-3 py-2">收銀員</th>
          <th className="border-b border-slate-200 px-3 py-2">結賬時間</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
            <td className="px-3 py-2 font-semibold text-slate-900">{row.table}</td>
            <td className="px-3 py-2 text-right text-slate-700">{formatMoney(row.receivable)}</td>
            <td className="px-3 py-2 text-right font-semibold text-emerald-700">{formatMoney(row.paid)}</td>
            <td className="px-3 py-2 text-slate-700">{row.method}</td>
            <td className="px-3 py-2 text-slate-700">{row.cashier}</td>
            <td className="px-3 py-2 whitespace-nowrap text-slate-700">
              {row.settledAt ? formatMacauDateTime(row.settledAt) : "未記錄"}
            </td>
          </tr>
        ))}
        {/* 合計行：方便同「支付方式分項」對數 */}
        <tr className="bg-slate-50 text-sm font-semibold text-slate-900">
          <td className="px-3 py-2">合計（{rows.length} 張）</td>
          <td className="px-3 py-2 text-right">{formatMoney(totalReceivable)}</td>
          <td className="px-3 py-2 text-right text-emerald-700">{formatMoney(totalPaid)}</td>
          <td className="px-3 py-2" colSpan={3} />
        </tr>
      </tbody>
    </table>
  );
}
