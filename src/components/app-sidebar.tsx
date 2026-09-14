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
import { useStoreOpenToggle } from "@/lib/pos/use-store-open-toggle";



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

  /**
   * 店內營業（線下）—— 2026-09-14 由**設置頁 header** 搬入商店名卡。
   *
   * ── 點解整合入商店名（而唔另開一粒掣）──────────────────────────────────
   * 側欄得 72px 闊，每行都係稀缺資源（同「工作台入口搬去設置頁」同一個理由）。
   * 商店名卡本身 3 行、位置固定喺底部堆最上，攞佢做開關＝**零額外行高**，
   * 而且收銀一眼就睇到「呢間鋪而家開唔開門」。
   *
   * ── 顏色（2026-09-14 J 拍板）────────────────────────────────────────────
   * - 營業中／未讀到：`bg-slate-800` ＋ 白字（**完全保留現狀**，唔加任何提示色）
   * - 已暫停：`bg-red-600` ＋ 白字，角色行讓位顯示「**已暫停**」（56px 內容闊度
   *   放唔落「總部 · 已暫停」，停業資訊優先）
   *
   * ⚠️ 側欄「同步／在線」徽章本身都會用 `bg-red-600`（同步受阻）——
   * 兩者用同一個紅。位置（商店名卡 vs 徽章）同文字（已暫停 vs 同步受阻）係分辨依據。
   *
   * ── 行為 ───────────────────────────────────────────────────────────────
   * 全部收喺 `useStoreOpenToggle()`：關店二次確認、關店單向連動暫停「線上接單」、
   * 失敗提示。呢度只負責畫掣。
   *
   * ── 🔴🔴 字級（2026-09-14 撲空咗兩次，必讀）─────────────────────────────
   * `globals.css` 有一條**冇 `@layer`** 嘅：
   *
   *     button, input, select, textarea { font: inherit; }
   *
   * 冇 layer 嘅宣告**優先於** Tailwind 嘅 `@layer utilities` ⇒ 喺 `<button>` 身上
   * 寫 `text-[11px]` / `text-xs` **完全冇效**，按鈕字級一律繼承 `body` 嘅 **16px**。
   * （`font` 係 shorthand，連 `leading-tight`、`font-semibold` 都一齊被重設。）
   *
   * 2026-09-14 實證：同一張卡，`<div>`（提示格）寫 `text-[10px]` → 量到 10px ✅；
   * `<button>`（商店名）寫 `text-[11px]` → 量到 **16px** ❌。呢個就係「商店名
   * 忽然變大」嘅真正原因（2026-09-14 由 `<div>` 改成 `<button>` 之後開始）。
   *
   * ⇒ **字級一定要寫喺 button 嘅仔（`<div>`）身上** —— 元素自己嘅宣告永遠贏任何
   *   繼承值。名稱 8px／角色 6px 就係分別寫喺兩個 `<div>`。
   *   ⚠️ 唔好「順手」把 `text-[8px]` 搬返上 `<button>`：一搬就即刻變返 16px。
   *   ⚠️ 同樣道理，其他 `<button>` 上面嘅 `text-*` / `font-*` 都係死碼
   *      （全 app 性問題，未修；要修就係刪咗 globals.css 嗰條 unlayered 重複規則，
   *      因為 Tailwind Preflight 本身已經有同一句，但影響面好廣，要 J 拍板）。
   */
  const storeOpen = useStoreOpenToggle(session?.merchantId ?? null);

  /** 商店名卡嘅 tooltip：講清楚撳落去會發生咩事（唔可以只寫「營業中」）。 */
  const storeToggleHint =
    storeOpen.isOpen === false
      ? "店內暫停營業中（掃碼點餐、自助點餐機落唔到單）—— 撳一下恢復營業"
      : storeOpen.isOpen === true
        ? "營業中 —— 撳一下可暫停店內營業"
        : "未讀到營業狀態（可能係讀取失敗），請重新載入頁面";

  /**
   * 商店名卡下面嘅提示格：**只**顯示寫入失敗（紅）。
   *
   * 🔴 2026-09-14 J 指示：移除連動結果提示整格 —— 最典型嗰句係
   * 「已恢復店內營業。線上接單仍暫停，如需接單請去設置頁開返。」，
   * 側欄得 56px 內容闊、10px 字 → 30 個字 wrap 成 **7 行**，
   * 一按完開關就多咗一大塊嘢，把上面嘅商店名卡擠走。
   *
   * ⚠️ `storeOpen.notice` **仍然由 `useStoreOpenToggle()` 產生**（行為層唔改），
   * 只係目前冇任何 UI 消費佢 —— 將來搬去闊啲嘅入口（設置頁 / 手機底部）
   * 可以直接接返，唔使再寫一次判斷邏輯。
   */
  const storeError = storeOpen.error;



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

            <button

              aria-label={storeToggleHint}

              aria-pressed={storeOpen.isOpen === null ? undefined : storeOpen.isOpen}

              className={`rounded-2xl px-1.5 py-2 text-center font-semibold transition disabled:opacity-100 ${

                storeOpen.isOpen === false
                  ? "bg-red-600 text-white hover:brightness-110"
                  : "bg-slate-800 text-slate-200 hover:bg-slate-700"

              } ${storeOpen.canToggle ? "cursor-pointer" : "cursor-default"}`}

              disabled={!storeOpen.canToggle}

              onClick={() => void storeOpen.toggle()}

              title={storeToggleHint}

              type="button"

            >

              {/* ⚠️ 字級一定要寫喺呢兩個 `<div>`（唔係 `<button>`）—— 見上面「字級」一段。 */}
              <div className="text-[8px] leading-tight">{session.name}</div>

              <div className={`mt-1 text-[6px] leading-tight ${storeOpen.isOpen === false ? "text-white/80" : "text-slate-400"}`}>
                {storeOpen.isOpen === false ? "已暫停" : roleLabel}
              </div>

            </button>

          ) : null}

          {storeError ? (

            <div className="rounded-xl bg-red-500/20 px-2 py-1.5 text-center text-[10px] font-semibold leading-snug text-red-200">

              {storeError}

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



          {/* 切換工作台嘅入口**已經搬去「設置」頁 header**（2026-09-13）。
              原因：側欄 72px 闊，每行都係稀缺資源；「工作台」係一次性設定，
              擺喺日常動線（點餐／訂單／會員）隔籬會令人以為同樣常用。
              入口而家喺 `device-settings.tsx` 嘅 `.hctrl`（「線上訂單 · 營業中」左邊），
              仍然係 `href="/select-workbench"` 直接跳 —— 逃生門冇消失，只係深一層。 */}

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

