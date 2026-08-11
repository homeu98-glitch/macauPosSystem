"use client";

type NumericKeypadProps = {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  confirmLabel?: string;
  onConfirm?: () => void;
  showConfirm?: boolean;
};

const DIGIT_ROWS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0"],
] as const;

export function NumericKeypad({
  value,
  onChange,
  maxLength = 8,
  confirmLabel = "確定",
  onConfirm,
  showConfirm = false,
}: NumericKeypadProps) {
  function append(token: string) {
    const next = `${value}${token}`.slice(0, maxLength);
    onChange(next);
  }

  return (
    <div className="grid gap-2">
      {DIGIT_ROWS.slice(0, 3).map((row, index) => (
        <div key={`row-${index}`} className="grid grid-cols-3 gap-2">
          {row.map((digit) => (
            <button
              key={digit}
              className="rounded-2xl bg-slate-50 px-3 py-4 text-lg font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-100"
              onClick={() => append(digit)}
              type="button"
            >
              {digit}
            </button>
          ))}
        </div>
      ))}

      <div className="grid grid-cols-3 gap-2">
        <button
          className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
          onClick={() => onChange("")}
          type="button"
        >
          清空
        </button>
        <button
          className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
          onClick={() => onChange(value.slice(0, -1))}
          type="button"
        >
          刪除
        </button>
        <button
          className="rounded-2xl bg-slate-50 px-3 py-4 text-lg font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-100"
          onClick={() => append("0")}
          type="button"
        >
          0
        </button>
      </div>

      {showConfirm ? (
        <button
          className="rounded-2xl bg-orange-500 px-3 py-4 text-sm font-semibold text-white hover:bg-orange-600"
          onClick={() => onConfirm?.()}
          type="button"
        >
          {confirmLabel}
        </button>
      ) : null}
    </div>
  );
}
