"use client";

/**
 * 新增／改期訂位表單。
 *
 * ## 為什麼「編輯」只有改期與改人數
 *
 * 改預點菜要重算金額、可能要退／補預付款，屬於另一個流程。
 * 所以這裡的編輯只做 `reschedule`（時間 + 人數），預點菜在詳情頁唯讀顯示。
 * 要改菜就取消重建 —— 寧可多一步，也不要做出一個「改了菜但錢沒對上」的介面。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ReservationMenuPicker } from "@/components/reservation/reservation-menu-picker";
import { formatMoney, formatSlotTime } from "@/lib/pos/reservation/labels";
import { computeReservationTotals } from "@/lib/pos/reservation/items";
import { shiftYmdDays } from "@/lib/pos/reservation/slots";
import { useReservationSlots } from "@/lib/pos/reservation/use-reservations";
import type { PosReservation, ReservationItem, ReservationSettings } from "@/lib/pos/reservation/types";
import { peekMenuSource, resolveMenuSource, type MenuSource } from "@/lib/pos/reservation/menu-source";

export function ReservationFormModal({
  storeId,
  settings,
  todayBiz,
  editing,
  onClose,
  onCreated,
}: {
  storeId: string;
  settings: ReservationSettings | null;
  todayBiz: string;
  editing: PosReservation | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const tomorrowBiz = useMemo(() => shiftYmdDays(todayBiz, 1), [todayBiz]);

  const [date, setDate] = useState(editing?.bizDate ?? todayBiz);
  const [slotAt, setSlotAt] = useState<string | null>(editing?.slotAt ?? null);
  const [partySize, setPartySize] = useState(editing?.partySize ?? 2);
  const [guestName, setGuestName] = useState(editing?.guestName ?? "");
  const [guestPhone, setGuestPhone] = useState(editing?.guestPhone ?? "");
  const [guestNote, setGuestNote] = useState(editing?.guestNote ?? "");
  const [items, setItems] = useState<ReservationItem[]>(editing?.items ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slotsState = useReservationSlots(storeId || null, date);
  const totals = useMemo(() => computeReservationTotals(items), [items]);

  // 菜單：先用本機快取（即時），冇就背景拉一次
  const [menu, setMenu] = useState<MenuSource>(
    () => peekMenuSource(storeId) ?? { menuItems: [], categories: [], memberDiscountRate: null },
  );
  useEffect(() => {
    let alive = true;
    void resolveMenuSource(storeId).then((next) => {
      if (alive) setMenu(next);
    });
    return () => {
      alive = false;
    };
  }, [storeId]);

  const discountRate = menu.memberDiscountRate;

  const maxParty = settings?.maxPartySize ?? 20;
  const minParty = settings?.minPartySize ?? 1;

  const submit = useCallback(async () => {
    if (!slotAt) {
      setError("請選擇時間。");
      return;
    }
    if (!guestName.trim()) {
      setError("請填寫姓名。");
      return;
    }
    setBusy(true);
    setError(null);

    try {
      if (editing) {
        const res = await fetch(`/api/pos/reservations/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeId, action: "reschedule", slotAt, partySize }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error ?? "改期失敗");
          return;
        }
        onCreated();
        return;
      }

      const res = await fetch("/api/pos/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          slotAt,
          partySize,
          guestName: guestName.trim(),
          guestPhone: guestPhone.trim(),
          guestNote: guestNote.trim(),
          source: "pos",
          items: items.map((item) => ({
            menuItemId: item.menuItemId,
            qty: item.qty,
            specs: item.specs,
            specText: item.specText,
          })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; rejected?: unknown[] };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "建立失敗");
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失敗");
    } finally {
      setBusy(false);
    }
  }, [slotAt, guestName, guestPhone, guestNote, items, storeId, partySize, editing, onCreated]);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-3">
        <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-5 py-3.5">
            <div className="flex-1">
              <div className="text-[16px] font-bold text-slate-900">{editing ? "改期 / 改人數" : "新增訂位"}</div>
              <div className="mt-0.5 text-[11.5px] text-slate-500">
                {editing ? "預點菜不會在改期時變動；要改菜請取消重建。" : "電話訂位、現場訂位都在這裡建立"}
              </div>
            </div>
            <button className="text-lg text-slate-400" onClick={onClose} type="button">
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {error ? (
              <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
                {error}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>日期</Label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: todayBiz, label: "今天" },
                    { key: tomorrowBiz, label: "明天" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      className={`min-h-[36px] rounded-full border px-3 text-[12.5px] font-semibold ${
                        date === item.key
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600"
                      }`}
                      onClick={() => {
                        setDate(item.key);
                        setSlotAt(null);
                      }}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                  <input
                    className="h-9 rounded-full border border-slate-200 px-3 text-[12.5px] font-semibold text-slate-700 outline-none focus:border-indigo-400"
                    max={shiftYmdDays(todayBiz, settings?.leadDaysMax ?? 14)}
                    min={todayBiz}
                    onChange={(e) => {
                      if (e.target.value) {
                        setDate(e.target.value);
                        setSlotAt(null);
                      }
                    }}
                    type="date"
                    value={date}
                  />
                </div>

                <Label className="mt-3">人數</Label>
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2">
                  <button
                    className="h-10 w-10 rounded-lg border border-slate-200 text-lg font-semibold text-slate-600 disabled:opacity-40"
                    disabled={partySize <= minParty}
                    onClick={() => setPartySize((v) => Math.max(minParty, v - 1))}
                    type="button"
                  >
                    −
                  </button>
                  <div className="flex-1 text-center text-[22px] font-bold text-slate-900">
                    {partySize}
                    <span className="ml-1 text-[12px] font-semibold text-slate-400">位</span>
                  </div>
                  <button
                    className="h-10 w-10 rounded-lg border border-slate-200 text-lg font-semibold text-slate-600 disabled:opacity-40"
                    disabled={partySize >= maxParty}
                    onClick={() => setPartySize((v) => Math.min(maxParty, v + 1))}
                    type="button"
                  >
                    ＋
                  </button>
                </div>
              </div>

              <div>
                <Label>時間（灰色 = 已滿 / 已過）</Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {slotsState.slots.map((slot) => {
                    const disabled = slot.full || slot.past;
                    return (
                      <button
                        key={slot.slotAt}
                        className={`h-10 rounded-lg border text-[12px] font-bold tabular-nums ${
                          slotAt === slot.slotAt
                            ? "border-indigo-600 bg-indigo-600 text-white"
                            : disabled
                              ? "border-slate-100 bg-slate-50 text-slate-300 line-through"
                              : "border-slate-200 bg-white text-slate-700"
                        }`}
                        disabled={disabled}
                        onClick={() => setSlotAt(slot.slotAt)}
                        type="button"
                      >
                        {slot.label}
                      </button>
                    );
                  })}
                </div>
                {slotsState.slots.length === 0 ? (
                  <div className="mt-2 text-[11.5px] text-slate-400">這一日沒有可訂時段。</div>
                ) : null}
              </div>

              <div>
                <Label>姓名</Label>
                <input
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-indigo-400"
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="陳大文"
                  value={guestName}
                />
              </div>

              <div>
                <Label>電話</Label>
                <input
                  className="h-10 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-indigo-400"
                  inputMode="tel"
                  onChange={(e) => setGuestPhone(e.target.value)}
                  placeholder="6212 3456"
                  value={guestPhone}
                />
              </div>

              <div className="sm:col-span-2">
                <Label>備註 / 忌口</Label>
                <textarea
                  className="h-16 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400"
                  onChange={(e) => setGuestNote(e.target.value)}
                  placeholder="靠窗、有小朋友、需要兒童椅…"
                  value={guestNote}
                />
              </div>
            </div>

            {/* 預點菜 */}
            <div className="mt-4">
              <Label>預點菜（選填）</Label>
              {editing ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] text-slate-500">
                  已預點 {editing.items.length} 道 · {formatMoney(editing.payableAmount)}
                  <span className="ml-1 text-slate-400">（改期不會改動）</span>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50/60 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold text-orange-800">
                      {items.length > 0 ? `${items.length} 道 · ${formatMoney(totals.payable)}` : "未選菜"}
                    </div>
                    <div className="text-[10.5px] text-orange-700">
                      {items.length > 0
                        ? `原價 ${formatMoney(totals.subtotal)}${totals.discount > 0 ? ` · 會員折 ${formatMoney(totals.discount)}` : ""}`
                        : "可以先選好菜，到店一鍵帶入"}
                    </div>
                  </div>
                  <button
                    className="min-h-[36px] shrink-0 rounded-xl bg-orange-500 px-3 text-[12.5px] font-semibold text-white"
                    onClick={() => setPickerOpen(true)}
                    type="button"
                  >
                    {items.length > 0 ? "修改選菜" : "＋ 選菜"}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
            <button
              className="min-h-[40px] rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-semibold text-slate-600"
              onClick={onClose}
              type="button"
            >
              取消
            </button>
            <div className="flex-1" />
            <button
              className="min-h-[40px] rounded-xl bg-indigo-600 px-5 text-[13.5px] font-semibold text-white disabled:opacity-50"
              disabled={busy || !slotAt}
              onClick={() => void submit()}
              type="button"
            >
              {busy ? "處理中…" : editing ? "儲存改期" : "建立訂位"}
            </button>
          </div>
        </div>
      </div>

      {pickerOpen ? (
        <ReservationMenuPicker
          categories={menu.categories}
          discountRate={discountRate}
          initial={items}
          menuItems={menu.menuItems}
          onClose={() => setPickerOpen(false)}
          onConfirm={(next) => {
            setItems(next);
            setPickerOpen(false);
          }}
          subtitle={`${date} ${slotAt ? formatSlotTime(slotAt) : ""} · ${partySize} 位`}
          title="為這張訂位選預點菜"
        />
      ) : null}
    </>
  );
}

function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mb-1.5 text-[11.5px] font-bold text-slate-500 ${className}`}>{children}</div>;
}
