"use client";

import { useEffect, useRef, useState } from "react";

import { useSyncHealth } from "@/lib/pos/sync-acks";

/**
 * 桌台總覽標題列嘅**維修工具 icon 掣**（無文字）—— 收埋「手動更新」＋「同步健康」兩個動作。
 *
 * ── 點解要合併（2026-09-15 J 拍板）──────────────────────────────────────
 * 標題列要放齊「開工 / 維修 / 線上接單 / 線下接單」仲要**同一行唔掉第二行**，
 * 而 iPad 橫向（1084px）標題列可用只有約 692px。
 * 兩粒文字掣（手動更新 98 ＋ 同步健康 98）本來佔 194px；
 * 合併成一個 42px icon 之後省 152px —— 正常情況下商家根本唔會撳呢兩粒，
 * 唔值得長期霸住寶貴嘅橫向空間。
 *
 * ── 交互（J 揀方案 A）──────────────────────────────────────────────────
 * 撳一下**彈小選單**，兩個動作照舊分開、各有解釋文字 —— 唔會撳錯。
 * （方案 B「撳一下直接執行手動更新」被否決：隱藏行為太難發現。）
 *
 * ── 角標 = 待上傳數量 ──────────────────────────────────────────────────
 * 同側欄「在線 / 2 張待傳」**同一份真源**（`useSyncHealth()`）：
 * - 一切正常 → 冇角標（零資訊量唔應該出現）
 * - 有待傳 → 琥珀色數字
 * - 連續補推失敗（blocked）→ 紅色數字（比琥珀更嚴重，同側欄一致）
 */

/**
 * 選單項目。⚠️ 一定要喺**模組層**定義（唔可以喺元件 render 期間定義，
 * 唔係每次 render 都係新元件 → state 被重置，eslint `react-hooks/static-components` 會報錯）。
 *
 * ⚠️ 文字字級一定要寫喺**內層 div**（唔可以寫喺 `<button>` 身上）：
 * `globals.css` 有無 `@layer` 嘅 `button{font:inherit}`，會蓋過 Tailwind 嘅 `text-*`。
 */
function ToolsMenuItem({
  title,
  description,
  disabled,
  onPick,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      className="block w-full rounded-xl px-3 py-2.5 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onPick}
      role="menuitem"
      type="button"
    >
      <div className="text-[13px] font-semibold text-slate-900">{title}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{description}</div>
    </button>
  );
}

type PosToolsMenuProps = {
  /** 手動更新進行中 / bootstrap 中 → 「手動更新」停用並顯示「更新中…」。 */
  busy: boolean;
  onManualUpdate: () => void;
  onSyncHealth: () => void;
};

export function PosToolsMenu({ busy, onManualUpdate, onSyncHealth }: PosToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const syncHealth = useSyncHealth();

  const blocked = syncHealth.level === "blocked";
  const pendingCount = blocked
    ? syncHealth.blocked
    : syncHealth.waitingAck + syncHealth.pending + syncHealth.failed;
  const showBadge = blocked || pendingCount > 0;

  // 點出面 / 撳 Esc 閂選單（唔用 modal，唔阻住收銀做嘢）
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /**
   * 揀完即刻閂選單再執行 —— 收銀唔應該見到選單停留喺度。
   */
  function pick(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="維修工具：手動更新 / 同步健康"
        className="relative flex h-[42px] w-[42px] items-center justify-center rounded-2xl bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
        title="維修工具：手動更新 / 同步健康"
        type="button"
      >
        {/* 滑桿圖示（＝維修／工具）；刻意唔用齒輪，同側欄「設置」分開 */}
        <svg
          aria-hidden="true"
          fill="none"
          height="19"
          stroke="#334155"
          strokeLinecap="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="19"
        >
          <line x1="4" x2="20" y1="7" y2="7" />
          <circle cx="9" cy="7" fill="#fff" r="2.4" />
          <line x1="4" x2="20" y1="17" y2="17" />
          <circle cx="15" cy="17" fill="#fff" r="2.4" />
        </svg>
        {showBadge ? (
          <span
            className={`absolute -right-1 -top-1 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-white shadow-[0_0_0_2px_#fff] ${
              blocked ? "bg-red-600" : "bg-amber-500"
            }`}
          >
            {pendingCount > 99 ? "99+" : pendingCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[330px] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
          role="menu"
        >
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            維修工具
          </div>
          <ToolsMenuItem
            description={
              busy
                ? "正在從伺服器拉取最新菜單及所有設定…"
                : "從伺服器強制拉取最新菜單及所有設定，套用後重新載入頁面"
            }
            disabled={busy}
            onPick={() => pick(onManualUpdate)}
            title={busy ? "更新中…" : "手動更新"}
          />
          <ToolsMenuItem
            description="檢查有冇「已結帳但未上到雲」嘅訂單，失敗事件重試或補錄上雲"
            onPick={() => pick(onSyncHealth)}
            title="同步健康"
          />
          {showBadge ? (
            <div className="mx-3 mb-1.5 mt-1 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
              {blocked
                ? `有 ${syncHealth.blocked} 張訂單連續補推都對唔上雲端，建議即刻處理。`
                : `仲有 ${pendingCount} 張／條待上傳或未確認。`}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
