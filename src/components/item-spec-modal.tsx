"use client";

import { useMemo, useState } from "react";

import { ResponsiveModal } from "@/components/responsive-modal";
import { MenuSpecGroup } from "@/lib/types";

type ItemSpecModalProps = {
  open: boolean;
  title: string;
  specGroups: MenuSpecGroup[];
  selectedSpecs?: Record<string, string[]>;
  isOptionDisabled?: (optionId: string) => boolean;
  onClose: () => void;
  onConfirm: (specs: Record<string, string[]>) => void;
};

export function ItemSpecModal({
  open,
  title,
  specGroups,
  selectedSpecs,
  isOptionDisabled,
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
    <ResponsiveModal
      actions={
        <>
          <div className="mr-auto text-left">
            <div className="text-xs font-semibold text-slate-500">規格加價</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{totalDelta > 0 ? `+MOP ${totalDelta}` : "MOP 0"}</div>
          </div>
          <button
            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-2xl bg-orange-500 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!ready}
            onClick={() => onConfirm(draft)}
            type="button"
          >
            確定
          </button>
        </>
      }
      bodyClassName="grid gap-4"
      description="請先把每組規格都選好"
      onClose={onClose}
      title={title}
      widthClassName="max-w-2xl"
      zIndexClassName="z-[70]"
    >
      {specGroups.map((group) => (
        <section key={group.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">{group.name}</div>
          <div className="mt-1 text-xs text-slate-500">
            {group.selectionMode === "multi" ? "多選" : "單選"} · {group.required ? "必選" : "非必選"}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {group.options.map((option) => {
              const disabled = isOptionDisabled ? isOptionDisabled(option.id) : false;
              const selected = (draft[group.id] ?? []).includes(option.id);
              return (
                <button
                  key={option.id}
                  className={`rounded-2xl border px-4 py-3 text-left text-sm font-semibold ${
                    disabled
                      ? "border-slate-200 bg-slate-100 text-slate-400"
                      : selected
                        ? "border-orange-300 bg-orange-50 text-orange-700"
                        : "border-slate-200 bg-white text-slate-900"
                  } ${disabled ? "cursor-not-allowed opacity-75" : ""}`}
                  onClick={() => {
                    if (disabled) return;
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
                        [group.id]: exists ? currentIds.filter((id) => id !== option.id) : [...currentIds, option.id],
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
              );
            })}
          </div>
        </section>
      ))}
    </ResponsiveModal>
  );
}
