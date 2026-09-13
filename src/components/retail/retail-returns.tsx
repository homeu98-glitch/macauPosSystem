"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadOrders } from "@/lib/storage";
import type { PosOrder } from "@/lib/types";
import {
  applyReturnToOrder,
  computeReturn,
  lookupReturnableOrders,
  planExchange,
  returnableLines,
  shouldRestock,
  type ReturnPick,
  type ReturnableLine,
} from "@/lib/retail/returns";
import { commitReturn } from "@/lib/retail/return-service";

const money = (v: number) => `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;

type Toast = { tone: "ok" | "err" | "info"; text: string };

/** 常用退貨原因（商家可自填；呢啲只係快捷 chips） */
const REASON_CHIPS = ["唔要", "尺寸唔啱", "壞咗", "包裝破損", "已過期"];

export function RetailReturns() {
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [query, setQuery] = useState("");
  /** 已揀中嘅原單 id */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 行級揀選：key → 數量（普通）/ 重量（稱重） */
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    setOrders(loadOrders());
  }, []);

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const hits = useMemo(
    () => (query.trim() ? lookupReturnableOrders(orders, query, { limit: 30 }) : []),
    [orders, query],
  );

  /** 最近已結零售單（未查詢時顯示，方便直接揀） */
  const recent = useMemo(
    () =>
      orders
        .filter((o) => o.tableId === "counter" && o.tableName === "零售")
        .filter((o) => o.status === "settled" || o.status === "partially_refunded")
        .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
        .slice(0, 12),
    [orders],
  );

  const active = useMemo(
    () => (activeId ? (orders.find((o) => o.id === activeId) ?? null) : null),
    [orders, activeId],
  );

  const lines = useMemo(() => (active ? returnableLines(active) : []), [active]);

  const pickList: ReturnPick[] = useMemo(() => {
    const out: ReturnPick[] = [];
    for (const line of lines) {
      const v = picks[line.key];
      if (v == null || !Number.isFinite(v) || v <= 1e-9) continue;
      if (line.weightKg != null && line.weightKg > 0) out.push({ key: line.key, kg: v });
      else out.push({ key: line.key, qty: v });
    }
    return out;
  }, [lines, picks]);

  const computation = useMemo(
    () => (active && pickList.length > 0 ? computeReturn(active, pickList) : null),
    [active, pickList],
  );

  const reset = useCallback(() => {
    setPicks({});
    setReason("");
  }, []);

  const selectOrder = useCallback(
    (id: string) => {
      setActiveId(id);
      reset();
    },
    [reset],
  );

  const confirm = useCallback(() => {
    if (!active || !computation) return;
    if (!computation.ok) {
      flash("err", computation.errors[0] ? describeError(computation.errors[0]) : "退貨資料有問題");
      return;
    }
    if (!reason.trim()) {
      // 硬閘：退款一定有原因（對帳 / 舞弊查核靠佢）
      flash("err", "請填退貨原因");
      return;
    }
    const applied = applyReturnToOrder({
      order: active,
      computation,
      reason: reason.trim(),
    });
    if (!applied.ok || !applied.order) {
      flash("err", applied.error ?? "落帳失敗");
      return;
    }

    const r = commitReturn({
      order: applied.order,
      computation,
      reason: reason.trim(),
    });
    if (!r.ok) {
      flash("err", r.error ?? "落帳失敗");
      return;
    }

    // 結果一定要講齊：退款幾多 / 有冇回補庫存 / 有冇出票
    const bits = [`已退款 ${money(computation.totalRefund)}`];
    if (r.stockChanges.length > 0) bits.push(`回補 ${r.stockChanges.length} 項庫存`);
    else if (r.restockSkipped) bits.push(`⚠️ ${r.restockSkipped}`);
    if (r.printJobCount > 0) bits.push(`退款單 ${r.printJobCount} 張`);
    else if (r.printWarning) bits.push(`⚠️ 未出票：${r.printWarning}`);
    const clean = r.stockChanges.length > 0 && r.printJobCount > 0 && !r.printWarning;
    flash(clean ? "ok" : "info", bits.join(" · "));

    setOrders(loadOrders());
    reset();
  }, [active, computation, reason, flash, reset]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="text-[15px] font-bold">退換貨</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            掃單號 / 序號 / 條碼 → 揀行 → 退款自動按原單實收計（唔會退多）
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            autoFocus
            className="w-[280px] rounded-xl border border-slate-300 px-3 py-2.5 text-[13px] outline-none focus:border-orange-400"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="單號（零售07）/ 序號 / 條碼"
            value={query}
          />
          {query ? (
            <button
              className="rounded-xl px-3 py-2.5 text-[12px] font-semibold text-slate-500 hover:bg-slate-100"
              onClick={() => setQuery("")}
              type="button"
            >
              清除
            </button>
          ) : null}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── 左：原單 + 可退行 ── */}
        <section className="min-h-0 overflow-y-auto p-4">
          {active ? (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold">{active.localOrderNo}</span>
                  <StatusPill status={active.status} />
                  <span className="text-[11.5px] text-slate-500">
                    {new Date(active.createdAt).toLocaleString("zh-MO")}
                  </span>
                  <span className="ml-auto text-[13px] font-bold">
                    原單 {money(active.total)}
                  </span>
                </div>
                {(active.refundedAmount ?? 0) > 0 ? (
                  <div className="mt-1 text-[11.5px] font-semibold text-rose-600">
                    已退累計 {money(active.refundedAmount ?? 0)}
                  </div>
                ) : null}
                <button
                  className="mt-2 rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-500 hover:bg-slate-100"
                  onClick={() => setActiveId(null)}
                  type="button"
                >
                  ← 換另一張單
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {lines.map((line) => (
                  <ReturnLineRow
                    key={line.key}
                    line={line}
                    value={picks[line.key]}
                    onChange={(v) =>
                      setPicks((prev) => {
                        const next = { ...prev };
                        if (v == null || v <= 0) delete next[line.key];
                        else next[line.key] = v;
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              {hits.length > 0 ? (
                <>
                  <h2 className="text-[13px] font-bold text-slate-700">
                    搵到 {hits.length} 張單
                  </h2>
                  <div className="mt-2 grid gap-2">
                    {hits.map((h) => (
                      <OrderCard
                        key={h.order.id}
                        hint={
                          h.kind === "serial"
                            ? "序號命中"
                            : h.kind === "barcode"
                              ? "條碼命中"
                              : "單號命中"
                        }
                        onPick={() => selectOrder(h.order.id)}
                        order={h.order}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {query.trim() ? (
                    <p className="mt-8 text-center text-[12.5px] text-slate-500">
                      搵唔到合資格嘅零售單（未結帳 / 已取消 / 已完成退款嘅單唔可以再退）
                    </p>
                  ) : (
                    <>
                      <h2 className="text-[13px] font-bold text-slate-700">最近零售單</h2>
                      {recent.length === 0 ? (
                        <p className="mt-6 text-center text-[12.5px] text-slate-400">
                          冇可退嘅零售單
                        </p>
                      ) : (
                        <div className="mt-2 grid gap-2">
                          {recent.map((o) => (
                            <OrderCard
                              key={o.id}
                              onPick={() => selectOrder(o.id)}
                              order={o}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>

        {/* ── 右：退款摘要 ── */}
        <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white p-4">
          <div className="text-[11px] font-semibold text-slate-500">應退</div>
          <div className="mt-1 text-[32px] font-extrabold tracking-tight text-rose-600">
            {money(computation?.totalRefund ?? 0)}
          </div>

          {computation?.ok ? (
            <div className="mt-3 space-y-1.5 text-[12.5px]">
              <SumRow label="商品退款" value={money(computation.goodsRefund)} />
              {computation.orderDiscountRefund > 0 ? (
                <SumRow
                  label="扣回整單折扣"
                  value={`−${money(computation.orderDiscountRefund)}`}
                  tone="warn"
                />
              ) : null}
              <div className="border-t border-dashed border-slate-200 pt-1.5">
                <SumRow label="退款合計" value={money(computation.totalRefund)} strong />
              </div>
              <div className="pt-1">
                <div className="text-[11px] font-semibold text-slate-500">退款方式</div>
                {computation.refundByMethod.map((r) => (
                  <SumRow key={r.methodId} label={r.label} value={money(r.amount)} />
                ))}
              </div>
              {!shouldRestock(reason) ? (
                <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-800">
                  ⚠️ 原因含「{reason}」→ 貨品唔會回補庫存
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-slate-400">
              {active ? "揀返要退嘅行 / 填數量" : "先揀一張原單"}
            </p>
          )}

          <div className="mt-4">
            <div className="text-[11px] font-semibold text-slate-500">退貨原因（必填）</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {REASON_CHIPS.map((r) => (
                <button
                  key={r}
                  className={`min-h-[34px] rounded-full px-3 py-1.5 text-[11.5px] font-semibold ${
                    reason === r ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                  onClick={() => setReason(reason === r ? "" : r)}
                  type="button"
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-[13px] outline-none focus:border-orange-400"
              onChange={(e) => setReason(e.target.value)}
              placeholder="或者自己輸入"
              value={reason}
            />
          </div>

          <div className="mt-auto pt-4">
            <button
              className="min-h-[52px] w-full rounded-2xl bg-rose-600 py-4 text-[16px] font-bold text-white hover:bg-rose-700 disabled:bg-slate-300"
              disabled={!computation?.ok || !reason.trim()}
              onClick={confirm}
              type="button"
            >
              確認退款 {computation?.ok ? money(computation.totalRefund) : ""}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              退款金額一律按原單實收計（打過折 / 改過價嘅單唔會退多）；<br />
              庫存會按實際退貨量回補（稱重商品按 kg）。
            </p>
          </div>
        </aside>
      </div>

      {toast ? <ToastBar toast={toast} /> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 細件 UI
// ─────────────────────────────────────────────────────────────

function describeError(e: { reason: string; asked?: number; remaining?: number }): string {
  if (e.reason === "exceeds") return `退得太多（最多 ${e.remaining}，你填 ${e.asked}）`;
  if (e.reason === "not-found") return "搵唔到呢一行";
  return "數量無效";
}

function StatusPill({ status }: { status: PosOrder["status"] }) {
  const map: Record<string, { text: string; cls: string }> = {
    settled: { text: "已結帳", cls: "bg-emerald-50 text-emerald-700" },
    partially_refunded: { text: "部分退款", cls: "bg-amber-50 text-amber-700" },
    refunded: { text: "已退款", cls: "bg-rose-50 text-rose-700" },
  };
  const m = map[status] ?? { text: status, cls: "bg-slate-100 text-slate-600" };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${m.cls}`}>
      {m.text}
    </span>
  );
}

function OrderCard({
  order,
  onPick,
  hint,
}: {
  order: PosOrder;
  onPick: () => void;
  hint?: string;
}) {
  const count = (order.items ?? []).reduce((s, it) => s + (it.weightKg ? 1 : Math.max(0, it.quantity)), 0);
  return (
    <button
      className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left hover:border-orange-300 hover:bg-orange-50/40"
      onClick={onPick}
      type="button"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-bold">{order.localOrderNo}</span>
          <StatusPill status={order.status} />
          {hint ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-600">
              {hint}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11.5px] text-slate-500">
          {order.items?.length ?? 0} 項 · {count} 件 ·{" "}
          {new Date(order.createdAt).toLocaleString("zh-MO", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {(order.refundedAmount ?? 0) > 0 ? ` · 已退 ${money(order.refundedAmount ?? 0)}` : ""}
        </div>
      </div>
      <span className="text-[14px] font-bold">{money(order.total)}</span>
    </button>
  );
}

function ReturnLineRow({
  line,
  value,
  onChange,
}: {
  line: ReturnableLine;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const isWeighed = line.weightKg != null && line.weightKg > 0;
  const max = isWeighed ? line.remainingKg : line.remainingQty;
  const disabled = max <= 1e-9;
  const selected = value != null && value > 1e-9;

  return (
    <div
      className={`rounded-2xl border p-3 ${
        disabled
          ? "border-slate-100 bg-slate-50 opacity-60"
          : selected
            ? "border-rose-300 bg-rose-50/40"
            : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{line.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
              {isWeighed ? `${line.weightKg} kg` : `${line.soldQty} 件`}
            </span>
            <span className="text-slate-500">行實收 {money(line.lineNet)}</span>
            {line.returnedQty > 0 || line.returnedKg > 0 ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                已退 {isWeighed ? `${line.returnedKg} kg` : `${line.returnedQty} 件`}
              </span>
            ) : null}
            {disabled ? (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 font-semibold text-slate-600">
                已全退
              </span>
            ) : null}
          </div>
        </div>

        {!disabled ? (
          isWeighed ? (
            <div className="flex items-center gap-1.5">
              <input
                className="w-[92px] rounded-lg border border-slate-300 px-2 py-2 text-[13px] tabular-nums"
                inputMode="decimal"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  onChange(v === "" ? undefined : Number(v));
                }}
                placeholder={`≤ ${max}`}
                value={value ?? ""}
              />
              <button
                className="min-h-[38px] rounded-lg bg-slate-100 px-2.5 text-[11.5px] font-semibold text-slate-700 hover:bg-slate-200"
                onClick={() => onChange(max)}
                type="button"
              >
                全退
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <StepBtn
                disabled={(value ?? 0) <= 0}
                onClick={() => onChange(Math.max(0, (value ?? 0) - 1))}
              >
                −
              </StepBtn>
              <span className="min-w-[30px] text-center text-[13px] font-bold tabular-nums">
                {value ?? 0}
              </span>
              <StepBtn
                disabled={(value ?? 0) >= max}
                onClick={() => onChange(Math.min(max, (value ?? 0) + 1))}
              >
                +
              </StepBtn>
              <button
                className="ml-1 min-h-[38px] rounded-lg bg-slate-100 px-2.5 text-[11.5px] font-semibold text-slate-700 hover:bg-slate-200"
                onClick={() => onChange(max)}
                type="button"
              >
                全退
              </button>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

function StepBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="grid h-10 w-10 place-items-center rounded-lg border border-slate-300 text-[16px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function SumRow({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={strong ? "font-bold text-slate-900" : "text-slate-600"}>{label}</span>
      <span
        className={`font-semibold tabular-nums ${
          tone === "warn" ? "text-orange-700" : strong ? "text-[15px] font-extrabold text-rose-600" : "text-slate-800"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ToastBar({ toast }: { toast: Toast }) {
  const tones = {
    ok: "bg-emerald-600",
    err: "bg-rose-600",
    info: "bg-slate-800",
  } as const;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 md:bottom-8">
      <div className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${tones[toast.tone]}`}>
        {toast.text}
      </div>
    </div>
  );
}

/** 換貨差額提示（供收銀台接入；目前頁面只做退貨，換貨走「退貨 + 新單」） */
export function exchangeDifferenceHint(refund: number, charge: number): string {
  return planExchange(refund, charge).summary;
}
