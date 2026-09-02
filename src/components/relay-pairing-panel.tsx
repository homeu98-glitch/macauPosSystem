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
 * web 剩低嘅責任：用登入身份嘅 storeId 查 `/pair-status`，話畀用戶知配對成唔成。
 */

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "paired" }
  | { kind: "unpaired" }
  | { kind: "failed"; detail: string };

/** 未配對時嘅自動輪詢間隔（中繼機可能係 web 開咗之後先配對，唔通要人手撳）。 */
const POLL_INTERVAL_MS = 10_000;

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

  // SSR 安全：storeId 一定要 mount 後先讀 localStorage。
  useEffect(() => {
    if (nativeShell) return;
    setStoreId(resolveStoreId() ?? "");
    setStoreName(loadAuthSession()?.name ?? "");
    setPairing(getRelayPairing());
  }, [nativeShell]);

  const inFlight = useRef(false);

  const checkStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!storeId) {
        setState({
          kind: "failed",
          detail: "讀取唔到店舖識別：本機未登入 POS 帳號（自助點餐機亦未綁定店舖）。請重新登入 POS 帳號。",
        });
        return;
      }
      if (inFlight.current) return;
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

        if (!r.ok || data.error) {
          // 配對失敗（server 錯 / 未配置）→ 明確區別於「尚未配對」。
          // 背景輪詢（silent）唔報錯：開頁時網絡唔穩唔好彈紅色，等下一輪自動重試。
          if (!silent) {
            setState({
              kind: "failed",
              detail: data.error ?? `伺服器回應異常（HTTP ${r.status}），請稍後再試。`,
            });
          }
          return;
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
        } else {
          // 本地以為配對咗、但雲端話冇（例如喺第二部機解除咗）→ 清本地，避免卡住
          if (getRelayPairing()) {
            clearRelayPairing();
            setPairing(null);
          }
          setState({ kind: "unpaired" });
        }
      } catch {
        // 同上：背景輪詢嘅網絡失敗唔好彈紅色。
        if (!silent) {
          setState({ kind: "failed", detail: "網絡連線失敗，無法連到雲端檢查配對狀態。" });
        }
      } finally {
        inFlight.current = false;
        setLastCheckedAt(new Date());
      }
    },
    [storeId],
  );

  // 初次探測 + 未配對時自動輪詢（配對咗就停）。
  useEffect(() => {
    if (nativeShell) return;
    if (!storeId) return;
    if (pairing) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const before = getRelayPairing();
      await checkStatus({ silent: before === null });
      if (cancelled) return;
      // 配對成功後（localStorage 由 null 變有嘢）就唔好再 poll
      if (getRelayPairing()) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nativeShell, storeId, pairing, checkStatus]);

  async function unpair() {
    if (!pairing) return;
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
    setState({ kind: "unpaired" });
  }

  if (nativeShell) return null;

  const paired = Boolean(pairing);
  const busy = state.kind === "checking";

  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900">雲端列印中繼（relay）</div>
          <div className="mt-1 text-sm text-slate-500">
            iPad / 瀏覽器 POS 經雲端將單據轉交店內 Android 中繼機出紙（解決 HTTPS 打唔到 LAN 打印機）。
          </div>
        </div>
        <StatusBadge paired={paired} state={state} />
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
            onClick={unpair}
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
              返嚟撳下面「檢查配對狀態」。
            </li>
          </ol>
          <button
            className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
            disabled={busy || !storeId}
            onClick={() => void checkStatus()}
            type="button"
          >
            {busy ? "檢查中…" : "檢查配對狀態"}
          </button>
        </div>
      )}

      <ResultMessage state={state} paired={paired} />

      {lastCheckedAt ? (
        <div className="mt-2 text-xs text-slate-400">
          上次檢查：{lastCheckedAt.toLocaleTimeString("zh-Hant-MO", { hour12: false })}
          {paired ? null : "　·　未配對時每 10 秒自動重查"}
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
  state,
}: {
  paired: boolean;
  state: CheckState;
}): ReactElement {
  if (paired) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        已配對
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
}: {
  state: CheckState;
  paired: boolean;
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
        <div className="font-semibold">尚未配對</div>
        <div className="mt-1 font-normal">
          雲端仲未搵到呢間店嘅中繼機。請確認 Android 中繼機已用<b>同一個</b> POS
          登入號碼（8 位電話 + 4 位 PIN）登入並撳咗「配對」，然後再檢查一次。
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
