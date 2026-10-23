"use client";

import { useEffect, useRef, useState } from "react";

import { useT } from "@/components/lang-provider";
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
  /**
   * 彈出層闊度（px）。預設 330。
   *
   * 快餐模式（2026-10-17）：掣擺喺左欄（最窄 208px），彈出層唔想闊過成條左欄
   * → 傳 240。
   */
  popupWidth?: number;
  /**
   * 彈出層水平展開方向。預設 `"right"`。
   *
   * - `"right"`（右邊界對齊掣）→ **向左**展開。適合靠右嘅掣（桌台總覽標題列）。
   * - `"left"`（左邊界對齊掣）→ **向右**展開。適合靠左嘅掣（快餐模式左欄）。
   *
   * ── 點解要有呢個 prop（2026-10-23 J 回報）────────────────────────────
   * 快餐模式嘅維修工具 icon 擺喺**左欄**（最窄 208px）頁首最右，
   * 用 `right` 對齊會向左展開 → 撞出左欄嘅 `overflow-hidden`：
   * 一邊被裁走（見到「動更新」「步健康」呢種斷字），一邊蓋住左邊側欄。
   *
   * ⚠️ 向右展開**必須**用 `position: fixed`：左欄 `overflow-hidden` 會裁走
   * 任何 `absolute` 溢出。座標由 `getBoundingClientRect()` 即時量度，
   * 並夾喺 viewport 內（窄機唔會爆出右邊）。
   */
  align?: "left" | "right";
};

/**
 * 量度彈出層喺 `fixed` 座標系嘅位置（`align="left"` 用）。
 *
 * 放喺模組層：元件內定義會令 `useEffect` 依賴每次都變。
 * 夾 viewport：`left` 唔可以細過 12px、亦唔可以令右邊爆出畫面。
 */
function measurePopupAnchor(button: HTMLButtonElement | null, width: number) {
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  const margin = 12;
  const maxLeft = window.innerWidth - width - margin;
  const left = Math.min(Math.max(rect.left, margin), Math.max(margin, maxLeft));
  return { top: rect.bottom + 6, left };
}

export function PosToolsMenu({
  busy,
  onManualUpdate,
  onSyncHealth,
  popupWidth = 330,
  align = "right",
}: PosToolsMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
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

  /**
   * 開／閂選單。`align="left"` 要喺**開嘅一刻**量座標（`fixed` 唔會自動跟掣走位）。
   * 唔放喺 effect 入面計：避免「effect 直接 setState」嘅 lint 警告。
   */
  function toggle() {
    const next = !open;
    if (next && align === "left") setAnchor(measurePopupAnchor(buttonRef.current, popupWidth));
    setOpen(next);
  }

  /** 視窗尺寸／捲動變咗就重新量（只喺 `align="left"` 需要）。 */
  useEffect(() => {
    if (!open || align !== "left") return;
    function update() {
      setAnchor(measurePopupAnchor(buttonRef.current, popupWidth));
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align, popupWidth]);

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("維修工具：手動更新 / 同步健康")}
        className="relative flex h-[42px] w-[42px] items-center justify-center rounded-2xl bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
        onClick={toggle}
        ref={buttonRef}
        title={t("維修工具：手動更新 / 同步健康")}
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
          className={
            align === "left"
              ? // 向右展開：`fixed` 才逃得出左欄嘅 `overflow-hidden`（`absolute` 會被裁走）
                "fixed z-40 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
              : "absolute right-0 top-[calc(100%+6px)] z-30 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
          }
          role="menu"
          style={
            align === "left"
              ? {
                  width: popupWidth,
                  top: anchor?.top ?? 0,
                  left: anchor?.left ?? 0,
                  // 未量到座標之前唔顯示，避免喺畫面左上角閃一下
                  visibility: anchor ? "visible" : "hidden",
                }
              : { width: popupWidth }
          }
        >
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {t("維修工具")}
          </div>
          <ToolsMenuItem
            description={
              busy
                ? t("正在從伺服器拉取最新菜單及所有設定…")
                : t("從伺服器強制拉取最新菜單及所有設定，套用後重新載入頁面")
            }
            disabled={busy}
            onPick={() => pick(onManualUpdate)}
            title={busy ? t("更新中…") : t("手動更新")}
          />
          <ToolsMenuItem
            description={t("檢查有冇「已結帳但未上到雲」嘅訂單，失敗事件重試或補錄上雲")}
            onPick={() => pick(onSyncHealth)}
            title={t("同步健康")}
          />
          {showBadge ? (
            <div className="mx-3 mb-1.5 mt-1 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
              {blocked
                ? t("有 {n} 張訂單連續補推都對唔上雲端，建議即刻處理。", { n: syncHealth.blocked })
                : t("仲有 {n} 張／條待上傳或未確認。", { n: pendingCount })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
