"use client";

// 訂單明細列表（共用）：逐筆顯示已結帳訂單。
// 列表形式（2026-09-10）：一條 row 對應一條 record，欄位固定、表頭 sticky、金額右對齊，
// 做法同「訂單頁」（local-orders-panel / online-orders）及「打印記錄」（print-center）完全一致。
//
// 欄位（8 欄）：
//   訂單號 · 狀態 · 餐台 · 收款類型 · 收銀員 · 結賬時間 · 應收(右) · 實收(右，綠色)
//
// 「狀態」欄：原本「取餐碼」係同訂單號擠喺同一格、冇自己嘅表頭，導致表頭同資料對唔齊。
//   而家獨立成欄並補上「狀態」表頭（線上單顯示取餐碼 badge，線下單顯示「—」）。
//
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

const TH_CELL = "sticky top-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500";
const TD_CELL = "px-3 py-2 align-middle";

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
  // ⚠️ 邊框同滾動容器由呼叫方提供（同「支付方式分項」一致，例如
  // `max-h-[420px] overflow-auto rounded-xl border border-slate-200`），
  // 呢度只出 <table>，避免雙重邊框；表頭 sticky 亦要靠呼叫方嘅滾動容器。
  return (
    <table className="w-full min-w-[1080px] table-fixed border-collapse text-left">
      <thead>
        <tr>
          <th className={`${TH_CELL} w-[118px]`}>訂單號</th>
          <th className={`${TH_CELL} w-[120px]`}>狀態</th>
          <th className={TH_CELL}>餐台</th>
          <th className={`${TH_CELL} w-[128px]`}>收款類型</th>
          <th className={`${TH_CELL} w-[132px]`}>收銀員</th>
          <th className={`${TH_CELL} w-[168px]`}>結賬時間</th>
          <th className={`${TH_CELL} w-[130px] text-right`}>應收</th>
          <th className={`${TH_CELL} w-[130px] text-right`}>實收</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-slate-100 even:bg-slate-50/60">
            <td className={TD_CELL}>
              <div className="truncate text-sm font-semibold text-slate-900">{row.orderNo ?? "線上單"}</div>
            </td>
            {/* 狀態欄：取餐碼（線上單先有）；線下單冇 → 「—」保持欄位對齊 */}
            <td className={TD_CELL}>
              {row.pickupCode ? (
                <span className="inline-flex whitespace-nowrap rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700">
                  取餐碼 {row.pickupCode}
                </span>
              ) : (
                <span className="text-xs text-slate-400">—</span>
              )}
            </td>
            <td className={TD_CELL}>
              <div className="truncate text-xs text-slate-500">{row.table}</div>
            </td>
            <td className={TD_CELL}>
              <div className="truncate text-xs text-slate-500">{row.method}</div>
            </td>
            <td className={TD_CELL}>
              <div className="truncate text-xs text-slate-500">{row.cashier}</div>
            </td>
            <td className={TD_CELL}>
              <div className="whitespace-nowrap text-xs tabular-nums text-slate-400">
                {row.settledAt ? formatMacauDateTime(row.settledAt) : "未記錄"}
              </div>
            </td>
            <td className={`${TD_CELL} text-right`}>
              <div className="whitespace-nowrap text-sm font-medium tabular-nums text-slate-700">
                {formatMoney(row.receivable)}
              </div>
            </td>
            <td className={`${TD_CELL} text-right`}>
              <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-emerald-700">
                {formatMoney(row.paid)}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
      {/* 合計：方便同「支付方式分項」對數 */}
      <tfoot>
        <tr className="border-t border-slate-200 bg-slate-50">
          <td className={`${TD_CELL} text-sm font-semibold text-slate-900`} colSpan={6}>
            合計（{rows.length} 張）
          </td>
          <td className={`${TD_CELL} text-right text-sm font-semibold tabular-nums text-slate-900`}>
            {formatMoney(totalReceivable)}
          </td>
          <td className={`${TD_CELL} text-right text-sm font-semibold tabular-nums text-emerald-700`}>
            {formatMoney(totalPaid)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
