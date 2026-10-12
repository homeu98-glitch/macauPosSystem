"use client";

import { CSSProperties, ReactNode, Ref, useRef } from "react";

import { useT } from "@/components/lang-provider";

type ResponsiveModalProps = {
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  header?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  widthClassName?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  panelRef?: Ref<HTMLDivElement>;
  bodyClassName?: string;
  zIndexClassName?: string;
  overlayClassName?: string;
  showCloseButton?: boolean;
  placement?: "center" | "bottom";
  allowPointerEventsOnOverlay?: boolean;
};

export function ResponsiveModal({
  children,
  title,
  description,
  header,
  actions,
  onClose,
  closeLabel = "關閉",
  widthClassName = "max-w-2xl",
  panelClassName = "",
  panelStyle,
  panelRef,
  bodyClassName = "",
  zIndexClassName = "z-50",
  overlayClassName = "",
  showCloseButton = true,
  placement = "center",
  allowPointerEventsOnOverlay = true,
}: ResponsiveModalProps) {
  const t = useT();
  /**
   * 🔴 2026-10-12 商家實紙（iPad 交班流程）：「撳遮罩關閉」要分辨**真正嘅遮罩撳**
   * 同「面板內撳落、手指滑到遮罩先鬆手」。
   *
   * 瀏覽器規矩：若 pointerdown 同 pointerup 嘅元素唔同，click 會派發去兩者
   * **最近公共祖先**。action bar 貼面板底緣（屏幕底緣）時，細按鈕＋手指精度有限，
   * 好易「壓到按鈕底緣、鬆手時跌咗出面板」→ click 落到遮罩 → 彈窗無故關閉，
   * 成個流程重頭嚟（實片實證：撳按鈕正中＝成功入下一步；壓底緣＝彈窗消失）。
   *
   * 對策：pointerdown 記住「壓力起點係咪遮罩本身」；click 只有喺起點同終點都係
   * 遮罩時先叫 onClose。面板內嘅撳（包括边缘滾動）一律唔會意外關閉彈窗。
   */
  const backdropPressStartedOnBackdrop = useRef(false);
  return (
    <div
      className={`fixed inset-0 ${zIndexClassName} ${placement === "bottom" ? "flex items-end justify-center" : "grid place-items-center"} bg-slate-900/45 p-2 sm:p-4 ${allowPointerEventsOnOverlay ? "" : "pointer-events-none"} ${overlayClassName}`}
      onPointerDown={(event) => {
        backdropPressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdropPressStartedOnBackdrop.current && event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div
        ref={panelRef}
        style={panelStyle}
        className={`flex w-full ${widthClassName} max-h-[calc(100dvh-16px)] flex-col overflow-hidden rounded-3xl bg-white shadow-2xl sm:max-h-[calc(100dvh-32px)] ${allowPointerEventsOnOverlay ? "" : "pointer-events-auto"} ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        {header ? (
          <div className="shrink-0 border-b border-slate-100 px-4 py-4 sm:px-5">{header}</div>
        ) : title || description || showCloseButton ? (
          <div className="shrink-0 border-b border-slate-100 px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {title ? <div className="text-lg font-semibold text-slate-900">{title}</div> : null}
                {description ? <div className="mt-1 text-sm text-slate-500">{description}</div> : null}
              </div>
              {showCloseButton && onClose ? (
                <button
                  className="shrink-0 rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
                  onClick={onClose}
                  type="button"
                >
                  {t(closeLabel)}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 ${bodyClassName}`}>{children}</div>

        {actions ? (
          <div className="sticky bottom-0 z-[1] shrink-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-5">
            <div className="flex flex-wrap justify-end gap-2">{actions}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
