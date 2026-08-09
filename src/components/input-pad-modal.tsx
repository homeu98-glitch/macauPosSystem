"use client";

import { ResponsiveModal } from "@/components/responsive-modal";

type InputPadModalProps = {
  open: boolean;
  title: string;
  mode: "number" | "text";
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

const TEXT_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const NUMBER_ROWS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0", "00", "."],
];

export function InputPadModal({
  open,
  title,
  mode,
  value,
  onChange,
  onClose,
  onConfirm,
}: InputPadModalProps) {
  if (!open) return null;

  const rows = mode === "number" ? NUMBER_ROWS : TEXT_ROWS;

  function append(token: string) {
    onChange(`${value}${token}`);
  }

  return (
    <ResponsiveModal
      actions={
        <>
          {mode === "text" ? (
            <button
              className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
              onClick={() => append(" ")}
              type="button"
            >
              空格
            </button>
          ) : (
            <button
              className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
              onClick={() => onChange("0")}
              type="button"
            >
              歸零
            </button>
          )}
          <button
            className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            onClick={() => onChange(value.slice(0, -1))}
            type="button"
          >
            刪除
          </button>
          <button
            className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600"
            onClick={onConfirm}
            type="button"
          >
            確定
          </button>
        </>
      }
      allowPointerEventsOnOverlay={false}
      bodyClassName="grid gap-3"
      description={mode === "number" ? "請輸入數字" : "請輸入文字"}
      onClose={onClose}
      panelClassName="border border-slate-200"
      placement="bottom"
      title={title}
      widthClassName="max-w-xl"
      zIndexClassName="z-[90]"
    >
      <div className="shrink-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-lg font-semibold text-slate-900 sm:text-xl">
          {value || " "}
      </div>
      {rows.map((row, index) => (
            <div
              key={`${mode}-${index}`}
              className={`grid gap-2 ${mode === "number" ? "grid-cols-3" : "grid-cols-5 sm:grid-cols-10"}`}
            >
              {row.map((key) => (
                <button
                  key={key}
                  className="rounded-2xl bg-white px-3 py-3 text-base font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  onClick={() => append(key)}
                  type="button"
                >
                  {key}
                </button>
              ))}
              {mode === "text" && row.length < 10
                ? Array.from({ length: 10 - row.length }).map((_, fillerIndex) => (
                    <div key={`filler-${index}-${fillerIndex}`} />
                  ))
                : null}
            </div>
          ))}
    </ResponsiveModal>
  );
}
