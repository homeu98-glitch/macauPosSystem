"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { OrderSourceBadge } from "@/components/order-source-badge";
import { StationPicker } from "@/components/kds/station-picker";
import {
  clearKdsDeviceBinding,
  loadKdsDeviceBinding,
  saveKdsDeviceBinding,
} from "@/lib/kds/device-binding";
import { remainingQtyOf } from "@/lib/kds/kds-board";
import { isStationAvailable, needsStationPicker } from "@/lib/kds/stations";
import type { KdsBoardOrder, KdsDeviceBinding } from "@/lib/kds/types";
import { useKdsBoard } from "@/lib/kds/use-kds-board";
import { loadAuthSession, type AuthSession } from "@/lib/storage";

/**
 * 後廚屏 `/kitchen`（docs/116 §7.1）。
 *
 * ## 入場流程
 *
 * ```
 * 有 authSession？
 *   冇 → 叫返去登入
 *   有 → 有 KDS 綁定（連崗位）？
 *          冇 → 揀崗位（只有一個工位就自動鎖定，唔嘥一步）
 *          有 → 直接入屏，鎖死嗰個崗位
 * ```
 *
 * ## 🔴 屏內**冇**「全部 / 廚房 / 水吧」切換掣
 *
 * 呢個係產品要求（降低誤按）。要改崗位只有一條路：
 * 「⚙ 設定」→「切換崗位」→ 清綁定 → 返登入（深兩層 + 要重新登入）。
 *
 * ## 版面硬規則（踩過嘅坑）
 *
 * - 卡片格用 `grid grid-cols-2 auto-rows-max items-stretch`
 *   —— **`auto-rows-max` 唔可以漏**，否則捲動容器會將 row 壓到 min-content
 *     → 卡片互相重疊（見 docs/116 §7.0）。
 * - **唔用響應式斷點**：iPad 橫向係唯一目標形狀。
 */

/** 完成後卡片留喺原位幾耐（畀廚房確認「我冇撳錯」+ 可撤銷）。 */
const LINGER_MS = 8000;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Timer({ startedAt, serverNow }: { startedAt?: string; serverNow: number }) {
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const minutes = Math.floor((serverNow - startMs) / 60_000);
  const cls =
    minutes >= 8
      ? "bg-rose-100 text-rose-700"
      : minutes >= 3
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex rounded-[10px] px-3 py-1.5 font-mono text-[19px] font-bold ${cls}`}>
      {formatElapsed(serverNow - startMs)}
    </span>
  );
}

/** 一張訂單卡。 */
function OrderCard({
  order,
  serverNow,
  onToggleItem,
  completed,
  onUndoComplete,
}: {
  order: KdsBoardOrder;
  serverNow: number;
  /** 撳 ✓ = 出一件；已滿就撤銷一件。父層統一處理「最後一件 → 留 8 秒」。 */
  onToggleItem: (order: KdsBoardOrder, itemKey: string, nextDoneQty: number) => void;
  /** 全部完成 → 綠色 + 「撤銷」。 */
  completed?: boolean;
  onUndoComplete?: (order: KdsBoardOrder) => void;
}) {
  const allDone = completed || remainingQtyOf(order.items) === 0;

  return (
    <article
      className={`flex flex-col overflow-hidden rounded-2xl border bg-white shadow-sm ${
        allDone ? "border-emerald-200 bg-emerald-50" : "border-slate-200"
      }`}
    >
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b px-4 py-3 ${
          allDone ? "border-emerald-200" : "border-slate-100"
        }`}
      >
        <div className="min-w-0">
          <div className="font-mono text-[28px] font-semibold leading-tight tracking-tight text-slate-900">
            {order.localOrderNo}
          </div>
          <div className="mt-1.5 truncate text-xs font-medium text-slate-500">
            {(order.tableId === "counter" ? "自取" : "堂食")} · 落單{" "}
            {order.sentToKitchenAt
              ? new Date(order.sentToKitchenAt).toLocaleTimeString("zh-HK", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "--:--"}{" "}
            · 共 {order.items.reduce((s, i) => s + i.quantity, 0)} 件
          </div>
        </div>
        <div className="grid justify-items-end gap-2">
          <OrderSourceBadge order={{ source: order.source }} />
          {completed ? (
            <span className="rounded-[10px] bg-emerald-600 px-3 py-1.5 text-[13px] font-bold text-white">
              已全部完成
            </span>
          ) : (
            <Timer serverNow={serverNow} startedAt={order.sentToKitchenAt} />
          )}
        </div>
      </div>

      {completed && onUndoComplete ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-[13px] text-emerald-700">全部出品已完成</span>
          <button
            className="rounded-xl bg-white px-4 py-2.5 text-[13px] font-bold text-emerald-700 ring-1 ring-emerald-300 active:scale-[.98]"
            onClick={() => onUndoComplete(order)}
            type="button"
          >
            撤銷
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col px-4 pb-3.5 pt-1.5">
          {order.items.map((item) => {
            const done = item.doneQty >= item.quantity;
            const partial = !done && item.doneQty > 0;
            return (
              <div
                className={`grid grid-cols-[minmax(0,1fr)_84px] items-center gap-4 py-2.5 ${
                  // 分隔線唔靠「繼承上一行」——除咗第一行之外每行自己帶上邊框
                  item === order.items[0] ? "" : "border-t border-slate-100"
                }`}
                key={item.itemKey}
              >
                <div className="min-w-0">
                  <div
                    className={`text-[22px] font-semibold leading-snug tracking-tight ${
                      done ? "text-slate-400 line-through decoration-2" : "text-slate-900"
                    }`}
                  >
                    {item.name}
                    <span className="ml-1.5 font-mono text-base font-medium text-slate-500">
                      ×{item.quantity}
                    </span>
                  </div>
                  {item.specs.length > 0 || item.note || (item.quantity > 1 && !done) ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item.specs.length > 0 ? (
                        <span className="rounded-[7px] bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                          {item.specs.join(" · ")}
                        </span>
                      ) : null}
                      {item.note ? (
                        <span className="rounded-[7px] bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                          {item.note}
                        </span>
                      ) : null}
                      {item.quantity > 1 ? (
                        <span className="rounded-[7px] bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-200">
                          {done ? "完成" : "已出"} {item.doneQty} / {item.quantity}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <button
                  className={`grid h-[60px] w-[84px] place-items-center rounded-[14px] text-[27px] font-bold leading-none transition active:scale-95 ${
                    done
                      ? "bg-emerald-50 text-emerald-600 ring-[1.5px] ring-emerald-500"
                      : partial
                        ? "bg-amber-50 text-amber-700 ring-[1.5px] ring-amber-500"
                        : "bg-white text-slate-400 ring-[1.5px] ring-slate-200"
                  }`}
                  onClick={() =>
                    onToggleItem(order, item.itemKey, done ? item.doneQty - 1 : item.doneQty + 1)
                  }
                  // 撳一下 = 出一件。已出滿就係「撤銷一件」（唔使長按都救得返）
                  title="撳一下完成一件 · 再撳一下撤銷"
                  type="button"
                >
                  ✓
                </button>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function KitchenScreen() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [binding, setBinding] = useState<KdsDeviceBinding | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  /** 完成咗但仲留喺屏上嘅卡（8 秒後自動走，期間可撤銷）。 */
  const [lingering, setLingering] = useState<Map<string, { order: KdsBoardOrder; index: number }>>(
    () => new Map(),
  );
  const lingerTimers = useRef(new Map<string, number>());
  const lastTapped = useRef(new Map<string, { orderId: string; itemKey: string }>());

  useEffect(() => {
    setAuthSession(loadAuthSession());
    setBinding(loadKdsDeviceBinding());
    setHydrated(true);
  }, []);

  // 1 秒一跳：計時器 + 傾斜處理完成卡嘅過期
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      for (const timer of lingerTimers.current.values()) window.clearTimeout(timer);
      lingerTimers.current.clear();
    },
    [],
  );

  const storeId = authSession?.merchantId ?? null;
  const station = binding?.role === "kitchen" ? (binding.station ?? null) : null;

  const api = useKdsBoard({
    storeId,
    station,
    // 未有 session 就唔好打 API；未有崗位都要打（要攞工位清單畀「揀崗位」畫面）
    enabled: Boolean(storeId),
  });

  const serverNow = nowTick + api.clockOffsetMs;

  // ── 只有一個工位 → 唔應該阻同事多撳一步，直接鎖定 ──
  const autoPicked = useRef(false);
  useEffect(() => {
    if (station || autoPicked.current) return;
    if (api.loading || api.stations.length === 0) return;
    if (needsStationPicker(api.stations)) return;
    if (!storeId) return;
    autoPicked.current = true;
    const only = api.stations[0];
    const ok = saveKdsDeviceBinding({
      storeId,
      storeName: authSession?.name ?? "",
      role: "kitchen",
      station: only.id,
      boundAt: new Date().toISOString(),
    });
    if (ok) setBinding(loadKdsDeviceBinding());
  }, [station, api.loading, api.stations, storeId, authSession?.name]);

  const chooseStation = useCallback(
    (stationId: string) => {
      if (!storeId) return;
      setSaving(true);
      setPickerError(null);
      const ok = saveKdsDeviceBinding({
        storeId,
        storeName: authSession?.name ?? "",
        role: "kitchen",
        station: stationId,
        boundAt: new Date().toISOString(),
      });
      setSaving(false);
      if (!ok) {
        setPickerError("綁定失敗（店鋪代碼唔正確）。請重新登入，確保登入有帶到商戶 ID。");
        return;
      }
      setBinding(loadKdsDeviceBinding());
    },
    [storeId, authSession?.name],
  );

  // ── 完成最後一件 → 卡片留 8 秒（綠色 + 可撤銷）──
  const toggleItem = useCallback(
    (order: KdsBoardOrder, itemKey: string, targetDone: number) => {
      api.markItem(order.id, itemKey, targetDone);

      const nextRemaining = order.items.reduce(
        (sum, item) => sum + Math.max(0, item.quantity - (item.itemKey === itemKey ? targetDone : item.doneQty)),
        0,
      );
      if (nextRemaining > 0) return;

      lastTapped.current.set(order.id, { orderId: order.id, itemKey });
      const snapshot: KdsBoardOrder = {
        ...order,
        items: order.items.map((item) => ({ ...item, doneQty: item.quantity })),
      };
      // 位置喺「完成嗰一刻」就定咗 → 卡片留喺原位，唔會彈去最頂
      const at = api.orders.findIndex((o) => o.id === order.id);
      setLingering((prev) => new Map(prev).set(order.id, { order: snapshot, index: at < 0 ? 0 : at }));
      const timer = window.setTimeout(() => {
        lingerTimers.current.delete(order.id);
        setLingering((prev) => {
          const next = new Map(prev);
          next.delete(order.id);
          return next;
        });
      }, LINGER_MS);
      const old = lingerTimers.current.get(order.id);
      if (old) window.clearTimeout(old);
      lingerTimers.current.set(order.id, timer);
    },
    [api],
  );

  const undoComplete = useCallback(
    (order: KdsBoardOrder) => {
      const tapped = lastTapped.current.get(order.id);
      const timer = lingerTimers.current.get(order.id);
      if (timer) {
        window.clearTimeout(timer);
        lingerTimers.current.delete(order.id);
      }
      setLingering((prev) => {
        const next = new Map(prev);
        next.delete(order.id);
        return next;
      });
      if (tapped) {
        const item = order.items.find((i) => i.itemKey === tapped.itemKey);
        if (item) api.markItem(order.id, item.itemKey, Math.max(0, item.quantity - 1));
      }
    },
    [api],
  );

  const visibleOrders = useMemo(() => {
    const list = [...api.orders];
    const present = new Set(list.map((o) => o.id));
    for (const [id, entry] of lingering) {
      if (present.has(id)) continue;
      // 插返佢消失前嘅位置（完成卡要「留在原位」，唔可以彈去最頂）
      list.splice(Math.min(entry.index, list.length), 0, entry.order);
    }
    return list;
  }, [api.orders, lingering]);

  const remaining = useMemo(
    () => api.orders.reduce((sum, order) => sum + remainingQtyOf(order.items), 0),
    [api.orders],
  );

  // 分區名**一律由商家設定提供**（api.stations = printZones）。
  // 只喺「榜單未載入 / 分區已被刪」時才 fallback 落 raw id —— 誠實過亂譯一個名。
  const stationLabelText = api.stations.find((item) => item.id === station)?.name ?? station ?? "";
  const stationMissing = Boolean(station && api.stations.length > 0 && !isStationAvailable(api.stations, station));

  // ───────────────────────── 未載入完 ─────────────────────────
  if (!hydrated) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-slate-50 text-sm text-slate-400">
        正在載入後廚屏…
      </div>
    );
  }

  // ───────────────────────── 未登入 ─────────────────────────
  if (!storeId) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-slate-50 px-6 text-center">
        <div>
          <div className="text-lg font-semibold text-slate-900">未登入</div>
          <div className="mt-2 text-sm text-slate-500">
            後廚屏係一部機嘅角色，要先用商戶帳號登入一次。
          </div>
          <Link
            className="mt-5 inline-block rounded-2xl bg-slate-900 px-6 py-3 text-sm font-bold text-white"
            href="/login?mode=kitchen"
          >
            去登入（後廚屏）
          </Link>
        </div>
      </div>
    );
  }

  // ───────────────────────── 揀崗位 ─────────────────────────
  if (!station) {
    return (
      <StationPicker
        error={pickerError ?? api.loadError}
        loading={api.loading}
        onPick={chooseStation}
        onRetry={api.refresh}
        saving={saving}
        stations={api.stations}
        storeName={authSession?.name ?? ""}
      />
    );
  }

  // ───────────────────────── 屏 ─────────────────────────
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-slate-50">
      {/* 頂欄 —— 崗位徽章係**唯讀**，刻意做成唔似按鈕 */}
      <div className="grid h-[66px] flex-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3.5 border-b border-slate-200 bg-white px-4">
        <div className="truncate text-base font-semibold tracking-tight text-slate-900">
          {authSession?.name || "本店"}
          <em className="ml-2 text-[13px] font-medium not-italic text-slate-400">
            {stationLabelText}屏
          </em>
        </div>
        <div className="inline-flex items-center gap-2.5 rounded-full bg-slate-100 py-2 pl-3.5 pr-4 ring-1 ring-slate-200">
          <span className="h-3 w-3 flex-none rounded-full bg-orange-500" />
          <span className="text-[17px] font-bold tracking-tight text-slate-900">{stationLabelText}</span>
          <span className="rounded-full bg-white px-2.5 py-0.5 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">
            已鎖定
          </span>
        </div>
        <div className="flex items-center justify-end gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold ${
              api.connected ? "bg-slate-100 text-slate-500" : "bg-rose-100 text-rose-700"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${api.connected ? "bg-emerald-500" : "bg-rose-500"}`} />
            {api.connected ? "已連線" : "連線中"}
          </span>
          <span className="inline-flex items-baseline gap-2 whitespace-nowrap rounded-full bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white">
            未完成 <b className="font-mono text-[17px]">{remaining}</b>
          </span>
          <button
            className="whitespace-nowrap rounded-full bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-900 ring-1 ring-slate-200 active:bg-slate-50"
            onClick={() => setShowSettings(true)}
            type="button"
          >
            ⚙ 設定
          </button>
        </div>
      </div>

      {/* 警示帶：任何一個都唔可以扮成功 */}
      {api.degraded === "kds_state_table_missing" ? (
        <div className="flex h-11 flex-none items-center gap-2.5 bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ 後廚狀態表未建立（migration 0033 未跑）· 撳「✓」唔會保存，請即刻通知工程師
        </div>
      ) : null}
      {api.failedCount > 0 ? (
        <div className="flex h-11 flex-none items-center gap-2.5 bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ 有 {api.failedCount} 次確認唔到（已回復原狀）{api.lastError ? ` · ${api.lastError}` : ""}
        </div>
      ) : null}
      {api.realtimeHealthy === false ? (
        <div className="flex h-11 flex-none items-center gap-2.5 bg-amber-500 px-5 text-sm font-bold text-white">
          ⚠ {api.realtimeHint}（新單可能唔會自動彈出）
        </div>
      ) : null}
      {api.loadError ? (
        <div className="flex h-11 flex-none items-center gap-2.5 bg-rose-600 px-5 text-sm font-bold text-white">
          ⚠ {api.loadError}
          <button className="rounded-lg bg-white/20 px-3 py-1 text-xs" onClick={api.refresh} type="button">
            重試
          </button>
        </div>
      ) : null}

      {/* 卡片格：⚠️ `auto-rows-max` 唔可以漏（漏咗 = 卡片重疊） */}
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 items-stretch content-start gap-3.5 overflow-y-auto p-3.5 pb-6">
        {visibleOrders.length === 0 ? (
          <div className="col-span-2 px-5 py-20 text-center text-sm leading-loose text-slate-400">
            暫時冇未完成嘅單
            <br />
            <span className="text-xs text-slate-300">
              新單一落到就會自動出現（{stationLabelText}工位）
            </span>
          </div>
        ) : (
          visibleOrders.map((order) => (
            <OrderCard
              completed={lingering.has(order.id)}
              key={order.id}
              onToggleItem={toggleItem}
              onUndoComplete={undoComplete}
              order={order}
              serverNow={serverNow}
            />
          ))
        )}
      </div>

      {/* 設定卡 = 屏內切換崗位嘅**唯一**入口（逃生門） */}
      {showSettings ? (
        <div className="absolute inset-0 z-[60] grid place-items-center bg-slate-900/45 p-6">
          <div className="w-[520px] rounded-[22px] bg-white px-6 pb-5 pt-6 shadow-2xl">
            <div className="text-[19px] font-bold tracking-tight text-slate-900">⚙ 後廚屏設定</div>
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-b border-slate-100 py-3 text-sm text-slate-500">
              <span>本機角色</span>
              <b className="font-semibold text-slate-900">後廚屏</b>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-b border-slate-100 py-3 text-sm text-slate-500">
              <span>本機崗位</span>
              <b className="font-semibold text-slate-900">{stationLabelText}（已鎖定）</b>
            </div>
            <div className="mt-3.5 rounded-2xl bg-slate-50 px-4 py-3 text-[12.5px] leading-relaxed text-slate-500">
              呢部機已經鎖定做單一崗位，屏內
              <strong className="font-semibold text-slate-900">
                冇「全部 / {stationLabelText}」切換掣
              </strong>
              ，就係為咗防止誤撳。
              <br />
              要改崗位，必須重新登入（下面個掣）。
              {stationMissing ? (
                <>
                  <br />
                  <span className="font-semibold text-amber-700">
                    ⚠ 注意：本店嘅工位清單而家冇「{stationLabelText}」，可能係菜單改過。
                  </span>
                </>
              ) : null}
            </div>
            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2.5">
              <button
                className="rounded-[13px] bg-slate-100 px-5 py-3 text-sm font-bold text-slate-600 ring-1 ring-slate-200"
                onClick={() => setShowSettings(false)}
                type="button"
              >
                關閉
              </button>
              <button
                className="whitespace-nowrap rounded-[13px] bg-rose-600 px-5 py-3 text-sm font-bold text-white"
                onClick={() => {
                  clearKdsDeviceBinding();
                  setBinding(null);
                  setShowSettings(false);
                  autoPicked.current = false;
                  setLingering(new Map());
                }}
                type="button"
              >
                切換崗位（重新登入）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
