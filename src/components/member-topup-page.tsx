"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { ensureLedgerSession } from "@/lib/ledger/session";
import { loadAuthSession } from "@/lib/storage";
import { useNetworkOnline } from "@/lib/use-network-online";

type EmbedState =
  | { status: "loading" }
  | {
      status: "ready";
      embedUrl: string;
      shopName: string;
      shopId: string;
      staffAccount: string;
    }
  | { status: "error"; message: string };

function buildTopupEntryUrl(embedUrl: string, returnUrl: string): string {
  const url = new URL(embedUrl);
  url.searchParams.set("siteAReturnUrl", returnUrl);
  return url.toString();
}

export function MemberTopupPage() {
  const searchParams = useSearchParams();
  const returnedFromTopup = searchParams.get("returned") === "1";
  const networkOnline = useNetworkOnline();
  const [state, setState] = useState<EmbedState>({ status: "loading" });
  const [redirecting, setRedirecting] = useState(false);

  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return "/topup?returned=1";
    return `${window.location.origin}/topup?returned=1`;
  }, []);

  const loadEmbed = useCallback(async () => {
    setState({ status: "loading" });
    setRedirecting(false);

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
        shopName?: string;
        shopId?: string;
        staffAccount?: string;
      };

      if (!response.ok || !payload.ok || !payload.embedUrl) {
        throw new Error(payload.error ?? "無法取得充值審核入口。");
      }

      setState({
        status: "ready",
        embedUrl: payload.embedUrl,
        shopName: payload.shopName ?? payload.shopId ?? "",
        shopId: payload.shopId ?? latestSession?.topUpShopId ?? staffAccount,
        staffAccount: payload.staffAccount ?? staffAccount,
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "載入充值審核失敗。",
      });
    }
  }, [networkOnline]);

  useEffect(() => {
    if (returnedFromTopup) return;
    void loadEmbed();
  }, [loadEmbed, returnedFromTopup]);

  useEffect(() => {
    if (returnedFromTopup || state.status !== "ready" || redirecting) return;
    setRedirecting(true);
    const entryUrl = buildTopupEntryUrl(state.embedUrl, returnUrl);
    window.location.replace(entryUrl);
  }, [redirecting, returnUrl, returnedFromTopup, state]);

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] flex-col overflow-hidden md:pl-[72px]">
        <header className="border-b border-slate-200 bg-white px-4 py-3">
          <div className="text-lg font-semibold text-slate-900">會員充值</div>
          <div className="mt-1 text-sm text-slate-500">
            線上轉帳截圖審核（topUpAutomation 店主後台）。與澳門會員通相同，以 SSO 整頁開啟充值系統。
          </div>
        </header>

        <main className="relative min-h-0 flex-1 bg-slate-100 p-4 pb-20 md:pb-4">
          {returnedFromTopup ? (
            <div className="mx-auto grid max-w-lg place-items-center rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <div className="text-base font-semibold text-slate-900">已返回 POS</div>
              <div className="mt-2 text-sm text-slate-600">
                充值審核在獨立網站完成。批核紀錄與自動核准設定已保存在充值系統，無須保持 POS 開啟。
              </div>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  className="rounded-2xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
                  onClick={() => void loadEmbed()}
                  type="button"
                >
                  再次進入充值審核
                </button>
                <Link
                  className="rounded-2xl bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                  href="/"
                >
                  返回收銀台
                </Link>
              </div>
            </div>
          ) : null}

          {!returnedFromTopup && state.status === "loading" ? (
            <div className="grid h-full place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              正在取得 SSO 登入連結，即將跳轉至充值審核…
            </div>
          ) : null}

          {!returnedFromTopup && state.status === "error" ? (
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

          {!returnedFromTopup && state.status === "ready" ? (
            <div className="mx-auto grid max-w-lg place-items-center rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
              <div className="text-base font-semibold text-emerald-900">
                已接入 {state.shopName}（{state.shopId}）
              </div>
              <div className="mt-2 text-sm text-emerald-800">
                POS 登入：{state.staffAccount}。正在跳轉至充值店主後台…
              </div>
              <a
                className="mt-6 inline-flex rounded-2xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
                href={buildTopupEntryUrl(state.embedUrl, returnUrl)}
              >
                若未自動跳轉，請按此進入
              </a>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
