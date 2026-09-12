"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { WorkbenchCardGroup } from "@/components/workbench-picker";

import {
  SIDEBAR_MODULES,
  WORKBENCHES,
  WORKBENCH_GROUP_LABEL,
  type MerchantModuleGrants,
  type SidebarModuleId,
  type WorkbenchId,
} from "@/lib/pos/module-catalog";
import { loadAuthSession } from "@/lib/storage";

/**
 * Admin panel · 「商戶模組授權」彈窗（migration 0037 / docs/127）。
 *
 * ## 呢個彈窗決定兩件事
 *
 * - **A. 可登入嘅工作台** → POS 登入後「選擇工作台」頁會顯示邊幾張卡。
 *   閂咗嘅會灰住 + 🔒（唔會消失，商家要睇得到「有得升級」）。
 * - **B. 側欄模組** → 入到收銀台之後，左邊側欄顯示邊幾個。閂咗嘅直接唔顯示。
 *
 * ## ⚠️ 一定要兩組一齊送
 *
 * PATCH body 一定要同時帶 `workbenches` + `sidebarModules`。Server 會用呢兩個值
 * **覆寫整行**；只送一組 = 另一組被靜靜清空（見 `/api/admin/merchants/modules`）。
 *
 * ## ⚠️「未設定」唔等於「全部閂」
 *
 * 從未設定過嘅商戶 = **全部開通**（向後兼容）。所以彈窗要明確講清楚呢件事，
 * 否則管理員見到「全部開」會以為自己之前設過。第一次按「儲存」之後，
 * 就變成「以 DB 為準」，可以由全開改成只開幾個。
 */

type DialogMerchant = { id: string; name: string };

export function AdminMerchantModulesDialog({
  merchant,
  onClose,
}: {
  merchant: DialogMerchant;
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<MerchantModuleGrants>({
    workbenches: [],
    sidebarModules: [],
  });
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const token = useCallback(() => loadAuthSession()?.adminSessionToken ?? "", []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/merchants/modules?merchantId=${encodeURIComponent(merchant.id)}`,
          { headers: { Authorization: `Bearer ${token()}` } },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          configured?: boolean;
          grants?: MerchantModuleGrants;
          error?: string;
        };
        if (!alive) return;
        if (!res.ok || !json.ok || !json.grants) {
          setError(json.error ?? `載入失敗（HTTP ${res.status}）`);
          return;
        }
        setGrants(json.grants);
        setConfigured(Boolean(json.configured));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [merchant.id, token]);

  function toggleWorkbench(id: WorkbenchId) {
    setSavedAt(null);
    setGrants((prev) => ({
      ...prev,
      workbenches: prev.workbenches.includes(id)
        ? prev.workbenches.filter((w) => w !== id)
        : [...prev.workbenches, id],
    }));
  }

  function toggleSidebar(id: SidebarModuleId) {
    setSavedAt(null);
    setGrants((prev) => ({
      ...prev,
      sidebarModules: prev.sidebarModules.includes(id)
        ? prev.sidebarModules.filter((m) => m !== id)
        : [...prev.sidebarModules, id],
    }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch("/api/admin/merchants/modules", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify({
          merchantId: merchant.id,
          // ⚠️ 兩組一齊送（見檔頂註解）。
          workbenches: grants.workbenches,
          sidebarModules: grants.sidebarModules,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `儲存失敗（HTTP ${res.status}）`);
        return;
      }
      setConfigured(true);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const counterWorkbenches = WORKBENCHES.filter((w) => w.group === "counter");
  const deviceWorkbenches = WORKBENCHES.filter((w) => w.group === "device");

  /** 預覽用：跟**未儲存**嘅開關即時變化，等管理員照住調到啱先撳儲存。 */
  const previewGrantedSet = useMemo(() => new Set<WorkbenchId>(grants.workbenches), [grants]);
  const lockedWorkbenches = useMemo(
    () => WORKBENCHES.filter((w) => !grants.workbenches.includes(w.id)),
    [grants],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/45 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 標題 */}
        <div className="flex flex-wrap items-start gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-slate-900">模組授權 · {merchant.name}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {configured
                ? "已設定過 —— 以下就係呢間店而家開通嘅模組。"
                : "未設定過 —— 目前跟預設「全部開通」。按「儲存」之後就會以此為準。"}
            </p>
          </div>
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
            onClick={onClose}
            type="button"
          >
            關閉
          </button>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-500">載入中…</p>
        ) : (
          <div className="max-h-[65vh] space-y-6 overflow-y-auto px-5 py-5">
            {error ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            {/* A. 可登入嘅工作台 */}
            <section>
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-bold text-slate-900">A. 可登入嘅工作台</h3>
                <p className="text-xs text-slate-500">
                  決定 POS 登入後「選擇工作台」頁顯示邊幾張卡。閂咗嘅會灰住 + 🔒。
                </p>
              </div>
              <div className="mt-3 space-y-4">
                {(
                  [
                    { title: WORKBENCH_GROUP_LABEL.counter, items: counterWorkbenches },
                    { title: WORKBENCH_GROUP_LABEL.device, items: deviceWorkbenches },
                  ] as const
                ).map((group) => (
                  <div key={group.title}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {group.title}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {group.items.map((w) => {
                        const on = grants.workbenches.includes(w.id);
                        return (
                          <button
                            key={w.id}
                            className={`flex min-h-[52px] items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition ${
                              on
                                ? "border-orange-300 bg-orange-50"
                                : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                            onClick={() => toggleWorkbench(w.id)}
                            type="button"
                          >
                            <Switch on={on} />
                            <span className="min-w-0">
                              <span
                                className={`block text-sm font-semibold ${
                                  on ? "text-slate-900" : "text-slate-500"
                                }`}
                              >
                                {w.label}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                                {w.homePath}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* B. 側欄模組 */}
            <section>
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-bold text-slate-900">B. 側欄模組</h3>
                <p className="text-xs text-slate-500">
                  決定入到收銀台之後，左邊側欄顯示邊幾個。閂咗嘅<b>直接唔顯示</b>（唔係灰住）——
                  側欄得 72px 闊，塞一堆撳唔到嘅灰掣只會令店員搵嘢更慢。
                </p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SIDEBAR_MODULES.map((m) => {
                  const on = grants.sidebarModules.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      className={`flex min-h-[48px] items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                        on
                          ? "border-orange-300 bg-orange-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                      onClick={() => toggleSidebar(m.id)}
                      type="button"
                    >
                      <Switch on={on} />
                      <span
                        className={`text-sm font-semibold ${on ? "text-slate-900" : "text-slate-500"}`}
                      >
                        {m.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* C. 預覽：商家實際會見到咩 */}
            <section>
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-bold text-slate-900">C. 預覽 · 商家登入後會見到咩</h3>
                <p className="text-xs text-slate-500">
                  跟上面開關<b>即時</b>變化（未儲存都會變），可以照住調到啱先撳「儲存」。
                </p>
              </div>

              {/* ⚠️ 呢個框一定要深色：工作台卡係為 POS 登入系（深色玻璃底）設計嘅，
                  擺入淺色卡片會變白底白字，完全睇唔到。 */}
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4">
                <div className="w-[780px]">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/70">
                      ② 選擇工作台
                    </span>
                    <span className="text-[11px] text-white/45">
                      商家登入之後見到嘅畫面（示意，非實尺）
                    </span>
                  </div>

                  <WorkbenchCardGroup
                    columns={2}
                    grantedSet={previewGrantedSet}
                    readOnly
                    title={WORKBENCH_GROUP_LABEL.counter}
                    workbenches={counterWorkbenches}
                  />
                  <WorkbenchCardGroup
                    columns={3}
                    grantedSet={previewGrantedSet}
                    readOnly
                    title={WORKBENCH_GROUP_LABEL.device}
                    workbenches={deviceWorkbenches}
                  />

                  {lockedWorkbenches.length > 0 ? (
                    <p className="mt-4 text-[11.5px] leading-relaxed text-white/45">
                      仲有{" "}
                      <b className="text-orange-200">{lockedWorkbenches.length} 個模組未開通</b>
                      （{lockedWorkbenches.map((w) => w.label).join("、")}）。商家會見到佢哋
                      <b className="text-white/70">灰住 + 🔒</b>，撳落去會提示聯絡管理員 —— 呢個係刻意嘅，
                      商家要睇得到「有得升級」先會問你。
                    </p>
                  ) : (
                    <p className="mt-4 text-[11.5px] text-white/45">
                      全部工作台已開通，商家會見到所有卡片都可以撳。
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}

        {/* 底部 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3.5">
          <p className="text-xs text-slate-500">
            {savedAt
              ? "已儲存。終端「下次登入」就會跟新設定（已經開住機嘅終端唔會即時變）。"
              : "改完撳「儲存」即刻生效；終端下次登入就會跟新設定。"}
          </p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-600 hover:bg-white"
              onClick={onClose}
              type="button"
            >
              取消
            </button>
            <button
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading || saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "儲存中…" : "儲存模組授權"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 純視覺開關（唔用 <input>，保持同 mockup 一致嘅 22×38 藥丸）。 */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition ${
        on ? "bg-orange-500" : "bg-slate-300"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-[2px]"
        }`}
      />
    </span>
  );
}
