"use client";

// 訂單明細列表（共用）：逐筆顯示已結帳訂單。
// 列表形式（2026-09-10）：一條 row 對應一條 record，欄位固定、表頭 sticky、金額右對齊，
// 做法同「訂單頁」（local-orders-panel / online-orders）及「打印記錄」（print-center）完全一致。
//
// 欄位（9 欄，2026-09-11 調整）：
//   訂單號 · 折扣備註 · 餐台 · 收款類型 · 收銀員 · 結賬時間 · 應收(右) · 優惠金額(右) · 實收(右，綠色)
//
// 2026-09-11 改動（折扣備註需求 #3 / #4）：
//   1. **移除「狀態」欄** —— 該欄其實只裝「取餐碼」（線下單永遠顯示「—」），唔係訂單狀態。
//      為免資訊流失，取餐碼併入「訂單號」欄第二行做細 badge（有先顯示）。
//   2. 騰出嘅欄位改為「折扣備註」：凡影響實收嘅調整（折扣 / 免單 / 系統抹零）都要顯示原因，
//      令每筆價格變動可追溯。逐件單品折扣嘅原因會自動去重列出。
//   3. 新增「優惠金額」欄，放喺**實收左邊**，= 應收 − 實收（涵蓋單品折扣／全單折扣／免單／抹零）。
//
// 用喺：交班頁（今日摘要）+ 餐飲日報（支付方式分項上方）。
// 口徑同「支付方式分項」一致：應收 = 原價合計 + 服務費 + 稅；實收 = order.total。

import { formatMacauDateTime, formatMoney } from "@/lib/format";
import type { OrderDetailNote, OrderDetailNoteKind } from "@/lib/pos/order-notes";

// 備註型別嘅**真源**喺 `@/lib/pos/order-notes`（推導邏輯同型別綁埋一齊，避免兩處漂移）。
// 呢度 re-export 只為方便已 import 本元件嘅呼叫方。
export type { OrderDetailNote, OrderDetailNoteKind };

export interface OrderDetailRow {
  id: string;
  /** 訂單號（POS localOrderNo，本身已帶「訂單」前綴，如「訂單22」）。缺省顯示「線上單」。 */
  orderNo?: string;
  /** 取餐碼（Ledger 線上單先有，如「005」）。已併入「訂單號」欄第二行。 */
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
  /** 折扣 / 免單 / 抹零備註（可多個，例如一個單品折扣 + 一個抹零）。空陣列 = 冇任何調整。 */
  notes?: OrderDetailNote[];
}

const TH_CELL = "sticky top-0 z-10 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500";
const TD_CELL = "px-3 py-2 align-middle";

/** 折扣備註 chip 配色：折扣（琥珀）／免單（玫紅）／抹零（灰）。 */
const NOTE_CHIP: Record<OrderDetailNoteKind, string> = {
  discount: "bg-amber-100 text-amber-800",
  comp: "bg-rose-100 text-rose-700",
  round: "bg-slate-100 text-slate-600",
};

/** 該筆訂單實際獲得嘅優惠總額 = 應收 − 實收（涵蓋單品折扣、全單折扣、免單、系統抹零）。 */
function rowSaving(row: OrderDetailRow): number {
  return Math.max(0, row.receivable - row.paid);
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
  const totalSaving = rows.reduce((s, r) => s + rowSaving(r), 0);
  const totalPaid = rows.reduce((s, r) => s + r.paid, 0);
  // ⚠️ 邊框同滾動容器由呼叫方提供（同「支付方式分項」一致，例如
  // `max-h-[420px] overflow-auto rounded-xl border border-slate-200`），
  // 呢度只出 <table>，避免雙重邊框；表頭 sticky 亦要靠呼叫方嘅滾動容器。
  //
  // 響應式（2026-09-10 修 + 2026-09-11 加欄後重調）：欄寬用百分比 + `table-fixed`，
  // 表格闊度永遠等於容器闊度（iPad 橫向／直向都唔會撐爆）。
  // `min-w-[900px]` 只係下限：容器窄過佢（例如手機 / iPad 直向）先出現橫向滾動。
  return (
    <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
      <thead>
        <tr>
          <th className={`${TH_CELL} w-[13%]`}>訂單號</th>
          <th className={`${TH_CELL} w-[16%]`}>折扣備註</th>
          <th className={`${TH_CELL} w-[8%]`}>餐台</th>
          <th className={`${TH_CELL} w-[10%]`}>收款類型</th>
          <th className={`${TH_CELL} w-[9%]`}>收銀員</th>
          <th className={`${TH_CELL} w-[13%]`}>結賬時間</th>
          <th className={`${TH_CELL} w-[9%] text-right`}>應收</th>
          <th className={`${TH_CELL} w-[11%] text-right`}>優惠金額</th>
          <th className={`${TH_CELL} w-[11%] text-right`}>實收</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const saving = rowSaving(row);
          const notes = row.notes ?? [];
          return (
            <tr key={row.id} className="border-t border-slate-100 even:bg-slate-50/60">
              <td className={TD_CELL}>
                <div className="truncate text-sm font-semibold text-slate-900">{row.orderNo ?? "線上單"}</div>
                {/* 取餐碼：原本係「狀態」欄，2026-09-11 併入呢度第二行（線下單冇 → 唔顯示） */}
                {row.pickupCode ? (
                  <div className="mt-1">
                    <span className="inline-flex whitespace-nowrap rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                      取餐碼 {row.pickupCode}
                    </span>
                  </div>
                ) : null}
              </td>
              {/* 折扣備註欄：凡影響實收嘅調整都列出原因（折扣 / 免單 / 抹零） */}
              <td className={TD_CELL}>
                {notes.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {notes.map((note, index) => (
                      <span
                        key={`${note.kind}-${note.text}-${index}`}
                        className={`inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold ${
                          NOTE_CHIP[note.kind] ?? NOTE_CHIP.round
                        }`}
                        title={note.text}
                      >
                        {note.text}
                      </span>
                    ))}
                  </div>
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
              {/* 優惠金額（新增，放喺實收左邊）：= 應收 − 實收 */}
              <td className={`${TD_CELL} text-right`}>
                <div
                  className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
                    saving > 0 ? "text-amber-700" : "text-slate-400"
                  }`}
                >
                  {saving > 0 ? `− ${formatMoney(saving)}` : formatMoney(0)}
                </div>
              </td>
              <td className={`${TD_CELL} text-right`}>
                <div className="whitespace-nowrap text-sm font-semibold tabular-nums text-emerald-700">
                  {formatMoney(row.paid)}
                </div>
              </td>
            </tr>
          );
        })}
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
          <td className={`${TD_CELL} text-right text-sm font-semibold tabular-nums text-amber-700`}>
            {totalSaving > 0 ? `− ${formatMoney(totalSaving)}` : formatMoney(0)}
          </td>
          <td className={`${TD_CELL} text-right text-sm font-semibold tabular-nums text-emerald-700`}>
            {formatMoney(totalPaid)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
