"use client";

import { useMemo } from "react";

import { ResponsiveModal } from "@/components/responsive-modal";
import { isTableSelectable, occupiedTableHint } from "@/lib/pos/online-dinein-labels";

export type AssignableTable = { id: string; name: string; floorName: string };

type TableAssignModalProps = {
  /** 標題（通常 `排位 · 取餐號 002`）。 */
  title: string;
  description?: string;
  tables: AssignableTable[];
  /** 已經有單嘅枱 id（**唔可以揀** —— 商家 2026-09-12 要求）。 */
  occupiedTableIds: readonly string[];
  /** 正在提交嘅枱（顯示中狀態）。 */
  busyTableId?: string | null;
  onSelect: (table: AssignableTable) => void;
  onClose: () => void;
};

/**
 * 「排位」桌台選擇彈窗（線上堂食單用）。
 *
 * ## 設計要點
 * - **枱已被佔用 → 直接 disable + 標「使用中」**（商家明確要求：唔係「提示後仍可強制」）。
 * - 依樓層分組，一格一枱、`grid-cols-2 md:grid-cols-4`（同訂單頁原本嘅安排桌台彈窗一致）。
 * - 觸控目標 ≥40px（`px-3 py-3` + 兩行文字），符合專案觸控規範。
 *
 * ⚠️ 呼叫者要**剔除目標單自己佔用嘅枱**（改枱時原本張枱要仍然可揀），
 * 做法見 `quick-online-orders-panel` / `online-orders` 兩處 call site。
 */
export function TableAssignModal({
  title,
  description = "選擇桌台後會將線上單轉到該枱，並補印廚房單。",
  tables,
  occupiedTableIds,
  busyTableId = null,
  onSelect,
  onClose,
}: TableAssignModalProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, AssignableTable[]>();
    for (const table of tables) {
      const key = table.floorName || "未分區";
      const rows = map.get(key);
      if (rows) rows.push(table);
      else map.set(key, [table]);
    }
    return [...map.entries()];
  }, [tables]);

  return (
    <ResponsiveModal
      description={description}
      onClose={onClose}
      title={title}
      widthClassName="max-w-2xl"
    >
      {tables.length === 0 ? (
        <div className="text-sm text-slate-500">尚未設定桌台，請至「設置 → 桌台」新增。</div>
      ) : (
        <div className="max-h-[60vh] space-y-4 overflow-auto pr-1">
          {grouped.map(([floorName, rows]) => (
            <div key={floorName}>
              <div className="mb-2 text-xs font-semibold text-slate-500">{floorName}</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {rows.map((table) => {
                  const selectable = isTableSelectable(table.id, occupiedTableIds);
                  const busy = busyTableId === table.id;
                  return (
                    <button
                      key={table.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left text-sm font-semibold text-slate-900 hover:border-orange-300 hover:bg-orange-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100"
                      disabled={!selectable || busy || busyTableId !== null}
                      onClick={() => onSelect(table)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{table.name}</span>
                        {!selectable ? (
                          <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                            {occupiedTableHint()}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs font-normal text-slate-500">
                        {busy ? "處理中…" : table.floorName}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </ResponsiveModal>
  );
}
