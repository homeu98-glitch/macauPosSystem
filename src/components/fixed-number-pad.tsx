"use client";

type FixedNumberPadProps = {
  title: string;
  subtitle?: string;
  value: string;
  onChange: (value: string) => void;
  onConfirm?: () => void;
  confirmLabel?: string;
};

const KEYS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0", "00", "."],
];

export function FixedNumberPad({
  title,
  subtitle,
  value,
  onChange,
  onConfirm,
  confirmLabel = "確定",
}: FixedNumberPadProps) {
  function append(token: string) {
    onChange(`${value}${token}`);
  }

  return (
    <aside className="flex h-full flex-col border-l border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-4">
        <div className="text-base font-semibold text-slate-900">{title}</div>
        {subtitle ? <div className="mt-1 text-xs text-slate-500">{subtitle}</div> : null}
      </div>

      <div className="px-4 py-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-2xl font-semibold text-slate-900">
          {value || " "}
        </div>
      </div>

      <div className="flex-1 px-4 pb-4">
        <div className="grid gap-2">
          {KEYS.map((row, index) => (
            <div key={`row-${index}`} className="grid grid-cols-3 gap-2">
              {row.map((key) => (
                <button
                  key={key}
                  className="rounded-2xl bg-slate-50 px-3 py-4 text-lg font-semibold text-slate-900 ring-1 ring-slate-200 hover:bg-slate-100"
                  onClick={() => append(key)}
                  type="button"
                >
                  {key}
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
              清除
            </button>
            <button
              className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
              onClick={() => onChange(value.slice(0, -1))}
              type="button"
            >
              刪除
            </button>
            <button
              className="rounded-2xl bg-orange-500 px-3 py-4 text-sm font-semibold text-white hover:bg-orange-600"
              onClick={() => onConfirm?.()}
              type="button"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

