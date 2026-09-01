"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMacauDateTime } from "@/lib/format";
import { useRouter } from "next/navigation";

import { ResponsiveModal } from "@/components/responsive-modal";
import { ReceiptTicketPreview } from "@/components/receipt-ticket-preview";
import { SelfOrderActionButtons } from "@/components/self-order-action-buttons";
import { SelfOrderAutoAcceptToggle } from "@/components/self-order-auto-accept-toggle";
import { OrderSourceBadge } from "@/components/order-source-badge";
import { OrderDiscountRow } from "@/components/order-discount-display";
import {
  dateFilterLabel,
  LedgerOrderDateFilter,
  orderMatchesDateFilter,
} from "@/lib/ledger/order-date-filter";
import {
  compareOrderByLocalNo,
  isLocalOrTransferredDineIn,
  isQuickCounterOrder,
  LocalOrderPanelTab,
  matchesLocalOrderPanelTab,
  getOrderStatusBadge,
} from "@/lib/pos-order-filters";
import {
  markQuickOrderCompletedInStore,
  quickCompleteLabel,
  updateQuickFulfillmentInStore,
} from "@/lib/quick-order-fulfillment";
import { isSelfOrder } from "@/lib/pos/order-source";
import { confirmSelfOrder, isReopenable, rejectSelfOrder, reopenPosOrder } from "@/lib/pos-orders";
import {
  addDeletedOrderIds,
  loadAuthSession,
  loadBootstrapCache,
  loadOrders,
  loadPosLocalSettings,
  loadQueue,
  saveOrders,
  saveQueue,
} from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { orderItemDiscountTotal } from "@/lib/pos/discount";

const STATUS_TABS: Array<{ key: LocalOrderPanelTab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "preparing", label: "製作中" },
  { key: "ready", label: "待取餐" },
  { key: "settled", label: "已完成" },
  { key: "reopened", label: "已返結" },
  { key: "cancelled", label: "已取消" },
];

function orderMatchesLocalDateFilter(order: PosOrder, filter: LedgerOrderDateFilter): boolean {
  const pseudo = { createdAt: order.createdAt, updatedAt: order.updatedAt };
  return orderMatchesDateFilter(pseudo, filter);
}

function QuickOrderActions({
  order,
  onChanged,
}: {
  order: PosOrder;
  onChanged: () => void;
}) {
  if (!isQuickCounterOrder(order)) return null;
  // draft 自助單唔顯示「可取餐」——要等「確認出單」先變 sent_to_kitchen（docs/87 §6）
  if (order.status === "draft" && isSelfOrder(order)) return null;

  const completeText = quickCompleteLabel(order);

  // docs/87 §6.3：放寬「可取餐」閘門，容許 sent_to_kitchen / paid 標記 ready（先出餐後付款）
  const canBeReady =
    (order.status === "sent_to_kitchen" || order.status === "paid") &&
    order.fulfillmentStatus !== "ready";

  if (canBeReady) {
    return (
      <button
        className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
        onClick={() => {
          updateQuickFulfillmentInStore(order.id);
          onChanged();
        }}
        type="button"
      >
        可取餐
      </button>
    );
  }

  if (order.status === "paid" && order.fulfillmentStatus === "ready") {
    return (
      <button
        className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white"
        onClick={() => {
          markQuickOrderCompletedInStore(order.id, { label: completeText });
          onChanged();
        }}
        type="button"
      >
        {completeText}
      </button>
    );
  }

  return null;
}

export function LocalOrdersPanel({ dateFilter = "today" }: { dateFilter?: LedgerOrderDateFilter }) {
  const currency = loadBootstrapCache()?.currency ?? "MOP";
  const router = useRouter();
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders().filter(isLocalOrTransferredDineIn));
  const [statusTab, setStatusTab] = useState<LocalOrderPanelTab>("all");
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [reopenTargetOrderId, setReopenTargetOrderId] = useState<string | null>(null);
  const [receiptPreviewOrderId, setReceiptPreviewOrderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState<string>("");
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  function refresh() {
    setOrders(loadOrders().filter(isLocalOrTransferredDineIn));
  }

  useEffect(() => {
    window.addEventListener("pos-orders-changed", refresh);
    return () => window.removeEventListener("pos-orders-changed", refresh);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeTabLabel = STATUS_TABS.find((t) => t.key === statusTab)?.label ?? "全部";

  const filteredOrders = useMemo(() => {
    return orders
      .filter((order) => orderMatchesLocalDateFilter(order, dateFilter))
      .filter((order) => matchesLocalOrderPanelTab(order, statusTab))
      // 單號由小到大（同收銀條 strip 一致）；唔用 updatedAt，否則改狀態單會移位
      .sort(compareOrderByLocalNo);
  }, [dateFilter, orders, statusTab]);
  // 與線上訂單頁「stats.pending」對齊：當前 tab + dateFilter 範圍內，狀態仲係 draft（未送廚房）嘅訂單。
  const draftCount = useMemo(
    () => filteredOrders.filter((order) => order.status === "draft").length,
    [filteredOrders],
  );

  const viewingOrder = viewingOrderId ? orders.find((row) => row.id === viewingOrderId) ?? null : null;
  const reopenTarget = reopenTargetOrderId ? orders.find((row) => row.id === reopenTargetOrderId) ?? null : null;
  const receiptPreviewOrder = receiptPreviewOrderId ? orders.find((row) => row.id === receiptPreviewOrderId) ?? null : null;

  function handleQuickAction() {
    refresh();
    setToast("已更新訂單狀態");
  }

  async function handleDeleteAllOrders() {
    const session = loadAuthSession();
    const storeId = session?.merchantId;
    if (!storeId) {
      setToast("無法取得店舖編號，請重新登入");
      return;
    }
    setDeletingAll(true);
    try {
      // 1) DB 先清（store 隔離 + exclude Ledger 線上單），免 backfill 重拉返晒出嚟
      const res = await fetch(`/api/pos/orders?storeId=${encodeURIComponent(storeId)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; deleted?: number };
      if (!res.ok || data.ok === false) {
        setToast(`刪除失敗：${data.error ?? res.status}`);
        return;
      }
      // 1.5) 本地線下單 id 記 tombstone（防 DB 刪除失效 / RLS 擋 / mock 模式時，backfill 又撈返嚟復活）
      // 只記線下單（onlineOrderId 為空＝DB 真刪嗰批）；Ledger 線上單（onlineOrderId 唔空）唔記，
      // 因為佢哋 DB 冇刪、用家亦無異議保留，下一次 backfill 應照常顯示。
      const localOfflineIds = loadOrders()
        .filter((o) => !o.onlineOrderId)
        .map((o) => o.id);
      if (localOfflineIds.length > 0) addDeletedOrderIds(localOfflineIds);
      // 2) 清本地線下單（saveOrders([]) 只掂本店 localStorage）
      saveOrders([]);
      // 3) 清 order 相關 sync queue events，免重推落 DB（ORDER_CREATED/UPDATED/ITEM_VOIDED/SETTLED）
      saveQueue(loadQueue().filter((e) => !(e.type && e.type.startsWith("ORDER_"))));
      // 4) 廣播畀收銀 / 其他面板（pos-app 監聽 pos-orders-changed）
      window.dispatchEvent(new CustomEvent("pos-orders-changed"));
      refresh();
      setConfirmDeleteAllOpen(false);
      // 5) 回報 DB 實際刪除筆數；0 筆要警告（可能離線 / mock 模式 DB 冇真刪）
      const deleted = typeof data.deleted === "number" ? data.deleted : localOfflineIds.length;
      if (deleted === 0) {
        setToast("已清除本機訂單，但 DB 未刪除任何單（可能離線 / mock 模式，請檢查連線）");
      } else {
        setToast(`已刪除 ${deleted} 筆線下訂單（本地 + DB）`);
      }
    } catch {
      setToast("刪除失敗，請檢查網絡");
    } finally {
      setDeletingAll(false);
    }
  }

  async function handleReopen(order: PosOrder) {
    if (!reopenReason.trim()) {
      setToast("請先揀返結原因");
      return;
    }
    setReopenSubmitting(true);
    try {
      const session = loadAuthSession();
      const operator = session?.name ?? session?.account ?? "收銀";
      const result = await reopenPosOrder({ orderId: order.id, reason: reopenReason, operator });
      if (!result.ok) {
        setToast(result.error ?? "返結失敗");
        return;
      }
      if (result.memberReverseError) {
        setToast("已返結並印單；會員餘額退回待 Ledger 對接");
      } else {
        setToast(result.memberReversed ? "已返結、會員餘額已退回並印單" : "已返結並印返結單");
      }
      setReopenReason("");
      setViewingOrderId(null);
      setReopenTargetOrderId(null);
      // 跳去點餐枱面：進入 temp 枱可編輯「返結帳」狀態，可加餐 / 改價 / 重結（原枱唔會被取代）
      const tableId = result.tempTable?.id ?? (order.tableId && order.tableId !== "counter" ? order.tableId : "");
      router.push(`/?tableId=${encodeURIComponent(tableId)}&orderId=${encodeURIComponent(order.id)}`);
    } finally {
      setReopenSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">店內線下訂單</div>
            {/* 與左卡「線上訂單」header 同格式：dateFilter · tab · 共 X 張 · 新單 X 張。 */}
            <div className="mt-1 text-xs text-slate-500 sm:text-sm">
              {dateFilterLabel(dateFilter)} · {activeTabLabel} · 共 {filteredOrders.length} 張 · 新單 {draftCount} 張
            </div>
          </div>
          {/*
            規格 6：「自動接自助單」開關直接取代原「刪除全部訂單」掣位。
            ⚠️ 「刪除全部訂單」嘅**邏輯保留**（handleDeleteAllOrders + 下方確認彈窗），只係
            介面上唔再需要入口（用戶明確指示：logic 唔好刪、UI 唔再需要）。
            要還原只要喺度加返一粒 onClick={() => setConfirmDeleteAllOpen(true)} 嘅掣就得。
          */}
          <SelfOrderAutoAcceptToggle />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                tab.key === statusTab ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
              }`}
              onClick={() => setStatusTab(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filteredOrders.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
            {dateFilter === "today" ? "今天暫無線下訂單" : `${dateFilterLabel(dateFilter)}暫無線下訂單`}
          </div>
        ) : (
          <div className="grid gap-2">
            {filteredOrders.map((order) => (
              <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {/* 顯示位 ①：訂單頁（規格 7）。來源標記統一放到狀態藥丸下面、右對齊（規格 7 約定） */}
                    <div className="truncate text-sm font-semibold text-slate-900">{order.localOrderNo}</div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">{order.tableName}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      {formatMacauDateTime(order.updatedAt || order.createdAt || "")}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[20px] font-semibold ${
                        (() => {
                          const b = getOrderStatusBadge(order);
                          return `${b.bgClass} ${b.textClass}`;
                        })()
                      }`}
                    >
                      <span
                        className={`h-4 w-4 rounded-full ${
                          (() => {
                            const b = getOrderStatusBadge(order);
                            return b.dotClass;
                          })()
                        }`}
                      />
                      {(() => {
                        const b = getOrderStatusBadge(order);
                        return b.label;
                      })()}
                    </span>
                    <OrderSourceBadge order={order} />
                  </div>
                </div>
                <div className="mt-2 text-sm font-semibold text-slate-900">{formatMoney(order.total, currency)}</div>
                {(() => {
                  // 折扣指示：原價（line-through）+ 折後價（amber）+ 折扣分項
                  const itemSaving = orderItemDiscountTotal(order.items);
                  const wholeSaving = Math.max(0, order.discountAmount ?? 0);
                  if (itemSaving + wholeSaving <= 0) return null;
                  const original = Math.round((order.total + itemSaving + wholeSaving) * 100) / 100;
                  return (
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs font-semibold text-amber-700 tabular-nums">
                        已優惠 -{formatMoney(itemSaving + wholeSaving, currency)}
                      </span>
                      <span className="text-[11px] tabular-nums text-slate-400 line-through">
                        原 {formatMoney(original, currency)}
                      </span>
                    </div>
                  );
                })()}
                <div className="mt-1 truncate text-xs text-slate-500">
                  {order.items
                    .slice(0, 3)
                    .map((item) => `${item.name}×${item.quantity}`)
                    .join(" · ")}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button
                    className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                    onClick={() => {
                      if (order.status === "settled") {
                        // 完成狀態：堂食 + 外賣都彈收據預覽（按打印模板樣式），唔跳點餐介面
                        setReceiptPreviewOrderId(order.id);
                        return;
                      }
                      if (!order.tableId || order.tableId === "counter") {
                        // 快餐/外賣/無枱（未結）→ 保留小窗唯讀
                        setReopenReason("");
                        setViewingOrderId(order.id);
                      } else {
                        // 未結堂食單（本地枱單 + 已轉枱線上堂食單）→ 直接跳枱面編輯
                        router.push(
                          `/?tableId=${encodeURIComponent(order.tableId)}&orderId=${encodeURIComponent(order.id)}`,
                        );
                      }
                    }}
                    type="button"
                  >
                    查看
                  </button>
                  {order.status === "settled" && isReopenable(order) ? (
                    <button
                      className="rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white"
                      onClick={() => {
                        setReopenReason("");
                        setReopenTargetOrderId(order.id);
                      }}
                      type="button"
                    >
                      返結帳
                    </button>
                  ) : null}
                  <QuickOrderActions onChanged={handleQuickAction} order={order} />
                  {/* 自助單 draft → 顯示「確認 / 拒絕」掣（規格 6：開關熄咗時需手動確認，統一用 SelfOrderActionButtons 避免走樣） */}
                  {order.status === "draft" && isSelfOrder(order) ? (
                    <SelfOrderActionButtons
                      orderLabel={order.localOrderNo}
                      onConfirm={() => {
                        const result = confirmSelfOrder(order.id);
                        if (result.ok) {
                          setToast(`已確認自助單 ${order.localOrderNo}`);
                          refresh();
                        } else {
                          setToast(result.error ?? "確認失敗");
                        }
                        return result;
                      }}
                      onReject={() => {
                        const result = rejectSelfOrder(order.id);
                        if (result.ok) {
                          setToast(`已拒絕自助單 ${order.localOrderNo}`);
                          refresh();
                        } else {
                          setToast(result.error ?? "拒絕失敗");
                        }
                        return result;
                      }}
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {viewingOrder ? (
        <ResponsiveModal
          description={`${viewingOrder.tableName} · ${(() => { const b = getOrderStatusBadge(viewingOrder); return b.label; })()}`}
          onClose={() => setViewingOrderId(null)}
          title={viewingOrder.localOrderNo}
          widthClassName="max-w-md"
        >
          <div className="grid gap-2 text-sm text-slate-700">
            {isQuickCounterOrder(viewingOrder) ? (
              <div
                className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                  (() => { const b = getOrderStatusBadge(viewingOrder); return `${b.bgClass} ${b.textClass}`; })()
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    (() => { const b = getOrderStatusBadge(viewingOrder); return b.dotClass; })()
                  }`}
                />
                {(() => { const b = getOrderStatusBadge(viewingOrder); return b.label; })()}
              </div>
            ) : null}
            {viewingOrder.orderNote ? <div>備註：{viewingOrder.orderNote}</div> : null}
            {viewingOrder.items.map((item) => {
              const itemHasDiscount = item.discountRate != null && Number.isFinite(item.discountRate) && item.discountRate < 100;
              return (
                <div key={`${item.menuItemId}-${item.name}`} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {item.name}
                    {itemHasDiscount ? (
                      <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        {item.discountRate}% off
                      </span>
                    ) : null}
                  </span>
                  <span className="font-semibold tabular-nums">×{item.quantity}</span>
                </div>
              );
            })}
            {(viewingOrder.voidedItems ?? []).map((item, idx) => (
              <div key={`voided-${item.menuItemId}-${idx}`} className="flex justify-between gap-2 text-red-600 line-through">
                <span>
                  {item.name}
                  <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">已退菜</span>
                </span>
                <span className="font-semibold">×{item.quantity}</span>
              </div>
            ))}
            {/* 折扣分項（用戶要求所有訂單明細位都要見到） */}
            <OrderDiscountRow
              currency={currency}
              items={viewingOrder.items}
              variant="compact"
              wholeOrderDiscountAmount={viewingOrder.discountAmount}
            />
            <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 font-semibold text-slate-900">
              <span>總計</span>
              <span>{formatMoney(viewingOrder.total, currency)}</span>
            </div>
            {isQuickCounterOrder(viewingOrder) && viewingOrder.status !== "settled" ? (
              <div className="mt-2">
                <QuickOrderActions
                  onChanged={() => {
                    handleQuickAction();
                    refresh();
                    setViewingOrderId(null);
                  }}
                  order={viewingOrder}
                />
              </div>
            ) : null}
            {/* 查看彈窗：自助單 draft 亦顯示確認 / 拒絕（統一用 SelfOrderActionButtons 避免走樣） */}
            {viewingOrder.status === "draft" && isSelfOrder(viewingOrder) ? (
              <div className="mt-2 flex gap-2">
                <SelfOrderActionButtons
                  orderLabel={viewingOrder.localOrderNo}
                  onConfirm={() => {
                    const result = confirmSelfOrder(viewingOrder.id);
                    if (result.ok) {
                      setToast(`已確認自助單 ${viewingOrder.localOrderNo}`);
                      refresh();
                      setViewingOrderId(null);
                    } else {
                      setToast(result.error ?? "確認失敗");
                    }
                    return result;
                  }}
                  onReject={() => {
                    const result = rejectSelfOrder(viewingOrder.id);
                    if (result.ok) {
                      setToast(`已拒絕自助單 ${viewingOrder.localOrderNo}`);
                      refresh();
                      setViewingOrderId(null);
                    } else {
                      setToast(result.error ?? "拒絕失敗");
                    }
                    return result;
                  }}
                />
              </div>
            ) : null}
          </div>
        </ResponsiveModal>
      ) : null}

      {reopenTarget ? (
        <ResponsiveModal
          description="把此單退回可編輯，改正後重新結帳"
          onClose={() => {
            setReopenTargetOrderId(null);
            setReopenReason("");
          }}
          title="返結帳（反結賬）"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-[11px] text-amber-700">
              必須揀返結原因，確認後跳去點餐枱面操作（可改價／加餐／重結）。
            </p>
            <select
              className="w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
            >
              <option value="" disabled>
                揀返結原因…
              </option>
              {(loadPosLocalSettings()?.reopenReasons ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="w-full rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              disabled={!reopenReason || reopenSubmitting}
              onClick={() => handleReopen(reopenTarget)}
            >
              {reopenSubmitting ? "處理中…" : "返結帳"}
            </button>
          </div>
        </ResponsiveModal>
      ) : null}

      {confirmDeleteAllOpen ? (
        <ResponsiveModal
          description="此操作不可復原，會刪除本店全部「店內線下訂單」。"
          onClose={() => setConfirmDeleteAllOpen(false)}
          title="刪除全部訂單"
          widthClassName="max-w-md"
        >
          <div className="grid gap-3">
            <p className="text-xs text-red-700">
              警告：一經確認即永久刪除本店所有線下訂單（含結帳紀錄），無法復原。
              其他已開啟嘅收銀 / 點餐終端唔會自動清除，佢哋下次同步時會重新拉取空列表刷新畫面。
              Ledger 線上訂單（會員餘額相關）唔會受影響。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                onClick={() => setConfirmDeleteAllOpen(false)}
                disabled={deletingAll}
              >
                取消
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                onClick={handleDeleteAllOrders}
                disabled={deletingAll}
              >
                {deletingAll ? "刪除中…" : "確認刪除全部"}
              </button>
            </div>
          </div>
        </ResponsiveModal>
      ) : null}

      {receiptPreviewOrder ? (
        <ResponsiveModal
          description="按現有收據打印模板樣式生成嘅預覽"
          onClose={() => setReceiptPreviewOrderId(null)}
          title={`收據預覽 · ${receiptPreviewOrder.localOrderNo}`}
          widthClassName="max-w-md"
        >
          <ReceiptTicketPreview order={receiptPreviewOrder} />
        </ResponsiveModal>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
