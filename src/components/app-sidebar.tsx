"use client";



import Link from "next/link";

import { usePathname } from "next/navigation";

import { useState } from "react";



import { PendingDot } from "@/components/pending-dot";

import { useNetworkOnline } from "@/lib/use-network-online";

import { signOutLedgerSession } from "@/lib/ledger/session";

import { loadAuthSession } from "@/lib/storage";

import { useTopupPendingCount } from "@/lib/topup/use-topup-pending-count";
import { useSyncHealth } from "@/lib/pos/sync-acks";
import { retryReconcileNow } from "@/lib/pos/sync-reconcile-daemon";



const baseNavItems = [

  { href: "/", label: "點餐", short: "點" },

  { href: "/orders", label: "訂單", short: "單" },

  { href: "/members", label: "會員", short: "會" },

  { href: "/prints", label: "打印", short: "印" },

  { href: "/reports", label: "報表", short: "報" },

  { href: "/soldout", label: "沽清", short: "沽" },

  { href: "/shift", label: "交班", short: "班" },

  { href: "/inventory", label: "庫存", short: "庫" },

] as const;



export function AppSidebar() {

  const pathname = usePathname();

  const networkOnline = useNetworkOnline();
  /**
   * 同步健康燈（docs/112 L3，2026-09-10）。
   *
   * 舊版側欄只有「在線 / 離線」= 瀏覽器網絡狀態，**唔等於資料已上雲** ——
   * 2026-09-09 實案就係「部機在線、綠燈亮住，但 13 張結帳單雲端一張都冇」。
   * 所以呢度補一個以「本地終態 vs 雲端確認」為準嘅燈：有嘢未確認就唔會再係一片綠。
   * 撳一下 = 立即補推（清冷卻 + 清受阻標記 + 跑一輪對賬）。
   */
  const syncHealth = useSyncHealth();
  const syncHealthLabel =
    syncHealth.level === "blocked"
      ? "同步受阻"
      : syncHealth.level === "pending"
        ? `${syncHealth.waitingAck || syncHealth.pending || syncHealth.failed} 張待傳`
        : syncHealth.level === "offline"
          ? "離線待傳"
          : "同步正常";
  const syncHealthTitle =
    syncHealth.level === "blocked"
      ? `有 ${syncHealth.blocked} 張訂單連續多次補推都對唔上雲端，撳一下即刻再試。`
      : syncHealth.level === "pending"
        ? `待上傳：${syncHealth.waitingAck} 張終態訂單未確認、${syncHealth.pending} 條事件排隊、${syncHealth.failed} 條退避重試。撳一下即刻再試。`
        : syncHealth.level === "offline"
          ? "而家離線，恢復網絡後會自動補傳（資料已保留喺本機）。"
          : "所有已結帳／已取消訂單都已確認上雲。";


  const [loggedIn, setLoggedIn] = useState(() => Boolean(loadAuthSession()));

  const [session] = useState(() => loadAuthSession());

  const { hasPending, configured: topupConfigured } = useTopupPendingCount();



  const navItems = baseNavItems;



  const roleLabel = session?.role === "admin" ? "總部" : session?.role === "manager" ? "店長" : "收銀";



  return (

    <>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col bg-slate-900 px-2 py-3 text-white md:flex">

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="grid gap-2">

          {navItems.map((item) => {

            const active = pathname === item.href || (item.href === "/members" && pathname.startsWith("/members"));

            const showTopupDot = item.href === "/members" && topupConfigured && hasPending;

            return (

              <Link

                key={item.href}

                className={`relative flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-semibold transition ${

                  active ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"

                }`}

                href={item.href}

              >

                {showTopupDot ? (

                  <PendingDot className="absolute right-2 top-2 ring-2 ring-slate-900" />

                ) : null}

                <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">{item.short}</span>

                <span className="whitespace-pre-line text-center leading-tight">{item.label}</span>

              </Link>

            );

          })}

        </div>
        </div>

        <div className="mt-2 grid shrink-0 gap-2 border-t border-slate-700 pt-2">

          {session ? (

            <div className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-[11px] font-semibold text-slate-200">

              <div>{session.name}</div>

              <div className="mt-1 text-slate-400">{roleLabel}</div>

            </div>

          ) : null}

          <div

            className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold ${

              networkOnline ? "bg-emerald-600/90 text-white" : "bg-amber-500 text-white"

            }`}

            title={networkOnline ? "網絡已連接" : "網絡已斷開"}

          >

            {networkOnline ? "在線" : "離線"}

          </div>

          {loggedIn ? (
            <button
              type="button"
              disabled={syncHealth.level === "ok"}
              onClick={() => void retryReconcileNow()}
              className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold transition ${
                syncHealth.level === "blocked"
                  ? "bg-red-600 text-white hover:brightness-110"
                  : syncHealth.level === "pending"
                    ? "bg-amber-500 text-white hover:brightness-110"
                    : syncHealth.level === "offline"
                      ? "bg-amber-500/80 text-white hover:brightness-110"
                      : "bg-emerald-600/90 text-white"
              }`}
              title={syncHealthTitle}
            >
              {syncHealthLabel}
            </button>
          ) : null}



          {loggedIn ? (

            <button

              className="rounded-2xl bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"

              onClick={() => {

                setLoggedIn(false);

                void signOutLedgerSession().then(() => {

                  window.location.replace("/login");

                });

              }}

              type="button"

            >

              登出

            </button>

          ) : null}



          <Link

            className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold transition ${

              pathname === "/settings" ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"

            }`}

            href="/settings"

          >

            設置

          </Link>

        </div>

      </aside>



      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-2 py-2 backdrop-blur md:hidden">

        <div className="flex gap-2 overflow-x-auto pb-1">

          {[...navItems, { href: "/settings", label: "設置", short: "設" }].map((item) => {

            const active = pathname === item.href || (item.href === "/members" && pathname.startsWith("/members"));

            const showTopupDot = item.href === "/members" && topupConfigured && hasPending;

            return (

              <Link

                key={item.href}

                className={`relative flex min-w-[64px] shrink-0 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-semibold ${

                  active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"

                }`}

                href={item.href}

              >

                {showTopupDot ? (

                  <PendingDot className="absolute right-1 top-1 ring-2 ring-white" />

                ) : null}

                <span className="grid h-6 w-6 place-items-center rounded-full bg-black/5">{item.short}</span>

                <span className="leading-tight">{item.label.replace("\n", "")}</span>

              </Link>

            );

          })}

        </div>

      </nav>

    </>

  );

}

