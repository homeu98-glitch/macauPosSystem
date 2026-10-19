"use client";

import { useMemo, useState } from "react";

import { useT } from "@/components/lang-provider";
import { ResponsiveModal } from "@/components/responsive-modal";
import { formatMoney } from "@/lib/format";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { rawLedgerStatus } from "@/lib/ledger/order-mapper";
import { isTableSelectable, occupiedTableHint } from "@/lib/pos/online-dinein-labels";
import { loadPosLocalSettings } from "@/lib/storage";

export type OnlineReopenModalTable = { id: string; name: string; floorName: string };

type OnlineReopenModalProps = {
  order: LedgerOnlineOrder;
  /** 已翻譯嘅單號（呼叫端持有 `t`，避免 modal 重複砌 `orderCodeLabelParts`）。 */
  orderCode: string;
  /**
   * 使唔使揀枱：餐廳模式嘅線上堂食單要揀真枱（排位）；
   * 快餐模式／自取／外送一律採納 counter，唔使揀。
   */
  needsTable: boolean;
  tables: OnlineReopenModalTable[];
  /** 已經有單嘅枱 id（唔可以揀 —— 同「排位」彈窗同一口径）。 */
  occupiedTableIds: readonly string[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (params: { tableId: string | null; reason: string }) => void;
};

/** 冇樓層名時嘅分組標題（同時係字典 key）—— 同 TableAssignModal。 */
const FLOOR_FALLBACK = "未分區";

/**
 * 「搬去線下 · 返結」確認彈窗（2026-10-19 到店優惠改價，v3 mockup 畫面 ③）。
 *
 * 線上單本身（未搬落嚟）維持「撂唔到直接返結」—— 呢個彈窗係統一入口：
 * ① 先搬去線下（堂食揀真枱排位／自取外送採納 counter，保留線上單號）
 * ② 已收款單再返結（原因必填）→ 跳去工作枱改價；未收款單跳過返結直接改價。
 *
 * 已收款單撂落去唔會沖正／退款（款項喺會員通 Ledger），改價後嘅差額由
 * 結帳時嘅「差額處理」（充值返回／現金退款／店方保留）解決 —— 見 pos-app。
 */
export function OnlineReopenModal({
  order,
  orderCode,
  needsTable,
  tables,
  occupiedTableIds,
  busy,
  onClose,
  onConfirm,
}: OnlineReopenModalProps) {
  const t = useT();
  const [tableId, setTableId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const paid = order.paymentStatus === "paid";
  const completed = rawLedgerStatus(order.status) === "completed";

  const grouped = useMemo(() => {
    const map = new Map<string, OnlineReopenModalTable[]>();
    for (const table of tables) {
      const key = table.floorName || FLOOR_FALLBACK;
      const rows = map.get(key);
      if (rows) rows.push(table);
      else map.set(key, [table]);
    }
    return [...map.entries()];
  }, [tables]);

  const reopenReasons = loadPosLocalSettings()?.reopenReasons ?? [];
  const canConfirm = !busy && (!needsTable || tableId) && (!paid || Boolean(reason.trim()));

  return (
    <ResponsiveModal
      actions={
        <>
          <button
            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
            onClick={onClose}
            type="button"
          >
            {t("取消")}
          </button>
          <button
            className="rounded-2xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
            disabled={!canConfirm}
            onClick={() => onConfirm({ tableId: needsTable ? tableId : null, reason })}
            type="button"
          >
            {busy ? t("處理中…") : paid ? t("搬去線下並返結") : t("搬去線下並改價")}
          </button>
        </>
      }
      description={`${orderCode} · ${order.customerName ?? "--"} · ${formatMoney(order.total)}`}
      onClose={onClose}
      title={needsTable ? t("搬去線下 · 揀枱同返結") : t("搬去線下 · 採納同返結")}
      widthClassName="max-w-2xl"
    >
      <div className="grid gap-3">
        {/* 已完成單：保留入口但講清楚後果（v3 mockup 畫面 ①「會彈警告」）。 */}
        {completed ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            {t("此單已完成：返結只影響帳務補救，唔影響已交付嘅餐。")}
          </p>
        ) : null}

        {/* 已收款：講明唔沖正；未收款：講明跳過返結。 */}
        {paid ? (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 ring-1 ring-sky-200">
            {t("此單線上已付 {amt}，返結唔會沖正／退款（款項喺會員通 Ledger）。改價後嘅差額會喺結帳時處理。", {
              amt: formatMoney(order.total),
            })}
          </p>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
            {t("未收款單唔使返結 —— 系統搬去線下後直接跳去工作枱改價。")}
          </p>
        )}

        {needsTable ? (
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-500">
              {t("揀枱（必填）—— 揀後會建立本地堂食單，保留線上單號")}
            </div>
            {tables.length === 0 ? (
              <div className="text-sm text-slate-500">{t("尚未設定桌台，請至「設置 → 桌台」新增。")}</div>
            ) : (
              <div className="max-h-[38vh] space-y-3 overflow-auto pr-1">
                {grouped.map(([floorName, rows]) => (
                  <div key={floorName}>
                    {/* ⚠️ 樓層名係第 2 層資料值，唔可以 t()；只翻 fallback。 */}
                    <div className="mb-2 text-xs font-semibold text-slate-500">
                      {floorName === FLOOR_FALLBACK ? t(FLOOR_FALLBACK) : floorName}
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      {rows.map((table) => {
                        const selectable = isTableSelectable(table.id, occupiedTableIds);
                        const selected = tableId === table.id;
                        return (
                          <button
                            key={table.id}
                            className={`rounded-2xl border px-3 py-3 text-left text-sm font-semibold disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 ${
                              selected
                                ? "border-orange-500 bg-orange-50 text-slate-900"
                                : "border-slate-200 bg-slate-50 text-slate-900 hover:border-orange-300 hover:bg-orange-50"
                            }`}
                            disabled={!selectable || busy}
                            onClick={() => setTableId(table.id)}
                            type="button"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate">{table.name}</span>
                              {!selectable ? (
                                <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                                  {t(occupiedTableHint())}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-xs font-normal text-slate-500">{table.floorName}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              {t("系統會依序做：① 排位（建立本地堂食單，保留線上單號）② 線上單標「已完成」並喺線上列表剔除 ③ 張單變「已返結」→ 跳去工作枱改價。")}
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            {t("系統會依序做：① 採納成 counter 單（建立本地單，保留線上單號）② 張單變「已返結」→ 跳去工作枱改價。")}
          </p>
        )}

        {/* 返結原因（必填）—— 只有已收款單先彈返結；未收款單跳過呢一步。
            原因清單嚟自設置（`reopenReasons`），同線下「返結帳」同一份。 */}
        {paid ? (
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-500">{t("揀返結原因（必填）")}</div>
            <select
              className="w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="" disabled>
                {t("揀返結原因…")}
              </option>
              {reopenReasons.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[11px] text-amber-700">
              {t("必須揀返結原因，確認後跳去點餐枱面操作（可改價／加餐／重結）。")}
            </p>
          </div>
        ) : null}
      </div>
    </ResponsiveModal>
  );
}
