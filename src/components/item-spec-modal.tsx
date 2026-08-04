"use client";

import { useMemo, useState } from "react";

import { MenuSpecGroup } from "@/lib/types";

type ItemSpecModalProps = {
  open: boolean;
  title: string;
  specGroups: MenuSpecGroup[];
  selectedSpecs?: Record<string, string[]>;
  onClose: () => void;
  onConfirm: (specs: Record<string, string[]>) => void;
};

export function ItemSpecModal({
  open,
  title,
  specGroups,
  selectedSpecs,
  onClose,
  onConfirm,
}: ItemSpecModalProps) {
  const [draft, setDraft] = useState<Record<string, string[]>>(selectedSpecs ?? {});

  const totalDelta = useMemo(() => {
    return specGroups.reduce((sum, group) => {
      const selectedIds = draft[group.id] ?? [];
      return (
        sum +
        group.options
          .filter((option) => selectedIds.includes(option.id))
          .reduce((groupSum, option) => groupSum + option.priceDelta, 0)
      );
    }, 0);
  }, [draft, specGroups]);

  const ready = specGroups.every((group) => !group.required || (draft[group.id]?.length ?? 0) > 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-900/45 p-4">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-sm text-slate-500">請先把每組規格都選好</div>
          </div>
          <button
            className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700"
            onClick={onClose}
            type="button"
          >
            關閉
          </button>
        </div>

        <div className="mt-4 grid gap-4">
          {specGroups.map((group) => (
            <section key={group.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">{group.name}</div>
              <div className="mt-1 text-xs text-slate-500">
                {group.selectionMode === "multi" ? "多選" : "單選"} · {group.required ? "必選" : "非必選"}
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {group.options.map((option) => (
                  <button
                    key={option.id}
                    className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold ${
                      (draft[group.id] ?? []).includes(option.id)
                        ? "border-orange-300 bg-orange-50 text-orange-700"
                        : "border-slate-200 bg-white text-slate-900"
                    }`}
                    onClick={() => {
                      setDraft((current) => {
                        const currentIds = current[group.id] ?? [];
                        if (group.selectionMode === "single") {
                          return {
                            ...current,
                            [group.id]: [option.id],
                          };
                        }

                        const exists = currentIds.includes(option.id);
                        return {
                          ...current,
                          [group.id]: exists
                            ? currentIds.filter((id) => id !== option.id)
                            : [...currentIds, option.id],
                        };
                      });
                    }}
                    type="button"
                  >
                    <div>{option.label}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {option.priceDelta > 0 ? `+MOP ${option.priceDelta}` : "不加價"}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
          <div>
            <div className="text-xs font-semibold text-slate-500">規格加價</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">
              {totalDelta > 0 ? `+MOP ${totalDelta}` : "MOP 0"}
            </div>
          </div>
          <button
            className="rounded-2xl bg-orange-500 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!ready}
            onClick={() => onConfirm(draft)}
            type="button"
          >
            確定
          </button>
        </div>
      </div>
    </div>
  );
}
