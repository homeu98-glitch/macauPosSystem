"use client";

import { useEffect, useState } from "react";

import { loadAuthSession, loadBootstrapCache } from "@/lib/storage";
import { isRunningInNativeShell } from "@/components/pwa-install-button";
import {
  clearRelayPairing,
  getRelayPairing,
  setRelayPaired,
} from "@/lib/print-bridge/relay-config";

/**
 * 雲端中繼配對 UI（docs/96 §8「Android 自註冊」）。
 *
 * 流程：喺 Android 中繼機嘅「雲端列印中繼」畫面輸入本店店舖 ID 並撳「配對」
 * → APK 自行 POST /pair 註冊雲端 → web 呢度撳「檢查配對狀態」查 /pair-status
 * → 拎到 agentId 就寫落 localStorage，令 isRelayConfigured() 變 true、dispatch 通道③啟用。
 *
 * web 唔使掃 QR、唔使攞 token（token 只存 hash，relay 出單用唔着），零新依賴。
 */
export function RelayPairingPanel() {
  const storeId =
    (typeof window !== "undefined"
      ? loadAuthSession()?.merchantId ?? loadBootstrapCache()?.storeId ?? ""
      : "") ?? "";

  const [pairing, setPairing] = useState(() => getRelayPairing());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // 原生殼（Android APK WebView / PC Companion）入面唔使、亦唔應該顯示雲端中繼配對 UI：
  // 呢啲環境本身就係打印終端（PosNative bridge / CompanionShell），relay 係畀純 website / PWA
  // 嘅 iPad、PC browser 用。喺原生殼入面隱藏，亦順便慳咗一次無謂嘅 /pair-status 探測。
  const [nativeShell] = useState(() => isRunningInNativeShell());

  // 自動探測：localStorage 冇配對，但雲端可能已經配對（例如 APK 早啲 self-register 過、
  // 或者 web 清過 cache）。避免每次都要人手撳「檢查」。
  useEffect(() => {
    if (pairing || !storeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/pos/print-agent/pair-status?storeId=${encodeURIComponent(storeId)}`,
        );
        const data = (await r.json()) as {
          paired?: boolean;
          agentId?: string;
          storeId?: string;
          storeName?: string | null;
        };
        if (!cancelled && data.paired && data.agentId) {
          setRelayPaired({
            agentId: data.agentId,
            token: "",
            storeId: data.storeId ?? storeId,
            storeName: data.storeName ?? null,
          });
          setPairing(getRelayPairing());
        }
      } catch {
        /* 離線／雲端未配置：忽略，等用家撳「檢查」 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, pairing]);

  async function checkStatus() {
    if (!storeId) {
      setMsg({ tone: "err", text: "讀取唔到店舖 ID，請先登入 POS。" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(
        `/api/pos/print-agent/pair-status?storeId=${encodeURIComponent(storeId)}`,
      );
      const data = (await r.json()) as {
        paired?: boolean;
        agentId?: string;
        storeId?: string;
        storeName?: string | null;
      };
      if (data.paired && data.agentId) {
        setRelayPaired({
          agentId: data.agentId,
          token: "",
          storeId: data.storeId ?? storeId,
          storeName: data.storeName ?? null,
        });
        setPairing(getRelayPairing());
        setMsg({ tone: "ok", text: "已連線雲端中繼，列印單據會經此出紙。" });
      } else {
        setMsg({
          tone: "err",
          text: "尚未配對：請先喺 Android 中繼機輸入店舖 ID 並撳「配對」，然後再撳此掣。",
        });
      }
    } catch {
      setMsg({ tone: "err", text: "檢查失敗，請檢查網絡。" });
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    if (!pairing) return;
    setBusy(true);
    setMsg(null);
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
    setBusy(false);
    setMsg({ tone: "ok", text: "已解除雲端中繼配對。" });
  }

  if (nativeShell) return null;

  return (
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-slate-900">雲端列印中繼（relay）</div>
          <div className="mt-1 text-sm text-slate-500">
            iPad / 瀏覽器 POS 經雲端將單據轉交店內 Android 中繼機出紙（解決 HTTPS 打唔到 LAN 打印機）。
          </div>
        </div>
        {pairing ? (
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            已連線
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            未配對
          </span>
        )}
      </div>

      {pairing ? (
        <div className="mt-4 grid gap-3">
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
            店舖：{pairing.storeName ?? pairing.storeId}
          </div>
          <button
            className="rounded-2xl bg-red-100 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-200 disabled:opacity-60"
            disabled={busy}
            onClick={unpair}
            type="button"
          >
            解除配對
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm font-semibold text-slate-700">
            <span className="text-xs text-slate-500">本店店舖 ID（輸入 Android 中繼機用）</span>
            <input
              className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
              readOnly
              value={storeId}
            />
          </label>
          <div className="text-xs leading-relaxed text-slate-500">
            喺 Android 中繼機嘅「雲端列印中繼」畫面，輸入以上店舖 ID 並撳「配對」，然後撳下面「檢查配對狀態」。
          </div>
          <button
            className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={checkStatus}
            type="button"
          >
            {busy ? "檢查中…" : "檢查配對狀態"}
          </button>
        </div>
      )}

      {msg ? (
        <div
          className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${
            msg.tone === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {msg.text}
        </div>
      ) : null}
    </section>
  );
}
