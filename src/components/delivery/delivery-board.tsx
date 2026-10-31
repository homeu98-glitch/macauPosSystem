"use client";

import { useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { DeliveryJobDetailModal } from "@/components/delivery/delivery-job-detail-modal";
import { useT } from "@/components/lang-provider";
import { isDeliveryDispatchEnabled } from "@/lib/pos/delivery/flag";
import type { DeliveryJobStatus, PosDeliveryJob } from "@/lib/pos/delivery/types";
import { useDeliveryDispatch } from "@/lib/pos/delivery/use-delivery-dispatch";
import { loadAuthSession } from "@/lib/storage";

/**
 * 「外送」總覽頁（2026-10-31）。
 *
 * ## 呢一頁係咩
 *
 * 商家喺訂單頁撳「派送」之後，張單就會出現喺呢度 —— 一眼睇到「邊張等緊車手、
 * 邊張配送中、邊張已送達」。**唔會**喺度改任何訂單內容（價錢、狀態、結帳全部
 * 仍然喺訂單頁處理），呢頁只係「派單視角」。
 *
 * ## 🔴 零 polling（用戶明確要求）
 *
 * - 入頁拉一次（module cache 60 秒，同訂單頁共用 inflight），
 * - 之後只有撳「手動刷新」才再拉；
 * - 冇 `setInterval`、冇 Realtime 訂閱（`pos_delivery_jobs` 係 service_role only）。
 *
 * ## 未開旗標時
 *
 * `NEXT_PUBLIC_DELIVERY_DISPATCH` 未開 → 訂單頁根本冇「派送」掣，
 * 呢頁會顯示一句清楚嘅提示，而唔係一個空白列表（令人以為壞咗）。
 */

type FilterKey = "all" | "pending" | "active" | "done" | "canceled";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待派出" },
  { key: "active", label: "進行中" },
  { key: "done", label: "已送達" },
  { key: "canceled", label: "已取消" },
];

/** 狀態 → 顯示文案 + 配色。⚠️ 呢個係 UI 真源，其他位置唔好再各寫一份。 */
const STATUS_META: Record<DeliveryJobStatus, { label: string; className: string; dot: string }> = {
  draft: { label: "待派出", className: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  queued: { label: "待派出", className: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  new: { label: "待接單", className: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  accepted: { label: "已接單", className: "bg-sky-50 text-sky-700", dot: "bg-sky-500" },
  picked_up: { label: "配送中", className: "bg-indigo-50 text-indigo-700", dot: "bg-indigo-500" },
  delivered: { label: "已送達", className: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  canceled: { label: "已取消", className: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  failed: { label: "派送失敗", className: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
};

function filterOf(status: DeliveryJobStatus): FilterKey {
  if (status === "draft" || status === "queued") return "pending";
  if (status === "new" || status === "accepted" || status === "picked_up") return "active";
  if (status === "delivered") return "done";
  return "canceled";
}

/** 日期範圍（2026-10-31）：外送 tab 預設「今日」。 */
type DateFilter = "today" | "week" | "all";

const DATE_FILTERS: Array<{ key: DateFilter; label: string }> = [
  { key: "today", label: "今日" },
  { key: "week", label: "本週" },
  // ⚠️ 唔可以叫「全部」—— 下面狀態篩選已經有一個「全部」，兩個一樣字會撞。
  { key: "all", label: "全部日期" },
];

/**
 * 呢張派單喺唔喺所選日期範圍。
 *
 * ⚠️ 用 `updatedAt` 而唔係 `createdAt`：商家喺呢頁關心「最近有咩動靜」
 *    （今朝派、下午送達嘅單，喺「今日」一定要見到）。用 createdAt 就會令
 *    「昨晚派、今朝送達」嘅單喺今日消失，睇落好似唔見咗。
 *
 * ⚠️ 時間解析失敗 → **當「喺範圍內」**。寧願多顯示一張，都唔好靜靜漏單
 *    （漏單 = 商家以為冇派，重複叫車手）。
 */
function matchesDateFilter(job: PosDeliveryJob, filter: DateFilter): boolean {
  if (filter === "all") return true;
  const at = new Date(job.updatedAt).getTime();
  if (!Number.isFinite(at)) return true;
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (filter === "week") {
    // 星期一為一週開始（澳門慣例），唔用 `getDay()` 直接減（星期日會變 -1 日）
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);
  }
  return at >= start.getTime();
}

function sourceLabel(job: PosDeliveryJob): string {
  if (job.platform === "aomi") return "澳覓";
  if (job.platform === "mfood") return "MFOOD";
  return job.orderSource === "ledger" ? "線上單" : "店內單";
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DeliveryBoard() {
  const t = useT();
  const [storeId] = useState(() => loadAuthSession()?.merchantId ?? null);
  const enabled = isDeliveryDispatchEnabled();
  const dispatch = useDeliveryDispatch(storeId);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("today");
  /** 撳卡開詳情（只讀，冇任何寫入動作）。 */
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);

  const jobs = useMemo(
    () => [...dispatch.jobsList].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [dispatch.jobsList],
  );

  /** 先按日期收窄，統計同列表都以呢個為基礎（同訂單頁一致）。 */
  const jobsInRange = useMemo(
    () => jobs.filter((job) => matchesDateFilter(job, dateFilter)),
    [jobs, dateFilter],
  );

  const counts = useMemo(() => {
    const out: Record<FilterKey, number> = {
      all: jobsInRange.length,
      pending: 0,
      active: 0,
      done: 0,
      canceled: 0,
    };
    for (const job of jobsInRange) out[filterOf(job.status)] += 1;
    return out;
  }, [jobsInRange]);

  const visible = jobsInRange.filter((job) =>
    filter === "all" ? true : filterOf(job.status) === filter,
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden md:pl-[72px]">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-slate-900">{t("外送")}</div>
              <div className="mt-0.5 text-sm text-slate-500">
                {t(DATE_FILTERS.find((item) => item.key === dateFilter)?.label ?? "今日")} ·{" "}
                {t("派單進度一覽 · 共 {n} 張", { n: counts.all })}
              </div>
            </div>
            <button
              className="inline-flex min-h-[36px] items-center rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              disabled={dispatch.loading || !storeId}
              onClick={() => void dispatch.refresh()}
              type="button"
            >
              {dispatch.loading ? t("載入中…") : t("手動刷新")}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/* 日期範圍（先揀，直接影響右邊數字） */}
            {DATE_FILTERS.map((item) => (
              <button
                key={item.key}
                className={`inline-flex min-h-[32px] items-center rounded-full px-3 py-1 text-xs font-semibold ${
                  dateFilter === item.key
                    ? "bg-orange-600 text-white"
                    : "bg-white text-slate-700 ring-1 ring-slate-200"
                }`}
                onClick={() => setDateFilter(item.key)}
                type="button"
              >
                {t(item.label)}
              </button>
            ))}

            <span aria-hidden className="mx-1 h-4 w-px bg-slate-200" />

            {FILTERS.map((item) => (
              <button
                key={item.key}
                className={`inline-flex min-h-[32px] items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${
                  filter === item.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                }`}
                onClick={() => setFilter(item.key)}
                type="button"
              >
                {t(item.label)}
                <span className={filter === item.key ? "text-white/70" : "text-slate-400"}>
                  {counts[item.key]}
                </span>
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {!enabled ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {t("外送功能未開啟：請開啟 NEXT_PUBLIC_DELIVERY_DISPATCH 後重新部署。")}
            </div>
          ) : null}

          {!storeId ? (
            <div className="mt-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
              {t("未登入或未綁定店鋪，請重新登入。")}
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
              <div className="text-sm font-semibold text-slate-700">
                {dateFilter !== "all" && jobs.length > 0 ? t("所選日期冇派單") : t("暫時冇外送派單")}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {/* 有舊單但唔喺今日 → 直接教佢揀「全部日期」，免得以為資料唔見咗 */}
                {dateFilter !== "all" && jobs.length > 0
                  ? t("試下揀「全部日期」睇返之前嘅派單。")
                  : t("喺訂單頁撳「派送」之後，張單就會出現喺呢度。")}
              </div>
            </div>
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((job) => {
                const meta = STATUS_META[job.status];
                return (
                  <article
                    key={job.id}
                    aria-label={t("查看派單詳情")}
                    className="flex cursor-pointer flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm active:bg-slate-50"
                    onClick={() => setViewingJobId(job.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setViewingJobId(job.id);
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-slate-900">
                        {job.orderNoSnapshot || job.orderRef.slice(0, 8)}
                      </span>
                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {sourceLabel(job)}
                      </span>
                      <span
                        className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.className}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        {t(meta.label)}
                      </span>
                    </div>

                    <div className="text-xs leading-relaxed text-slate-600">
                      <div className="font-semibold text-slate-800">
                        {job.customerName || t("未填收件人")} · {job.customerPhone || "--"}
                      </div>
                      <div className="line-clamp-2">{job.customerAddress || t("未填地址")}</div>
                      {job.customerNote ? (
                        <div className="mt-0.5 text-slate-400">{job.customerNote}</div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                      <span>
                        {t("車手費")}{" "}
                        <b className="tabular-nums text-slate-700">{(job.feeAmountAvos / 100).toFixed(2)}</b>
                      </span>
                      <span>
                        {job.feePaidBy === "customer" ? t("客人支付") : t("商戶支付")}
                      </span>
                      {job.codAmountAvos > 0 ? (
                        <span className="font-semibold text-amber-700">
                          {t("代收")} {(job.codAmountAvos / 100).toFixed(2)}
                        </span>
                      ) : null}
                      <span className="ml-auto tabular-nums text-slate-400">
                        {formatUpdated(job.updatedAt)}
                      </span>
                    </div>

                    {/* 未接通車手平台：草稿單唔會自己變「待接單」，要講清楚，
                        否則商家會以為已經叫咗車手喺度等。 */}
                    {job.status === "draft" ? (
                      <div className="rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800">
                        {t("已記錄派單資料；車手平台接通後會自動送出。")}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 詳情（只讀）：撳卡片開，睇時間軸／送貨資料／費用 */}
      <DeliveryJobDetailModal
        job={jobs.find((item) => item.id === viewingJobId) ?? null}
        onClose={() => setViewingJobId(null)}
      />
    </div>
  );
}
