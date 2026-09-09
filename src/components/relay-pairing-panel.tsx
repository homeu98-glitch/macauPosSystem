"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { isRunningInNativeShell } from "@/components/pwa-install-button";
import { loadAuthSession } from "@/lib/storage";
import { resolveStoreId } from "@/lib/pos/sync-flush";
import {
  clearRelayPairing,
  getRelayPairing,
  setRelayPaired,
} from "@/lib/print-bridge/relay-config";

/**
 * 雲端中繼配對 UI（docs/96 §8「Android 自註冊」）。
 *
 * ## 配對點解唔使輸入任何嘢
 * 用戶喺 Android 中繼機（Print Hub）用 **同一個 POS 登入號碼（8 位電話 + 4 位 PIN）**
 * 打 `/api/ledger/login`，拎到嘅 `merchantId` 就係 storeId；web 呢邊登入後都係同一個
 * `merchantId`。即係 **storeId 由登入身份隱含推導**，用戶根本冇嘢要輸入。
 *
 * 所以舊版「本店店舖 ID（輸入 Android 中繼機用）」嗰個欄已經移除 —— 佢唔單止多餘，
 * 仲危險：用戶見到 `macau-store-a` 以為係真 ID，照抄去中繼機就會中
 * 「配咗對但一張都印唔出」嘅 silent failure（見 resolveStoreId() 註解）。
 *
 * ## 自動配對狀態機（2026-09-09）
 * web 端冇得自己 POST /pair（配對動作喺中繼機做），所謂「自動配對」= 未配對時自動
 * 每 5 秒打一次 /pair-status 偵測，中繼機現身（配對成功）即停。三個狀態：
 *
 * - **自動配對中（mode="auto"）**：未配對 + 未被手動停止 → 每 5s 偵測一次，成功即停；
 * - **已配對**：localStorage 有 pairing → 循環停止，只顯示「解除配對」；
 * - **已解除配對（mode="idle"）**：手動解除配對（或手動停止）後 → **完全停止**自動循環，
 *   就算 re-render / effect 重跑 / reload 都唔會復活（旗標落 localStorage）；
 *   只有商家再手動撳「配對」先會重啟 5s 循環。
 *
 * 關鍵防護：解除配對會 `generationRef` +1，任何 in-flight 嘅 /pair-status 回應
 * （喺解除前發出、解除後先返嚟）一律作廢 —— 唔會將啱啱清走嘅配對「復活」。
 */

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "paired" }
  | { kind: "unpaired" }
  | { kind: "failed"; detail: string };

/** 自動配對循環：未配對時每 5 秒偵測一次，直到配對成功。 */
const AUTO_PAIR_INTERVAL_MS = 5_000;

/** 手動「解除配對」／「停止自動配對」後記低：唔好再自動重新配對（reload 頁面都唔會復活）。 */
const AUTO_PAIR_STOPPED_KEY = "macau-pos-relay-auto-pair-stopped";

function isAutoPairStopped(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_PAIR_STOPPED_KEY) === "1";
}

function setAutoPairStopped(stopped: boolean): void {
  if (typeof window === "undefined") return;
  if (stopped) {
    window.localStorage.setItem(AUTO_PAIR_STOPPED_KEY, "1");
  } else {
    window.localStorage.removeItem(AUTO_PAIR_STOPPED_KEY);
  }
}

export function RelayPairingPanel() {
  // 原生殼（Android APK WebView / PC Companion）入面唔使、亦唔應該顯示雲端中繼配對 UI：
  // 呢啲環境本身就係打印終端（PosNative bridge / CompanionShell），relay 係畀純 website / PWA
  // 嘅 iPad、PC browser 用。喺原生殼入面隱藏，亦順便慳咗無謂嘅 /pair-status 探測。
  const [nativeShell] = useState(() => isRunningInNativeShell());

  const [storeId, setStoreId] = useState<string>("");
  // 店名由 auth session 直接攞（即 merchants.name，login 時 server 落）。
  // 唔使查 DB：pos_print_agents 冇 store_name 欄（0020 只喺 pos_print_jobs 加咗）。
  const [storeName, setStoreName] = useState<string>("");
  const [pairing, setPairing] = useState(() => getRelayPairing());
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  // 自動配對循環開關：auto = 未配對時每 5s 偵測；idle = 完全停止（解除配對/手動停止後）。
  const [mode, setMode] = useState<"auto" | "idle">("idle");
  // 徽章用：係咪因為手動解除配對先至未配對（影響「已解除配對」vs「尚未配對」文案）。
  const [manualUnpaired, setManualUnpaired] = useState(false);

  // SSR 安全：storeId 一定要 mount 後先讀 localStorage。
  useEffect(() => {
    if (nativeShell) return;
    setStoreId(resolveStoreId() ?? "");
    setStoreName(loadAuthSession()?.name ?? "");
    const existing = getRelayPairing();
    setPairing(existing);
    if (!existing) {
      // 尚未配對 → 自動進入配對模式；但之前手動解除/停止過（旗標喺 localStorage）就唔好自作主張。
      const stopped = isAutoPairStopped();
      setMode(stopped ? "idle" : "auto");
    }
  }, [nativeShell]);

  // 併發防護：
  // - inFlight：同一時間只准一個 /pair-status 請求（輪詢 + 手動「立即檢查」撞正都唔會重複）。
  // - generationRef：每次解除配對 +1；checkStatus 開始時記低自己嗰代，回應返嚟時代數對唔上
  //   （而且期間發生過解除配對）→ 成個回應作廢，唔好覆蓋解除配對後嘅狀態。
  const inFlight = useRef(false);
  const generationRef = useRef(0);
  const unpairGenRef = useRef(-1);
  // mode 嘅鏡像 ref：循環 tick 係 async，要喺 await 後即刻知 mode 有冇變（state 更新要等
  // re-render，ref 經下面 sync effect 同步，足夠快過 5s timer）。
  const modeRef = useRef<"auto" | "idle">("idle");
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  /**
   * 查一次配對狀態。**回傳值 = 呢次探測係咪成功**（true=拎到明確結果，false=server 錯/網絡錯）。
   * 自動配對循環靠佢判斷：server/網絡錯誤都唔會斷循環，下一輪 5s 後自動重試。
   */
  const checkStatus = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      const silent = opts?.silent ?? false;
      const gen = generationRef.current;
      if (!storeId) {
        setState({
          kind: "failed",
          detail: "讀取唔到店舖識別：本機未登入 POS 帳號（自助點餐機亦未綁定店舖）。請重新登入 POS 帳號。",
        });
        return false;
      }
      if (inFlight.current) return false;
      inFlight.current = true;
      if (!silent) setState({ kind: "checking" });

      try {
        const r = await fetch(
          `/api/pos/print-agent/pair-status?storeId=${encodeURIComponent(storeId)}`,
        );
        const data = (await r.json().catch(() => ({}))) as {
          paired?: boolean;
          agentId?: string;
          storeId?: string;
          storeName?: string | null;
          error?: string;
        };

        // 呢個請求發出之後發生過「解除配對」→ 回應已過期，一律作廢：
        // 唔好 setRelayPaired（會復活啱啱清走嘅配對）、亦唔好改 state。
        if (gen !== generationRef.current && unpairGenRef.current === gen) {
          return false;
        }

        if (!r.ok || data.error) {
          // 配對失敗（server 錯 / 未配置）→ 明確區別於「尚未配對」。
          // 背景輪詢（silent）唔報錯：開頁時網絡唔穩唔好彈紅色，等下一輪自動重試。
          if (!silent) {
            setState({
              kind: "failed",
              detail: data.error ?? `伺服器回應異常（HTTP ${r.status}），請稍後再試。`,
            });
          }
          return false;
        }

        if (data.paired && data.agentId) {
          setRelayPaired({
            agentId: data.agentId,
            token: "",
            storeId: data.storeId ?? storeId,
            storeName: data.storeName ?? null,
          });
          setPairing(getRelayPairing());
          setState({ kind: "paired" });
          setManualUnpaired(false);
          setAutoPairStopped(false);
          return true;
        }
        // 本地以為配對咗、但雲端話冇（例如喺第二部機解除咗）→ 清本地，避免卡住
        if (getRelayPairing()) {
          clearRelayPairing();
          setPairing(null);
        }
        setState({ kind: "unpaired" });
        return true;
      } catch {
        // 同上：背景輪詢嘅網絡失敗唔好彈紅色。
        if (!silent) {
          setState({ kind: "failed", detail: "網絡連線失敗，無法連到雲端檢查配對狀態。" });
        }
        return false;
      } finally {
        inFlight.current = false;
        setLastCheckedAt(new Date());
      }
    },
    [storeId],
  );

  // 自動配對循環：mode="auto" 且未配對時，每 5s 偵測一次；配對成功／mode 變 idle 即停。
  // mode / pairing 變化都會重置循環（解除配對 → pairing=null + mode=idle → effect 清理，唔會再排下一輪）。
  useEffect(() => {
    if (nativeShell) return;
    if (!storeId) return;
    if (pairing) return;
    if (mode !== "auto") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const before = getRelayPairing();
      const ok = await checkStatus({ silent: before === null });
      if (cancelled) return;
      // 偵測期間被解除配對／手動停止 → modeRef 已變 idle，即刻收手，唔好排下一輪。
      if (modeRef.current !== "auto") return;
      // 配對成功（localStorage 由 null 變有嘢）→ 停止重試循環。
      if (getRelayPairing()) return;
      // ok=false（server 錯/網絡錯）都照 5s 重試：自動配對要撐到中繼機現身為止。
      void ok;
      timer = setTimeout(tick, AUTO_PAIR_INTERVAL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nativeShell, storeId, pairing, mode, checkStatus]);

  /** 商家手動撳「配對」：清除停止旗標，重啟每 5s 一次嘅自動配對循環。 */
  function startAutoPairing() {
    setAutoPairStopped(false);
    setManualUnpaired(false);
    setMode("auto");
    generationRef.current += 1; // 作廢舊 in-flight 偵測，避免舊回應搶住改狀態
    setState({ kind: "idle" });
  }

  /** 商家手動停止自動配對（未解除雲端 agent，但本地唔再自動偵測）。 */
  function stopAutoPairing() {
    setMode("idle");
    setAutoPairStopped(true);
    generationRef.current += 1;
    setState({ kind: "idle" });
  }

  async function unpair() {
    if (!pairing) return;
    // 先作廢所有 in-flight 偵測（gen +1），確保解除配對唔會被背景回應覆蓋／復活。
    const gen = generationRef.current + 1;
    generationRef.current = gen;
    unpairGenRef.current = gen;
    setState({ kind: "checking" });
    try {
      await fetch("/api/pos/print-agent/unpair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: pairing.agentId, storeId: pairing.storeId }),
      });
    } catch {
      /* 雲端 revoke 失敗都照清本地，避免卡死 */
    }
    clearRelayPairing();
    setPairing(null);
    // 解除配對 → 完全停止自動配對：旗標落 localStorage，reload 都唔會自動重新配對；
    // 只有商家再手動撳「配對」（startAutoPairing）先會重啟循環。
    setMode("idle");
    setAutoPairStopped(true);
    setManualUnpaired(true);
    setState({ kind: "unpaired" });
  }

  if (nativeShell) return null;

  const paired = Boolean(pairing);
  const busy = state.kind === "checking";
  const autoPairing = mode === "auto" && !paired;

  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900">雲端列印中繼（relay）</div>
          <div className="mt-1 text-sm text-slate-500">
            iPad / 瀏覽器 POS 經雲端將單據轉交店內 Android 中繼機出紙（解決 HTTPS 打唔到 LAN 打印機）。
          </div>
        </div>
        <StatusBadge paired={paired} autoPairing={autoPairing} manualUnpaired={manualUnpaired} state={state} />
      </div>

      {!storeId ? (
        <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          未登入 POS 帳號，讀取唔到店舖識別。請先登入，雲端中繼要先知道係邊間店先配到對。
        </div>
      ) : null}

      {paired && pairing ? (
        <div className="mt-4 grid gap-3">
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            已連線：{storeName || pairing.storeName || pairing.storeId}
            <div className="mt-1 text-xs font-normal text-emerald-700">
              列印單據會經雲端中繼送到店內 Android 中繼機出紙。
            </div>
          </div>
          <button
            className="rounded-2xl bg-red-100 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-200 disabled:opacity-60"
            disabled={busy}
            onClick={() => void unpair()}
            type="button"
          >
            {busy ? "處理中…" : "解除配對"}
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          <ol className="grid gap-1.5 text-sm leading-relaxed text-slate-600">
            <li>
              <span className="font-semibold text-slate-800">1.</span>{" "}
              喺店內 Android 中繼機開「Macau Print Hub」。
            </li>
            <li>
              <span className="font-semibold text-slate-800">2.</span>{" "}
              用你嘅 POS 登入號碼（8 位電話 + 4 位 PIN）登入並撳「配對」。
            </li>
            <li>
              <span className="font-semibold text-slate-800">3.</span>{" "}
              唔使做任何嘢——呢邊會自動配對，中繼機現身即自動接上。
            </li>
          </ol>
          {autoPairing ? (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="font-semibold">自動配對中…</div>
              <div className="mt-1 font-normal">
                每 5 秒自動檢查一次，直到配對成功為止；成功後會即時停止重試。
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
              <div className="font-semibold">{manualUnpaired ? "已解除配對" : "自動配對已停止"}</div>
              <div className="mt-1 font-normal">
                唔會自動重新配對；按下面「配對」先會重新開始自動配對。
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {autoPairing ? (
              <button
                className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-60"
                disabled={busy}
                onClick={stopAutoPairing}
                type="button"
              >
                停止自動配對
              </button>
            ) : (
              <button
                className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
                disabled={busy || !storeId}
                onClick={startAutoPairing}
                type="button"
              >
                配對
              </button>
            )}
            <button
              className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 disabled:opacity-60"
              disabled={busy || !storeId}
              onClick={() => void checkStatus()}
              type="button"
            >
              {busy ? "檢查中…" : "立即檢查"}
            </button>
          </div>
        </div>
      )}

      <ResultMessage state={state} paired={paired} autoPairing={autoPairing} />

      {lastCheckedAt ? (
        <div className="mt-2 text-xs text-slate-400">
          上次檢查：{lastCheckedAt.toLocaleTimeString("zh-Hant-MO", { hour12: false })}
          {paired
            ? null
            : autoPairing
              ? "　·　自動配對中：每 5 秒重試一次"
              : "　·　自動配對已停止"}
        </div>
      ) : null}

      {/* Debug 細字：對唔到 storeId 時一眼睇得出（預設摺埋，唔騷擾用戶） */}
      <details className="mt-3 text-xs text-slate-400">
        <summary className="cursor-pointer select-none">技術資料（店舖識別）</summary>
        <div className="mt-2 grid gap-1 break-all">
          <div>
            storeId（本機用緊）：
            <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              {storeId || "（無）"}
            </code>
          </div>
          <div>
            中繼機 ID：<code className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">
              {pairing?.agentId ?? "（未配對）"}
            </code>
          </div>
        </div>
      </details>
    </section>
  );
}

function StatusBadge({
  paired,
  autoPairing,
  manualUnpaired,
  state,
}: {
  paired: boolean;
  autoPairing: boolean;
  manualUnpaired: boolean;
  state: CheckState;
}): ReactElement {
  if (paired) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        已配對
      </span>
    );
  }
  if (autoPairing) {
    return (
      <span className="shrink-0 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
        自動配對中…
      </span>
    );
  }
  if (manualUnpaired) {
    return (
      <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
        已解除配對
      </span>
    );
  }
  if (state.kind === "failed") {
    return (
      <span className="shrink-0 rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-700">
        配對失敗
      </span>
    );
  }
  if (state.kind === "checking") {
    return (
      <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
        檢查中…
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
      尚未配對
    </span>
  );
}

function ResultMessage({
  state,
  paired,
  autoPairing,
}: {
  state: CheckState;
  paired: boolean;
  autoPairing: boolean;
}): ReactElement | null {
  if (state.kind === "paired") {
    return (
      <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
        配對成功，雲端中繼已連線。
      </div>
    );
  }
  if (state.kind === "unpaired") {
    return (
      <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <div className="font-semibold">{autoPairing ? "自動配對中" : "尚未配對"}</div>
        <div className="mt-1 font-normal">
          雲端仲未搵到呢間店嘅中繼機。請確認 Android 中繼機已用<b>同一個</b> POS
          登入號碼（8 位電話 + 4 位 PIN）登入並撳咗「配對」
          {autoPairing ? "；偵測到配對成功後會自動接上，唔使手動重試。" : "，再撳「配對」重新開始。"}
        </div>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
        <div className="font-semibold">配對失敗</div>
        <div className="mt-1 whitespace-pre-wrap break-words font-normal">{state.detail}</div>
      </div>
    );
  }
  if (paired) return null;
  return null;
}
