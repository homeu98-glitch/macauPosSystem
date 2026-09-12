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
import { SIDEBAR_MODULES } from "@/lib/pos/module-catalog";



/**
 * 側欄模組清單 —— 由 `SIDEBAR_MODULES`（單一真源，`@/lib/pos/module-catalog`）生成。
 *
 * ⚠️ 唔好喺度再寫死一份清單：加模組時如果只改呢度、冇改 `module-catalog`，
 * Admin 授權頁就唔會出現嗰個開關 = 永遠開唔到（唔會 throw，只會靜靜冇咗）。
 *
 * ## 2026-09-13：側欄改為**按商戶授權過濾**（migration 0037 / docs/127）
 *
 * Admin 後台冇開通嘅模組**直接唔顯示**（唔係灰住）—— 側欄得 72px 闊，
 * 塞一堆撳唔到嘅灰按鈕只會令店員搵嘢更慢。
 *
 * ⚠️ `allowedModules` **缺失 = 全部開通**（同 server `loadMerchantGrants()` /
 * 登入頁 `granted` 同一個口徑）。絕對唔可以當成「一個都冇」，
 * 否則升級之後未重新登入嘅舊 session 一 reload，側欄就會變全空。
 */
function resolveNavItems(grantedSidebarModules: readonly string[] | undefined) {
  if (!grantedSidebarModules) return [...SIDEBAR_MODULES];
  const allowed = new Set(grantedSidebarModules);
  return SIDEBAR_MODULES.filter((item) => allowed.has(item.id));
}



export function AppSidebar() {

  const pathname = usePathname();

  const networkOnline = useNetworkOnline();
  /**
   * 同步健康燈（docs/112 L3，2026-09-10；2026-09-10 整合入「在線」徽章）。
   *
   * 舊版側欄只有「在線 / 離線」= 瀏覽器網絡狀態，**唔等於資料已上雲** ——
   * 2026-09-09 實案就係「部機在線、綠燈亮住，但 13 張結帳單雲端一張都冇」。
   *
   * 所以「在線」徽章改為**雙用途**：底色以「本地終態 vs 雲端確認」為準（最壞優先），
   * 只有一切正常時才退回顯示網絡狀態。理由：一個獨立全寬按鈕 99% 時間只寫住
   * 「同步正常」= 零資訊量，卻要佔側欄一行（72px 闊，每行 ~36px）。
   *
   * 正常時它係純狀態徽章（`disabled`）；有嘢未上雲才變成可按嘅「立即重試」。
   */
  const syncHealth = useSyncHealth();
  /** 重試中：避免撳完好似冇反應（`retryReconcileNow` 通常 <1s，但慢網可能幾秒）。 */
  const [syncRetrying, setSyncRetrying] = useState(false);
  /**
   * 徽章文案：**有嘢未上雲優先**，其次才係網絡狀態。
   * 一切正常時仍然顯示「在線／離線」—— 商家熟悉嘅講法唔變。
   */
  const syncBadgeLabel =
    syncHealth.level === "blocked"
      ? "同步受阻"
      : syncHealth.level === "pending"
        ? `${syncHealth.waitingAck || syncHealth.pending || syncHealth.failed} 張待傳`
        : syncHealth.level === "offline"
          ? "離線待傳"
          : networkOnline
            ? "在線"
            : "離線";
  const syncBadgeTitle =
    syncHealth.level === "blocked"
      ? `有 ${syncHealth.blocked} 張訂單連續多次補推都對唔上雲端，撳一下即刻再試。`
      : syncHealth.level === "pending"
        ? `待上傳：${syncHealth.waitingAck} 張終態訂單未確認、${syncHealth.pending} 條事件排隊、${syncHealth.failed} 條退避重試。撳一下即刻再試。`
        : syncHealth.level === "offline"
          ? "而家離線，恢復網絡後會自動補傳（資料已保留喺本機）。"
          : networkOnline
            ? "網絡已連接；所有已結帳／已取消訂單都已確認上雲。"
            : "網絡已斷開；目前冇待上傳資料。";
  /** 徽章底色：最壞情況優先（受阻 → 待傳 → 離線 → 一切正常才用網絡色）。 */
  const syncBadgeClass =
    syncHealth.level === "blocked"
      ? "bg-red-600 text-white"
      : syncHealth.level === "pending"
        ? "bg-amber-500 text-white"
        : syncHealth.level === "offline"
          ? "bg-amber-500/80 text-white"
          : networkOnline
            ? "bg-emerald-600/90 text-white"
            : "bg-amber-500 text-white";


  const [loggedIn, setLoggedIn] = useState(() => Boolean(loadAuthSession()));

  const [session] = useState(() => loadAuthSession());

  const { hasPending, configured: topupConfigured } = useTopupPendingCount();



  const navItems = resolveNavItems(session?.allowedModules?.sidebarModules);



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

          <button

            className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold transition disabled:opacity-100 ${syncBadgeClass} ${
              syncHealth.level === "ok" ? "cursor-default" : "hover:brightness-110"
            }`}

            disabled={syncHealth.level === "ok" || syncRetrying}

            onClick={() => {
              setSyncRetrying(true);
              void retryReconcileNow().finally(() => setSyncRetrying(false));
            }}

            title={syncBadgeTitle}

            type="button"

          >

            {syncRetrying ? "重試中…" : syncBadgeLabel}

          </button>




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



          {/* 切換工作台（逃生門）—— 2026-09-13 新增。
              揀錯工作台之後唔應該逼人登出再登入（仲要重新打 8 位帳號 + PIN），
              所以留一個直接返去「選擇工作台」頁嘅入口。 */}
          <Link

            className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold transition ${

              pathname === "/select-workbench" ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"

            }`}

            href="/select-workbench"

            title="切換工作台（重新揀呢部機嘅崗位）"

          >

            工作台

          </Link>

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

          {[
            ...navItems,
            { href: "/select-workbench", label: "工作台", short: "台" },
            { href: "/settings", label: "設置", short: "設" },
          ].map((item) => {

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

