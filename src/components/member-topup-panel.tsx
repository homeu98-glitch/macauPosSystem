"use client";

import { useCallback, useEffect, useState } from "react";

import { ensureLedgerSession } from "@/lib/ledger/session";
import { loadAuthSession } from "@/lib/storage";
import { refreshTopupPendingCount } from "@/lib/topup/pending-count-store";
import { useNetworkOnline } from "@/lib/use-network-online";

type EmbedState =
  | { status: "loading" }
  | { status: "ready"; embedUrl: string }
  | { status: "error"; message: string };

export function MemberTopupPanel() {
  const networkOnline = useNetworkOnline();
  const [state, setState] = useState<EmbedState>({ status: "loading" });
  const [iframeBlocked, setIframeBlocked] = useState(false);

  const loadEmbed = useCallback(async () => {
    setState({ status: "loading" });
    setIframeBlocked(false);

    const session = loadAuthSession();
    if (!session?.ledgerAccessToken) {
      setState({ status: "error", message: "請先登入 POS。" });
      return;
    }
    if (!networkOnline) {
      setState({ status: "error", message: "充值審核須連線，請恢復網絡後再試。" });
      return;
    }

    const refreshedToken = await ensureLedgerSession();
    const latestSession = loadAuthSession();
    const accessToken = refreshedToken ?? latestSession?.ledgerAccessToken ?? session.ledgerAccessToken;
    if (!accessToken) {
      setState({ status: "error", message: "Ledger 登入已過期，請重新登入 POS。" });
      return;
    }

    const staffAccount = latestSession?.account ?? session.account;

    try {
      const response = await fetch("/api/topup/owner-embed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          staffAccount,
          refreshToken: latestSession?.ledgerRefreshToken ?? session.ledgerRefreshToken,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        embedUrl?: string;
      };

      if (!response.ok || !payload.ok || !payload.embedUrl) {
        throw new Error(payload.error ?? "無法取得充值審核入口。");
      }

      setState({
        status: "ready",
        embedUrl: payload.embedUrl,
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "載入充值審核失敗。",
      });
    }
  }, [networkOnline]);

  useEffect(() => {
    void loadEmbed();
  }, [loadEmbed]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const timer = window.setInterval(() => {
      void refreshTopupPendingCount();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [state.status]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="text-sm text-slate-500">
          線上轉帳截圖審核。開啟「自動核准」後由伺服器定時執行，無須一直停留此頁。
        </div>
        {state.status === "ready" ? (
          <div className="flex flex-wrap gap-2">
            <a
              className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
              href={state.embedUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              在新分頁開啟
            </a>
            <button
              className="rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
              onClick={() => void loadEmbed()}
              type="button"
            >
              重新載入
            </button>
          </div>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 bg-slate-100 p-3 pb-20 md:pb-3">
        {state.status === "loading" ? (
          <div className="grid h-full place-items-center rounded-2xl border border-dashed border-slate-300 bg-white text-sm text-slate-500">
            正在向充值系統取得 SSO 登入連結…
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="grid h-full place-items-center rounded-2xl border border-red-200 bg-white p-6 text-center">
            <div className="text-sm font-semibold text-red-700">{state.message}</div>
            <button
              className="mt-4 rounded-2xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white"
              onClick={() => void loadEmbed()}
              type="button"
            >
              重試
            </button>
          </div>
        ) : null}

        {state.status === "ready" ? (
          <>
            {iframeBlocked ? (
              <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                嵌入顯示失敗時，請使用「在新分頁開啟」，或確認 topUp 已部署 iframe 支援。
              </div>
            ) : null}
            <iframe
              key={state.embedUrl}
              allow="fullscreen"
              className="h-full w-full rounded-2xl border border-slate-200 bg-white shadow-sm"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              src={state.embedUrl}
              title="會員充值審核"
              onError={() => setIframeBlocked(true)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
