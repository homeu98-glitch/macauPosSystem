"use client";

import { type WorkbenchDef, type WorkbenchId } from "@/lib/pos/module-catalog";

/**
 * 工作台卡（選擇工作台頁嘅一格）—— **共用元件**。
 *
 * ## 為什麼要抽呢個檔
 *
 * 呢組卡有兩個地方要用：
 *   1. 真·`/select-workbench`（店員實際揀）
 *   2. Admin「模組授權」彈窗嘅**預覽**（管理員撳開關時即刻睇到商家會見到咩）
 *
 * 兩邊一定要係**同一份 markup**。如果 preview 自己抄一份，好快就會出現
 * 「預覽睇到有 5 個，實際登入見到 4 個」呢種最難查嘅落差 ——
 * 而且唔會 throw，只會令管理員唔信個預覽。
 *
 * ⚠️ 呢個檔嘅樣式係**深色**（配合 POS 登入系嘅玻璃背景）。
 * Admin 面板係淺色，所以預覽要放喺一個深色嘅「裝置框」入面，
 * 唔可以就咁塞入淺色卡片 —— 白底白字會完全睇唔到。
 */

const ACCENT_RING: Record<WorkbenchDef["accent"], string> = {
  orange: "border-orange-500/60 bg-orange-500/15",
  emerald: "border-emerald-500/55 bg-emerald-500/10",
  sky: "border-sky-500/55 bg-sky-500/10",
  rose: "border-rose-500/55 bg-rose-500/10",
};

const ACCENT_DOT: Record<WorkbenchDef["accent"], string> = {
  orange: "bg-orange-400",
  emerald: "bg-emerald-400",
  sky: "bg-sky-400",
  rose: "bg-rose-400",
};

export function WorkbenchCardGroup({
  title,
  workbenches,
  grantedSet,
  lastWorkbench = null,
  busyId = null,
  onChoose,
  readOnly = false,
  columns = 2,
}: {
  title: string;
  workbenches: WorkbenchDef[];
  grantedSet: Set<WorkbenchId>;
  /** 標「上次使用」徽章用。預覽通常傳 null。 */
  lastWorkbench?: WorkbenchId | null;
  busyId?: WorkbenchId | null;
  onChoose?: (workbench: WorkbenchDef) => void;
  /** 預覽模式：唔可以撳（但仍然照樣顯示灰／🔒 狀態）。 */
  readOnly?: boolean;
  /**
   * 大螢幕欄數。
   *
   * ⚠️ 刻意**唔**用 `workbenches.length` 自動推：兩組嘅自然排版唔同 ——
   * 收銀組有 4 項（2×2 最靚），裝置角色有 3 項（一行 3 個最靚）。
   * 自動推「≥3 就用 3 欄」會令收銀組變成 3+1（吊一個落第二行），
   * 同確認稿唔一致。
   */
  columns?: 2 | 3;
}) {
  if (workbenches.length === 0) return null;

  const gridCols = columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

  return (
    <section className="mt-4">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-xs font-extrabold tracking-wide text-white/70">{title}</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <div className={`grid grid-cols-1 gap-3 ${gridCols}`}>
        {workbenches.map((w) => {
          const granted = grantedSet.has(w.id);
          const isLast = lastWorkbench === w.id;
          const busy = busyId === w.id;

          return (
            <button
              key={w.id}
              className={`relative grid min-h-[86px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition ${
                granted
                  ? isLast
                    ? `${ACCENT_RING[w.accent]}`
                    : "border-white/15 bg-white/5"
                  : "border-white/10 bg-white/[0.03]"
              } ${busy ? "opacity-60" : ""} ${
                readOnly ? "" : "hover:border-white/25 hover:bg-white/10"
              }`}
              disabled={busy || readOnly}
              onClick={readOnly ? undefined : () => onChoose?.(w)}
              type="button"
            >
              {isLast && granted ? (
                <span className="absolute -top-2 right-3 rounded-full bg-orange-500 px-2.5 py-0.5 text-[10px] font-extrabold tracking-wide text-white">
                  上次使用
                </span>
              ) : null}
              {!granted ? (
                <span className="absolute -top-2 right-3 rounded-full bg-slate-700 px-2.5 py-0.5 text-[10px] font-extrabold tracking-wide text-slate-300">
                  未開通
                </span>
              ) : null}

              <span
                className={`grid h-11 w-11 place-items-center rounded-full text-sm font-bold ${
                  granted ? "bg-white/10 text-white" : "bg-white/5 text-white/40"
                }`}
              >
                {w.short}
              </span>

              <span className="min-w-0">
                <span
                  className={`block text-sm font-bold ${granted ? "text-white" : "text-white/45"}`}
                >
                  {w.label}
                </span>
                <span
                  className={`mt-1 block text-[11.5px] leading-snug ${
                    granted ? "text-white/55" : "text-white/30"
                  }`}
                >
                  {w.desc}
                </span>
              </span>

              <span
                className={`whitespace-nowrap text-[11.5px] font-bold ${
                  granted ? "text-white/45" : "text-white/25"
                }`}
              >
                {busy ? "進入中…" : granted ? "進入 →" : "🔒"}
              </span>

              {granted ? (
                <span
                  aria-hidden
                  className={`absolute right-3 top-3 h-1.5 w-1.5 rounded-full ${ACCENT_DOT[w.accent]}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
