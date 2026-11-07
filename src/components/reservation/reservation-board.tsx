"use client";

/**
 * 訂位台 —— POS 側主頁面。
 *
 * ## 兩種視圖（刻意）
 *
 * - **今天 / 明天**：時段視圖。店員想的是「18:00 還有幾個位」。
 * - **7 天內 / 30 天內 / 全部**：按日期分組的列表。一個時段視圖裝不下 30 天。
 *
 * 同一個表格同時服務兩個問題，會兩邊都做不好 —— 所以分開。
 *
 * ## 零 polling
 *
 * 進頁拉一次；操作成功用 `patchLocal` 局部更新；另有手動刷新。
 * 唔會 `setInterval`、唔會訂閱 Realtime。
 */

import { useCallback, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { ReservationDetailModal } from "@/components/reservation/reservation-detail-modal";
import { ReservationFormModal } from "@/components/reservation/reservation-form-modal";
import { ReservationSettingsModal } from "@/components/reservation/reservation-settings-modal";
import { loadAuthSession, loadBootstrapCache } from "@/lib/storage";
import {
  buildReservationDayListJob,
  printReservationJobs,
} from "@/lib/pos/reservation/print";
import { reservationBizDate } from "@/lib/pos/reservation/biz-date";
import {
  formatBizDate,
  formatMoney,
  formatSlotTime,
  relativeDayLabel,
  RESERVATION_SOURCE_LABEL,
  RESERVATION_STATUS_BORDER,
  RESERVATION_STATUS_META,
} from "@/lib/pos/reservation/labels";
import { groupByBizDate, summarize, useReservations, useReservationSettings, useReservationSlots } from "@/lib/pos/reservation/use-reservations";
import { shiftYmdDays } from "@/lib/pos/reservation/slots";
import {
  RESERVATION_RANGE_LABELS,
  type PosReservation,
  type ReservationRange,
  type ReservationStatus,
} from "@/lib/pos/reservation/types";

const RANGES: ReservationRange[] = ["today", "tomorrow", "7d", "30d", "all"];

const STATUS_FILTERS: Array<{ key: ReservationStatus | "all"; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待確認" },
  { key: "confirmed", label: "已確認" },
  { key: "arrived", label: "已到店" },
  { key: "seated", label: "已入座" },
  { key: "no_show", label: "未到" },
];

export function ReservationBoard() {
  const session = useMemo(() => loadAuthSession(), []);
  const storeId = session?.storeIds?.[0] ?? "";

  const [range, setRange] = useState<ReservationRange>("today");
  const [printMsg, setPrintMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | "all">("all");
  const [detail, setDetail] = useState<PosReservation | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PosReservation | null>(null);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settingsState = useReservationSettings(storeId || null);
  const data = useReservations(storeId || null, range);

  const settings = settingsState.settings;
  const todayBiz = useMemo(
    () => reservationBizDate(new Date(), settings?.serviceHours ?? {}),
    [settings],
  );
  const tomorrowBiz = useMemo(() => shiftYmdDays(todayBiz, 1), [todayBiz]);

  const isSlotView = range === "today" || range === "tomorrow";
  const activeDate = range === "tomorrow" ? tomorrowBiz : todayBiz;
  const slotsState = useReservationSlots(isSlotView ? storeId || null : null, isSlotView ? activeDate : null);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return data.reservations;
    return data.reservations.filter((row) => row.status === statusFilter);
  }, [data.reservations, statusFilter]);

  const stats = useMemo(() => summarize(data.reservations), [data.reservations]);
  const dayGroups = useMemo(() => groupByBizDate(filtered), [filtered]);

  /** slotAt（毫秒）→ 該時段的訂位。 */
  const bySlot = useMemo(() => {
    const map = new Map<number, PosReservation[]>();
    for (const row of filtered) {
      const key = new Date(row.slotAt).getTime();
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return map;
  }, [filtered]);

  const openDetail = useCallback((row: PosReservation) => setDetail(row), []);

  const handleChanged = useCallback(
    (next: PosReservation) => {
      data.patchLocal(next.id, next);
      setDetail((prev) => (prev && prev.id === next.id ? next : prev));
      setFormOpen(false);
      setEditing(null);
      void data.reload();
    },
    [data],
  );

  const handleCreated = useCallback(() => {
    setFormOpen(false);
    setEditing(null);
    void data.reload();
    void slotsState.reload();
  }, [data, slotsState]);

  const tableMissing = !data.tableReady || !settingsState.tableReady;
  const disabled = settings ? !settings.enabled : false;

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden md:pl-[72px]">
        {/* 頂欄 */}
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-slate-900">訂位</div>
              <div className="mt-0.5 text-sm text-slate-500">
                {isSlotView ? formatBizDate(activeDate) : RESERVATION_RANGE_LABELS[range]} ·{" "}
                共 {stats.groups} 組 · {stats.guests} 位
                {stats.prepaid > 0 ? ` · 已預付 ${stats.prepaid}` : ""}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="inline-flex min-h-[36px] items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
                onClick={() => setCheckInOpen(true)}
                type="button"
              >
                掃碼到店
              </button>
              <button
                className="inline-flex min-h-[36px] items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
                onClick={() => {
                  const ctx = {
                    storeId,
                    storeName: loadBootstrapCache(storeId)?.storeName ?? "",
                    notice: settings?.notice ?? "",
                  };
                  const queued = printReservationJobs([
                    buildReservationDayListJob(data.reservations, activeDate, ctx),
                  ]);
                  setPrintMsg(queued > 0 ? "今日訂位清單已送到打印機。" : "未能加入列印，請到打印中心檢查。");
                  window.setTimeout(() => setPrintMsg(null), 3500);
                }}
                type="button"
              >
                列印清單
              </button>
              <button
                className="inline-flex min-h-[36px] items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
                onClick={() => setSettingsOpen(true)}
                type="button"
              >
                設置
              </button>
              <button
                className="inline-flex min-h-[36px] items-center rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                disabled={!storeId}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
                type="button"
              >
                ＋ 新增訂位
              </button>
            </div>
          </div>

          {printMsg ? (
            <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
              {printMsg}
            </div>
          ) : null}

          {/* 五檔時間篩選 */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {RANGES.map((key) => (
              <button
                key={key}
                className={`min-h-[34px] rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  range === key
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
                onClick={() => setRange(key)}
                type="button"
              >
                {RESERVATION_RANGE_LABELS[key]}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <button
                className="inline-flex min-h-[34px] items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-50"
                disabled={data.state === "loading"}
                onClick={() => void data.reload()}
                type="button"
              >
                {data.state === "loading" ? "載入中…" : "手動刷新"}
              </button>
            </div>
          </div>
        </header>

        {/* 統計 */}
        <div className="grid shrink-0 grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-4">
          <Stat label={isSlotView ? "本日訂位" : "範圍內"} value={`${stats.groups}`} suffix="組" />
          <Stat label="待確認" value={`${stats.pending}`} tone="warn" />
          <Stat label="已到店" value={`${stats.arrived}`} />
          <Stat label="逾時未到" value={`${stats.noShow}`} tone="bad" />
        </div>

        {/* 狀態 chips */}
        <div className="flex shrink-0 flex-wrap gap-2 border-b border-slate-200 bg-white px-4 py-2">
          {STATUS_FILTERS.map((item) => (
            <button
              key={item.key}
              className={`min-h-[30px] rounded-full px-3 py-1 text-xs font-semibold ${
                statusFilter === item.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
              onClick={() => setStatusFilter(item.key)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 主體 */}
        <main className="min-h-0 flex-1 overflow-auto px-4 py-4">
          {tableMissing ? (
            <Notice
              tone="warn"
              title="訂位資料表未建立"
              body="請先執行 supabase/migrations/0077_pos_reservations.sql，然後重新整理。"
            />
          ) : disabled ? (
            <Notice
              tone="info"
              title="本店未開放訂位"
              body="到「訂位設置」開啟後，客人便可以透過會員通訂位。店員代訂不受影響。"
            />
          ) : null}

          {data.error ? <Notice tone="error" title="讀取失敗" body={data.error} /> : null}

          {isSlotView ? (
            <SlotView
              slots={slotsState.slots}
              loading={slotsState.loading}
              quota={slotsState.meta?.quota ?? settings?.slotQuota ?? 0}
              bySlot={bySlot}
              onOpen={openDetail}
            />
          ) : (
            <ListGroups groups={dayGroups} todayBiz={todayBiz} tomorrowBiz={tomorrowBiz} onOpen={openDetail} />
          )}

          {!isSlotView && dayGroups.length === 0 && data.state !== "loading" ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              這個範圍內未有訂位
            </div>
          ) : null}
        </main>
      </div>

      {detail ? (
        <ReservationDetailModal
          storeId={storeId}
          reservation={detail}
          onClose={() => setDetail(null)}
          onChanged={handleChanged}
          onEdit={(row) => {
            setEditing(row);
            setDetail(null);
            setFormOpen(true);
          }}
          onOpenSettings={() => setDetail(null)}
          notice={settings?.notice ?? ""}
        />
      ) : null}

      {formOpen ? (
        <ReservationFormModal
          storeId={storeId}
          settings={settings}
          todayBiz={todayBiz}
          editing={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onCreated={handleCreated}
        />
      ) : null}

      {settingsOpen && settings ? (
        <ReservationSettingsModal
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            const result = await settingsState.save(next);
            if (result.ok) {
              setSettingsOpen(false);
              void data.reload();
            }
            return result;
          }}
          settings={settings}
        />
      ) : null}

      {checkInOpen ? (
        <CheckInModal
          storeId={storeId}
          onClose={() => setCheckInOpen(false)}
          onFound={(row) => {
            setCheckInOpen(false);
            setDetail(row);
          }}
        />
      ) : null}
    </div>
  );
}

/* ────────────────────────── 子元件 ────────────────────────── */

function Stat({ label, value, suffix, tone }: { label: string; value: string; suffix?: string; tone?: "warn" | "bad" }) {
  const color = tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="border-r border-slate-100 px-4 py-3 last:border-r-0">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tracking-tight ${color}`}>
        {value}
        {suffix ? <span className="ml-1 text-xs font-semibold text-slate-400">{suffix}</span> : null}
      </div>
    </div>
  );
}

function Notice({ tone, title, body }: { tone: "warn" | "error" | "info"; title: string; body: string }) {
  const cls =
    tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-slate-200 bg-white text-slate-600";
  return (
    <div className={`mb-3 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${cls}`}>
      <span className="font-semibold">{title}　</span>
      {body}
    </div>
  );
}

function SlotView({
  slots,
  loading,
  quota,
  bySlot,
  onOpen,
}: {
  slots: Array<{ slotAt: string; label: string; used: number; remaining: number; full: boolean; past: boolean }>;
  loading: boolean;
  quota: number;
  bySlot: Map<number, PosReservation[]>;
  onOpen: (row: PosReservation) => void;
}) {
  if (loading && slots.length === 0) {
    return <div className="py-10 text-center text-sm text-slate-400">載入時段中…</div>;
  }
  if (slots.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
        這一日未有可訂時段。請到「訂位設置」檢查營業時段。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {slots.map((slot) => {
        const rows = bySlot.get(new Date(slot.slotAt).getTime()) ?? [];
        return (
          <section key={slot.slotAt}>
            <div className="mb-1.5 flex items-center gap-2 px-0.5">
              <span className="text-sm font-bold tabular-nums text-slate-800">{slot.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  slot.full ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600"
                }`}
              >
                {slot.full ? `已滿 ${slot.used}/${quota}` : `餘 ${slot.remaining} 組`}
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            {rows.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {rows.map((row) => (
                  <ReservationCard key={row.id} row={row} onOpen={onOpen} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white/70 px-3 py-2 text-[12px] text-slate-400">
                {slot.past ? "已過時段" : `未有訂位　·　可再接 ${slot.remaining} 組`}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ListGroups({
  groups,
  todayBiz,
  tomorrowBiz,
  onOpen,
}: {
  groups: ReturnType<typeof groupByBizDate>;
  todayBiz: string;
  tomorrowBiz: string;
  onOpen: (row: PosReservation) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <section key={group.bizDate} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
            <span className="text-sm font-bold text-slate-800">{formatBizDate(group.bizDate)}</span>
            {relativeDayLabel(group.bizDate, todayBiz, tomorrowBiz) ? (
              <span className="rounded-md bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {relativeDayLabel(group.bizDate, todayBiz, tomorrowBiz)}
              </span>
            ) : null}
            <span className="text-[11.5px] font-semibold text-slate-500">
              {group.groups} 組 · {group.guests} 位
            </span>
            {group.pending > 0 ? (
              <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-bold text-amber-700">
                待確認 {group.pending}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5 p-2.5">
            {group.rows.slice(0, 6).map((row) => (
              <ReservationCard key={row.id} row={row} onOpen={onOpen} compact />
            ))}
            {group.rows.length > 6 ? (
              <div className="py-1 text-center text-[11.5px] font-semibold text-indigo-600">
                另有 {group.rows.length - 6} 張，請用「今天 / 明天」查看詳情
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReservationCard({
  row,
  onOpen,
  compact,
}: {
  row: PosReservation;
  onOpen: (row: PosReservation) => void;
  compact?: boolean;
}) {
  const meta = RESERVATION_STATUS_META[row.status];
  const border = RESERVATION_STATUS_BORDER[row.status];

  if (compact) {
    return (
      <button
        className="flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-1.5 text-left"
        onClick={() => onOpen(row)}
        type="button"
      >
        <span className="w-[46px] shrink-0 text-[12.5px] font-bold tabular-nums text-slate-700">
          {formatSlotTime(row.slotAt)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-slate-800">
          {row.guestName || "（未登記）"} · {row.partySize} 位
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${meta.className}`}>{meta.label}</span>
        {row.items.length > 0 ? (
          <span className="shrink-0 text-[10.5px] font-bold text-orange-600">預點 {row.items.length}</span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 border-l-4 bg-white px-3 py-2.5 ${border}`}
    >
      <div className="w-[54px] shrink-0 text-center">
        <div className="text-[15px] font-bold tabular-nums text-slate-900">{formatSlotTime(row.slotAt)}</div>
        <div className="text-[11px] font-semibold text-slate-500">{row.partySize} 位</div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-bold text-slate-900">{row.guestName || "（未登記姓名）"}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${meta.className}`}>{meta.label}</span>
          {row.items.length > 0 ? (
            <span className="rounded-md border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">
              預點 {row.items.length} 道
            </span>
          ) : null}
          {row.paidAmount > 0 ? (
            <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
              已付 {formatMoney(row.paidAmount)}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
          {[row.guestPhone, row.guestNote, RESERVATION_SOURCE_LABEL[row.source]].filter(Boolean).join(" · ")}
        </div>
      </div>

      <div className="shrink-0 text-right">
        {row.payableAmount > 0 ? (
          <>
            <div className="text-[12.5px] font-bold tabular-nums text-slate-800">{formatMoney(row.payableAmount)}</div>
            <div className="text-[10px] font-semibold text-slate-400">{row.paidAmount > 0 ? "已預付" : "預點"}</div>
          </>
        ) : (
          <div className="text-[12px] text-slate-300">—</div>
        )}
      </div>

      <button
        className="inline-flex min-h-[32px] shrink-0 items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-600"
        onClick={() => onOpen(row)}
        type="button"
      >
        詳情
      </button>
    </div>
  );
}

/** 掃碼／輸入訂位碼 → 找到訂位。 */
function CheckInModal({
  storeId,
  onClose,
  onFound,
}: {
  storeId: string;
  onClose: () => void;
  onFound: (row: PosReservation) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || !storeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/pos/reservations?storeId=${encodeURIComponent(storeId)}&range=all&limit=300`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as { ok?: boolean; reservations?: PosReservation[]; error?: string };
      if (!json.ok) {
        setError(json.error ?? "查詢失敗");
        return;
      }
      const hit = (json.reservations ?? []).find((row) => row.code.toUpperCase() === trimmed);
      if (!hit) {
        setError(`找不到訂位碼 ${trimmed}`);
        return;
      }
      onFound(hit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查詢失敗");
    } finally {
      setBusy(false);
    }
  }, [code, storeId, onFound]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="text-base font-semibold text-slate-900">掃碼到店</div>
          <button className="text-lg text-slate-400" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-[12.5px] leading-relaxed text-slate-500">
            用掃碼槍掃客人的訂位二維碼，或直接輸入訂位碼。掃到之後會先顯示確認卡，
            <b className="text-slate-700">按「確認到店」才會改狀態</b>。
          </p>
          <input
            autoFocus
            className="mt-3 h-12 w-full rounded-xl border border-slate-200 px-3 text-center text-lg font-bold tracking-widest uppercase outline-none focus:border-indigo-400"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="R1106-018"
            value={code}
          />
          {error ? <div className="mt-2 text-[12px] font-semibold text-rose-600">{error}</div> : null}
        </div>
        <div className="flex gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            className="min-h-[40px] flex-1 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="min-h-[40px] flex-[2] rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy || code.trim().length === 0}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? "查詢中…" : "查詢訂位"}
          </button>
        </div>
      </div>
    </div>
  );
}
