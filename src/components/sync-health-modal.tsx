"use client";

/**
 * 同步健康檢查 Modal（L1 失敗事件 + L2 終態對賬補錄）。
 *
 * 由 pos-app「同步健康」掣 / 琥珀卡「詳細」開出。資料全部直接由
 * store-scope localStorage + /api/pos/state 讀，唔依賴 pos-app 任何 state；
 * 任何會郁到 queue 嘅動作之後會 call onMutated()，等 pos-app 刷新佢自己個琥珀計數。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { PosOrder, QueueEvent } from "@/lib/types";
import { loadOrders, loadQueue, loadQuarantinedOrders, QuarantinedOrderRow } from "@/lib/storage";
import { discardFailedSyncEvent, retryFailedSyncEvents, resolveStoreId } from "@/lib/pos/sync-flush";
import {
  computeMissingLocalOrders,
  computeOrphanLocalOrders,
  computeReconcileDrift,
  computeServerRangeStart,
  discardQuarantinedOrder,
  downloadMissingOrdersToLocal,
  fetchServerOrders,
  findLocalOrderById,
  loadFailedEvents,
  MissingLocalRow,
  OrphanLocalRow,
  pushOrderSnapshotForReconcile,
  quarantineOrders,
  restoreQuarantinedOrder,
  ReconcileDriftRow,
  retryAllFailedEvents,
} from "@/lib/pos/sync-reconcile";

const STATUS_LABEL: Record<string, string> = {
  draft: "點單中",
  sent_to_kitchen: "已下單未結帳",
  paid: "已付款",
  reopened: "已返結",
  settled: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
  partially_refunded: "部分退款",
};

function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return STATUS_LABEL[status] ?? status;
}

function StatusChip({ status, tone }: { status: string | null; tone: "ok" | "warn" | "muted" }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold";
  const cls =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "warn"
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-600";
  const dot =
    tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-slate-400";
  return (
    <span className={`${base} ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {statusLabel(status)}
    </span>
  );
}

export function SyncHealthModal({
  open,
  onClose,
  onMutated,
}: {
  open: boolean;
  onClose: () => void;
  onMutated: () => void;
}) {
  const storeId = useMemo(() => (open ? resolveStoreId() : undefined), [open]);

  const [failedEvents, setFailedEvents] = useState<QueueEvent[]>([]);
  const [driftRows, setDriftRows] = useState<ReconcileDriftRow[]>([]);
  const [missingRows, setMissingRows] = useState<MissingLocalRow[]>([]);
  const [orphanRows, setOrphanRows] = useState<OrphanLocalRow[]>([]);
  const [quarantinedRows, setQuarantinedRows] = useState<QuarantinedOrderRow[]>([]);
  const [missingServerOrders, setMissingServerOrders] = useState<PosOrder[]>([]);
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [scanError, setScanError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const scanningRef = useRef(false);

  async function refreshDrift() {
    if (!storeId || scanningRef.current) return;
    scanningRef.current = true;
    setScanState("scanning");
    setScanError("");
    try {
      const localOrders = loadOrders(storeId);
      const startIso = computeServerRangeStart(localOrders);
      const { orders, error } = await fetchServerOrders(storeId, startIso);
      if (error) {
        setScanError(error);
        setScanState("error");
        setDriftRows([]);
        setMissingRows([]);
        setMissingServerOrders([]);
        return;
      }
      setDriftRows(computeReconcileDrift(localOrders, orders));
      const missing = computeMissingLocalOrders(localOrders, orders);
      setMissingRows(missing);
      // 留低 server 原始 row 一份，下載用（MissingLocalRow 只帶摘要，唔夠寫返 localStorage）
      setMissingServerOrders(
        missing
          .map((m) => orders.find((o) => o.id === m.orderId))
          .filter((o): o is PosOrder => !!o),
      );
      // ── L3：孤兒單掃描（2026-09-09 方案 A）──
      // 孤兒 = 本機非終態 + 雲端**全量**冇 + outbox 冇 pending/failed ORDER_* 事件支持。
      // 必須用全量 fetch（唔帶 range）：孤兒單唔喺 computeServerRangeStart 嘅終態窗口入面。
      const full = await fetchServerOrders(storeId, null);
      if (full.error) {
        setOrphanRows([]);
      } else {
        setOrphanRows(computeOrphanLocalOrders(localOrders, full.orders, loadQueue()));
      }
      setQuarantinedRows(loadQuarantinedOrders());
      setScanState("done");
    } finally {
      scanningRef.current = false;
    }
  }

  // 每次打開都重新掃（離開期間可能有新結帳 / 新同步）。
  useEffect(() => {
    if (!open) return;
    setFailedEvents(loadFailedEvents());
    setQuarantinedRows(loadQuarantinedOrders());
    setStatusMsg("");
    setBusyIds(new Set());
    void refreshDrift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storeId]);

  if (!open) return null;

  function bumpQueue() {
    setFailedEvents(loadFailedEvents());
    onMutated();
  }

  function handleRetryEvent(id: string) {
    retryFailedSyncEvents([id]);
    setStatusMsg("已將 1 筆失敗事件重新排入同步隊列…");
    bumpQueue();
  }

  function handleRetryAll() {
    const n = retryAllFailedEvents();
    setStatusMsg(n > 0 ? `已將 ${n} 筆失敗事件重新排入同步隊列…` : "冇可重試嘅失敗事件");
    bumpQueue();
  }

  function handleDiscard(id: string) {
    if (!window.confirm("確定放棄呢筆同步？資料將只保留喺本機、唔會上雲。")) return;
    discardFailedSyncEvent(id);
    bumpQueue();
  }

  async function handleRepush(orderId: string) {
    const order = findLocalOrderById(orderId, storeId);
    if (!order) {
      setStatusMsg("搵唔到本機訂單快照（可能已被刪除）。");
      return;
    }
    setBusyIds((prev) => new Set(prev).add(orderId));
    const result = pushOrderSnapshotForReconcile(order);
    setStatusMsg(result.message);
    // 等 400ms 讓 flush 起步，再重新對賬（雲端通常要多幾秒先反映，淨係幫手郁走已消失嘅行）
    window.setTimeout(() => {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
      void refreshDrift();
    }, 400);
    bumpQueue();
  }

  async function handleRepushAll() {
    const targets = driftRows.filter((row) => !busyIds.has(row.orderId));
    if (targets.length === 0) {
      setStatusMsg("冇需要補錄嘅訂單。");
      return;
    }
    const ok: string[] = [];
    for (const row of targets) {
      const order = findLocalOrderById(row.orderId, storeId);
      if (!order) continue;
      const result = pushOrderSnapshotForReconcile(order);
      if (result.ok) ok.push(row.localOrderNo);
    }
    setStatusMsg(ok.length > 0 ? `已排入 ${ok.length} 張單補錄（${ok.slice(0, 3).join("、")}…）` : "全部補錄失敗");
    window.setTimeout(() => void refreshDrift(), 500);
    bumpQueue();
  }

  // 2026-09-09：L2 反向——雲端有、本機缺嘅終態單（常見於多機協作：另一部機結咗帳
  // 但本機從未見過呢個 id，本機 orders 永遠冇，桌台總覽都唔 render）。一撳下載就
  // 將雲端 row append 入本機 localStorage，並觸發 pos-orders-changed → UI 自動見到。
  function handleDownloadAll() {
    if (!storeId) return;
    if (missingServerOrders.length === 0) {
      setStatusMsg("冇需要下載嘅訂單。");
      return;
    }
    const n = downloadMissingOrdersToLocal(missingServerOrders, storeId);
    setStatusMsg(n > 0 ? `已下載 ${n} 張訂單到本機` : "下載失敗");
    void refreshDrift();
    onMutated(); // 觸發 pos-app 重新讀 orders
  }

  // ── L3 / L4：孤兒單隔離區（2026-09-09 方案 A）──
  function handleQuarantine(orderId: string) {
    const n = quarantineOrders([orderId], "manual-health-check");
    setStatusMsg(n > 0 ? "已隔離 1 張孤兒單（下方可還原／永久刪除）。" : "隔離失敗（訂單可能已唔喺本機）。");
    setQuarantinedRows(loadQuarantinedOrders());
    void refreshDrift();
    onMutated();
  }

  function handleRestoreQuarantined(orderId: string) {
    const ok = restoreQuarantinedOrder(orderId);
    setStatusMsg(ok ? "已還原到本機訂單。" : "還原失敗。");
    setQuarantinedRows(loadQuarantinedOrders());
    void refreshDrift();
    onMutated();
  }

  function handleDiscardQuarantined(orderId: string) {
    if (!window.confirm("確定永久刪除呢張孤兒單？會同時加入 tombstone，唔會再復活。")) return;
    const ok = discardQuarantinedOrder(orderId);
    setStatusMsg(ok ? "已永久刪除。" : "刪除失敗。");
    setQuarantinedRows(loadQuarantinedOrders());
    onMutated();
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-base font-semibold text-slate-900">同步健康檢查</div>
            <div className="mt-0.5 text-xs text-slate-500">
              檢查「已結帳但未上到雲」嘅訂單；補錄會用本機快照重新推上雲端
            </div>
          </div>
          <button
            type="button"
            aria-label="關閉"
            onClick={onClose}
            className="rounded-xl px-2.5 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!storeId ? (
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              未登入 POS 帳號或未綁定店舖，無法對賬。請先登入再試。
            </div>
          ) : (
            <>
              {/* ── L1：失敗事件 ── */}
              <section className="mb-5">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    同步失敗事件
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      {failedEvents.length} 筆
                    </span>
                  </h2>
                  {failedEvents.length > 0 ? (
                    <button
                      type="button"
                      onClick={handleRetryAll}
                      className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                    >
                      全部重試
                    </button>
                  ) : null}
                </div>
                {failedEvents.length === 0 ? (
                  <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    ✅ 冇永久失敗嘅同步事件（連續被拒 5 次先會入呢度）。
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {failedEvents.map((event) => (
                      <li
                        key={event.id}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold text-slate-800">
                              {event.type}
                              <span className="ml-2 font-normal text-slate-400">#{event.entityId.slice(-8)}</span>
                              {typeof event.attempts === "number" ? (
                                <span className="ml-2 font-normal text-slate-400">嘗試 {event.attempts} 次</span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-500">
                              {event.lastError ? `原因：${event.lastError}` : `建立於 ${new Date(event.createdAt).toLocaleString("zh-HK")}`}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRetryEvent(event.id)}
                              className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                            >
                              重試
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDiscard(event.id)}
                              className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-red-600 ring-1 ring-red-200 hover:bg-red-50"
                            >
                              放棄
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── L2：終態對賬補錄 ── */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    已結帳但雲端未同步
                    <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-700">
                      {scanState === "done" ? `${driftRows.length} 張` : "…"}
                    </span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => void refreshDrift()}
                    disabled={scanState === "scanning"}
                    className="rounded-xl bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {scanState === "scanning" ? "檢查中…" : "重新檢查"}
                  </button>
                </div>

                {scanState === "scanning" ? (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">正在比對本機同雲端訂單狀態…</div>
                ) : scanState === "error" ? (
                  <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">對賬失敗：{scanError}</div>
                ) : driftRows.length === 0 ? (
                  <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    ✅ 冇發現「本機已結帳、雲端仲係未結帳」嘅訂單。
                  </div>
                ) : (
                  <>
                    <div className="mb-2 rounded-xl bg-purple-50 px-3 py-2 text-[11px] leading-relaxed text-purple-800">
                      以下訂單喺本機已完成，但雲端仲未收到結帳。撳「補錄上雲」會將本機快照重新推送；如冇反應可等幾秒再「重新檢查」。
                    </div>
                    <ul className="space-y-2">
                      {driftRows.map((row) => (
                        <li key={row.orderId} className="rounded-xl border border-purple-100 bg-white px-3 py-2.5 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-800">
                                {row.localOrderNo}
                                {row.tableName ? <span className="ml-2 font-normal text-slate-400">{row.tableName}</span> : null}
                                <span className="ml-2 font-normal text-slate-400">MOP {row.total.toFixed(2)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                                本機
                                <StatusChip status={row.localStatus} tone="ok" />
                                <span className="text-slate-300">→</span>
                                雲端
                                {row.serverStatus ? <StatusChip status={row.serverStatus} tone="warn" /> : <StatusChip status={null} tone="muted" />}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={busyIds.has(row.orderId)}
                              onClick={() => void handleRepush(row.orderId)}
                              className="shrink-0 rounded-xl bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-500 disabled:opacity-50"
                            >
                              {busyIds.has(row.orderId) ? "排入中…" : "補錄上雲"}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => void handleRepushAll()}
                      disabled={busyIds.size > 0}
                      className="mt-3 w-full rounded-xl bg-purple-600 px-3 py-2 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-50"
                    >
                      全部補錄上雲
                    </button>
                  </>
                )}
              </section>

              {/* ── L2 反向：雲端有、本機缺（2026-09-09 加）。
                  多機協作時另一部機結咗帳 → 雲端有 row → 本機 localStorage 冇（POS client
                  mount/realtime 只入 react state，冇持久化），導致呢部機永遠睇唔到。
                  下載 = append 雲端 row 入本機 + 廣播 pos-orders-changed → UI 即時 render。 */}
              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    雲端有但本機缺
                    <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                      {scanState === "done" ? `${missingRows.length} 張` : "…"}
                    </span>
                  </h2>
                </div>

                {scanState === "scanning" ? null : scanState === "error" ? null : missingRows.length === 0 ? (
                  <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    ✅ 冇發現「雲端已結帳、本機冇對應訂單」嘅情況。
                  </div>
                ) : (
                  <>
                    <div className="mb-2 rounded-xl bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-800">
                      雲端有呢啲訂單（多機協作時另一部機結咗帳），但本機 localStorage 冇對應記錄。
                      撳「下載到本機」就會將雲端 row 加返入本機，桌台總覽同店內線下訂量即時見到。
                    </div>
                    <ul className="space-y-2">
                      {missingRows.map((row) => (
                        <li key={row.orderId} className="rounded-xl border border-sky-100 bg-white px-3 py-2.5 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-800">
                                {row.localOrderNo}
                                {row.tableName ? <span className="ml-2 font-normal text-slate-400">{row.tableName}</span> : null}
                                <span className="ml-2 font-normal text-slate-400">MOP {row.total.toFixed(2)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                                雲端
                                <StatusChip status={row.serverStatus} tone="ok" />
                                <span className="text-slate-300">·</span>
                                更新於 {new Date(row.serverUpdatedAt).toLocaleString("zh-HK")}
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] font-semibold text-sky-700">將會下載</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={handleDownloadAll}
                      className="mt-3 w-full rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500"
                    >
                      全部下載到本機（{missingRows.length} 張）
                    </button>
                  </>
                )}
              </section>

              {/* ── L3：孤兒單（2026-09-09 方案 A）──
                  本機非終態 + 雲端全量冇 + outbox 冇 pending/failed ORDER_* 事件支持。
                  即係「手動更新不斷拉返嚟嘅幽靈枱」—— 雲端根本冇呢張單，merge 永遠唔會清走佢。
                  隔離 = 由桌台移出、保留快照喺下方隔離區，可還原。 */}
              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    孤兒單（雲端冇、無法同步）
                    <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                      {scanState === "done" ? `${orphanRows.length} 張` : "…"}
                    </span>
                  </h2>
                </div>

                {scanState === "scanning" ? null : scanState === "error" ? null : orphanRows.length === 0 ? (
                  <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    ✅ 冇發現孤兒單（本機進行中嘅訂單全部喺雲端有記錄）。
                  </div>
                ) : (
                  <>
                    <div className="mb-2 rounded-xl bg-orange-50 px-3 py-2 text-[11px] leading-relaxed text-orange-800">
                      以下訂單喺本機仲係「進行中」，但雲端完全冇記錄、亦冇任何待同步事件支持
                      —— 即係永遠同步唔上雲嘅孤兒單（會令桌台「復活」、報表對唔上）。
                      撳「隔離」將佢由桌台移出（快照保留喺下方，可還原）。
                    </div>
                    <ul className="space-y-2">
                      {orphanRows.map((row) => (
                        <li key={row.orderId} className="rounded-xl border border-orange-100 bg-white px-3 py-2.5 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-800">
                                {row.localOrderNo || "(無單號)"}
                                {row.tableName ? <span className="ml-2 font-normal text-slate-400">{row.tableName}</span> : null}
                                <span className="ml-2 font-normal text-slate-400">MOP {row.total.toFixed(2)}</span>
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                                本機
                                <StatusChip status={row.status} tone="warn" />
                                <span className="text-slate-300">·</span>
                                雲端
                                <StatusChip status={null} tone="muted" />
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleQuarantine(row.orderId)}
                              className="shrink-0 rounded-xl bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500"
                            >
                              隔離
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              {/* ── L4：已隔離訂單（快照保留，可還原 / 永久刪除）── */}
              <section className="mt-5">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">
                    已隔離訂單
                    <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                      {quarantinedRows.length} 張
                    </span>
                  </h2>
                </div>

                {quarantinedRows.length === 0 ? (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    隔離區係空嘅。
                  </div>
                ) : (
                  <>
                    <div className="mb-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                      呢啲訂單已被移出桌台（雲端冇記錄，無法同步）。如果確認係真實消費，
                      可以「還原」返入本機再手動處理；確認係廢單就「永久刪除」。
                    </div>
                    <ul className="space-y-2">
                      {quarantinedRows.map((row) => (
                        <li key={row.order.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-800">
                                {row.order.localOrderNo || "(無單號)"}
                                {row.order.tableName ? <span className="ml-2 font-normal text-slate-400">{row.order.tableName}</span> : null}
                                <span className="ml-2 font-normal text-slate-400">MOP {(row.order.total ?? 0).toFixed(2)}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                {row.reason === "auto-full-pull" ? "自動隔離（手動更新）" : "手動隔離"} ·{" "}
                                {new Date(row.quarantinedAt).toLocaleString("zh-HK")}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleRestoreQuarantined(row.order.id)}
                                className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                              >
                                還原
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDiscardQuarantined(row.order.id)}
                                className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-red-600 ring-1 ring-red-200 hover:bg-red-50"
                              >
                                永久刪除
                              </button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              {statusMsg ? (
                <div className="mt-4 rounded-xl bg-slate-900 px-3 py-2 text-center text-xs font-semibold text-white">
                  {statusMsg}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
