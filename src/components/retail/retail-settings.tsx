"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadPosLocalSettings, savePosLocalSettings } from "@/lib/storage";
import type { PosLocalSettings } from "@/lib/types";
import { describeSuffix } from "@/lib/retail/scanner-profiles";
import { normalizeRetailPaymentMethods } from "@/lib/retail/split-payment";
import { ScannerWizard } from "@/components/retail/scanner-wizard";

type Toast = { tone: "ok" | "err" | "info"; text: string };

/**
 * 零售設定（`/retail/settings`）。
 *
 * 目前只收兩件事：**掃碼槍**（自動學習嚮導）同 **折扣 / 改價授權門檻**（目前只作記錄，
 * PIN 閘會喺下一輪接上，見 docs/124 §10.5）。
 *
 * 🔴 寫入一律用 `savePosLocalSettings()`（會 dispatch `pos-local-settings-changed`）
 * 並**檢查回傳值** —— 靜默失敗會出現「撳完似成功、reload 打回原形」。
 */
export function RetailSettings() {
  const [settings, setSettings] = useState<PosLocalSettings | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const reload = useCallback(() => setSettings(loadPosLocalSettings()), []);

  useEffect(() => {
    reload();
    // 掃碼槍嚮導儲存後會 dispatch 呢個 event → 重新讀，唔會顯示舊值
    const onChanged = () => reload();
    window.addEventListener("pos-local-settings-changed", onChanged);
    return () => window.removeEventListener("pos-local-settings-changed", onChanged);
  }, [reload]);

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const persist = useCallback(
    (next: PosLocalSettings, okText: string) => {
      setSettings(next);
      if (!savePosLocalSettings(next)) {
        flash("err", "寫入失敗（儲存空間不足 / 私隱模式）→ 改動可能未儲存");
        return false;
      }
      flash("ok", okText);
      return true;
    },
    [flash],
  );

  const active = useMemo(() => {
    const list = settings?.scannerProfiles ?? [];
    return list.find((p) => p.id === settings?.activeScannerProfileId) ?? list[0] ?? null;
  }, [settings]);

  const methods = useMemo(
    () => normalizeRetailPaymentMethods(settings?.retailPaymentMethods ?? settings?.paymentMethods ?? []),
    [settings],
  );

  if (!settings) {
    return <div className="p-6 text-[13px] text-slate-400">載入設定中…</div>;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="text-[15px] font-bold">零售設定</div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          掃碼槍、付款方式、折扣授權門檻
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid max-w-[820px] gap-4">
          {/* ── 掃碼槍 ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-bold">掃碼槍</h2>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  active ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
                }`}
              >
                {active ? `現用：${active.name}` : "未設定（用預設）"}
              </span>
              <button
                className="ml-auto min-h-[40px] rounded-xl bg-orange-600 px-4 text-[12.5px] font-semibold text-white hover:bg-orange-700"
                onClick={() => setWizardOpen(true)}
                type="button"
              >
                {active ? "重新學習 / 換設定" : "開始自動學習"}
              </button>
            </div>

            {active ? (
              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[12px] md:grid-cols-5">
                <Spec label="前綴" value={active.prefix || "（無）"} />
                <Spec label="結尾" value={describeSuffix(active.suffix)} />
                <Spec label="超時" value={`${active.timeoutMs}ms`} />
                <Spec
                  label="長度"
                  value={active.minLength || active.maxLength ? `${active.minLength ?? "?"}–${active.maxLength ?? "?"}` : "不限"}
                />
                <Spec label="字元集" value={active.charset === "alnum" ? "字母數字" : "純數字"} />
              </dl>
            ) : (
              <p className="mt-2 text-[12px] text-slate-500">
                未設定 → 系統用安全預設（Enter 結尾、50ms 超時）。建議做一次自動學習，
                否則某些型號嘅前綴會被當成條碼一部分。
              </p>
            )}

            {(settings.scannerProfiles ?? []).length > 1 ? (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <div className="text-[11.5px] font-semibold text-slate-600">已儲存嘅設定檔</div>
                <div className="mt-2 grid gap-1.5">
                  {(settings.scannerProfiles ?? []).map((p) => (
                    <div
                      key={p.id}
                      className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 ${
                        p.id === settings.activeScannerProfileId
                          ? "border-orange-300 bg-orange-50"
                          : "border-slate-200"
                      }`}
                    >
                      <span className="min-w-0 flex-1 text-[12.5px] font-semibold">{p.name}</span>
                      <span className="text-[11px] text-slate-500">
                        {describeSuffix(p.suffix)} · {p.timeoutMs}ms
                      </span>
                      {p.id === settings.activeScannerProfileId ? (
                        <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                          使用中
                        </span>
                      ) : (
                        <button
                          className="min-h-[36px] rounded-lg bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 hover:bg-slate-200"
                          onClick={() =>
                            persist(
                              { ...settings, activeScannerProfileId: p.id },
                              `已切換至「${p.name}」`,
                            )
                          }
                          type="button"
                        >
                          改用
                        </button>
                      )}
                      {(settings.scannerProfiles ?? []).length > 1 ? (
                        <button
                          className="min-h-[36px] rounded-lg bg-rose-50 px-3 text-[11px] font-semibold text-rose-700 hover:bg-rose-100"
                          onClick={() => {
                            if (!window.confirm(`刪除設定檔「${p.name}」？`)) return;
                            const rest = (settings.scannerProfiles ?? []).filter((x) => x.id !== p.id);
                            persist(
                              {
                                ...settings,
                                scannerProfiles: rest,
                                activeScannerProfileId:
                                  settings.activeScannerProfileId === p.id
                                    ? (rest[0]?.id ?? "")
                                    : settings.activeScannerProfileId,
                              },
                              "已刪除",
                            );
                          }}
                          type="button"
                        >
                          刪除
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {/* ── 付款方式（讀取，唯讀提示） ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-[14px] font-bold">付款方式</h2>
            {methods.length === 0 ? (
              <p className="mt-2 rounded-xl bg-amber-50 p-3 text-[12px] font-semibold text-amber-800">
                未設定 → 收銀台結帳會冇付款方式可揀。去「設備設置 → 付款方式」加入。
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {methods.map((m) => (
                  <span
                    key={m.id}
                    className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                  >
                    {m.label}
                    <span className="ml-1 font-normal text-slate-400">{kindLabel(m.kind)}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* ── 折扣 / 改價授權（記錄，PIN 閘下一輪） ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="text-[14px] font-bold">折扣 / 改價授權門檻</h2>
            <p className="mt-1 text-[11.5px] text-slate-500">
              低於此折扣（或單行減價超過上限）需要授權。
              <span className="text-amber-700">目前只作提示，PIN 閘會喺下一輪接上。</span>
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[11.5px] font-semibold text-slate-600">最低折扣（折）</span>
                <input
                  className="min-h-[40px] w-full rounded-lg border border-slate-300 px-2.5 text-[13px] outline-none focus:border-orange-400"
                  inputMode="numeric"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setSettings({
                      ...settings,
                      retailApprovalRules: { ...settings.retailApprovalRules, minDiscountRate: n },
                    });
                  }}
                  onBlur={() => persist(settings, "已儲存授權門檻")}
                  value={settings.retailApprovalRules.minDiscountRate}
                />
                <span className="text-[10.5px] text-slate-400">例如 90 = 9 折以下要授權</span>
              </label>
              <label className="grid gap-1">
                <span className="text-[11.5px] font-semibold text-slate-600">單行最多減價（MOP）</span>
                <input
                  className="min-h-[40px] w-full rounded-lg border border-slate-300 px-2.5 text-[13px] outline-none focus:border-orange-400"
                  inputMode="decimal"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setSettings({
                      ...settings,
                      retailApprovalRules: { ...settings.retailApprovalRules, maxLineSaving: n },
                    });
                  }}
                  onBlur={() => persist(settings, "已儲存授權門檻")}
                  value={settings.retailApprovalRules.maxLineSaving}
                />
              </label>
            </div>
          </section>
        </div>
      </div>

      {wizardOpen ? (
        <ScannerWizard
          onClose={() => {
            setWizardOpen(false);
            reload();
          }}
        />
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 md:bottom-8">
          <div
            className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${
              toast.tone === "ok" ? "bg-emerald-600" : toast.tone === "err" ? "bg-rose-600" : "bg-slate-800"
            }`}
          >
            {toast.text}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "cash":
      return "現金";
    case "card":
      return "卡";
    case "ewallet":
      return "電子錢包";
    case "voucher":
      return "券";
    case "member_balance":
      return "會員餘額";
    default:
      return "其他";
  }
}
