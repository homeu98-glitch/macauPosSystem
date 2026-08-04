"use client";

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
    <div className="pointer-events-none fixed inset-0 z-[90] flex items-end justify-end p-4">
      <div className="pointer-events-auto w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-sm text-slate-500">
              {mode === "number" ? "請輸入數字" : "請輸入文字"}
            </div>
          </div>
          <button
            className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
            onClick={onClose}
            type="button"
          >
            關閉
          </button>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xl font-semibold text-slate-900">
          {value || " "}
        </div>

        <div className="mt-4 grid gap-3">
          {rows.map((row, index) => (
            <div
              key={`${mode}-${index}`}
              className={`grid gap-2 ${mode === "number" ? "grid-cols-3" : "grid-cols-10"}`}
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
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          {mode === "text" ? (
            <button
              className="col-span-2 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
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
            className={`${mode === "text" ? "col-span-1" : "col-span-1"} rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50`}
            onClick={() => onChange(value.slice(0, -1))}
            type="button"
          >
            刪除
          </button>
          <button
            className={`${mode === "text" ? "col-span-1" : "col-span-2"} rounded-2xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600`}
            onClick={onConfirm}
            type="button"
          >
            確定
          </button>
        </div>
      </div>
    </div>
  );
}
