"use client";

import { useT } from "@/components/lang-provider";
import { ResponsiveModal } from "@/components/responsive-modal";
import type { DeliveryJobStatus, PosDeliveryJob } from "@/lib/pos/delivery/types";

/**
 * 派單詳情（2026-10-31）—— 外送 tab 撳卡片開。
 *
 * ## 呢個彈窗只讀，唔會改任何東西
 *
 * 派單進度完全由車手平台回寫；POS 側唯一會做嘅動作係「派送」（喺訂單頁），
 * 所以詳情彈窗冇「催單／取消／完成」掣 —— 呢啲要 Ledger v3.6 開放對應 endpoint
 * 才加得，否則就係一個撳落去冇反應嘅假掣。
 *
 * ## 時間軸只有三個真實時間
 *
 * DB 只有 `created_at` / `updated_at` / `delivered_at`。中間步驟（已送出、車手接單、
 * 已取貨）**冇獨立時間戳**，所以時間軸只標「已完成／進行中」，時間一律顯示
 * 有證據嘅嗰個（建立＝created_at、送達＝delivered_at、進行中＝updated_at）。
 * ⚠️ 唔可以「估」一個時間顯示出嚟 —— 商家會攞住個時間同車手對數。
 */

const STEPS = [
  { key: "created", label: "已建立" },
  { key: "queued", label: "已送出" },
  { key: "accepted", label: "車手接單" },
  { key: "picked_up", label: "已取貨" },
  { key: "delivered", label: "已送達" },
] as const;

/** 狀態 → 時間軸進度（-1 = 已取消／失敗，唔屬於正常流程）。 */
const PROGRESS: Record<DeliveryJobStatus, number> = {
  draft: 0,
  queued: 1,
  new: 1,
  accepted: 2,
  picked_up: 3,
  delivered: 4,
  canceled: -1,
  failed: -1,
};

function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 呢個步驟有冇真實時間可以顯示。 */
function stepTime(job: PosDeliveryJob, index: number, progress: number): string {
  if (index === 0) return formatDateTime(job.createdAt);
  if (index === 4) return job.deliveredAt ? formatDateTime(job.deliveredAt) : "";
  if (index === progress) return formatDateTime(job.updatedAt);
  return "";
}

export function DeliveryJobDetailModal({
  job,
  onClose,
}: {
  job: PosDeliveryJob | null;
  onClose: () => void;
}) {
  const t = useT();
  if (!job) return null;

  const progress = PROGRESS[job.status];
  const closed = progress === -1;
  const currentStep = STEPS[Math.min(Math.max(progress, 0), STEPS.length - 1)];

  return (
    <ResponsiveModal
      onClose={onClose}
      widthClassName="max-w-xl"
      header={
        <div className="flex flex-wrap items-center gap-2 pr-2">
          <h3 className="text-base font-bold text-slate-900">
            {job.orderNoSnapshot || job.orderRef.slice(0, 8)}
          </h3>
          <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
            {job.orderSource === "ledger" ? t("線上單") : t("店內單")}
          </span>
          {closed ? (
            <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">
              {job.status === "failed" ? t("派送失敗") : t("已取消")}
            </span>
          ) : (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
              {t("目前狀態")}：{t(currentStep.label)}
            </span>
          )}
        </div>
      }
      actions={
        <button
          className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"
          onClick={onClose}
          type="button"
        >
          {t("關閉")}
        </button>
      }
    >
      <div className="space-y-3">
        {/* ── 時間軸 ── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
            {t("派送進度")}
          </div>
          <ol className="space-y-2">
            {STEPS.map((step, index) => {
              // 已取消／失敗：只將「已建立」同「已送出」當完成，其餘留白
              const done = closed
                ? index <= 1
                : index < progress || (index === progress && job.status === "delivered");
              const now = !closed && index === progress && job.status !== "delivered";
              const time = stepTime(job, index, closed ? 1 : progress);
              return (
                <li key={step.key} className="flex items-start gap-2.5">
                  <span
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${
                      done ? "bg-emerald-600" : now ? "bg-orange-500" : "bg-slate-200"
                    }`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-sm font-semibold ${
                          done || now ? "text-slate-900" : "text-slate-400"
                        }`}
                      >
                        {t(step.label)}
                      </span>
                      {time ? (
                        <span className="tabular-nums text-[11px] text-slate-400">{time}</span>
                      ) : null}
                    </div>
                    {now && job.status === "draft" ? (
                      <div className="mt-0.5 text-[11px] text-amber-700">
                        {t("已記錄派單資料，未送出（車手平台未接通）")}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {closed ? (
            <div className="mt-2 rounded-xl bg-rose-50 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700">
              {t("呢張派單已經結束，可以喺訂單頁重新派送。")}
            </div>
          ) : null}
        </section>

        {/* ── 送貨資料 ── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
            {t("送貨資料")}
          </div>
          <div className="space-y-1 text-sm text-slate-700">
            <div>
              {job.customerName || t("未填收件人")} ·{" "}
              <span className="tabular-nums">{job.customerPhone || "--"}</span>
            </div>
            <div className="text-slate-600">{job.customerAddress || t("未填地址")}</div>
            {job.customerNote ? (
              <div className="text-xs text-slate-400">{job.customerNote}</div>
            ) : null}
            {job.customerLat !== undefined && job.customerLng !== undefined ? (
              <div className="tabular-nums text-[11px] text-slate-400">
                {job.customerLat}, {job.customerLng}
              </div>
            ) : null}
          </div>
        </section>

        {/* ── 費用 ── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
            {t("費用")}
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-600">{t("車手費")}</span>
              <span className="tabular-nums font-semibold text-slate-900">
                {(job.feeAmountAvos / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">{t("邊個付車手費")}</span>
              <span className="text-slate-900">
                {job.feePaidBy === "customer" ? t("客人支付") : t("商戶支付")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600">{t("代收貨款")}</span>
              <span className="tabular-nums font-semibold text-amber-700">
                {(job.codAmountAvos / 100).toFixed(2)}
              </span>
            </div>
          </div>
        </section>
      </div>
    </ResponsiveModal>
  );
}
