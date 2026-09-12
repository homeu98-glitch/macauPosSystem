"use client";

import { useEffect, useMemo, useState } from "react";

import { applyWorkbenchSelection } from "@/lib/pos/apply-workbench";
import {
  WORKBENCHES,
  WORKBENCH_GROUP_LABEL,
  defaultMerchantGrants,
  type WorkbenchDef,
  type WorkbenchId,
} from "@/lib/pos/module-catalog";
import {
  loadLastWorkbench,
  loadRememberWorkbenchEnabled,
  saveLastWorkbench,
  saveRememberWorkbenchEnabled,
} from "@/lib/pos/workbench-preference";
import { loadAuthSession, type AuthSession } from "@/lib/storage";

import { signOutLedgerSession } from "@/lib/ledger/session";

/**
 * 「選擇工作台」頁（2026-09-13 新增，見 migration 0037 / docs/127）。
 *
 * 登入成功之後嘅**第一個畫面**。登入頁淨係證明「你係邊個」，
 * 呢一頁先係「呢部機今次開機做邊個崗位」。
 *
 * ## 三條硬規則
 *
 * 1. **只列 Admin 已開通嘅模組可以撳**。未開通嘅**灰住 + 🔒 照樣顯示**
 *    （唔係隱藏）—— 商家要睇得到「有呢個模組但未買」，先有升級引導。
 * 2. **冇 session 即刻彈返 `/login`**。呢頁係 `/login` 嘅下一步，
 *    直接開 URL 入嚟（例如書籤）唔應該見到任何門店資料。
 * 3. **揀完一律整頁 reload**。`applyWorkbenchSelection()` 啱啱寫咗一堆
 *    本機 + 店級狀態，SPA 跳轉會殘留舊 store scope 嘅 React state。
 *
 * ## 為什麼要顯示「上次使用」
 *
 * 收銀機／後廚屏係**固定崗位**，店員每日開機都揀同一個。
 * 標咗「上次使用」就唔使每次重新諗「我部機係邊個」。
 * 開埋「記住呢部機嘅選擇」就會連呢一頁都跳過（見 `workbench-preference`）。
 */

const ACCENT_RING: Record<WorkbenchDef["accent"], string> = {
  orange: "border-orange-500/60 bg-orange-500/15",
  emerald: "border-emerald-500/55 bg-emerald-500/10",
  sky: "border-sky-500/55 bg-sky-500/10",
  rose: "border-rose-500/55 bg-rose-500/10",
};

const ACCENT_DOT: Record<WorkbenchDef["accent"], string> = {
  orange: "bg-orange-400",
  emerald: "bg-emerald-400",
  sky: "bg-sky-400",
  rose: "bg-rose-400",
};

function roleLabel(role: AuthSession["role"]): string {
  if (role === "admin") return "管理員";
  if (role === "manager") return "店長";
  return "收銀員";
}

export function SelectWorkbenchScreen() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const [busyId, setBusyId] = useState<WorkbenchId | null>(null);
  const [notice, setNotice] = useState("");
  const [remember, setRemember] = useState(true);
  const [lastWorkbench, setLastWorkbench] = useState<WorkbenchId | null>(null);

  useEffect(() => {
    const current = loadAuthSession();
    if (!current) {
      // 直接開呢條 URL（冇登入）→ 彈返登入頁。
      window.location.replace("/login");
      return;
    }
    setSession(current);
    setRemember(loadRememberWorkbenchEnabled());
    setLastWorkbench(loadLastWorkbench(current.merchantId));
    setReady(true);
  }, []);

  /**
   * ⚠️ `allowedModules` **缺失 = 全部開通**（同 server 端 `loadMerchantGrants()`
   * 同一個口徑）。呢個唔可以當成「一個都冇」，否則升級後未重新登入嘅終端
   * 會一頁空白，冇人入得返 POS。
   */
  const grants = useMemo(
    () => session?.allowedModules ?? defaultMerchantGrants(),
    [session],
  );

  const grantedSet = useMemo(() => new Set<WorkbenchId>(grants.workbenches), [grants]);
  const lockedWorkbenches = useMemo(
    () => WORKBENCHES.filter((w) => !grantedSet.has(w.id)),
    [grantedSet],
  );

  const counterWorkbenches = useMemo(() => WORKBENCHES.filter((w) => w.group === "counter"), []);
  const deviceWorkbenches = useMemo(() => WORKBENCHES.filter((w) => w.group === "device"), []);

  async function choose(workbench: WorkbenchDef) {
    if (!session || busyId) return;

    if (!grantedSet.has(workbench.id)) {
      setNotice(
        `「${workbench.label}」仲未開通。請聯絡管理員喺「後台 → 商家 → 模組授權」開通，之後重新登入就會見到。`,
      );
      return;
    }

    setNotice("");
    setBusyId(workbench.id);
    try {
      // 先記低偏好再套用：就算套用過程有嘢慢（例如寫店級掃碼模式要等 2.5s 上限），
      // 用戶撳返轉頭／重新開機都已經記得佢揀過咩。
      saveRememberWorkbenchEnabled(remember);
      saveLastWorkbench(session.merchantId, workbench.id);

      await applyWorkbenchSelection(workbench.id, session);
      window.location.replace(workbench.homePath);
    } catch (err) {
      setBusyId(null);
      setNotice(err instanceof Error ? err.message : "進入工作台失敗，請重試。");
    }
  }

  function logout() {
    void signOutLedgerSession().then(() => {
      window.location.replace("/login");
    });
  }

  if (!ready || !session) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-slate-950 text-sm text-slate-400">
        載入中…
      </div>
    );
  }

  return (
    /*
      🔴 `fixed inset-0` + `overflow-y-auto` 唔可以改成 `min-h-screen`：
      root layout 嘅 <body> 係 `h-full overflow-hidden flex flex-col`，
      用 `min-h-screen` 嘅話內容一高過視窗就會**被切走而且冇得滾**
      （呢頁有 7 張工作台卡 + 提示框 + 底部，比登入頁高好多，一定會中）。
      用 fixed 自己開一個捲動容器，就唔受祖先 overflow 影響。
    */
    <div className="fixed inset-0 overflow-y-auto login-animated-bg">
      <div className="pointer-events-none fixed inset-0">
        <div className="login-blob absolute -left-24 top-10 h-72 w-72 rounded-full bg-fuchsia-500/50" />
        <div className="login-blob absolute -right-24 top-24 h-80 w-80 rounded-full bg-cyan-400/50 [animation-delay:1.4s]" />
        <div className="login-blob absolute left-1/3 bottom-[-120px] h-96 w-96 -translate-x-1/2 rounded-full bg-amber-400/40 [animation-delay:2.6s]" />
        <div className="absolute inset-0 bg-slate-950/45" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 py-6">
        {/* 邊個登入咗 */}
        <div className="flex flex-wrap items-center gap-3 rounded-3xl border border-white/10 bg-white/10 px-4 py-3 backdrop-blur">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-orange-500/50 bg-orange-500/20 text-sm font-extrabold text-orange-100">
            {session.name.slice(0, 2)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-bold text-white">{session.name}</div>
            <div className="mt-0.5 text-xs text-white/55">
              帳號 {session.account} · {roleLabel(session.role)}
            </div>
          </div>
          <button
            className="rounded-2xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-white/15"
            onClick={logout}
            type="button"
          >
            登出
          </button>
        </div>

        {/* 標題 */}
        <div className="mt-6">
          <h1 className="text-2xl font-bold text-white">請選擇要進入嘅工作台</h1>
          <p className="mt-2 text-sm text-white/60">
            呢部裝置今次開機做邊個崗位？入到去之後，可以再喺「設置」入面切換。
          </p>
        </div>

        {notice ? (
          <div className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            {notice}
          </div>
        ) : null}

        {/* 收銀工作台 */}
        <WorkbenchGroup
          busyId={busyId}
          grantedSet={grantedSet}
          lastWorkbench={lastWorkbench}
          onChoose={choose}
          title={WORKBENCH_GROUP_LABEL.counter}
          workbenches={counterWorkbenches}
        />

        {/* 裝置角色 */}
        <WorkbenchGroup
          busyId={busyId}
          grantedSet={grantedSet}
          lastWorkbench={lastWorkbench}
          onChoose={choose}
          title={WORKBENCH_GROUP_LABEL.device}
          workbenches={deviceWorkbenches}
        />

        {/* 未開通提示 */}
        {lockedWorkbenches.length > 0 ? (
          <div className="mt-5 grid grid-cols-[34px_minmax(0,1fr)] items-start gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5">
            <div className="grid h-[34px] w-[34px] place-items-center rounded-full bg-slate-400/25 text-sm font-extrabold text-slate-200">
              ?
            </div>
            <div>
              <div className="text-sm font-bold text-white">搵唔到想用嘅模組？</div>
              <div className="mt-1 text-xs leading-relaxed text-white/55">
                呢一頁只列出<b className="text-orange-200">後台已開通</b>嘅模組。如果想用嘅模組灰住或者冇出現，
                請聯絡管理員喺「後台 → 商家 → 模組授權」開通，之後重新登入就會見到。
              </div>
            </div>
          </div>
        ) : null}

        {/* 底部：記住 + 未開通統計 */}
        <div className="mt-auto pt-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 py-4">
            <div className="min-w-0">
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm text-white/85">
                <input
                  checked={remember}
                  className="h-5 w-5 accent-orange-500"
                  onChange={(event) => setRemember(event.target.checked)}
                  type="checkbox"
                />
                記住呢部機嘅選擇（下次開機直接進入，唔使再揀）
              </label>
              {lockedWorkbenches.length > 0 ? (
                <div className="mt-2 text-xs text-white/45">
                  仲有 <b className="text-orange-200">{lockedWorkbenches.length} 個模組未開通</b>
                  （{lockedWorkbenches.map((w) => w.label).join("、")}）。如需使用，請聯絡管理員喺後台開通。
                </div>
              ) : null}
            </div>
            <button
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-white/15"
              onClick={logout}
              type="button"
            >
              以此身份登出
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkbenchGroup({
  title,
  workbenches,
  grantedSet,
  lastWorkbench,
  busyId,
  onChoose,
}: {
  title: string;
  workbenches: WorkbenchDef[];
  grantedSet: Set<WorkbenchId>;
  lastWorkbench: WorkbenchId | null;
  busyId: WorkbenchId | null;
  onChoose: (workbench: WorkbenchDef) => void;
}) {
  if (workbenches.length === 0) return null;

  const columns = workbenches.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

  return (
    <section className="mt-5">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-xs font-extrabold tracking-wide text-white/70">{title}</span>
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <div className={`grid grid-cols-1 gap-3 ${columns}`}>
        {workbenches.map((w) => {
          const granted = grantedSet.has(w.id);
          const isLast = lastWorkbench === w.id;
          const busy = busyId === w.id;

          return (
            <button
              key={w.id}
              className={`relative grid min-h-[86px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition ${
                granted
                  ? isLast
                    ? `${ACCENT_RING[w.accent]} hover:brightness-110`
                    : "border-white/15 bg-white/5 hover:border-white/25 hover:bg-white/10"
                  : "border-white/10 bg-white/[0.03]"
              } ${busy ? "opacity-60" : ""}`}
              disabled={busy}
              onClick={() => onChoose(w)}
              type="button"
            >
              {isLast && granted ? (
                <span className="absolute -top-2 right-3 rounded-full bg-orange-500 px-2.5 py-0.5 text-[10px] font-extrabold tracking-wide text-white">
                  上次使用
                </span>
              ) : null}
              {!granted ? (
                <span className="absolute -top-2 right-3 rounded-full bg-slate-700 px-2.5 py-0.5 text-[10px] font-extrabold tracking-wide text-slate-300">
                  未開通
                </span>
              ) : null}

              <span
                className={`grid h-11 w-11 place-items-center rounded-full text-sm font-bold ${
                  granted ? "bg-white/10 text-white" : "bg-white/5 text-white/40"
                }`}
              >
                {w.short}
              </span>

              <span className="min-w-0">
                <span
                  className={`block text-sm font-bold ${granted ? "text-white" : "text-white/45"}`}
                >
                  {w.label}
                </span>
                <span
                  className={`mt-1 block text-[11.5px] leading-snug ${
                    granted ? "text-white/55" : "text-white/30"
                  }`}
                >
                  {w.desc}
                </span>
              </span>

              <span
                className={`whitespace-nowrap text-[11.5px] font-bold ${
                  granted ? "text-white/45" : "text-white/25"
                }`}
              >
                {busy ? "進入中…" : granted ? "進入 →" : "🔒"}
              </span>

              {granted ? (
                <span
                  aria-hidden
                  className={`absolute right-3 top-3 h-1.5 w-1.5 rounded-full ${ACCENT_DOT[w.accent]}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
