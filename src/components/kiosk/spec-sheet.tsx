"use client";

import { useEffect, useRef } from "react";

import type { MenuSpecGroup, MenuSpecOption, OrderItem } from "@/lib/types";
import type { SpecDraft } from "@/lib/use-kiosk-order";
import { money2 } from "@/components/kiosk/order-summary-card";

/**
 * 規格 bottom sheet —— **兩頁共用**（審查 P2-6）。
 *
 * 舊版 `/menu` 同 `/order` 各有一份 ~55 行逐字重複嘅規格選擇邏輯。抽成共用之後：
 *   - 規格合併 / 必選校驗只有一處實作；
 *   - 無障礙（P3-2）只需補一次：`role="dialog"` / `aria-modal` / Esc 關閉 / 初始 focus。
 *
 * @param variant `mobile`（手機 /menu，圓角 chip）| `kiosk`（平板 /order，邊框 chip）
 */
export function SpecSheet({
  draft,
  onClose,
  onChangeSpecs,
  onConfirm,
  t,
  variant = "mobile",
}: {
  draft: SpecDraft;
  onClose: () => void;
  /** 由 SpecSheet 計好下一個 specs 組合，呼叫端只需寫返落 specDraft。 */
  onChangeSpecs: (specs: NonNullable<OrderItem["selectedSpecs"]>, priceDelta: number) => void;
  onConfirm: () => void;
  t: (key: string) => string;
  variant?: "mobile" | "kiosk";
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 無障礙（P3-2 修復）：舊版 bottom sheet 冇 role / 冇 Esc / 冇焦點管理，
  // 鍵盤同屏幕閱讀器用家無法得知彈咗個 dialog，亦關唔到。
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const requiredMissing = (draft.item.specGroups ?? [])
    .filter((g) => g.required)
    .some((g) => !draft.specs.find((s) => s.groupId === g.id));

  const chipClass = (selected: boolean) =>
    variant === "mobile"
      ? `rounded-full px-3.5 py-1.5 text-sm ${selected ? "bg-orange-500 text-white" : "bg-stone-100 text-stone-600"}`
      : `rounded-lg border px-3 py-1 text-sm ${
          selected ? "border-orange-500 bg-orange-50 text-orange-600" : "border-slate-200 text-slate-600"
        }`;

  function toggle(group: MenuSpecGroup, opt: MenuSpecOption) {
    const others = draft.specs.filter((s) => s.groupId !== group.id);
    const selected = draft.specs.find((s) => s.groupId === group.id && s.optionId === opt.id);
    const nextSpecs: NonNullable<OrderItem["selectedSpecs"]> =
      group.selectionMode === "single"
        ? [
            ...others,
            {
              groupId: group.id,
              groupName: group.name,
              optionId: opt.id,
              optionLabel: opt.label,
              priceDelta: opt.priceDelta,
            },
          ]
        : selected
          ? others
          : [
              ...others,
              {
                groupId: group.id,
                groupName: group.name,
                optionId: opt.id,
                optionLabel: opt.label,
                priceDelta: opt.priceDelta,
              },
            ];
    onChangeSpecs(nextSpecs, nextSpecs.reduce((s, x) => s + x.priceDelta, 0));
  }

  return (
    <div
      className={`fixed inset-0 flex items-end justify-center bg-black/40 ${variant === "mobile" ? "z-30" : "z-20"}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={draft.item.name}
        className={`max-h-[85dvh] w-full max-w-md overflow-y-auto bg-white p-4 pb-6 outline-none ${
          variant === "mobile" ? "rounded-t-3xl" : "rounded-t-2xl"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {variant === "mobile" ? <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-stone-200" /> : null}
        <h2
          className={`mb-3 ${variant === "mobile" ? "text-lg font-bold text-stone-900" : "text-base font-semibold text-slate-900"}`}
        >
          {draft.item.name}
        </h2>
        {(draft.item.specGroups ?? []).map((group) => (
          <div key={group.id} className={variant === "mobile" ? "mb-4" : "mb-3"}>
            <div
              className={`mb-1.5 text-sm ${variant === "mobile" ? "font-semibold text-stone-700" : "font-medium text-slate-700"}`}
            >
              {group.name}
              {group.required && <span className="ml-1 text-xs text-red-400">*</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {group.options.map((opt) => {
                const selected = draft.specs.find((s) => s.groupId === group.id && s.optionId === opt.id);
                return (
                  <button
                    key={opt.id}
                    aria-pressed={Boolean(selected)}
                    onClick={() => toggle(group, opt)}
                    className={chipClass(Boolean(selected))}
                  >
                    {opt.label}
                    {opt.priceDelta ? ` +${opt.priceDelta}` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <button
          disabled={requiredMissing}
          onClick={onConfirm}
          className={`mt-2 w-full bg-orange-500 py-3.5 text-base font-semibold text-white disabled:opacity-50 active:scale-[0.99] ${
            variant === "mobile" ? "rounded-2xl" : "rounded-xl py-3"
          }`}
        >
          {variant === "mobile" ? `${t("addToCart")} · MOP ${money2(draft.item.price + draft.priceDelta)}` : t("add")}
        </button>
        <button onClick={onClose} className="mt-2 w-full py-2 text-xs text-stone-400">
          {t("closeSheet")}
        </button>
      </div>
    </div>
  );
}
