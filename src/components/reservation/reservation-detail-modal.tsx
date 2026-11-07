"use client";

/**
 * 訂位詳情彈窗 —— 狀態操作與入座開枱的唯一入口。
 *
 * ## 三步式入座
 *
 * `detail` → `table`（選枱）→ `plan`（按今日菜牌重算 + 差額確認）→ 寫入
 *
 * 為什麼要分三步而不是一個「入座」按鈕：
 *   · 選枱要避開已佔用的枱（讀本機 `orders`，唔另外打 API）
 *   · 重算要顯示哪幾道菜帶唔入（沽清 / 下架），唔可以靜默刪
 *   · 差額要店員看過才確認，否則找錢時對唔上
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  formatBizDate,
  formatMoney,
  formatSlotTime,
  RESERVATION_SOURCE_LABEL,
  RESERVATION_STATUS_META,
} from "@/lib/pos/reservation/labels";
import type { PosReservation, ReservationStatus } from "@/lib/pos/reservation/types";
import type { SeatPlan } from "@/lib/pos/reservation/items";
import { loadBootstrapCache, loadOrders } from "@/lib/storage";
import { resolveMenuSource } from "@/lib/pos/reservation/menu-source";
import { savePendingSeat } from "@/lib/pos/reservation/pending-seat";
import { toOrderItems } from "@/lib/pos/reservation/seat";
import { buildReservationConfirmJob, printReservationJobs } from "@/lib/pos/reservation/print";

type Step = "detail" | "table" | "plan";

export function ReservationDetailModal({
  storeId,
  reservation,
  onClose,
  onChanged,
  onEdit,
  onOpenSettings,
  notice,
}: {
  storeId: string;
  reservation: PosReservation;
  onClose: () => void;
  onChanged: (next: PosReservation) => void;
  onEdit: (row: PosReservation) => void;
  onOpenSettings: () => void;
  /** 商家自訂訂位須知（印喺確認單頁尾）。 */
  notice?: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("detail");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [selectedTable, setSelectedTable] = useState<{ id: string; name: string } | null>(null);
  const [plan, setPlan] = useState<SeatPlan | null>(null);

  const meta = RESERVATION_STATUS_META[reservation.status];

  /** 本機枱位佔用（同 pos-app 同一口徑：未結帳 / 已付款 / 返結都算佔用）。 */
  const occupied = useMemo(() => {
    const orders = loadOrders(storeId);
    const set = new Set<string>();
    for (const order of orders) {
      if (!order.tableId) continue;
      if (order.status === "settled" || order.status === "cancelled") continue;
      set.add(order.tableId);
    }
    return set;
  }, [storeId]);

  const tables = useMemo(() => {
    const bootstrap = loadBootstrapCache(storeId);
    const list = bootstrap?.tables ?? [];
    return list
      .filter((table) => (table.capacity ?? 0) >= reservation.partySize)
      .filter((table) => !occupied.has(table.id) || reservation.tableId === table.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [storeId, reservation.partySize, reservation.tableId, occupied]);

  const patch = useCallback(
    async (action: string, extra?: Record<string, unknown>) => {
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(`/api/pos/reservations/${encodeURIComponent(reservation.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeId, action, ...extra }),
        });
        const json = (await res.json()) as { ok?: boolean; reservation?: PosReservation; error?: string };
        if (!res.ok || !json.ok || !json.reservation) {
          setError(json.error ?? "操作失敗");
          return null;
        }
        onChanged(json.reservation);
        return json.reservation;
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作失敗");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [reservation.id, storeId, onChanged],
  );

  const loadPlan = useCallback(
    async (table: { id: string; name: string }) => {
      setSelectedTable(table);
      setBusy("plan");
      setError(null);
      try {
        const res = await fetch(
          `/api/pos/reservations/${encodeURIComponent(reservation.id)}/seat-plan?storeId=${encodeURIComponent(storeId)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as { ok?: boolean; plan?: SeatPlan; error?: string };
        if (!res.ok || !json.ok || !json.plan) {
          setError(json.error ?? "重算失敗");
          return;
        }
        setPlan(json.plan);
        setStep("plan");
      } catch (err) {
        setError(err instanceof Error ? err.message : "重算失敗");
      } finally {
        setBusy(null);
      }
    },
    [reservation.id, storeId],
  );

  /**
   * 入座開枱：① 標記 seated → ② 把預點菜轉成 OrderItem 寫入 pending
   * → ③ 跳去收銀台深鏈，由 pos-app 開枱 + 填車。
   *
   * 為什麼要跳轉而唔喺呢度直接建單：建單邏輯（單號、draft 狀態、打印）全部喺
   * `pos-app`，喺訂位頁複製一份一定會慢慢漂移。深鏈交接係唯一唔會分叉嘅做法。
   */
  const confirmSeat = useCallback(async () => {
    if (!selectedTable || !plan) return;
    const next = await patch("seat", { tableId: selectedTable.id, tableName: selectedTable.name });
    if (!next) return;

    // 訂位頁可能冇 bootstrap 快取 → 兜底拉一次，否則會全部當「找不到」
    const menu = await resolveMenuSource(storeId);
    const converted = toOrderItems(plan.lines, menu.menuItems);

    if (plan.lines.length > 0 && converted.items.length === 0) {
      setError("找不到菜單資料，已標記入座但未能帶入預點菜。請到點餐頁手動加菜。");
      return;
    }

    savePendingSeat(storeId, {
      reservationId: reservation.id,
      reservationCode: reservation.code,
      guestName: reservation.guestName,
      tableId: selectedTable.id,
      tableName: selectedTable.name,
      partySize: reservation.partySize,
      items: converted.items,
      createdAt: new Date().toISOString(),
    });

    onClose();
    router.push(
      `/pos?tableId=${encodeURIComponent(selectedTable.id)}&reservationId=${encodeURIComponent(reservation.id)}`,
    );
  }, [patch, plan, selectedTable, storeId, reservation, onClose, router]);

  const canCancel = reservation.status === "pending" || reservation.status === "confirmed" || reservation.status === "arrived";
  const canArrive = reservation.status === "confirmed";
  const canSeat = reservation.status === "confirmed" || reservation.status === "arrived";
  const canNoShow = reservation.status === "confirmed" || reservation.status === "arrived";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-3">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* 頭 */}
        <div className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[17px] font-bold text-slate-900">
                {reservation.guestName || "（未登記姓名）"} · {reservation.partySize} 位
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${meta.className}`}>{meta.label}</span>
              {reservation.paidAmount > 0 ? (
                <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10.5px] font-bold text-emerald-700">
                  已預付 {formatMoney(reservation.paidAmount)}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-slate-500">
              {reservation.code} · {formatBizDate(reservation.bizDate)} {formatSlotTime(reservation.slotAt)} ·{" "}
              {RESERVATION_SOURCE_LABEL[reservation.source]}
            </div>
          </div>
          <button className="text-lg leading-none text-slate-400" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        {/* 身 */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {error ? (
            <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
              {error}
            </div>
          ) : null}

          {step === "detail" ? (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <Info label="聯絡電話" value={reservation.guestPhone || "—"} />
                <Info label="用餐時長" value={`${reservation.partySize} 位`} />
                <div className="col-span-2">
                  <Info label="備註" value={reservation.guestNote || "—"} />
                </div>
                {reservation.tableName ? (
                  <div className="col-span-2">
                    <Info label="枱位" value={`${reservation.tableName}${reservation.orderNo ? ` · 訂單 ${reservation.orderNo}` : ""}`} />
                  </div>
                ) : null}
              </div>

              <div className="mt-4">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[12.5px] font-bold text-slate-800">
                    預點菜（{reservation.items.length} 道）
                  </span>
                  {reservation.status !== "seated" && reservation.status !== "canceled" ? (
                    <button
                      className="text-[11.5px] font-semibold text-indigo-600"
                      onClick={() => onEdit(reservation)}
                      type="button"
                    >
                      修改
                    </button>
                  ) : null}
                </div>

                {reservation.items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-400">
                    無預點菜
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[1fr_76px_44px_74px] gap-2 bg-slate-50 px-3 py-1.5 text-[10.5px] font-bold text-slate-500">
                      <span>菜品</span>
                      <span className="text-right">原價</span>
                      <span className="text-right">數量</span>
                      <span className="text-right">折後</span>
                    </div>
                    {reservation.items.map((item) => {
                      const net =
                        typeof item.memberPrice === "number"
                          ? item.memberPrice
                          : typeof item.discountRate === "number" && item.discountRate < 100
                            ? Math.round(((item.unitPrice * item.discountRate) / 100) * 100) / 100
                            : item.unitPrice;
                      return (
                        <div
                          key={`${item.menuItemId}-${item.specText}`}
                          className="grid grid-cols-[1fr_76px_44px_74px] gap-2 border-t border-slate-100 px-3 py-2 text-[12px]"
                        >
                          <span className="min-w-0">
                            <span className="font-semibold text-slate-800">{item.name}</span>
                            {item.specText ? (
                              <span className="block text-[10.5px] text-slate-400">{item.specText}</span>
                            ) : null}
                          </span>
                          <span className="text-right tabular-nums text-slate-400">{formatMoney(item.unitPrice)}</span>
                          <span className="text-right font-semibold tabular-nums">{item.qty}</span>
                          <span className="text-right font-semibold tabular-nums text-emerald-700">
                            {formatMoney(net)}
                          </span>
                        </div>
                      );
                    })}
                    <div className="flex justify-end gap-4 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[12px]">
                      <span className="text-slate-500">原價 {formatMoney(reservation.itemsSubtotal)}</span>
                      {reservation.discountAmount > 0 ? (
                        <span className="font-semibold text-emerald-700">
                          −{formatMoney(reservation.discountAmount)}
                        </span>
                      ) : null}
                      <span className="font-bold text-slate-900">{formatMoney(reservation.payableAmount)}</span>
                    </div>
                  </div>
                )}
              </div>

              {reservation.paidAmount > 0 ? (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5">
                  <div className="text-[12px] font-bold text-emerald-800">
                    已預付 {formatMoney(reservation.paidAmount)}
                    <span className="ml-1 font-normal text-emerald-600">（會員餘額）</span>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-emerald-700">
                    {reservation.paymentRef ? `交易號 ${reservation.paymentRef}` : "—"}
                    {reservation.paidAt ? ` · ${new Date(reservation.paidAt).toLocaleString("zh-HK")}` : ""}
                  </div>
                </div>
              ) : null}

              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-amber-800">
                入座開枱會按<b>當日菜牌</b>重算預點菜，差額在開枱前顯示。
                已入座之後不可由訂位側取消，要走訂單退款。
              </div>

              {confirmCancel ? (
                <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
                  <span className="flex-1 text-[12px] font-semibold text-rose-700">確定取消這張訂位？</span>
                  <button
                    className="rounded-lg bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-600"
                    onClick={() => setConfirmCancel(false)}
                    type="button"
                  >
                    返回
                  </button>
                  <button
                    className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11.5px] font-semibold text-white disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmCancel(false);
                      void patch("cancel", { reason: "店家取消" });
                    }}
                    type="button"
                  >
                    確定取消
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {step === "table" ? (
            <>
              <div className="mb-2 text-[12.5px] font-semibold text-slate-700">
                選擇枱位（只列可容納 {reservation.partySize} 位的空枱）
              </div>
              {tables.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 px-3 py-6 text-center text-[12px] text-slate-500">
                  沒有可用的空枱。請先處理現有訂單，或到「設置」新增枱位。
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {tables.map((table) => (
                    <button
                      key={table.id}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${
                        selectedTable?.id === table.id
                          ? "border-orange-400 bg-orange-50"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                      onClick={() => void loadPlan({ id: table.id, name: table.name })}
                      type="button"
                    >
                      <div className="text-[13.5px] font-bold text-slate-900">{table.name}</div>
                      <div className="text-[10.5px] text-slate-500">
                        {table.capacity ?? "—"} 人 · {table.area || "—"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {step === "plan" && plan && selectedTable ? (
            <>
              <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-slate-700">
                <span>入座 {selectedTable.name}</span>
                <span className="text-slate-400">·</span>
                <span>{reservation.partySize} 位</span>
              </div>

              {plan.unavailable.length > 0 ? (
                <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800">
                  <b>以下菜品帶唔入：</b>
                  {plan.unavailable.map((u) => `${u.name}（${u.reason === "soldout" ? "沽清" : "已下架"}）`).join("、")}
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="grid grid-cols-[1fr_70px_38px_80px] gap-2 bg-slate-50 px-3 py-1.5 text-[10.5px] font-bold text-slate-500">
                  <span>菜品（按今日菜牌）</span>
                  <span className="text-right">今日價</span>
                  <span className="text-right">數量</span>
                  <span className="text-right">折後</span>
                </div>
                {plan.lines.map((line) => (
                  <div
                    key={`${line.menuItemId}-${line.specText}`}
                    className="grid grid-cols-[1fr_70px_38px_80px] gap-2 border-t border-slate-100 px-3 py-2 text-[12px]"
                  >
                    <span className="min-w-0 font-semibold text-slate-800">{line.name}</span>
                    <span className="text-right tabular-nums text-slate-500">{formatMoney(line.unitPrice)}</span>
                    <span className="text-right font-semibold tabular-nums">{line.qty}</span>
                    <span className="text-right font-semibold tabular-nums text-emerald-700">
                      {formatMoney(line.netPrice * line.qty)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-[12px]">
                <Row label="今日重算（原價）" value={formatMoney(plan.subtotal)} />
                <Row label="今日應付（會員價）" value={formatMoney(plan.payable)} />
                <Row label="客人已預付" value={`−${formatMoney(reservation.paidAmount)}`} />
                <div className="mt-1.5 flex items-baseline justify-between border-t border-dashed border-emerald-300 pt-1.5">
                  <span className="font-bold text-emerald-800">
                    {plan.delta >= 0 ? "需向客人補收" : "需退回客人"}
                  </span>
                  <span className="text-[17px] font-bold tabular-nums text-emerald-800">
                    {formatMoney(Math.abs(plan.delta))}
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* 腳 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          {step === "detail" ? (
            <>
              <button
                className="min-h-[38px] rounded-xl border border-slate-200 bg-white px-3 text-[12.5px] font-semibold text-slate-600"
                onClick={() => {
                  const queued = printReservationJobs([
                    buildReservationConfirmJob(reservation, {
                      storeId,
                      storeName: loadBootstrapCache(storeId)?.storeName ?? "",
                      notice,
                    }),
                  ]);
                  if (queued === 0) setError("未能加入列印，請到打印中心檢查。");
                }}
                type="button"
              >
                列印確認單
              </button>
              {canCancel ? (
                <button
                  className="min-h-[38px] rounded-xl border border-rose-200 bg-white px-3 text-[12.5px] font-semibold text-rose-600"
                  onClick={() => setConfirmCancel(true)}
                  type="button"
                >
                  取消訂位
                </button>
              ) : null}
              {canNoShow ? (
                <button
                  className="min-h-[38px] rounded-xl border border-slate-200 bg-white px-3 text-[12.5px] font-semibold text-slate-600"
                  onClick={() => void patch("no_show")}
                  type="button"
                >
                  標記未到
                </button>
              ) : null}
              <div className="flex-1" />
              {reservation.status === "pending" ? (
                <button
                  className="min-h-[38px] rounded-xl bg-indigo-600 px-4 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void patch("confirm")}
                  type="button"
                >
                  確認訂位
                </button>
              ) : null}
              {canArrive ? (
                <button
                  className="min-h-[38px] rounded-xl border border-emerald-200 bg-white px-3 text-[12.5px] font-semibold text-emerald-700 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void patch("arrive")}
                  type="button"
                >
                  客人已到
                </button>
              ) : null}
              {canSeat ? (
                <button
                  className="min-h-[38px] rounded-xl bg-indigo-600 px-4 text-[13px] font-semibold text-white"
                  onClick={() => setStep("table")}
                  type="button"
                >
                  入座開枱 →
                </button>
              ) : null}
              {reservation.status === "seated" ? (
                <button
                  className="min-h-[38px] rounded-xl border border-slate-200 bg-white px-3 text-[12.5px] font-semibold text-slate-600"
                  onClick={() => router.push("/orders")}
                  type="button"
                >
                  去訂單頁
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button
                className="min-h-[38px] rounded-xl border border-slate-200 bg-white px-3 text-[12.5px] font-semibold text-slate-600"
                onClick={() => {
                  setStep("detail");
                  setPlan(null);
                  setSelectedTable(null);
                }}
                type="button"
              >
                ← 返回
              </button>
              <div className="flex-1" />
              {step === "plan" ? (
                <button
                  className="min-h-[38px] rounded-xl bg-emerald-600 px-4 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void confirmSeat()}
                  type="button"
                >
                  {busy === "seat" ? "處理中…" : "確認入座開枱"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[10.5px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-emerald-800">
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export type { ReservationStatus };
