"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { OrderSourceBadge } from "@/components/order-source-badge";
import { remainingQtyOf } from "@/lib/kds/kds-board";
import { useKdsBoard } from "@/lib/kds/use-kds-board";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import { loadAuthSession, type AuthSession } from "@/lib/storage";

/**
 * 出餐台屏 `/expo`（docs/116 §7.2）。
 *
 * ## 職責
 *
 * 核對「一張單**齊唔齊**」，齊咗就**確認出餐**。
 * 所以中欄一定係**整單、唔分工位** —— 同後廚屏（只睇自己分區）係相反嘅視角。
 *
 * ## 三條硬規則
 *
 * 1. **唔齊唔可以出餐**：`ready` 端點有前置檢查（409 + 欠幾多），
 *    屏上亦要事先 disable 個掣。冇呢層就會出現「客人返嚟話少咗一碟，
 *    但系統顯示已出餐」——查都查唔到。
 * 2. **唔可以順手幫訂單結帳**：屏上只寫 `fulfillment_status` / `served_at`，
 *    唔碰 `status`。結帳涉及會員扣款 / Ledger RPC，係收銀台嘅事（§7.3）。
 * 3. **要有「召回」**：客人話漏咗一碟時，`recall` 會清走該單全部單品完成狀態、
 *    打返後廚屏（`fulfillment_status` 回 `preparing`）。
 */

type ReadyState = { orderId: string; shortfall: { name: string; quantity: number; doneQty: number }[] } | null;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function ExpoScreen() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shortfall, setShortfall] = useState<ReadyState>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    setAuthSession(loadAuthSession());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const storeId = authSession?.merchantId ?? null;

  const api = useKdsBoard({
    storeId,
    station: null,
    enabled: Boolean(storeId),
    // 出餐台要睇**整單**（唔分工位核對），亦要見到「已齊但未確認」嘅單
    allStations: true,
    includeCompleted: true,
  });

  const serverNow = nowTick + api.clockOffsetMs;
  const zoneName = useMemo(() => {
    const map = new Map(api.stations.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? id;
  }, [api.stations]);

  /** 未確認出餐（包括「已齊」同「仲欠」）。 */
  const waiting = useMemo(
    () => api.orders.filter((o) => o.fulfillmentStatus !== "ready"),
    [api.orders],
  );
  /** 已經確認出餐 —— 仲要留住，畀「召回」用。 */
  const served = useMemo(
    () => api.orders.filter((o) => o.fulfillmentStatus === "ready"),
    [api.orders],
  );

  const queue = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return waiting;
    return waiting.filter(
      (o) => o.localOrderNo.toLowerCase().includes(q) || o.tableName.toLowerCase().includes(q),
    );
  }, [waiting, query]);

  // 揀單：預設揀隊列第一張；被出餐 / 被撤走就自動跳去下一張
  useEffect(() => {
    if (selectedId && queue.some((o) => o.id === selectedId)) return;
    setSelectedId(queue[0]?.id ?? null);
    setShortfall(null);
  }, [queue, selectedId]);

  const selected = useMemo(
    () => queue.find((o) => o.id === selectedId) ?? null,
    [queue, selectedId],
  );
  const selectedRemaining = selected ? remainingQtyOf(selected.items) : 0;

  const callOrders = useCallback(
    async (orderId: string, action: "ready" | "recall") => {
      if (!storeId) return;
      setBusy(true);
      setActionError(null);
      setShortfall(null);
      try {
        const res = await fetch("/api/pos/kds/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await posDeviceAuthHeadersFresh()) },
          body: JSON.stringify({ storeId, orderId, action }),
        });
        const payload = (await res.json().catch(() => null)) as
          | {
              ok?: boolean;
              error?: string;
              code?: string;
              shortfall?: { itemKey: string; name: string; quantity: number; doneQty: number }[];
            }
          | null;

        if (!res.ok || !payload?.ok) {
          // 409 = 未齊。呢個係**預期內**嘅業務拒絕，唔係系統錯誤 → 顯示欠邊幾項
          if (res.status === 409 && payload?.code === "not_all_done") {
            setShortfall({
              orderId,
              shortfall: (payload.shortfall ?? []).map((s) => ({
                name: s.name,
                quantity: s.quantity,
                doneQty: s.doneQty,
              })),
            });
          } else {
            setActionError(payload?.error ?? `操作失敗（${res.status}）`);
          }
          return;
        }
        // 成功 → 即刻拉一次（唔等 realtime），令個掣立即有反應
        api.refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "操作失敗");
      } finally {
        setBusy(false);
      }
    },
    [storeId, api],
  );

  if (!hydrated) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-slate-50 text-sm text-slate-400">
        正在載入出餐台屏…
      </div>
    );
  }

  if (!storeId) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-slate-50 px-6 text-center">
        <div>
          <div className="text-lg font-semibold text-slate-900">未登入</div>
          <div className="mt-2 text-sm text-slate-500">出餐台屏係一部機嘅角色，要先用商戶帳號登入一次。</div>
          <Link
            className="mt-5 inline-block rounded-2xl bg-slate-900 px-6 py-3 text-sm font-bold text-white"
            href="/login?mode=expo"
          >
            去登入（出餐台屏）
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-slate-50">
      {/* 頂欄 */}
      <div className="grid h-[66px] flex-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3.5 border-b border-slate-200 bg-white px-4">
        <div className="truncate text-base font-semibold tracking-tight text-slate-900">
          {authSession?.name || "本店"}
          <em className="ml-2 text-[13px] font-medium not-italic text-slate-400">出餐台</em>
        </div>
        <input
          className="h-10 w-[300px] rounded-full border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:ring-2 focus:ring-orange-500/40"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜尋取餐號 / 枱號"
          value={query}
        />
        <div className="flex items-center justify-end gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold ${
              api.connected ? "bg-slate-100 text-slate-500" : "bg-rose-100 text-rose-700"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${api.connected ? "bg-emerald-500" : "bg-rose-500"}`} />
            {api.connected ? "已連線" : "連線中"}
          </span>
          <button
            className="whitespace-nowrap rounded-full bg-emerald-50 px-4 py-2 text-[13px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
            onClick={() => setShowDone((v) => !v)}
            type="button"
          >
            已出餐 <b className="font-mono text-[15px]">{served.length}</b>
          </button>
          <Link
            className="whitespace-nowrap rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-900 ring-1 ring-slate-200"
            href="/kitchen"
          >
            ← 後廚屏
          </Link>
        </div>
      </div>

      {/* 警示帶 */}
      {api.degraded === "kds_state_table_missing" ? (
        <div className="flex h-11 flex-none items-center bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ 後廚狀態表未建立（migration 0033 未跑）· 後廚進度一律當 0，唔可以確認出餐
        </div>
      ) : null}
      {actionError ? (
        <div className="flex h-11 flex-none items-center gap-3 bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ {actionError}
        </div>
      ) : null}
      {api.realtimeHealthy === false ? (
        <div className="flex h-11 flex-none items-center bg-amber-500 px-5 text-sm font-bold text-white">
          ⚠ {api.realtimeHint}（後廚進度可能唔會自動更新）
        </div>
      ) : null}
      {api.loadError ? (
        <div className="flex h-11 flex-none items-center gap-3 bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ {api.loadError}
          <button className="rounded-lg bg-white/20 px-3 py-1 text-xs" onClick={api.refresh} type="button">
            重試
          </button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_336px] gap-3.5 p-3.5">
        {/* 左：隊列（最早落單排前） */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-none items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-semibold text-slate-500">
              {showDone ? "已出餐" : "待出餐"}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs font-bold text-slate-600">
              {showDone ? served.length : waiting.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {(showDone ? served : queue).length === 0 ? (
              <div className="px-3 py-10 text-center text-xs leading-relaxed text-slate-400">
                {showDone ? "今日暫時未有已出餐嘅單" : "暫時冇待出餐嘅單"}
              </div>
            ) : (
              (showDone ? served : queue).map((order) => {
                const remaining = remainingQtyOf(order.items);
                const elapsed = formatElapsed(
                  serverNow - Date.parse(order.sentToKitchenAt ?? order.createdAt),
                );
                const active = order.id === selectedId;
                return (
                  <button
                    className={`mb-2 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                    key={order.id}
                    onClick={() => {
                      setSelectedId(order.id);
                      setShortfall(null);
                    }}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-[17px] font-semibold leading-tight">
                        {order.localOrderNo}
                      </span>
                      <span
                        className={`mt-0.5 block font-mono text-[12px] ${
                          active ? "text-white/60" : "text-slate-400"
                        }`}
                      >
                        {elapsed}
                      </span>
                    </span>
                    {order.fulfillmentStatus === "ready" ? (
                      <span className="rounded-md bg-emerald-100 px-2 py-1 text-[11px] font-bold text-emerald-700">
                        已出
                      </span>
                    ) : (
                      <span
                        className={`rounded-md px-2 py-1 font-mono text-[12px] font-bold ${
                          remaining > 0
                            ? active
                              ? "bg-rose-500 text-white"
                              : "bg-rose-100 text-rose-700"
                            : active
                              ? "bg-emerald-500 text-white"
                              : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {remaining > 0 ? `欠${remaining}` : "齊"}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 中：整單核對（唔分工位） */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {selected ? (
            <>
              <div className="flex flex-none items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                <div className="min-w-0">
                  <div className="font-mono text-[32px] font-semibold leading-none tracking-tight text-slate-900">
                    {selected.localOrderNo}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {(selected.tableId === "counter" ? "自取" : `${selected.tableName || "堂食"}`)} · 共{" "}
                    {selected.items.reduce((s, i) => s + i.quantity, 0)} 件
                  </div>
                </div>
                <div className="grid flex-none justify-items-end gap-2">
                  <OrderSourceBadge order={{ source: selected.source }} />
                  <span className="rounded-[10px] bg-slate-100 px-3 py-1.5 font-mono text-[19px] font-bold text-slate-500">
                    {formatElapsed(serverNow - Date.parse(selected.sentToKitchenAt ?? selected.createdAt))}
                  </span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
                {selected.items.map((item) => {
                  const done = item.doneQty >= item.quantity;
                  return (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-100 py-3 last:border-b-0"
                      key={item.itemKey}
                    >
                      <div className="min-w-0">
                        <div
                          className={`text-[20px] font-semibold leading-snug tracking-tight ${
                            done ? "text-slate-400" : "text-slate-900"
                          }`}
                        >
                          {item.name}
                          <span className="ml-1.5 font-mono text-[15px] font-medium text-slate-500">
                            ×{item.quantity}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-[7px] bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                            {zoneName(item.station)}
                          </span>
                          {item.specs.map((spec) => (
                            <span
                              className="rounded-[7px] bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                              key={spec}
                            >
                              {spec}
                            </span>
                          ))}
                          {item.note ? (
                            <span className="rounded-[7px] bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                              {item.note}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span
                        className={`whitespace-nowrap rounded-[10px] px-3 py-2 text-[13px] font-bold ${
                          done ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                        }`}
                      >
                        {done ? "✓ 完成" : `仲欠 ${item.quantity - item.doneQty}`}
                      </span>
                    </div>
                  );
                })}
                {selected.items.length === 0 ? (
                  <div className="py-10 text-center text-sm text-slate-400">呢張單冇出品</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center px-6 text-center text-sm leading-loose text-slate-400">
              {showDone ? "揀左邊嘅「已出餐」單可以召回" : "暫時冇待出餐嘅單"}
              <br />
              <span className="text-xs text-slate-300">後廚屏一完成出品，呢度會即時見到</span>
            </div>
          )}
        </div>

        {/* 右：大字號 + 大掣 */}
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto">
          <div className="rounded-2xl border border-slate-200 bg-white px-5 py-5 text-center">
            {selected ? (
              <>
                <div className="text-[11px] font-semibold tracking-widest text-slate-400">取餐號 / 枱號</div>
                <div className="mt-2 font-mono text-[52px] font-bold leading-none tracking-tight text-slate-900">
                  {selected.localOrderNo}
                </div>
                <div className="mt-3 text-[13px] font-semibold text-slate-500">
                  {selectedRemaining > 0 ? (
                    <span className="text-rose-600">仲欠 {selectedRemaining} 件</span>
                  ) : (
                    <span className="text-emerald-600">全部出品已齊</span>
                  )}
                </div>
              </>
            ) : (
              <div className="py-6 text-sm text-slate-400">未揀單</div>
            )}
          </div>

          {shortfall && shortfall.orderId === selected?.id ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] leading-relaxed text-rose-700">
              <div className="font-bold">未齊，唔可以出餐</div>
              <ul className="mt-1.5 grid gap-1">
                {shortfall.shortfall.map((s) => (
                  <li key={s.name}>
                    · {s.name} 仲欠 {Math.max(0, s.quantity - s.doneQty)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <button
            className="h-[120px] rounded-[22px] bg-emerald-600 text-[24px] font-bold text-white shadow-sm transition active:scale-[.99] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            disabled={!selected || selectedRemaining > 0 || busy || selected.fulfillmentStatus === "ready"}
            onClick={() => selected && void callOrders(selected.id, "ready")}
            type="button"
          >
            {busy
              ? "處理中…"
              : selected?.fulfillmentStatus === "ready"
                ? "已出餐"
                : selectedRemaining > 0
                  ? `仲欠 ${selectedRemaining} 件`
                  : "確認出餐"}
          </button>

          <button
            className="rounded-[16px] bg-white px-4 py-4 text-sm font-bold text-slate-600 ring-1 ring-slate-200 transition active:scale-[.99] disabled:opacity-40"
            disabled={!selected || busy || selected.fulfillmentStatus !== "ready"}
            onClick={() => selected && void callOrders(selected.id, "recall")}
            type="button"
          >
            ↺ 召回（打返後廚）
          </button>

          <div className="rounded-2xl bg-slate-100 px-4 py-3 text-[11.5px] leading-relaxed text-slate-500">
            出餐台屏只會寫「出餐狀態」，**唔會幫訂單結帳** —— 結帳（連會員扣款）係收銀台嘅事。
          </div>
        </div>
      </div>
    </div>
  );
}
