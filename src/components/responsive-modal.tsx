"use client";

import { ReactNode } from "react";

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
  bodyClassName?: string;
  zIndexClassName?: string;
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
  bodyClassName = "",
  zIndexClassName = "z-50",
  showCloseButton = true,
  placement = "center",
  allowPointerEventsOnOverlay = true,
}: ResponsiveModalProps) {
  return (
    <div
      className={`fixed inset-0 ${zIndexClassName} ${placement === "bottom" ? "flex items-end justify-center" : "grid place-items-center"} bg-slate-900/45 p-2 sm:p-4 ${allowPointerEventsOnOverlay ? "" : "pointer-events-none"}`}
    >
      <div
        className={`flex w-full ${widthClassName} max-h-[calc(100dvh-16px)] flex-col overflow-hidden rounded-3xl bg-white shadow-2xl sm:max-h-[calc(100dvh-32px)] ${allowPointerEventsOnOverlay ? "" : "pointer-events-auto"} ${panelClassName}`}
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
                  {closeLabel}
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
